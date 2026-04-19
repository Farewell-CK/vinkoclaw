/**
 * Runtime telemetry for VinkoClaw agent execution.
 *
 * Tracks every LLM turn, tool call, and metric so that the
 * control-center can display a full decision timeline per task.
 *
 * Traces are persisted to SQLite so that both the orchestrator
 * (API server) and the task-runner (executor) share the same store.
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TaskRecord, TaskResult } from "@vinko/shared";
import type { ToolDefinition } from "./tool-executor.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface UsageMetrics {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ToolExecution {
  toolName: string;
  toolCallId: string;
  argumentsSummary: string;  // truncated to 200 chars
  output: string;             // truncated to 500 chars
  error?: string;
  blocked?: string;           // rules engine denial reason
  durationMs: number;
}

export interface AgentTurn {
  round: number;
  /** Messages sent to the LLM (truncated for storage) */
  modelInputSummary: string;
  /** How the model responded */
  modelOutputSummary: string;
  /** Tool calls made in this round */
  toolCalls: ToolExecution[];
  /** Which backend handled this request */
  backendUsed: string;
  modelUsed: string;
  /** Token usage from the API response */
  usage?: UsageMetrics | undefined;
  /** Time spent on this round */
  durationMs: number;
}

export interface AgentTrace {
  taskId: string;
  sessionId: string;
  roleId: string;
  instruction: string;
  turns: AgentTurn[];
  metrics: {
    totalTokens: number;
    totalPromptTokens: number;
    totalCompletionTokens: number;
    toolCalls: number;
    errors: number;
    roundsBlocked: number;
    durationMs: number;
  };
  startedAt: string;
  completedAt?: string;
  result?: {
    summary: string;
    deliverable: string;
    score: number;
    confidence: string;
  } | undefined;
}

// ─── Global singleton ─────────────────────────────────────────────────────────


// ─── SQLite-backed collector ────────────────────────────────────────────────

export interface TelemetryCollectorOptions {
  dbFile?: string;  // defaults to in-memory
}

const SQLITE_BUSY_TIMEOUT_MS = (() => {
  const raw = Number(process.env.VINKO_SQLITE_BUSY_TIMEOUT_MS ?? "10000");
  if (!Number.isFinite(raw)) {
    return 10_000;
  }
  return Math.max(1_000, Math.round(raw));
})();

const SQLITE_SCHEMA_RETRY_LIMIT = 8;
const SQLITE_SCHEMA_RETRY_DELAY_MS = 150;

const MAX_INPUT_SUMMARY = 2000;
const MAX_OUTPUT_SUMMARY = 1000;
const MAX_ARG_SUMMARY = 200;
const MAX_TOOL_OUTPUT = 500;

function isSqliteLockedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes("database is locked") || message.includes("database is busy");
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export class TelemetryCollector {
  private traces = new Map<string, AgentTrace>();
  private turnStarts = new Map<string, number>();
  private db: DatabaseSync | null = null;

  constructor(options?: TelemetryCollectorOptions) {
    const dbFile = options?.dbFile;
    if (dbFile) {
      const dbDir = dirname(dbFile);
      if (!existsSync(dbDir)) {
        mkdirSync(dbDir, { recursive: true });
      }
      this.db = new DatabaseSync(dbFile, {
        enableForeignKeyConstraints: true,
        timeout: SQLITE_BUSY_TIMEOUT_MS
      });
      this.db.exec("PRAGMA journal_mode = WAL;");
      this.db.exec("PRAGMA synchronous = NORMAL;");
      this.db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};`);
      this.ensureSchema();
    }
  }

  private ensureSchema(): void {
    if (!this.db) return;
    for (let attempt = 0; attempt < SQLITE_SCHEMA_RETRY_LIMIT; attempt += 1) {
      try {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS telemetry_traces (
            task_id TEXT PRIMARY KEY,
            session_id TEXT,
            role_id TEXT,
            instruction TEXT,
            started_at TEXT,
            completed_at TEXT,
            metrics_json TEXT,
            result_json TEXT
          );
          CREATE TABLE IF NOT EXISTS telemetry_turns (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            trace_id TEXT NOT NULL REFERENCES telemetry_traces(task_id) ON DELETE CASCADE,
            round INTEGER NOT NULL,
            model_input_summary TEXT,
            model_output_summary TEXT,
            backend_used TEXT,
            model_used TEXT,
            usage_json TEXT,
            duration_ms INTEGER DEFAULT 0,
            tool_calls_json TEXT
          );
        `);
        return;
      } catch (error) {
        if (!isSqliteLockedError(error) || attempt === SQLITE_SCHEMA_RETRY_LIMIT - 1) {
          throw error;
        }
        sleepSync(SQLITE_SCHEMA_RETRY_DELAY_MS * (attempt + 1));
      }
    }
  }

  startTrace(task: TaskRecord): string {
    const traceId = task.id;
    const trace: AgentTrace = {
      taskId: task.id,
      sessionId: task.sessionId ?? "",
      roleId: task.roleId ?? "unknown",
      instruction: task.instruction.slice(0, 500),
      turns: [],
      metrics: {
        totalTokens: 0,
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
        toolCalls: 0,
        errors: 0,
        roundsBlocked: 0,
        durationMs: 0
      },
      startedAt: new Date().toISOString()
    };
    this.traces.set(traceId, trace);

    if (this.db) {
      try {
        const stmt = this.db.prepare(`
          INSERT OR REPLACE INTO telemetry_traces
            (task_id, session_id, role_id, instruction, started_at, metrics_json, result_json)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        stmt.run(trace.taskId, trace.sessionId, trace.roleId, trace.instruction,
                 trace.startedAt, JSON.stringify(trace.metrics), null);
      } catch (error) {
        if (!isSqliteLockedError(error)) {
          throw error;
        }
      }
    }

    return traceId;
  }

  recordTurnStart(traceId: string, round: number): void {
    const key = `${traceId}:${round}`;
    this.turnStarts.set(key, Date.now());
  }

  recordTurn(traceId: string, turn: AgentTurn): void {
    const trace = this.traces.get(traceId);
    if (!trace) return;

    // Calculate duration from turn start
    const key = `${traceId}:${turn.round}`;
    const startMs = this.turnStarts.get(key);
    if (startMs) {
      turn.durationMs = Date.now() - startMs;
      this.turnStarts.delete(key);
    }

    trace.turns.push(turn);

    // Update aggregate metrics
    if (turn.usage) {
      trace.metrics.totalTokens += turn.usage.totalTokens;
      trace.metrics.totalPromptTokens += turn.usage.promptTokens;
      trace.metrics.totalCompletionTokens += turn.usage.completionTokens;
    }
    trace.metrics.toolCalls += turn.toolCalls.length;
    trace.metrics.errors += turn.toolCalls.filter((t) => t.error || t.blocked).length;
    trace.metrics.roundsBlocked += turn.toolCalls.filter((t) => t.blocked).length;

    // Persist turn to SQLite
    if (this.db) {
      try {
        const stmt = this.db.prepare(`
          INSERT INTO telemetry_turns
            (trace_id, round, model_input_summary, model_output_summary,
             backend_used, model_used, usage_json, duration_ms, tool_calls_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        stmt.run(
          traceId,
          turn.round,
          turn.modelInputSummary,
          turn.modelOutputSummary,
          turn.backendUsed || null,
          turn.modelUsed || null,
          turn.usage ? JSON.stringify(turn.usage) : null,
          turn.durationMs,
          JSON.stringify(turn.toolCalls)
        );
      } catch (error) {
        if (!isSqliteLockedError(error)) {
          throw error;
        }
      }
    }
  }

  recordBlockedTool(traceId: string, round: number, toolName: string, toolCallId: string, reason: string): void {
    const trace = this.traces.get(traceId);
    if (!trace) return;

    // Find the last turn for this round and add the blocked tool
    const lastTurn = trace.turns[trace.turns.length - 1];
    if (lastTurn && lastTurn.round === round) {
      lastTurn.toolCalls.push({
        toolName,
        toolCallId,
        argumentsSummary: "",
        output: "",
        blocked: reason,
        durationMs: 0
      });
      trace.metrics.roundsBlocked++;

      // Update the turn's tool_calls_json in DB
      if (this.db) {
        try {
          const updateStmt = this.db.prepare(`
            UPDATE telemetry_turns SET tool_calls_json = ?
            WHERE trace_id = ? AND round = ?
          `);
          updateStmt.run(JSON.stringify(lastTurn.toolCalls), traceId, round);
        } catch (error) {
          if (!isSqliteLockedError(error)) {
            throw error;
          }
        }
      }
    }
  }

  completeTrace(traceId: string, result: TaskResult): void {
    const trace = this.traces.get(traceId);
    if (!trace) return;

    trace.completedAt = new Date().toISOString();
    trace.metrics.durationMs = Date.parse(trace.completedAt) - Date.parse(trace.startedAt);
    trace.result = {
      summary: (result.summary ?? "").slice(0, 200),
      deliverable: (result.deliverable ?? "").slice(0, 500),
      score: 0,
      confidence: "unknown"
    };

    if (this.db) {
      try {
        const stmt = this.db.prepare(`
          UPDATE telemetry_traces
          SET completed_at = ?, metrics_json = ?, result_json = ?
          WHERE task_id = ?
        `);
        stmt.run(trace.completedAt, JSON.stringify(trace.metrics), JSON.stringify(trace.result), traceId);
      } catch (error) {
        if (!isSqliteLockedError(error)) {
          throw error;
        }
      }
    }
  }

  getTrace(traceId: string): AgentTrace | undefined {
    // Check in-memory cache first
    const cached = this.traces.get(traceId);
    if (cached) return cached;

    // Fall back to SQLite
    if (!this.db) return undefined;
    const traceStmt = this.db.prepare(`SELECT * FROM telemetry_traces WHERE task_id = ?`);
    const row = traceStmt.get(traceId) as Record<string, unknown> | undefined;
    if (!row) return undefined;

    const turnStmt = this.db.prepare(`SELECT * FROM telemetry_turns WHERE trace_id = ? ORDER BY round`);
    const turns = turnStmt.all(traceId) as Array<Record<string, unknown>>;

    return this.rowToTrace(row, turns);
  }

  listTraces(): AgentTrace[] {
    if (!this.db) {
      return Array.from(this.traces.values());
    }

    // Reload all traces from SQLite for cross-process consistency
    const traceStmt = this.db.prepare(`SELECT * FROM telemetry_traces ORDER BY started_at DESC`);
    const rows = traceStmt.all() as Array<Record<string, unknown>>;

    const turnStmt = this.db.prepare(`SELECT * FROM telemetry_turns WHERE trace_id = ? ORDER BY round`);

    return rows.map((row) => {
      const turns = turnStmt.all(row.task_id as string) as Array<Record<string, unknown>>;
      return this.rowToTrace(row, turns);
    });
  }

  private rowToTrace(row: Record<string, unknown>, turns: Array<Record<string, unknown>>): AgentTrace {
    return {
      taskId: row.task_id as string,
      sessionId: (row.session_id as string) ?? "",
      roleId: (row.role_id as string) ?? "unknown",
      instruction: (row.instruction as string) ?? "",
      turns: turns.map((t) => ({
        round: t.round as number,
        modelInputSummary: (t.model_input_summary as string) ?? "",
        modelOutputSummary: (t.model_output_summary as string) ?? "",
        toolCalls: JSON.parse((t.tool_calls_json as string) ?? "[]") as ToolExecution[],
        backendUsed: (t.backend_used as string) ?? "",
        modelUsed: (t.model_used as string) ?? "",
        usage: t.usage_json ? JSON.parse(t.usage_json as string) as UsageMetrics : undefined,
        durationMs: (t.duration_ms as number) ?? 0
      })),
      metrics: JSON.parse((row.metrics_json as string) ?? "{}") as AgentTrace["metrics"],
      startedAt: (row.started_at as string) ?? "",
      completedAt: (row.completed_at as string) ?? undefined,
      result: row.result_json
        ? JSON.parse(row.result_json as string) as AgentTrace["result"]
        : undefined
    };
  }

  /** Clear old traces to prevent database growth (keep last N) */
  prune(maxTraces: number = 100): void {
    if (this.db) {
      const ids = this.db.prepare(`
        SELECT task_id FROM telemetry_traces ORDER BY started_at DESC LIMIT -1 OFFSET ?
      `).all(maxTraces) as Array<{ task_id: string }>;
      if (ids.length > 0) {
        const placeholders = ids.map(() => "?").join(",");
        const deleteStmt = this.db.prepare(
          `DELETE FROM telemetry_traces WHERE task_id IN (${placeholders})`
        );
        deleteStmt.run(...ids.map((r) => r.task_id));
      }
    } else {
      if (this.traces.size <= maxTraces) return;
      const keys = Array.from(this.traces.keys());
      const toRemove = keys.slice(0, keys.length - maxTraces);
      for (const key of toRemove) {
        this.traces.delete(key);
      }
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Truncate a string for telemetry storage. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `... (${text.length - max} more chars)`;
}

/** Summarize the messages being sent to the LLM. */
export function summarizeModelInput(messages: { role: string; content: unknown }[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
    parts.push(`${msg.role}: ${truncate(content, 300)}`);
  }
  return truncate(parts.join("\n"), MAX_INPUT_SUMMARY);
}

/** Summarize the model's response. */
export function summarizeModelOutput(message: {
  content?: unknown;
  tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
}): string {
  const parts: string[] = [];
  if (message.content) {
    const text = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
    parts.push(truncate(text, MAX_OUTPUT_SUMMARY));
  }
  if (message.tool_calls && message.tool_calls.length > 0) {
    for (const tc of message.tool_calls) {
      parts.push(`tool_call: ${tc.function.name}(${truncate(tc.function.arguments, MAX_ARG_SUMMARY)})`);
    }
  }
  return parts.join("\n") || "(empty response)";
}

/** Truncate tool arguments for telemetry display. */
export function summarizeToolArguments(argsRaw: string): string {
  return truncate(argsRaw, MAX_ARG_SUMMARY);
}

/** Truncate tool output for telemetry display. */
export function summarizeToolOutput(output: string): string {
  return truncate(output, MAX_TOOL_OUTPUT);
}

/**
 * Shared telemetry collector for the entire VinkoClaw process.
 * Use this instance when you don't need a custom collector.
 *
 * NOTE: This is a lazily-initialized singleton. Call `initGlobalTelemetry`
 * before first use to configure the SQLite backing store.
 */
let _globalTelemetry: TelemetryCollector | null = null;

export function initGlobalTelemetry(dbFile: string): TelemetryCollector {
  if (_globalTelemetry) return _globalTelemetry;
  _globalTelemetry = new TelemetryCollector({ dbFile });
  return _globalTelemetry;
}

export function getGlobalTelemetry(): TelemetryCollector {
  if (!_globalTelemetry) {
    // Fallback: in-memory collector (single-process only)
    _globalTelemetry = new TelemetryCollector();
  }
  return _globalTelemetry;
}

/** Backwards-compatible alias — use `getGlobalTelemetry()` instead for cross-process sharing. */
export const globalTelemetry = {
  get listTraces() { return getGlobalTelemetry().listTraces.bind(getGlobalTelemetry()); },
  get getTrace() { return getGlobalTelemetry().getTrace.bind(getGlobalTelemetry()); },
  get startTrace() { return getGlobalTelemetry().startTrace.bind(getGlobalTelemetry()); },
  get recordTurnStart() { return getGlobalTelemetry().recordTurnStart.bind(getGlobalTelemetry()); },
  get recordTurn() { return getGlobalTelemetry().recordTurn.bind(getGlobalTelemetry()); },
  get recordBlockedTool() { return getGlobalTelemetry().recordBlockedTool.bind(getGlobalTelemetry()); },
  get completeTrace() { return getGlobalTelemetry().completeTrace.bind(getGlobalTelemetry()); },
  get prune() { return getGlobalTelemetry().prune.bind(getGlobalTelemetry()); },
};

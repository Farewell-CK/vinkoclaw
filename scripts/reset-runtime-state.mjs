#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUN_ROOT = path.join(ROOT, ".run", "reset-runtime-state");
const ORCH_BASE = process.env.ORCH_BASE_URL ?? "http://127.0.0.1:8098";
const TIMESTAMP = new Date().toISOString().replace(/[:.]/g, "-");
const REPORT_FILE = path.join(RUN_ROOT, "latest.json");
const HISTORY_FILE = path.join(RUN_ROOT, "history.jsonl");
const ACTIVE_TASK_STATUSES = ["queued", "running", "waiting_approval"];
const AWAITING_INPUT_TASK_STATUSES = ["paused_input"];
const RESETTABLE_TASK_STATUSES = [...ACTIVE_TASK_STATUSES, ...AWAITING_INPUT_TASK_STATUSES];
const ACTIVE_GOAL_RUN_STATUSES = ["queued", "running", "awaiting_input", "awaiting_authorization"];
const RUNTIME_TABLES = [
  "task_relations",
  "agent_messages",
  "collaboration_timeline_events",
  "agent_collaborations",
  "tool_runs",
  "approval_events",
  "approval_workflow_steps",
  "approval_workflows",
  "approvals",
  "operator_actions",
  "goal_run_traces",
  "goal_run_handoff_artifacts",
  "goal_run_timeline_events",
  "goal_run_inputs",
  "run_auth_tokens",
  "goal_runs",
  "session_messages",
  "tasks",
  "sessions",
  "workspace_memory",
  "audit_events",
  "auth_sessions"
];
const PROCESS_PATTERNS = {
  checks: [
    /scripts\/harness-runner\.mjs/,
    /scripts\/founder-delivery-selfcheck\.mjs/,
    /scripts\/product-selfcheck(?:-watch|-daemon)?\.mjs/,
    /scripts\/self-check(?:-collaboration|-skill-lifecycle)?\.mjs/,
    /scripts\/persona-test\.mjs/
  ],
  services: [
    /npm run dev(?::orchestrator)?(?:\s|$)/,
    /npm run dev:task-runner(?::multi)?(?:\s|$)/,
    /npm run start:task-runner(?::multi)?(?:\s|$)/,
    /scripts\/run-task-runners\.mjs/,
    /npm run dev:email-inbound(?:\s|$)/,
    /npm run dev -w @vinko\/orchestrator/,
    /npm run dev -w @vinko\/task-runner/,
    /npm run start -w @vinko\/orchestrator/,
    /npm run start -w @vinko\/task-runner/,
    /tsx .*services\/orchestrator/,
    /tsx .*services\/task-runner/,
    /tsx .*services\/email-inbound/,
    /tsx watch src\/server\.ts/,
    /tsx watch src\/worker\.ts/,
    /tsx watch src\/index\.ts/,
    /tsx\/dist\/loader\.mjs src\/server\.ts/,
    /tsx\/dist\/loader\.mjs src\/worker\.ts/,
    /tsx\/dist\/loader\.mjs src\/index\.ts/
  ]
};

function info(message) {
  process.stdout.write(`[reset-runtime-state] ${message}\n`);
}

function fail(message) {
  process.stderr.write(`[reset-runtime-state] FAIL: ${message}\n`);
  process.exit(1);
}

function parseEnvFile(filePath) {
  if (!existsSync(filePath)) {
    return {};
  }
  const parsed = {};
  const content = readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/g)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const index = line.indexOf("=");
    if (index <= 0) {
      continue;
    }
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
    parsed[key] = value;
  }
  return parsed;
}

function resolvePath(value, fallback) {
  const target = value && value.trim().length > 0 ? value.trim() : fallback;
  if (path.isAbsolute(target)) {
    return target;
  }
  return path.resolve(ROOT, target);
}

function resolveRuntimePaths() {
  const fileEnv = {
    ...parseEnvFile(path.join(ROOT, "config", ".env")),
    ...parseEnvFile(path.join(ROOT, ".env"))
  };
  const merged = {
    ...fileEnv,
    ...process.env
  };
  const dataDir = resolvePath(merged.VINKOCLAW_DATA_DIR, ".data");
  const dbPath = resolvePath(merged.VINKO_DB_PATH, path.join(dataDir, "vinkoclaw.sqlite"));
  const telemetryPath = path.join(path.dirname(dbPath), "telemetry.db");
  return {
    dataDir,
    dbPath,
    telemetryPath
  };
}

function parseNumber(value, fallback, minimum = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(minimum, Math.round(parsed));
}

function parseArgs(argv) {
  const positionals = [];
  const flags = {
    dryRun: false,
    backup: true,
    killCheckProcesses: false,
    killDevServices: false,
    includeTelemetry: false,
    timeoutMs: 60_000,
    maxBusyTasks: 0,
    reason: "reset-runtime-state"
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    if (arg === "--dry-run") {
      flags.dryRun = true;
      continue;
    }
    if (arg === "--no-backup") {
      flags.backup = false;
      continue;
    }
    if (arg === "--kill-check-processes") {
      flags.killCheckProcesses = true;
      continue;
    }
    if (arg === "--kill-dev-services") {
      flags.killDevServices = true;
      continue;
    }
    if (arg === "--include-telemetry") {
      flags.includeTelemetry = true;
      continue;
    }
    if (arg === "--help") {
      flags.help = true;
      continue;
    }
    if (arg.startsWith("--timeout-ms=")) {
      flags.timeoutMs = parseNumber(arg.slice("--timeout-ms=".length), flags.timeoutMs, 1_000);
      continue;
    }
    if (arg === "--timeout-ms") {
      flags.timeoutMs = parseNumber(argv[index + 1], flags.timeoutMs, 1_000);
      index += 1;
      continue;
    }
    if (arg.startsWith("--max-busy-tasks=")) {
      flags.maxBusyTasks = parseNumber(arg.slice("--max-busy-tasks=".length), flags.maxBusyTasks, 0);
      continue;
    }
    if (arg === "--max-busy-tasks") {
      flags.maxBusyTasks = parseNumber(argv[index + 1], flags.maxBusyTasks, 0);
      index += 1;
      continue;
    }
    if (arg.startsWith("--reason=")) {
      flags.reason = arg.slice("--reason=".length).trim() || flags.reason;
      continue;
    }
    if (arg === "--reason") {
      flags.reason = (argv[index + 1] ?? "").trim() || flags.reason;
      index += 1;
      continue;
    }
    fail(`unknown flag: ${arg}`);
  }
  return {
    mode: positionals[0] ?? "drain",
    ...flags
  };
}

function printHelp() {
  info("usage: node ./scripts/reset-runtime-state.mjs <mode> [options]");
  info("modes:");
  info("  drain         在线取消活跃 tasks / goal runs / approvals，默认保留历史");
  info("  wipe-runtime  备份后清空运行态历史表，保留配置、技能绑定、凭据");
  info("  rebuild-db    备份后删除主数据库文件，彻底重建");
  info("  factory-reset 最强恢复模式：终止检查/服务进程，备份后删除主数据库与 telemetry 数据库");
  info("options:");
  info("  --dry-run");
  info("  --kill-check-processes");
  info("  --kill-dev-services");
  info("  --no-backup");
  info("  --include-telemetry");
  info("  --timeout-ms <ms>");
  info("  --max-busy-tasks <n>");
  info("  --reason <text>");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestJson(pathname, input = {}) {
  const method = input.method ?? "GET";
  const headers = {
    "content-type": "application/json",
    ...(input.headers ?? {})
  };
  const response = await fetch(`${ORCH_BASE}${pathname}`, {
    method,
    headers,
    body: input.body ? JSON.stringify(input.body) : undefined
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${pathname}: ${text}`);
  }
  if (!text.trim()) {
    return {};
  }
  return JSON.parse(text);
}

function databaseExists(dbPath) {
  return existsSync(dbPath) || existsSync(`${dbPath}-wal`) || existsSync(`${dbPath}-shm`);
}

function openDb(dbPath) {
  return new DatabaseSync(dbPath, {
    timeout: 5_000
  });
}

function getGroupedCounts(db, tableName, statusColumn = "status") {
  try {
    const rows = db.prepare(`SELECT ${statusColumn} AS status, COUNT(*) AS count FROM ${tableName} GROUP BY ${statusColumn}`).all();
    const counts = {};
    for (const row of rows) {
      const key = typeof row.status === "string" ? row.status : "";
      if (!key) {
        continue;
      }
      counts[key] = Number(row.count ?? 0);
    }
    return counts;
  } catch {
    return {};
  }
}

function sumCounts(counts, keys) {
  return keys.reduce((total, key) => total + Number(counts[key] ?? 0), 0);
}

export function getDbSnapshot(dbPath) {
  if (!databaseExists(dbPath)) {
    return {
      exists: false,
      tasks: {},
      goalRuns: {},
      approvals: {},
      sessions: 0,
      workspaceMemory: 0,
      busyTasks: 0,
      busyGoalRuns: 0,
      pendingApprovals: 0,
      blockedProjectState: 0
    };
  }
  const db = openDb(dbPath);
  try {
    const tasks = getGroupedCounts(db, "tasks");
    const goalRuns = getGroupedCounts(db, "goal_runs");
    const approvals = getGroupedCounts(db, "approvals");
    const sessionsRow = db.prepare("SELECT COUNT(*) AS count FROM sessions").get();
    const workspaceMemoryRow = db.prepare("SELECT COUNT(*) AS count FROM workspace_memory").get();
    const blockedProjectState =
      Number(tasks.failed ?? 0) +
      Number(tasks.paused_input ?? 0) +
      Number(goalRuns.awaiting_input ?? 0) +
      Number(approvals.pending ?? 0);
    return {
      exists: true,
      tasks,
      goalRuns,
      approvals,
      sessions: Number(sessionsRow?.count ?? 0),
      workspaceMemory: Number(workspaceMemoryRow?.count ?? 0),
      busyTasks: sumCounts(tasks, RESETTABLE_TASK_STATUSES),
      busyGoalRuns: sumCounts(goalRuns, ACTIVE_GOAL_RUN_STATUSES),
      pendingApprovals: Number(approvals.pending ?? 0),
      blockedProjectState,
      awaitingInputTasks: Number(tasks.paused_input ?? 0)
    };
  } finally {
    db.close();
  }
}

export function listResettableTaskIds(dbPath) {
  if (!databaseExists(dbPath)) {
    return [];
  }
  const db = openDb(dbPath);
  try {
    const placeholders = RESETTABLE_TASK_STATUSES.map(() => "?").join(", ");
    const rows = db
      .prepare(
        `SELECT id, status FROM tasks WHERE status IN (${placeholders}) ORDER BY updated_at ASC, created_at ASC`
      )
      .all(...RESETTABLE_TASK_STATUSES);
    return rows.map((row) => ({
      id: String(row.id),
      status: String(row.status)
    }));
  } finally {
    db.close();
  }
}

function listProcesses() {
  const output = execFileSync("ps", ["-eo", "pid=,args="], {
    cwd: ROOT,
    encoding: "utf8"
  });
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(.*)$/);
      if (!match) {
        return null;
      }
      return {
        pid: Number(match[1]),
        command: match[2]
      };
    })
    .filter(Boolean);
}

function getAncestorPids() {
  const output = execFileSync("ps", ["-eo", "pid=,ppid="], {
    cwd: ROOT,
    encoding: "utf8"
  });
  const parentByPid = new Map();
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const match = line.match(/^(\d+)\s+(\d+)$/);
    if (!match) {
      continue;
    }
    parentByPid.set(Number(match[1]), Number(match[2]));
  }
  const ancestors = new Set([process.pid, process.ppid]);
  let cursor = process.ppid;
  while (cursor && !ancestors.has(parentByPid.get(cursor))) {
    const parent = parentByPid.get(cursor);
    if (!parent || parent <= 1) {
      break;
    }
    ancestors.add(parent);
    cursor = parent;
  }
  return ancestors;
}

function matchProcesses(groupName) {
  const patterns = PROCESS_PATTERNS[groupName] ?? [];
  const ignored = getAncestorPids();
  return listProcesses().filter((entry) => {
    if (!entry || ignored.has(entry.pid)) {
      return false;
    }
    return patterns.some((pattern) => pattern.test(entry.command));
  });
}

async function killProcesses(groupName) {
  const matched = matchProcesses(groupName);
  if (matched.length === 0) {
    return [];
  }
  info(`killing ${groupName} processes: ${matched.map((entry) => entry.pid).join(", ")}`);
  for (const entry of matched) {
    try {
      process.kill(-entry.pid, "SIGTERM");
    } catch {
      try {
        process.kill(entry.pid, "SIGTERM");
      } catch {
        // Ignore processes that exit between listing and kill.
      }
    }
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const alive = matched.filter((entry) => {
      try {
        process.kill(entry.pid, 0);
        return true;
      } catch {
        return false;
      }
    });
    if (alive.length === 0) {
      return matched;
    }
    await sleep(400);
  }
  for (const entry of matched) {
    try {
      process.kill(-entry.pid, "SIGKILL");
    } catch {
      try {
        process.kill(entry.pid, "SIGKILL");
      } catch {
        // Ignore.
      }
    }
  }
  return matched;
}

function buildBackupDir(dataDir) {
  return path.join(dataDir, "backups", "runtime-reset", TIMESTAMP);
}

function backupFiles(input) {
  const files = input.files.filter((filePath) => existsSync(filePath));
  if (files.length === 0) {
    return undefined;
  }
  mkdirSync(input.backupDir, { recursive: true });
  for (const filePath of files) {
    copyFileSync(filePath, path.join(input.backupDir, path.basename(filePath)));
  }
  return input.backupDir;
}

function removeFileIfExists(filePath) {
  if (existsSync(filePath)) {
    rmSync(filePath, {
      force: true
    });
  }
}

function writeReport(report) {
  mkdirSync(RUN_ROOT, { recursive: true });
  writeFileSync(REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const historyLine = {
    ...report,
    stdoutSummary: undefined
  };
  let history = "";
  try {
    history = readFileSync(HISTORY_FILE, "utf8");
  } catch {
    history = "";
  }
  writeFileSync(HISTORY_FILE, `${history}${JSON.stringify(historyLine)}\n`, "utf8");
}

async function waitForDrain(dbPath, input) {
  const deadline = Date.now() + input.timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = getDbSnapshot(dbPath);
    if (
      snapshot.busyTasks <= input.maxBusyTasks &&
      snapshot.busyGoalRuns === 0 &&
      snapshot.pendingApprovals === 0
    ) {
      return snapshot;
    }
    await sleep(1_500);
  }
  return getDbSnapshot(dbPath);
}

async function drainRuntimeState(input) {
  await requestJson("/health");
  const rounds = [];
  for (let round = 1; round <= 4; round += 1) {
    const before = getDbSnapshot(input.dbPath);
    rounds.push({
      round,
      before
    });
    if (
      before.busyTasks <= input.maxBusyTasks &&
      before.busyGoalRuns === 0 &&
      before.pendingApprovals === 0
    ) {
      return {
        rounds,
        finalSnapshot: before
      };
    }

    await requestJson("/api/approvals/cancel-stale", {
      method: "POST",
      body: {
        olderThanMinutes: 0,
        limit: 2_000,
        decidedBy: "system:reset-runtime-state",
        reasonPrefix: input.reason
      }
    }).catch(() => null);

    await requestJson("/api/goal-runs/cancel-stale", {
      method: "POST",
      body: {
        olderThanMinutes: 0,
        limit: 1_000,
        statuses: ACTIVE_GOAL_RUN_STATUSES,
        reasonPrefix: input.reason
      }
    }).catch(() => null);

    const activeTasks = listResettableTaskIds(input.dbPath);
    for (const task of activeTasks) {
      await requestJson(`/api/tasks/${task.id}/cancel`, {
        method: "POST",
        body: {
          reason: input.reason
        }
      }).catch(() => null);
    }

    const settled = await waitForDrain(input.dbPath, input);
    rounds[rounds.length - 1].after = settled;
    if (
      settled.busyTasks <= input.maxBusyTasks &&
      settled.busyGoalRuns === 0 &&
      settled.pendingApprovals === 0
    ) {
      return {
        rounds,
        finalSnapshot: settled
      };
    }
  }
  return {
    rounds,
    finalSnapshot: getDbSnapshot(input.dbPath)
  };
}

function wipeRuntimeTables(dbPath) {
  if (!databaseExists(dbPath)) {
    return;
  }
  const db = openDb(dbPath);
  try {
    db.exec("PRAGMA foreign_keys = OFF;");
    db.exec("BEGIN IMMEDIATE;");
    for (const tableName of RUNTIME_TABLES) {
      db.exec(`DELETE FROM ${tableName};`);
    }
    db.exec("COMMIT;");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  } catch (error) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      // Ignore rollback failure.
    }
    throw error;
  } finally {
    db.close();
  }

  const vacuumDb = openDb(dbPath);
  try {
    vacuumDb.exec("VACUUM;");
  } finally {
    vacuumDb.close();
  }
  removeFileIfExists(`${dbPath}-wal`);
  removeFileIfExists(`${dbPath}-shm`);
}

function rebuildDatabaseFiles(dbPath, includeTelemetry) {
  removeFileIfExists(dbPath);
  removeFileIfExists(`${dbPath}-wal`);
  removeFileIfExists(`${dbPath}-shm`);
  if (includeTelemetry) {
    const telemetryPath = path.join(path.dirname(dbPath), "telemetry.db");
    removeFileIfExists(telemetryPath);
    removeFileIfExists(`${telemetryPath}-wal`);
    removeFileIfExists(`${telemetryPath}-shm`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  if (!["drain", "wipe-runtime", "rebuild-db", "factory-reset"].includes(args.mode)) {
    fail(`unknown mode: ${args.mode}`);
  }

  const startedAt = new Date().toISOString();
  const startedAtMs = Date.now();
  const { dataDir, dbPath, telemetryPath } = resolveRuntimePaths();
  const countsBefore = getDbSnapshot(dbPath);
  const report = {
    mode: args.mode,
    startedAt,
    finishedAt: startedAt,
    durationMs: 0,
    orchBase: ORCH_BASE,
    dbPath,
    telemetryPath,
    reason: args.reason,
    dryRun: args.dryRun,
    backupDir: undefined,
    killedCheckProcesses: [],
    killedServiceProcesses: [],
    countsBefore,
    countsAfter: countsBefore,
    ok: false
  };

  const includeTelemetry = args.includeTelemetry || args.mode === "factory-reset";

  if ((args.killCheckProcesses || args.mode === "factory-reset") && !args.dryRun) {
    const killed = await killProcesses("checks");
    report.killedCheckProcesses = killed;
  }

  if (args.mode === "drain") {
    if (args.dryRun) {
      report.ok = true;
    } else {
      info(`draining active runtime state via ${ORCH_BASE}`);
      const drain = await drainRuntimeState({
        dbPath,
        timeoutMs: args.timeoutMs,
        maxBusyTasks: args.maxBusyTasks,
        reason: args.reason
      });
      report.rounds = drain.rounds;
      report.countsAfter = drain.finalSnapshot;
      report.ok =
        drain.finalSnapshot.busyTasks <= args.maxBusyTasks &&
        drain.finalSnapshot.busyGoalRuns === 0 &&
        drain.finalSnapshot.pendingApprovals === 0;
      if (!report.ok) {
        report.detail = "drain did not converge to a clean queue";
      }
    }
  } else {
    const shouldKillServices =
      args.killDevServices || args.mode === "wipe-runtime" || args.mode === "rebuild-db" || args.mode === "factory-reset";
    if (shouldKillServices && !args.dryRun) {
      const killed = await killProcesses("services");
      report.killedServiceProcesses = killed;
    }
    if (args.backup && !args.dryRun) {
      const backupDir = backupFiles({
        backupDir: buildBackupDir(dataDir),
        files: [
          dbPath,
          `${dbPath}-wal`,
          `${dbPath}-shm`,
          ...(includeTelemetry ? [telemetryPath, `${telemetryPath}-wal`, `${telemetryPath}-shm`] : [])
        ]
      });
      report.backupDir = backupDir;
    }
    if (args.mode === "wipe-runtime") {
      if (!args.dryRun) {
        info(`wiping runtime tables in ${dbPath}`);
        wipeRuntimeTables(dbPath);
      }
      report.countsAfter = getDbSnapshot(dbPath);
      report.ok =
        report.countsAfter.busyTasks === 0 &&
        report.countsAfter.busyGoalRuns === 0 &&
        report.countsAfter.pendingApprovals === 0 &&
        report.countsAfter.sessions === 0;
    }
    if (args.mode === "rebuild-db") {
      if (!args.dryRun) {
        info(`removing database files under ${path.dirname(dbPath)}`);
        rebuildDatabaseFiles(dbPath, includeTelemetry);
      }
      report.countsAfter = getDbSnapshot(dbPath);
      report.ok = !databaseExists(dbPath);
    }
    if (args.mode === "factory-reset") {
      if (!args.dryRun) {
        info(`factory-reset removing runtime databases under ${path.dirname(dbPath)}`);
        rebuildDatabaseFiles(dbPath, true);
      }
      report.countsAfter = getDbSnapshot(dbPath);
      report.ok = !databaseExists(dbPath) && !databaseExists(telemetryPath);
    }
  }

  report.finishedAt = new Date().toISOString();
  report.durationMs = Date.now() - startedAtMs;
  if (!report.ok && !report.detail) {
    report.detail = "runtime reset failed";
  }
  writeReport(report);
  if (!report.ok) {
    fail(report.detail ?? "runtime reset failed");
  }
  info(`ok mode=${args.mode} duration=${report.durationMs}ms`);
}

function isMainModule() {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  return import.meta.url === pathToFileURL(entry).href;
}

if (isMainModule()) {
  main().catch((error) => {
    fail(error instanceof Error ? error.message : String(error));
  });
}

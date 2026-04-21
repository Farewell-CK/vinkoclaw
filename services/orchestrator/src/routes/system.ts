import express from "express";
import type {
  ApprovalRecord,
  AuditEventRecord,
  GoalRunRecord,
  RoleId,
  TaskRecord,
  VinkoStore
} from "@vinko/shared";
import { listRoles, listSkills, renderPrometheusMetrics } from "@vinko/shared";
import { buildRuntimeCapabilitySnapshot, createToolBackedRegistry, createDefaultRulesEngine, globalTelemetry } from "@vinko/agent-runtime";

export interface SystemRoutesDeps {
  store: VinkoStore;
  buildSystemMetricsSnapshot: () => Record<string, unknown>;
  buildSystemHealthReport: () => Record<string, unknown>;
  buildSystemDailyKpi: (days: number) => Record<string, unknown>;
  sanitizeApprovalRecord: <T extends { payload: Record<string, unknown> }>(approval: T) => T;
  sanitizeOperatorActionRecord: <T extends { payload: Record<string, unknown> }>(action: T) => T;
}

type ActivityTrace = ReturnType<typeof globalTelemetry.listTraces>[number];

interface ActivityFeedEvent {
  id: string;
  kind: "audit" | "trace" | "task" | "goal_run" | "approval";
  source: "audit" | "telemetry" | "task" | "goal_run" | "approval";
  ts: string;
  title: string;
  summary: string;
  entityType: string;
  entityId: string;
  status?: string;
  roleId?: string;
  stage?: string;
  metrics?: {
    rounds?: number;
    toolCalls?: number;
    totalTokens?: number;
    blocked?: number;
  };
}

type ActivityStore = VinkoStore & Partial<{
  listAuditEvents: (limit?: number) => AuditEventRecord[];
  listTasks: (limit?: number) => TaskRecord[];
  listGoalRuns: (input?: { limit?: number | undefined; status?: GoalRunRecord["status"] | undefined }) => GoalRunRecord[];
  listApprovals: (limit?: number) => ApprovalRecord[];
}>;

const MAX_ACTIVITY_FEED_LIMIT = 200;
const DEFAULT_ACTIVITY_FEED_LIMIT = 40;
const ACTIVE_TASK_STATUSES = new Set(["queued", "running", "paused_input", "waiting_approval"]);
const ACTIVE_GOAL_RUN_STATUSES = new Set(["queued", "running", "awaiting_input", "awaiting_authorization"]);

function parseFeedLimit(raw: unknown): number {
  const limit = Number(raw);
  if (!Number.isFinite(limit)) {
    return DEFAULT_ACTIVITY_FEED_LIMIT;
  }
  return Math.max(1, Math.min(MAX_ACTIVITY_FEED_LIMIT, Math.round(limit)));
}

function truncateText(value: string | undefined, max = 140): string {
  const text = String(value ?? "").trim();
  if (!text) {
    return "";
  }
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max - 1)}…`;
}

function toTimestampValue(value: string | undefined): number {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function compareActivityByTimestampDesc(left: ActivityFeedEvent, right: ActivityFeedEvent): number {
  return toTimestampValue(right.ts) - toTimestampValue(left.ts);
}

function buildAuditActivity(event: AuditEventRecord): ActivityFeedEvent {
  const status =
    typeof event.payload?.status === "string" ? String(event.payload.status) : undefined;
  return {
    id: `audit:${event.id}`,
    kind: "audit",
    source: "audit",
    ts: event.createdAt,
    title: `Audit · ${event.category}`,
    summary: truncateText(event.message, 180),
    entityType: event.entityType,
    entityId: event.entityId,
    ...(status ? { status } : {})
  };
}

function buildTraceActivity(trace: ActivityTrace): ActivityFeedEvent {
  const status = trace.completedAt ? "completed" : "running";
  return {
    id: `trace:${trace.taskId}:${trace.completedAt ?? trace.startedAt}`,
    kind: "trace",
    source: "telemetry",
    ts: trace.completedAt ?? trace.startedAt,
    title: status === "completed" ? "Task trace completed" : "Task trace running",
    summary: truncateText(`${trace.roleId} · ${trace.instruction}`, 180),
    entityType: "task",
    entityId: trace.taskId,
    status,
    roleId: trace.roleId,
    metrics: {
      rounds: Array.isArray(trace.turns) ? trace.turns.length : 0,
      toolCalls: Number(trace.metrics?.toolCalls ?? 0),
      totalTokens: Number(trace.metrics?.totalTokens ?? 0),
      blocked: Number(trace.metrics?.roundsBlocked ?? 0)
    }
  };
}

function buildTaskActivity(task: TaskRecord): ActivityFeedEvent {
  return {
    id: `task:${task.id}:${task.status}:${task.updatedAt}`,
    kind: "task",
    source: "task",
    ts: task.updatedAt || task.startedAt || task.createdAt,
    title: `Task ${task.status}`,
    summary: truncateText(`${task.roleId} · ${task.title}`, 180),
    entityType: "task",
    entityId: task.id,
    status: task.status,
    roleId: task.roleId
  };
}

function buildGoalRunActivity(goalRun: GoalRunRecord): ActivityFeedEvent {
  return {
    id: `goal_run:${goalRun.id}:${goalRun.status}:${goalRun.updatedAt}`,
    kind: "goal_run",
    source: "goal_run",
    ts: goalRun.updatedAt || goalRun.startedAt || goalRun.createdAt,
    title: `Goal run ${goalRun.status}`,
    summary: truncateText(`${goalRun.currentStage} · ${goalRun.objective}`, 180),
    entityType: "goal_run",
    entityId: goalRun.id,
    status: goalRun.status,
    stage: goalRun.currentStage
  };
}

function buildApprovalActivity(approval: ApprovalRecord): ActivityFeedEvent {
  return {
    id: `approval:${approval.id}:${approval.status}:${approval.updatedAt}`,
    kind: "approval",
    source: "approval",
    ts: approval.updatedAt || approval.createdAt,
    title: approval.status === "pending" ? "Approval pending" : `Approval ${approval.status}`,
    summary: truncateText(approval.summary, 180),
    entityType: "approval",
    entityId: approval.id,
    status: approval.status
  };
}

export function registerSystemRoutes(app: express.Express, deps: SystemRoutesDeps): void {
  const { store, buildSystemMetricsSnapshot, buildSystemHealthReport, buildSystemDailyKpi, sanitizeApprovalRecord, sanitizeOperatorActionRecord } = deps;

  app.get("/health", (_request, response) => {
    response.json({
      ok: true,
      timestamp: new Date().toISOString(),
      config: store.getRuntimeConfig()
    });
  });

  app.get("/metrics", (_request, response) => {
    const snapshot = store.getDashboardSnapshot();
    response.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    response.send(renderPrometheusMetrics(snapshot));
  });

  app.get("/api/dashboard", (_request, response) => {
    const snapshot = store.getDashboardSnapshot();
    response.json({
      ...snapshot,
      approvals: snapshot.approvals.map((approval) => sanitizeApprovalRecord(approval)),
      operatorActions: snapshot.operatorActions.map((action) => sanitizeOperatorActionRecord(action))
    });
  });

  app.get("/api/system/metrics", (_request, response) => {
    response.json(buildSystemMetricsSnapshot());
  });

  app.get("/api/system/health-report", (_request, response) => {
    const report = buildSystemHealthReport();
    response.status(report.ok ? 200 : 503).json(report);
  });

  app.get("/api/system/kpi/daily", (request, response) => {
    const daysRaw = Number(request.query.days);
    const days = Number.isFinite(daysRaw) ? Math.max(1, Math.min(90, Math.round(daysRaw))) : 14;
    response.json(buildSystemDailyKpi(days));
  });

  app.get("/api/roles", (_request, response) => {
    response.json({
      roles: listRoles().map((role) => ({
        ...role,
        skills: store.resolveSkillsForRole(role.id)
      })),
      catalog: listSkills()
    });
  });

  // ─── Telemetry routes ────────────────────────────────────────────────────

  app.get("/api/system/telemetry", (_request, response) => {
    const traces = globalTelemetry.listTraces();
    const limit = Math.min(Number(_request.query.limit) || 20, 100);
    response.json({
      total: traces.length,
      traces: traces.slice(-limit).reverse()
    });
  });

  app.get("/api/system/activity-feed", (request, response) => {
    const limit = parseFeedLimit(request.query.limit);
    const sourceLimit = Math.max(limit * 2, 20);
    const activityStore = store as ActivityStore;
    const auditEvents =
      typeof activityStore.listAuditEvents === "function" ? activityStore.listAuditEvents(sourceLimit) : [];
    const tasks =
      typeof activityStore.listTasks === "function" ? activityStore.listTasks(sourceLimit) : [];
    const goalRuns =
      typeof activityStore.listGoalRuns === "function" ? activityStore.listGoalRuns({ limit: sourceLimit }) : [];
    const approvals =
      typeof activityStore.listApprovals === "function" ? activityStore.listApprovals(sourceLimit) : [];
    const traces = globalTelemetry.listTraces().slice(0, sourceLimit);

    const allEvents = [
      ...auditEvents.map(buildAuditActivity),
      ...traces.map(buildTraceActivity),
      ...tasks.filter((task) => ACTIVE_TASK_STATUSES.has(task.status)).map(buildTaskActivity),
      ...goalRuns.filter((goalRun) => ACTIVE_GOAL_RUN_STATUSES.has(goalRun.status)).map(buildGoalRunActivity),
      ...approvals.filter((approval) => approval.status === "pending").map(buildApprovalActivity)
    ].sort(compareActivityByTimestampDesc);

    response.json({
      generatedAt: new Date().toISOString(),
      total: allEvents.length,
      events: allEvents.slice(0, limit)
    });
  });

  app.get("/api/system/runtime-harness", (_request, response) => {
    const runtimeSecrets =
      typeof store.getRuntimeSecrets === "function" ? store.getRuntimeSecrets() : {};
    const runtimeSettings =
      typeof store.getRuntimeSettings === "function" ? store.getRuntimeSettings() : {};
    const registry = createToolBackedRegistry({
      workDir: "/tmp/vinkoclaw-runtime-harness",
      secrets: runtimeSecrets,
      searchProvider: runtimeSettings.SEARCH_PROVIDER ?? ""
    });
    const capabilitySnapshot = buildRuntimeCapabilitySnapshot(registry);
    const rulesEngine = createDefaultRulesEngine();
    const catalog = listSkills();
    const roles = listRoles().map((role) => {
      const bindings = store.resolveSkillsForRole(role.id as RoleId);
      return {
        roleId: role.id,
        roleName: role.name,
        total: bindings.length,
        verified: bindings.filter((binding) => binding.verificationStatus === "verified").length,
        unverified: bindings.filter((binding) => (binding.verificationStatus ?? "unverified") === "unverified").length,
        failed: bindings.filter((binding) => binding.verificationStatus === "failed").length,
        bindings: bindings.map((binding) => ({
          skillId: binding.skillId,
          verificationStatus: binding.verificationStatus ?? "unverified",
          source: binding.source ?? "",
          sourceLabel: binding.sourceLabel ?? "",
          version: binding.version ?? "",
          installedAt: binding.installedAt ?? "",
          verifiedAt: binding.verifiedAt ?? ""
        }))
      };
    });
    response.json({
      toolRegistry: {
        mode: capabilitySnapshot.registryMode,
        total: capabilitySnapshot.totalRegistered,
        enabled: capabilitySnapshot.totalEnabled,
        tools: capabilitySnapshot.tools.map((tool) => ({
          id: tool.id,
          name: tool.name,
          category: tool.category,
          riskLevel: tool.riskLevel,
          enabledByDefault: tool.enabled,
          tags: tool.tags
        }))
      },
      rulesEngine: {
        mode: "default",
        total: rulesEngine.listRules().length,
        rules: rulesEngine.listRules().map((rule) => ({
          id: rule.id,
          toolId: rule.toolId,
          phase: rule.phase,
          action: rule.action,
          reason: rule.reason
        }))
      },
      skills: {
        mode: "role_bound",
        catalogTotal: catalog.length,
        catalog: catalog.map((skill) => ({
          skillId: skill.id,
          name: skill.name,
          allowedRoles: skill.allowedRoles,
          aliases: skill.aliases
        })),
        roles
      }
    });
  });

  app.get("/api/tasks/:id/trace", (request, response) => {
    const trace = globalTelemetry.getTrace(request.params.id);
    if (!trace) {
      return response.status(404).json({ error: "No trace found for this task" });
    }
    response.json(trace);
  });
}

import express from "express";
import type {
  ApprovalRecord,
  AuditEventRecord,
  GoalRunRecord,
  RoleId,
  TaskRecord,
  VinkoStore
} from "@vinko/shared";
import {
  applyLowRiskEvolutionProposals,
  extractEvolutionSignalFromHarnessGrade,
  getEvolutionState,
  listHarnessGrades,
  listRoles,
  listSkills,
  renderPrometheusMetrics,
  recordEvolutionSignals,
  rollbackLatestEvolutionChange
} from "@vinko/shared";
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

interface ActivityAuditDetails {
  category: string;
  eventType?: string;
  stage?: string;
  intent?: string;
  reason?: string;
  matchedRules?: string[];
  matchedKeywords?: string[];
  templateId?: string;
  templateName?: string;
  confidence?: string;
  textPreview?: string;
  routerVersion?: string;
  decisionSource?: string;
  validatorStatus?: string;
  fallbackReason?: string;
  primaryRole?: string;
  supportingRoles?: string[];
  selectedMode?: string;
  sessionId?: string;
  taskId?: string;
  action?: string;
  actionId?: string;
  clientActionId?: string;
  resultType?: string;
  goalRunId?: string;
  approvalId?: string;
  operatorActionId?: string;
}

interface ActivityFeedEvent {
  id: string;
  kind: "audit" | "trace" | "task" | "goal_run" | "approval";
  source: "audit" | "telemetry" | "task" | "goal_run" | "approval";
  ts: string;
  title: string;
  summary: string;
  entityType: string;
  entityId: string;
  eventType?: string;
  status?: string;
  roleId?: string;
  stage?: string;
  metrics?: {
    rounds?: number;
    toolCalls?: number;
    totalTokens?: number;
    blocked?: number;
  };
  audit?: ActivityAuditDetails;
}

interface ActivityFeedSnapshot {
  generatedAt: string;
  total: number;
  events: ActivityFeedEvent[];
}

interface TelemetrySnapshot {
  total: number;
  traces: ActivityTrace[];
}

function syncEvolutionFromHarnessGrades(store: VinkoStore): void {
  const harnessStore = store as VinkoStore & Partial<{ getConfigEntry: <T>(key: string) => T | undefined }>;
  const harnessRootDir = harnessStore.getConfigEntry?.<string>("self-check:harness-root-dir");
  if (!harnessRootDir || typeof harnessRootDir !== "string") {
    return;
  }
  const grades = listHarnessGrades(harnessRootDir);
  const signals = grades
    .map((grade) => extractEvolutionSignalFromHarnessGrade(grade))
    .filter((signal): signal is NonNullable<typeof signal> => Boolean(signal));
  if (signals.length === 0) {
    return;
  }
  recordEvolutionSignals(store, signals);
  applyLowRiskEvolutionProposals(store);
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

function toStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function toTimestampValue(value: string | undefined): number {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function compareActivityByTimestampDesc(left: ActivityFeedEvent, right: ActivityFeedEvent): number {
  return toTimestampValue(right.ts) - toTimestampValue(left.ts);
}

function buildAuditDetails(event: AuditEventRecord): ActivityAuditDetails {
  const payload = event.payload ?? {};
  const matchedRules = toStringList(payload.matchedRules);
  const matchedKeywords = toStringList(payload.matchedKeywords);
  return {
    category: event.category,
    ...(typeof payload.eventType === "string" ? { eventType: payload.eventType } : {}),
    ...(typeof payload.stage === "string" ? { stage: payload.stage } : {}),
    ...(typeof payload.intent === "string" ? { intent: payload.intent } : {}),
    ...(typeof payload.reason === "string" ? { reason: payload.reason } : {}),
    ...(matchedRules ? { matchedRules } : {}),
    ...(matchedKeywords ? { matchedKeywords } : {}),
    ...(typeof payload.templateId === "string" ? { templateId: payload.templateId } : {}),
    ...(typeof payload.templateName === "string" ? { templateName: payload.templateName } : {}),
    ...(typeof payload.confidence === "string" ? { confidence: payload.confidence } : {}),
    ...(typeof payload.textPreview === "string" ? { textPreview: truncateText(payload.textPreview, 180) } : {}),
    ...(typeof payload.routerVersion === "string" ? { routerVersion: payload.routerVersion } : {}),
    ...(typeof payload.decisionSource === "string" ? { decisionSource: payload.decisionSource } : {}),
    ...(typeof payload.validatorStatus === "string" ? { validatorStatus: payload.validatorStatus } : {}),
    ...(typeof payload.fallbackReason === "string" ? { fallbackReason: payload.fallbackReason } : {}),
    ...(typeof payload.primaryRole === "string" ? { primaryRole: payload.primaryRole } : {}),
    ...(typeof payload.selectedMode === "string" ? { selectedMode: payload.selectedMode } : {}),
    ...(typeof payload.sessionId === "string" ? { sessionId: payload.sessionId } : {}),
    ...(typeof payload.taskId === "string" ? { taskId: payload.taskId } : {}),
    ...(typeof payload.action === "string" ? { action: payload.action } : {}),
    ...(typeof payload.actionId === "string" ? { actionId: payload.actionId } : {}),
    ...(typeof payload.clientActionId === "string" ? { clientActionId: payload.clientActionId } : {}),
    ...(typeof payload.resultType === "string" ? { resultType: payload.resultType } : {}),
    ...(typeof payload.goalRunId === "string" ? { goalRunId: payload.goalRunId } : {}),
    ...(typeof payload.approvalId === "string" ? { approvalId: payload.approvalId } : {}),
    ...(typeof payload.operatorActionId === "string" ? { operatorActionId: payload.operatorActionId } : {}),
    ...(Array.isArray(toStringList(payload.supportingRoles))
      ? { supportingRoles: toStringList(payload.supportingRoles) as string[] }
      : {})
  };
}

function buildAuditActivity(event: AuditEventRecord): ActivityFeedEvent {
  const status =
    typeof event.payload?.status === "string" ? String(event.payload.status) : undefined;
  return {
    id: `audit:${event.id}`,
    kind: "audit",
    source: "audit",
    ts: event.createdAt,
    title: `Audit · ${typeof event.payload?.eventType === "string" ? event.payload.eventType : event.category}`,
    summary: truncateText(event.message, 180),
    entityType: event.entityType,
    entityId: event.entityId,
    ...(typeof event.payload?.eventType === "string" ? { eventType: String(event.payload.eventType) } : {}),
    audit: buildAuditDetails(event),
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
    eventType: `task_${task.status}`,
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
    eventType: `goal_run_${goalRun.status}`,
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
    eventType: `approval_${approval.status}`,
    status: approval.status
  };
}

function buildTelemetrySnapshot(limitRaw: unknown): TelemetrySnapshot {
  const traces = globalTelemetry.listTraces();
  const limit = Math.min(Number(limitRaw) || 20, 100);
  return {
    total: traces.length,
    traces: traces.slice(-limit).reverse()
  };
}

function buildActivityFeedSnapshot(store: VinkoStore, limitRaw: unknown): ActivityFeedSnapshot {
  const limit = parseFeedLimit(limitRaw);
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

  return {
    generatedAt: new Date().toISOString(),
    total: allEvents.length,
    events: allEvents.slice(0, limit)
  };
}

function writeSseEvent(
  response: express.Response,
  input: {
    event: string;
    data: unknown;
    id?: string;
  }
): void {
  if (input.id) {
    response.write(`id: ${input.id}\n`);
  }
  response.write(`event: ${input.event}\n`);
  response.write(`data: ${JSON.stringify(input.data)}\n\n`);
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
    response.json(buildTelemetrySnapshot(_request.query.limit));
  });

  app.get("/api/system/activity-feed", (request, response) => {
    response.json(buildActivityFeedSnapshot(store, request.query.limit));
  });

  app.get("/api/system/activity-feed/stream", (request, response) => {
    const limit = parseFeedLimit(request.query.limit);
    const pollMsRaw = Number(request.query.pollMs);
    const pollMs = Number.isFinite(pollMsRaw) ? Math.max(1000, Math.min(10000, Math.round(pollMsRaw))) : 2000;
    response.status(200);
    response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("Connection", "keep-alive");
    response.setHeader("X-Accel-Buffering", "no");
    response.flushHeaders?.();

    let previousSignature = "";
    let heartbeatCount = 0;
    const emitSnapshot = () => {
      const activity = buildActivityFeedSnapshot(store, limit);
      const telemetry = buildTelemetrySnapshot(Math.min(limit, 20));
      const signature = JSON.stringify({
        activityIds: activity.events.map((event) => event.id),
        traceIds: telemetry.traces.map((trace) => `${trace.taskId}:${trace.completedAt ?? trace.startedAt}`)
      });
      if (signature === previousSignature) {
        return;
      }
      previousSignature = signature;
      writeSseEvent(response, {
        event: "snapshot",
        id: `snapshot:${activity.generatedAt}`,
        data: {
          generatedAt: activity.generatedAt,
          activity,
          telemetry
        }
      });
    };

    writeSseEvent(response, {
      event: "ready",
      id: `ready:${Date.now()}`,
      data: {
        ok: true,
        pollMs,
        limit
      }
    });
    emitSnapshot();

    const interval = setInterval(() => {
      heartbeatCount += 1;
      writeSseEvent(response, {
        event: "heartbeat",
        id: `heartbeat:${Date.now()}`,
        data: {
          heartbeatCount,
          ts: new Date().toISOString()
        }
      });
      emitSnapshot();
    }, pollMs);

    const cleanup = () => {
      clearInterval(interval);
      response.end();
    };
    request.on("close", cleanup);
    request.on("end", cleanup);
  });

  app.get("/api/system/runtime-harness", (_request, response) => {
    syncEvolutionFromHarnessGrades(store);
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
      },
      evolution: (() => {
        const state = getEvolutionState(store);
        const proposed = state.proposals.filter((proposal) => proposal.status === "proposed");
        const applied = state.proposals.filter((proposal) => proposal.status === "applied");
        const runtimeConfig = store.getRuntimeConfig();
        return {
          signals: state.signals.length,
          proposals: state.proposals.length,
          proposed: proposed.length,
          applied: applied.length,
          routerConfig: {
            confidenceThreshold: runtimeConfig.evolution.router.confidenceThreshold,
            preferValidatedFallbacks: runtimeConfig.evolution.router.preferValidatedFallbacks,
            templateHintCount: runtimeConfig.evolution.router.templateHints.length
          },
          intakeConfig: {
            preferClarificationForShortVagueRequests:
              runtimeConfig.evolution.intake.preferClarificationForShortVagueRequests,
            shortVagueRequestMaxLength: runtimeConfig.evolution.intake.shortVagueRequestMaxLength,
            directConversationMaxLength: runtimeConfig.evolution.intake.directConversationMaxLength,
            ambiguousConversationMaxLength: runtimeConfig.evolution.intake.ambiguousConversationMaxLength,
            collaborationMinLength: runtimeConfig.evolution.intake.collaborationMinLength,
            requireExplicitTeamSignal: runtimeConfig.evolution.intake.requireExplicitTeamSignal
          },
          collaborationConfig: {
            partialDeliveryMinCompletedRoles: runtimeConfig.evolution.collaboration.partialDeliveryMinCompletedRoles,
            timeoutNoProgressMode: runtimeConfig.evolution.collaboration.timeoutNoProgressMode,
            terminalFailureNoProgressMode: runtimeConfig.evolution.collaboration.terminalFailureNoProgressMode,
            manualResumeAggregationMode: runtimeConfig.evolution.collaboration.manualResumeAggregationMode
          },
          skillRecommendationCount: runtimeConfig.evolution.skills.recommendations.length,
          latestSignals: state.signals.slice(-5).reverse(),
          latestProposal: proposed[0] ?? null,
          latestAppliedChange: state.appliedChanges[state.appliedChanges.length - 1] ?? null
        };
      })()
    });
  });

  app.get("/api/system/evolution", (_request, response) => {
    syncEvolutionFromHarnessGrades(store);
    const state = getEvolutionState(store);
    response.json({
      version: state.version,
      updatedAt: state.updatedAt,
      signalCount: state.signals.length,
      proposalCount: state.proposals.length,
      appliedChangeCount: state.appliedChanges.length,
      runtimeConfig: store.getRuntimeConfig().evolution,
      signals: state.signals.slice(-50).reverse(),
      proposals: state.proposals.slice(-20).reverse(),
      appliedChanges: state.appliedChanges.slice(-20).reverse()
    });
  });

  app.post("/api/system/evolution/rollback-latest", (_request, response) => {
    const before = getEvolutionState(store);
    const previousLatest = before.appliedChanges[before.appliedChanges.length - 1] ?? null;
    const next = rollbackLatestEvolutionChange(store);
    response.json({
      ok: previousLatest !== null,
      rolledBack: previousLatest,
      version: next.version,
      signalCount: next.signals.length,
      proposalCount: next.proposals.length,
      appliedChangeCount: next.appliedChanges.length,
      runtimeConfig: store.getRuntimeConfig().evolution,
      latestAppliedChange: next.appliedChanges[next.appliedChanges.length - 1] ?? null
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

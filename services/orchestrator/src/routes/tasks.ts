import express from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  orchestratorCreateTaskSchema,
  orchestratorInboundMessageSchema,
  orchestratorSessionActionSchema,
  orchestratorTaskSplitSchema
} from "@vinko/protocol";
import type { SessionActionKind } from "@vinko/protocol";
import {
  buildSessionWorkbenchSnapshotFromStore,
  buildProjectBoardSnapshot,
  buildWorkflowStatusSummary,
  findProjectBoardProject,
  listProjectBoardAttentionItems,
  listProjectBoardProjects
} from "@vinko/shared";
import type {
  ApprovalRecord,
  AuditEventRecord,
  GoalRunRecord,
  RoleId,
  SessionMessageRecord,
  TaskAttachment,
  TaskMetadata,
  TaskRecord,
  VinkoStore,
  WorkspaceMemoryFactRecord
} from "@vinko/shared";
import { enrichTaskRecord } from "./response-utils.js";
import { buildRecurringStatusSnapshot } from "./recurring.js";

type InboundResult = {
  message: string;
  type?: string | undefined;
  taskId?: string | undefined;
  goalRunId?: string | undefined;
  actionId?: string | undefined;
  approvalId?: string | undefined;
  [key: string]: unknown;
};

type SessionTimelineEventKind = "message" | "task" | "goal_run" | "approval" | "audit";

interface SessionTimelineEvent {
  id: string;
  kind: SessionTimelineEventKind;
  ts: string;
  title: string;
  summary: string;
  entityType: string;
  entityId: string;
  status?: string | undefined;
  roleId?: string | undefined;
  eventType?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

interface SessionTimelineSnapshot {
  sessionId: string;
  actionId?: string | undefined;
  generatedAt: string;
  total: number;
  events: SessionTimelineEvent[];
}

interface VerifiedArtifactSummary {
  path: string;
  exists: boolean;
  resolvedPath?: string | undefined;
}

export interface TaskRoutesDeps {
  store: VinkoStore;
  ensureInboundSession: (input: {
    source: "control-center" | "feishu" | "email" | "system";
    requestedBy?: string | undefined;
    chatId?: string | undefined;
    titleHint: string;
  }) => string | undefined;
  selectRoleFromText: (text: string) => RoleId;
  shorten: (value: string, length?: number) => string;
  normalizeAttachments: (value: unknown) => TaskAttachment[];
  handleInboundMessage: (input: {
    sessionId?: string | undefined;
    text: string;
    taskText?: string | undefined;
    source: "control-center" | "feishu" | "email" | "system";
    requestedBy?: string | undefined;
    chatId?: string | undefined;
    clientActionId?: string | undefined;
    attachments?: TaskAttachment[] | undefined;
  }) => Promise<InboundResult>;
  buildAutoSplitSpecs: (
    task: TaskRecord,
    maxTasks?: number
  ) => Array<{
    roleId: RoleId;
    title: string;
    instruction: string;
    priority?: number | undefined;
  }>;
  splitTaskIntoChildren: (input: {
    parentTask: TaskRecord;
    requestedBy?: string | undefined;
    specs: Array<{
      roleId: RoleId;
      title: string;
      instruction: string;
      priority?: number | undefined;
    }>;
  }) => TaskRecord[];
}

export function registerTaskRoutes(app: express.Express, deps: TaskRoutesDeps): void {
  const {
    store,
    ensureInboundSession,
    selectRoleFromText,
    shorten,
    normalizeAttachments,
    handleInboundMessage,
    buildAutoSplitSpecs,
    splitTaskIntoChildren
  } = deps;

  function buildProjectBoardInput() {
    const sessions = store.listSessions(100);
    const tasks = store.listTasks(500);
    const goalRuns = store.listGoalRuns?.({ limit: 500 }) ?? [];
    return {
      sessions,
      tasks,
      roleBindingsByRole: {
        ceo: store.resolveSkillsForRole("ceo"),
        cto: store.resolveSkillsForRole("cto"),
        product: store.resolveSkillsForRole("product"),
        uiux: store.resolveSkillsForRole("uiux"),
        frontend: store.resolveSkillsForRole("frontend"),
        backend: store.resolveSkillsForRole("backend"),
        algorithm: store.resolveSkillsForRole("algorithm"),
        qa: store.resolveSkillsForRole("qa"),
        developer: store.resolveSkillsForRole("developer"),
        engineering: store.resolveSkillsForRole("engineering"),
        research: store.resolveSkillsForRole("research"),
        operations: store.resolveSkillsForRole("operations")
      },
      workspaceMemory: store.getWorkspaceMemory?.(),
      crmLeads: store.listCrmLeads?.({ limit: 500 }) ?? [],
      crmCadences: store.listCrmCadences?.({ limit: 500 }) ?? [],
      crmContacts: store.listCrmContacts?.({ limit: 500 }) ?? [],
      goalRuns,
      goalRunHandoffs: goalRuns.flatMap((run) =>
        (store.listGoalRunHandoffArtifacts?.(run.id, 20) ?? []).map((entry) => ({
          id: entry.id,
          goalRunId: run.id,
          artifact: entry.artifact
        }))
      ),
      goalRunTraces: goalRuns.flatMap((run) => store.listGoalRunTraces?.(run.id, 20) ?? [])
    };
  }

  function verifyArtifactPath(artifactPath: string): VerifiedArtifactSummary {
    const value = artifactPath.trim();
    const candidates = path.isAbsolute(value)
      ? [value]
      : [
          path.resolve(process.cwd(), value),
          path.resolve(process.cwd(), "..", value),
          path.resolve(process.cwd(), "..", "..", value)
        ];
    const resolvedPath = candidates.find((candidate) => existsSync(candidate));
    return {
      path: value,
      exists: Boolean(resolvedPath),
      ...(resolvedPath ? { resolvedPath } : {})
    };
  }

  function parseTimelineLimit(raw: unknown): number {
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      return 30;
    }
    return Math.max(1, Math.min(200, Math.round(value)));
  }

  function parseTimelineActionId(raw: unknown): string | undefined {
    const actionId = typeof raw === "string" ? raw.trim() : "";
    return actionId ? actionId.slice(0, 200) : undefined;
  }

  function timestampValue(value: string | undefined): number {
    const parsed = Date.parse(String(value ?? ""));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function truncateTimelineText(value: string | undefined, max = 180): string {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    if (!text) {
      return "";
    }
    return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
  }

  function createSessionActionId(action: SessionActionKind, sessionId: string): string {
    const random = Math.random().toString(36).slice(2, 10);
    return `session_action_${action}_${sessionId.slice(0, 8)}_${Date.now().toString(36)}${random}`;
  }

  function buildSessionActionLabel(action: SessionActionKind): string {
    if (action === "supplement") {
      return "supplement";
    }
    if (action === "rerun-goalrun") {
      return "rerun_goalrun";
    }
    return "continue";
  }

  function listSessionActionAuditEvents(sessionId: string, actionId: string): AuditEventRecord[] {
    const auditStore = store as VinkoStore & Partial<{ listAuditEvents: (limit?: number) => AuditEventRecord[] }>;
    return (auditStore.listAuditEvents?.(500) ?? []).filter((event) => {
      if (event.category !== "session-action" || event.entityType !== "session" || event.entityId !== sessionId) {
        return false;
      }
      const payloadActionId =
        typeof event.payload?.actionId === "string"
          ? event.payload.actionId
          : typeof event.payload?.clientActionId === "string"
            ? event.payload.clientActionId
            : "";
      return payloadActionId === actionId;
    });
  }

  function findExistingSessionActionAudit(sessionId: string, actionId: string): AuditEventRecord | undefined {
    const priority = new Map([
      ["session_action_completed", 3],
      ["session_action_failed", 2],
      ["session_action_requested", 1]
    ]);
    return listSessionActionAuditEvents(sessionId, actionId)
      .filter((event) => typeof event.payload?.eventType === "string" && priority.has(event.payload.eventType))
      .sort((left, right) => {
        const leftPriority = priority.get(String(left.payload.eventType)) ?? 0;
        const rightPriority = priority.get(String(right.payload.eventType)) ?? 0;
        if (leftPriority !== rightPriority) {
          return rightPriority - leftPriority;
        }
        return timestampValue(right.createdAt) - timestampValue(left.createdAt);
      })[0];
  }

  function buildExistingSessionActionResponse(input: {
    sessionId: string;
    actionId: string;
    requestedAction: SessionActionKind;
    auditEvent: AuditEventRecord;
  }): Record<string, unknown> {
    const payload = input.auditEvent.payload ?? {};
    const action = typeof payload.action === "string" ? payload.action : input.requestedAction;
    const responseState = safeBuildSessionActionResponseState(input.sessionId, input.actionId);
    return {
      duplicate: true,
      actionId: input.actionId,
      action,
      duplicateStatus:
        payload.eventType === "session_action_completed"
          ? "completed"
          : payload.eventType === "session_action_failed"
            ? "failed"
            : "in_flight",
      existing: {
        auditEventId: input.auditEvent.id,
        eventType: typeof payload.eventType === "string" ? payload.eventType : undefined,
        resultType: typeof payload.resultType === "string" ? payload.resultType : undefined,
        taskId: typeof payload.taskId === "string" ? payload.taskId : undefined,
        goalRunId: typeof payload.goalRunId === "string" ? payload.goalRunId : undefined,
        approvalId: typeof payload.approvalId === "string" ? payload.approvalId : undefined,
        operatorActionId: typeof payload.operatorActionId === "string" ? payload.operatorActionId : undefined,
        createdAt: input.auditEvent.createdAt
      },
      ...responseState
    };
  }

  function formatSessionActionInstruction(input: {
    action: SessionActionKind;
    sessionId: string;
    supplement?: string | undefined;
  }): string {
    const workbench = buildSessionWorkbenchDetail(input.sessionId);
    const snapshot = workbench?.snapshot;
    const timeline = workbench?.timeline;
    const goal = snapshot?.currentGoal || snapshot?.sessionTitle || workbench?.session?.title || "当前目标";
    const blockers = Array.isArray(snapshot?.blockers) ? snapshot.blockers : [];
    const nextActions = Array.isArray(snapshot?.nextActions) ? snapshot.nextActions : [];
    const latestArtifacts = Array.isArray(snapshot?.latestArtifacts) ? snapshot.latestArtifacts : [];
    const timelineHints = Array.isArray(timeline?.events)
      ? timeline.events
          .slice(0, 5)
          .map((event) => `${event.eventType || event.kind}:${event.summary}`)
          .filter(Boolean)
      : [];
    const supplement = input.supplement?.trim();
    if (input.action === "supplement") {
      return [
        `这是对当前会话的补充信息，请续接原任务并继续推进：${supplement || "用户未提供额外文本，请基于当前会话继续判断。"}`,
        `当前目标：${goal}`,
        `下一步：${nextActions.join("；") || "按时间线判断下一步"}`,
        `阻塞项：${blockers.join("；") || "暂无阻塞"}`,
        `最近产物：${latestArtifacts.join("；") || "暂无产物"}`
      ].join("\n");
    }
    if (input.action === "rerun-goalrun") {
      return [
        `请基于当前会话重新触发一次 GoalRun，目标是：${goal}。`,
        "要求：结合已有时间线、阻塞项和产物，不要重复已完成部分；如果需要授权或澄清，明确提出。",
        `下一步：${nextActions.join("；") || "按时间线判断下一步"}`,
        `阻塞项：${blockers.join("；") || "暂无阻塞"}`,
        `最近产物：${latestArtifacts.join("；") || "暂无产物"}`,
        `最近时间线：${timelineHints.join("；") || "暂无时间线"}`
      ].join("\n");
    }
    return [
      `请继续推进当前会话：${goal}。`,
      `优先处理这些下一步：${nextActions.join("；") || "按时间线判断下一步"}。`,
      `如果存在阻塞，请先解决或提出明确问题：${blockers.join("；") || "暂无阻塞"}。`,
      `最近产物：${latestArtifacts.join("；") || "暂无产物"}。`,
      `最近时间线：${timelineHints.join("；") || "暂无时间线"}。`
    ].join("\n");
  }

  function buildSessionWorkbenchDetail(sessionId: string) {
    const session = store.getSession(sessionId);
    if (!session) {
      return undefined;
    }
    const snapshot = buildSessionWorkbenchSnapshotFromStore({
      store,
      sessionId: session.id
    });
    if (!snapshot) {
      return undefined;
    }
    const allTasks = store.listTasks(500);
    const tasksById = new Map(allTasks.map((task) => [task.id, task]));
    const sessionTasks = allTasks
      .filter((task) => task.sessionId === session.id)
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .slice(0, 12)
      .map((task) => enrichTaskRecord(store, task));
    const sessionGoalRuns = (store.listGoalRuns?.({ limit: 500 }) ?? [])
      .filter((goalRun) => goalRun.sessionId === session.id)
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .slice(0, 8);
    const sessionApprovals = store
      .listApprovals(500)
      .filter((approval) => approvalBelongsToSession(approval, session.id, tasksById))
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .slice(0, 8);
    return {
      session,
      snapshot,
      tasks: sessionTasks,
      goalRuns: sessionGoalRuns,
      approvals: sessionApprovals,
      messages: store.listSessionMessages(session.id, 60),
      timeline: buildSessionTimelineSnapshot(session.id, 30)
    };
  }

  function safeBuildSessionActionResponseState(
    sessionId: string,
    actionId?: string | undefined
  ): {
    workbench?: ReturnType<typeof buildSessionWorkbenchDetail> | undefined;
    timeline?: SessionTimelineSnapshot | undefined;
    refreshError?: string | undefined;
  } {
    try {
      return {
        workbench: buildSessionWorkbenchDetail(sessionId),
        timeline: buildSessionTimelineSnapshot(sessionId, 30, actionId)
      };
    } catch (error) {
      return {
        refreshError: error instanceof Error ? error.message : String(error)
      };
    }
  }

  function buildMessageTimelineEvent(message: SessionMessageRecord): SessionTimelineEvent {
    const actionId = typeof message.metadata?.clientActionId === "string" ? message.metadata.clientActionId.trim() : "";
    return {
      id: `message:${message.id}`,
      kind: "message",
      ts: message.createdAt,
      title: message.actorType === "user" ? "User message" : message.actorType === "role" ? "Agent message" : "System message",
      summary: truncateTimelineText(message.content),
      entityType: "message",
      entityId: message.id,
      eventType: message.messageType,
      roleId: message.roleId,
      metadata: {
        actorType: message.actorType,
        actorId: message.actorId,
        clientActionId: actionId || undefined
      }
    };
  }

  function buildTaskTimelineEvent(task: TaskRecord): SessionTimelineEvent {
    return {
      id: `task:${task.id}:${task.status}:${task.updatedAt}`,
      kind: "task",
      ts: task.updatedAt || task.startedAt || task.createdAt,
      title: `Task ${task.status}`,
      summary: truncateTimelineText(`${task.roleId} · ${task.title}`),
      entityType: "task",
      entityId: task.id,
      eventType: `task_${task.status}`,
      status: task.status,
      roleId: task.roleId,
      metadata: {
        source: task.source,
        hasResult: Boolean(task.result),
        hasPendingInput: Boolean(task.pendingInput)
      }
    };
  }

  function buildGoalRunTimelineEvent(goalRun: GoalRunRecord): SessionTimelineEvent {
    return {
      id: `goal_run:${goalRun.id}:${goalRun.status}:${goalRun.updatedAt}`,
      kind: "goal_run",
      ts: goalRun.updatedAt || goalRun.startedAt || goalRun.createdAt,
      title: `Goal run ${goalRun.status}`,
      summary: truncateTimelineText(`${goalRun.currentStage} · ${goalRun.objective}`),
      entityType: "goal_run",
      entityId: goalRun.id,
      eventType: `goal_run_${goalRun.status}`,
      status: goalRun.status,
      metadata: {
        stage: goalRun.currentStage,
        currentTaskId: goalRun.currentTaskId
      }
    };
  }

  function buildApprovalTimelineEvent(approval: ApprovalRecord): SessionTimelineEvent {
    return {
      id: `approval:${approval.id}:${approval.status}:${approval.updatedAt}`,
      kind: "approval",
      ts: approval.updatedAt || approval.createdAt,
      title: approval.status === "pending" ? "Approval pending" : `Approval ${approval.status}`,
      summary: truncateTimelineText(approval.summary),
      entityType: "approval",
      entityId: approval.id,
      eventType: `approval_${approval.status}`,
      status: approval.status,
      metadata: {
        kind: approval.kind,
        taskId: approval.taskId,
        operatorActionId: approval.operatorActionId
      }
    };
  }

  function buildAuditTimelineEvent(event: AuditEventRecord): SessionTimelineEvent {
    const clientActionId =
      typeof event.payload?.clientActionId === "string"
        ? event.payload.clientActionId
        : typeof event.payload?.actionId === "string"
          ? event.payload.actionId
          : undefined;
    return {
      id: `audit:${event.id}`,
      kind: "audit",
      ts: event.createdAt,
      title: `Audit · ${typeof event.payload?.eventType === "string" ? event.payload.eventType : event.category}`,
      summary: truncateTimelineText(event.message),
      entityType: event.entityType,
      entityId: event.entityId,
      eventType: typeof event.payload?.eventType === "string" ? event.payload.eventType : undefined,
      status: typeof event.payload?.status === "string" ? event.payload.status : undefined,
      metadata: {
        category: event.category,
        taskId: typeof event.payload?.taskId === "string" ? event.payload.taskId : undefined,
        sessionId: typeof event.payload?.sessionId === "string" ? event.payload.sessionId : undefined,
        clientActionId,
        action: typeof event.payload?.action === "string" ? event.payload.action : undefined,
        resultType: typeof event.payload?.resultType === "string" ? event.payload.resultType : undefined,
        goalRunId: typeof event.payload?.goalRunId === "string" ? event.payload.goalRunId : undefined,
        approvalId: typeof event.payload?.approvalId === "string" ? event.payload.approvalId : undefined,
        operatorActionId: typeof event.payload?.operatorActionId === "string" ? event.payload.operatorActionId : undefined
      }
    };
  }

  function metadataString(event: SessionTimelineEvent, key: string): string {
    const value = event.metadata?.[key];
    return typeof value === "string" ? value.trim() : "";
  }

  function timelineEventActionId(event: SessionTimelineEvent): string {
    return metadataString(event, "clientActionId");
  }

  function filterTimelineEventsByActionId(events: SessionTimelineEvent[], actionId?: string | undefined): SessionTimelineEvent[] {
    if (!actionId) {
      return events;
    }
    const relatedTaskIds = new Set<string>();
    const relatedGoalRunIds = new Set<string>();
    const relatedApprovalIds = new Set<string>();
    const relatedOperatorActionIds = new Set<string>();

    for (const event of events) {
      if (timelineEventActionId(event) !== actionId) {
        continue;
      }
      if (event.entityType === "task") {
        relatedTaskIds.add(event.entityId);
      }
      if (event.entityType === "goal_run") {
        relatedGoalRunIds.add(event.entityId);
      }
      if (event.entityType === "approval") {
        relatedApprovalIds.add(event.entityId);
      }
      const taskId = metadataString(event, "taskId");
      const currentTaskId = metadataString(event, "currentTaskId");
      const goalRunId = metadataString(event, "goalRunId");
      const approvalId = metadataString(event, "approvalId");
      const operatorActionId = metadataString(event, "operatorActionId");
      if (taskId) {
        relatedTaskIds.add(taskId);
      }
      if (currentTaskId) {
        relatedTaskIds.add(currentTaskId);
      }
      if (goalRunId) {
        relatedGoalRunIds.add(goalRunId);
      }
      if (approvalId) {
        relatedApprovalIds.add(approvalId);
      }
      if (operatorActionId) {
        relatedOperatorActionIds.add(operatorActionId);
      }
    }

    return events.filter((event) => {
      if (timelineEventActionId(event) === actionId) {
        return true;
      }
      if (event.entityType === "task" && relatedTaskIds.has(event.entityId)) {
        return true;
      }
      if (event.entityType === "goal_run" && relatedGoalRunIds.has(event.entityId)) {
        return true;
      }
      if (event.entityType === "approval" && relatedApprovalIds.has(event.entityId)) {
        return true;
      }
      const taskId = metadataString(event, "taskId");
      const currentTaskId = metadataString(event, "currentTaskId");
      const operatorActionId = metadataString(event, "operatorActionId");
      return (
        Boolean(taskId && relatedTaskIds.has(taskId)) ||
        Boolean(currentTaskId && relatedTaskIds.has(currentTaskId)) ||
        Boolean(operatorActionId && relatedOperatorActionIds.has(operatorActionId))
      );
    });
  }

  function approvalBelongsToSession(approval: ApprovalRecord, sessionId: string, tasksById: Map<string, TaskRecord>): boolean {
    const payloadSessionId = typeof approval.payload?.sessionId === "string" ? approval.payload.sessionId.trim() : "";
    if (payloadSessionId === sessionId) {
      return true;
    }
    return Boolean(approval.taskId && tasksById.get(approval.taskId)?.sessionId === sessionId);
  }

  function auditBelongsToSession(event: AuditEventRecord, sessionId: string, tasksById: Map<string, TaskRecord>): boolean {
    if (event.entityType === "session" && event.entityId === sessionId) {
      return true;
    }
    const payloadSessionId = typeof event.payload?.sessionId === "string" ? event.payload.sessionId.trim() : "";
    if (payloadSessionId === sessionId) {
      return true;
    }
    const payloadTaskId = typeof event.payload?.taskId === "string" ? event.payload.taskId.trim() : "";
    if (payloadTaskId && tasksById.get(payloadTaskId)?.sessionId === sessionId) {
      return true;
    }
    return event.entityType === "task" && tasksById.get(event.entityId)?.sessionId === sessionId;
  }

  function buildSessionTimelineSnapshot(
    sessionId: string,
    limit: number,
    actionId?: string | undefined
  ): SessionTimelineSnapshot {
    const allTasks = store.listTasks(500);
    const tasksById = new Map(allTasks.map((task) => [task.id, task]));
    const sessionTasks = allTasks.filter((task) => task.sessionId === sessionId);
    const sessionGoalRuns = (store.listGoalRuns?.({ limit: 500 }) ?? []).filter((goalRun) => goalRun.sessionId === sessionId);
    const sessionApprovals = store.listApprovals(500).filter((approval) => approvalBelongsToSession(approval, sessionId, tasksById));
    const sessionMessages = store.listSessionMessages(sessionId, 500);
    const auditStore = store as VinkoStore & Partial<{ listAuditEvents: (limit?: number) => AuditEventRecord[] }>;
    const sessionAuditEvents = (auditStore.listAuditEvents?.(500) ?? []).filter((event) =>
      auditBelongsToSession(event, sessionId, tasksById)
    );
    const events = filterTimelineEventsByActionId([
      ...sessionMessages.map(buildMessageTimelineEvent),
      ...sessionTasks.map(buildTaskTimelineEvent),
      ...sessionGoalRuns.map(buildGoalRunTimelineEvent),
      ...sessionApprovals.map(buildApprovalTimelineEvent),
      ...sessionAuditEvents.map(buildAuditTimelineEvent)
    ].sort((left, right) => timestampValue(right.ts) - timestampValue(left.ts)), actionId);

    return {
      sessionId,
      ...(actionId ? { actionId } : {}),
      generatedAt: new Date().toISOString(),
      total: events.length,
      events: events.slice(0, limit)
    };
  }

  function writeSseEvent(
    response: express.Response,
    input: {
      event: string;
      data: unknown;
      id?: string | undefined;
    }
  ): void {
    if (input.id) {
      response.write(`id: ${input.id}\n`);
    }
    response.write(`event: ${input.event}\n`);
    response.write(`data: ${JSON.stringify(input.data)}\n\n`);
  }

  app.get("/api/tasks", (_request, response) => {
    response.json(store.listTasks(100).map((task) => enrichTaskRecord(store, task)));
  });

  app.get("/api/sessions", (request, response) => {
    const limitRaw = Number(request.query.limit);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, Math.round(limitRaw))) : 100;
    response.json(store.listSessions(limit));
  });

  app.get("/api/sessions/:sessionId", (request, response) => {
    const session = store.getSession(request.params.sessionId);
    if (!session) {
      response.status(404).json({ error: "session_not_found" });
      return;
    }
    response.json(session);
  });

  app.get("/api/sessions/:sessionId/messages", (request, response) => {
    const session = store.getSession(request.params.sessionId);
    if (!session) {
      response.status(404).json({ error: "session_not_found" });
      return;
    }
    const limitRaw = Number(request.query.limit);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(1000, Math.round(limitRaw))) : 200;
    response.json({
      session,
      messages: store.listSessionMessages(session.id, limit)
    });
  });

  app.get("/api/sessions/:sessionId/timeline", (request, response) => {
    const session = store.getSession(request.params.sessionId);
    if (!session) {
      response.status(404).json({ error: "session_not_found" });
      return;
    }
    response.json({
      session,
      timeline: buildSessionTimelineSnapshot(
        session.id,
        parseTimelineLimit(request.query.limit),
        parseTimelineActionId(request.query.actionId)
      )
    });
  });

  app.get("/api/sessions/:sessionId/timeline/stream", (request, response) => {
    const session = store.getSession(request.params.sessionId);
    if (!session) {
      response.status(404).json({ error: "session_not_found" });
      return;
    }

    const limit = parseTimelineLimit(request.query.limit);
    const actionId = parseTimelineActionId(request.query.actionId);
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
      const timeline = buildSessionTimelineSnapshot(session.id, limit, actionId);
      const signature = JSON.stringify(timeline.events.map((event) => event.id));
      if (signature === previousSignature) {
        return;
      }
      previousSignature = signature;
      writeSseEvent(response, {
        event: "snapshot",
        id: `snapshot:${timeline.generatedAt}`,
        data: {
          generatedAt: timeline.generatedAt,
          session,
          timeline
        }
      });
    };

    writeSseEvent(response, {
      event: "ready",
      id: `ready:${Date.now()}`,
      data: {
        ok: true,
        sessionId: session.id,
        actionId,
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
          sessionId: session.id,
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

  app.get("/api/sessions/:sessionId/workbench", (request, response) => {
    const workbench = buildSessionWorkbenchDetail(request.params.sessionId);
    if (!workbench?.session) {
      response.status(404).json({ error: "session_not_found" });
      return;
    }
    if (!workbench.snapshot) {
      response.status(404).json({ error: "session_workbench_not_found" });
      return;
    }

    response.json(workbench);
  });

  app.post("/api/sessions/:sessionId/actions", async (request, response) => {
    const session = store.getSession(request.params.sessionId);
    if (!session) {
      response.status(404).json({ error: "session_not_found" });
      return;
    }
    const parsed = orchestratorSessionActionSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({
        error: "invalid_session_action_payload",
        details: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message
        }))
      });
      return;
    }
    const body = parsed.data;
    const actionId = body.actionId ?? createSessionActionId(body.action, session.id);
    const source = body.source ?? "control-center";
    const attachments = normalizeAttachments(body.attachments);
    const existingActionAudit = findExistingSessionActionAudit(session.id, actionId);
    if (existingActionAudit) {
      const existingAction =
        typeof existingActionAudit.payload?.action === "string" ? existingActionAudit.payload.action : undefined;
      if (existingAction && existingAction !== body.action) {
        response.status(409).json({
          error: "session_action_id_conflict",
          actionId,
          existingAction,
          requestedAction: body.action
        });
        return;
      }
      response.status(202).json(
        buildExistingSessionActionResponse({
          sessionId: session.id,
          actionId,
          requestedAction: body.action,
          auditEvent: existingActionAudit
        })
      );
      return;
    }
    const instruction = formatSessionActionInstruction({
      action: body.action,
      sessionId: session.id,
      supplement: body.text
    });

    store.appendAuditEvent({
      category: "session-action",
      entityType: "session",
      entityId: session.id,
      message: `Session action requested: ${buildSessionActionLabel(body.action)}`,
      payload: {
        eventType: "session_action_requested",
        sessionId: session.id,
        action: body.action,
        actionId,
        clientActionId: actionId,
        source,
        requestedBy: body.requestedBy ?? "",
        textPreview: truncateTimelineText(body.text, 240),
        generatedInstructionPreview: truncateTimelineText(instruction, 240)
      }
    });

    try {
      const result = await handleInboundMessage({
        sessionId: session.id,
        text: instruction,
        taskText: instruction,
        source,
        requestedBy: body.requestedBy,
        chatId: body.chatId,
        clientActionId: actionId,
        attachments
      });
      store.appendAuditEvent({
        category: "session-action",
        entityType: "session",
        entityId: session.id,
        message: `Session action completed: ${buildSessionActionLabel(body.action)}`,
        payload: {
          eventType: "session_action_completed",
          sessionId: session.id,
          action: body.action,
          actionId,
          clientActionId: actionId,
          source,
          resultType: result.type ?? "unknown",
          taskId: typeof result.taskId === "string" ? result.taskId : undefined,
          goalRunId: typeof result.goalRunId === "string" ? result.goalRunId : undefined,
          approvalId: typeof result.approvalId === "string" ? result.approvalId : undefined,
          operatorActionId: typeof result.actionId === "string" ? result.actionId : undefined,
          generatedInstructionPreview: truncateTimelineText(instruction, 240)
        }
      });

      const responseState = safeBuildSessionActionResponseState(session.id, actionId);
      response.status(202).json({
        actionId,
        action: body.action,
        result,
        ...responseState
      });
    } catch (error) {
      store.appendAuditEvent({
        category: "session-action",
        entityType: "session",
        entityId: session.id,
        message: `Session action failed: ${buildSessionActionLabel(body.action)}`,
        payload: {
          eventType: "session_action_failed",
          sessionId: session.id,
          action: body.action,
          actionId,
          clientActionId: actionId,
          source,
          error: error instanceof Error ? error.message : String(error)
        }
      });
      response.status(500).json({
        error: "session_action_failed",
        actionId,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  });

  app.get("/api/project-board", (_request, response) => {
    response.json(buildProjectBoardSnapshot(buildProjectBoardInput()));
  });

  app.get("/api/project-board/attention", (request, response) => {
    const level = request.query.level === "critical" || request.query.level === "watch" ? request.query.level : undefined;
    const snapshot = buildProjectBoardSnapshot(buildProjectBoardInput());
    response.json({
      generatedAt: snapshot.generatedAt,
      summary: snapshot.summary,
      attentionQueue: listProjectBoardAttentionItems(snapshot, { level })
    });
  });

  app.get("/api/operating-system", (_request, response) => {
    const snapshot = buildProjectBoardSnapshot(buildProjectBoardInput());
    const recurring = buildRecurringStatusSnapshot(store);
    const projects = listProjectBoardProjects(snapshot, { includeArchived: true });
    const attentionQueue = listProjectBoardAttentionItems(snapshot);
    const criticalAttention = attentionQueue.filter((item) => item.level === "critical").length;
    const watchAttention = attentionQueue.filter((item) => item.level === "watch").length;
    const dueCadences = Number(recurring.summary.dueCadences ?? 0);
    const health = criticalAttention > 0 || dueCadences > 0 ? "attention_required" : watchAttention > 0 ? "watch" : "healthy";
    const nextActions = [
      ...attentionQueue.map((item) => item.nextAction),
      ...snapshot.nextActions,
      recurring.nextAction
    ].filter((item, index, items) => item && items.indexOf(item) === index);

    response.json({
      generatedAt: snapshot.generatedAt,
      mode: "solo_founder_os",
      health,
      summary: {
        ...snapshot.summary,
        totalProjects: projects.length,
        criticalAttention,
        watchAttention,
        recurringHealth: recurring.health,
        recurringNextAction: recurring.nextAction,
        recurringInFlightRuns: Number(recurring.summary.inFlightRuns ?? 0)
      },
      focusProjects: projects
        .slice()
        .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
        .slice(0, 6),
      primary: snapshot.primary,
      founderMemory: store.getWorkspaceMemory().founderProfile,
      memoryFacts: store.getWorkspaceMemory().memoryFacts ?? [],
      projects: snapshot.projects,
      archivedProjects: snapshot.archivedProjects,
      workstreams: snapshot.workstreams,
      blockers: snapshot.blockers,
      pendingDecisions: snapshot.pendingDecisions,
      teamReadiness: snapshot.teamReadiness,
      attentionQueue: attentionQueue.slice(0, 12),
      nextActions: nextActions.slice(0, 12),
      latestArtifacts: snapshot.latestArtifacts.slice(0, 12),
      verifiedArtifacts: snapshot.latestArtifacts.slice(0, 12).map((artifact) => verifyArtifactPath(artifact)),
      recurring: {
        health: recurring.health,
        nextAction: recurring.nextAction,
        summary: recurring.summary
      },
      crm: {
        summary: recurring.crm.summary,
        overdueCadences: recurring.crm.overdueCadences.slice(0, 8),
        activeLeads: recurring.crm.activeLeads.slice(0, 8)
      }
    });
  });

  app.post("/api/workspace-memory/facts", (request, response) => {
    const body = typeof request.body === "object" && request.body !== null ? (request.body as Record<string, unknown>) : {};
    const kind = typeof body.kind === "string" ? body.kind : "";
    const value = typeof body.value === "string" ? body.value.trim() : "";
    const source = typeof body.source === "string" ? body.source : "manual";
    const confidence = Number(body.confidence ?? 1);
    const validKinds = new Set([
      "business_domain",
      "target_user",
      "deliverable_preference",
      "decision_style",
      "feedback",
      "project_context",
      "tech_stack"
    ]);
    const validSources = new Set(["task", "session", "feishu", "control-center", "system", "manual"]);
    if (!kind || !validKinds.has(kind) || !value) {
      response.status(400).json({ error: "invalid_memory_fact", message: "kind and value are required" });
      return;
    }
    const memory = store.recordWorkspaceMemoryFact({
      kind: kind as WorkspaceMemoryFactRecord["kind"],
      value,
      source: validSources.has(source) ? (source as WorkspaceMemoryFactRecord["source"]) : "manual",
      confidence: Number.isFinite(confidence) ? confidence : 1,
      taskId: typeof body.taskId === "string" ? body.taskId : undefined,
      sessionId: typeof body.sessionId === "string" ? body.sessionId : undefined,
      note: typeof body.note === "string" ? body.note : undefined
    });
    response.json({ memoryFacts: memory.memoryFacts ?? [] });
  });

  app.delete("/api/workspace-memory/facts/:factId", (request, response) => {
    const factId = typeof request.params.factId === "string" ? request.params.factId.trim() : "";
    if (!factId) {
      response.status(400).json({ error: "invalid_memory_fact_id" });
      return;
    }
    const memory = store.deleteWorkspaceMemoryFact(factId);
    response.json({ memoryFacts: memory.memoryFacts ?? [] });
  });

  app.post("/api/workspace-memory/facts/reset", (_request, response) => {
    const memory = store.resetWorkspaceMemoryFacts();
    response.json({ memoryFacts: memory.memoryFacts ?? [] });
  });

  app.get("/api/projects", (_request, response) => {
    const snapshot = buildProjectBoardSnapshot(buildProjectBoardInput());
    response.json({
      generatedAt: snapshot.generatedAt,
      summary: snapshot.summary,
      projects: listProjectBoardProjects(snapshot, { includeArchived: true })
    });
  });

  app.get("/api/projects/:projectId", (request, response) => {
    const snapshot = buildProjectBoardSnapshot(buildProjectBoardInput());
    const project = findProjectBoardProject(snapshot, request.params.projectId);
    if (!project) {
      response.status(404).json({ error: "project_not_found" });
      return;
    }
    response.json({
      generatedAt: snapshot.generatedAt,
      project
    });
  });

  app.get("/api/projects/:projectId/history", (request, response) => {
    const snapshot = buildProjectBoardSnapshot(buildProjectBoardInput());
    const project = findProjectBoardProject(snapshot, request.params.projectId);
    if (!project) {
      response.status(404).json({ error: "project_not_found" });
      return;
    }
    response.json({
      projectId: project.id,
      name: project.name,
      history: project.history
    });
  });

  app.get("/api/tasks/:taskId", (request, response) => {
    const task = store.getTask(request.params.taskId);
    if (!task) {
      response.status(404).json({ error: "task_not_found" });
      return;
    }
    response.json({
      task: enrichTaskRecord(store, task),
      session: task.sessionId ? store.getSession(task.sessionId) : undefined,
      workflowSummary: buildWorkflowStatusSummary(task, {
        includeGoal: true,
        includeArtifacts: true
      })
    });
  });

  app.post("/api/tasks/:taskId/cancel", (request, response) => {
    const task = store.getTask(request.params.taskId);
    if (!task) {
      response.status(404).json({ error: "task_not_found" });
      return;
    }
    if (task.status === "completed" || task.status === "failed" || task.status === "cancelled") {
      response.status(409).json({
        error: "task_not_cancellable",
        status: task.status
      });
      return;
    }

    const body =
      typeof request.body === "object" && request.body !== null
        ? (request.body as Record<string, unknown>)
        : {};
    const reason =
      typeof body.reason === "string" && body.reason.trim().length > 0 ? body.reason.trim() : undefined;
    const cancelled = store.cancelTask(task.id, reason);
    if (!cancelled) {
      response.status(500).json({ error: "task_cancel_failed" });
      return;
    }

    if (cancelled.sessionId) {
      store.appendSessionMessage({
        sessionId: cancelled.sessionId,
        actorType: "system",
        actorId: "orchestrator",
        messageType: "event",
        content: `已取消任务：${cancelled.title}`,
        metadata: {
          type: "task_cancelled",
          taskId: cancelled.id,
          reason: reason ?? ""
        }
      });
    }

    response.json(enrichTaskRecord(store, cancelled));
  });

  app.post("/api/tasks/cancel-stale", (request, response) => {
    const body =
      typeof request.body === "object" && request.body !== null
        ? (request.body as Record<string, unknown>)
        : {};
    const olderThanMinutesRaw = Number(body.olderThanMinutes ?? 60);
    const olderThanMinutes = Number.isFinite(olderThanMinutesRaw) ? Math.max(0, Math.round(olderThanMinutesRaw)) : 60;
    const includeRunning = body.includeRunning === true;
    const limitRaw = Number(body.limit ?? 500);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(5000, Math.round(limitRaw))) : 500;
    const reasonPrefix =
      typeof body.reasonPrefix === "string" && body.reasonPrefix.trim().length > 0
        ? body.reasonPrefix.trim()
        : "stale task cleanup";
    const requestedByFilter =
      typeof body.requestedBy === "string" && body.requestedBy.trim().length > 0 ? body.requestedBy.trim() : undefined;
    const sourceFilter =
      typeof body.source === "string" && body.source.trim().length > 0 ? body.source.trim() : undefined;
    const roleIdFilter =
      typeof body.roleId === "string" && body.roleId.trim().length > 0 ? body.roleId.trim() : undefined;
    const dryRun = body.dryRun === true;

    const staleStatuses = new Set(["queued", "waiting_approval", ...(includeRunning ? ["running"] : [])]);
    const thresholdMs = Date.now() - olderThanMinutes * 60 * 1000;
    const tasks = store.listTasks(5000);
    const candidates = tasks
      .filter((task) => {
        if (!staleStatuses.has(task.status)) {
          return false;
        }
        if (requestedByFilter && task.requestedBy !== requestedByFilter) {
          return false;
        }
        if (sourceFilter && task.source !== sourceFilter) {
          return false;
        }
        if (roleIdFilter && task.roleId !== roleIdFilter) {
          return false;
        }
        const updatedMs = Date.parse(task.updatedAt);
        if (!Number.isFinite(updatedMs)) {
          return false;
        }
        return updatedMs <= thresholdMs;
      })
      .slice(0, limit);

    if (dryRun) {
      response.json({
        dryRun: true,
        scanned: tasks.length,
        candidates: candidates.length,
        candidateTaskIds: candidates.map((task) => task.id),
        cancelledCount: 0,
        cancelledTaskIds: [],
        errors: []
      });
      return;
    }

    const cancelled: string[] = [];
    const errors: Array<{ taskId: string; error: string }> = [];

    for (const task of candidates) {
      const cancelledTask = store.cancelTask(task.id, `${reasonPrefix}: ${olderThanMinutes}m`);
      if (!cancelledTask) {
        errors.push({
          taskId: task.id,
          error: "task_cancel_failed"
        });
        continue;
      }
      if (cancelledTask.sessionId) {
        store.appendSessionMessage({
          sessionId: cancelledTask.sessionId,
          actorType: "system",
          actorId: "orchestrator",
          messageType: "event",
          content: `已取消超时任务：${cancelledTask.title}`,
          metadata: {
            type: "task_cancelled_stale",
            taskId: cancelledTask.id,
            reason: `${reasonPrefix}: ${olderThanMinutes}m`
          }
        });
      }
      cancelled.push(cancelledTask.id);
    }

    response.json({
      dryRun: false,
      scanned: tasks.length,
      candidates: candidates.length,
      cancelledCount: cancelled.length,
      cancelledTaskIds: cancelled,
      errors
    });
  });

  app.get("/api/tasks/:taskId/children", (request, response) => {
    const task = store.getTask(request.params.taskId);
    if (!task) {
      response.status(404).json({ error: "task_not_found" });
      return;
    }

    response.json({
      task: enrichTaskRecord(store, task),
      session: task.sessionId ? store.getSession(task.sessionId) : undefined,
      relations: store.listTaskRelationsByParent(task.id),
      children: store.listTaskChildren(task.id).map((child) => enrichTaskRecord(store, child)),
      workflowSummary: buildWorkflowStatusSummary(task, {
        includeGoal: true,
        includeArtifacts: true
      })
    });
  });

  app.get("/api/tasks/:taskId/collaboration", (request, response) => {
    const task = store.getTask(request.params.taskId);
    if (!task) {
      response.status(404).json({ error: "task_not_found" });
      return;
    }

    const collaborations = store.listAgentCollaborationsByParentTask(task.id);
    const collaboration = collaborations[0];
    if (!collaboration) {
      response.status(404).json({ error: "collaboration_not_found" });
      return;
    }

    const children = store.listTaskChildren(task.id).filter((child) => {
      const metadata = child.metadata as { collaborationId?: string };
      return metadata.collaborationId === collaboration.id;
    });
    response.json({
      task: enrichTaskRecord(store, task),
      session: task.sessionId ? store.getSession(task.sessionId) : undefined,
      collaboration,
      children: children.map((child) => enrichTaskRecord(store, child)),
      messages: store.listAgentMessages(collaboration.id),
      timeline: store.listCollaborationTimelineEvents(collaboration.id),
      workflowSummary: buildWorkflowStatusSummary(task, {
        includeGoal: true,
        includeArtifacts: true
      })
    });
  });

  app.get("/api/collaborations/:collaborationId", (request, response) => {
    const collaboration = store.getAgentCollaboration(request.params.collaborationId);
    if (!collaboration) {
      response.status(404).json({ error: "collaboration_not_found" });
      return;
    }
    const parentTask = store.getTask(collaboration.parentTaskId);
    const children = store.listTaskChildren(collaboration.parentTaskId).filter((child) => {
      const metadata = child.metadata as { collaborationId?: string };
      return metadata.collaborationId === collaboration.id;
    });
    response.json({
      collaboration,
      parentTask: parentTask ? enrichTaskRecord(store, parentTask) : undefined,
      children: children.map((child) => enrichTaskRecord(store, child))
    });
  });

  app.get("/api/collaborations/:collaborationId/messages", (request, response) => {
    const collaboration = store.getAgentCollaboration(request.params.collaborationId);
    if (!collaboration) {
      response.status(404).json({ error: "collaboration_not_found" });
      return;
    }
    response.json({
      collaboration,
      messages: store.listAgentMessages(collaboration.id)
    });
  });

  app.get("/api/collaborations/:collaborationId/timeline", (request, response) => {
    const collaboration = store.getAgentCollaboration(request.params.collaborationId);
    if (!collaboration) {
      response.status(404).json({ error: "collaboration_not_found" });
      return;
    }
    response.json({
      collaboration,
      timeline: store.listCollaborationTimelineEvents(collaboration.id)
    });
  });

  app.get("/api/agent-instances", (request, response) => {
    const roleId = typeof request.query.roleId === "string" ? request.query.roleId : "";
    const status = typeof request.query.status === "string" ? request.query.status : "";
    const instances = store.listAgentInstances({
      ...(roleId ? { roleId: roleId as RoleId } : {}),
      ...(status === "active" || status === "inactive" ? { status } : {})
    });
    response.json(instances);
  });

  app.get("/api/agent-instances/:instanceId", (request, response) => {
    const instance = store.getAgentInstance(request.params.instanceId);
    if (!instance) {
      response.status(404).json({ error: "agent_instance_not_found" });
      return;
    }
    response.json(instance);
  });

  app.post("/api/tasks/:taskId/split", (request, response) => {
    const task = store.getTask(request.params.taskId);
    if (!task) {
      response.status(404).json({ error: "task_not_found" });
      return;
    }

    const parsed = orchestratorTaskSplitSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      response.status(400).json({
        error: "invalid_split_payload",
        details: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message
        }))
      });
      return;
    }

    const body = parsed.data;
    const manualSpecs = Array.isArray(body.tasks)
      ? body.tasks.map((entry) => ({
          roleId: entry.roleId,
          title: entry.title,
          instruction: entry.instruction,
          priority: entry.priority
        }))
      : [];
    const specs =
      (body.strategy ?? (manualSpecs.length > 0 ? "manual" : "auto")) === "manual"
        ? manualSpecs
        : buildAutoSplitSpecs(task, body.maxTasks ?? 6);
    if (specs.length === 0) {
      response.status(400).json({ error: "empty_split_specs" });
      return;
    }

    const children = splitTaskIntoChildren({
      parentTask: task,
      requestedBy: body.requestedBy,
      specs
    });
    if (task.sessionId) {
      store.appendSessionMessage({
        sessionId: task.sessionId,
        actorType: "system",
        actorId: "orchestrator",
        messageType: "event",
        content: `已拆解任务 ${task.title}，创建 ${children.length} 个子任务`,
        metadata: {
          type: "task_split",
          parentTaskId: task.id,
          childTaskIds: children.map((entry) => entry.id)
        }
      });
    }

    response.status(201).json({
      parentTaskId: task.id,
      count: children.length,
      tasks: children.map((entry) => enrichTaskRecord(store, entry))
    });
  });

  app.post("/api/tasks", (request, response) => {
    const parsed = orchestratorCreateTaskSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({
        error: "invalid_task_payload",
        details: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message
        }))
      });
      return;
    }
    const body = parsed.data;
    const source = body.source ?? "control-center";
    const sessionId =
      body.sessionId ??
      ensureInboundSession({
        source,
        requestedBy: body.requestedBy,
        chatId: body.chatId,
        titleHint: body.title ?? body.instruction
      });

    const attachments = normalizeAttachments(body.attachments);
    const metadata: TaskMetadata = {
      ...(body.metadata ?? {}),
      ...(attachments.length > 0 ? { attachments } : {})
    };

    const task = store.createTask({
      sessionId,
      source,
      roleId: body.roleId ?? selectRoleFromText(body.instruction),
      title: body.title ?? shorten(body.instruction),
      instruction: body.instruction,
      priority: body.priority,
      requestedBy: body.requestedBy,
      chatId: body.chatId,
      metadata
    });
    if (task.sessionId) {
      store.appendSessionMessage({
        sessionId: task.sessionId,
        actorType: "system",
        actorId: "orchestrator",
        messageType: "event",
        content: `创建任务：${task.title}`,
        metadata: {
          type: "task_created",
          taskId: task.id,
          roleId: task.roleId
        }
      });
    }
    response.status(201).json(enrichTaskRecord(store, task));
  });

  app.post("/api/messages", async (request, response) => {
    const parsed = orchestratorInboundMessageSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({
        error: "invalid_message_payload",
        details: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message
        }))
      });
      return;
    }
    const body = parsed.data;

    const attachments = normalizeAttachments(body.attachments);
    response.status(202).json(
      await handleInboundMessage({
        text: body.text,
        sessionId: body.sessionId,
        source: body.source ?? "control-center",
        requestedBy: body.requestedBy,
        chatId: body.chatId,
        clientActionId: body.clientActionId,
        attachments
      })
    );
  });
}

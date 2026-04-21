import express from "express";
import {
  orchestratorCreateTaskSchema,
  orchestratorInboundMessageSchema,
  orchestratorTaskSplitSchema
} from "@vinko/protocol";
import {
  buildProjectBoardSnapshot,
  buildWorkflowStatusSummary,
  findProjectBoardProject,
  listProjectBoardAttentionItems,
  listProjectBoardProjects
} from "@vinko/shared";
import type { RoleId, TaskAttachment, TaskMetadata, TaskRecord, VinkoStore } from "@vinko/shared";
import { enrichTaskRecord } from "./response-utils.js";

type InboundResult = {
  message: string;
};

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
    text: string;
    taskText?: string | undefined;
    source: "control-center" | "feishu" | "email" | "system";
    requestedBy?: string | undefined;
    chatId?: string | undefined;
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
        source: body.source ?? "control-center",
        requestedBy: body.requestedBy,
        chatId: body.chatId,
        attachments
      })
    );
  });
}

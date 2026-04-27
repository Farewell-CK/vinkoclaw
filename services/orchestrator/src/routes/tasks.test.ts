import express from "express";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionRecord, SkillBindingRecord, TaskRecord, VinkoStore } from "@vinko/shared";
import type { TaskRoutesDeps } from "./tasks.js";
import { registerTaskRoutes } from "./tasks.js";

function buildTask(patch: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task_1",
    sessionId: "session_1",
    source: "feishu",
    roleId: "ceo",
    title: "测试任务",
    instruction: "do work",
    status: "queued",
    priority: 80,
    requestedBy: "ou_owner",
    chatId: "chat_1",
    metadata: {},
    createdAt: "2026-04-07T00:00:00.000Z",
    updatedAt: "2026-04-07T00:00:00.000Z",
    ...patch
  };
}

function buildSession(patch: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "session_1",
    source: "feishu",
    sourceKey: "chat_1",
    title: "项目会话",
    status: "active",
    metadata: {},
    createdAt: "2026-04-07T00:00:00.000Z",
    updatedAt: "2026-04-07T00:10:00.000Z",
    lastMessageAt: "2026-04-07T00:10:00.000Z",
    ...patch
  };
}

function buildSkillBinding(patch: Partial<SkillBindingRecord> = {}): SkillBindingRecord {
  return {
    id: "binding_1",
    scope: "role",
    scopeId: "product",
    skillId: "prd-writer",
    status: "enabled",
    verificationStatus: "verified",
    config: {},
    createdAt: "2026-04-07T00:00:00.000Z",
    updatedAt: "2026-04-07T00:00:00.000Z",
    ...patch
  };
}

function createTaskRoutesApp(
  store: VinkoStore,
  overrides?: Partial<TaskRoutesDeps>
): express.Express {
  const app = express();
  app.use(express.json());
  registerTaskRoutes(app, {
    store,
    ensureInboundSession: () => undefined,
    selectRoleFromText: () => "ceo",
    shorten: (value: string) => value,
    normalizeAttachments: () => [],
    handleInboundMessage: () => Promise.resolve({ type: "task_queued" as const, message: "ok", taskId: "t_mock" }),
    buildAutoSplitSpecs: () => [],
    splitTaskIntoChildren: () => [],
    ...overrides
  });
  return app;
}

async function withServer(app: express.Express, fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("listening", () => resolve());
      server.once("error", reject);
    });
    const address = server.address() as AddressInfo | null;
    if (!address) {
      throw new Error("server_address_unavailable");
    }
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function readChunks(stream: ReadableStream<Uint8Array>, count: number): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  try {
    for (let index = 0; index < count; index += 1) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      output += decoder.decode(result.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  return output;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("task routes", () => {
  it("returns 404 for cancelling unknown task", async () => {
    const store = {
      getTask: vi.fn(() => undefined),
      listToolRunsByTask: vi.fn(() => []),
      listTaskChildren: vi.fn(() => [])
    } as unknown as VinkoStore;
    const app = createTaskRoutesApp(store);

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/tasks/task_missing/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({})
      });

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: "task_not_found" });
    });
  });

  it("cancels pending task and appends session event", async () => {
    const task = buildTask();
    const cancelledTask = buildTask({
      status: "cancelled",
      updatedAt: "2026-04-07T00:10:00.000Z"
    });

    const appendSessionMessage = vi.fn();
    const store = {
      getTask: vi.fn(() => task),
      cancelTask: vi.fn(() => cancelledTask),
      appendSessionMessage,
      listToolRunsByTask: vi.fn(() => []),
      listTaskChildren: vi.fn(() => [])
    } as unknown as VinkoStore;
    const app = createTaskRoutesApp(store);

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/tasks/${task.id}/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "用户手动取消" })
      });

      expect(response.status).toBe(200);
      const payload = (await response.json()) as { task: Record<string, unknown>; session?: Record<string, unknown> } | Record<string, unknown>;
      const taskPayload: Record<string, unknown> =
        typeof payload === "object" && payload !== null && "task" in payload
          ? ((payload as { task: Record<string, unknown> }).task)
          : (payload as Record<string, unknown>);
      expect(taskPayload.status).toBe("cancelled");
      expect(taskPayload.failureCategory).toBe("cancelled");
    });

    expect(appendSessionMessage).toHaveBeenCalledTimes(1);
    const input = appendSessionMessage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input.sessionId).toBe("session_1");
    expect(input.content).toBe("已取消任务：测试任务");
  });

  it("cancels paused_input task and returns cleared pending input", async () => {
    const task = buildTask({
      status: "paused_input"
    });
    const cancelledTask = buildTask({
      status: "cancelled",
      updatedAt: "2026-04-07T00:10:00.000Z",
      errorText: "cleanup paused founder task"
    });

    const store = {
      getTask: vi.fn(() => task),
      cancelTask: vi.fn(() => cancelledTask),
      appendSessionMessage: vi.fn(),
      listToolRunsByTask: vi.fn(() => []),
      listTaskChildren: vi.fn(() => [])
    } as unknown as VinkoStore;
    const app = createTaskRoutesApp(store);

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/tasks/${task.id}/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "cleanup paused founder task" })
      });

      expect(response.status).toBe(200);
      const payload = (await response.json()) as Record<string, unknown>;
      expect(payload.status).toBe("cancelled");
      expect(payload.failureCategory).toBe("cancelled");
    });

    expect((store.cancelTask as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      task.id,
      "cleanup paused founder task"
    );
  });

  it("rejects cancelling finished task", async () => {
    const task = buildTask({ status: "completed" });
    const store = {
      getTask: vi.fn(() => task),
      listToolRunsByTask: vi.fn(() => []),
      listTaskChildren: vi.fn(() => [])
    } as unknown as VinkoStore;
    const app = createTaskRoutesApp(store);

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/tasks/${task.id}/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({})
      });

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        error: "task_not_cancellable",
        status: "completed"
      });
    });
  });

  it("dry-runs stale task cleanup", async () => {
    const now = Date.now();
    const staleTask = buildTask({
      id: "task_stale",
      status: "queued",
      updatedAt: new Date(now - 2 * 60 * 60 * 1000).toISOString()
    });
    const freshTask = buildTask({
      id: "task_fresh",
      status: "queued",
      updatedAt: new Date(now - 5 * 60 * 1000).toISOString()
    });
    const store = {
      listTasks: vi.fn(() => [staleTask, freshTask]),
      listToolRunsByTask: vi.fn(() => []),
      listTaskChildren: vi.fn(() => [])
    } as unknown as VinkoStore;
    const app = createTaskRoutesApp(store);

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/tasks/cancel-stale`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ olderThanMinutes: 60, dryRun: true })
      });
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        dryRun: boolean;
        candidates: number;
        candidateTaskIds: string[];
        cancelledCount: number;
      };
      expect(payload.dryRun).toBe(true);
      expect(payload.candidates).toBe(1);
      expect(payload.candidateTaskIds).toEqual(["task_stale"]);
      expect(payload.cancelledCount).toBe(0);
    });
  });

  it("cancels stale tasks in batch", async () => {
    const now = Date.now();
    const staleRunningTask = buildTask({
      id: "task_running_stale",
      status: "running",
      sessionId: "session_2",
      title: "stale running",
      updatedAt: new Date(now - 3 * 60 * 60 * 1000).toISOString()
    });
    const appendSessionMessage = vi.fn();
    const cancelTask = vi.fn((taskId: string) =>
      taskId === staleRunningTask.id ? { ...staleRunningTask, status: "cancelled" } : undefined
    );
    const store = {
      listTasks: vi.fn(() => [staleRunningTask]),
      cancelTask,
      appendSessionMessage,
      listToolRunsByTask: vi.fn(() => []),
      listTaskChildren: vi.fn(() => [])
    } as unknown as VinkoStore;
    const app = createTaskRoutesApp(store);

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/tasks/cancel-stale`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ olderThanMinutes: 60, includeRunning: true, dryRun: false })
      });
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        dryRun: boolean;
        cancelledCount: number;
        cancelledTaskIds: string[];
        errors: unknown[];
      };
      expect(payload.dryRun).toBe(false);
      expect(payload.cancelledCount).toBe(1);
      expect(payload.cancelledTaskIds).toEqual(["task_running_stale"]);
      expect(payload.errors).toEqual([]);
    });

    expect(cancelTask).toHaveBeenCalledTimes(1);
    expect(appendSessionMessage).toHaveBeenCalledTimes(1);
  });

  it("passes inbound messages through and returns collaboration resume ack", async () => {
    const handleInboundMessage = vi.fn(async () => ({
      type: "operator_action_applied" as const,
      message: "收到，我已把这次补充信息续接到原协作任务（abcd1234），现在继续汇总并推进交付。",
      actionId: "task_resume_1"
    }));
    const store = {
      listToolRunsByTask: vi.fn(() => []),
      listTaskChildren: vi.fn(() => [])
    } as unknown as VinkoStore;
    const app = createTaskRoutesApp(store, { handleInboundMessage });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source: "control-center",
          requestedBy: "owner",
          text: "目标用户是独立开发者"
        })
      });

      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toEqual({
        type: "operator_action_applied",
        message: "收到，我已把这次补充信息续接到原协作任务（abcd1234），现在继续汇总并推进交付。",
        actionId: "task_resume_1"
      });
    });

    expect(handleInboundMessage).toHaveBeenCalledTimes(1);
    expect(handleInboundMessage).toHaveBeenCalledWith({
      text: "目标用户是独立开发者",
      sessionId: undefined,
      source: "control-center",
      requestedBy: "owner",
      chatId: undefined,
      clientActionId: undefined,
      attachments: []
    });
  });

  it("manages auditable workspace memory facts", async () => {
    let memoryFacts: Array<Record<string, unknown>> = [];
    const store = {
      recordWorkspaceMemoryFact: vi.fn((fact: Record<string, unknown>) => {
        memoryFacts = [
          {
            id: "memory_fact_ai_toy",
            createdAt: "2026-04-27T00:00:00.000Z",
            updatedAt: "2026-04-27T00:00:00.000Z",
            ...fact
          }
        ];
        return { memoryFacts };
      }),
      deleteWorkspaceMemoryFact: vi.fn((id: string) => {
        memoryFacts = memoryFacts.filter((fact) => fact.id !== id);
        return { memoryFacts };
      }),
      resetWorkspaceMemoryFacts: vi.fn(() => {
        memoryFacts = [];
        return { memoryFacts };
      })
    } as unknown as VinkoStore;
    const app = createTaskRoutesApp(store);

    await withServer(app, async (baseUrl) => {
      const createResponse = await fetch(`${baseUrl}/api/workspace-memory/facts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "business_domain",
          value: "AI 玩具",
          source: "manual",
          confidence: 0.9
        })
      });
      expect(createResponse.status).toBe(200);
      const created = (await createResponse.json()) as { memoryFacts: Array<Record<string, unknown>> };
      expect(created.memoryFacts[0]?.value).toBe("AI 玩具");

      const deleteResponse = await fetch(`${baseUrl}/api/workspace-memory/facts/memory_fact_ai_toy`, {
        method: "DELETE"
      });
      expect(deleteResponse.status).toBe(200);
      await expect(deleteResponse.json()).resolves.toEqual({ memoryFacts: [] });

      const resetResponse = await fetch(`${baseUrl}/api/workspace-memory/facts/reset`, {
        method: "POST"
      });
      expect(resetResponse.status).toBe(200);
      await expect(resetResponse.json()).resolves.toEqual({ memoryFacts: [] });
    });
  });

  it("runs structured session actions against the selected session and records audit evidence", async () => {
    const session = buildSession({
      id: "session_action_target",
      source: "control-center",
      sourceKey: "operator:owner",
      title: "通用智能体工作台",
      metadata: {
        projectMemory: {
          currentGoal: "交付通用智能体工作台",
          currentStage: "execution",
          latestUserRequest: "继续推进",
          latestSummary: "正在补结构化会话动作",
          nextActions: ["补接口"],
          updatedAt: "2026-04-23T02:00:00.000Z",
          updatedBy: "owner"
        }
      }
    });
    const auditEvents: Array<{
      id: string;
      category: string;
      entityType: string;
      entityId: string;
      message: string;
      payload: Record<string, unknown>;
      createdAt: string;
    }> = [];
    const appendAuditEvent = vi.fn((input) => {
      const event = {
        id: `audit_${auditEvents.length + 1}`,
        category: input.category,
        entityType: input.entityType,
        entityId: input.entityId,
        message: input.message,
        payload: input.payload ?? {},
        createdAt: `2026-04-23T02:0${auditEvents.length + 1}:00.000Z`
      };
      auditEvents.unshift(event);
      return event;
    });
    const handleInboundMessage = vi.fn<TaskRoutesDeps["handleInboundMessage"]>(async () => ({
      type: "task_queued",
      message: "已续接当前会话并排队",
      taskId: "task_session_action"
    }));
    const actionTask = buildTask({
      id: "task_session_action",
      sessionId: session.id,
      title: "继续推进当前会话",
      status: "queued",
      updatedAt: "2026-04-23T02:03:00.000Z"
    });
    const unrelatedTask = buildTask({
      id: "task_unrelated",
      sessionId: session.id,
      title: "其他任务",
      status: "queued",
      updatedAt: "2026-04-23T02:04:00.000Z"
    });
    const store = {
      getSession: vi.fn((id: string) => (id === session.id ? session : undefined)),
      listSessions: vi.fn(() => [session]),
      listTasks: vi.fn(() => [actionTask, unrelatedTask]),
      listApprovals: vi.fn(() => []),
      listGoalRuns: vi.fn(() => []),
      listSessionMessages: vi.fn(() => []),
      appendAuditEvent,
      listAuditEvents: vi.fn(() => auditEvents),
      resolveSkillsForRole: vi.fn(() => []),
      getWorkspaceMemory: vi.fn(() => undefined),
      listCrmLeads: vi.fn(() => []),
      listCrmCadences: vi.fn(() => []),
      listCrmContacts: vi.fn(() => []),
      listGoalRunHandoffArtifacts: vi.fn(() => []),
      listGoalRunTraces: vi.fn(() => []),
      listToolRunsByTask: vi.fn(() => []),
      listTaskChildren: vi.fn(() => [])
    } as unknown as VinkoStore;
    const app = createTaskRoutesApp(store, { handleInboundMessage });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/sessions/${session.id}/actions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "continue",
          actionId: "session_action_continue_fixed",
          source: "control-center",
          requestedBy: "owner"
        })
      });
      expect(response.status).toBe(202);
      const payload = (await response.json()) as {
        actionId: string;
        action: string;
        result: Record<string, unknown>;
        workbench: {
          session: Record<string, unknown>;
          timeline: { events: Array<Record<string, unknown>> };
        };
        timeline: { actionId?: string; events: Array<Record<string, unknown>> };
      };

      expect(payload.actionId).toBe("session_action_continue_fixed");
      expect(payload.action).toBe("continue");
      expect(payload.result).toEqual(
        expect.objectContaining({
          type: "task_queued",
          taskId: "task_session_action"
        })
      );
      expect(payload.workbench.session.id).toBe(session.id);
      expect(payload.timeline.events.map((event) => event.entityId)).toEqual(
        expect.arrayContaining(["task_session_action"])
      );
      expect(payload.timeline.events.map((event) => event.entityId)).not.toContain("task_unrelated");
      expect(payload.timeline.events.map((event) => event.eventType)).toEqual(
        expect.arrayContaining(["session_action_requested", "session_action_completed"])
      );

      const timelineResponse = await fetch(
        `${baseUrl}/api/sessions/${session.id}/timeline?actionId=session_action_continue_fixed&limit=20`
      );
      expect(timelineResponse.status).toBe(200);
      const timelinePayload = (await timelineResponse.json()) as {
        timeline: { actionId?: string; events: Array<Record<string, unknown>> };
      };
      expect(timelinePayload.timeline.actionId).toBe("session_action_continue_fixed");
      expect(timelinePayload.timeline.events.map((event) => event.entityId)).toEqual(
        expect.arrayContaining(["task_session_action"])
      );
      expect(timelinePayload.timeline.events.map((event) => event.entityId)).not.toContain("task_unrelated");
    });

    expect(handleInboundMessage).toHaveBeenCalledWith({
      sessionId: session.id,
      text: expect.stringContaining("请继续推进当前会话：交付通用智能体工作台"),
      taskText: expect.stringContaining("请继续推进当前会话：交付通用智能体工作台"),
      source: "control-center",
      requestedBy: "owner",
      chatId: undefined,
      clientActionId: "session_action_continue_fixed",
      attachments: []
    });
    const handledInput = handleInboundMessage.mock.calls[0]?.[0];
    expect(handledInput).toBeDefined();
    expect(handledInput?.text).toContain("优先处理这些下一步：补接口");
    expect(handledInput?.text).toContain("最近时间线");
    expect(appendAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "session-action",
        entityType: "session",
        entityId: session.id,
        payload: expect.objectContaining({
          eventType: "session_action_requested",
          actionId: "session_action_continue_fixed"
        })
      })
    );
    expect(appendAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "session-action",
        entityType: "session",
        entityId: session.id,
        payload: expect.objectContaining({
          eventType: "session_action_completed",
          resultType: "task_queued",
          taskId: "task_session_action"
        })
      })
    );
  });

  it("deduplicates structured session actions by action id", async () => {
    const session = buildSession({
      id: "session_action_dedupe",
      source: "control-center",
      sourceKey: "operator:owner",
      title: "幂等会话",
      metadata: {
        projectMemory: {
          currentGoal: "继续交付",
          currentStage: "execution",
          latestSummary: "已有完成动作",
          updatedAt: "2026-04-23T02:00:00.000Z",
          updatedBy: "owner"
        }
      }
    });
    const auditEvents = [
      {
        id: "audit_existing_completed",
        category: "session-action",
        entityType: "session",
        entityId: session.id,
        message: "Session action completed: continue",
        payload: {
          eventType: "session_action_completed",
          sessionId: session.id,
          action: "continue",
          actionId: "session_action_dedupe_fixed",
          clientActionId: "session_action_dedupe_fixed",
          resultType: "task_queued",
          taskId: "task_existing"
        },
        createdAt: "2026-04-23T02:02:00.000Z"
      }
    ];
    const handleInboundMessage = vi.fn<TaskRoutesDeps["handleInboundMessage"]>(async () => ({
      type: "task_queued",
      message: "不应调用",
      taskId: "task_duplicate"
    }));
    const store = {
      getSession: vi.fn((id: string) => (id === session.id ? session : undefined)),
      listSessions: vi.fn(() => [session]),
      listTasks: vi.fn(() => [
        buildTask({
          id: "task_existing",
          sessionId: session.id,
          status: "queued",
          updatedAt: "2026-04-23T02:03:00.000Z"
        })
      ]),
      listApprovals: vi.fn(() => []),
      listGoalRuns: vi.fn(() => []),
      listSessionMessages: vi.fn(() => []),
      appendAuditEvent: vi.fn(),
      listAuditEvents: vi.fn(() => auditEvents),
      resolveSkillsForRole: vi.fn(() => []),
      getWorkspaceMemory: vi.fn(() => undefined),
      listCrmLeads: vi.fn(() => []),
      listCrmCadences: vi.fn(() => []),
      listCrmContacts: vi.fn(() => []),
      listGoalRunHandoffArtifacts: vi.fn(() => []),
      listGoalRunTraces: vi.fn(() => []),
      listToolRunsByTask: vi.fn(() => []),
      listTaskChildren: vi.fn(() => [])
    } as unknown as VinkoStore;
    const app = createTaskRoutesApp(store, { handleInboundMessage });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/sessions/${session.id}/actions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "continue",
          actionId: "session_action_dedupe_fixed",
          source: "control-center",
          requestedBy: "owner"
        })
      });
      expect(response.status).toBe(202);
      const payload = (await response.json()) as {
        duplicate?: boolean;
        duplicateStatus?: string;
        existing?: { taskId?: string };
        timeline?: { actionId?: string; events: Array<Record<string, unknown>> };
      };
      expect(payload.duplicate).toBe(true);
      expect(payload.duplicateStatus).toBe("completed");
      expect(payload.existing?.taskId).toBe("task_existing");
      expect(payload.timeline?.actionId).toBe("session_action_dedupe_fixed");
    });

    expect(handleInboundMessage).not.toHaveBeenCalled();
    expect(store.appendAuditEvent).not.toHaveBeenCalled();
  });

  it("rejects session action id conflicts across action kinds", async () => {
    const session = buildSession({
      id: "session_action_conflict",
      source: "control-center",
      sourceKey: "operator:owner",
      title: "冲突会话"
    });
    const auditEvents = [
      {
        id: "audit_existing_requested",
        category: "session-action",
        entityType: "session",
        entityId: session.id,
        message: "Session action requested: continue",
        payload: {
          eventType: "session_action_requested",
          sessionId: session.id,
          action: "continue",
          actionId: "session_action_conflict_fixed"
        },
        createdAt: "2026-04-23T02:01:00.000Z"
      }
    ];
    const handleInboundMessage = vi.fn<TaskRoutesDeps["handleInboundMessage"]>(async () => ({
      type: "task_queued",
      message: "不应调用",
      taskId: "task_conflict"
    }));
    const store = {
      getSession: vi.fn((id: string) => (id === session.id ? session : undefined)),
      listTasks: vi.fn(() => []),
      listApprovals: vi.fn(() => []),
      listGoalRuns: vi.fn(() => []),
      listSessionMessages: vi.fn(() => []),
      appendAuditEvent: vi.fn(),
      listAuditEvents: vi.fn(() => auditEvents),
      listToolRunsByTask: vi.fn(() => []),
      listTaskChildren: vi.fn(() => [])
    } as unknown as VinkoStore;
    const app = createTaskRoutesApp(store, { handleInboundMessage });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/sessions/${session.id}/actions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "supplement",
          actionId: "session_action_conflict_fixed",
          source: "control-center",
          requestedBy: "owner",
          text: "补充信息"
        })
      });
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        error: "session_action_id_conflict",
        actionId: "session_action_conflict_fixed",
        existingAction: "continue",
        requestedAction: "supplement"
      });
    });

    expect(handleInboundMessage).not.toHaveBeenCalled();
    expect(store.appendAuditEvent).not.toHaveBeenCalled();
  });

  it("builds a CEO project board snapshot", async () => {
    const session = buildSession({
      metadata: {
        projectMemory: {
          currentGoal: "完成 OPC 团队首页和 PRD 工作流",
          currentStage: "delivery",
          latestUserRequest: "继续推进 0.2.0",
          latestSummary: "skill marketplace 已接入验证闭环",
          unresolvedQuestions: ["是否要补项目面板"],
          nextActions: ["完成 CEO 面板", "做端到端 founder 流程压测"],
          latestArtifacts: ["docs/01-product/opc-ai-team-roadmap-v0.2.0.md"],
          updatedAt: "2026-04-13T09:00:00.000Z",
          updatedBy: "system"
        }
      }
    });
    const blockedTask = buildTask({
      id: "task_blocked",
      title: "补 CEO 面板",
      status: "failed",
      errorText: "missing project board"
    });
    const awaitUserTask = buildTask({
      id: "task_waiting",
      title: "确认首页主 CTA",
      metadata: {
        collaborationStatus: "await_user",
        collaborationPendingQuestions: ["请确认 CTA 文案"]
      }
    });
    const store = {
      listSessions: vi.fn(() => [session]),
      listTasks: vi.fn(() => [blockedTask, awaitUserTask]),
      resolveSkillsForRole: vi.fn((roleId: string) => {
        if (roleId === "product") {
          return [
            buildSkillBinding({
              scopeId: "product",
              skillId: "prd-writer",
              verificationStatus: "verified"
            }),
            buildSkillBinding({
              id: "binding_2",
              scopeId: "product",
              skillId: "research-brief",
              verificationStatus: "unverified"
            })
          ];
        }
        if (roleId === "qa") {
          return [
            buildSkillBinding({
              id: "binding_3",
              scopeId: "qa",
              skillId: "regression-checker",
              verificationStatus: "failed"
            })
          ];
        }
        return [];
      }),
      getWorkspaceMemory: vi.fn(() => ({
        userPreferences: {
          preferredLanguage: "zh",
          preferredTechStack: [],
          communicationStyle: "concise"
        },
        keyDecisions: [],
        projectContext: {
          currentGoals: ["完成 OPC 团队首页和 PRD 工作流"],
          activeProjects: [
            {
              id: "project:opc-团队首页和-prd-工作流",
              name: "OPC 团队首页和 PRD 工作流",
              stage: "delivery",
              status: "active",
              lastUpdate: "2026-04-19T03:10:00.000Z"
            }
          ]
        },
        updatedAt: "2026-04-19T03:10:00.000Z"
      })),
      listToolRunsByTask: vi.fn(() => []),
      listTaskChildren: vi.fn(() => [])
    } as unknown as VinkoStore;
    const app = createTaskRoutesApp(store);

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/project-board`);
      expect(response.status).toBe(200);
      const payload = (await response.json()) as Record<string, unknown>;
      const summary = payload.summary as Record<string, unknown>;
      expect(summary.activeProjects).toBe(1);
      expect(summary.archivedProjects).toBe(0);
      expect(summary.blockedTasks).toBe(1);
      expect(summary.awaitingInputTasks).toBe(1);
      const projects = payload.projects as Array<Record<string, unknown>>;
      expect(projects[0]?.name).toBe("OPC 团队首页和 PRD 工作流");
      expect(projects[0]?.history).toBeInstanceOf(Array);
      const primary = payload.primary as Record<string, unknown>;
      expect(primary.currentGoal).toBe("完成 OPC 团队首页和 PRD 工作流");
      expect(primary.currentStage).toBe("delivery");
      expect(payload.blockers).toEqual(
        expect.arrayContaining(["是否要补项目面板", "补 CEO 面板: missing project board", "确认首页主 CTA"])
      );
      const teamReadiness = payload.teamReadiness as Array<Record<string, unknown>>;
      expect(teamReadiness[0]?.roleId).toBe("qa");
      const product = teamReadiness.find((entry) => entry.roleId === "product");
      expect(product?.verifiedSkills).toBe(1);
      expect(product?.unverifiedSkills).toBe(1);
    });
  });

  it("builds project board from orchestration state when project memory is absent", async () => {
    const session = buildSession({
      metadata: {}
    });
    const orchestrationTask = buildTask({
      id: "task_orchestration_primary",
      sessionId: session.id,
      title: "Founder delivery main task",
      status: "running",
      metadata: {
        orchestrationMode: "main_agent",
        orchestrationState: {
          version: 1,
          mode: "main_agent",
          ownerRoleId: "product",
          spec: {
            goal: "交付登录 MVP",
            successCriteria: ["产出 PRD", "产出可运行页面"],
            constraints: ["一周内上线"],
            scope: ["首页", "登录流程"]
          },
          progress: {
            stage: "implementation",
            status: "active",
            completed: ["prd"],
            inFlight: ["implementation"],
            blocked: [],
            awaitingInput: ["确认登录方式"],
            nextActions: ["完成前端页面", "补充 QA 测试"]
          },
          decision: {
            summary: "先交付邮箱验证码登录",
            entries: ["暂不接入第三方登录"]
          },
          artifactIndex: {
            items: [{ path: "docs/prd-login-mvp.md", title: "PRD", stage: "prd", status: "produced" }]
          },
          updatedAt: "2026-04-16T09:00:00.000Z",
          updatedBy: "product"
        }
      }
    });
    const store = {
      listSessions: vi.fn(() => [session]),
      listTasks: vi.fn(() => [orchestrationTask]),
      resolveSkillsForRole: vi.fn(() => []),
      listCrmLeads: vi.fn(() => []),
      listCrmCadences: vi.fn(() => []),
      listToolRunsByTask: vi.fn(() => []),
      listTaskChildren: vi.fn(() => [])
    } as unknown as VinkoStore;
    const app = createTaskRoutesApp(store);

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/project-board`);
      expect(response.status).toBe(200);
      const payload = (await response.json()) as Record<string, unknown>;
      const primary = payload.primary as Record<string, unknown>;
      expect(primary.currentGoal).toBe("交付登录 MVP");
      expect(primary.currentStage).toBe("implementation");
      expect(primary.latestSummary).toBe("先交付邮箱验证码登录");
      expect(primary.nextActions).toEqual(expect.arrayContaining(["完成前端页面", "补充 QA 测试"]));
      expect(primary.latestArtifacts).toEqual(expect.arrayContaining(["docs/prd-login-mvp.md"]));
      expect(primary.lastTaskId).toBe("task_orchestration_primary");
      expect(primary.orchestrationMode).toBe("main_agent");
      expect(primary.orchestrationOwnerRoleId).toBe("product");
      expect(payload.blockers).toEqual(expect.arrayContaining(["确认登录方式"]));
      const summary = payload.summary as Record<string, unknown>;
      expect(summary.activeLeads).toBe(0);
      expect(summary.overdueCadences).toBe(0);
    });
  });

  it("returns task detail with session context", async () => {
    const task = buildTask({
      metadata: {
        runtimeBackendUsed: "zhipu",
        runtimeModelUsed: "glm-5-turbo",
        runtimeToolLoopEnabled: true,
        runtimeToolRegistry: "default",
        runtimeRulesEngine: "default",
        runtimeSkillBindings: [
          {
            skillId: "prd-writer",
            verificationStatus: "verified",
            source: "catalog",
            sourceLabel: "catalog",
            version: "1.0.0",
            runtimeAvailable: true
          }
        ],
        toolChangedFiles: ["docs/report.md"]
      },
      result: {
        summary: "done",
        deliverable: "产物文件：docs/report.md",
        citations: [],
        followUps: ["继续验证"]
      }
    });
    const session = buildSession({
      metadata: {
        projectMemory: {
          currentGoal: "交付 founder 报告",
          currentStage: "artifact_delivered",
          latestUserRequest: "继续推进",
          latestSummary: "报告已生成",
          unresolvedQuestions: [],
          nextActions: ["继续验证"],
          latestArtifacts: ["docs/report.md"],
          updatedAt: "2026-04-07T00:09:00.000Z",
          updatedBy: "system"
        }
      }
    });
    const store = {
      getTask: vi.fn((id: string) => (id === task.id ? task : undefined)),
      getSession: vi.fn((id: string) => (id === session.id ? session : undefined)),
      listToolRunsByTask: vi.fn(() => []),
      listTaskChildren: vi.fn(() => []),
      listSessionMessages: vi.fn(() => [{ id: "msg_1" }, { id: "msg_2" }])
    } as unknown as VinkoStore;
    const app = createTaskRoutesApp(store);

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/tasks/${task.id}`);
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        task: Record<string, unknown>;
        session: Record<string, unknown>;
      };
      expect(payload.session.id).toBe("session_1");
      const evidence = payload.task.completionEvidence as Record<string, unknown>;
      const runtime = evidence.runtime as Record<string, unknown>;
      const context = evidence.context as Record<string, unknown>;
      const skills = evidence.skills as Record<string, unknown>;
      const harness = evidence.harness as Record<string, unknown>;
      expect(runtime.backendUsed).toBe("zhipu");
      expect(runtime.modelUsed).toBe("glm-5-turbo");
      expect(runtime.toolLoopEnabled).toBe(true);
      expect(context.projectMemoryPresent).toBe(true);
      expect(context.currentGoal).toBe("交付 founder 报告");
      expect(context.sessionMessageCount).toBe(2);
      expect(skills.roleId).toBe("ceo");
      expect(skills.total).toBe(1);
      expect(skills.bindings).toEqual([expect.objectContaining({ skillId: "prd-writer", verificationStatus: "verified" })]);
      expect(harness.grade).toBeTruthy();
      expect(typeof harness.score).toBe("number");
    });
  });

  it("returns session workbench detail", async () => {
    const session = buildSession({
      metadata: {
        projectMemory: {
          currentGoal: "交付通用智能体工作台",
          currentStage: "execution",
          latestUserRequest: "继续推进 session workbench",
          latestSummary: "已接入 milestone stream",
          unresolvedQuestions: ["是否需要单独的实时日志存储"],
          nextActions: ["补 session workbench 详情接口", "接通控制台点击跳转"],
          latestArtifacts: ["docs/workbench.md"],
          updatedAt: "2026-04-23T02:00:00.000Z",
          updatedBy: "system"
        }
      }
    });
    const activeTask = buildTask({
      id: "task_workbench",
      sessionId: session.id,
      title: "补齐 session workbench 闭环",
      instruction: "实现 session workbench detail route",
      status: "running",
      updatedAt: "2026-04-23T02:05:00.000Z"
    });
    const failedTask = buildTask({
      id: "task_failed",
      sessionId: session.id,
      title: "尝试旧版补丁",
      status: "failed",
      errorText: "legacy patch approach rejected",
      updatedAt: "2026-04-23T01:59:00.000Z"
    });
    const approval = {
      id: "approval_session",
      kind: "task_execution",
      taskId: activeTask.id,
      summary: "Approve pushing workbench card",
      payload: {
        sessionId: session.id
      },
      status: "pending",
      createdAt: "2026-04-23T02:03:00.000Z",
      updatedAt: "2026-04-23T02:03:00.000Z"
    };
    const goalRun = {
      id: "goalrun_session",
      sessionId: session.id,
      source: "control-center",
      objective: "打造通用超级智能体",
      status: "running",
      currentStage: "execute",
      language: "zh-CN",
      metadata: {},
      context: {},
      retryCount: 0,
      maxRetries: 2,
      awaitingInputFields: [],
      createdAt: "2026-04-23T01:55:00.000Z",
      updatedAt: "2026-04-23T02:04:00.000Z"
    };
    const sessionMessages = [
      {
        id: "msg_1",
        sessionId: session.id,
        actorType: "user",
        actorId: "owner",
        messageType: "text",
        content: "继续推进",
        metadata: {},
        createdAt: "2026-04-23T02:01:00.000Z"
      },
      {
        id: "msg_2",
        sessionId: session.id,
        actorType: "system",
        actorId: "orchestrator",
        messageType: "event",
        content: "开始补 workbench 详情",
        metadata: {},
        createdAt: "2026-04-23T02:02:00.000Z"
      }
    ];
    const auditEvents = [
      {
        id: "audit_session_workbench",
        category: "feishu",
        entityType: "session",
        entityId: session.id,
        message: "Sent session workbench card",
        payload: {
          eventType: "session_workbench_pushed",
          sessionId: session.id
        },
        createdAt: "2026-04-23T02:06:00.000Z"
      },
      {
        id: "audit_other",
        category: "task",
        entityType: "task",
        entityId: "task_other",
        message: "Other task event",
        payload: {},
        createdAt: "2026-04-23T02:07:00.000Z"
      }
    ];
    const store = {
      getSession: vi.fn((id: string) => (id === session.id ? session : undefined)),
      listSessions: vi.fn(() => [session]),
      listTasks: vi.fn(() => [activeTask, failedTask]),
      listApprovals: vi.fn(() => [approval]),
      listGoalRuns: vi.fn(() => [goalRun]),
      listSessionMessages: vi.fn(() => sessionMessages),
      getTask: vi.fn((id: string) => [activeTask, failedTask].find((task) => task.id === id)),
      resolveSkillsForRole: vi.fn(() => []),
      getWorkspaceMemory: vi.fn(() => undefined),
      listCrmLeads: vi.fn(() => []),
      listCrmCadences: vi.fn(() => []),
      listCrmContacts: vi.fn(() => []),
      listGoalRunHandoffArtifacts: vi.fn(() => []),
      listGoalRunTraces: vi.fn(() => []),
      listAuditEvents: vi.fn(() => auditEvents),
      listToolRunsByTask: vi.fn(() => []),
      listTaskChildren: vi.fn(() => [])
    } as unknown as VinkoStore;
    const app = createTaskRoutesApp(store);

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/sessions/${session.id}/workbench`);
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        session: Record<string, unknown>;
        snapshot: Record<string, unknown>;
        tasks: Array<Record<string, unknown>>;
        goalRuns: Array<Record<string, unknown>>;
        approvals: Array<Record<string, unknown>>;
        messages: Array<Record<string, unknown>>;
        timeline: { total: number; events: Array<Record<string, unknown>> };
      };

      expect(payload.session.id).toBe(session.id);
      expect(payload.snapshot.sessionId).toBe(session.id);
      expect(payload.snapshot.currentGoal).toBe("交付通用智能体工作台");
      expect(payload.snapshot.currentStage).toBe("execution");
      expect(payload.snapshot.blockers).toEqual(
        expect.arrayContaining(["尝试旧版补丁: legacy patch approach rejected", "待审批：Approve pushing workbench card"])
      );
      expect(payload.snapshot.pendingApproval).toEqual(
        expect.objectContaining({ id: "approval_session", status: "pending" })
      );
      expect(payload.snapshot.activeTask).toEqual(
        expect.objectContaining({ id: "task_workbench", status: "running", roleId: "ceo" })
      );
      expect(payload.snapshot.activeGoalRun).toEqual(
        expect.objectContaining({ id: "goalrun_session", status: "running" })
      );
      expect(payload.tasks[0]?.id).toBe("task_workbench");
      expect(payload.goalRuns[0]?.id).toBe("goalrun_session");
      expect(payload.approvals[0]?.id).toBe("approval_session");
      expect(payload.messages).toHaveLength(2);
      expect(payload.timeline.total).toBe(7);
      expect(payload.timeline.events[0]).toEqual(
        expect.objectContaining({ kind: "audit", entityId: session.id, eventType: "session_workbench_pushed" })
      );
      expect(payload.timeline.events.map((event) => event.kind)).toEqual(
        expect.arrayContaining(["message", "task", "goal_run", "approval", "audit"])
      );

      const timelineResponse = await fetch(`${baseUrl}/api/sessions/${session.id}/timeline?limit=3`);
      expect(timelineResponse.status).toBe(200);
      const timelinePayload = (await timelineResponse.json()) as {
        session: Record<string, unknown>;
        timeline: { total: number; events: Array<Record<string, unknown>> };
      };
      expect(timelinePayload.session.id).toBe(session.id);
      expect(timelinePayload.timeline.total).toBe(7);
      expect(timelinePayload.timeline.events).toHaveLength(3);

      const streamResponse = await fetch(`${baseUrl}/api/sessions/${session.id}/timeline/stream?limit=3&pollMs=1000`);
      expect(streamResponse.status).toBe(200);
      expect(streamResponse.headers.get("content-type")).toContain("text/event-stream");
      expect(streamResponse.body).toBeTruthy();
      const streamOutput = await readChunks(streamResponse.body!, 2);
      await streamResponse.body?.cancel();
      expect(streamOutput).toContain("event: ready");
      expect(streamOutput).toContain("event: snapshot");
      expect(streamOutput).toContain("session_workbench_pushed");
    });
  });

});

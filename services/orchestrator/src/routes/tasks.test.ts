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
      source: "control-center",
      requestedBy: "owner",
      chatId: undefined,
      attachments: []
    });
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

});

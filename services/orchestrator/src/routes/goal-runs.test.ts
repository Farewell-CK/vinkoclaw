import express from "express";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GoalRunRecord, VinkoStore } from "@vinko/shared";
import { registerGoalRunRoutes } from "./goal-runs.js";

function buildGoalRun(patch: Partial<GoalRunRecord> = {}): GoalRunRecord {
  return {
    id: "goal_1",
    source: "feishu",
    objective: "build site",
    status: "queued",
    currentStage: "discover",
    requestedBy: "ou_owner",
    chatId: "chat_1",
    language: "zh-CN",
    metadata: {},
    context: {},
    retryCount: 0,
    maxRetries: 2,
    awaitingInputFields: [],
    createdAt: "2026-04-07T00:00:00.000Z",
    updatedAt: "2026-04-07T00:00:00.000Z",
    ...patch
  };
}

function createGoalRunRoutesApp(store: VinkoStore): express.Express {
  const app = express();
  app.use(express.json());
  registerGoalRunRoutes(app, { store });
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

describe("goal-run routes", () => {
  it("returns workflow summary on list and detail payloads", async () => {
    const goalRun = buildGoalRun({
      id: "goal_list_1",
      status: "running",
      currentStage: "execute",
      metadata: {
        workflowLabel: "Founder Delivery / QA",
        workflowSuccessCriteria: ["完成关键路径验证"],
        workflowCompletionSignal: "QA 结论可供发布决策"
      },
      context: {
        last_artifact_files: ["reports/qa-summary.md"]
      }
    });
    const store = {
      listGoalRuns: vi.fn(() => [goalRun]),
      getGoalRun: vi.fn((id: string) => (id === goalRun.id ? goalRun : undefined)),
      listGoalRunInputs: vi.fn(() => []),
      listRunAuthTokens: vi.fn(() => []),
      listGoalRunTraces: vi.fn(() => []),
      getLatestGoalRunHandoff: vi.fn(() => undefined)
    } as unknown as VinkoStore;
    const app = createGoalRunRoutesApp(store);

    await withServer(app, async (baseUrl) => {
      const listResponse = await fetch(`${baseUrl}/api/goal-runs?limit=10`);
      expect(listResponse.status).toBe(200);
      const listPayload = (await listResponse.json()) as Array<Record<string, unknown>>;
      expect(listPayload).toHaveLength(1);
      expect(listPayload[0]?.workflowSummary).toEqual(expect.stringContaining("**工作流**：Founder Delivery / QA"));

      const detailResponse = await fetch(`${baseUrl}/api/goal-runs/${goalRun.id}`);
      expect(detailResponse.status).toBe(200);
      const detailPayload = (await detailResponse.json()) as {
        goalRun: Record<string, unknown>;
      };
      expect(detailPayload.goalRun.workflowSummary).toEqual(expect.stringContaining("**最近产物**：reports/qa-summary.md"));
      const workflowState = detailPayload.goalRun.workflowState as Record<string, unknown>;
      expect(workflowState.stage).toBe("执行交付");
      expect(workflowState.status).toBe("running");
    });
  });

  it("dry-runs stale goal-run cleanup", async () => {
    const now = Date.now();
    const stale = buildGoalRun({
      id: "goal_stale",
      status: "running",
      updatedAt: new Date(now - 5 * 60 * 60 * 1000).toISOString()
    });
    const fresh = buildGoalRun({
      id: "goal_fresh",
      status: "running",
      updatedAt: new Date(now - 5 * 60 * 1000).toISOString()
    });
    const store = {
      listGoalRuns: vi.fn(() => [stale, fresh])
    } as unknown as VinkoStore;
    const app = createGoalRunRoutesApp(store);

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/goal-runs/cancel-stale`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ olderThanMinutes: 120, dryRun: true })
      });
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        dryRun: boolean;
        candidates: number;
        candidateGoalRunIds: string[];
      };
      expect(payload.dryRun).toBe(true);
      expect(payload.candidates).toBe(1);
      expect(payload.candidateGoalRunIds).toEqual(["goal_stale"]);
    });
  });

  it("cancels stale goal-runs in batch mode", async () => {
    const now = Date.now();
    const stale = buildGoalRun({
      id: "goal_cancel_1",
      status: "awaiting_input",
      updatedAt: new Date(now - 4 * 60 * 60 * 1000).toISOString()
    });
    const cancelGoalRun = vi.fn((goalRunId: string) =>
      goalRunId === stale.id ? { ...stale, status: "cancelled" as const } : undefined
    );
    const appendGoalRunTimelineEvent = vi.fn();
    const store = {
      listGoalRuns: vi.fn(() => [stale]),
      cancelGoalRun,
      appendGoalRunTimelineEvent
    } as unknown as VinkoStore;
    const app = createGoalRunRoutesApp(store);

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/goal-runs/cancel-stale`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          olderThanMinutes: 60,
          statuses: ["awaiting_input"],
          dryRun: false
        })
      });
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        dryRun: boolean;
        cancelledCount: number;
        cancelledGoalRunIds: string[];
        errors: unknown[];
      };
      expect(payload.dryRun).toBe(false);
      expect(payload.cancelledCount).toBe(1);
      expect(payload.cancelledGoalRunIds).toEqual(["goal_cancel_1"]);
      expect(payload.errors).toEqual([]);
    });

    expect(cancelGoalRun).toHaveBeenCalledTimes(1);
    expect(appendGoalRunTimelineEvent).toHaveBeenCalledTimes(1);
  });

  it("returns goal-run traces and latest handoff", async () => {
    const goalRun = buildGoalRun({
      id: "goal_trace_1",
      status: "completed",
      currentStage: "accept",
      sessionId: "session_1",
      metadata: {
        workflowLabel: "Founder Delivery / Build",
        workflowSuccessCriteria: ["交付可验证页面", "沉淀执行证据"],
        workflowCompletionSignal: "可进入 QA 或验收"
      },
      context: {
        last_task_id: "task_1",
        last_task_status: "completed",
        last_artifact_files: ["apps/control-center/public/index.html"],
        last_completed_roles: ["frontend"],
        last_failed_roles: [],
        last_collaboration_enabled: false
      }
    });
    const store = {
      getGoalRun: vi.fn((id: string) => (id === goalRun.id ? goalRun : undefined)),
      getTask: vi.fn((id: string) =>
        id === "task_1"
          ? {
              id: "task_1",
              sessionId: "session_1",
              source: "feishu",
              roleId: "frontend",
              title: "execute task",
              instruction: "build site",
              status: "completed",
              priority: 90,
              metadata: {
                runtimeBackendUsed: "zhipu",
                runtimeModelUsed: "glm-5-turbo",
                runtimeToolLoopEnabled: true,
                runtimeToolRegistry: "default",
                runtimeRulesEngine: "default",
                runtimeSkillBindings: [
                  {
                    skillId: "code-executor",
                    verificationStatus: "verified",
                    source: "catalog",
                    sourceLabel: "catalog",
                    runtimeAvailable: true
                  }
                ]
              },
              createdAt: "2026-04-07T00:00:00.000Z",
              updatedAt: "2026-04-07T00:00:00.000Z"
            }
          : undefined
      ),
      getSession: vi.fn((id: string) =>
        id === "session_1"
          ? {
              id: "session_1",
              source: "feishu",
              sourceKey: "chat_1",
              title: "project session",
              status: "active",
              metadata: {
                projectMemory: {
                  currentGoal: "build site",
                  currentStage: "accept",
                  latestUserRequest: "继续推进",
                  latestSummary: "交付完成",
                  unresolvedQuestions: [],
                  nextActions: ["verify release"],
                  latestArtifacts: ["apps/control-center/public/index.html"],
                  updatedAt: "2026-04-07T00:00:00.000Z",
                  updatedBy: "system"
                }
              },
              createdAt: "2026-04-07T00:00:00.000Z",
              updatedAt: "2026-04-07T00:00:00.000Z",
              lastMessageAt: "2026-04-07T00:00:00.000Z"
            }
          : undefined
      ),
      listGoalRunInputs: vi.fn(() => []),
      listRunAuthTokens: vi.fn(() => []),
      listToolRunsByTask: vi.fn(() => [
        {
          id: "tool_1",
          taskId: "task_1",
          roleId: "frontend",
          providerId: "opencode",
          title: "tool",
          instruction: "run",
          command: "opencode",
          args: ["exec"],
          riskLevel: "low",
          status: "completed",
          approvalStatus: "not_required",
          createdAt: "2026-04-07T00:00:00.000Z",
          updatedAt: "2026-04-07T00:00:00.000Z"
        }
      ]),
      listGoalRunTraces: vi.fn(() => [
        {
          id: "trace_1",
          goalRunId: goalRun.id,
          stage: "execute",
          status: "completed",
          inputSummary: "objective",
          outputSummary: "done",
          artifactFiles: ["apps/control-center/public/index.html"],
          completedRoles: ["frontend"],
          failedRoles: [],
          approvalGateHits: 0,
          metadata: {},
          createdAt: "2026-04-07T00:00:00.000Z"
        }
      ]),
      getLatestGoalRunHandoff: vi.fn(() => ({
        id: "handoff_1",
        artifact: {
          stage: "execute",
          taskId: "task_1",
          taskTraceId: "task_1",
          summary: "execution completed",
          artifacts: ["apps/control-center/public/index.html"],
          decisions: ["completed:frontend"],
          unresolvedQuestions: [],
          nextActions: ["verify"],
          approvalNeeds: [],
          createdAt: "2026-04-07T00:00:00.000Z"
        }
      })),
      listGoalRunHandoffArtifacts: vi.fn(() => [])
    } as unknown as VinkoStore;

    const app = createGoalRunRoutesApp(store);

    await withServer(app, async (baseUrl) => {
      const traceResponse = await fetch(`${baseUrl}/api/goal-runs/${goalRun.id}/trace`);
      expect(traceResponse.status).toBe(200);
      const tracePayload = (await traceResponse.json()) as {
        goalRun: Record<string, unknown>;
        traces: Array<Record<string, unknown>>;
      };
      expect(tracePayload.traces).toHaveLength(1);
      expect(tracePayload.traces[0]?.stage).toBe("execute");
      const traceEvidence = tracePayload.goalRun.completionEvidence as Record<string, unknown>;
      expect(traceEvidence.handoffArtifactPresent).toBe(true);
      expect(traceEvidence.traceCount).toBe(1);
      const context = traceEvidence.context as Record<string, unknown>;
      const runtime = traceEvidence.runtime as Record<string, unknown>;
      const skills = traceEvidence.skills as Record<string, unknown>;
      const tools = traceEvidence.tools as Record<string, unknown>;
      const harness = traceEvidence.harness as Record<string, unknown>;
      expect(context.projectMemoryPresent).toBe(true);
      expect(context.currentGoal).toBe("build site");
      expect(runtime.backendUsed).toBe("zhipu");
      expect(runtime.modelUsed).toBe("glm-5-turbo");
      expect(skills.roleId).toBe("frontend");
      expect(skills.total).toBe(1);
      expect(skills.bindings).toEqual([expect.objectContaining({ skillId: "code-executor", verificationStatus: "verified" })]);
      expect(tools.totalCalls).toBe(1);
      expect(harness.grade).toBeTruthy();
      expect(typeof harness.score).toBe("number");

      const handoffResponse = await fetch(`${baseUrl}/api/goal-runs/${goalRun.id}/handoff`);
      expect(handoffResponse.status).toBe(200);
      const handoffPayload = (await handoffResponse.json()) as {
        goalRun: Record<string, unknown>;
        handoff: { id: string; artifact: Record<string, unknown> };
      };
      expect(handoffPayload.handoff.id).toBe("handoff_1");
      expect(handoffPayload.handoff.artifact.summary).toBe("execution completed");
      const handoffEvidence = handoffPayload.goalRun.completionEvidence as Record<string, unknown>;
      expect(handoffEvidence.handoffArtifactPresent).toBe(true);
      expect(typeof tracePayload.goalRun.workflowSummary).toBe("string");
      expect(tracePayload.goalRun.workflowSummary).toContain("**工作流**：Founder Delivery / Build");
      expect(tracePayload.goalRun.workflowSummary).toContain("**最近交接**：execution completed");
      const workflowState = tracePayload.goalRun.workflowState as Record<string, unknown>;
      expect(workflowState.workflowLabel).toBe("Founder Delivery / Build");
      expect(workflowState.recentArtifacts).toEqual(["apps/control-center/public/index.html"]);
    });
  });

  it("filters handoff artifacts by stage when latest is disabled", async () => {
    const goalRun = buildGoalRun({
      id: "goal_handoff_stage_1",
      status: "completed",
      currentStage: "accept"
    });
    const listGoalRunHandoffArtifacts = vi.fn((_goalRunId: string, _limit: number, stage?: string) =>
      stage === "deploy"
        ? [
            {
              id: "handoff_deploy_1",
              artifact: {
                stage: "deploy",
                summary: "deployment preflight passed",
                artifacts: [],
                decisions: [],
                unresolvedQuestions: [],
                nextActions: ["accept release"],
                approvalNeeds: [],
                createdAt: "2026-04-07T00:00:00.000Z"
              }
            }
          ]
        : []
    );
    const store = {
      getGoalRun: vi.fn((id: string) => (id === goalRun.id ? goalRun : undefined)),
      getLatestGoalRunHandoff: vi.fn((_goalRunId: string, stage?: string) =>
        stage === "deploy"
          ? {
              id: "handoff_deploy_1",
              artifact: {
                stage: "deploy",
                summary: "deployment preflight passed",
                artifacts: [],
                decisions: [],
                unresolvedQuestions: [],
                nextActions: ["accept release"],
                approvalNeeds: [],
                createdAt: "2026-04-07T00:00:00.000Z"
              }
            }
          : undefined
      ),
      listGoalRunHandoffArtifacts,
      listGoalRunTraces: vi.fn(() => [])
    } as unknown as VinkoStore;

    const app = createGoalRunRoutesApp(store);

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/goal-runs/${goalRun.id}/handoff?latest=false&stage=deploy`);
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        goalRun: Record<string, unknown>;
        handoffs: Array<{ id: string; artifact: Record<string, unknown> }>;
      };
      expect(payload.handoffs).toHaveLength(1);
      expect(payload.handoffs[0]?.id).toBe("handoff_deploy_1");
      expect(payload.handoffs[0]?.artifact.stage).toBe("deploy");
      const evidence = payload.goalRun.completionEvidence as Record<string, unknown>;
      expect(evidence.handoffArtifactPresent).toBe(true);
    });

    expect(listGoalRunHandoffArtifacts).toHaveBeenCalledWith(goalRun.id, 200, "deploy");
  });
});

import express from "express";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CrmCadenceRecord,
  CrmContactRecord,
  CrmLeadRecord,
  GoalRunRecord,
  SessionRecord,
  SkillBindingRecord,
  StageHandoffArtifact,
  TaskRecord,
  VinkoStore
} from "@vinko/shared";
import type { TaskRoutesDeps } from "./tasks.js";
import { registerTaskRoutes } from "./tasks.js";

function buildTask(patch: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task_1",
    sessionId: "session_1",
    source: "control-center",
    roleId: "product",
    title: "推进项目",
    instruction: "continue",
    status: "queued",
    priority: 80,
    metadata: {
      orchestrationState: {
        version: 1,
        mode: "main_agent",
        ownerRoleId: "product",
        spec: {
          goal: "增长项目",
          successCriteria: [],
          constraints: [],
          scope: []
        },
        progress: {
          stage: "implementation",
          status: "completed",
          completed: ["landing page delivered"],
          inFlight: [],
          blocked: [],
          awaitingInput: [],
          nextActions: ["准备发布复盘"]
        },
        decision: {
          summary: "确定首页先上 MVP",
          entries: ["AB 实验下一轮再做"]
        },
        artifactIndex: {
          items: [
            {
              path: "apps/site/index.html",
              title: "Landing Page",
              stage: "implementation",
              status: "verified"
            }
          ]
        },
        verificationStatus: "verified",
        updatedAt: "2026-04-20T00:00:00.000Z",
        updatedBy: "product"
      }
    },
    createdAt: "2026-04-20T00:00:00.000Z",
    updatedAt: "2026-04-20T00:00:00.000Z",
    ...patch
  };
}

function buildSession(patch: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "session_1",
    source: "control-center",
    sourceKey: "session_1",
    title: "增长项目会话",
    status: "active",
    metadata: {},
    createdAt: "2026-04-20T00:00:00.000Z",
    updatedAt: "2026-04-20T00:10:00.000Z",
    lastMessageAt: "2026-04-20T00:10:00.000Z",
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

function buildSkillBinding(patch: Partial<SkillBindingRecord> = {}): SkillBindingRecord {
  return {
    id: "binding_1",
    scope: "role",
    scopeId: "product",
    skillId: "prd-writer",
    status: "enabled",
    verificationStatus: "verified",
    config: {},
    createdAt: "2026-04-20T00:00:00.000Z",
    updatedAt: "2026-04-20T00:00:00.000Z",
    ...patch
  };
}

function buildLead(patch: Partial<CrmLeadRecord> = {}): CrmLeadRecord {
  return {
    id: "lead_1",
    name: "Annie Case",
    source: "manual",
    stage: "qualified",
    status: "active",
    tags: [],
    latestSummary: "等待安排产品演示",
    metadata: {},
    linkedProjectId: "project:增长项目",
    createdAt: "2026-04-20T00:30:00.000Z",
    updatedAt: "2026-04-20T00:50:00.000Z",
    ...patch
  };
}

function buildCadence(patch: Partial<CrmCadenceRecord> = {}): CrmCadenceRecord {
  return {
    id: "cadence_1",
    leadId: "lead_1",
    label: "weekly follow-up",
    channel: "email",
    intervalDays: 7,
    objective: "安排演示",
    nextRunAt: "2026-04-20T01:00:00.000Z",
    status: "active",
    metadata: {},
    createdAt: "2026-04-20T00:35:00.000Z",
    updatedAt: "2026-04-20T01:05:00.000Z",
    ...patch
  };
}

function buildContact(patch: Partial<CrmContactRecord> = {}): CrmContactRecord {
  return {
    id: "contact_1",
    leadId: "lead_1",
    channel: "email",
    outcome: "replied",
    summary: "对方回复愿意进一步沟通",
    nextAction: "安排演示",
    happenedAt: "2026-04-20T01:20:00.000Z",
    createdAt: "2026-04-20T01:20:00.000Z",
    ...patch
  };
}

function buildGoalRun(patch: Partial<GoalRunRecord> = {}): GoalRunRecord {
  return {
    id: "goal_1",
    source: "control-center",
    objective: "完成增长项目从实现到部署",
    status: "running",
    currentStage: "deploy",
    sessionId: "session_1",
    language: "zh-CN",
    metadata: {},
    context: {},
    retryCount: 0,
    maxRetries: 2,
    awaitingInputFields: [],
    result: {
      summary: "部署前检查已完成",
      deliverable: "等待最终部署",
      nextActions: ["执行部署"]
    },
    createdAt: "2026-04-20T00:40:00.000Z",
    updatedAt: "2026-04-20T01:15:00.000Z",
    ...patch
  };
}

function buildGoalRunHandoff(patch: Partial<{ id: string; goalRunId: string; artifact: StageHandoffArtifact }> = {}) {
  return {
    id: "handoff_1",
    goalRunId: "goal_1",
    artifact: {
      stage: "deploy",
      summary: "交接部署产物",
      artifacts: ["dist/site.zip"],
      decisions: [],
      unresolvedQuestions: [],
      nextActions: ["执行部署"],
      approvalNeeds: [],
      createdAt: "2026-04-20T01:16:00.000Z"
    },
    ...patch
  };
}

function buildGoalRunTrace(patch: Partial<Record<string, unknown>> = {}) {
  return {
    id: "trace_1",
    goalRunId: "goal_1",
    stage: "deploy",
    status: "completed",
    inputSummary: "准备部署",
    outputSummary: "部署脚本执行完成",
    artifactFiles: ["dist/site.zip"],
    completedRoles: ["operations"],
    failedRoles: [],
    approvalGateHits: 0,
    metadata: {},
    createdAt: "2026-04-20T01:17:00.000Z",
    ...patch
  };
}

describe("project routes", () => {
  it("returns a solo founder operating-system snapshot", async () => {
    const store = {
      listSessions: vi.fn(() => [
        buildSession({
          metadata: {
            projectMemory: {
              currentGoal: "增长项目",
              currentStage: "implementation",
              latestSummary: "首页开发中",
              latestArtifacts: ["apps/site/index.html"],
              updatedAt: "2026-04-20T01:00:00.000Z",
              updatedBy: "frontend"
            }
          }
        })
      ]),
      listTasks: vi.fn(() => [buildTask()]),
      resolveSkillsForRole: vi.fn(() => [buildSkillBinding()]),
      getWorkspaceMemory: vi.fn(() => ({
        userPreferences: {
          preferredLanguage: "zh",
          preferredTechStack: [],
          communicationStyle: "concise"
        },
        keyDecisions: [],
        projectContext: {
          currentGoals: ["增长项目"],
          activeProjects: [
            {
              id: "project:增长项目",
              name: "增长项目",
              stage: "implementation",
              status: "active",
              lastUpdate: "2026-04-20T01:10:00.000Z",
              latestSummary: "首页开发中"
            }
          ]
        },
        updatedAt: "2026-04-20T01:10:00.000Z"
      })),
      listCrmLeads: vi.fn(() => [buildLead()]),
      listCrmCadences: vi.fn(() => [buildCadence({ nextRunAt: "2026-04-19T01:00:00.000Z" })]),
      listCrmContacts: vi.fn(() => [buildContact()]),
      listGoalRuns: vi.fn(() => [buildGoalRun()]),
      listGoalRunHandoffArtifacts: vi.fn(() => [buildGoalRunHandoff()]),
      listGoalRunTraces: vi.fn(() => [buildGoalRunTrace()]),
      listToolRunsByTask: vi.fn(() => []),
      listTaskChildren: vi.fn(() => [])
    } as unknown as VinkoStore;
    const app = createTaskRoutesApp(store);

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/operating-system`);
      expect(response.status).toBe(200);
      const payload = (await response.json()) as Record<string, unknown>;
      expect(payload.mode).toBe("solo_founder_os");
      expect(payload.health).toBe("attention_required");
      expect((payload.summary as Record<string, unknown>).totalProjects).toBe(1);
      expect((payload.summary as Record<string, unknown>).recurringNextAction).toBe("run_due_cadences");
      expect(payload.focusProjects).toBeInstanceOf(Array);
      expect(payload.projects).toBeInstanceOf(Array);
      expect(payload.teamReadiness).toBeInstanceOf(Array);
      expect(payload.attentionQueue).toBeInstanceOf(Array);
      expect(payload.nextActions).toBeInstanceOf(Array);
      expect((payload.recurring as Record<string, unknown>).health).toBe("attention_required");
      expect(((payload.crm as Record<string, unknown>).summary as Record<string, unknown>).activeLeads).toBe(1);
    });
  });

  it("lists active and archived projects", async () => {
    const sessions = [
      buildSession({
        metadata: {
          projectMemory: {
            currentGoal: "增长项目",
            currentStage: "research",
            latestSummary: "完成市场调研",
            updatedAt: "2026-04-20T01:00:00.000Z",
            updatedBy: "research"
          }
        }
      }),
      buildSession({
        id: "session_2",
        title: "旧项目归档",
        status: "archived",
        metadata: {
          projectMemory: {
            currentGoal: "旧项目归档",
            currentStage: "done",
            latestSummary: "项目已结束",
            updatedAt: "2026-04-18T01:00:00.000Z",
            updatedBy: "operations"
          }
        }
      })
    ];
    const store = {
      listSessions: vi.fn(() => sessions),
      listTasks: vi.fn(() => [buildTask()]),
      resolveSkillsForRole: vi.fn(() => [buildSkillBinding()]),
      getWorkspaceMemory: vi.fn(() => ({
        userPreferences: {
          preferredLanguage: "zh",
          preferredTechStack: [],
          communicationStyle: "concise"
        },
        keyDecisions: [],
        projectContext: {
          currentGoals: ["增长项目"],
          activeProjects: [
            {
              id: "project:增长项目",
              name: "增长项目",
              stage: "research",
              status: "active",
              lastUpdate: "2026-04-20T01:20:00.000Z",
              latestSummary: "完成市场调研"
            },
            {
              id: "project:旧项目归档",
              name: "旧项目归档",
              stage: "done",
              status: "archived",
              lastUpdate: "2026-04-18T01:00:00.000Z",
              latestSummary: "项目已结束"
            }
          ]
        },
        updatedAt: "2026-04-20T01:20:00.000Z"
      })),
      listCrmLeads: vi.fn(() => [buildLead()]),
      listCrmCadences: vi.fn(() => [buildCadence()]),
      listCrmContacts: vi.fn(() => [buildContact()]),
      listGoalRuns: vi.fn(() => [buildGoalRun()]),
      listGoalRunHandoffArtifacts: vi.fn(() => [buildGoalRunHandoff()]),
      listGoalRunTraces: vi.fn(() => [buildGoalRunTrace()]),
      listToolRunsByTask: vi.fn(() => []),
      listTaskChildren: vi.fn(() => [])
    } as unknown as VinkoStore;
    const app = createTaskRoutesApp(store);

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/projects`);
      expect(response.status).toBe(200);
      const payload = (await response.json()) as { projects: Array<Record<string, unknown>>; summary: Record<string, unknown> };
      expect(payload.summary.activeProjects).toBe(1);
      expect(payload.summary.archivedProjects).toBe(1);
      expect(payload.projects).toHaveLength(2);
    });
  });

  it("returns project detail and history", async () => {
    const store = {
      listSessions: vi.fn(() => [
        buildSession({
          metadata: {
            projectMemory: {
              currentGoal: "增长项目",
              currentStage: "implementation",
              latestSummary: "首页开发中",
              latestArtifacts: ["apps/site/index.html"],
              updatedAt: "2026-04-20T01:00:00.000Z",
              updatedBy: "frontend"
            }
          }
        })
      ]),
      listTasks: vi.fn(() => [buildTask()]),
      resolveSkillsForRole: vi.fn(() => []),
      getWorkspaceMemory: vi.fn(() => ({
        userPreferences: {
          preferredLanguage: "zh",
          preferredTechStack: [],
          communicationStyle: "concise"
        },
        keyDecisions: [],
        projectContext: {
          currentGoals: ["增长项目"],
          activeProjects: [
            {
              id: "project:增长项目",
              name: "增长项目",
              stage: "implementation",
              status: "active",
              lastUpdate: "2026-04-20T01:10:00.000Z",
              latestSummary: "首页开发中"
            }
          ]
        },
        updatedAt: "2026-04-20T01:10:00.000Z"
      })),
      listCrmLeads: vi.fn(() => [buildLead()]),
      listCrmCadences: vi.fn(() => [buildCadence()]),
      listGoalRuns: vi.fn(() => [buildGoalRun()]),
      listGoalRunHandoffArtifacts: vi.fn(() => [buildGoalRunHandoff()]),
      listGoalRunTraces: vi.fn(() => [buildGoalRunTrace()]),
      listToolRunsByTask: vi.fn(() => []),
      listTaskChildren: vi.fn(() => [])
    } as unknown as VinkoStore;
    const app = createTaskRoutesApp(store);

    await withServer(app, async (baseUrl) => {
      const listResponse = await fetch(`${baseUrl}/api/projects`);
      expect(listResponse.status).toBe(200);
      const listPayload = (await listResponse.json()) as { projects: Array<Record<string, unknown>> };
      const projectId = String(listPayload.projects[0]?.id || "");
      expect(projectId).toBeTruthy();
      const encodedProjectId = encodeURIComponent(projectId);
      const detailResponse = await fetch(`${baseUrl}/api/projects/${encodedProjectId}`);
      expect(detailResponse.status).toBe(200);
      const detailPayload = (await detailResponse.json()) as { project: Record<string, unknown> };
      expect(detailPayload.project.name).toBe("增长项目");
      const historyResponse = await fetch(`${baseUrl}/api/projects/${encodedProjectId}/history`);
      expect(historyResponse.status).toBe(200);
      const historyPayload = (await historyResponse.json()) as { history: Array<Record<string, unknown>> };
      expect(historyPayload.history.length).toBeGreaterThan(0);
      expect(historyPayload.history.map((entry) => entry.kind)).toEqual(
        expect.arrayContaining([
          "workspace",
          "session",
          "crm_lead",
          "crm_cadence",
          "goal_run",
          "goal_run_handoff",
          "goal_run_trace"
        ])
      );
      expect(historyPayload.history.map((entry) => entry.stage)).toContain("cadence:active");
      expect(historyPayload.history.map((entry) => entry.stage)).toContain("goal_run:deploy:running");
      expect(historyPayload.history.map((entry) => entry.stage)).toEqual(
        expect.arrayContaining(["goal_run_handoff:deploy", "goal_run_trace:deploy:completed"])
      );
    });
  });
});

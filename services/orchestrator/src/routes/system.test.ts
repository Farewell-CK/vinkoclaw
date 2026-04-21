import express from "express";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VinkoStore } from "@vinko/shared";
import { globalTelemetry } from "@vinko/agent-runtime";
import { registerSystemRoutes } from "./system.js";

function createSystemRoutesApp(store: VinkoStore): express.Express {
  const app = express();
  registerSystemRoutes(app, {
    store,
    buildSystemMetricsSnapshot: () => ({ ok: true }),
    buildSystemHealthReport: () => ({ ok: true }),
    buildSystemDailyKpi: () => ({ days: 14 }),
    sanitizeApprovalRecord: (approval) => approval,
    sanitizeOperatorActionRecord: (action) => action
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

describe("system routes", () => {
  it("returns a unified activity feed ordered by recency", async () => {
    vi.spyOn(globalTelemetry, "listTraces").mockReturnValue([
      {
        taskId: "task-trace-1",
        sessionId: "sess-1",
        roleId: "frontend",
        instruction: "Build a task board",
        turns: [
          {
            round: 1,
            modelInputSummary: "input",
            modelOutputSummary: "output",
            toolCalls: [],
            backendUsed: "openai",
            modelUsed: "gpt-test",
            durationMs: 120,
            usage: {
              promptTokens: 100,
              completionTokens: 40,
              totalTokens: 140
            }
          }
        ],
        metrics: {
          totalTokens: 140,
          totalPromptTokens: 100,
          totalCompletionTokens: 40,
          toolCalls: 0,
          errors: 0,
          roundsBlocked: 0,
          durationMs: 120
        },
        startedAt: "2026-04-21T10:01:00.000Z"
      }
    ]);

    const store = {
      getRuntimeConfig: vi.fn(() => ({})),
      getDashboardSnapshot: vi.fn(() => ({
        approvals: [],
        operatorActions: []
      })),
      resolveSkillsForRole: vi.fn(() => []),
      listAuditEvents: vi.fn(() => [
        {
          id: "audit-1",
          category: "goal-run",
          entityType: "goal_run",
          entityId: "goal-1",
          message: "Created goal run",
          payload: {},
          createdAt: "2026-04-21T10:00:00.000Z"
        }
      ]),
      listTasks: vi.fn(() => [
        {
          id: "task-1",
          source: "control-center",
          roleId: "backend",
          title: "Build API",
          instruction: "Ship a generic API",
          status: "running",
          priority: 90,
          metadata: {},
          createdAt: "2026-04-21T09:58:00.000Z",
          updatedAt: "2026-04-21T10:03:00.000Z"
        }
      ]),
      listGoalRuns: vi.fn(() => [
        {
          id: "goal-1",
          source: "control-center",
          objective: "Build a general agent workspace",
          status: "running",
          currentStage: "execute",
          language: "zh-CN",
          metadata: {},
          context: {},
          retryCount: 0,
          maxRetries: 2,
          awaitingInputFields: [],
          createdAt: "2026-04-21T09:57:00.000Z",
          updatedAt: "2026-04-21T10:02:30.000Z"
        }
      ]),
      listApprovals: vi.fn(() => [
        {
          id: "approval-1",
          kind: "task_execution",
          summary: "Approve external API call",
          payload: {},
          status: "pending",
          createdAt: "2026-04-21T10:02:00.000Z",
          updatedAt: "2026-04-21T10:02:00.000Z"
        }
      ])
    } as unknown as VinkoStore;
    const app = createSystemRoutesApp(store);

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/system/activity-feed?limit=4`);
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        generatedAt: string;
        total: number;
        events: Array<{
          kind: string;
          title: string;
          summary: string;
          entityType: string;
          entityId: string;
          status?: string;
          metrics?: {
            totalTokens?: number;
          };
        }>;
      };

      expect(payload.total).toBe(5);
      expect(payload.events).toHaveLength(4);
      expect(payload.events.map((event) => event.kind)).toEqual(["task", "goal_run", "approval", "trace"]);
      expect(payload.events[0]?.entityId).toBe("task-1");
      expect(payload.events[1]?.entityId).toBe("goal-1");
      expect(payload.events[2]?.entityId).toBe("approval-1");
      expect(payload.events[3]?.entityId).toBe("task-trace-1");
      expect(payload.events[3]?.metrics?.totalTokens).toBe(140);
    });
  });

  it("returns runtime harness snapshot", async () => {
    const store = {
      getRuntimeConfig: vi.fn(() => ({})),
      getDashboardSnapshot: vi.fn(() => ({
        approvals: [],
        operatorActions: []
      })),
      resolveSkillsForRole: vi.fn(() => [])
    } as unknown as VinkoStore;
    const app = createSystemRoutesApp(store);

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/system/runtime-harness`);
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        toolRegistry: {
          mode: string;
          total: number;
          tools: Array<Record<string, unknown>>;
        };
        rulesEngine: {
          mode: string;
          total: number;
          rules: Array<Record<string, unknown>>;
        };
        skills: {
          mode: string;
          catalogTotal: number;
          catalog: Array<Record<string, unknown>>;
          roles: Array<Record<string, unknown>>;
        };
      };
      expect(payload.toolRegistry.mode).toBe("default");
      expect(payload.toolRegistry.total).toBeGreaterThanOrEqual(3);
      expect(payload.toolRegistry.tools.some((tool) => tool.name === "run_code")).toBe(true);
      expect(payload.rulesEngine.mode).toBe("default");
      expect(payload.rulesEngine.total).toBeGreaterThan(0);
      expect(payload.rulesEngine.rules.some((rule) => rule.id === "block-dangerous-commands")).toBe(true);
      expect(payload.skills.mode).toBe("role_bound");
      expect(payload.skills.catalogTotal).toBeGreaterThan(0);
      expect(payload.skills.catalog.some((skill) => skill.skillId === "prd-writer")).toBe(true);
      expect(Array.isArray(payload.skills.roles)).toBe(true);
      expect(payload.skills.roles.some((role) => role.roleId === "product")).toBe(true);
    });
  });

  it("returns health report payload as provided by server", async () => {
    const healthReport = {
      ok: false,
      summary: {
        critical: 1,
        warning: 2
      },
      queue: {
        queuedTasks: 3,
        runningTasks: 0,
        waitingApprovalTasks: 0,
        pausedInputTasks: 1,
        queuedGoalRuns: 1,
        runningGoalRuns: 0,
        queueBacklogWithoutRunningWorkers: true
      },
      recovery: {
        recommendedResetMode: "factory-reset",
        actions: ["执行 `npm run reset:runtime:factory-reset`"]
      },
      alerts: [
        {
          level: "critical",
          code: "queued_without_runner_progress",
          message: "存在排队任务，但当前没有 running task/goal run，疑似 task-runner 不消费队列"
        }
      ]
    };
    const store = {
      getRuntimeConfig: vi.fn(() => ({})),
      getDashboardSnapshot: vi.fn(() => ({
        approvals: [],
        operatorActions: []
      })),
      resolveSkillsForRole: vi.fn(() => [])
    } as unknown as VinkoStore;
    const app = express();
    registerSystemRoutes(app, {
      store,
      buildSystemMetricsSnapshot: () => ({ ok: true }),
      buildSystemHealthReport: () => healthReport,
      buildSystemDailyKpi: () => ({ days: 14 }),
      sanitizeApprovalRecord: (approval) => approval,
      sanitizeOperatorActionRecord: (action) => action
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/system/health-report`);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual(healthReport);
    });
  });
});

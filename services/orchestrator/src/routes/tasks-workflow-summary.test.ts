import express from "express";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskRecord, VinkoStore } from "@vinko/shared";
import type { TaskRoutesDeps } from "./tasks.js";
import { registerTaskRoutes } from "./tasks.js";

function buildTask(patch: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task_1",
    sessionId: "session_1",
    source: "feishu",
    roleId: "operations",
    title: "交付 founder weekly recap",
    instruction: "整理周报",
    status: "queued",
    priority: 80,
    requestedBy: "ou_owner",
    chatId: "chat_1",
    metadata: {},
    createdAt: "2026-04-19T10:00:00.000Z",
    updatedAt: "2026-04-19T10:00:00.000Z",
    ...patch
  };
}

function createApp(store: VinkoStore): express.Express {
  const app = express();
  app.use(express.json());
  registerTaskRoutes(app, {
    store,
    ensureInboundSession: () => undefined,
    selectRoleFromText: () => "operations",
    shorten: (value: string) => value,
    normalizeAttachments: () => [],
    handleInboundMessage: () => Promise.resolve({ message: "ok" }),
    buildAutoSplitSpecs: () => [],
    splitTaskIntoChildren: () => []
  } satisfies TaskRoutesDeps);
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

describe("task workflow summary routes", () => {
  it("returns unified workflow summary on task detail", async () => {
    const task = buildTask({
      title: "交付 founder 报告",
      metadata: {
        orchestrationState: {
          version: 1,
          mode: "main_agent",
          ownerRoleId: "product",
          spec: { goal: "交付 founder 报告" },
          progress: {
            stage: "report",
            status: "active",
            nextActions: ["继续验证"],
            awaitingInput: [],
            blocked: []
          },
          artifactIndex: {
            items: [{ path: "docs/report.md", title: "Founder Report", stage: "report", status: "produced" }]
          },
          updatedAt: "2026-04-19T10:00:00.000Z",
          updatedBy: "product"
        },
        toolChangedFiles: ["docs/report.md", "docs/report.html"]
      }
    });
    const store = {
      getTask: vi.fn((id: string) => (id === task.id ? task : undefined)),
      getSession: vi.fn(() => undefined),
      listToolRunsByTask: vi.fn(() => []),
      listTaskChildren: vi.fn(() => []),
      listSessionMessages: vi.fn(() => [])
    } as unknown as VinkoStore;
    const app = createApp(store);

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/tasks/${task.id}`);
      expect(response.status).toBe(200);
      const payload = (await response.json()) as { workflowSummary: string };
      expect(payload.workflowSummary).toContain("**目标**：交付 founder 报告");
      expect(payload.workflowSummary).toContain("**当前阶段**：report · active");
      expect(payload.workflowSummary).toContain("**下一步**：继续验证");
      expect(payload.workflowSummary).toContain("**导出**：Markdown / HTML");
    });
  });

  it("returns unified workflow summary on collaboration detail", async () => {
    const task = buildTask({
      metadata: {
        orchestrationState: {
          version: 1,
          mode: "main_agent",
          ownerRoleId: "operations",
          spec: { goal: "交付 founder weekly recap" },
          progress: {
            stage: "recap",
            status: "await_user",
            nextActions: ["补充本周关键指标"],
            awaitingInput: ["确认本周转化率"],
            blocked: []
          },
          artifactIndex: {
            items: [{ path: "docs/founder-weekly-recap.md", title: "周报", stage: "recap", status: "produced" }]
          },
          updatedAt: "2026-04-19T10:00:00.000Z",
          updatedBy: "operations"
        }
      }
    });
    const collaboration = {
      id: "collab_1",
      parentTaskId: task.id,
      currentPhase: "await_user",
      participants: ["operations", "qa"]
    };
    const childTask = buildTask({
      id: "task_child_1",
      roleId: "operations",
      title: "整理周报摘要",
      metadata: {
        collaborationId: collaboration.id
      }
    });
    const store = {
      getTask: vi.fn((id: string) => (id === task.id ? task : undefined)),
      getSession: vi.fn(() => undefined),
      listAgentCollaborationsByParentTask: vi.fn(() => [collaboration]),
      listTaskChildren: vi.fn(() => [childTask]),
      listAgentMessages: vi.fn(() => []),
      listCollaborationTimelineEvents: vi.fn(() => []),
      listToolRunsByTask: vi.fn(() => [])
    } as unknown as VinkoStore;
    const app = createApp(store);

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/tasks/${task.id}/collaboration`);
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        workflowSummary: string;
        children: Array<Record<string, unknown>>;
      };
      expect(payload.workflowSummary).toContain("**目标**：交付 founder weekly recap");
      expect(payload.workflowSummary).toContain("**当前阶段**：recap · await_user");
      expect(payload.workflowSummary).toContain("**待补充**：确认本周转化率");
      expect(payload.workflowSummary).toContain("**导出**：Markdown");
      expect(payload.children).toHaveLength(1);
    });
  });
});

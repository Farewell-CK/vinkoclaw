import express from "express";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import type { CrmCadenceRecord, CrmLeadRecord, SessionRecord, TaskRecord, VinkoStore } from "@vinko/shared";
import { registerTaskRoutes } from "./tasks.js";

function buildSession(patch: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "session_1",
    source: "control-center",
    sourceKey: "session_1",
    title: "OPC 增长引擎",
    status: "active",
    metadata: {
      projectMemory: {
        currentGoal: "OPC 增长引擎",
        currentStage: "operations",
        latestSummary: "正在跟进首批线索",
        nextActions: [],
        updatedAt: "2026-04-21T08:00:00.000Z",
        updatedBy: "operations"
      }
    },
    createdAt: "2026-04-21T00:00:00.000Z",
    updatedAt: "2026-04-21T08:00:00.000Z",
    lastMessageAt: "2026-04-21T08:00:00.000Z",
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
    latestSummary: "等待跟进",
    linkedProjectId: "project:opc-增长引擎",
    metadata: {},
    createdAt: "2026-04-21T00:00:00.000Z",
    updatedAt: "2026-04-21T08:00:00.000Z",
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
    nextRunAt: "2026-04-20T08:00:00.000Z",
    status: "active",
    metadata: {},
    createdAt: "2026-04-21T00:00:00.000Z",
    updatedAt: "2026-04-21T08:00:00.000Z",
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
    shorten: (value) => value,
    normalizeAttachments: () => [],
    handleInboundMessage: async () => ({ message: "ok" }),
    buildAutoSplitSpecs: () => [],
    splitTaskIntoChildren: () => []
  });
  return app;
}

async function withServer(app: express.Express, fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
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

describe("project board attention route", () => {
  it("returns CEO attention items with optional level filtering", async () => {
    const store = {
      listSessions: vi.fn(() => [buildSession()]),
      listTasks: vi.fn(() => [] as TaskRecord[]),
      listGoalRuns: vi.fn(() => []),
      resolveSkillsForRole: vi.fn(() => []),
      getWorkspaceMemory: vi.fn(() => undefined),
      listCrmLeads: vi.fn(() => [buildLead()]),
      listCrmCadences: vi.fn(() => [buildCadence()]),
      listCrmContacts: vi.fn(() => []),
      listGoalRunHandoffArtifacts: vi.fn(() => []),
      listGoalRunTraces: vi.fn(() => [])
    } as unknown as VinkoStore;
    const app = createApp(store);

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/project-board/attention?level=watch`);
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        attentionQueue: Array<{ projectName: string; level: string; reason: string; nextAction: string }>;
      };
      expect(payload.attentionQueue).toHaveLength(1);
      expect(payload.attentionQueue[0]).toMatchObject({
        projectName: "OPC 增长引擎",
        level: "watch",
        reason: "overdue_cadence",
        nextAction: "run_due_cadences"
      });
    });
  });
});

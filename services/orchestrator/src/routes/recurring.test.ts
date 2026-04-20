import express from "express";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VinkoStore } from "@vinko/shared";
import { registerRecurringRoutes } from "./recurring.js";

function createApp(store: VinkoStore): express.Express {
  const app = express();
  app.use(express.json());
  registerRecurringRoutes(app, { store });
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

describe("recurring routes", () => {
  it("returns recurring dashboard summary from CRM cadence state", async () => {
    const store = {
      listCrmLeads: vi.fn(() => [{ id: "lead_1", status: "active", linkedProjectId: "project:vinkoclaw" }]),
      listTasks: vi.fn(() => [
        {
          id: "task_followup_1",
          title: "CRM Follow-up: Annie Case",
          status: "completed",
          requestedBy: "crm-cadence",
          createdAt: "2026-04-20T09:00:00.000Z",
          metadata: {
            workflowLabel: "crm_follow_up",
            cadenceTriggeredAt: "2026-04-20T09:00:00.000Z",
            crmCadenceId: "cadence_due",
            crmLeadId: "lead_1"
          }
        }
      ]),
      listCrmCadences: vi
        .fn()
        .mockImplementation((input?: { dueBefore?: string; status?: string }) =>
          input?.dueBefore
            ? [{ id: "cadence_due", status: "active", nextRunAt: "2026-04-19T09:00:00.000Z" }]
            : [{ id: "cadence_due", status: "active" }, { id: "cadence_future", status: "active" }]
        )
    } as unknown as VinkoStore;
    const app = createApp(store);

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/recurring/dashboard`);
      expect(response.status).toBe(200);
      const payload = (await response.json()) as Record<string, unknown>;
      const summary = payload.summary as Record<string, unknown>;
      const history = payload.history as Record<string, unknown>;
      expect(summary.activeLeads).toBe(1);
      expect(summary.activeCadences).toBe(2);
      expect(summary.dueCadences).toBe(1);
      expect(summary.lastRunAt).toBe("2026-04-20T09:00:00.000Z");
      expect((history.summary as Record<string, unknown>).totalRuns).toBe(1);
    });
  });

  it("runs due cadences through recurring endpoint", async () => {
    const cadence = {
      id: "cadence_1",
      leadId: "lead_1",
      label: "weekly follow-up",
      channel: "email",
      intervalDays: 7,
      status: "active",
      objective: "持续推进合作沟通",
      nextRunAt: "2026-04-19T09:00:00.000Z",
      createdAt: "2026-04-20T00:00:00.000Z",
      updatedAt: "2026-04-20T00:00:00.000Z"
    };
    const lead = {
      id: "lead_1",
      name: "Annie Case",
      source: "manual",
      stage: "qualified",
      status: "active",
      tags: [],
      linkedProjectId: "project:vinkoclaw",
      createdAt: "2026-04-20T00:00:00.000Z",
      updatedAt: "2026-04-20T00:00:00.000Z"
    };
    const store = {
      listCrmCadences: vi.fn(() => [cadence]),
      getCrmCadence: vi.fn(() => cadence),
      getCrmLead: vi.fn(() => lead),
      ensureSession: vi.fn(() => ({
        id: "session_1",
        source: "system",
        sourceKey: "crm:lead:lead_1",
        title: "CRM / Annie Case",
        status: "active",
        metadata: {},
        createdAt: "2026-04-20T00:00:00.000Z",
        updatedAt: "2026-04-20T00:00:00.000Z",
        lastMessageAt: "2026-04-20T00:00:00.000Z"
      })),
      createTask: vi.fn(() => ({
        id: "task_1",
        sessionId: "session_1"
      })),
      updateCrmCadence: vi.fn(() => cadence)
    } as unknown as VinkoStore;
    const app = createApp(store);

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/recurring/run-due`, {
        method: "POST"
      });
      expect(response.status).toBe(200);
      const payload = (await response.json()) as Record<string, unknown>;
      const summary = payload.summary as Record<string, unknown>;
      const crm = payload.crm as Record<string, unknown>;
      expect(summary.triggered).toBe(1);
      expect((crm.summary as Record<string, unknown>).dueCadences).toBe(1);
    });
  });

  it("returns recurring history and auto tick alias", async () => {
    const store = {
      listTasks: vi.fn(() => [
        {
          id: "task_followup_1",
          title: "CRM Follow-up: Annie Case",
          status: "running",
          requestedBy: "crm-cadence",
          createdAt: "2026-04-20T10:00:00.000Z",
          metadata: {
            workflowLabel: "crm_follow_up",
            cadenceTriggeredAt: "2026-04-20T10:00:00.000Z",
            crmCadenceId: "cadence_1",
            crmLeadId: "lead_1"
          }
        }
      ]),
      listCrmLeads: vi.fn(() => []),
      listCrmCadences: vi.fn(() => [])
    } as unknown as VinkoStore;
    const app = createApp(store);

    await withServer(app, async (baseUrl) => {
      const historyResponse = await fetch(`${baseUrl}/api/recurring/history`);
      expect(historyResponse.status).toBe(200);
      const historyPayload = (await historyResponse.json()) as Record<string, unknown>;
      expect((historyPayload.summary as Record<string, unknown>).totalRuns).toBe(1);
      expect((historyPayload.recentRuns as Array<Record<string, unknown>>)[0]?.cadenceId).toBe("cadence_1");

      const tickResponse = await fetch(`${baseUrl}/api/recurring/tick`, { method: "POST" });
      expect(tickResponse.status).toBe(200);
      const tickPayload = (await tickResponse.json()) as Record<string, unknown>;
      expect(tickPayload.mode).toBe("auto");
      expect((tickPayload.history as Record<string, unknown>).summary).toBeTruthy();
    });
  });
});

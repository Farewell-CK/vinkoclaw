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
      expect(summary.activeLeads).toBe(1);
      expect(summary.activeCadences).toBe(2);
      expect(summary.dueCadences).toBe(1);
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
});

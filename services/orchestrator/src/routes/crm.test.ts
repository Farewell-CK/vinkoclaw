import express from "express";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CrmCadenceRecord, CrmLeadRecord, VinkoStore } from "@vinko/shared";
import { registerCrmRoutes } from "./crm.js";

function buildLead(patch: Partial<CrmLeadRecord> = {}): CrmLeadRecord {
  return {
    id: "lead_1",
    name: "Annie Case",
    source: "feishu",
    stage: "new",
    status: "active",
    tags: [],
    latestSummary: "",
    metadata: {},
    createdAt: "2026-04-20T00:00:00.000Z",
    updatedAt: "2026-04-20T00:00:00.000Z",
    ...patch
  };
}

function createApp(store: VinkoStore): express.Express {
  const app = express();
  app.use(express.json());
  registerCrmRoutes(app, { store });
  return app;
}

function buildCadence(patch: Partial<CrmCadenceRecord> = {}): CrmCadenceRecord {
  return {
    id: "cadence_1",
    leadId: "lead_1",
    label: "weekly follow-up",
    channel: "email",
    intervalDays: 7,
    status: "active",
    objective: "持续推进合作沟通",
    nextRunAt: "2026-04-27T09:00:00.000Z",
    metadata: {},
    createdAt: "2026-04-20T00:00:00.000Z",
    updatedAt: "2026-04-20T00:00:00.000Z",
    ...patch
  };
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

describe("crm routes", () => {
  it("creates and lists leads", async () => {
    const created = buildLead({ latestSummary: "有合作兴趣" });
    const store = {
      listCrmLeads: vi.fn(() => [created]),
      createCrmLead: vi.fn(() => created)
    } as unknown as VinkoStore;
    const app = createApp(store);

    await withServer(app, async (baseUrl) => {
      const createResponse = await fetch(`${baseUrl}/api/crm/leads`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Annie Case",
          source: "feishu",
          latestSummary: "有合作兴趣"
        })
      });
      expect(createResponse.status).toBe(201);
      const listResponse = await fetch(`${baseUrl}/api/crm/leads`);
      expect(listResponse.status).toBe(200);
      const payload = (await listResponse.json()) as { leads: Array<Record<string, unknown>> };
      expect(payload.leads).toHaveLength(1);
      expect(payload.leads[0]?.name).toBe("Annie Case");
    });
  });

  it("updates and archives leads", async () => {
    const updated = buildLead({ stage: "proposal", nextAction: "发送报价" });
    const archived = buildLead({ status: "archived", archivedAt: "2026-04-20T01:00:00.000Z" });
    const store = {
      getCrmLead: vi.fn(() => updated),
      updateCrmLead: vi.fn(() => updated),
      archiveCrmLead: vi.fn(() => archived)
    } as unknown as VinkoStore;
    const app = createApp(store);

    await withServer(app, async (baseUrl) => {
      const detailResponse = await fetch(`${baseUrl}/api/crm/leads/${updated.id}`);
      expect(detailResponse.status).toBe(200);
      const patchResponse = await fetch(`${baseUrl}/api/crm/leads/${updated.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          stage: "proposal",
          nextAction: "发送报价"
        })
      });
      expect(patchResponse.status).toBe(200);
      const archiveResponse = await fetch(`${baseUrl}/api/crm/leads/${updated.id}/archive`, {
        method: "POST"
      });
      expect(archiveResponse.status).toBe(200);
      const payload = (await archiveResponse.json()) as { lead: Record<string, unknown> };
      expect(payload.lead.status).toBe("archived");
    });
  });

  it("creates and lists cadences", async () => {
    const lead = buildLead();
    const cadence = buildCadence();
    const store = {
      getCrmLead: vi.fn(() => lead),
      createCrmCadence: vi.fn(() => cadence),
      listCrmCadences: vi.fn(() => [cadence])
    } as unknown as VinkoStore;
    const app = createApp(store);

    await withServer(app, async (baseUrl) => {
      const createResponse = await fetch(`${baseUrl}/api/crm/cadences`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          leadId: lead.id,
          label: "weekly follow-up",
          channel: "email",
          intervalDays: 7,
          objective: "持续推进合作沟通",
          nextRunAt: "2026-04-27T09:00:00.000Z"
        })
      });
      expect(createResponse.status).toBe(201);

      const listResponse = await fetch(`${baseUrl}/api/crm/cadences?leadId=${lead.id}`);
      expect(listResponse.status).toBe(200);
      const payload = (await listResponse.json()) as { cadences: Array<Record<string, unknown>> };
      expect(payload.cadences).toHaveLength(1);
      expect(payload.cadences[0]?.label).toBe("weekly follow-up");
    });
  });

  it("updates and archives cadences", async () => {
    const cadence = buildCadence({ status: "paused", lastRunAt: "2026-04-20T10:00:00.000Z" });
    const archived = buildCadence({ status: "archived" });
    const store = {
      getCrmCadence: vi.fn(() => cadence),
      updateCrmCadence: vi.fn(() => cadence),
      archiveCrmCadence: vi.fn(() => archived)
    } as unknown as VinkoStore;
    const app = createApp(store);

    await withServer(app, async (baseUrl) => {
      const detailResponse = await fetch(`${baseUrl}/api/crm/cadences/${cadence.id}`);
      expect(detailResponse.status).toBe(200);

      const patchResponse = await fetch(`${baseUrl}/api/crm/cadences/${cadence.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          status: "paused",
          lastRunAt: "2026-04-20T10:00:00.000Z"
        })
      });
      expect(patchResponse.status).toBe(200);

      const archiveResponse = await fetch(`${baseUrl}/api/crm/cadences/${cadence.id}/archive`, {
        method: "POST"
      });
      expect(archiveResponse.status).toBe(200);
      const payload = (await archiveResponse.json()) as { cadence: Record<string, unknown> };
      expect(payload.cadence.status).toBe("archived");
    });
  });
});

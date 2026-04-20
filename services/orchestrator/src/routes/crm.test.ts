import express from "express";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CrmLeadRecord, VinkoStore } from "@vinko/shared";
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
});

import express from "express";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CrmCadenceRecord, CrmContactRecord, CrmLeadRecord, VinkoStore } from "@vinko/shared";
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

function buildContact(patch: Partial<CrmContactRecord> = {}): CrmContactRecord {
  return {
    id: "contact_1",
    leadId: "lead_1",
    channel: "email",
    outcome: "replied",
    summary: "对方回复愿意进一步沟通",
    nextAction: "安排演示",
    happenedAt: "2026-04-20T10:00:00.000Z",
    createdAt: "2026-04-20T10:00:00.000Z",
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

  it("writes contact results back to leads", async () => {
    const lead = buildLead({ latestSummary: "初次接触", nextAction: "发送资料" });
    const updatedLead = buildLead({
      latestSummary: "对方回复愿意进一步沟通",
      nextAction: "安排演示",
      lastContactAt: "2026-04-20T10:00:00.000Z"
    });
    const cadence = buildCadence({
      id: "cadence_1",
      leadId: lead.id,
      lastRunAt: "2026-04-20T10:00:00.000Z"
    });
    const contact = buildContact({ cadenceId: cadence.id });
    const store = {
      getCrmLead: vi.fn(() => lead),
      getCrmCadence: vi.fn(() => cadence),
      listCrmContacts: vi.fn(() => [contact]),
      createCrmContact: vi.fn(() => contact),
      updateCrmLead: vi.fn(() => updatedLead)
    } as unknown as VinkoStore;
    const app = createApp(store);

    await withServer(app, async (baseUrl) => {
      const detailResponse = await fetch(`${baseUrl}/api/crm/leads/${lead.id}`);
      expect(detailResponse.status).toBe(200);
      const detailPayload = (await detailResponse.json()) as { contacts: Array<Record<string, unknown>> };
      expect(detailPayload.contacts).toHaveLength(1);

      const createResponse = await fetch(`${baseUrl}/api/crm/leads/${lead.id}/contacts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          channel: "email",
          cadenceId: cadence.id,
          outcome: "replied",
          summary: "对方回复愿意进一步沟通",
          nextAction: "安排演示",
          happenedAt: "2026-04-20T10:00:00.000Z"
        })
      });
      expect(createResponse.status).toBe(201);
      const payload = (await createResponse.json()) as { contact: Record<string, unknown>; cadence: Record<string, unknown> };
      expect(payload.contact.outcome).toBe("replied");
      expect(payload.cadence.id).toBe("cadence_1");
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

  it("returns a CRM dashboard with overdue cadences", async () => {
    const lead = buildLead({ linkedProjectId: "project:vinkoclaw" });
    const overdue = buildCadence({ nextRunAt: "2026-04-19T09:00:00.000Z" });
    const active = buildCadence({ id: "cadence_2", nextRunAt: "2026-04-25T09:00:00.000Z" });
    const completed = buildCadence({ id: "cadence_3", status: "completed", nextRunAt: "2026-04-18T09:00:00.000Z" });
    const contact = buildContact({ outcome: "meeting_booked" });
    const store = {
      listCrmLeads: vi.fn(() => [lead]),
      listCrmContacts: vi.fn(() => [contact]),
      listCrmCadences: vi
        .fn()
        .mockImplementation((input?: { dueBefore?: string; status?: string }) =>
          input?.dueBefore
            ? [overdue]
            : input?.status === "completed"
              ? [completed]
              : input?.status === "active"
                ? [overdue, active]
                : [overdue, active, completed]
        )
    } as unknown as VinkoStore;
    const app = createApp(store);

    await withServer(app, async (baseUrl) => {
      const dashboardResponse = await fetch(`${baseUrl}/api/crm/dashboard`);
      expect(dashboardResponse.status).toBe(200);
      const payload = (await dashboardResponse.json()) as {
        summary: Record<string, number>;
        contactOutcomes: Record<string, number>;
        recentContacts: Array<Record<string, unknown>>;
        overdueCadences: Array<Record<string, unknown>>;
        activeLeads: Array<Record<string, unknown>>;
      };
      expect(payload.summary.activeLeads).toBe(1);
      expect(payload.summary.activeCadences).toBe(2);
      expect(payload.summary.completedCadences).toBe(1);
      expect(payload.summary.overdueCadences).toBe(1);
      expect(payload.summary.projectLinkedLeads).toBe(1);
      expect(payload.summary.totalContacts).toBe(1);
      expect(payload.summary.positiveContacts).toBe(1);
      expect(payload.contactOutcomes.meeting_booked).toBe(1);
      expect(payload.recentContacts[0]?.id).toBe("contact_1");
      expect(payload.overdueCadences[0]?.id).toBe("cadence_1");
      expect(payload.activeLeads[0]?.id).toBe("lead_1");
    });
  });

  it("triggers a follow-up task from cadence", async () => {
    const lead = buildLead({ company: "Indie Labs", linkedProjectId: "project:vinkoclaw" });
    const cadence = buildCadence({ ownerRoleId: "operations" });
    const session = {
      id: "session_1",
      source: "system",
      sourceKey: `crm:lead:${lead.id}`,
      title: "CRM / Annie Case",
      status: "active",
      metadata: {},
      createdAt: "2026-04-20T00:00:00.000Z",
      updatedAt: "2026-04-20T00:00:00.000Z",
      lastMessageAt: "2026-04-20T00:00:00.000Z"
    };
    const task = {
      id: "task_1",
      sessionId: session.id,
      source: "system",
      roleId: "operations",
      title: "CRM Follow-up: Annie Case / weekly follow-up",
      instruction: "跟进内容",
      status: "queued",
      priority: 72,
      metadata: {
        crmLeadId: lead.id,
        crmCadenceId: cadence.id
      },
      createdAt: "2026-04-20T00:00:00.000Z",
      updatedAt: "2026-04-20T00:00:00.000Z"
    };
    const updatedCadence = buildCadence({
      nextRunAt: "2026-04-27T09:00:00.000Z",
      lastRunAt: "2026-04-20T09:00:00.000Z"
    });
    const store = {
      getCrmCadence: vi.fn(() => cadence),
      getCrmLead: vi.fn(() => lead),
      ensureSession: vi.fn(() => session),
      createTask: vi.fn(() => task),
      updateCrmCadence: vi.fn(() => updatedCadence)
    } as unknown as VinkoStore;
    const app = createApp(store);

    await withServer(app, async (baseUrl) => {
      const triggerResponse = await fetch(`${baseUrl}/api/crm/cadences/${cadence.id}/trigger-followup`, {
        method: "POST"
      });
      expect(triggerResponse.status).toBe(201);
      const payload = (await triggerResponse.json()) as {
        task: Record<string, unknown>;
        session: Record<string, unknown>;
        cadence: Record<string, unknown>;
      };
      expect(payload.task.id).toBe("task_1");
      expect(payload.session.id).toBe("session_1");
      expect(payload.cadence.id).toBe("cadence_1");
      expect(payload.task.title).toBe("CRM Follow-up: Annie Case / weekly follow-up");
    });
  });

  it("runs all due cadences in bulk", async () => {
    const lead = buildLead();
    const cadences = [
      buildCadence({ id: "cadence_1" }),
      buildCadence({ id: "cadence_2", leadId: "lead_1", label: "second follow-up" })
    ];
    const sessions = [
      {
        id: "session_1",
        source: "system",
        sourceKey: "crm:lead:lead_1",
        title: "CRM / Annie Case",
        status: "active",
        metadata: {},
        createdAt: "2026-04-20T00:00:00.000Z",
        updatedAt: "2026-04-20T00:00:00.000Z",
        lastMessageAt: "2026-04-20T00:00:00.000Z"
      },
      {
        id: "session_2",
        source: "system",
        sourceKey: "crm:lead:lead_1",
        title: "CRM / Annie Case",
        status: "active",
        metadata: {},
        createdAt: "2026-04-20T00:00:00.000Z",
        updatedAt: "2026-04-20T00:00:00.000Z",
        lastMessageAt: "2026-04-20T00:00:00.000Z"
      }
    ];
    const tasks = [
      {
        id: "task_1",
        sessionId: "session_1",
        source: "system",
        roleId: "operations",
        title: "CRM Follow-up: Annie Case / weekly follow-up",
        instruction: "跟进内容",
        status: "queued",
        priority: 72,
        metadata: {},
        createdAt: "2026-04-20T00:00:00.000Z",
        updatedAt: "2026-04-20T00:00:00.000Z"
      },
      {
        id: "task_2",
        sessionId: "session_2",
        source: "system",
        roleId: "operations",
        title: "CRM Follow-up: Annie Case / second follow-up",
        instruction: "跟进内容",
        status: "queued",
        priority: 72,
        metadata: {},
        createdAt: "2026-04-20T00:00:00.000Z",
        updatedAt: "2026-04-20T00:00:00.000Z"
      }
    ];
    let sessionIndex = 0;
    let taskIndex = 0;
    const store = {
      listCrmCadences: vi.fn(() => cadences),
      getCrmCadence: vi.fn((id: string) => cadences.find((item) => item.id === id)),
      getCrmLead: vi.fn(() => lead),
      ensureSession: vi.fn(() => sessions[sessionIndex++]),
      createTask: vi.fn(() => tasks[taskIndex++]),
      updateCrmCadence: vi.fn((id: string) => cadences.find((item) => item.id === id))
    } as unknown as VinkoStore;
    const app = createApp(store);

    await withServer(app, async (baseUrl) => {
      const runResponse = await fetch(`${baseUrl}/api/crm/cadences/run-due`, {
        method: "POST"
      });
      expect(runResponse.status).toBe(200);
      const payload = (await runResponse.json()) as {
        summary: Record<string, number>;
        triggered: Array<Record<string, unknown>>;
      };
      expect(payload.summary.dueCadences).toBe(2);
      expect(payload.summary.triggered).toBe(2);
      expect(payload.triggered).toHaveLength(2);
      expect(payload.triggered[0]?.taskId).toBe("task_1");
      expect(payload.triggered[1]?.taskId).toBe("task_2");
    });
  });
});

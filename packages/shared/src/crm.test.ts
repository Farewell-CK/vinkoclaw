import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VinkoStore } from "./store.js";

const tempDirs: string[] = [];

function createTestStore(): VinkoStore {
  const dir = mkdtempSync(path.join(tmpdir(), "vinkoclaw-crm-store-"));
  tempDirs.push(dir);
  return new VinkoStore(path.join(dir, "test.sqlite"));
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("VinkoStore CRM leads", () => {
  it("creates and lists CRM leads", () => {
    const store = createTestStore();
    const lead = store.createCrmLead({
      name: "Annie Case",
      company: "Indie Labs",
      source: "feishu",
      stage: "qualified",
      tags: ["creator", "warm"],
      latestSummary: "对 AI 团队产品有兴趣",
      nextAction: "发送产品介绍",
      ownerRoleId: "operations",
      linkedProjectId: "project:vinkoclaw"
    });

    expect(lead.name).toBe("Annie Case");
    expect(lead.stage).toBe("qualified");
    expect(lead.status).toBe("active");

    const listed = store.listCrmLeads();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(lead.id);
  });

  it("updates and archives CRM leads", () => {
    const store = createTestStore();
    const lead = store.createCrmLead({
      name: "OpenRouter Team",
      source: "email",
      latestSummary: "等待商务回复"
    });

    const updated = store.updateCrmLead(lead.id, {
      stage: "proposal",
      nextAction: "一周后跟进",
      latestSummary: "已发送合作方案"
    });
    expect(updated?.stage).toBe("proposal");
    expect(updated?.nextAction).toBe("一周后跟进");

    const archived = store.archiveCrmLead(lead.id);
    expect(archived?.status).toBe("archived");
    expect(archived?.archivedAt).toBeTruthy();
    expect(store.listCrmLeads({ status: "archived" })).toHaveLength(1);
  });
});

describe("VinkoStore CRM cadences", () => {
  it("creates and lists cadences for a lead", () => {
    const store = createTestStore();
    const lead = store.createCrmLead({
      name: "Potential Design Partner",
      source: "email"
    });

    const cadence = store.createCrmCadence({
      leadId: lead.id,
      label: "weekly follow-up",
      channel: "email",
      intervalDays: 7,
      objective: "持续跟进合作意向",
      nextRunAt: "2026-04-27T09:00:00.000Z",
      ownerRoleId: "operations",
      metadata: { templateId: "tpl-founder-ops-recurring" }
    });

    expect(cadence.leadId).toBe(lead.id);
    expect(cadence.status).toBe("active");

    const listed = store.listCrmCadences({ leadId: lead.id });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(cadence.id);
  });

  it("updates and archives cadences", () => {
    const store = createTestStore();
    const lead = store.createCrmLead({
      name: "Prospect",
      source: "feishu"
    });
    const cadence = store.createCrmCadence({
      leadId: lead.id,
      label: "touch base",
      intervalDays: 3,
      objective: "确认是否愿意继续沟通",
      nextRunAt: "2026-04-23T09:00:00.000Z"
    });

    const updated = store.updateCrmCadence(cadence.id, {
      status: "paused",
      intervalDays: 5,
      lastRunAt: "2026-04-20T10:00:00.000Z"
    });
    expect(updated?.status).toBe("paused");
    expect(updated?.intervalDays).toBe(5);

    const archived = store.archiveCrmCadence(cadence.id);
    expect(archived?.status).toBe("archived");
    expect(store.listCrmCadences({ status: "archived" })).toHaveLength(1);
  });

  it("filters cadences by due date", () => {
    const store = createTestStore();
    const lead = store.createCrmLead({
      name: "Due Prospect",
      source: "email"
    });
    store.createCrmCadence({
      leadId: lead.id,
      label: "overdue cadence",
      intervalDays: 2,
      objective: "尽快补发跟进",
      nextRunAt: "2026-04-20T09:00:00.000Z"
    });
    store.createCrmCadence({
      leadId: lead.id,
      label: "future cadence",
      intervalDays: 7,
      objective: "下周再跟进",
      nextRunAt: "2026-04-27T09:00:00.000Z"
    });

    const due = store.listCrmCadences({ dueBefore: "2026-04-21T00:00:00.000Z" });
    expect(due).toHaveLength(1);
    expect(due[0]?.label).toBe("overdue cadence");
  });

  it("writes contact outcomes back into cadence state", () => {
    const store = createTestStore();
    const lead = store.createCrmLead({
      name: "Follow-up Prospect",
      source: "email"
    });
    const cadence = store.createCrmCadence({
      leadId: lead.id,
      label: "follow-up cadence",
      channel: "email",
      intervalDays: 5,
      objective: "持续推进沟通",
      nextRunAt: "2026-04-27T09:00:00.000Z"
    });

    store.createCrmContact({
      leadId: lead.id,
      cadenceId: cadence.id,
      channel: "email",
      outcome: "replied",
      summary: "对方回复希望下周继续沟通",
      happenedAt: "2026-04-20T10:00:00.000Z"
    });

    const repliedCadence = store.getCrmCadence(cadence.id);
    expect(repliedCadence?.lastRunAt).toBe("2026-04-20T10:00:00.000Z");
    expect(repliedCadence?.nextRunAt).toBe("2026-04-25T10:00:00.000Z");
    expect(repliedCadence?.status).toBe("active");

    store.createCrmContact({
      leadId: lead.id,
      cadenceId: cadence.id,
      channel: "email",
      outcome: "meeting_booked",
      summary: "已约好演示会议",
      happenedAt: "2026-04-21T09:00:00.000Z"
    });

    const completedCadence = store.getCrmCadence(cadence.id);
    expect(completedCadence?.lastRunAt).toBe("2026-04-21T09:00:00.000Z");
    expect(completedCadence?.status).toBe("completed");
  });

  it("progresses lead stage from contact outcomes", () => {
    const store = createTestStore();
    const lead = store.createCrmLead({
      name: "Stage Prospect",
      source: "email",
      stage: "new"
    });

    store.createCrmContact({
      leadId: lead.id,
      outcome: "sent",
      summary: "已发送首轮外联"
    });
    expect(store.getCrmLead(lead.id)?.stage).toBe("contacted");

    store.createCrmContact({
      leadId: lead.id,
      outcome: "replied",
      summary: "对方回复愿意沟通"
    });
    expect(store.getCrmLead(lead.id)?.stage).toBe("qualified");

    store.createCrmContact({
      leadId: lead.id,
      outcome: "meeting_booked",
      summary: "已预约演示会议"
    });
    expect(store.getCrmLead(lead.id)?.stage).toBe("proposal");

    store.createCrmContact({
      leadId: lead.id,
      outcome: "won",
      summary: "确认合作"
    });
    expect(store.getCrmLead(lead.id)?.stage).toBe("won");
  });
});

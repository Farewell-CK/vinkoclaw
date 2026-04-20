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
});

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

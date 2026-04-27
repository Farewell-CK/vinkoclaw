import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { WorkspaceMemoryManager } from "./workspace-memory.js";

function createTempDb(): { dbPath: string; db: DatabaseSync; manager: WorkspaceMemoryManager } {
  const dbPath = `/tmp/workspace-memory-test-${Date.now()}.db`;
  mkdirSync("/tmp", { recursive: true });
  const db = new DatabaseSync(dbPath);
  const manager = new WorkspaceMemoryManager(db);
  return { dbPath, db, manager };
}

function cleanup(dbPath: string): void {
  if (existsSync(dbPath)) {
    rmSync(dbPath, { force: true });
  }
}

describe("WorkspaceMemoryManager", () => {
  let ctx: ReturnType<typeof createTempDb>;

  beforeEach(() => {
    ctx = createTempDb();
  });

  afterEach(() => {
    ctx.db.close();
    cleanup(ctx.dbPath);
  });

  it("returns empty record for fresh database", () => {
    const result = ctx.manager.get();
    expect(result.userPreferences.preferredLanguage).toBe("default");
    expect(result.userPreferences.preferredTechStack).toEqual([]);
    expect(result.userPreferences.communicationStyle).toBe("default");
    expect(result.keyDecisions).toEqual([]);
    expect(result.projectContext.currentGoals).toEqual([]);
    expect(result.projectContext.activeProjects).toEqual([]);
  });

  it("patches user preferences", () => {
    const result = ctx.manager.patch({
      userPreferences: {
        preferredLanguage: "zh",
        preferredTechStack: ["React", "TypeScript"],
        communicationStyle: "concise"
      }
    });

    expect(result.userPreferences.preferredLanguage).toBe("zh");
    expect(result.userPreferences.preferredTechStack).toEqual(["React", "TypeScript"]);
    expect(result.userPreferences.communicationStyle).toBe("concise");
  });

  it("patches founder profile without schema migration", () => {
    ctx.manager.patchFounderProfile({
      businessDomains: ["AI Agent", "AI 玩具"],
      targetUsers: ["个人创业者"],
      deliverablePreferences: ["结论先行", "结构化报告"],
      decisionStyle: "evidence_first",
      feedbackSignals: [
        {
          signal: "revision_requested",
          note: "用户要求补充市场证据",
          taskId: "task_1",
          createdAt: "2026-04-27T00:00:00.000Z"
        }
      ]
    });

    const result = ctx.manager.get();
    expect(result.founderProfile.businessDomains).toEqual(["AI Agent", "AI 玩具"]);
    expect(result.founderProfile.targetUsers).toEqual(["个人创业者"]);
    expect(result.founderProfile.deliverablePreferences).toEqual(["结论先行", "结构化报告"]);
    expect(result.founderProfile.decisionStyle).toBe("evidence_first");
    expect(result.projectContext.founderProfile?.businessDomains).toEqual(["AI Agent", "AI 玩具"]);
  });

  it("records auditable memory facts with provenance", () => {
    ctx.manager.recordMemoryFact({
      kind: "business_domain",
      value: "AI 玩具",
      source: "task",
      confidence: 0.8,
      taskId: "task_1",
      sessionId: "session_1",
      note: "用户要求调研 AI 玩具市场"
    });

    const result = ctx.manager.get();
    expect(result.memoryFacts).toHaveLength(1);
    expect(result.memoryFacts?.[0]).toMatchObject({
      kind: "business_domain",
      value: "AI 玩具",
      source: "task",
      confidence: 0.8,
      taskId: "task_1",
      sessionId: "session_1"
    });
  });

  it("updates existing memory fact by stable id instead of duplicating", () => {
    ctx.manager.recordMemoryFact({
      id: "memory_fact_domain_ai_toy",
      kind: "business_domain",
      value: "AI 玩具",
      source: "task",
      confidence: 0.6
    });
    ctx.manager.recordMemoryFact({
      id: "memory_fact_domain_ai_toy",
      kind: "business_domain",
      value: "AI 玩具",
      source: "manual",
      confidence: 0.95,
      note: "用户确认这是核心方向"
    });

    const result = ctx.manager.get();
    expect(result.memoryFacts).toHaveLength(1);
    expect(result.memoryFacts?.[0]?.source).toBe("manual");
    expect(result.memoryFacts?.[0]?.confidence).toBe(0.95);
    expect(result.memoryFacts?.[0]?.note).toBe("用户确认这是核心方向");
  });

  it("can delete and reset memory facts", () => {
    ctx.manager.recordMemoryFact({
      id: "memory_fact_1",
      kind: "target_user",
      value: "个人创业者",
      source: "manual",
      confidence: 1
    });
    ctx.manager.recordMemoryFact({
      id: "memory_fact_2",
      kind: "deliverable_preference",
      value: "结构化报告",
      source: "manual",
      confidence: 1
    });

    expect(ctx.manager.deleteMemoryFact("memory_fact_1").memoryFacts).toHaveLength(1);
    expect(ctx.manager.resetMemoryFacts().memoryFacts).toEqual([]);
  });

  it("adds key decisions", () => {
    ctx.manager.addDecision("使用 React + Firebase", "团队熟悉该技术栈，开发效率高", "tech_stack");
    ctx.manager.addDecision("采用 JWT 认证", "无状态，易于扩展", "auth");

    const result = ctx.manager.get();
    expect(result.keyDecisions).toHaveLength(2);
    const d0 = result.keyDecisions[0]!;
    const d1 = result.keyDecisions[1]!;
    expect(d0.decision).toBe("使用 React + Firebase");
    expect(d0.rationale).toBe("团队熟悉该技术栈，开发效率高");
    expect(d0.category).toBe("tech_stack");
    expect(d1.decision).toBe("采用 JWT 认证");
    expect(d1.category).toBe("auth");
  });

  it("updates projects", () => {
    ctx.manager.updateProject("VinkoClaw", "development");
    ctx.manager.updateProject("Control Center", "design");

    const result = ctx.manager.get();
    expect(result.projectContext.activeProjects).toHaveLength(2);
    const p0 = result.projectContext.activeProjects[0]!;
    expect(p0.id).toBe("project:vinkoclaw");
    expect(p0.name).toBe("VinkoClaw");
    expect(p0.stage).toBe("development");
    expect(p0.status).toBe("active");
  });

  it("updates existing project stage", () => {
    ctx.manager.updateProject("VinkoClaw", "development");
    ctx.manager.updateProject("VinkoClaw", "testing");

    const result = ctx.manager.get();
    expect(result.projectContext.activeProjects).toHaveLength(1);
    const p0 = result.projectContext.activeProjects[0]!;
    expect(p0.stage).toBe("testing");
  });

  it("archives projects while preserving metadata", () => {
    ctx.manager.updateProject("VinkoClaw", "delivery", {
      latestSummary: "交付主链已完成",
      lastTaskId: "task_123"
    });
    ctx.manager.archiveProject("VinkoClaw", "项目收尾完成");

    const result = ctx.manager.get();
    expect(result.projectContext.activeProjects).toHaveLength(1);
    const p0 = result.projectContext.activeProjects[0]!;
    expect(p0.status).toBe("archived");
    expect(p0.latestSummary).toBe("项目收尾完成");
    expect(p0.lastTaskId).toBe("task_123");
  });

  it("sets preferences incrementally", () => {
    ctx.manager.setPreferences({ preferredLanguage: "en" });
    ctx.manager.setPreferences({ communicationStyle: "detailed" });

    const result = ctx.manager.get();
    expect(result.userPreferences.preferredLanguage).toBe("en");
    expect(result.userPreferences.communicationStyle).toBe("detailed");
    expect(result.userPreferences.preferredTechStack).toEqual([]); // unchanged
  });

  it("persists across multiple get calls", () => {
    ctx.manager.patch({
      userPreferences: {
        preferredLanguage: "zh",
        preferredTechStack: ["Vue"],
        communicationStyle: "concise"
      }
    });

    // Simulate fresh load
    const manager2 = new WorkspaceMemoryManager(ctx.db);
    const result = manager2.get();

    expect(result.userPreferences.preferredLanguage).toBe("zh");
    expect(result.userPreferences.preferredTechStack).toEqual(["Vue"]);
    expect(result.userPreferences.communicationStyle).toBe("concise");
  });

  it("handles partial patch correctly", () => {
    const result1 = ctx.manager.patch({
      userPreferences: { preferredLanguage: "zh" }
    });

    // Should preserve defaults for unpainted fields
    expect(result1.userPreferences.preferredTechStack).toEqual([]);
    expect(result1.userPreferences.communicationStyle).toBe("default");

    // Now patch only tech stack
    const result2 = ctx.manager.patch({
      userPreferences: { preferredTechStack: ["Next.js"] }
    });

    // Language should persist from previous patch
    expect(result2.userPreferences.preferredLanguage).toBe("zh");
    expect(result2.userPreferences.preferredTechStack).toEqual(["Next.js"]);
  });
});

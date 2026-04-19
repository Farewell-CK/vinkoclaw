import { describe, expect, it } from "vitest";
import {
  buildProjectMemoryUpdateFromTask,
  collectProjectMemoryArtifactsFromTask,
  extractArtifactFilesFromText,
  mergeProjectMemory,
  normalizeProjectMemory
} from "./project-memory.js";
import type { TaskRecord, ToolRunRecord } from "./types.js";

function buildTask(patch: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task_project_memory_1",
    source: "system",
    roleId: "cto",
    title: "交付协作项目",
    instruction: "请完成交付",
    status: "completed",
    priority: 90,
    metadata: {},
    createdAt: "2026-04-13T00:00:00.000Z",
    updatedAt: "2026-04-13T00:00:00.000Z",
    ...patch
  };
}

function buildToolRun(patch: Partial<ToolRunRecord> = {}): ToolRunRecord {
  return {
    id: "tool_run_1",
    taskId: "task_project_memory_1",
    roleId: "cto",
    providerId: "codex",
    title: "测试命令",
    instruction: "运行测试",
    status: "completed",
    approvalStatus: "not_required",
    command: "npm test",
    args: [],
    riskLevel: "low",
    requestedBy: "system",
    outputText: "",
    errorText: "",
    createdAt: "2026-04-13T00:00:00.000Z",
    updatedAt: "2026-04-13T00:00:00.000Z",
    ...patch
  };
}

describe("project-memory", () => {
  it("normalizes unknown values into a stable record", () => {
    const memory = normalizeProjectMemory({
      currentGoal: "  Launch landing page ",
      unresolvedQuestions: ["确认定价", "", "确认定价"],
      latestArtifacts: [" docs/prd.md ", "docs/prd.md"]
    });

    expect(memory.currentGoal).toBe("Launch landing page");
    expect(memory.unresolvedQuestions).toEqual(["确认定价"]);
    expect(memory.latestArtifacts).toEqual(["docs/prd.md"]);
    expect(memory.version).toBe(1);
  });

  it("merges explicit updates and allows clearing arrays", () => {
    const merged = mergeProjectMemory(
      {
        currentGoal: "Build AI team OS",
        currentStage: "awaiting_input",
        unresolvedQuestions: ["确认目标用户"],
        nextActions: ["等待补充信息"]
      },
      {
        currentStage: "collaboration_delivered",
        unresolvedQuestions: [],
        nextActions: ["开始实现控制台面板"],
        updatedBy: "ceo"
      }
    );

    expect(merged.currentGoal).toBe("Build AI team OS");
    expect(merged.currentStage).toBe("collaboration_delivered");
    expect(merged.unresolvedQuestions).toEqual([]);
    expect(merged.nextActions).toEqual(["开始实现控制台面板"]);
    expect(merged.updatedBy).toBe("ceo");
  });

  it("keeps orchestration metadata canonical across normalize and merge", () => {
    const normalized = normalizeProjectMemory({
      currentGoal: "交付 founder workflow",
      orchestrationMode: "main_agent",
      orchestrationOwnerRoleId: "product",
      orchestrationVerificationStatus: "pending"
    });

    expect(normalized.orchestrationMode).toBe("main_agent");
    expect(normalized.orchestrationOwnerRoleId).toBe("product");
    expect(normalized.orchestrationVerificationStatus).toBe("pending");

    const merged = mergeProjectMemory(normalized, {
      latestSummary: "主 Agent 已收敛 PRD 结果",
      orchestrationVerificationStatus: "verified"
    });

    expect(merged.orchestrationMode).toBe("main_agent");
    expect(merged.orchestrationOwnerRoleId).toBe("product");
    expect(merged.orchestrationVerificationStatus).toBe("verified");
  });

  it("extracts artifact files with the same harness-safe filters for all callers", () => {
    const files = extractArtifactFilesFromText(
      [
        "CHANGED_FILES: src/app.ts tmp/cache.md -bad.mjs docs/plan.md",
        "Output: .data/private.json apps/control-center/index.tsx"
      ].join("\n")
    );

    expect(files).toEqual(["apps/control-center/index.tsx", "docs/plan.md", "src/app.ts"]);
  });

  it("collects task, metadata and tool-run artifacts through one shared path", () => {
    const task = buildTask({
      metadata: {
        toolChangedFiles: ["CHANGED_FILES: docs/spec.md"]
      },
      result: {
        summary: "实现完成",
        deliverable: "产物：`services/api.ts`",
        citations: [],
        followUps: []
      }
    });
    const toolRun = buildToolRun({
      outputText: "changed packages/shared/src/project-memory.ts"
    });

    expect(collectProjectMemoryArtifactsFromTask(task, [toolRun])).toEqual([
      "docs/spec.md",
      "packages/shared/src/project-memory.ts",
      "services/api.ts"
    ]);
  });

  it("builds canonical task memory updates with orchestration metadata", () => {
    const update = buildProjectMemoryUpdateFromTask(
      buildTask({
        result: {
          summary: "主 Agent 已完成交付",
          deliverable: "CHANGED_FILES: docs/result.md",
          citations: [],
          followUps: ["进入发布准备"]
        }
      }),
      {
        currentStage: "collaboration_delivered",
        orchestrationMode: "main_agent",
        orchestrationOwnerRoleId: "cto",
        orchestrationVerificationStatus: "verified"
      }
    );

    expect(update.currentGoal).toBe("交付协作项目");
    expect(update.currentStage).toBe("collaboration_delivered");
    expect(update.latestArtifacts).toEqual(["docs/result.md"]);
    expect(update.nextActions).toEqual(["进入发布准备"]);
    expect(update.orchestrationMode).toBe("main_agent");
    expect(update.orchestrationOwnerRoleId).toBe("cto");
    expect(update.orchestrationVerificationStatus).toBe("verified");
  });
});

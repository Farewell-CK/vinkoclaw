import { describe, expect, it } from "vitest";
import type { TaskRecord } from "@vinko/shared";
import {
  buildRoleAwareInstruction,
  extractArtifactFilesFromText,
  resolveGoalRunHandoffNextActions,
  resolveFounderWorkflowNextSpec,
  resolveSkillIntegrationCompletion
} from "./worker.js";

function buildTask(patch: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task_worker_1",
    source: "system",
    roleId: "engineering",
    title: "接入 skill runtime",
    instruction: "请接入这个 skill",
    status: "queued",
    priority: 90,
    metadata: {},
    createdAt: "2026-04-13T00:00:00.000Z",
    updatedAt: "2026-04-13T00:00:00.000Z",
    ...patch
  };
}

describe("buildRoleAwareInstruction", () => {
  it("injects skill runtime integration constraints for engineering tasks", () => {
    const instruction = buildRoleAwareInstruction(
      buildTask({
        metadata: {
          workflowLabel: "Skill Integration",
          workflowSuccessCriteria: ["skill definition 可被识别", "安装元数据齐全"],
          workflowCompletionSignal: "skill 可进入安装或 discover-only 验证",
          deliverableSections: ["接入方案", "技能定义", "代码改动"],
          requestedSkillId: "competitor-research-pro",
          requestedSkillName: "Competitor Research Pro",
          requestedSkillSourceLabel: "community-registry",
          requestedSkillSourceUrl: "https://example.com/skills/competitor-research-pro",
          requestedSkillVersion: "0.3.1",
          requestedSkillTargetRoleId: "research"
        }
      })
    );

    expect(instruction).toContain("交付结构要求");
    expect(instruction).toContain("工作流交付契约");
    expect(instruction).toContain("Skill Integration");
    expect(instruction).toContain("技能接入执行约束");
    expect(instruction).toContain("competitor-research-pro");
    expect(instruction).toContain("community-registry");
    expect(instruction).toContain("research");
    expect(instruction).toContain("补充或更新测试");
  });

  it("preserves prd-writer skill contract for product tasks", () => {
    const instruction = buildRoleAwareInstruction(
      buildTask({
        roleId: "product",
        title: "写 PRD",
        instruction: "请写一个 PRD",
        metadata: {
          deliverableSections: ["背景", "目标用户", "需求范围"]
        }
      }),
      ["prd-writer"]
    );

    expect(instruction).toContain("技能执行约束(PRD Writer)");
    expect(instruction).toContain("结构化 PRD");
    expect(instruction).toContain("待确认项不能为空");
  });


  it("applies verifier-only contract when verifierOnly metadata is enabled", () => {
    const instruction = buildRoleAwareInstruction(
      buildTask({
        roleId: "qa",
        instruction: "请验证这个实现",
        metadata: {
          verifierOnly: true,
          deliverableSections: ["测试范围", "验证结论"]
        }
      })
    );

    expect(instruction).toContain("验证者约束");
    expect(instruction).toContain("只负责验证");
    expect(instruction).toContain("不要继续产出下一阶段主交付");
  });
  it("marks completed known skill integrations as local_installable", () => {
    const outcome = resolveSkillIntegrationCompletion(
      buildTask({
        status: "completed",
        metadata: {
          requestedSkillId: "prd-writer",
          requestedSkillName: "PRD Writer",
          requestedSkillTargetRoleId: "product"
        }
      })
    );

    expect(outcome?.requestedSkillId).toBe("prd-writer");
    expect(outcome?.runtimeAvailable).toBe(true);
    expect(outcome?.installState).toBe("local_installable");
    expect(outcome?.installedRole).toBe("product");
  });

  it("marks completed unknown skill integrations as discover_only", () => {
    const outcome = resolveSkillIntegrationCompletion(
      buildTask({
        status: "completed",
        metadata: {
          requestedSkillId: "competitor-research-pro",
          requestedSkillName: "Competitor Research Pro",
          requestedSkillTargetRoleId: "research"
        }
      })
    );

    expect(outcome?.requestedSkillId).toBe("competitor-research-pro");
    expect(outcome?.runtimeAvailable).toBe(false);
    expect(outcome?.installState).toBe("discover_only");
    expect(outcome?.installedRole).toBe("research");
  });

  it("builds founder delivery implementation follow-up after PRD", () => {
    const spec = resolveFounderWorkflowNextSpec(
      buildTask({
        roleId: "product",
        status: "completed",
        title: "Founder Delivery / PRD: 官网改版",
        instruction: "请沉淀官网改版 PRD",
        metadata: {
          founderWorkflowKind: "founder_delivery",
          founderWorkflowStage: "prd",
          founderWorkflowOriginalInstruction: "做一个官网首页并完成交付"
        },
        result: {
          summary: "已完成官网改版 PRD",
          deliverable: "产物文件：docs/prd-homepage.md",
          citations: [],
          followUps: []
        }
      })
    );

    expect(spec?.nextStage).toBe("implementation");
    expect(spec?.deliverableMode).toBe("artifact_required");
    expect(spec?.deliverableSections).toEqual(["变更文件", "实现说明", "启动命令", "验证结果", "剩余风险"]);
    expect(spec?.workflowLabel).toBe("Delivery Workflow / Build");
    expect(spec?.completionSignal).toBe("实现交付可进入 QA 验证");
    expect(spec?.instruction).toContain("PRD 摘要");
    expect(spec?.instruction).toContain("合理默认假设继续推进");
    expect(spec?.instruction).toContain("React + TypeScript + Vite");
  });


  it("marks founder QA stage as verifier-only", () => {
    const spec = resolveFounderWorkflowNextSpec(
      buildTask({
        roleId: "engineering",
        status: "completed",
        metadata: {
          founderWorkflowKind: "founder_delivery",
          founderWorkflowStage: "implementation",
          founderWorkflowOriginalInstruction: "做一个创业项目 landing page"
        },
        result: {
          summary: "实现完成",
          deliverable: "产物文件：apps/site/index.html",
          citations: [],
          followUps: []
        }
      })
    );

    expect(spec?.nextStage).toBe("qa");
    expect(spec?.roleId).toBe("qa");
    expect(spec?.workflowLabel).toBe("Delivery Workflow / QA");
    expect(spec?.verifierOnly).toBe(true);
  });
  it("builds founder delivery recap follow-up after QA", () => {
    const spec = resolveFounderWorkflowNextSpec(
      buildTask({
        roleId: "qa",
        status: "completed",
        metadata: {
          founderWorkflowKind: "founder_delivery",
          founderWorkflowStage: "qa",
          founderWorkflowOriginalInstruction: "完成一个创业项目 landing page"
        },
        result: {
          summary: "验证通过，仍有少量待优化项",
          deliverable: "产物文件：docs/qa-landing-page.md",
          citations: [],
          followUps: []
        }
      })
    );

    expect(spec?.nextStage).toBe("recap");
    expect(spec?.roleId).toBe("operations");
    expect(spec?.deliverableSections).toEqual(["阶段结论", "已完成事项", "关键进展", "阻塞问题", "下一步", "待决策项"]);
    expect(spec?.workflowLabel).toBe("Delivery Workflow / Recap");
    expect(spec?.completionSignal).toBe("创始人可直接消费 recap 并推进下一轮动作");
    expect(spec?.verifierOnly).toBe(false);
  });

  it("filters ignored and malformed artifact paths from text", () => {
    const files = extractArtifactFilesFromText(
      [
        "CHANGED_FILES: src/app.ts tmp/openclaw/cache.md -classifier.mjs docs/prd.md",
        "Artifacts: tmp/debug.md scripts/build.mjs"
      ].join("\n")
    );

    expect(files).toEqual(["docs/prd.md", "scripts/build.mjs", "src/app.ts"]);
  });

  it("prefers explicit next actions for goal-run handoff generation", () => {
    const nextActions = resolveGoalRunHandoffNextActions({
      nextActions: ["accept release", "run smoke test", "accept release"],
      task: {
        result: {
          summary: "done",
          deliverable: "deliverable",
          citations: [],
          followUps: ["should not win"]
        }
      },
      runContext: {
        next_actions: ["context fallback"]
      }
    });

    expect(nextActions).toEqual(["accept release", "run smoke test"]);
  });
});

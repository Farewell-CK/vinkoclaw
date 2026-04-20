import { describe, expect, it } from "vitest";
import { buildGoalRunProgressMessage, buildGoalRunStatusMessage, buildGoalRunWorkflowSummary } from "./goal-run-summary.js";
import type { GoalRunRecord, TaskRecord } from "./types.js";

function buildGoalRun(patch: Partial<GoalRunRecord> = {}): GoalRunRecord {
  return {
    id: "goal_12345678",
    source: "feishu",
    objective: "交付 founder 周报",
    status: "awaiting_input",
    currentStage: "discover",
    language: "zh-CN",
    metadata: {
      workflowLabel: "Founder Weekly Recap",
      workflowSuccessCriteria: ["产出结构化 recap", "包含关键经营指标"],
      workflowCompletionSignal: "Founder 可直接审阅并推进下周行动"
    },
    context: {
      last_artifact_files: ["reports/weekly-recap.md"]
    },
    plan: {
      acceptance: ["形成可复用周报模板"]
    },
    retryCount: 0,
    maxRetries: 2,
    awaitingInputFields: ["本周转化率", "新增线索数"],
    awaitingInputPrompt: "请补充本周转化率和新增线索数。",
    createdAt: "2026-04-19T00:00:00.000Z",
    updatedAt: "2026-04-19T00:00:00.000Z",
    ...patch
  };
}

function buildTask(patch: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task_1",
    source: "feishu",
    roleId: "ceo",
    title: "recap",
    instruction: "build recap",
    status: "running",
    priority: 90,
    metadata: {},
    createdAt: "2026-04-19T00:00:00.000Z",
    updatedAt: "2026-04-19T00:00:00.000Z",
    ...patch
  };
}

describe("goal-run-summary", () => {
  it("builds workflow summary from goal run state and handoff artifacts", () => {
    const run = buildGoalRun();
    const summary = buildGoalRunWorkflowSummary(run, {
      latestHandoff: {
        id: "handoff_1",
        artifact: {
          summary: "已沉淀周报框架",
          nextActions: ["补齐经营指标", "进入最终排版"],
          unresolvedQuestions: ["确认本周转化率"],
          artifacts: ["reports/weekly-recap.md", "reports/weekly-recap.html"]
        }
      },
      currentTask: buildTask({
        metadata: {
          workflowLabel: "Founder Weekly Recap"
        }
      }),
      projectMemory: {
        nextActions: ["同步给 founder"],
        latestArtifacts: ["reports/archive/week-15.md"]
      }
    });

    expect(summary).toContain("**工作流**：Founder Weekly Recap");
    expect(summary).toContain("**目标**：交付 founder 周报");
    expect(summary).toContain("**当前阶段**：信息澄清 · 待补充");
    expect(summary).toContain("**下一步**：补齐经营指标；进入最终排版");
    expect(summary).toContain("**待补充**：本周转化率；新增线索数；确认本周转化率");
    expect(summary).toContain("**成功标准**：产出结构化 recap；包含关键经营指标；形成可复用周报模板");
    expect(summary).toContain("**完成信号**：Founder 可直接审阅并推进下周行动");
    expect(summary).toContain("**最近产物**：reports/weekly-recap.md；reports/weekly-recap.html；reports/archive/week-15.md");
    expect(summary).toContain("**最近交接**：已沉淀周报框架");
  });

  it("builds user-facing status and progress messages", () => {
    const run = buildGoalRun({
      status: "running",
      currentStage: "execute",
      awaitingInputFields: []
    });
    const statusMessage = buildGoalRunStatusMessage(run);
    const progressMessage = buildGoalRunProgressMessage(run, "已进入执行阶段，正在生成交付内容。");

    expect(statusMessage).toContain("目标 goal_123 正在推进中。");
    expect(statusMessage).toContain("**当前阶段**：执行交付 · 进行中");
    expect(progressMessage).toContain("已进入执行阶段，正在生成交付内容。");
    expect(progressMessage).toContain("**工作流**：Founder Weekly Recap");
  });
});

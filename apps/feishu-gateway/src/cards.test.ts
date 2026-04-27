import { describe, expect, it } from "vitest";
import {
  buildCollaborationAwaitUserCard,
  buildCollaborationCompletedCard,
  buildCollaborationPartialCard,
  buildCollaborationStartedCard,
  buildGoalRunBlockedCard,
  buildGoalRunCompletedCard,
  buildGoalRunFailedCard,
  buildGoalRunProgressCard,
  buildSessionWorkbenchCard
} from "./cards.js";

describe("feishu goal-run cards", () => {
  it("builds progress and blocked cards", () => {
    const progress = buildGoalRunProgressCard({
      title: "GoalRun · goal_1234",
      statusLabel: "execute · running",
      summary: "已进入执行阶段",
      workflowSummary: "**下一步**：继续产出可验证文件"
    });
    const blocked = buildGoalRunBlockedCard({
      title: "GoalRun · goal_1234",
      status: "awaiting_authorization",
      statusLabel: "deploy · awaiting_authorization",
      reason: "等待授权后继续部署",
      workflowSummary: "**待补充**：deploy token"
    });

    expect(progress.schema).toBe("2.0");
    expect(blocked.schema).toBe("2.0");
    expect(JSON.stringify(progress)).toContain("execute · running");
    expect(JSON.stringify(blocked)).toContain("awaiting_authorization");
  });

  it("builds completed and failed cards", () => {
    const completed = buildGoalRunCompletedCard({
      title: "GoalRun · goal_done",
      summary: "目标已完成",
      workflowSummary: "**最近产物**：reports/final.md"
    });
    const failed = buildGoalRunFailedCard({
      title: "GoalRun · goal_fail",
      reason: "执行失败：缺少凭据",
      workflowSummary: "**阻塞**：credential.deploy.vercel.api_token"
    });

    expect(completed.schema).toBe("2.0");
    expect(failed.schema).toBe("2.0");
    expect(JSON.stringify(completed)).toContain("reports/final.md");
    expect(JSON.stringify(failed)).toContain("缺少凭据");
  });

  it("builds collaboration status cards", () => {
    const started = buildCollaborationStartedCard({
      title: "团队协作 · collab_1",
      statusLabel: "进行中",
      summary: "已启动多角色协作",
      participants: ["产品经理", "后端", "测试"],
      workflowSummary: "**目标**：交付首版 MVP",
      nextActions: ["等待各角色执行并收敛汇总"]
    });
    const awaitUser = buildCollaborationAwaitUserCard({
      title: "团队协作 · collab_1",
      statusLabel: "等待补充",
      summary: "缺少目标用户画像",
      participants: ["产品经理", "后端"],
      nextActions: ["请补充目标用户画像"]
    });
    const partial = buildCollaborationPartialCard({
      title: "团队协作 · collab_1",
      statusLabel: "部分交付",
      summary: "已输出可用部分结果",
      nextActions: ["查看已交付部分并决定是否继续"]
    });
    const completed = buildCollaborationCompletedCard({
      title: "团队协作 · collab_1",
      statusLabel: "已完成",
      summary: "完整协作结果已生成",
      workflowSummary: "**最近产物**：docs/collab-report.md"
    });

    expect(started.schema).toBe("2.0");
    expect(awaitUser.schema).toBe("2.0");
    expect(partial.schema).toBe("2.0");
    expect(completed.schema).toBe("2.0");
    expect(JSON.stringify(started)).toContain("产品经理");
    expect(JSON.stringify(awaitUser)).toContain("目标用户画像");
    expect(JSON.stringify(partial)).toContain("部分交付");
    expect(JSON.stringify(completed)).toContain("docs/collab-report.md");
  });

  it("builds a session workbench card", () => {
    const card = buildSessionWorkbenchCard({
      snapshot: {
        sessionId: "session_1",
        sessionTitle: "Feishu oc_xxx",
        source: "feishu",
        generatedAt: "2026-04-23T00:00:00.000Z",
        currentGoal: "交付创业项目首版",
        currentStage: "execute",
        latestSummary: "已经进入实现阶段",
        blockers: ["待确认部署授权"],
        pendingDecisions: ["是否先上线内测版"],
        nextActions: ["继续完成首页和注册流程"],
        latestArtifacts: ["docs/spec.md"],
        activeTask: {
          id: "task_1",
          title: "实现首页和注册流程",
          status: "running",
          roleId: "frontend",
          workflowSummary: "**工作流**：Founder Delivery"
        },
        activeGoalRun: {
          id: "goal_1",
          stage: "execute",
          status: "running",
          objective: "完成创业项目首版交付"
        },
        pendingApproval: {
          id: "approval_1",
          summary: "需要确认部署授权",
          status: "pending"
        }
      }
    });

    expect(card.schema).toBe("2.0");
    expect(JSON.stringify(card)).toContain("session_workbench");
    expect(JSON.stringify(card)).toContain("刷新状态");
    expect(JSON.stringify(card)).toContain("继续推进");
    expect(JSON.stringify(card)).toContain("实现首页和注册流程");
  });
});

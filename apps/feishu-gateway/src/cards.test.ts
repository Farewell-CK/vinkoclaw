import { describe, expect, it } from "vitest";
import {
  buildGoalRunBlockedCard,
  buildGoalRunCompletedCard,
  buildGoalRunFailedCard,
  buildGoalRunProgressCard
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
});

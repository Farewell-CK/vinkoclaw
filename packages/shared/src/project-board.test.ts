import { describe, expect, it } from "vitest";
import { buildProjectBoardSnapshot } from "./project-board.js";
import type { SessionRecord, TaskRecord } from "./types.js";

function buildSession(patch: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "session_1",
    source: "control-center",
    sourceKey: "session_1",
    title: "Founder Session",
    status: "active",
    metadata: {},
    createdAt: "2026-04-19T00:00:00.000Z",
    updatedAt: "2026-04-19T00:00:00.000Z",
    lastMessageAt: "2026-04-19T00:00:00.000Z",
    ...patch
  };
}

function buildTask(patch: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task_1",
    sessionId: "session_1",
    source: "control-center",
    roleId: "product",
    title: "推进 founder workflow",
    instruction: "continue",
    status: "queued",
    priority: 80,
    metadata: {},
    createdAt: "2026-04-19T00:00:00.000Z",
    updatedAt: "2026-04-19T00:00:00.000Z",
    ...patch
  };
}

describe("project-board", () => {
  it("counts paused_input tasks as awaiting input", () => {
    const snapshot = buildProjectBoardSnapshot({
      sessions: [
        buildSession({
          metadata: {
            projectMemory: {
              currentGoal: "交付 founder 闭环",
              currentStage: "delivery",
              latestSummary: "waiting on clarification",
              updatedAt: "2026-04-19T01:00:00.000Z",
              updatedBy: "product"
            }
          }
        })
      ],
      tasks: [
        buildTask({
          id: "task_paused",
          status: "paused_input",
          title: "确认技术选型",
          pendingInput: {
            question: "请确认是做 Web 还是小程序",
            pausedAt: "2026-04-19T01:10:00.000Z"
          }
        })
      ],
      roleBindingsByRole: {}
    });

    expect(snapshot.summary.awaitingInputTasks).toBe(1);
    expect(snapshot.blockers).toContain("确认技术选型");
  });

  it("falls back to project memory orchestration metadata when orchestration task is absent", () => {
    const snapshot = buildProjectBoardSnapshot({
      sessions: [
        buildSession({
          metadata: {
            projectMemory: {
              currentGoal: "完成主 Agent 交付",
              currentStage: "implementation",
              latestSummary: "主 Agent 正在推进实现",
              updatedAt: "2026-04-19T01:00:00.000Z",
              updatedBy: "product",
              orchestrationMode: "main_agent",
              orchestrationOwnerRoleId: "product",
              orchestrationVerificationStatus: "pending"
            }
          }
        })
      ],
      tasks: [],
      roleBindingsByRole: {}
    });

    expect(snapshot.primary?.orchestrationMode).toBe("main_agent");
    expect(snapshot.primary?.orchestrationOwnerRoleId).toBe("product");
    expect(snapshot.primary?.orchestrationVerificationStatus).toBe("pending");
  });
});

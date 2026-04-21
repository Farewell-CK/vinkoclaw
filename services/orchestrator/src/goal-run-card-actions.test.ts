import { describe, expect, it, vi } from "vitest";
import type { GoalRunRecord, VinkoStore } from "@vinko/shared";
import { buildGoalRunCardActionFeedback, parseGoalRunCardActionPayload } from "./goal-run-card-actions.js";

function buildGoalRun(patch: Partial<GoalRunRecord> = {}): GoalRunRecord {
  return {
    id: "goal_1",
    source: "feishu",
    objective: "交付 founder 周报",
    status: "awaiting_authorization",
    currentStage: "deploy",
    language: "zh-CN",
    metadata: {},
    context: {},
    retryCount: 0,
    maxRetries: 2,
    awaitingInputFields: [],
    createdAt: "2026-04-19T00:00:00.000Z",
    updatedAt: "2026-04-19T00:00:00.000Z",
    ...patch
  };
}

describe("goal-run-card-actions", () => {
  it("parses goal-run action payloads", () => {
    expect(
      parseGoalRunCardActionPayload({
        kind: "goal_run_action",
        goalRunId: "goal_1",
        action: "status"
      })
    ).toEqual({
      kind: "goal_run_action",
      goalRunId: "goal_1",
      action: "status"
    });
    expect(parseGoalRunCardActionPayload({ kind: "task_feedback" })).toBeUndefined();
  });

  it("builds authorization hint card for awaiting authorization runs", () => {
    const run = buildGoalRun();
    const store = {
      getLatestGoalRunHandoff: vi.fn(() => undefined),
      getTask: vi.fn(() => undefined),
      getSession: vi.fn(() => undefined)
    } as unknown as VinkoStore;

    const card = buildGoalRunCardActionFeedback({
      store,
      run,
      action: "authorization_hint"
    });

    expect(card).toMatchObject({
      schema: "2.0"
    });
    expect(JSON.stringify(card)).toContain("/api/goal-runs/goal_1/authorize");
  });
});

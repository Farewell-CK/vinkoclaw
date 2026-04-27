import { describe, expect, it, vi } from "vitest";
import type { GoalRunRecord, TaskRecord, VinkoStore } from "@vinko/shared";
import {
  buildGoalRunStatusCard,
  buildTaskStatusCard,
  parseSessionWorkbenchCardActionPayload
} from "./session-workbench-card-actions.js";

function buildTask(patch: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task_1",
    sessionId: "session_1",
    source: "feishu",
    roleId: "frontend",
    title: "实现首页",
    instruction: "实现首页",
    status: "running",
    priority: 80,
    metadata: {},
    createdAt: "2026-04-23T00:00:00.000Z",
    updatedAt: "2026-04-23T00:00:00.000Z",
    ...patch
  };
}

function buildGoalRun(patch: Partial<GoalRunRecord> = {}): GoalRunRecord {
  return {
    id: "goal_1",
    source: "feishu",
    objective: "交付首版",
    status: "running",
    currentStage: "execute",
    language: "zh",
    metadata: {},
    context: {},
    retryCount: 0,
    maxRetries: 2,
    awaitingInputFields: [],
    createdAt: "2026-04-23T00:00:00.000Z",
    updatedAt: "2026-04-23T00:00:00.000Z",
    sessionId: "session_1",
    ...patch
  };
}

describe("session-workbench-card-actions", () => {
  it("parses session workbench card action payload", () => {
    expect(
      parseSessionWorkbenchCardActionPayload({
        kind: "session_workbench",
        sessionId: "session_1",
        action: "task_status",
        taskId: "task_1"
      })
    ).toEqual({
      kind: "session_workbench",
      sessionId: "session_1",
      action: "task_status",
      taskId: "task_1"
    });
    expect(
      parseSessionWorkbenchCardActionPayload({
        kind: "session_workbench",
        sessionId: "session_1",
        action: "continue"
      })
    ).toEqual({
      kind: "session_workbench",
      sessionId: "session_1",
      action: "continue"
    });
  });

  it("builds task status card", () => {
    const card = buildTaskStatusCard(buildTask());
    expect(card).toMatchObject({ schema: "2.0" });
    expect(JSON.stringify(card)).toContain("实现首页");
  });

  it("builds goal-run status card", () => {
    const store = {
      getSession: vi.fn(() => undefined),
      getTask: vi.fn(() => undefined),
      getLatestGoalRunHandoff: vi.fn(() => undefined)
    } as unknown as VinkoStore;
    const card = buildGoalRunStatusCard(store, buildGoalRun());
    expect(card).toMatchObject({ schema: "2.0" });
    expect(JSON.stringify(card)).toContain("GoalRun");
  });
});

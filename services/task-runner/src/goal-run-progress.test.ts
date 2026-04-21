import { describe, expect, it, vi } from "vitest";
import type { GoalRunRecord } from "@vinko/shared";
import { notifyGoalRunProgressSafely } from "./goal-run-progress.js";

function createGoalRun(overrides?: Partial<GoalRunRecord>): GoalRunRecord {
  const now = new Date().toISOString();
  return {
    id: "goal-run-1",
    source: "feishu",
    objective: "build company website",
    status: "running",
    currentStage: "execute",
    requestedBy: "owner",
    chatId: "oc_1234567890abcdefghijklmn",
    sessionId: "session-1",
    language: "zh",
    metadata: {},
    context: {},
    retryCount: 0,
    maxRetries: 2,
    awaitingInputFields: [],
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    ...overrides
  };
}

describe("notifyGoalRunProgressSafely", () => {
  it("returns false for non-feishu sources without notifying", async () => {
    const run = createGoalRun({ source: "system", chatId: undefined });
    const notifier = vi.fn(async (_chatId: string, _message: string) => undefined);
    const appendAuditEvent = vi.fn();

    const sent = await notifyGoalRunProgressSafely({
      run,
      message: "test",
      notifyFeishu: notifier,
      audit: { appendAuditEvent }
    });

    expect(sent).toBe(false);
    expect(notifier).not.toHaveBeenCalled();
    expect(appendAuditEvent).not.toHaveBeenCalled();
  });

  it("returns true when Feishu notification succeeds", async () => {
    const run = createGoalRun({
      metadata: {
        workflowLabel: "Founder Delivery / Build",
        workflowSuccessCriteria: ["产出代码与验证结果"],
        workflowCompletionSignal: "可进入 QA 验证"
      }
    });
    const notifier = vi.fn(async (_chatId: string, _message: string) => undefined);
    const cardNotifier = vi.fn(async (_chatId: string, _card: Record<string, unknown>) => undefined);
    const appendAuditEvent = vi.fn();

    const sent = await notifyGoalRunProgressSafely({
      run,
      message: "progress",
      notifyFeishu: notifier,
      notifyFeishuCard: cardNotifier,
      audit: { appendAuditEvent }
    });

    expect(sent).toBe(true);
    expect(notifier).not.toHaveBeenCalled();
    expect(cardNotifier).toHaveBeenCalledWith(
      run.chatId,
      expect.objectContaining({
        schema: "2.0"
      })
    );
    expect(JSON.stringify(cardNotifier.mock.calls[0]?.[1] ?? {})).toContain("\"kind\":\"goal_run_action\"");
    expect(appendAuditEvent).not.toHaveBeenCalled();
  });

  it("swallows Feishu errors and records an audit event", async () => {
    const run = createGoalRun({ id: "goal-run-fail", currentStage: "verify" });
    const notifier = vi.fn(async () => {
      throw new Error("Feishu send failed with 400: invalid receive_id");
    });
    const appendAuditEvent = vi.fn();
    const cardNotifier = vi.fn(async () => {
      throw new Error("Feishu send failed with 400: invalid receive_id");
    });

    const sent = await notifyGoalRunProgressSafely({
      run,
      message: "verify in progress",
      notifyFeishu: notifier,
      notifyFeishuCard: cardNotifier,
      audit: { appendAuditEvent }
    });

    expect(sent).toBe(false);
    expect(cardNotifier).toHaveBeenCalledWith(
      run.chatId,
      expect.objectContaining({
        schema: "2.0"
      })
    );
    expect(appendAuditEvent).toHaveBeenCalledTimes(1);
    expect(appendAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "feishu",
        entityType: "goal_run",
        entityId: "goal-run-fail",
        message: "Failed to send GoalRun progress to Feishu",
        payload: expect.objectContaining({
          stage: "verify",
          error: expect.stringContaining("invalid receive_id")
        })
      })
    );
  });
});

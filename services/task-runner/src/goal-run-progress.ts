import { createLogger, type GoalRunRecord } from "@vinko/shared";

const logger = createLogger("goal-run-progress");

export type GoalRunProgressNotifier = (chatId: string, message: string) => Promise<void>;

export type GoalRunProgressAuditSink = {
  appendAuditEvent: (input: {
    category: string;
    entityType: string;
    entityId: string;
    message: string;
    payload?: Record<string, unknown>;
  }) => unknown;
};

export async function notifyGoalRunProgressSafely(input: {
  run: GoalRunRecord;
  message: string;
  notifyFeishu: GoalRunProgressNotifier;
  audit: GoalRunProgressAuditSink;
}): Promise<boolean> {
  const { run, message, notifyFeishu, audit } = input;
  if (run.source !== "feishu" || !run.chatId) {
    return false;
  }
  try {
    await notifyFeishu(run.chatId, message);
    return true;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    audit.appendAuditEvent({
      category: "feishu",
      entityType: "goal_run",
      entityId: run.id,
      message: "Failed to send GoalRun progress to Feishu",
      payload: {
        chatId: run.chatId,
        stage: run.currentStage,
        error: errorMessage
      }
    });
    logger.error("goal run progress notification failed", error, {
      goalRunId: run.id,
      stage: run.currentStage,
      chatId: run.chatId
    });
    return false;
  }
}

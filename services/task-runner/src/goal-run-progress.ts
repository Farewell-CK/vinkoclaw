import {
  buildGoalRunProgressMessage,
  summarizeGoalRun,
  buildGoalRunWorkflowSummary,
  createLogger,
  type GoalRunRecord,
  type TaskRecord
} from "@vinko/shared";
import {
  buildGoalRunBlockedCard,
  buildGoalRunCompletedCard,
  buildGoalRunFailedCard,
  buildGoalRunProgressCard
} from "@vinko/feishu-gateway";

const logger = createLogger("goal-run-progress");

export type GoalRunProgressNotifier = (chatId: string, message: string) => Promise<void>;
export type GoalRunProgressCardNotifier = (chatId: string, card: Record<string, unknown>) => Promise<void>;

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
  notifyFeishuCard?: GoalRunProgressCardNotifier | undefined;
  audit: GoalRunProgressAuditSink;
  artifacts?: {
    latestHandoff?: {
      id: string;
      artifact?: {
        summary?: string | undefined;
        nextActions?: string[] | undefined;
        unresolvedQuestions?: string[] | undefined;
        approvalNeeds?: string[] | undefined;
        artifacts?: string[] | undefined;
      } | undefined;
    } | undefined;
    currentTask?: Pick<TaskRecord, "id" | "status" | "metadata"> | undefined;
    projectMemory?: Record<string, unknown> | undefined;
  } | undefined;
}): Promise<boolean> {
  const { run, message, notifyFeishu, notifyFeishuCard, audit, artifacts } = input;
  if (run.source !== "feishu" || !run.chatId) {
    return false;
  }
  const renderedMessage = buildGoalRunProgressMessage(run, message, artifacts);
  const workflowSummary = buildGoalRunWorkflowSummary(run, artifacts);
  const goalRunSummary = summarizeGoalRun(run, artifacts);
  const title = `GoalRun · ${run.id.slice(0, 8)}`;
  const statusLabel = `${run.currentStage} · ${run.status}`;
  const baseActions = [
    {
      label: "查看状态",
      value: {
        kind: "goal_run_action",
        goalRunId: run.id,
        action: "status"
      },
      type: "default" as const
    },
    {
      label: run.status === "awaiting_authorization" ? "授权指引" : "继续推进",
      value: {
        kind: "goal_run_action",
        goalRunId: run.id,
        action: run.status === "awaiting_authorization" ? "authorization_hint" : "resume_hint"
      },
      type: "primary" as const
    }
  ];
  try {
    if (notifyFeishuCard) {
      const card =
        run.status === "completed"
          ? buildGoalRunCompletedCard({
              title,
              summary: renderedMessage,
              workflowSummary
            })
          : run.status === "failed"
            ? buildGoalRunFailedCard({
                title,
                reason: renderedMessage,
                workflowSummary
              })
            : run.status === "awaiting_input" || run.status === "awaiting_authorization"
            ? buildGoalRunBlockedCard({
                title,
                status: run.status,
                statusLabel,
                reason: renderedMessage,
                workflowSummary,
                nextActions: goalRunSummary.pendingItems.length > 0 ? goalRunSummary.pendingItems : [goalRunSummary.nextStep],
                actions: baseActions
              })
              : buildGoalRunProgressCard({
                  title,
                  statusLabel,
                  summary: renderedMessage,
                  workflowSummary,
                  nextActions: [goalRunSummary.nextStep],
                  actions: baseActions
                });
      await notifyFeishuCard(run.chatId, card);
    } else {
      await notifyFeishu(run.chatId, renderedMessage);
    }
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

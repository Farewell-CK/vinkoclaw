import { buildGoalRunStatusMessage, type GoalRunRecord, type VinkoStore } from "@vinko/shared";
import {
  buildGoalRunBlockedCard,
  buildGoalRunCompletedCard,
  buildGoalRunFailedCard,
  buildGoalRunProgressCard
} from "@vinko/feishu-gateway";

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export interface GoalRunCardActionPayload {
  kind: "goal_run_action";
  goalRunId: string;
  action: "status" | "resume_hint" | "authorization_hint";
}

export function parseGoalRunCardActionPayload(value: Record<string, unknown>): GoalRunCardActionPayload | undefined {
  const kind = clean(value.kind);
  if (kind !== "goal_run_action") {
    return undefined;
  }
  const goalRunId = clean(value.goalRunId);
  const action = clean(value.action);
  if (!goalRunId) {
    return undefined;
  }
  if (action !== "status" && action !== "resume_hint" && action !== "authorization_hint") {
    return undefined;
  }
  return {
    kind: "goal_run_action",
    goalRunId,
    action
  };
}

export function buildGoalRunCardActionFeedback(input: {
  store: VinkoStore;
  run: GoalRunRecord;
  action: GoalRunCardActionPayload["action"];
}): Record<string, unknown> {
  const session = input.run.sessionId && typeof input.store.getSession === "function" ? input.store.getSession(input.run.sessionId) : undefined;
  const projectMemory =
    typeof session?.metadata?.projectMemory === "object" && session.metadata.projectMemory !== null
      ? (session.metadata.projectMemory as Record<string, unknown>)
      : undefined;
  const currentTask = input.run.currentTaskId && typeof input.store.getTask === "function" ? input.store.getTask(input.run.currentTaskId) : undefined;
  const latestHandoff = input.store.getLatestGoalRunHandoff(input.run.id);
  const workflowSummary = buildGoalRunStatusMessage(input.run, {
    currentTask,
    latestHandoff,
    projectMemory
  });
  const title = `GoalRun · ${input.run.id.slice(0, 8)}`;
  const statusLabel = `${input.run.currentStage} · ${input.run.status}`;

  if (input.action === "authorization_hint") {
    const message =
      input.run.status === "awaiting_authorization"
        ? `当前需要授权后继续执行。请在控制台打开 GoalRun ${input.run.id.slice(0, 8)}，或调用 /api/goal-runs/${input.run.id}/authorize 提交 token。`
        : "当前不在授权等待态，无需提交授权。";
    return buildGoalRunBlockedCard({
      title,
      statusLabel,
      reason: message,
      workflowSummary
    });
  }

  if (input.action === "resume_hint") {
    const message =
      input.run.status === "awaiting_input"
        ? `当前等待你补充信息。可直接在飞书回复缺失字段，或在控制台调用 /api/goal-runs/${input.run.id}/input。`
        : input.run.status === "awaiting_authorization"
          ? `当前等待授权。请在控制台完成授权后，GoalRun 会自动恢复。`
          : `GoalRun 当前状态是 ${input.run.status}，无需人工恢复，系统会继续推进。`;
    return buildGoalRunBlockedCard({
      title,
      statusLabel,
      reason: message,
      workflowSummary
    });
  }

  if (input.run.status === "completed") {
    return buildGoalRunCompletedCard({
      title,
      summary: workflowSummary,
      workflowSummary
    });
  }
  if (input.run.status === "failed") {
    return buildGoalRunFailedCard({
      title,
      reason: workflowSummary,
      workflowSummary
    });
  }
  if (input.run.status === "awaiting_input" || input.run.status === "awaiting_authorization") {
    return buildGoalRunBlockedCard({
      title,
      statusLabel,
      reason: workflowSummary,
      workflowSummary
    });
  }
  return buildGoalRunProgressCard({
    title,
    statusLabel,
    summary: workflowSummary,
    workflowSummary
  });
}

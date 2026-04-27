import {
  buildGoalRunStatusMessage,
  buildWorkflowStatusSummary,
  type GoalRunRecord,
  type TaskRecord,
  type VinkoStore
} from "@vinko/shared";
import {
  buildGoalRunBlockedCard,
  buildGoalRunCompletedCard,
  buildGoalRunFailedCard,
  buildGoalRunProgressCard,
  buildTaskCompletedCard,
  buildTaskFailedCard,
  buildTaskPausedCard,
  buildTaskQueuedCard
} from "@vinko/feishu-gateway";

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export interface SessionWorkbenchCardActionPayload {
  kind: "session_workbench";
  sessionId: string;
  action: "refresh" | "continue" | "task_status" | "goal_run_status";
  taskId?: string | undefined;
  goalRunId?: string | undefined;
}

export function parseSessionWorkbenchCardActionPayload(
  value: Record<string, unknown>
): SessionWorkbenchCardActionPayload | undefined {
  const kind = clean(value.kind);
  const sessionId = clean(value.sessionId);
  const action = clean(value.action);
  if (kind !== "session_workbench" || !sessionId) {
    return undefined;
  }
  if (action !== "refresh" && action !== "continue" && action !== "task_status" && action !== "goal_run_status") {
    return undefined;
  }
  const taskId = clean(value.taskId);
  const goalRunId = clean(value.goalRunId);
  return {
    kind: "session_workbench",
    sessionId,
    action,
    ...(taskId ? { taskId } : {}),
    ...(goalRunId ? { goalRunId } : {})
  };
}

const ROLE_LABELS: Record<string, string> = {
  ceo: "CEO",
  cto: "CTO",
  product: "产品经理",
  uiux: "UI/UX",
  frontend: "前端",
  backend: "后端",
  algorithm: "算法",
  qa: "测试",
  developer: "开发",
  engineering: "工程",
  research: "研究",
  operations: "运营"
};

export function buildTaskStatusCard(task: TaskRecord): Record<string, unknown> {
  const roleLabel = ROLE_LABELS[task.roleId] ?? task.roleId;
  const workflowSummary = buildWorkflowStatusSummary(task, { includeGoal: true, includeArtifacts: true });
  if (task.status === "completed") {
    return buildTaskCompletedCard({
      title: task.title,
      roleLabel,
      summary: task.result?.summary || "任务已完成。",
      workflowSummary
    });
  }
  if (task.status === "failed" || task.status === "cancelled") {
    return buildTaskFailedCard({
      title: task.title,
      roleLabel,
      reason: task.errorText || "任务已失败。",
      workflowSummary
    });
  }
  if (task.status === "paused_input") {
    return buildTaskPausedCard({
      title: task.title,
      roleLabel,
      question: task.pendingInput?.question || "任务等待你补充信息。",
      workflowSummary
    });
  }
  return buildTaskQueuedCard({
    title: task.title,
    roleLabel,
    workflowSummary
  });
}

export function buildGoalRunStatusCard(store: VinkoStore, run: GoalRunRecord): Record<string, unknown> {
  const session = run.sessionId ? store.getSession(run.sessionId) : undefined;
  const projectMemory =
    typeof session?.metadata?.projectMemory === "object" && session.metadata.projectMemory !== null
      ? (session.metadata.projectMemory as Record<string, unknown>)
      : undefined;
  const currentTask = run.currentTaskId ? store.getTask(run.currentTaskId) : undefined;
  const latestHandoff = store.getLatestGoalRunHandoff(run.id);
  const workflowSummary = buildGoalRunStatusMessage(run, {
    currentTask,
    latestHandoff,
    projectMemory
  });
  const title = `GoalRun · ${run.id.slice(0, 8)}`;
  const statusLabel = `${run.currentStage} · ${run.status}`;

  if (run.status === "completed") {
    return buildGoalRunCompletedCard({
      title,
      summary: workflowSummary,
      workflowSummary
    });
  }
  if (run.status === "failed" || run.status === "cancelled") {
    return buildGoalRunFailedCard({
      title,
      reason: workflowSummary,
      workflowSummary
    });
  }
  if (run.status === "awaiting_input" || run.status === "awaiting_authorization") {
    return buildGoalRunBlockedCard({
      title,
      status: run.status,
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

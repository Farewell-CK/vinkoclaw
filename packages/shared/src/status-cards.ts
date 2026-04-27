import type { GoalRunStatus, TaskStatus } from "./types.js";

export type StatusCardTemplate =
  | "green"
  | "red"
  | "orange"
  | "blue"
  | "indigo"
  | "grey"
  | "purple"
  | "yellow";

export interface StatusCardAction {
  label: string;
  value?: Record<string, unknown> | undefined;
  url?: string | undefined;
  type?: "primary" | "default" | "danger" | undefined;
}

export interface StatusCardSpec {
  eventType: string;
  title: string;
  template: StatusCardTemplate;
  statusLabel: string;
  summary: string;
  workflowSummary?: string | undefined;
  roleLabel?: string | undefined;
  participants?: string[] | undefined;
  nextActions?: string[] | undefined;
  actions?: StatusCardAction[] | undefined;
  footerNote?: string | undefined;
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function uniqueLines(values: unknown, limit = 4): string[] {
  if (!Array.isArray(values)) {
    return [];
  }
  return Array.from(
    new Set(
      values
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean)
    )
  ).slice(0, limit);
}

function taskStatusLabel(status: TaskStatus): string {
  switch (status) {
    case "queued":
      return "已接收";
    case "running":
      return "执行中";
    case "paused_input":
      return "等待补充";
    case "waiting_approval":
      return "等待审批";
    case "completed":
      return "已完成";
    case "failed":
      return "执行失败";
    case "cancelled":
      return "已取消";
    default:
      return status;
  }
}

function taskTemplate(status: TaskStatus): StatusCardTemplate {
  switch (status) {
    case "completed":
      return "green";
    case "failed":
    case "cancelled":
      return "red";
    case "paused_input":
    case "waiting_approval":
      return "orange";
    case "queued":
    case "running":
    default:
      return "blue";
  }
}

export interface TaskCompletedStatusCardSpecInput {
  title: string;
  roleLabel: string;
  summary: string;
  workflowSummary?: string | undefined;
  nextActions?: string[] | undefined;
  feedback?: { taskId: string; chatId: string } | undefined;
}

export function buildTaskCompletedStatusCardSpec(input: TaskCompletedStatusCardSpecInput): StatusCardSpec {
  const actions = input.feedback
    ? [
        {
          label: "👍 满意",
          type: "primary" as const,
          value: {
            kind: "task_feedback",
            taskId: input.feedback.taskId,
            chatId: input.feedback.chatId,
            rating: "good"
          }
        },
        {
          label: "👎 需改进",
          type: "danger" as const,
          value: {
            kind: "task_feedback",
            taskId: input.feedback.taskId,
            chatId: input.feedback.chatId,
            rating: "poor"
          }
        }
      ]
    : [];

  return {
    eventType: "task_completed",
    title: `✓ ${input.title}`,
    template: taskTemplate("completed"),
    statusLabel: taskStatusLabel("completed"),
    roleLabel: clean(input.roleLabel),
    summary: clean(input.summary),
    workflowSummary: clean(input.workflowSummary) || undefined,
    nextActions: uniqueLines(input.nextActions),
    actions,
    footerNote: "你可以直接回复“继续”，或选择一个下一步方向继续推进。"
  };
}

export interface TaskFailedStatusCardSpecInput {
  title: string;
  roleLabel: string;
  reason: string;
  workflowSummary?: string | undefined;
}

export function buildTaskFailedStatusCardSpec(input: TaskFailedStatusCardSpecInput): StatusCardSpec {
  return {
    eventType: "task_failed",
    title: `✗ ${input.title}`,
    template: taskTemplate("failed"),
    statusLabel: taskStatusLabel("failed"),
    roleLabel: clean(input.roleLabel),
    summary: clean(input.reason),
    workflowSummary: clean(input.workflowSummary) || undefined,
    footerNote: "可补充更多信息、缩小范围或重试。"
  };
}

export interface TaskPausedStatusCardSpecInput {
  title: string;
  roleLabel: string;
  question: string;
  workflowSummary?: string | undefined;
}

export function buildTaskPausedStatusCardSpec(input: TaskPausedStatusCardSpecInput): StatusCardSpec {
  return {
    eventType: "task_paused_input",
    title: `⏸ ${input.title}`,
    template: taskTemplate("paused_input"),
    statusLabel: taskStatusLabel("paused_input"),
    roleLabel: clean(input.roleLabel),
    summary: `需要你补充信息才能继续：\n\n**${clean(input.question)}**`,
    workflowSummary: clean(input.workflowSummary) || undefined,
    footerNote: "请直接回复你的答案，任务会自动恢复。"
  };
}

export interface TaskQueuedStatusCardSpecInput {
  taskTitle: string;
  roleLabel: string;
  workflowSummary?: string | undefined;
  nextActions?: string[] | undefined;
}

export function buildTaskQueuedStatusCardSpec(input: TaskQueuedStatusCardSpecInput): StatusCardSpec {
  return {
    eventType: "task_queued",
    title: "CEO 工作已接收",
    template: taskTemplate("queued"),
    statusLabel: "已进入执行队列",
    roleLabel: clean(input.roleLabel),
    summary: [`**目标**：${clean(input.taskTitle)}`, "我会先确认交付目标，再组织执行、验证产物，并把结果回报给你。"].join("\n\n"),
    workflowSummary: clean(input.workflowSummary) || undefined,
    nextActions: uniqueLines(input.nextActions),
    footerNote: "你是 CEO。需要决策或补充信息时我会暂停并明确提问；完成后会回报产物、验证状态和下一步。"
  };
}

function goalRunTemplate(status: GoalRunStatus): StatusCardTemplate {
  switch (status) {
    case "completed":
      return "green";
    case "failed":
    case "cancelled":
      return "red";
    case "awaiting_input":
    case "awaiting_authorization":
      return "orange";
    case "queued":
    case "running":
    default:
      return "blue";
  }
}

function goalRunFooterNote(status: GoalRunStatus): string {
  switch (status) {
    case "completed":
      return "如需继续下一轮目标，直接在当前会话下发新指令即可。";
    case "failed":
      return "建议补充缺失信息、缩小范围或重新发起一条更清晰的目标。";
    case "awaiting_input":
    case "awaiting_authorization":
      return "请直接回复补充信息，或在控制台继续授权 / 恢复。";
    default:
      return "GoalRun 会继续自动推进，并在关键节点同步。";
  }
}

export interface GoalRunStatusCardSpecInput {
  title: string;
  status: GoalRunStatus;
  statusLabel: string;
  summary: string;
  workflowSummary?: string | undefined;
  nextActions?: string[] | undefined;
  actions?: StatusCardAction[] | undefined;
}

export function buildGoalRunStatusCardSpec(input: GoalRunStatusCardSpecInput): StatusCardSpec {
  return {
    eventType: `goal_run_${input.status}`,
    title: clean(input.title),
    template: goalRunTemplate(input.status),
    statusLabel: clean(input.statusLabel),
    summary: clean(input.summary),
    workflowSummary: clean(input.workflowSummary) || undefined,
    nextActions: uniqueLines(input.nextActions),
    actions: Array.isArray(input.actions) ? input.actions : [],
    footerNote: goalRunFooterNote(input.status)
  };
}

export type CollaborationStatusCardState = "active" | "await_user" | "partial" | "completed" | "blocked";

function collaborationTemplate(status: CollaborationStatusCardState): StatusCardTemplate {
  switch (status) {
    case "completed":
      return "green";
    case "blocked":
      return "red";
    case "partial":
      return "yellow";
    case "await_user":
      return "orange";
    case "active":
    default:
      return "blue";
  }
}

function collaborationEventType(status: CollaborationStatusCardState): string {
  switch (status) {
    case "await_user":
      return "collaboration_await_user";
    case "partial":
      return "collaboration_partial_delivery";
    case "completed":
      return "collaboration_completed";
    case "blocked":
      return "collaboration_blocked";
    case "active":
    default:
      return "collaboration_started";
  }
}

function collaborationFooterNote(status: CollaborationStatusCardState): string {
  switch (status) {
    case "await_user":
      return "请直接回复补充信息，系统会继续自动收敛。";
    case "partial":
      return "当前已交付可用部分结果，剩余阻塞项会继续跟踪。";
    case "completed":
      return "完整协作结果已生成，可继续追加下一步目标。";
    case "blocked":
      return "请检查阻塞原因，补齐关键上下文后再继续。";
    case "active":
    default:
      return "协作会按里程碑自动汇总，并在需要你决策时暂停。";
  }
}

export interface CollaborationStatusCardSpecInput {
  title: string;
  status: CollaborationStatusCardState;
  statusLabel: string;
  summary: string;
  participants?: string[] | undefined;
  workflowSummary?: string | undefined;
  nextActions?: string[] | undefined;
}

export function buildCollaborationStatusCardSpec(input: CollaborationStatusCardSpecInput): StatusCardSpec {
  return {
    eventType: collaborationEventType(input.status),
    title: clean(input.title),
    template: collaborationTemplate(input.status),
    statusLabel: clean(input.statusLabel),
    summary: clean(input.summary),
    participants: uniqueLines(input.participants, 6),
    workflowSummary: clean(input.workflowSummary) || undefined,
    nextActions: uniqueLines(input.nextActions),
    footerNote: collaborationFooterNote(input.status)
  };
}

export interface EvolutionStatusCardSpecInput {
  eventType: "evolution_change_applied" | "evolution_change_rolled_back";
  title?: string | undefined;
  summary: string;
  workflowSummary?: string | undefined;
  nextActions?: string[] | undefined;
}

export function buildEvolutionStatusCardSpec(input: EvolutionStatusCardSpecInput): StatusCardSpec {
  const applied = input.eventType === "evolution_change_applied";
  return {
    eventType: input.eventType,
    title: input.title?.trim() || (applied ? "系统学习已生效" : "系统学习已回滚"),
    template: applied ? "indigo" : "orange",
    statusLabel: applied ? "运行时策略已更新" : "运行时策略已回滚",
    summary: clean(input.summary),
    workflowSummary: clean(input.workflowSummary) || undefined,
    nextActions: uniqueLines(input.nextActions),
    footerNote: applied
      ? "这是低频的重要运行时变化，后续任务会自动按新策略执行。"
      : "系统已恢复到上一个稳定策略快照。"
  };
}

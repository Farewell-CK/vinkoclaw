/**
 * Feishu Card Builder — unified card templates for VinkoClaw.
 *
 * All user-visible notifications use schema 2.0 interactive cards instead of
 * raw text. Color semantics:
 *   green   = success / completed
 *   red     = failure / error
 *   orange  = warning / needs action (approval, paused, clarification)
 *   blue    = info / queued / in progress
 *   indigo  = system / config
 *   grey    = neutral / acknowledgement
 */

import {
  buildCollaborationStatusCardSpec,
  buildEvolutionStatusCardSpec,
  buildGoalRunStatusCardSpec,
  buildTaskCompletedStatusCardSpec,
  buildTaskFailedStatusCardSpec,
  buildTaskPausedStatusCardSpec,
  buildTaskQueuedStatusCardSpec,
  type SessionWorkbenchSnapshot,
  type CollaborationStatusCardSpecInput,
  type EvolutionStatusCardSpecInput,
  type GoalRunStatusCardSpecInput,
  type StatusCardAction,
  type StatusCardSpec,
  type TaskCompletedStatusCardSpecInput,
  type TaskFailedStatusCardSpecInput,
  type TaskPausedStatusCardSpecInput,
  type TaskQueuedStatusCardSpecInput
} from "@vinko/shared";

// ── Colour palette ───────────────────────────────────────────────────────────

type CardTemplate =
  | "green" | "red" | "orange" | "blue"
  | "indigo" | "grey" | "purple" | "yellow";

// ── Low-level helpers ────────────────────────────────────────────────────────

function header(title: string, template: CardTemplate) {
  return { title: { tag: "plain_text", content: title }, template };
}

function md(content: string) {
  return { tag: "markdown", content };
}

function hr() {
  return { tag: "hr" };
}

function note(text: string) {
  return md(`<font color='grey'>${text}</font>`);
}

function button(label: string, value: Record<string, unknown>, type: "primary" | "danger" | "default" = "default") {
  return { tag: "button", text: { tag: "plain_text", content: label }, type, value };
}

function actions(...btns: Array<Record<string, unknown>>) {
  return { tag: "action", actions: btns };
}

function linkButton(label: string, url: string, type: "primary" | "default" = "default") {
  return {
    tag: "button",
    text: { tag: "plain_text", content: label },
    type,
    multi_url: { url }
  };
}

function card(
  headerEl: ReturnType<typeof header>,
  elements: unknown[],
): Record<string, unknown> {
  return {
    schema: "2.0",
    config: { width_mode: "fill" },
    header: headerEl,
    body: { elements },
  };
}

function statusSummaryBlock(spec: StatusCardSpec): string {
  const lines: string[] = [`**状态**：${spec.statusLabel}`];
  if (spec.roleLabel) {
    lines.push(`**执行角色**：${spec.roleLabel}`);
  }
  if (spec.summary) {
    lines.push("", spec.summary);
  }
  return lines.join("\n");
}

function participantsBlock(participants: string[] | undefined): unknown[] {
  const entries = Array.isArray(participants) ? participants.map((item) => String(item).trim()).filter(Boolean) : [];
  if (entries.length === 0) {
    return [];
  }
  return [md(`**参与角色**：${entries.join("、")}`)];
}

function nextActionsBlock(nextActions: string[] | undefined): unknown[] {
  const items = Array.isArray(nextActions) ? nextActions.map((item) => String(item).trim()).filter(Boolean) : [];
  if (items.length === 0) {
    return [];
  }
  return [hr(), md(`**下一步**\n\n${items.slice(0, 4).map((item) => `- ${item}`).join("\n")}`)];
}

function renderStatusActions(actionsInput: StatusCardAction[] | undefined): Array<Record<string, unknown>> {
  const actionButtons: Array<Record<string, unknown>> = [];
  if (Array.isArray(actionsInput)) {
    for (const item of actionsInput) {
      if (item.url) {
        actionButtons.push(linkButton(item.label, item.url, item.type === "primary" ? "primary" : "default"));
        continue;
      }
      if (item.value) {
        actionButtons.push(button(item.label, item.value, item.type ?? "default"));
      }
    }
  }
  return actionButtons;
}

function renderStatusCard(spec: StatusCardSpec): Record<string, unknown> {
  const actionButtons = renderStatusActions(spec.actions);
  return card(
    header(spec.title, spec.template),
    [
      md(statusSummaryBlock(spec)),
      ...participantsBlock(spec.participants),
      ...(spec.workflowSummary?.trim() ? [hr(), md(spec.workflowSummary.trim())] : []),
      ...nextActionsBlock(spec.nextActions),
      ...(actionButtons.length > 0 ? [hr(), actions(...actionButtons)] : []),
      ...(spec.footerNote ? [hr(), note(spec.footerNote)] : [])
    ]
  );
}

// ── Task completed card ──────────────────────────────────────────────────────

export interface TaskCompletedCardInput extends TaskCompletedStatusCardSpecInput {}

export function buildTaskCompletedCard(input: TaskCompletedCardInput): Record<string, unknown> {
  return renderStatusCard(buildTaskCompletedStatusCardSpec(input));
}

// ── Task failed card ─────────────────────────────────────────────────────────

export interface TaskFailedCardInput extends TaskFailedStatusCardSpecInput {}

export function buildTaskFailedCard(input: TaskFailedCardInput): Record<string, unknown> {
  return renderStatusCard(buildTaskFailedStatusCardSpec(input));
}

// ── Task paused / needs input card ──────────────────────────────────────────

export interface TaskPausedCardInput extends TaskPausedStatusCardSpecInput {}

export function buildTaskPausedCard(input: TaskPausedCardInput): Record<string, unknown> {
  return renderStatusCard(buildTaskPausedStatusCardSpec(input));
}

// ── Needs clarification card (intake phase) ──────────────────────────────────

export interface NeedsClarificationCardInput {
  questions: string[];
}

export function buildNeedsClarificationCard(input: NeedsClarificationCardInput): Record<string, unknown> {
  const qList = input.questions
    .map((q, i) => `${i + 1}. ${q}`)
    .join("\n");

  return card(
    header("需要补充几个信息", "orange"),
    [
      md(`在开始之前，我有几个问题：\n\n${qList}`),
      hr(),
      note("请直接回复，我会根据你的回答开始任务"),
    ],
  );
}

// ── Task queued card ─────────────────────────────────────────────────────────

export interface TaskQueuedCardInput {
  taskTitle?: string;
  title?: string;
  roleLabel: string;
  workflowSummary?: string;
  nextActions?: string[];
}

export function buildTaskQueuedCard(input: TaskQueuedCardInput): Record<string, unknown> {
  return renderStatusCard(
    buildTaskQueuedStatusCardSpec({
      taskTitle: input.taskTitle ?? input.title ?? "",
      roleLabel: input.roleLabel,
      workflowSummary: input.workflowSummary,
      nextActions: input.nextActions
    })
  );
}

// ── GoalRun progress cards ───────────────────────────────────────────────────

export interface GoalRunProgressCardInput extends Omit<GoalRunStatusCardSpecInput, "status"> {}

export function buildGoalRunProgressCard(input: GoalRunProgressCardInput): Record<string, unknown> {
  return renderStatusCard(
    buildGoalRunStatusCardSpec({
      ...input,
      status: "running"
    })
  );
}

export interface GoalRunBlockedCardInput {
  title: string;
  status: "awaiting_input" | "awaiting_authorization";
  statusLabel: string;
  reason: string;
  workflowSummary?: string;
  nextActions?: string[];
  actions?: StatusCardAction[];
}

export function buildGoalRunBlockedCard(input: GoalRunBlockedCardInput): Record<string, unknown> {
  return renderStatusCard(
    buildGoalRunStatusCardSpec({
      title: input.title,
      status: input.status,
      statusLabel: input.statusLabel,
      summary: input.reason,
      workflowSummary: input.workflowSummary,
      nextActions: input.nextActions,
      actions: input.actions
    })
  );
}

export interface GoalRunCompletedCardInput {
  title: string;
  summary: string;
  workflowSummary?: string;
  nextActions?: string[];
}

export function buildGoalRunCompletedCard(input: GoalRunCompletedCardInput): Record<string, unknown> {
  return renderStatusCard(
    buildGoalRunStatusCardSpec({
      title: input.title,
      status: "completed",
      statusLabel: "已完成",
      summary: input.summary,
      workflowSummary: input.workflowSummary,
      nextActions: input.nextActions
    })
  );
}

export interface GoalRunFailedCardInput {
  title: string;
  reason: string;
  workflowSummary?: string;
  nextActions?: string[];
}

export function buildGoalRunFailedCard(input: GoalRunFailedCardInput): Record<string, unknown> {
  return renderStatusCard(
    buildGoalRunStatusCardSpec({
      title: input.title,
      status: "failed",
      statusLabel: "执行失败",
      summary: input.reason,
      workflowSummary: input.workflowSummary,
      nextActions: input.nextActions
    })
  );
}

// ── Approval request card ────────────────────────────────────────────────────

export interface ApprovalRequestCardInput {
  approvalId: string;
  summary: string;
  requestedBy?: string;
  approverOpenId: string;
  expiresAt: number;
  stepId: string;
  roleId: string;
}

export function buildApprovalRequestCard(input: ApprovalRequestCardInput): Record<string, unknown> {
  const base = {
    kind: "approval_decision",
    approvalId: input.approvalId,
    stepId: input.stepId,
    roleId: input.roleId,
    approverOpenId: input.approverOpenId,
    expiresAt: input.expiresAt,
  };

  const requester = input.requestedBy?.trim() || "系统";

  return card(
    header("需要你审批", "orange"),
    [
      md(`**发起人**：${requester}\n\n${input.summary}`),
      hr(),
      actions(
        button("✓ 批准", { ...base, decision: "approved" }, "primary"),
        button("✗ 拒绝", { ...base, decision: "rejected" }, "danger"),
      ),
    ],
  );
}

// ── Approval result card ─────────────────────────────────────────────────────

export interface ApprovalResultCardInput {
  summary: string;
  decision: "approved" | "rejected";
  decidedBy?: string;
}

export function buildApprovalResultCard(input: ApprovalResultCardInput): Record<string, unknown> {
  const approved = input.decision === "approved";
  return card(
    header(approved ? "✓ 审批通过" : "✗ 审批拒绝", approved ? "green" : "red"),
    [
      md(input.summary),
      ...(input.decidedBy ? [hr(), note(`由 ${input.decidedBy} 决定`)] : []),
    ],
  );
}

// ── Light review queued notification ────────────────────────────────────────

export interface LightReviewQueuedCardInput {
  parentTitle: string;
  reviewerLabel: string;
}

export function buildLightReviewQueuedCard(input: LightReviewQueuedCardInput): Record<string, unknown> {
  return card(
    header("审阅中", "blue"),
    [
      md(`**${input.reviewerLabel}** 正在快速检查：${input.parentTitle}`),
      hr(),
      note("审阅完成后你会收到最终结果"),
    ],
  );
}

// ── Light iteration queued notification ──────────────────────────────────────

export interface LightIterationQueuedCardInput {
  parentTitle: string;
  executorLabel: string;
  reviewSummary: string;
}

export function buildLightIterationQueuedCard(input: LightIterationQueuedCardInput): Record<string, unknown> {
  return card(
    header("修订中", "indigo"),
    [
      md(`**${input.executorLabel}** 正在根据审阅意见修订：${input.parentTitle}`),
      md(`> ${input.reviewSummary.slice(0, 200)}`),
    ],
  );
}

// ── Feedback acknowledgement cards ──────────────────────────────────────────

export function buildFeedbackGoodCard(): Record<string, unknown> {
  return card(
    header("已记录", "green"),
    [md("感谢你的反馈 👍 已记录到系统学习中")],
  );
}

export function buildFeedbackPoorCard(): Record<string, unknown> {
  return card(
    header("已重新安排", "indigo"),
    [
      md("已收到反馈 👎 任务已重新安排执行"),
      hr(),
      note("稍后为你重新完成"),
    ],
  );
}

// ── Escalation card ──────────────────────────────────────────────────────────

export interface EscalationCardInput {
  title: string;
  roleLabel: string;
  issues: string[];
  iterationCount: number;
}

export function buildEscalationCard(input: EscalationCardInput): Record<string, unknown> {
  const issueList = input.issues.length > 0
    ? input.issues.map((q, i) => `${i + 1}. ${q}`).join("\n")
    : "经过多轮迭代仍未达到质量要求";

  return card(
    header(`⚠ 需要你介入：${input.title}`, "orange"),
    [
      md(`**${input.roleLabel}** 经过 ${input.iterationCount} 轮迭代后仍存在以下问题，需要你的指引：\n\n${issueList}`),
      hr(),
      note("请直接回复你的指示，任务将继续执行"),
    ],
  );
}

// ── Collaboration status cards ──────────────────────────────────────────────

export interface CollaborationStatusCardInput extends Omit<CollaborationStatusCardSpecInput, "status"> {}

export function buildCollaborationStartedCard(input: CollaborationStatusCardInput): Record<string, unknown> {
  return renderStatusCard(buildCollaborationStatusCardSpec({ ...input, status: "active" }));
}

export function buildCollaborationAwaitUserCard(input: CollaborationStatusCardInput): Record<string, unknown> {
  return renderStatusCard(buildCollaborationStatusCardSpec({ ...input, status: "await_user" }));
}

export function buildCollaborationPartialCard(input: CollaborationStatusCardInput): Record<string, unknown> {
  return renderStatusCard(buildCollaborationStatusCardSpec({ ...input, status: "partial" }));
}

export function buildCollaborationCompletedCard(input: CollaborationStatusCardInput): Record<string, unknown> {
  return renderStatusCard(buildCollaborationStatusCardSpec({ ...input, status: "completed" }));
}

export function buildCollaborationBlockedCard(input: CollaborationStatusCardInput): Record<string, unknown> {
  return renderStatusCard(buildCollaborationStatusCardSpec({ ...input, status: "blocked" }));
}

// ── Evolution status cards ──────────────────────────────────────────────────

export interface EvolutionStatusCardInput extends EvolutionStatusCardSpecInput {}

export function buildEvolutionStatusCard(input: EvolutionStatusCardInput): Record<string, unknown> {
  return renderStatusCard(buildEvolutionStatusCardSpec(input));
}

// ── Session workbench card ──────────────────────────────────────────────────

export interface SessionWorkbenchCardInput {
  snapshot: SessionWorkbenchSnapshot;
}

export function buildSessionWorkbenchCard(input: SessionWorkbenchCardInput): Record<string, unknown> {
  const { snapshot } = input;
  const actionsInput: StatusCardAction[] = [
    {
      label: "刷新状态",
      type: "primary",
      value: {
        kind: "session_workbench",
        sessionId: snapshot.sessionId,
        action: "refresh"
      }
    },
    {
      label: "继续推进",
      type: "default",
      value: {
        kind: "session_workbench",
        sessionId: snapshot.sessionId,
        action: "continue"
      }
    }
  ];
  if (snapshot.activeTask) {
    actionsInput.push({
      label: "查看任务",
      value: {
        kind: "session_workbench",
        sessionId: snapshot.sessionId,
        action: "task_status",
        taskId: snapshot.activeTask.id
      }
    });
  }
  if (snapshot.activeGoalRun) {
    actionsInput.push({
      label: "查看 GoalRun",
      value: {
        kind: "session_workbench",
        sessionId: snapshot.sessionId,
        action: "goal_run_status",
        goalRunId: snapshot.activeGoalRun.id
      }
    });
  }

  return renderStatusCard({
    eventType: "session_workbench",
    title: `工作台 · ${snapshot.sessionTitle}`,
    template: snapshot.blockers.length > 0 ? "orange" : "indigo",
    statusLabel: snapshot.currentStage || "进行中",
    summary: [
      `**目标**：${snapshot.currentGoal || snapshot.sessionTitle}`,
      snapshot.latestSummary ? `**最新进展**：${snapshot.latestSummary}` : "",
      snapshot.activeTask
        ? `**当前任务**：${snapshot.activeTask.title} · ${snapshot.activeTask.status} · ${snapshot.activeTask.roleId}`
        : "",
      snapshot.activeGoalRun
        ? `**当前 GoalRun**：${snapshot.activeGoalRun.stage} · ${snapshot.activeGoalRun.status}`
        : "",
      snapshot.pendingApproval
        ? `**待审批**：${snapshot.pendingApproval.summary}`
        : ""
    ].filter(Boolean).join("\n"),
    workflowSummary: snapshot.activeTask?.workflowSummary,
    nextActions: snapshot.nextActions,
    actions: actionsInput,
    footerNote:
      snapshot.blockers.length > 0
        ? `当前阻塞：${snapshot.blockers.slice(0, 2).join("；")}`
        : snapshot.latestArtifacts.length > 0
          ? `最近产物：${snapshot.latestArtifacts.slice(0, 3).join("；")}`
          : "工作台会按当前会话持续回报状态。"
  });
}

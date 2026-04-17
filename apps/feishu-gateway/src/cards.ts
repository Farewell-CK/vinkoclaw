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

function actions(...btns: ReturnType<typeof button>[]) {
  return { tag: "action", actions: btns };
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

// ── Task completed card ──────────────────────────────────────────────────────

export interface TaskCompletedCardInput {
  title: string;
  roleLabel: string;
  summary: string;
  workflowSummary?: string;
  /** Pass taskId + chatId to enable 👍/👎 feedback buttons */
  feedback?: { taskId: string; chatId: string };
}

export function buildTaskCompletedCard(input: TaskCompletedCardInput): Record<string, unknown> {
  const elements: unknown[] = [
    md(`**${input.roleLabel}** 已完成任务\n\n${input.summary}`),
  ];
  if (input.workflowSummary?.trim()) {
    elements.push(hr(), md(input.workflowSummary.trim()));
  }

  if (input.feedback) {
    elements.push(hr());
    const base = { kind: "task_feedback", taskId: input.feedback.taskId, chatId: input.feedback.chatId };
    elements.push(
      actions(
        button("👍 满意", { ...base, rating: "good" }, "primary"),
        button("👎 需改进", { ...base, rating: "poor" }, "danger"),
      ),
    );
  }

  return card(header(`✓ ${input.title}`, "green"), elements);
}

// ── Task failed card ─────────────────────────────────────────────────────────

export interface TaskFailedCardInput {
  title: string;
  roleLabel: string;
  reason: string;
}

export function buildTaskFailedCard(input: TaskFailedCardInput): Record<string, unknown> {
  return card(
    header(`✗ ${input.title}`, "red"),
    [
      md(`**${input.roleLabel}** 执行失败\n\n${input.reason}`),
      hr(),
      note("可重新描述任务，或补充更多信息后重试"),
    ],
  );
}

// ── Task paused / needs input card ──────────────────────────────────────────

export interface TaskPausedCardInput {
  title: string;
  roleLabel: string;
  question: string;
  workflowSummary?: string;
}

export function buildTaskPausedCard(input: TaskPausedCardInput): Record<string, unknown> {
  return card(
    header(`⏸ ${input.title}`, "orange"),
    [
      md(`**${input.roleLabel}** 需要你补充信息才能继续：\n\n**${input.question}**`),
      ...(input.workflowSummary?.trim() ? [hr(), md(input.workflowSummary.trim())] : []),
      hr(),
      note("请直接回复你的答案，任务将自动恢复"),
    ],
  );
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
  title: string;
  roleLabel: string;
  workflowSummary?: string;
}

export function buildTaskQueuedCard(input: TaskQueuedCardInput): Record<string, unknown> {
  return card(
    header("已接收", "blue"),
    [
      md(`**${input.roleLabel}** 正在处理：${input.title}`),
      ...(input.workflowSummary?.trim() ? [hr(), md(input.workflowSummary.trim())] : []),
      hr(),
      note("任务完成后我会通知你"),
    ],
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

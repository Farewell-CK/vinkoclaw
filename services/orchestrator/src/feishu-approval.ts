export interface FeishuCardDecisionPayload {
  approvalId: string;
  stepId: string;
  decision: "approved" | "rejected";
  approverOpenId: string;
  expiresAt: number;
}

export type FeishuCardDecisionValidationFailureReason =
  | "card_payload_invalid"
  | "card_owner_mismatch"
  | "card_expired"
  | "approval_not_found"
  | "approval_step_not_pending"
  | "approval_approver_not_configured"
  | "approval_approver_not_allowed";

export type FeishuCardDecisionValidationResult =
  | {
      ok: true;
    }
  | {
      ok: false;
      reason: FeishuCardDecisionValidationFailureReason;
      feedback: string;
    };

const FEISHU_CARD_FAILURE_FEEDBACK: Record<FeishuCardDecisionValidationFailureReason, string> = {
  card_payload_invalid: "卡片动作无效，请重新发起审批。",
  card_owner_mismatch: "该审批卡片不属于你，无法处理。",
  card_expired: "该审批卡片已过期，请重新触发审批。",
  approval_not_found: "审批单不存在或已失效。",
  approval_step_not_pending: "该审批步骤已处理，无需重复操作。",
  approval_approver_not_configured: "当前审批步骤未配置审批人，无法处理。",
  approval_approver_not_allowed: "你不在当前审批步骤的审批人列表中。"
};

export function parseFeishuCardDecisionPayload(
  value: Record<string, unknown>
): FeishuCardDecisionPayload | undefined {
  const kind = typeof value.kind === "string" ? value.kind.trim() : "";
  if (kind !== "approval_decision") {
    return undefined;
  }
  const approvalId = typeof value.approvalId === "string" ? value.approvalId.trim() : "";
  const stepId = typeof value.stepId === "string" ? value.stepId.trim() : "";
  const decision = value.decision === "approved" || value.decision === "rejected" ? value.decision : undefined;
  const approverOpenId = typeof value.approverOpenId === "string" ? value.approverOpenId.trim() : "";
  const expiresAtRaw = Number(value.expiresAt);
  if (!approvalId || !stepId || !decision || !approverOpenId || !Number.isFinite(expiresAtRaw)) {
    return undefined;
  }
  return {
    approvalId,
    stepId,
    decision,
    approverOpenId,
    expiresAt: Math.round(expiresAtRaw)
  };
}

export function validateFeishuCardDecision(input: {
  payload: FeishuCardDecisionPayload | undefined;
  operatorOpenId: string;
  nowMs?: number;
  approvalExists: boolean;
  pendingStepId: string | undefined;
  allowedApproverOpenIds: string[];
}): FeishuCardDecisionValidationResult {
  if (!input.payload) {
    return {
      ok: false,
      reason: "card_payload_invalid",
      feedback: FEISHU_CARD_FAILURE_FEEDBACK.card_payload_invalid
    };
  }

  if (input.payload.approverOpenId !== input.operatorOpenId) {
    return {
      ok: false,
      reason: "card_owner_mismatch",
      feedback: FEISHU_CARD_FAILURE_FEEDBACK.card_owner_mismatch
    };
  }

  const now = input.nowMs ?? Date.now();
  if (now > input.payload.expiresAt) {
    return {
      ok: false,
      reason: "card_expired",
      feedback: FEISHU_CARD_FAILURE_FEEDBACK.card_expired
    };
  }

  if (!input.approvalExists) {
    return {
      ok: false,
      reason: "approval_not_found",
      feedback: FEISHU_CARD_FAILURE_FEEDBACK.approval_not_found
    };
  }

  if (!input.pendingStepId || input.pendingStepId !== input.payload.stepId) {
    return {
      ok: false,
      reason: "approval_step_not_pending",
      feedback: FEISHU_CARD_FAILURE_FEEDBACK.approval_step_not_pending
    };
  }

  if (input.allowedApproverOpenIds.length === 0) {
    return {
      ok: false,
      reason: "approval_approver_not_configured",
      feedback: FEISHU_CARD_FAILURE_FEEDBACK.approval_approver_not_configured
    };
  }

  if (!input.allowedApproverOpenIds.includes(input.operatorOpenId)) {
    return {
      ok: false,
      reason: "approval_approver_not_allowed",
      feedback: FEISHU_CARD_FAILURE_FEEDBACK.approval_approver_not_allowed
    };
  }

  return { ok: true };
}

export class ExpiringTokenDeduper {
  private readonly tokenExpireAtMap = new Map<string, number>();

  constructor(private readonly ttlMs: number) {}

  prune(nowMs = Date.now()): void {
    for (const [token, expiresAt] of this.tokenExpireAtMap.entries()) {
      if (expiresAt <= nowMs) {
        this.tokenExpireAtMap.delete(token);
      }
    }
  }

  claim(rawToken: string, nowMs = Date.now()): boolean {
    const token = rawToken.trim();
    if (!token) {
      return false;
    }
    this.prune(nowMs);
    if (this.tokenExpireAtMap.has(token)) {
      return false;
    }
    this.tokenExpireAtMap.set(token, nowMs + this.ttlMs);
    return true;
  }

  size(): number {
    return this.tokenExpireAtMap.size;
  }
}

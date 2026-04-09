import { describe, expect, it } from "vitest";
import {
  ExpiringTokenDeduper,
  parseFeishuCardDecisionPayload,
  validateFeishuCardDecision
} from "./feishu-approval.js";

describe("feishu-approval", () => {
  it("parses valid approval card payload", () => {
    const parsed = parseFeishuCardDecisionPayload({
      kind: "approval_decision",
      approvalId: "apr_1",
      stepId: "step_1",
      decision: "approved",
      approverOpenId: "ou_approver_1",
      expiresAt: Date.now() + 60_000
    });

    expect(parsed).toEqual({
      approvalId: "apr_1",
      stepId: "step_1",
      decision: "approved",
      approverOpenId: "ou_approver_1",
      expiresAt: expect.any(Number)
    });
  });

  it("rejects malformed approval card payload", () => {
    expect(
      parseFeishuCardDecisionPayload({
        kind: "approval_decision",
        approvalId: "apr_1"
      } as Record<string, unknown>)
    ).toBeUndefined();
  });

  it("validates approval card decision context", () => {
    const now = 1_700_000_000_000;
    const payload = parseFeishuCardDecisionPayload({
      kind: "approval_decision",
      approvalId: "apr_1",
      stepId: "step_1",
      decision: "approved",
      approverOpenId: "ou_approver_1",
      expiresAt: now + 60_000
    });

    expect(
      validateFeishuCardDecision({
        payload,
        operatorOpenId: "ou_approver_1",
        nowMs: now,
        approvalExists: true,
        pendingStepId: "step_1",
        allowedApproverOpenIds: ["ou_approver_1", "ou_approver_2"]
      })
    ).toEqual({ ok: true });

    expect(
      validateFeishuCardDecision({
        payload,
        operatorOpenId: "ou_other",
        nowMs: now,
        approvalExists: true,
        pendingStepId: "step_1",
        allowedApproverOpenIds: ["ou_approver_1"]
      })
    ).toMatchObject({
      ok: false,
      reason: "card_owner_mismatch"
    });

    expect(
      validateFeishuCardDecision({
        payload,
        operatorOpenId: "ou_approver_1",
        nowMs: now + 120_000,
        approvalExists: true,
        pendingStepId: "step_1",
        allowedApproverOpenIds: ["ou_approver_1"]
      })
    ).toMatchObject({
      ok: false,
      reason: "card_expired"
    });

    expect(
      validateFeishuCardDecision({
        payload,
        operatorOpenId: "ou_approver_1",
        nowMs: now,
        approvalExists: false,
        pendingStepId: "step_1",
        allowedApproverOpenIds: ["ou_approver_1"]
      })
    ).toMatchObject({
      ok: false,
      reason: "approval_not_found"
    });

    expect(
      validateFeishuCardDecision({
        payload,
        operatorOpenId: "ou_approver_1",
        nowMs: now,
        approvalExists: true,
        pendingStepId: "step_2",
        allowedApproverOpenIds: ["ou_approver_1"]
      })
    ).toMatchObject({
      ok: false,
      reason: "approval_step_not_pending"
    });

    expect(
      validateFeishuCardDecision({
        payload,
        operatorOpenId: "ou_approver_1",
        nowMs: now,
        approvalExists: true,
        pendingStepId: "step_1",
        allowedApproverOpenIds: []
      })
    ).toMatchObject({
      ok: false,
      reason: "approval_approver_not_configured"
    });

    expect(
      validateFeishuCardDecision({
        payload,
        operatorOpenId: "ou_approver_1",
        nowMs: now,
        approvalExists: true,
        pendingStepId: "step_1",
        allowedApproverOpenIds: ["ou_approver_2"]
      })
    ).toMatchObject({
      ok: false,
      reason: "approval_approver_not_allowed"
    });
  });

  it("deduplicates card action token with ttl", () => {
    const deduper = new ExpiringTokenDeduper(1_000);
    const now = 1_700_000_000_000;

    expect(deduper.claim("token_1", now)).toBe(true);
    expect(deduper.claim("token_1", now + 10)).toBe(false);
    expect(deduper.size()).toBe(1);

    deduper.prune(now + 1_001);
    expect(deduper.size()).toBe(0);
    expect(deduper.claim("token_1", now + 1_002)).toBe(true);
  });
});

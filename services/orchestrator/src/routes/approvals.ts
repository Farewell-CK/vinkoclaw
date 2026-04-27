import express from "express";
import {
  orchestratorApprovalEscalationSchema,
  orchestratorApprovalDecisionSchema,
  orchestratorApprovalStepDecisionSchema
} from "@vinko/protocol";
import type { ApprovalDecisionInput, VinkoStore } from "@vinko/shared";

export interface ApprovalRoutesDeps {
  store: VinkoStore;
  sanitizeApprovalRecord: <T extends { payload: Record<string, unknown> }>(approval: T) => T;
  sanitizeOperatorActionRecord: <T extends { payload: Record<string, unknown> }>(action: T) => T;
  ensureApprovalWorkflowForRecord: (approvalId: string) =>
    | {
        workflow: {
          id: string;
          approvalId: string;
          status: string;
          currentStepIndex: number;
          createdAt: string;
          updatedAt: string;
        };
        steps: Array<{
          id: string;
          workflowId: string;
          stepIndex: number;
          roleId: string;
          status: string;
          decidedBy?: string | undefined;
          decisionNote?: string | undefined;
          decidedAt?: string | undefined;
          createdAt: string;
          updatedAt: string;
        }>;
      }
    | undefined;
  safeEmitApprovalLifecycleEvent: (input: {
    phase: "before_approval_decision" | "after_approval_decision";
    approvalId: string;
    kind: string;
    status?: string | undefined;
    requestedBy?: string | undefined;
    decidedBy?: string | undefined;
  }) => Promise<void>;
  applyApprovalDecisionEffects: (
    approval: ReturnType<VinkoStore["getApproval"]>
  ) => Promise<unknown>;
  onApprovalWorkflowUpdated?: (input: {
    approvalId: string;
    stepId?: string | undefined;
    reason: "decision" | "escalation";
    approval?: ReturnType<VinkoStore["getApproval"]> | undefined;
  }) => Promise<void> | void;
}

export function registerApprovalRoutes(app: express.Express, deps: ApprovalRoutesDeps): void {
  const {
    store,
    sanitizeApprovalRecord,
    sanitizeOperatorActionRecord,
    ensureApprovalWorkflowForRecord,
    safeEmitApprovalLifecycleEvent,
    applyApprovalDecisionEffects,
    onApprovalWorkflowUpdated
  } = deps;

  app.get("/api/approvals", (_request, response) => {
    response.json(store.listApprovals(100).map((approval) => sanitizeApprovalRecord(approval)));
  });

  app.get("/api/approvals/:approvalId/history", (request, response) => {
    const approval = store.getApproval(request.params.approvalId);
    if (!approval) {
      response.status(404).json({ error: "approval_not_found" });
      return;
    }
    response.json({
      approval: sanitizeApprovalRecord(approval),
      events: store.listApprovalEvents(approval.id)
    });
  });

  app.get("/api/approvals/:approvalId/workflow", (request, response) => {
    const approval = store.getApproval(request.params.approvalId);
    if (!approval) {
      response.status(404).json({ error: "approval_not_found" });
      return;
    }

    const ensured = ensureApprovalWorkflowForRecord(approval.id);
    if (!ensured) {
      response.status(404).json({ error: "approval_workflow_not_found" });
      return;
    }

    response.json({
      approval: sanitizeApprovalRecord(approval),
      workflow: ensured.workflow,
      steps: ensured.steps
    });
  });

  app.post("/api/approvals/:approvalId/step/:stepId/decision", async (request, response) => {
    const approval = store.getApproval(request.params.approvalId);
    if (!approval) {
      response.status(404).json({ error: "approval_not_found" });
      return;
    }
    const ensured = ensureApprovalWorkflowForRecord(approval.id);
    if (!ensured) {
      response.status(404).json({ error: "approval_workflow_not_found" });
      return;
    }

    const parsed = orchestratorApprovalStepDecisionSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({
        error: "invalid_approval_step_decision_payload",
        details: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message
        }))
      });
      return;
    }

    const decision = parsed.data;
    await safeEmitApprovalLifecycleEvent({
      phase: "before_approval_decision",
      approvalId: approval.id,
      kind: approval.kind,
      status: approval.status,
      requestedBy: approval.requestedBy,
      decidedBy: decision.decidedBy
    });

    let decisionResult:
      | ReturnType<typeof store.decideApprovalWorkflowStep>
      | undefined;
    try {
      decisionResult = store.decideApprovalWorkflowStep({
        approvalId: approval.id,
        stepId: request.params.stepId,
        status: decision.status,
        decidedBy: decision.decidedBy,
        decisionNote: decision.decisionNote
      });
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      return;
    }

    const decidedApproval = decisionResult.approval ?? store.getApproval(approval.id);
    await safeEmitApprovalLifecycleEvent({
      phase: "after_approval_decision",
      approvalId: approval.id,
      kind: approval.kind,
      status: decidedApproval?.status ?? approval.status,
      requestedBy: approval.requestedBy,
      decidedBy: decision.decidedBy
    });

    let actionResult: unknown = undefined;
    try {
      actionResult = await applyApprovalDecisionEffects(decidedApproval);
    } catch (error) {
      response.status(502).json({
        approval: sanitizeApprovalRecord(decidedApproval ?? approval),
        workflow: decisionResult.workflow,
        step: decisionResult.step,
        error: "approval_effect_failed",
        message: error instanceof Error ? error.message : String(error)
      });
      return;
    }

    response.json({
      approval: sanitizeApprovalRecord(decidedApproval ?? approval),
      workflow: decisionResult.workflow,
      step: decisionResult.step,
      action:
        actionResult && typeof actionResult === "object" && "payload" in actionResult
          ? sanitizeOperatorActionRecord(actionResult as { payload: Record<string, unknown> })
          : actionResult
    });
    try {
      await onApprovalWorkflowUpdated?.({
        approvalId: approval.id,
        reason: "decision",
        approval: decidedApproval
      });
    } catch {
      // Ignore callback failures to keep API decision path stable.
    }
  });

  app.post("/api/approvals/:approvalId/escalate", (request, response) => {
    const approval = store.getApproval(request.params.approvalId);
    if (!approval) {
      response.status(404).json({ error: "approval_not_found" });
      return;
    }

    const parsed = orchestratorApprovalEscalationSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({
        error: "invalid_approval_escalation_payload",
        details: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message
        }))
      });
      return;
    }

    const escalation = parsed.data;
    let result:
      | ReturnType<typeof store.escalateApprovalWorkflow>
      | undefined;
    try {
      result = store.escalateApprovalWorkflow({
        approvalId: approval.id,
        roleId: escalation.roleId,
        requestedBy: escalation.requestedBy,
        note: escalation.note
      });
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      return;
    }

    response.status(201).json({
      approval: sanitizeApprovalRecord(store.getApproval(approval.id) ?? approval),
      workflow: result.workflow,
      step: result.step
    });
    try {
      void onApprovalWorkflowUpdated?.({
        approvalId: approval.id,
        stepId: result.step.id,
        reason: "escalation",
        approval: store.getApproval(approval.id) ?? approval
      });
    } catch {
      // Ignore callback failures to keep API escalation path stable.
    }
  });

  app.post("/api/approvals/:approvalId/decision", async (request, response) => {
    const parsed = orchestratorApprovalDecisionSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({
        error: "invalid_decision_payload",
        details: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message
        }))
      });
      return;
    }
    const decision = parsed.data as ApprovalDecisionInput;
    const approval = store.getApproval(request.params.approvalId);
    if (!approval) {
      response.status(404).json({ error: "approval_not_found" });
      return;
    }
    const ensured = ensureApprovalWorkflowForRecord(approval.id);
    if (!ensured) {
      response.status(404).json({ error: "approval_workflow_not_found" });
      return;
    }
    const pendingStep = store.getPendingApprovalWorkflowStep(approval.id);
    if (!pendingStep) {
      response.status(409).json({ error: "approval_workflow_has_no_pending_step" });
      return;
    }

    await safeEmitApprovalLifecycleEvent({
      phase: "before_approval_decision",
      approvalId: approval.id,
      kind: approval.kind,
      status: approval.status,
      requestedBy: approval.requestedBy,
      decidedBy: decision.decidedBy
    });

    let decisionResult:
      | ReturnType<typeof store.decideApprovalWorkflowStep>
      | undefined;
    try {
      decisionResult = store.decideApprovalWorkflowStep({
        approvalId: approval.id,
        stepId: pendingStep.step.id,
        status: decision.status,
        decidedBy: decision.decidedBy,
        decisionNote: decision.decisionNote
      });
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      return;
    }

    const decidedApproval = decisionResult.approval ?? store.getApproval(approval.id) ?? approval;
    await safeEmitApprovalLifecycleEvent({
      phase: "after_approval_decision",
      approvalId: decidedApproval.id,
      kind: decidedApproval.kind,
      status: decidedApproval.status,
      requestedBy: decidedApproval.requestedBy,
      decidedBy: decidedApproval.decidedBy
    });

    let actionResult: unknown = undefined;
    try {
      actionResult = await applyApprovalDecisionEffects(decidedApproval);
    } catch (error) {
      response.status(502).json({
        approval: sanitizeApprovalRecord(decidedApproval),
        workflow: decisionResult.workflow,
        step: decisionResult.step,
        error: "approval_effect_failed",
        message: error instanceof Error ? error.message : String(error)
      });
      return;
    }

    response.json({
      approval: sanitizeApprovalRecord(decidedApproval),
      workflow: decisionResult.workflow,
      step: decisionResult.step,
      action:
        actionResult && typeof actionResult === "object" && "payload" in actionResult
          ? sanitizeOperatorActionRecord(
              actionResult as typeof actionResult & { payload: Record<string, unknown> }
            )
          : actionResult
    });
    try {
      await onApprovalWorkflowUpdated?.({
        approvalId: approval.id,
        reason: "decision",
        approval: decidedApproval
      });
    } catch {
      // Ignore callback failures to keep API decision path stable.
    }
  });

  app.post("/api/approvals/:approvalId/cancel", async (request, response) => {
    const approval = store.getApproval(request.params.approvalId);
    if (!approval) {
      response.status(404).json({ error: "approval_not_found" });
      return;
    }
    const pendingStep = store.getPendingApprovalWorkflowStep(approval.id);
    if (!pendingStep) {
      response.status(409).json({ error: "approval_workflow_has_no_pending_step" });
      return;
    }

    const body =
      typeof request.body === "object" && request.body !== null
        ? (request.body as Record<string, unknown>)
        : {};
    const decidedBy =
      typeof body.decidedBy === "string" && body.decidedBy.trim().length > 0 ? body.decidedBy.trim() : "system";
    const reason = typeof body.reason === "string" && body.reason.trim().length > 0 ? body.reason.trim() : "cancelled";

    await safeEmitApprovalLifecycleEvent({
      phase: "before_approval_decision",
      approvalId: approval.id,
      kind: approval.kind,
      status: approval.status,
      requestedBy: approval.requestedBy,
      decidedBy
    });

    let decisionResult:
      | ReturnType<typeof store.decideApprovalWorkflowStep>
      | undefined;
    try {
      decisionResult = store.decideApprovalWorkflowStep({
        approvalId: approval.id,
        stepId: pendingStep.step.id,
        status: "rejected",
        decidedBy,
        decisionNote: `cancelled: ${reason}`
      });
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      return;
    }

    const decidedApproval = decisionResult.approval ?? store.getApproval(approval.id) ?? approval;
    await safeEmitApprovalLifecycleEvent({
      phase: "after_approval_decision",
      approvalId: decidedApproval.id,
      kind: decidedApproval.kind,
      status: decidedApproval.status,
      requestedBy: decidedApproval.requestedBy,
      decidedBy
    });

    let actionResult: unknown = undefined;
    try {
      actionResult = await applyApprovalDecisionEffects(decidedApproval);
    } catch (error) {
      response.status(502).json({
        approval: sanitizeApprovalRecord(decidedApproval),
        workflow: decisionResult.workflow,
        step: decisionResult.step,
        error: "approval_effect_failed",
        message: error instanceof Error ? error.message : String(error)
      });
      return;
    }

    response.json({
      approval: sanitizeApprovalRecord(decidedApproval),
      workflow: decisionResult.workflow,
      step: decisionResult.step,
      action:
        actionResult && typeof actionResult === "object" && "payload" in actionResult
          ? sanitizeOperatorActionRecord(
              actionResult as typeof actionResult & { payload: Record<string, unknown> }
            )
          : actionResult
    });
    try {
      await onApprovalWorkflowUpdated?.({
        approvalId: approval.id,
        reason: "decision",
        approval: decidedApproval
      });
    } catch {
      // Ignore callback failures to keep API cancellation path stable.
    }
  });

  app.post("/api/approvals/cancel-stale", async (request, response) => {
    const body =
      typeof request.body === "object" && request.body !== null
        ? (request.body as Record<string, unknown>)
        : {};
    const olderThanMinutesRaw = Number(body.olderThanMinutes ?? 60);
    const olderThanMinutes = Number.isFinite(olderThanMinutesRaw) ? Math.max(0, Math.round(olderThanMinutesRaw)) : 60;
    const decidedBy =
      typeof body.decidedBy === "string" && body.decidedBy.trim().length > 0 ? body.decidedBy.trim() : "system";
    const reasonPrefix =
      typeof body.reasonPrefix === "string" && body.reasonPrefix.trim().length > 0
        ? body.reasonPrefix.trim()
        : "stale pending cleanup";
    const limitRaw = Number(body.limit ?? 200);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(2000, Math.round(limitRaw))) : 200;
    const requestedByFilter =
      typeof body.requestedBy === "string" && body.requestedBy.trim().length > 0 ? body.requestedBy.trim() : undefined;
    const dryRun = body.dryRun === true;

    const thresholdMs = Date.now() - olderThanMinutes * 60 * 1000;
    const approvals = store.listApprovals(2000);
    const candidates = approvals
      .filter((approval) => {
        if (approval.status !== "pending") {
          return false;
        }
        if (requestedByFilter && approval.requestedBy !== requestedByFilter) {
          return false;
        }
        const updatedMs = Date.parse(approval.updatedAt);
        if (!Number.isFinite(updatedMs)) {
          return false;
        }
        return updatedMs <= thresholdMs;
      })
      .slice(0, limit);

    const cancelled: string[] = [];
    const skipped: Array<{ approvalId: string; reason: string }> = [];
    const errors: Array<{ approvalId: string; error: string }> = [];

    if (dryRun) {
      response.json({
        dryRun: true,
        scanned: approvals.length,
        candidates: candidates.length,
        candidateApprovalIds: candidates.map((item) => item.id),
        cancelledCount: 0,
        cancelledApprovalIds: [],
        skipped,
        errors
      });
      return;
    }

    for (const approval of candidates) {
      const pendingStep = store.getPendingApprovalWorkflowStep(approval.id);
      if (!pendingStep) {
        skipped.push({
          approvalId: approval.id,
          reason: "approval_workflow_has_no_pending_step"
        });
        continue;
      }

      await safeEmitApprovalLifecycleEvent({
        phase: "before_approval_decision",
        approvalId: approval.id,
        kind: approval.kind,
        status: approval.status,
        requestedBy: approval.requestedBy,
        decidedBy
      });

      let decisionResult:
        | ReturnType<typeof store.decideApprovalWorkflowStep>
        | undefined;
      try {
        decisionResult = store.decideApprovalWorkflowStep({
          approvalId: approval.id,
          stepId: pendingStep.step.id,
          status: "rejected",
          decidedBy,
          decisionNote: `${reasonPrefix}: ${olderThanMinutes}m`
        });
      } catch (error) {
        errors.push({
          approvalId: approval.id,
          error: error instanceof Error ? error.message : String(error)
        });
        continue;
      }

      const decidedApproval = decisionResult.approval ?? store.getApproval(approval.id) ?? approval;
      await safeEmitApprovalLifecycleEvent({
        phase: "after_approval_decision",
        approvalId: decidedApproval.id,
        kind: decidedApproval.kind,
        status: decidedApproval.status,
        requestedBy: decidedApproval.requestedBy,
        decidedBy
      });

      try {
        await applyApprovalDecisionEffects(decidedApproval);
      } catch (error) {
        errors.push({
          approvalId: approval.id,
          error: error instanceof Error ? error.message : String(error)
        });
        continue;
      }

      cancelled.push(approval.id);
      try {
        await onApprovalWorkflowUpdated?.({
          approvalId: approval.id,
          reason: "decision",
          approval: decidedApproval
        });
      } catch {
        // keep cleanup flow best-effort
      }
    }

    response.json({
      dryRun: false,
      scanned: approvals.length,
      candidates: candidates.length,
      cancelledCount: cancelled.length,
      cancelledApprovalIds: cancelled,
      skipped,
      errors
    });
  });

  app.get("/api/operator-actions", (_request, response) => {
    response.json(store.listOperatorActions(100).map((action) => sanitizeOperatorActionRecord(action)));
  });
}

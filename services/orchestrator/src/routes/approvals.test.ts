import express from "express";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ApprovalRecord,
  ApprovalWorkflowRecord,
  ApprovalWorkflowStepRecord,
  VinkoStore
} from "@vinko/shared";
import { registerApprovalRoutes } from "./approvals.js";

type ApprovalWorkflowUpdatedInput = {
  approvalId: string;
  stepId?: string | undefined;
  reason: "decision" | "escalation";
  approval?: ApprovalRecord | undefined;
};

type ApprovalWorkflowUpdatedHandler = (input: ApprovalWorkflowUpdatedInput) => Promise<void> | void;

function buildApproval(patch: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return {
    id: "apr_1",
    kind: "install_skill",
    summary: "approval summary",
    payload: {},
    status: "pending",
    requestedBy: "ou_owner",
    createdAt: "2026-04-07T00:00:00.000Z",
    updatedAt: "2026-04-07T00:00:00.000Z",
    ...patch
  };
}

function buildWorkflow(patch: Partial<ApprovalWorkflowRecord> = {}): ApprovalWorkflowRecord {
  return {
    id: "wf_1",
    approvalId: "apr_1",
    status: "pending",
    currentStepIndex: 0,
    createdAt: "2026-04-07T00:00:00.000Z",
    updatedAt: "2026-04-07T00:00:00.000Z",
    ...patch
  };
}

function buildStep(patch: Partial<ApprovalWorkflowStepRecord> = {}): ApprovalWorkflowStepRecord {
  return {
    id: "step_1",
    workflowId: "wf_1",
    stepIndex: 0,
    roleId: "ceo",
    status: "pending",
    createdAt: "2026-04-07T00:00:00.000Z",
    updatedAt: "2026-04-07T00:00:00.000Z",
    ...patch
  };
}

function createApprovalRoutesApp(
  store: VinkoStore,
  hooks?: { onUpdated?: ApprovalWorkflowUpdatedHandler }
): express.Express {
  const app = express();
  app.use(express.json());
  const deps = {
    store,
    sanitizeApprovalRecord: <T extends { payload: Record<string, unknown> }>(approval: T) => approval,
    sanitizeOperatorActionRecord: <T extends { payload: Record<string, unknown> }>(action: T) => action,
    ensureApprovalWorkflowForRecord: () => ({
      workflow: buildWorkflow(),
      steps: [buildStep()]
    }),
    safeEmitApprovalLifecycleEvent: async () => {},
    applyApprovalDecisionEffects: async () => ({ ok: true })
  };
  if (hooks?.onUpdated) {
    Object.assign(deps, {
      onApprovalWorkflowUpdated: hooks.onUpdated
    });
  }
  registerApprovalRoutes(app, deps);
  return app;
}

async function withServer(app: express.Express, fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("listening", () => resolve());
      server.once("error", reject);
    });
    const address = server.address() as AddressInfo | null;
    if (!address) {
      throw new Error("server_address_unavailable");
    }
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("approval routes", () => {
  it("returns 404 when cancelling unknown approval", async () => {
    const store = {
      getApproval: vi.fn(() => undefined)
    } as unknown as VinkoStore;
    const app = createApprovalRoutesApp(store);

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/approvals/apr_missing/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({})
      });
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: "approval_not_found" });
    });
  });

  it("cancels approval through pending workflow step", async () => {
    const approval = buildApproval();
    const pendingStep = { workflow: buildWorkflow(), step: buildStep() };
    const onUpdated = vi.fn<ApprovalWorkflowUpdatedHandler>(async () => {});

    const store = {
      getApproval: vi.fn(() => approval),
      getPendingApprovalWorkflowStep: vi.fn(() => pendingStep),
      decideApprovalWorkflowStep: vi.fn(() => ({
        workflow: buildWorkflow({ status: "rejected" }),
        step: buildStep({ status: "rejected", decidedBy: "system" }),
        approval: buildApproval({
          status: "rejected",
          decidedBy: "system",
          decisionNote: "cancelled: stale",
          decidedAt: "2026-04-07T00:01:00.000Z",
          updatedAt: "2026-04-07T00:01:00.000Z"
        })
      }))
    } as unknown as VinkoStore;
    const app = createApprovalRoutesApp(store, { onUpdated });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/approvals/${approval.id}/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decidedBy: "system", reason: "stale" })
      });

      expect(response.status).toBe(200);
      const payload = (await response.json()) as { approval: { status: string; decidedBy?: string } };
      expect(payload.approval.status).toBe("rejected");
      expect(payload.approval.decidedBy).toBe("system");
    });

    expect(onUpdated).toHaveBeenCalledTimes(1);
    const firstCallArg = onUpdated.mock.calls[0]?.[0];
    expect(firstCallArg).toMatchObject({
      approvalId: approval.id,
      reason: "decision",
      approval: expect.objectContaining({
        id: approval.id,
        status: "rejected"
      })
    });
  });

  it("dry-runs stale approval cleanup and returns candidates", async () => {
    const now = Date.now();
    const oldIso = new Date(now - 2 * 60 * 60 * 1000).toISOString();
    const newIso = new Date(now - 10 * 60 * 1000).toISOString();
    const store = {
      listApprovals: vi.fn(() => [
        buildApproval({ id: "apr_old", status: "pending", updatedAt: oldIso }),
        buildApproval({ id: "apr_new", status: "pending", updatedAt: newIso }),
        buildApproval({ id: "apr_done", status: "approved", updatedAt: oldIso })
      ])
    } as unknown as VinkoStore;
    const app = createApprovalRoutesApp(store);

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/approvals/cancel-stale`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ olderThanMinutes: 60, dryRun: true })
      });
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        dryRun: boolean;
        candidates: number;
        candidateApprovalIds: string[];
        cancelledCount: number;
      };
      expect(payload.dryRun).toBe(true);
      expect(payload.candidates).toBe(1);
      expect(payload.candidateApprovalIds).toEqual(["apr_old"]);
      expect(payload.cancelledCount).toBe(0);
    });
  });

  it("cancels stale approvals in batch mode", async () => {
    const now = Date.now();
    const oldIso = new Date(now - 2 * 60 * 60 * 1000).toISOString();
    const approvals = [buildApproval({ id: "apr_1", status: "pending", updatedAt: oldIso })];
    const store = {
      listApprovals: vi.fn(() => approvals),
      getPendingApprovalWorkflowStep: vi.fn(() => ({
        workflow: buildWorkflow(),
        step: buildStep()
      })),
      decideApprovalWorkflowStep: vi.fn(({ approvalId }: { approvalId: string }) => ({
        workflow: buildWorkflow({ approvalId, status: "rejected" }),
        step: buildStep({ status: "rejected", decidedBy: "system" }),
        approval: buildApproval({
          id: approvalId,
          status: "rejected",
          decidedBy: "system",
          updatedAt: new Date().toISOString()
        })
      })),
      getApproval: vi.fn((approvalId: string) => approvals.find((item) => item.id === approvalId))
    } as unknown as VinkoStore;
    const app = createApprovalRoutesApp(store);

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/approvals/cancel-stale`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ olderThanMinutes: 60, dryRun: false, decidedBy: "system" })
      });
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        dryRun: boolean;
        cancelledCount: number;
        cancelledApprovalIds: string[];
        errors: unknown[];
      };
      expect(payload.dryRun).toBe(false);
      expect(payload.cancelledCount).toBe(1);
      expect(payload.cancelledApprovalIds).toEqual(["apr_1"]);
      expect(payload.errors).toEqual([]);
    });
  });
});

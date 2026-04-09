import express from "express";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GoalRunRecord, VinkoStore } from "@vinko/shared";
import { registerGoalRunRoutes } from "./goal-runs.js";

function buildGoalRun(patch: Partial<GoalRunRecord> = {}): GoalRunRecord {
  return {
    id: "goal_1",
    source: "feishu",
    objective: "build site",
    status: "queued",
    currentStage: "discover",
    requestedBy: "ou_owner",
    chatId: "chat_1",
    language: "zh-CN",
    metadata: {},
    context: {},
    retryCount: 0,
    maxRetries: 2,
    awaitingInputFields: [],
    createdAt: "2026-04-07T00:00:00.000Z",
    updatedAt: "2026-04-07T00:00:00.000Z",
    ...patch
  };
}

function createGoalRunRoutesApp(store: VinkoStore): express.Express {
  const app = express();
  app.use(express.json());
  registerGoalRunRoutes(app, { store });
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

describe("goal-run routes", () => {
  it("dry-runs stale goal-run cleanup", async () => {
    const now = Date.now();
    const stale = buildGoalRun({
      id: "goal_stale",
      status: "running",
      updatedAt: new Date(now - 5 * 60 * 60 * 1000).toISOString()
    });
    const fresh = buildGoalRun({
      id: "goal_fresh",
      status: "running",
      updatedAt: new Date(now - 5 * 60 * 1000).toISOString()
    });
    const store = {
      listGoalRuns: vi.fn(() => [stale, fresh])
    } as unknown as VinkoStore;
    const app = createGoalRunRoutesApp(store);

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/goal-runs/cancel-stale`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ olderThanMinutes: 120, dryRun: true })
      });
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        dryRun: boolean;
        candidates: number;
        candidateGoalRunIds: string[];
      };
      expect(payload.dryRun).toBe(true);
      expect(payload.candidates).toBe(1);
      expect(payload.candidateGoalRunIds).toEqual(["goal_stale"]);
    });
  });

  it("cancels stale goal-runs in batch mode", async () => {
    const now = Date.now();
    const stale = buildGoalRun({
      id: "goal_cancel_1",
      status: "awaiting_input",
      updatedAt: new Date(now - 4 * 60 * 60 * 1000).toISOString()
    });
    const cancelGoalRun = vi.fn((goalRunId: string) =>
      goalRunId === stale.id ? { ...stale, status: "cancelled" as const } : undefined
    );
    const appendGoalRunTimelineEvent = vi.fn();
    const store = {
      listGoalRuns: vi.fn(() => [stale]),
      cancelGoalRun,
      appendGoalRunTimelineEvent
    } as unknown as VinkoStore;
    const app = createGoalRunRoutesApp(store);

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/goal-runs/cancel-stale`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          olderThanMinutes: 60,
          statuses: ["awaiting_input"],
          dryRun: false
        })
      });
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        dryRun: boolean;
        cancelledCount: number;
        cancelledGoalRunIds: string[];
        errors: unknown[];
      };
      expect(payload.dryRun).toBe(false);
      expect(payload.cancelledCount).toBe(1);
      expect(payload.cancelledGoalRunIds).toEqual(["goal_cancel_1"]);
      expect(payload.errors).toEqual([]);
    });

    expect(cancelGoalRun).toHaveBeenCalledTimes(1);
    expect(appendGoalRunTimelineEvent).toHaveBeenCalledTimes(1);
  });
});

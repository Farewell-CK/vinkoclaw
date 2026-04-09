import express from "express";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskRecord, VinkoStore } from "@vinko/shared";
import { registerTaskRoutes } from "./tasks.js";

function buildTask(patch: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task_1",
    sessionId: "session_1",
    source: "feishu",
    roleId: "ceo",
    title: "测试任务",
    instruction: "do work",
    status: "queued",
    priority: 80,
    requestedBy: "ou_owner",
    chatId: "chat_1",
    metadata: {},
    createdAt: "2026-04-07T00:00:00.000Z",
    updatedAt: "2026-04-07T00:00:00.000Z",
    ...patch
  };
}

function createTaskRoutesApp(store: VinkoStore): express.Express {
  const app = express();
  app.use(express.json());
  registerTaskRoutes(app, {
    store,
    ensureInboundSession: () => undefined,
    selectRoleFromText: () => "ceo",
    shorten: (value: string) => value,
    normalizeAttachments: () => [],
    handleInboundMessage: () => Promise.resolve({ type: "task_queued" as const, message: "ok", taskId: "t_mock" }),
    buildAutoSplitSpecs: () => [],
    splitTaskIntoChildren: () => []
  });
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

describe("task routes", () => {
  it("returns 404 for cancelling unknown task", async () => {
    const store = {
      getTask: vi.fn(() => undefined),
      listToolRunsByTask: vi.fn(() => []),
      listTaskChildren: vi.fn(() => [])
    } as unknown as VinkoStore;
    const app = createTaskRoutesApp(store);

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/tasks/task_missing/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({})
      });

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: "task_not_found" });
    });
  });

  it("cancels pending task and appends session event", async () => {
    const task = buildTask();
    const cancelledTask = buildTask({
      status: "cancelled",
      updatedAt: "2026-04-07T00:10:00.000Z"
    });

    const appendSessionMessage = vi.fn();
    const store = {
      getTask: vi.fn(() => task),
      cancelTask: vi.fn(() => cancelledTask),
      appendSessionMessage,
      listToolRunsByTask: vi.fn(() => []),
      listTaskChildren: vi.fn(() => [])
    } as unknown as VinkoStore;
    const app = createTaskRoutesApp(store);

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/tasks/${task.id}/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "用户手动取消" })
      });

      expect(response.status).toBe(200);
      const payload = (await response.json()) as Record<string, unknown>;
      expect(payload.status).toBe("cancelled");
      expect(payload.failureCategory).toBe("cancelled");
    });

    expect(appendSessionMessage).toHaveBeenCalledTimes(1);
    const input = appendSessionMessage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input.sessionId).toBe("session_1");
    expect(input.content).toBe("已取消任务：测试任务");
  });

  it("rejects cancelling finished task", async () => {
    const task = buildTask({ status: "completed" });
    const store = {
      getTask: vi.fn(() => task),
      listToolRunsByTask: vi.fn(() => []),
      listTaskChildren: vi.fn(() => [])
    } as unknown as VinkoStore;
    const app = createTaskRoutesApp(store);

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/tasks/${task.id}/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({})
      });

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        error: "task_not_cancellable",
        status: "completed"
      });
    });
  });

  it("dry-runs stale task cleanup", async () => {
    const now = Date.now();
    const staleTask = buildTask({
      id: "task_stale",
      status: "queued",
      updatedAt: new Date(now - 2 * 60 * 60 * 1000).toISOString()
    });
    const freshTask = buildTask({
      id: "task_fresh",
      status: "queued",
      updatedAt: new Date(now - 5 * 60 * 1000).toISOString()
    });
    const store = {
      listTasks: vi.fn(() => [staleTask, freshTask]),
      listToolRunsByTask: vi.fn(() => []),
      listTaskChildren: vi.fn(() => [])
    } as unknown as VinkoStore;
    const app = createTaskRoutesApp(store);

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/tasks/cancel-stale`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ olderThanMinutes: 60, dryRun: true })
      });
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        dryRun: boolean;
        candidates: number;
        candidateTaskIds: string[];
        cancelledCount: number;
      };
      expect(payload.dryRun).toBe(true);
      expect(payload.candidates).toBe(1);
      expect(payload.candidateTaskIds).toEqual(["task_stale"]);
      expect(payload.cancelledCount).toBe(0);
    });
  });

  it("cancels stale tasks in batch", async () => {
    const now = Date.now();
    const staleRunningTask = buildTask({
      id: "task_running_stale",
      status: "running",
      sessionId: "session_2",
      title: "stale running",
      updatedAt: new Date(now - 3 * 60 * 60 * 1000).toISOString()
    });
    const appendSessionMessage = vi.fn();
    const cancelTask = vi.fn((taskId: string) =>
      taskId === staleRunningTask.id ? { ...staleRunningTask, status: "cancelled" } : undefined
    );
    const store = {
      listTasks: vi.fn(() => [staleRunningTask]),
      cancelTask,
      appendSessionMessage,
      listToolRunsByTask: vi.fn(() => []),
      listTaskChildren: vi.fn(() => [])
    } as unknown as VinkoStore;
    const app = createTaskRoutesApp(store);

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/tasks/cancel-stale`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ olderThanMinutes: 60, includeRunning: true, dryRun: false })
      });
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        dryRun: boolean;
        cancelledCount: number;
        cancelledTaskIds: string[];
        errors: unknown[];
      };
      expect(payload.dryRun).toBe(false);
      expect(payload.cancelledCount).toBe(1);
      expect(payload.cancelledTaskIds).toEqual(["task_running_stale"]);
      expect(payload.errors).toEqual([]);
    });

    expect(cancelTask).toHaveBeenCalledTimes(1);
    expect(appendSessionMessage).toHaveBeenCalledTimes(1);
  });
});

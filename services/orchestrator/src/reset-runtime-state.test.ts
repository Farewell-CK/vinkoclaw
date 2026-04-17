import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

type RuntimeSnapshot = {
  busyTasks: number;
  awaitingInputTasks: number;
  busyGoalRuns: number;
  pendingApprovals: number;
};

type ResettableTask = {
  id: string;
  status: string;
};

let getDbSnapshot: (dbPath: string) => RuntimeSnapshot;
let listResettableTaskIds: (dbPath: string) => ResettableTask[];

beforeAll(async () => {
  const modulePath = "../../../scripts/reset-runtime-state.mjs";
  const mod = (await import(modulePath)) as {
    getDbSnapshot: (dbPath: string) => RuntimeSnapshot;
    listResettableTaskIds: (dbPath: string) => ResettableTask[];
  };
  getDbSnapshot = mod.getDbSnapshot;
  listResettableTaskIds = mod.listResettableTaskIds;
});

function createRuntimeDb(rows: {
  tasks?: Array<{ id: string; status: string }>;
  goalRuns?: Array<{ id: string; status: string }>;
  approvals?: Array<{ id: string; status: string }>;
} = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "vinkoclaw-reset-test-"));
  const dbPath = path.join(dir, "runtime.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE tasks (id TEXT PRIMARY KEY, status TEXT, updated_at TEXT, created_at TEXT);
    CREATE TABLE goal_runs (id TEXT PRIMARY KEY, status TEXT);
    CREATE TABLE approvals (id TEXT PRIMARY KEY, status TEXT);
    CREATE TABLE sessions (id TEXT PRIMARY KEY);
    CREATE TABLE workspace_memory (id TEXT PRIMARY KEY);
  `);
  for (const task of rows.tasks ?? []) {
    db.prepare("INSERT INTO tasks (id, status, updated_at, created_at) VALUES (?, ?, ?, ?)")
      .run(task.id, task.status, "2026-04-17T08:00:00.000Z", "2026-04-17T08:00:00.000Z");
  }
  for (const run of rows.goalRuns ?? []) {
    db.prepare("INSERT INTO goal_runs (id, status) VALUES (?, ?)").run(run.id, run.status);
  }
  for (const approval of rows.approvals ?? []) {
    db.prepare("INSERT INTO approvals (id, status) VALUES (?, ?)").run(approval.id, approval.status);
  }
  db.close();
  return {
    dbPath,
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

describe("reset-runtime-state helpers", () => {
  it("treats paused_input as busy runtime state", () => {
    const runtime = createRuntimeDb({
      tasks: [
        { id: "task_queued", status: "queued" },
        { id: "task_paused", status: "paused_input" },
        { id: "task_completed", status: "completed" }
      ],
      goalRuns: [{ id: "goal_running", status: "running" }],
      approvals: [{ id: "approval_pending", status: "pending" }]
    });
    cleanups.push(runtime.cleanup);

    const snapshot = getDbSnapshot(runtime.dbPath);

    expect(snapshot.busyTasks).toBe(2);
    expect(snapshot.awaitingInputTasks).toBe(1);
    expect(snapshot.busyGoalRuns).toBe(1);
    expect(snapshot.pendingApprovals).toBe(1);
  });

  it("lists paused_input tasks for reset alongside queued/running tasks", () => {
    const runtime = createRuntimeDb({
      tasks: [
        { id: "task_running", status: "running" },
        { id: "task_paused", status: "paused_input" },
        { id: "task_done", status: "completed" }
      ]
    });
    cleanups.push(runtime.cleanup);

    expect(listResettableTaskIds(runtime.dbPath)).toEqual([
      { id: "task_running", status: "running" },
      { id: "task_paused", status: "paused_input" }
    ]);
  });
});

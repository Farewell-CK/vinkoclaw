import { describe, expect, it } from "vitest";
import type { GoalRunRecord, TaskRecord, ToolRunRecord, VinkoStore } from "@vinko/shared";
import {
  enrichGoalRunRecord,
  enrichTaskRecord,
  summarizeLatencyMetrics
} from "./response-utils.js";

function buildTask(patch: Partial<TaskRecord>): TaskRecord {
  return {
    id: "task_1",
    source: "control-center",
    roleId: "ceo",
    title: "task",
    instruction: "do task",
    status: "completed",
    priority: 80,
    metadata: {},
    createdAt: "2026-04-06T00:00:00.000Z",
    updatedAt: "2026-04-06T00:00:00.000Z",
    ...patch
  };
}

function buildGoalRun(patch: Partial<GoalRunRecord>): GoalRunRecord {
  return {
    id: "goal_1",
    source: "control-center",
    objective: "build frontend and backend with tests",
    status: "completed",
    currentStage: "accept",
    language: "zh-CN",
    metadata: {},
    context: {},
    retryCount: 0,
    maxRetries: 2,
    awaitingInputFields: [],
    createdAt: "2026-04-06T00:00:00.000Z",
    updatedAt: "2026-04-06T00:00:00.000Z",
    ...patch
  };
}

function buildToolRun(patch: Partial<ToolRunRecord>): ToolRunRecord {
  return {
    id: "tool_1",
    taskId: "task_1",
    roleId: "frontend",
    providerId: "opencode",
    title: "tool",
    instruction: "run",
    command: "opencode",
    args: ["exec"],
    riskLevel: "low",
    status: "completed",
    approvalStatus: "not_required",
    createdAt: "2026-04-06T00:00:00.000Z",
    updatedAt: "2026-04-06T00:00:00.000Z",
    ...patch
  };
}

function createMockStore(input?: {
  toolRunsByTask?: Record<string, ToolRunRecord[]>;
  childrenByParent?: Record<string, TaskRecord[]>;
}): VinkoStore {
  return {
    listToolRunsByTask: (taskId: string) => input?.toolRunsByTask?.[taskId] ?? [],
    listTaskChildren: (parentTaskId: string) => input?.childrenByParent?.[parentTaskId] ?? []
  } as unknown as VinkoStore;
}

describe("response-utils", () => {
  it("extracts task completion evidence and collaboration role status", () => {
    const task = buildTask({
      id: "parent_task",
      roleId: "ceo",
      status: "completed",
      metadata: {
        collaborationMode: true,
        collaborationId: "collab_1",
        toolChangedFiles: ["frontend/app.tsx, backend/api.ts"]
      },
      result: {
        summary: "CHANGED_FILES: qa/plan.md",
        deliverable: "产物文件：docs/spec.md",
        citations: [],
        followUps: []
      }
    });
    const children: TaskRecord[] = [
      buildTask({
        id: "child_1",
        roleId: "frontend",
        status: "completed",
        metadata: { collaborationId: "collab_1" }
      }),
      buildTask({
        id: "child_2",
        roleId: "backend",
        status: "failed",
        metadata: { collaborationId: "collab_1" }
      })
    ];
    const store = createMockStore({
      toolRunsByTask: {
        parent_task: [
          buildToolRun({
            taskId: "parent_task",
            outputText: "CHANGED_FILES: infra/deploy.yml"
          })
        ]
      },
      childrenByParent: {
        parent_task: children
      }
    });

    const enriched = enrichTaskRecord(store, task);
    expect(enriched.failureCategory).toBe("none");
    const completionEvidence = enriched.completionEvidence as Record<string, unknown>;
    const artifactFiles = completionEvidence.artifactFiles as string[];
    expect(artifactFiles).toEqual([
      "backend/api.ts",
      "docs/spec.md",
      "frontend/app.tsx",
      "infra/deploy.yml",
      "qa/plan.md"
    ]);
    const collaboration = completionEvidence.collaboration as Record<string, unknown>;
    expect(collaboration.completedRoles).toEqual(["frontend"]);
    expect(collaboration.failedRoles).toEqual(["backend"]);
  });

  it("builds goal-run failure category and retry policy", () => {
    const run = buildGoalRun({
      status: "failed",
      currentStage: "verify",
      errorText: "verify failed: required collaboration roles not satisfied (missing=backend)",
      retryCount: 2,
      maxRetries: 2,
      context: {
        last_task_status: "completed",
        last_collaboration_enabled: true,
        last_completed_roles: ["frontend"],
        last_failed_roles: ["backend"],
        last_artifact_files: ["frontend/app.tsx"]
      }
    });
    const enriched = enrichGoalRunRecord(run);
    expect(enriched.failureCategory).toBe("validation");
    expect((enriched.retryPolicyApplied as Record<string, unknown>).exhausted).toBe(true);
    const evidence = enriched.completionEvidence as Record<string, unknown>;
    expect(evidence.collaborationEnabled).toBe(true);
    expect(evidence.completedRoles).toEqual(["frontend"]);
    expect(evidence.failedRoles).toEqual(["backend"]);
  });

  it("computes p50/p95 latency metrics", () => {
    const tasks: TaskRecord[] = [
      buildTask({
        status: "completed",
        createdAt: "2026-04-06T00:00:00.000Z",
        startedAt: "2026-04-06T00:00:00.000Z",
        completedAt: "2026-04-06T00:00:10.000Z"
      }),
      buildTask({
        id: "task_2",
        status: "failed",
        createdAt: "2026-04-06T00:00:00.000Z",
        startedAt: "2026-04-06T00:00:00.000Z",
        completedAt: "2026-04-06T00:00:30.000Z"
      })
    ];
    const goalRuns: GoalRunRecord[] = [
      buildGoalRun({
        status: "completed",
        createdAt: "2026-04-06T00:00:00.000Z",
        startedAt: "2026-04-06T00:00:00.000Z",
        completedAt: "2026-04-06T00:01:00.000Z"
      }),
      buildGoalRun({
        id: "goal_2",
        status: "failed",
        createdAt: "2026-04-06T00:00:00.000Z",
        startedAt: "2026-04-06T00:00:00.000Z",
        completedAt: "2026-04-06T00:02:00.000Z"
      })
    ];
    const latency = summarizeLatencyMetrics({
      tasks,
      goalRuns,
      sinceMs: Date.parse("2026-04-05T00:00:00.000Z")
    });
    expect(latency.taskP50Ms).toBe(10000);
    expect(latency.taskP95Ms).toBe(30000);
    expect(latency.goalRunP50Ms).toBe(60000);
    expect(latency.goalRunP95Ms).toBe(120000);
  });
});

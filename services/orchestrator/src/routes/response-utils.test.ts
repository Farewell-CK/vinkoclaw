import { describe, expect, it } from "vitest";
import type { GoalRunRecord, SessionRecord, SkillBindingRecord, TaskRecord, ToolRunRecord, VinkoStore } from "@vinko/shared";
import {
  enrichGoalRunRecord,
  enrichGoalRunRecordWithHarnessEvidence,
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

function buildSession(patch: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "session_1",
    source: "feishu",
    sourceKey: "chat_1",
    title: "project session",
    status: "active",
    metadata: {},
    createdAt: "2026-04-06T00:00:00.000Z",
    updatedAt: "2026-04-06T00:00:00.000Z",
    lastMessageAt: "2026-04-06T00:00:00.000Z",
    ...patch
  };
}

function buildSkillBinding(patch: Partial<SkillBindingRecord> = {}): SkillBindingRecord {
  return {
    id: "binding_1",
    scope: "role",
    scopeId: "product",
    skillId: "prd-writer",
    status: "enabled",
    verificationStatus: "verified",
    config: {},
    createdAt: "2026-04-06T00:00:00.000Z",
    updatedAt: "2026-04-06T00:00:00.000Z",
    ...patch
  };
}

function createMockStore(input?: {
  toolRunsByTask?: Record<string, ToolRunRecord[]>;
  childrenByParent?: Record<string, TaskRecord[]>;
  latestGoalRunHandoffs?: Record<string, { id: string; artifact: Record<string, unknown> } | undefined>;
  sessionsById?: Record<string, SessionRecord | undefined>;
  tasksById?: Record<string, TaskRecord | undefined>;
  roleSkills?: Record<string, SkillBindingRecord[]>;
  sessionMessagesBySessionId?: Record<string, unknown[]>;
}): VinkoStore {
  return {
    listToolRunsByTask: (taskId: string) => input?.toolRunsByTask?.[taskId] ?? [],
    listTaskChildren: (parentTaskId: string) => input?.childrenByParent?.[parentTaskId] ?? [],
    getLatestGoalRunHandoff: (goalRunId: string) => input?.latestGoalRunHandoffs?.[goalRunId] as
      | { id: string; artifact: Record<string, unknown> }
      | undefined,
    getSession: (sessionId: string) => input?.sessionsById?.[sessionId],
    getTask: (taskId: string) => input?.tasksById?.[taskId],
    resolveSkillsForRole: (roleId: string) => input?.roleSkills?.[roleId] ?? [],
    listSessionMessages: (sessionId: string) => input?.sessionMessagesBySessionId?.[sessionId] ?? []
  } as unknown as VinkoStore;
}

describe("response-utils", () => {
  it("extracts task completion evidence and collaboration role status", () => {
    const task = buildTask({
      id: "parent_task",
      roleId: "ceo",
      status: "completed",
      metadata: {
        deliverableMode: "artifact_required",
        collaborationMode: true,
        collaborationId: "collab_1",
        collaborationPhase: "await_user",
        collaborationConvergenceMode: "await_user",
        collaborationTriggerReason: "manual_trigger",
        collaborationStatus: "await_user",
        collaborationResumedAt: "2026-04-12T02:00:00.000Z",
        collaborationPendingQuestions: ["请确认目标用户", "请补充交付格式"],
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
    expect(enriched.failureCategory).toBe("input_required");
    expect(enriched.displayStatus).toBe("await_user");
    const completionEvidence = enriched.completionEvidence as Record<string, unknown>;
    expect(completionEvidence.deliverableMode).toBe("artifact_required");
    expect(completionEvidence.deliverableContractViolated).toBe(false);
    const artifactFiles = completionEvidence.artifactFiles as string[];
    expect(artifactFiles).toEqual([
      "backend/api.ts",
      "docs/spec.md",
      "frontend/app.tsx",
      "infra/deploy.yml",
      "qa/plan.md"
    ]);
    const collaboration = completionEvidence.collaboration as Record<string, unknown>;
    expect(collaboration.phase).toBe("await_user");
    expect(collaboration.convergenceMode).toBe("await_user");
    expect(collaboration.triggerReason).toBe("manual_trigger");
    expect(collaboration.status).toBe("await_user");
    expect(collaboration.resumedAt).toBe("2026-04-12T02:00:00.000Z");
    expect(collaboration.pendingQuestions).toEqual(["请确认目标用户", "请补充交付格式"]);
    expect(collaboration.childRunning).toBe(0);
    expect(collaboration.childPending).toBe(0);
    expect(collaboration.completedRoles).toEqual(["frontend"]);
    expect(collaboration.failedRoles).toEqual(["backend"]);
  });

  it("surfaces resuming status while collaboration is resuming from user input", () => {
    const task = buildTask({
      id: "resume_task",
      status: "queued",
      metadata: {
        collaborationMode: true,
        collaborationId: "collab_resume",
        collaborationPhase: "converge",
        collaborationStatus: "active",
        collaborationResumeRequested: true,
        collaborationResumedAt: "2026-04-12T03:00:00.000Z"
      }
    });
    const store = createMockStore({
      childrenByParent: {
        resume_task: [
          buildTask({
            id: "child_running",
            roleId: "product",
            status: "running",
            metadata: { collaborationId: "collab_resume" }
          }),
          buildTask({
            id: "child_queued",
            roleId: "qa",
            status: "queued",
            metadata: { collaborationId: "collab_resume" }
          })
        ]
      }
    });

    const enriched = enrichTaskRecord(store, task);
    expect(enriched.displayStatus).toBe("resuming");
    expect(enriched.failureCategory).toBe("none");
    const collaboration = (enriched.completionEvidence as Record<string, unknown>).collaboration as Record<string, unknown>;
    expect(collaboration.status).toBe("active");
    expect(collaboration.resumeRequested).toBe(true);
    expect(collaboration.resumedAt).toBe("2026-04-12T03:00:00.000Z");
    expect(collaboration.childRunning).toBe(1);
    expect(collaboration.childPending).toBe(1);
  });

  it("surfaces deliverable contract violation metadata", () => {
    const task = buildTask({
      id: "artifact_violation",
      status: "failed",
      metadata: {
        deliverableMode: "artifact_required",
        deliverableContractViolated: true
      },
      errorText: "Deliverable contract violated: task requires a persisted artifact, but none was produced."
    });
    const enriched = enrichTaskRecord(createMockStore(), task);
    const completionEvidence = enriched.completionEvidence as Record<string, unknown>;
    expect(completionEvidence.deliverableMode).toBe("artifact_required");
    expect(completionEvidence.deliverableContractViolated).toBe(true);
    expect(enriched.failureCategory).toBe("runtime");
  });

  it("surfaces skill integration readiness metadata", () => {
    const task = buildTask({
      id: "skill_ready_task",
      status: "completed",
      metadata: {
        requestedSkillId: "prd-writer",
        requestedSkillName: "PRD Writer",
        requestedSkillTargetRoleId: "product",
        requestedSkillInstallState: "local_installable",
        requestedSkillRuntimeAvailable: true,
        requestedSkillRuntimeCheckedAt: "2026-04-13T00:00:00.000Z"
      }
    });
    const enriched = enrichTaskRecord(createMockStore(), task);
    const completionEvidence = enriched.completionEvidence as Record<string, unknown>;
    const skillIntegration = completionEvidence.skillIntegration as Record<string, unknown>;
    expect(skillIntegration.skillId).toBe("prd-writer");
    expect(skillIntegration.skillName).toBe("PRD Writer");
    expect(skillIntegration.targetRoleId).toBe("product");
    expect(skillIntegration.installState).toBe("local_installable");
    expect(skillIntegration.runtimeAvailable).toBe(true);
    expect(skillIntegration.checkedAt).toBe("2026-04-13T00:00:00.000Z");
    const suggestedAction = skillIntegration.suggestedAction as Record<string, unknown>;
    expect(suggestedAction.kind).toBe("install_skill");
    expect(suggestedAction.skillId).toBe("prd-writer");
    expect(suggestedAction.targetRoleId).toBe("product");
  });

  it("surfaces task skill harness evidence from runtime snapshot", () => {
    const task = buildTask({
      roleId: "product",
      metadata: {
        runtimeSkillBindings: [
          {
            skillId: "prd-writer",
            verificationStatus: "verified",
            source: "catalog",
            sourceLabel: "catalog",
            version: "1.0.0",
            runtimeAvailable: true
          },
          {
            skillId: "reflection-review",
            verificationStatus: "unverified",
            source: "catalog",
            sourceLabel: "catalog",
            version: "",
            runtimeAvailable: true
          }
        ]
      }
    });
    const enriched = enrichTaskRecord(createMockStore(), task);
    const completionEvidence = enriched.completionEvidence as Record<string, unknown>;
    const skills = completionEvidence.skills as Record<string, unknown>;
    expect(skills.roleId).toBe("product");
    expect(skills.total).toBe(2);
    expect(skills.verified).toBe(1);
    expect(skills.unverified).toBe(1);
    expect(skills.runtimeAvailable).toBe(2);
    expect(skills.bindings).toEqual([
      expect.objectContaining({ skillId: "prd-writer", verificationStatus: "verified" }),
      expect.objectContaining({ skillId: "reflection-review", verificationStatus: "unverified" })
    ]);
    const harness = completionEvidence.harness as Record<string, unknown>;
    expect(harness.grade).toBeTruthy();
    expect(typeof harness.score).toBe("number");
    expect(Array.isArray(harness.strengths)).toBe(true);
    expect(Array.isArray(harness.gaps)).toBe(true);
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
    expect(evidence.handoffArtifactPresent).toBe(false);
    expect(evidence.approvalGateHits).toBe(0);
    expect(evidence.resumeFromStageSupported).toBe(false);
    expect(evidence.stageFailureCategory).toBe("validation");
  });

  it("hydrates goal-run harness evidence from store", () => {
    const run = buildGoalRun({
      id: "goal_handoff_1",
      status: "completed",
      currentStage: "accept",
      sessionId: "session_1",
      context: {
        last_task_id: "task_1"
      }
    });
    const session = buildSession({
      metadata: {
        projectMemory: {
          currentGoal: "ship founder flow",
          currentStage: "accept",
          latestUserRequest: "继续",
          latestSummary: "已完成交付",
          unresolvedQuestions: [],
          nextActions: ["archive"],
          latestArtifacts: ["docs/founder-flow.md"],
          updatedAt: "2026-04-06T00:00:00.000Z",
          updatedBy: "system"
        }
      }
    });
    const lastTask = buildTask({
      id: "task_1",
      sessionId: "session_1",
      roleId: "product",
      metadata: {
        runtimeBackendUsed: "zhipu",
        runtimeModelUsed: "glm-5-turbo",
        runtimeToolLoopEnabled: true,
        runtimeToolRegistry: "default",
        runtimeRulesEngine: "default",
        runtimeSkillBindings: [
          {
            skillId: "prd-writer",
            verificationStatus: "verified",
            source: "catalog",
            sourceLabel: "catalog",
            runtimeAvailable: true
          }
        ]
      }
    });
    const store = createMockStore({
      latestGoalRunHandoffs: {
        [run.id]: {
          id: "handoff_1",
          artifact: {
            stage: "accept",
            summary: "done"
          }
        }
      },
      sessionsById: {
        session_1: session
      },
      tasksById: {
        task_1: lastTask
      },
      sessionMessagesBySessionId: {
        session_1: [{ id: "m1" }, { id: "m2" }, { id: "m3" }]
      }
    });

    const enriched = enrichGoalRunRecordWithHarnessEvidence(store, run, {
      traceCount: 3
    });
    const evidence = enriched.completionEvidence as Record<string, unknown>;
    expect(evidence.handoffArtifactPresent).toBe(true);
    expect(evidence.traceCount).toBe(3);
    const context = evidence.context as Record<string, unknown>;
    const runtime = evidence.runtime as Record<string, unknown>;
    const skills = evidence.skills as Record<string, unknown>;
    expect(context.sessionMessageCount).toBe(3);
    expect(runtime.lastTaskId).toBe("task_1");
    expect(skills.roleId).toBe("product");
    expect(skills.total).toBe(1);
    expect(skills.bindings).toEqual([expect.objectContaining({ skillId: "prd-writer" })]);
    const harness = evidence.harness as Record<string, unknown>;
    expect(harness.grade).toBeTruthy();
    expect(typeof harness.score).toBe("number");
    expect(Array.isArray(harness.strengths)).toBe(true);
  });

  it("attaches workflow summary/state to enriched goal runs", () => {
    const run = buildGoalRun({
      id: "goal_workflow_1",
      objective: "交付 founder 执行总结",
      status: "awaiting_input",
      currentStage: "discover",
      metadata: {
        workflowLabel: "Founder Weekly Recap",
        workflowSuccessCriteria: ["形成结构化总结"],
        workflowCompletionSignal: "Founder 可直接消费"
      },
      awaitingInputFields: ["本周营收"]
    });
    const store = createMockStore({
      latestGoalRunHandoffs: {
        goal_workflow_1: {
          id: "handoff_workflow_1",
          artifact: {
            summary: "已沉淀 recap 大纲",
            nextActions: ["补齐营收数字"],
            unresolvedQuestions: ["确认本周营收"],
            artifacts: ["reports/founder-recap.md"]
          }
        }
      }
    });

    const enriched = enrichGoalRunRecordWithHarnessEvidence(store, run) as Record<string, unknown>;
    expect(enriched.workflowSummary).toEqual(expect.stringContaining("**工作流**：Founder Weekly Recap"));
    expect(enriched.workflowSummary).toEqual(expect.stringContaining("**待补充**：本周营收；确认本周营收"));
    const workflowState = enriched.workflowState as Record<string, unknown>;
    expect(workflowState.nextStep).toBe("补齐营收数字");
    expect(workflowState.recentArtifacts).toEqual(["reports/founder-recap.md"]);
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

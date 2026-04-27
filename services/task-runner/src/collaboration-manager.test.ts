import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VinkoStore, type AgentCollaboration, type ReflectionNote, type TaskRecord, type TaskResult } from "@vinko/shared";
import { CollaborationManager } from "./collaboration-manager.js";

const tempDirs: string[] = [];

function createTestStore(): VinkoStore {
  const dir = mkdtempSync(path.join(tmpdir(), "vinkoclaw-collab-manager-"));
  tempDirs.push(dir);
  return new VinkoStore(path.join(dir, "test.sqlite"));
}

function createAwaitingParentTask(store: VinkoStore): TaskRecord {
  const session = store.ensureSession({
    source: "feishu",
    sourceKey: "chat:oc_1234567890abcdefghijklmn",
    title: "协作父任务会话"
  });
  return store.createTask({
    sessionId: session.id,
    source: "feishu",
    roleId: "ceo",
    title: "协作父任务",
    instruction: "请继续推进并完成交付",
    requestedBy: "ou_owner",
    chatId: "oc_1234567890abcdefghijklmn",
    metadata: {
      collaborationId: "collab-test-1",
      collaborationStatus: "await_user",
      collaborationPhase: "await_user",
      collaborationPendingQuestions: ["请确认用户画像", "请确认交付格式"],
      collaborationLatestUserReply: "目标用户是独立开发者",
      collaborationUserSupplements: [
        {
          text: "目标用户是独立开发者",
          requesterName: "owner",
          at: "2026-04-12T00:00:00.000Z"
        }
      ]
    }
  });
}

function createCollaborationHarnessFixture(store: VinkoStore): {
  collaboration: AgentCollaboration;
  manager: CollaborationManager;
  parentTask: TaskRecord;
} {
  const session = store.ensureSession({
    source: "system",
    sourceKey: `collab-harness-${Date.now()}-${Math.random()}`,
    title: "协作 harness 会话"
  });
  const parentTask = store.createTask({
    sessionId: session.id,
    source: "system",
    roleId: "cto",
    title: "协作交付项目",
    instruction: "请组织多角色完成交付",
    metadata: {
      collaborationStatus: "active",
      orchestrationMode: "main_agent"
    }
  });
  const collaboration: AgentCollaboration = {
    id: `collab-harness-${parentTask.id}`,
    parentTaskId: parentTask.id,
    sessionId: session.id,
    status: "active",
    participants: ["product", "backend", "qa"],
    facilitator: "cto",
    currentPhase: "aggregation",
    phaseResults: [],
    config: {
      maxRounds: 3,
      discussionTimeoutMs: 30_000,
      requireConsensus: false,
      pushIntermediateResults: true,
      autoAggregateOnComplete: true,
      aggregateTimeoutMs: 60_000
    },
    createdAt: "2026-04-12T00:00:00.000Z",
    updatedAt: "2026-04-12T00:00:00.000Z"
  };
  store.createAgentCollaboration(collaboration);
  return {
    collaboration,
    manager: new CollaborationManager({ store }),
    parentTask
  };
}

function createCompletedAggregationTask(
  store: VinkoStore,
  fixture: { collaboration: AgentCollaboration; parentTask: TaskRecord },
  result: TaskResult,
  metadata: Record<string, unknown> = {}
): TaskRecord {
  const task = store.createTask({
    sessionId: fixture.parentTask.sessionId,
    source: "system",
    roleId: fixture.collaboration.facilitator,
    title: "最终汇总",
    instruction: "汇总所有角色输出",
    metadata: {
      parentTaskId: fixture.parentTask.id,
      collaborationId: fixture.collaboration.id,
      isAggregation: true,
      aggregationMode: "deliver",
      aggregationTriggerReason: "all_tasks_completed",
      ...metadata
    }
  });
  const reflection: ReflectionNote = {
    score: 9,
    confidence: "high",
    assumptions: [],
    risks: [],
    improvements: []
  };
  return store.completeTask(task.id, result, reflection) ?? task;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("CollaborationManager.resumeAwaitingCollaboration", () => {
  it("reactivates await_user collaboration and triggers a fresh aggregation", async () => {
    const store = createTestStore();
    const parentTask = createAwaitingParentTask(store);
    const collaboration: AgentCollaboration = {
      id: "collab-test-1",
      parentTaskId: parentTask.id,
      status: "completed",
      participants: ["product", "backend", "qa"],
      facilitator: "cto",
      currentPhase: "await_user",
      phaseResults: [],
      config: {
        maxRounds: 3,
        discussionTimeoutMs: 30_000,
        requireConsensus: false,
        pushIntermediateResults: true,
        autoAggregateOnComplete: true,
        aggregateTimeoutMs: 60_000
      },
      createdAt: "2026-04-12T00:00:00.000Z",
      updatedAt: "2026-04-12T00:00:00.000Z",
      completedAt: "2026-04-12T00:05:00.000Z"
    };
    if (parentTask.sessionId) {
      collaboration.sessionId = parentTask.sessionId;
    }
    if (parentTask.chatId) {
      collaboration.chatId = parentTask.chatId;
    }
    store.createAgentCollaboration(collaboration);

    const sendCardToChat = vi.fn(async (_chatId: string, _card: Record<string, unknown>) => undefined);
    const manager = new CollaborationManager({
      store,
      feishuClient: {
        sendCardToChat
      } as never
    });
    const performFinalAggregation = vi
      .spyOn(manager, "performFinalAggregation")
      .mockResolvedValue(undefined);

    const resumed = await manager.resumeAwaitingCollaboration(store.getTask(parentTask.id) ?? parentTask);

    expect(resumed).toBe(true);
    expect(performFinalAggregation).toHaveBeenCalledWith("collab-test-1", {
      shouldAggregate: true,
      mode: "deliver",
      reason: "manual_trigger"
    });
    const updatedParent = store.getTask(parentTask.id);
    expect(updatedParent?.metadata.collaborationStatus).toBe("active");
    expect(updatedParent?.metadata.collaborationPhase).toBe("converge");
    expect(updatedParent?.metadata.collaborationPendingQuestions).toEqual([]);
    expect(updatedParent?.metadata.collaborationResumeRequested).toBe(false);

    const updatedCollaboration = store.getAgentCollaboration("collab-test-1");
    expect(updatedCollaboration?.status).toBe("active");
    expect(updatedCollaboration?.currentPhase).toBe("converge");
    expect(updatedCollaboration?.completedAt).toBeUndefined();

    expect(sendCardToChat).toHaveBeenCalledTimes(2);
    expect(sendCardToChat).toHaveBeenCalledWith(
      "oc_1234567890abcdefghijklmn",
      expect.objectContaining({
        schema: "2.0"
      })
    );
    expect(JSON.stringify(sendCardToChat.mock.calls[1]?.[1] ?? {})).toContain("session_workbench");

    const evolutionState = store.getConfigEntry<{ signals?: Array<{ kind?: string }> }>("evolution-state");
    const signalKinds = (evolutionState?.signals ?? []).map((item) => item.kind);
    expect(signalKinds).toContain("collaboration_resumed");
  });

  it("returns false when parent task does not belong to a collaboration", async () => {
    const store = createTestStore();
    const parentTask = store.createTask({
      source: "feishu",
      roleId: "ceo",
      title: "普通任务",
      instruction: "do work",
      metadata: {}
    });
    const manager = new CollaborationManager({ store });

    await expect(manager.resumeAwaitingCollaboration(parentTask)).resolves.toBe(false);
  });
});

describe("CollaborationManager harness state", () => {
  it("writes verified main-agent state into project memory after final delivery", async () => {
    const store = createTestStore();
    const fixture = createCollaborationHarnessFixture(store);
    const aggregationTask = createCompletedAggregationTask(store, fixture, {
      summary: "多角色协作已完成交付",
      deliverable: "CHANGED_FILES: docs/collaboration-report.md\n完整交付已收敛。",
      citations: [],
      followUps: ["进入发布准备"]
    });

    await fixture.manager.handleTaskCompletion(aggregationTask);

    const session = store.getSession(fixture.parentTask.sessionId!);
    const memory = session?.metadata.projectMemory as Record<string, unknown> | undefined;
    expect(memory?.currentStage).toBe("collaboration_delivered");
    expect(memory?.latestArtifacts).toEqual(["docs/collaboration-report.md"]);
    expect(memory?.orchestrationMode).toBe("main_agent");
    expect(memory?.orchestrationOwnerRoleId).toBe("cto");
    expect(memory?.orchestrationVerificationStatus).toBe("verified");
  });

  it("keeps pending main-agent state visible when collaboration awaits user input", async () => {
    const store = createTestStore();
    const fixture = createCollaborationHarnessFixture(store);
    const aggregationTask = createCompletedAggregationTask(
      store,
      fixture,
      {
        summary: "缺少目标用户信息",
        deliverable: "请提供目标用户画像后继续。",
        citations: [],
        followUps: ["请确认目标用户画像"]
      },
      {
        aggregationMode: "await_user",
        aggregationTriggerReason: "all_tasks_terminal_with_failures"
      }
    );

    await fixture.manager.handleTaskCompletion(aggregationTask);

    const session = store.getSession(fixture.parentTask.sessionId!);
    const memory = session?.metadata.projectMemory as Record<string, unknown> | undefined;
    expect(memory?.currentStage).toBe("awaiting_input");
    expect(memory?.unresolvedQuestions).toEqual(["请确认目标用户画像"]);
    expect(memory?.orchestrationMode).toBe("main_agent");
    expect(memory?.orchestrationOwnerRoleId).toBe("cto");
    expect(memory?.orchestrationVerificationStatus).toBe("pending");
  });

  it("uses learned collaboration policy when failures finish with no completed roles", async () => {
    const store = createTestStore();
    store.patchRuntimeConfig((config) => {
      config.evolution.collaboration.terminalFailureNoProgressMode = "await_user";
      config.evolution.collaboration.partialDeliveryMinCompletedRoles = 2;
      return config;
    });
    const fixture = createCollaborationHarnessFixture(store);
    const recentCreatedAt = new Date(Date.now() - 30_000).toISOString();
    const recentUpdatedAt = new Date(Date.now() - 10_000).toISOString();
    fixture.collaboration.createdAt = recentCreatedAt;
    fixture.collaboration.currentPhase = "execution";
    fixture.collaboration.updatedAt = recentUpdatedAt;
    store.updateAgentCollaboration(fixture.collaboration.id, {
      currentPhase: "execution",
      updatedAt: recentUpdatedAt
    });
    const child1 = store.createTask({
      sessionId: fixture.parentTask.sessionId,
      source: "system",
      roleId: "product",
      title: "产品子任务",
      instruction: "do product",
      metadata: {
        parentTaskId: fixture.parentTask.id,
        collaborationId: fixture.collaboration.id
      }
    });
    const child2 = store.createTask({
      sessionId: fixture.parentTask.sessionId,
      source: "system",
      roleId: "backend",
      title: "后端子任务",
      instruction: "do backend",
      metadata: {
        parentTaskId: fixture.parentTask.id,
        collaborationId: fixture.collaboration.id
      }
    });
    store.createTaskRelation({
      parentTaskId: fixture.parentTask.id,
      childTaskId: child1.id,
      relationType: "split"
    });
    store.createTaskRelation({
      parentTaskId: fixture.parentTask.id,
      childTaskId: child2.id,
      relationType: "split"
    });
    store.failTask(child1.id, "product failed");
    store.failTask(child2.id, "backend failed");

    const decision = (fixture.manager as unknown as {
      resolveAggregationDecision: (collaboration: AgentCollaboration, manual?: boolean) => {
        shouldAggregate: boolean;
        mode: string;
        reason: string;
      };
    }).resolveAggregationDecision(fixture.collaboration);

    expect(decision.shouldAggregate).toBe(true);
    expect(decision.mode).toBe("await_user");
    expect(decision.reason).toBe("all_tasks_terminal_with_failures");
  });
});

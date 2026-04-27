import { describe, expect, it, vi } from "vitest";
import type { GoalRunRecord, SessionRecord, TaskRecord } from "@vinko/shared";
import { handleInboundResumeStage } from "./inbound-resume.js";

function createGoalRun(overrides: Partial<GoalRunRecord> = {}): GoalRunRecord {
  return {
    id: "goal-1",
    source: "feishu",
    objective: "Build product",
    status: "awaiting_input",
    currentStage: "discover",
    requestedBy: "ou_xxx",
    chatId: "chat-1",
    sessionId: "sess-1",
    language: "zh-CN",
    metadata: {},
    context: {},
    retryCount: 0,
    maxRetries: 2,
    awaitingInputFields: ["company_name"],
    createdAt: "2026-04-22T00:00:00.000Z",
    updatedAt: "2026-04-22T00:00:00.000Z",
    ...overrides
  };
}

function createTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task-1",
    source: "feishu",
    roleId: "frontend",
    title: "Build landing page",
    instruction: "Build landing page",
    status: "running",
    priority: 90,
    metadata: {},
    requestedBy: "ou_xxx",
    chatId: "chat-1",
    createdAt: "2026-04-22T00:00:00.000Z",
    updatedAt: "2026-04-22T00:00:00.000Z",
    ...overrides
  };
}

function createSession(): SessionRecord {
  return {
    id: "sess-1",
    source: "feishu",
    sourceKey: "chat:chat-1",
    title: "session",
    status: "active",
    metadata: {},
    createdAt: "2026-04-22T00:00:00.000Z",
    updatedAt: "2026-04-22T00:00:00.000Z",
    lastMessageAt: "2026-04-22T00:00:00.000Z"
  };
}

describe("inbound-resume", () => {
  it("returns goal-run status reply for status queries", async () => {
    const finalize = vi.fn((result) => result);
    const result = await handleInboundResumeStage({
      store: {
        listGoalRuns: vi.fn(() => [createGoalRun({ status: "running", awaitingInputFields: [] })]),
        listTasks: vi.fn(() => []),
        getTask: vi.fn(() => undefined),
        getSession: vi.fn(() => createSession()),
        getLatestGoalRunHandoff: vi.fn(() => undefined),
        upsertGoalRunInput: vi.fn(),
        updateGoalRunContext: vi.fn(),
        queueGoalRun: vi.fn(),
        appendGoalRunTimelineEvent: vi.fn(),
        appendSessionMessage: vi.fn()
      },
      inboundText: "现在进度怎么样？",
      taskText: "现在进度怎么样？",
      source: "feishu",
      requestedBy: "ou_xxx",
      requesterName: "Duke",
      chatId: "chat-1",
      sessionId: "sess-1",
      isDirectConversationTurn: () => false,
      isContinueSignal: () => false,
      hasActionIntent: () => false,
      formatRoleLabel: (roleId) => String(roleId || ""),
      formatCollaborationProgress: () => undefined,
      updateSessionProjectMemoryFromInbound: vi.fn(),
      finalize
    });

    expect(result?.type).toBe("smalltalk_replied");
    expect(finalize).toHaveBeenCalledTimes(1);
  });

  it("resumes awaiting collaboration task", async () => {
    const appendSessionMessage = vi.fn();
    const updateSessionProjectMemoryFromInbound = vi.fn();
    const finalize = vi.fn((result) => result);
    const awaitingTask = createTask({
      id: "task-collab-1",
      status: "running",
      metadata: {
        collaborationId: "collab-1",
        collaborationStatus: "await_user"
      },
      sessionId: "sess-1"
    });

    const result = await handleInboundResumeStage({
      store: {
        listGoalRuns: vi.fn(() => []),
        listTasks: vi.fn(() => [awaitingTask]),
        getTask: vi.fn(() => undefined),
        getSession: vi.fn(() => createSession()),
        getLatestGoalRunHandoff: vi.fn(() => undefined),
        upsertGoalRunInput: vi.fn(),
        updateGoalRunContext: vi.fn(),
        queueGoalRun: vi.fn(),
        appendGoalRunTimelineEvent: vi.fn(),
        appendSessionMessage,
        patchTaskMetadata: vi.fn(),
        requeueTask: vi.fn(() => awaitingTask)
      } as never,
      inboundText: "补充一下用户希望支持移动端",
      taskText: "补充一下用户希望支持移动端",
      source: "feishu",
      requestedBy: "ou_xxx",
      requesterName: "Duke",
      chatId: "chat-1",
      sessionId: "sess-1",
      isDirectConversationTurn: () => false,
      isContinueSignal: () => false,
      hasActionIntent: () => false,
      formatRoleLabel: (roleId) => String(roleId || ""),
      formatCollaborationProgress: () => undefined,
      updateSessionProjectMemoryFromInbound,
      finalize
    });

    expect(result?.type).toBe("operator_action_applied");
    expect(updateSessionProjectMemoryFromInbound).toHaveBeenCalled();
    expect(appendSessionMessage).toHaveBeenCalled();
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VinkoStore } from "@vinko/shared";
import { notifySessionWorkbench } from "./session-workbench-notifier.js";

const tempDirs: string[] = [];

function createStore(): VinkoStore {
  const dir = mkdtempSync(path.join(tmpdir(), "vinkoclaw-session-workbench-notifier-"));
  tempDirs.push(dir);
  return new VinkoStore(path.join(dir, "test.sqlite"));
}

function createSessionFixture(store: VinkoStore): { sessionId: string; chatId: string } {
  const chatId = "oc_1234567890abcdefghijklmn";
  const session = store.ensureSession({
    source: "feishu",
    sourceKey: `chat:${chatId}`,
    title: "Workbench session",
    metadata: {
      chatId
    }
  });
  store.updateSessionProjectMemory(session.id, {
    currentGoal: "打造通用超级智能体",
    currentStage: "execute",
    latestSummary: "工作台通知已接入",
    nextActions: ["继续验收 milestone 推送"],
    updatedBy: "task-runner"
  });
  store.createTask({
    sessionId: session.id,
    source: "feishu",
    roleId: "engineering",
    title: "接入工作台通知",
    instruction: "实现 session workbench notifier",
    chatId
  });
  return {
    sessionId: session.id,
    chatId
  };
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

describe("notifySessionWorkbench", () => {
  it("sends a session workbench card for a valid Feishu session", async () => {
    const store = createStore();
    const fixture = createSessionFixture(store);
    const sendCardToChat = vi.fn(async (_chatId: string, _card: Record<string, unknown>) => undefined);

    const sent = await notifySessionWorkbench({
      store,
      feishuClient: { sendCardToChat } as never,
      sessionId: fixture.sessionId,
      chatId: fixture.chatId,
      reason: "task_completed"
    });

    expect(sent).toBe(true);
    expect(sendCardToChat).toHaveBeenCalledWith(
      fixture.chatId,
      expect.objectContaining({
        schema: "2.0"
      })
    );
    expect(JSON.stringify(sendCardToChat.mock.calls[0]?.[1] ?? {})).toContain("session_workbench");
  });

  it("does not send without client or valid chat id", async () => {
    const store = createStore();
    const fixture = createSessionFixture(store);
    const sendCardToChat = vi.fn(async (_chatId: string, _card: Record<string, unknown>) => undefined);

    await expect(
      notifySessionWorkbench({
        store,
        feishuClient: undefined,
        sessionId: fixture.sessionId,
        chatId: fixture.chatId,
        reason: "task_completed"
      })
    ).resolves.toBe(false);

    await expect(
      notifySessionWorkbench({
        store,
        feishuClient: { sendCardToChat } as never,
        sessionId: fixture.sessionId,
        chatId: "not-a-chat",
        reason: "task_completed"
      })
    ).resolves.toBe(false);

    expect(sendCardToChat).not.toHaveBeenCalled();
  });

  it("records an audit event when card sending fails", async () => {
    const store = createStore();
    const fixture = createSessionFixture(store);
    const sendCardToChat = vi.fn(async () => {
      throw new Error("Feishu 400");
    });

    const sent = await notifySessionWorkbench({
      store,
      feishuClient: { sendCardToChat } as never,
      sessionId: fixture.sessionId,
      chatId: fixture.chatId,
      reason: "task_failed"
    });

    expect(sent).toBe(false);
    const audit = store.listAuditEvents(10).find((entry) => entry.message === "Failed to send session workbench card");
    expect(audit?.payload.eventType).toBe("session_workbench_push_failed");
    expect(audit?.payload.reason).toBe("task_failed");
  });
});

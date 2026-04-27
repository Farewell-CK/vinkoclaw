import type { SessionRecord } from "@vinko/shared";
import { describe, expect, it, vi } from "vitest";
import { initInboundRuntime } from "./inbound-runtime.js";

describe("inbound-runtime", () => {
  it("initializes session intake and finalizes ack", () => {
    const appendSessionMessage = vi.fn();
    const getSession = vi.fn(
      (): SessionRecord => ({
        id: "sess-1",
        source: "feishu",
        sourceKey: "chat:chat-1",
        title: "帮我写一份 PRD",
        status: "active",
        metadata: {},
        createdAt: "2026-04-22T00:00:00.000Z",
        updatedAt: "2026-04-22T00:00:00.000Z",
        lastMessageAt: "2026-04-22T00:00:00.000Z"
      })
    );
    const ensureInboundSession = vi.fn(() => "sess-1");
    const updateSessionProjectMemoryFromInbound = vi.fn();

    const runtime = initInboundRuntime({
      store: {
        appendSessionMessage,
        getSession
      },
      ensureInboundSession,
      updateSessionProjectMemoryFromInbound,
      input: {
        source: "feishu",
        requestedBy: "ou_xxx",
        requesterName: "Duke",
        chatId: "chat-1"
      },
      inboundText: "帮我写一份 PRD",
      taskText: "帮我写一份 PRD",
      titleHint: "帮我写一份 PRD"
    });

    expect(runtime.sessionId).toBe("sess-1");
    expect(updateSessionProjectMemoryFromInbound).toHaveBeenCalledWith({
      sessionId: "sess-1",
      requesterName: "Duke",
      requestedBy: "ou_xxx",
      source: "feishu",
      inboundText: "帮我写一份 PRD",
      taskText: "帮我写一份 PRD",
      stage: "intake"
    });

    runtime.finalize({
      type: "smalltalk_replied",
      message: "收到"
    });

    expect(appendSessionMessage).toHaveBeenCalledTimes(2);
    expect(appendSessionMessage.mock.calls[0]?.[0]).toMatchObject({
      sessionId: "sess-1",
      actorType: "user",
      content: "帮我写一份 PRD"
    });
    expect(appendSessionMessage.mock.calls[1]?.[0]).toMatchObject({
      sessionId: "sess-1",
      actorType: "system",
      content: "收到"
    });
  });

  it("uses an explicit existing session when provided", () => {
    const appendSessionMessage = vi.fn();
    const getSession = vi.fn(
      (): SessionRecord => ({
        id: "sess-explicit",
        source: "control-center",
        sourceKey: "operator:owner",
        title: "已有会话",
        status: "active",
        metadata: {},
        createdAt: "2026-04-22T00:00:00.000Z",
        updatedAt: "2026-04-22T00:00:00.000Z",
        lastMessageAt: "2026-04-22T00:00:00.000Z"
      })
    );
    const ensureInboundSession = vi.fn(() => "sess-new");
    const updateSessionProjectMemoryFromInbound = vi.fn();

    const runtime = initInboundRuntime({
      store: {
        appendSessionMessage,
        getSession
      },
      ensureInboundSession,
      updateSessionProjectMemoryFromInbound,
      input: {
        sessionId: "sess-explicit",
        source: "control-center",
        requestedBy: "owner",
        clientActionId: "session_action_continue_1"
      },
      inboundText: "继续推进当前会话",
      taskText: "继续推进当前会话",
      titleHint: "继续推进当前会话"
    });

    expect(runtime.sessionId).toBe("sess-explicit");
    expect(ensureInboundSession).not.toHaveBeenCalled();
    expect(appendSessionMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess-explicit",
        metadata: expect.objectContaining({
          clientActionId: "session_action_continue_1"
        })
      })
    );
  });
});

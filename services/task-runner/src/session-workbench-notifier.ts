import type { FeishuClient } from "@vinko/feishu-gateway";
import { buildSessionWorkbenchCard } from "@vinko/feishu-gateway";
import {
  buildSessionWorkbenchSnapshotFromStore,
  createLogger,
  type VinkoStore
} from "@vinko/shared";

const logger = createLogger("session-workbench-notifier");

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isLikelyFeishuChatId(chatId: string): boolean {
  return /^oc_[a-z0-9]{20,}$/i.test(chatId.trim());
}

export async function notifySessionWorkbench(input: {
  store: VinkoStore;
  feishuClient: FeishuClient | undefined;
  sessionId: string | undefined;
  chatId: string | undefined;
  reason: string;
}): Promise<boolean> {
  const sessionId = clean(input.sessionId);
  const chatId = clean(input.chatId);
  if (!sessionId || !chatId || !input.feishuClient || !isLikelyFeishuChatId(chatId)) {
    return false;
  }

  const snapshot = buildSessionWorkbenchSnapshotFromStore({
    store: input.store,
    sessionId
  });
  if (!snapshot) {
    return false;
  }

  try {
    await input.feishuClient.sendCardToChat(chatId, buildSessionWorkbenchCard({ snapshot }));
    input.store.appendAuditEvent({
      category: "feishu",
      entityType: "session",
      entityId: sessionId,
      message: "Sent session workbench card",
      payload: {
        eventType: "session_workbench_pushed",
        reason: input.reason,
        chatId
      }
    });
    return true;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    input.store.appendAuditEvent({
      category: "feishu",
      entityType: "session",
      entityId: sessionId,
      message: "Failed to send session workbench card",
      payload: {
        eventType: "session_workbench_push_failed",
        reason: input.reason,
        chatId,
        error: errorMessage
      }
    });
    logger.error("session workbench notification failed", error, {
      sessionId,
      chatId,
      reason: input.reason
    });
    return false;
  }
}

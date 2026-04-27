import type { SessionRecord, TaskSource, VinkoStore } from "@vinko/shared";

export type InboundResult =
  | { type: "template_updated"; message: string; templateId: string; enabled: boolean }
  | { type: "template_not_found"; message: string; query: string }
  | { type: "smalltalk_replied"; message: string }
  | { type: "needs_clarification"; message: string; questions: string[] }
  | { type: "config_input_required"; message: string; missingField: string; expectedCommand: string }
  | { type: "operator_action_pending"; message: string; approvalId: string }
  | { type: "operator_action_applied"; message: string; actionId: string }
  | { type: "template_tasks_queued"; message: string; templateId: string; taskIds: string[] }
  | { type: "goal_run_queued"; message: string; goalRunId: string }
  | { type: "task_queued"; message: string; taskId: string };

interface InitInboundRuntimeInput {
  store: Pick<VinkoStore, "appendSessionMessage" | "getSession">;
  ensureInboundSession: (input: {
    source: TaskSource;
    requestedBy?: string | undefined;
    requesterName?: string | undefined;
    chatId?: string | undefined;
    titleHint: string;
  }) => string | undefined;
  updateSessionProjectMemoryFromInbound: (input: {
    sessionId?: string | undefined;
    requesterName?: string | undefined;
    requestedBy?: string | undefined;
    source: TaskSource;
    inboundText: string;
    taskText: string;
    stage: string;
  }) => void;
  input: {
    sessionId?: string | undefined;
    source: TaskSource;
    requestedBy?: string | undefined;
    requesterName?: string | undefined;
    chatId?: string | undefined;
    clientActionId?: string | undefined;
  };
  inboundText: string;
  taskText: string;
  titleHint: string;
}

export function initInboundRuntime(input: InitInboundRuntimeInput): {
  sessionId: string | undefined;
  session: SessionRecord | undefined;
  finalize: (result: InboundResult) => InboundResult;
} {
  const existingSession = input.input.sessionId ? input.store.getSession(input.input.sessionId) : undefined;
  const sessionId =
    existingSession?.id ??
    input.ensureInboundSession({
      source: input.input.source,
      requestedBy: input.input.requestedBy,
      requesterName: input.input.requesterName,
      chatId: input.input.chatId,
      titleHint: input.titleHint
    });

  if (sessionId) {
    input.store.appendSessionMessage({
      sessionId,
      actorType: "user",
      actorId: input.input.requestedBy ?? "anonymous",
      messageType: "text",
      content: input.inboundText,
      metadata: {
        source: input.input.source,
        chatId: input.input.chatId ?? "",
        requesterName: input.input.requesterName ?? "",
        clientActionId: input.input.clientActionId ?? ""
      }
    });
    input.updateSessionProjectMemoryFromInbound({
      sessionId,
      requesterName: input.input.requesterName,
      requestedBy: input.input.requestedBy,
      source: input.input.source,
      inboundText: input.inboundText,
      taskText: input.taskText,
      stage: "intake"
    });
  }

  const finalize = (result: InboundResult): InboundResult => {
    if (sessionId) {
      input.store.appendSessionMessage({
        sessionId,
        actorType: "system",
        actorId: "orchestrator",
        messageType: "event",
        content: result.message,
        metadata: {
          type: "inbound_ack",
          source: input.input.source,
          clientActionId: input.input.clientActionId ?? ""
        }
      });
    }
    return result;
  };

  return {
    sessionId,
    session: sessionId ? input.store.getSession(sessionId) : undefined,
    finalize
  };
}

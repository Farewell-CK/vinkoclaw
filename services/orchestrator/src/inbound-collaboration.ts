import type { CreateTaskInput, TaskRecord, VinkoStore } from "@vinko/shared";

export function resolveAwaitingCollaborationTaskForInbound(
  input: {
    source: CreateTaskInput["source"];
    requestedBy?: string | undefined;
    chatId?: string | undefined;
  },
  tasks: TaskRecord[]
): TaskRecord | undefined {
  const candidates = tasks.filter((task) => {
    if (task.source !== input.source) {
      return false;
    }
    const metadata = task.metadata as {
      collaborationId?: unknown;
      collaborationStatus?: unknown;
    };
    if (typeof metadata.collaborationId !== "string" || !metadata.collaborationId.trim()) {
      return false;
    }
    if (metadata.collaborationStatus !== "await_user") {
      return false;
    }
    if (input.chatId) {
      return task.chatId === input.chatId;
    }
    if (input.requestedBy) {
      return task.requestedBy === input.requestedBy;
    }
    return true;
  });
  return candidates.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
}

export function formatAwaitingCollaborationMessage(task: TaskRecord): string {
  const metadata = task.metadata as {
    collaborationPendingQuestions?: unknown;
  };
  const pendingQuestions = Array.isArray(metadata.collaborationPendingQuestions)
    ? metadata.collaborationPendingQuestions
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean)
        .slice(0, 3)
    : [];
  const lines = [
    `当前协作任务（${task.id.slice(0, 8)}）正在等待你补充信息。`,
    "你直接回复补充内容后，我会续上原协作链继续汇总，不会重新开一条任务。"
  ];
  if (pendingQuestions.length > 0) {
    lines.push("当前待补充项：");
    for (const question of pendingQuestions) {
      lines.push(`- ${question}`);
    }
  }
  return lines.join("\n");
}

export function resumeAwaitingCollaborationTask(
  store: VinkoStore,
  input: {
    task: TaskRecord;
    text: string;
    requesterName?: string | undefined;
  }
): TaskRecord {
  const metadata = input.task.metadata as {
    collaborationUserSupplements?: unknown;
  };
  const existingSupplements = Array.isArray(metadata.collaborationUserSupplements)
    ? metadata.collaborationUserSupplements.filter((entry) => entry && typeof entry === "object")
    : [];
  const nextSupplements = [
    ...existingSupplements,
    {
      text: input.text.trim(),
      requesterName: input.requesterName?.trim() || undefined,
      at: new Date().toISOString()
    }
  ].slice(-6);

  store.patchTaskMetadata(input.task.id, {
    collaborationResumeRequested: true,
    collaborationStatus: "active",
    collaborationPhase: "converge",
    collaborationPendingQuestions: [],
    collaborationLatestUserReply: input.text.trim(),
    collaborationUserSupplements: nextSupplements,
    collaborationResumedAt: new Date().toISOString()
  });
  return store.requeueTask(input.task.id) ?? input.task;
}

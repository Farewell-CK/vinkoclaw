import type { CreateTaskInput, GoalRunRecord, RoleId, TaskRecord, VinkoStore } from "@vinko/shared";
import { buildGoalRunStatusMessage } from "@vinko/shared";
import { formatAwaitingCollaborationMessage, resolveAwaitingCollaborationTaskForInbound, resumeAwaitingCollaborationTask } from "./inbound-collaboration.js";
import type { InboundResult } from "./inbound-runtime.js";

export function resolveAwaitingGoalRunForInbound(
  store: Pick<VinkoStore, "listGoalRuns">,
  input: {
    source: CreateTaskInput["source"];
    requestedBy?: string | undefined;
    chatId?: string | undefined;
  }
): GoalRunRecord | undefined {
  const candidates = store.listGoalRuns({ limit: 200 }).filter((run) => {
    if (run.source !== input.source) {
      return false;
    }
    if (run.status !== "awaiting_input") {
      return false;
    }
    if (input.chatId && run.chatId !== input.chatId) {
      return false;
    }
    if (!input.chatId && input.requestedBy && run.requestedBy !== input.requestedBy) {
      return false;
    }
    return true;
  });
  return candidates.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
}

export function resolveLatestGoalRunForInbound(
  store: Pick<VinkoStore, "listGoalRuns">,
  input: {
    source: CreateTaskInput["source"];
    requestedBy?: string | undefined;
    chatId?: string | undefined;
  }
): GoalRunRecord | undefined {
  const candidates = store.listGoalRuns({ limit: 500 }).filter((run) => {
    if (run.source !== input.source) {
      return false;
    }
    if (input.chatId && run.chatId !== input.chatId) {
      return false;
    }
    if (!input.chatId && input.requestedBy && run.requestedBy !== input.requestedBy) {
      return false;
    }
    return true;
  });
  return candidates.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
}

export function resolveLatestInFlightGoalRunForInbound(
  store: Pick<VinkoStore, "listGoalRuns">,
  input: {
    source: CreateTaskInput["source"];
    requestedBy?: string | undefined;
    chatId?: string | undefined;
  }
): GoalRunRecord | undefined {
  const inFlightStatuses = new Set(["queued", "running", "awaiting_authorization"]);
  const candidates = store.listGoalRuns({ limit: 500 }).filter((run) => {
    if (run.source !== input.source) {
      return false;
    }
    if (!inFlightStatuses.has(run.status)) {
      return false;
    }
    if (input.chatId) {
      return run.chatId === input.chatId;
    }
    if (input.requestedBy) {
      return run.requestedBy === input.requestedBy;
    }
    return true;
  });
  return candidates.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
}

export function isGoalRunStatusQuery(text: string, hasActionIntent: (text: string) => boolean): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  if (hasActionIntent(normalized)) {
    return false;
  }
  const patterns = ["进度", "状态", "做到哪", "完成了吗", "开发好了吗", "写好了吗", "现在怎么样", "情况如何"];
  const hasKeyword = patterns.some((keyword) => normalized.includes(keyword));
  if (!hasKeyword) {
    return false;
  }
  const querySignals = ["吗", "？", "?", "如何", "怎么样", "做到哪", "完成没", "完成了没"];
  return querySignals.some((token) => normalized.includes(token));
}

export function isTaskStatusQuery(text: string, hasActionIntent: (text: string) => boolean): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  if (hasActionIntent(normalized)) {
    return false;
  }
  const patterns = ["进度", "状态", "做到哪", "完成了吗", "好了吗", "现在怎么样", "情况如何", "卡住"];
  const hasKeyword = patterns.some((keyword) => normalized.includes(keyword));
  if (!hasKeyword) {
    return false;
  }
  const querySignals = ["吗", "？", "?", "如何", "怎么样", "做到哪", "完成没", "完成了没", "卡住"];
  return querySignals.some((token) => normalized.includes(token));
}

const GOAL_INPUT_FIELD_LABELS: Record<string, { label: string; aliases: string[] }> = {
  company_name: {
    label: "公司名称",
    aliases: ["公司名称", "公司名", "企业名称", "品牌名", "companyname", "company"]
  },
  business_domain: {
    label: "业务方向",
    aliases: ["业务方向", "主营业务", "业务领域", "业务", "行业", "businessdomain", "domain"]
  },
  target_audience: {
    label: "目标用户",
    aliases: ["目标用户", "目标客群", "用户群体", "受众", "targetaudience", "audience"]
  },
  deploy_target: {
    label: "部署目标",
    aliases: ["部署目标", "部署平台", "上线平台", "deploytarget"]
  }
};

function normalizeGoalFieldAlias(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_()（）:：-]+/g, "");
}

export function formatGoalInputFields(fields: string[]): string {
  const normalized = fields.map((field) => field.trim()).filter(Boolean);
  if (normalized.length === 0) {
    return "关键信息";
  }
  return normalized
    .map((field) => {
      const configured = GOAL_INPUT_FIELD_LABELS[field];
      return configured ? `${configured.label}(${field})` : field;
    })
    .join("、");
}

export function buildGoalInputExpectedCommand(fields: string[]): string {
  const normalized = fields.map((field) => field.trim()).filter(Boolean);
  if (normalized.length === 0) {
    return "";
  }
  return normalized
    .map((field) => {
      const configured = GOAL_INPUT_FIELD_LABELS[field];
      return configured ? `${configured.label}: <value>` : `${field}: <value>`;
    })
    .join("；");
}

function resolveGoalInputFieldKey(rawKey: string, expectedFields: string[]): string | undefined {
  const key = rawKey.trim();
  if (!key) {
    return undefined;
  }
  if (expectedFields.includes(key)) {
    return key;
  }

  const normalizedExpected = new Map<string, string>();
  for (const field of expectedFields) {
    normalizedExpected.set(normalizeGoalFieldAlias(field), field);
  }

  const strippedParenthetical = key.replace(/\(([^()]+)\)|（([^（）]+)）/g, " $1 $2 ").trim();
  const candidates = [key, strippedParenthetical];
  for (const candidate of candidates) {
    const compact = normalizeGoalFieldAlias(candidate);
    const direct = normalizedExpected.get(compact);
    if (direct) {
      return direct;
    }
    for (const field of expectedFields) {
      const configured = GOAL_INPUT_FIELD_LABELS[field];
      if (!configured) {
        continue;
      }
      if (configured.aliases.some((alias) => normalizeGoalFieldAlias(alias) === compact)) {
        return field;
      }
    }
  }

  const englishKeyMatch = key.match(/[a-zA-Z0-9_.-]{2,64}/);
  if (englishKeyMatch?.[0]) {
    const fallback = normalizedExpected.get(normalizeGoalFieldAlias(englishKeyMatch[0]));
    if (fallback) {
      return fallback;
    }
  }
  return undefined;
}

export function parseGoalRunInputFromText(rawText: string, expectedFields: string[]): Record<string, string> | undefined {
  const text = rawText.trim();
  if (!text) {
    return undefined;
  }
  const normalizedFields = expectedFields.map((field) => field.trim()).filter(Boolean);
  if (normalizedFields.length === 0) {
    return undefined;
  }

  const segments = text
    .split(/[\n,，;；]/g)
    .map((segment) => segment.trim())
    .filter(Boolean);
  const keyed: Record<string, string> = {};
  for (const segment of segments) {
    const match = segment.match(/^([\w\u4e00-\u9fff().（）:-]{2,80})\s*[:：=]\s*(.+)$/u);
    if (!match) {
      continue;
    }
    const key = resolveGoalInputFieldKey(match[1] ?? "", normalizedFields);
    const value = match[2]?.trim();
    if (!key || !value) {
      continue;
    }
    keyed[key] = value;
  }
  if (Object.keys(keyed).length > 0) {
    return keyed;
  }

  const values = segments;
  if (values.length < normalizedFields.length) {
    return undefined;
  }
  const mapped: Record<string, string> = {};
  for (let index = 0; index < normalizedFields.length; index += 1) {
    const field = normalizedFields[index];
    const value = values[index];
    if (!field || !value) {
      continue;
    }
    mapped[field] = value;
  }
  return Object.keys(mapped).length > 0 ? mapped : undefined;
}

export function parseKeyValuePairsFromText(rawText: string): Record<string, string> | undefined {
  const text = rawText.trim();
  if (!text) {
    return undefined;
  }
  const segments = text
    .split(/[\n,，;；]/g)
    .map((segment) => segment.trim())
    .filter(Boolean);
  const parsed: Record<string, string> = {};
  for (const segment of segments) {
    const match = segment.match(/^([a-zA-Z0-9_.-]{2,64})\s*[:：=]\s*(.+)$/);
    if (!match) {
      continue;
    }
    const key = match[1]?.trim();
    const value = match[2]?.trim();
    if (!key || !value) {
      continue;
    }
    parsed[key] = value;
  }
  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

export function formatGoalRunStatusMessage(
  store: Pick<VinkoStore, "getTask" | "getLatestGoalRunHandoff" | "getSession">,
  goalRun: GoalRunRecord,
  formatCollaborationProgress: (task: TaskRecord) => string | undefined
): string {
  const currentTask = goalRun.currentTaskId ? store.getTask(goalRun.currentTaskId) : undefined;
  const projectMemory =
    goalRun.sessionId && typeof store.getSession === "function"
      ? (store.getSession(goalRun.sessionId)?.metadata?.projectMemory as Record<string, unknown> | undefined)
      : undefined;
  const latestHandoff = store.getLatestGoalRunHandoff(goalRun.id);
  const collaborationProgress = currentTask ? formatCollaborationProgress(currentTask) : undefined;
  const base = buildGoalRunStatusMessage(goalRun, {
    currentTask,
    latestHandoff,
    projectMemory
  });
  return collaborationProgress ? `${base}\n${collaborationProgress}` : base;
}

export function resolveLatestActiveTaskForInbound(
  store: Pick<VinkoStore, "listTasks">,
  input: {
    source: CreateTaskInput["source"];
    requestedBy?: string | undefined;
    chatId?: string | undefined;
  }
): TaskRecord | undefined {
  const candidates = store.listTasks(500).filter((task) => {
    if (task.source !== input.source) {
      return false;
    }
    if (!["queued", "running", "waiting_approval"].includes(task.status)) {
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

export function formatActiveTaskStatusMessage(
  task: TaskRecord,
  formatRoleLabel: (roleId: string | undefined) => string,
  formatCollaborationProgress: (task: TaskRecord) => string | undefined
): string {
  const statusLabel =
    task.status === "queued"
      ? "排队中"
      : task.status === "running"
        ? "执行中"
        : task.status === "waiting_approval"
          ? "等待审批"
          : task.status;
  const base = `你当前有一条进行中的任务（${task.id.slice(0, 8)}），状态：${statusLabel}，执行角色：${formatRoleLabel(task.roleId)}。我会继续推进并同步结果。`;
  const collaborationProgress = formatCollaborationProgress(task);
  return collaborationProgress ? `${base}\n${collaborationProgress}` : base;
}

export function requestsNewIndependentGoal(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  const patterns = ["新任务", "另一个任务", "另外一个任务", "重新开始", "开新", "new task", "another task", "start over"];
  return patterns.some((keyword) => normalized.includes(keyword));
}

export async function handleInboundResumeStage(input: {
  store: Pick<
    VinkoStore,
    | "listGoalRuns"
    | "listTasks"
    | "getTask"
    | "getSession"
    | "getLatestGoalRunHandoff"
    | "upsertGoalRunInput"
    | "updateGoalRunContext"
    | "queueGoalRun"
    | "appendGoalRunTimelineEvent"
    | "appendSessionMessage"
  >;
  inboundText: string;
  taskText: string;
  source: CreateTaskInput["source"];
  requestedBy?: string | undefined;
  requesterName?: string | undefined;
  chatId?: string | undefined;
  sessionId?: string | undefined;
  isDirectConversationTurn: (text: string) => boolean;
  isContinueSignal: (text: string) => boolean;
  hasActionIntent: (text: string) => boolean;
  formatRoleLabel: (roleId: string | undefined) => string;
  formatCollaborationProgress: (task: TaskRecord) => string | undefined;
  updateSessionProjectMemoryFromInbound: (input: {
    sessionId?: string | undefined;
    requesterName?: string | undefined;
    requestedBy?: string | undefined;
    source: CreateTaskInput["source"];
    inboundText: string;
    taskText: string;
    stage: string;
    unresolvedQuestions?: string[] | undefined;
    nextActions?: string[] | undefined;
  }) => void;
  finalize: (result: InboundResult) => InboundResult;
}): Promise<InboundResult | undefined> {
  if (isGoalRunStatusQuery(input.inboundText, input.hasActionIntent)) {
    const latestGoalRun = resolveLatestGoalRunForInbound(input.store, input);
    if (latestGoalRun) {
      return input.finalize({
        type: "smalltalk_replied",
        message: formatGoalRunStatusMessage(input.store, latestGoalRun, input.formatCollaborationProgress)
      });
    }
  }

  if (isTaskStatusQuery(input.inboundText, input.hasActionIntent)) {
    const awaitingCollaboration = resolveAwaitingCollaborationTaskForInbound(input, input.store.listTasks(500));
    if (awaitingCollaboration) {
      return input.finalize({
        type: "smalltalk_replied",
        message: formatAwaitingCollaborationMessage(awaitingCollaboration)
      });
    }
    const activeTask = resolveLatestActiveTaskForInbound(input.store, input);
    if (activeTask) {
      return input.finalize({
        type: "smalltalk_replied",
        message: formatActiveTaskStatusMessage(activeTask, input.formatRoleLabel, input.formatCollaborationProgress)
      });
    }
  }

  const awaitingGoalRun = resolveAwaitingGoalRunForInbound(input.store, input);
  if (awaitingGoalRun) {
    const parsedInputs = parseGoalRunInputFromText(input.inboundText, awaitingGoalRun.awaitingInputFields);
    if (!parsedInputs) {
      if (input.isDirectConversationTurn(input.inboundText)) {
        return input.finalize({
          type: "smalltalk_replied",
          message: `我可以继续帮你推进当前目标。现在还缺：${formatGoalInputFields(awaitingGoalRun.awaitingInputFields)}。你直接回复这些信息后，我会立刻继续。`
        });
      }
      return input.finalize({
        type: "config_input_required",
        message: `当前任务（${awaitingGoalRun.id.slice(0, 8)}）还缺：${formatGoalInputFields(awaitingGoalRun.awaitingInputFields)}。你可以按顺序回复，或用 key:value 格式。`,
        missingField: awaitingGoalRun.awaitingInputFields[0] ?? "input",
        expectedCommand: buildGoalInputExpectedCommand(awaitingGoalRun.awaitingInputFields)
      });
    }

    for (const [key, value] of Object.entries(parsedInputs)) {
      input.store.upsertGoalRunInput({
        goalRunId: awaitingGoalRun.id,
        inputKey: key,
        value,
        createdBy: input.requestedBy
      });
    }
    input.store.updateGoalRunContext(awaitingGoalRun.id, parsedInputs);
    const resumedGoalRun = input.store.queueGoalRun(awaitingGoalRun.id, awaitingGoalRun.currentStage) ?? awaitingGoalRun;
    input.store.appendGoalRunTimelineEvent({
      goalRunId: awaitingGoalRun.id,
      stage: resumedGoalRun.currentStage,
      eventType: "input_received",
      message: `Received ${Object.keys(parsedInputs).length} input item(s)`,
      payload: {
        keys: Object.keys(parsedInputs)
      }
    });
    return input.finalize({
      type: "operator_action_applied",
      message: `收到，已补充 ${Object.keys(parsedInputs).join(", ")}，我先让流程继续推进，关键进展会同步你。`,
      actionId: awaitingGoalRun.id
    });
  }

  const inFlightGoalRun = resolveLatestInFlightGoalRunForInbound(input.store, input);
  if (inFlightGoalRun) {
    const prefilledInputs = parseKeyValuePairsFromText(input.inboundText);
    if (prefilledInputs) {
      for (const [key, value] of Object.entries(prefilledInputs)) {
        input.store.upsertGoalRunInput({
          goalRunId: inFlightGoalRun.id,
          inputKey: key,
          value,
          createdBy: input.requestedBy
        });
      }
      input.store.updateGoalRunContext(inFlightGoalRun.id, prefilledInputs);
      input.store.appendGoalRunTimelineEvent({
        goalRunId: inFlightGoalRun.id,
        stage: inFlightGoalRun.currentStage,
        eventType: "input_received",
        message: `Prefilled ${Object.keys(prefilledInputs).length} input item(s) while run in-flight`,
        payload: {
          keys: Object.keys(prefilledInputs)
        }
      });
      return input.finalize({
        type: "operator_action_applied",
        message: `收到，已记录补充信息 ${Object.keys(prefilledInputs).join(", ")}，我会继续推进当前目标流程。`,
        actionId: inFlightGoalRun.id
      });
    }
    if (input.isContinueSignal(input.inboundText)) {
      input.updateSessionProjectMemoryFromInbound({
        sessionId: input.sessionId,
        requesterName: input.requesterName,
        requestedBy: input.requestedBy,
        source: input.source,
        inboundText: input.inboundText,
        taskText: input.taskText,
        stage: "goal_run_in_progress"
      });
      return input.finalize({
        type: "smalltalk_replied",
        message: `${formatGoalRunStatusMessage(input.store, inFlightGoalRun, input.formatCollaborationProgress)} 你无需重复下发，我会持续推进并在关键节点同步。`
      });
    }
  }

  const awaitingCollaboration = resolveAwaitingCollaborationTaskForInbound(input, input.store.listTasks(500));
  if (awaitingCollaboration) {
    const resumedTask = resumeAwaitingCollaborationTask(input.store as VinkoStore, {
      task: awaitingCollaboration,
      text: input.inboundText,
      requesterName: input.requesterName
    });
    input.updateSessionProjectMemoryFromInbound({
      sessionId: resumedTask.sessionId,
      requesterName: input.requesterName,
      requestedBy: input.requestedBy,
      source: input.source,
      inboundText: input.inboundText,
      taskText: input.taskText,
      stage: "resuming_collaboration",
      unresolvedQuestions: [],
      nextActions: ["等待团队重新汇总并继续交付"]
    });
    if (resumedTask.sessionId) {
      input.store.appendSessionMessage({
        sessionId: resumedTask.sessionId,
        actorType: "system",
        actorId: "orchestrator",
        messageType: "event",
        content: `已续接协作任务：${resumedTask.title}`,
        metadata: {
          type: "collaboration_resumed",
          taskId: resumedTask.id,
          collaborationId:
            typeof resumedTask.metadata?.collaborationId === "string" ? resumedTask.metadata.collaborationId : "",
          source: input.source
        }
      });
    }
    return input.finalize({
      type: "operator_action_applied",
      message: `收到，我已把这次补充信息续接到原协作任务（${awaitingCollaboration.id.slice(0, 8)}），现在继续汇总并推进交付。`,
      actionId: awaitingCollaboration.id
    });
  }

  return undefined;
}

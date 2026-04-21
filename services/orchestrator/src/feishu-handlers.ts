import express from "express";
import {
  FeishuClient,
  FeishuWebSocketMonitor,
  parseFeishuEvent,
  buildFeedbackGoodCard,
  buildFeedbackPoorCard,
  type FeishuConnectionMode,
  type FeishuCardActionEvent,
  type FeishuMessageEvent
} from "@vinko/feishu-gateway";
import { resolveFeishuAckMode, getEmojiSelector, resolveFeishuApproverOpenIds } from "@vinko/shared";
import type {
  EmojiScene,
  RoleId,
  VinkoStore,
  RuntimeEnv,
  AuditEventRecord,
  ApprovalRecord,
  OperatorActionRecord,
  TaskRecord
} from "@vinko/shared";
import {
  parseFeishuCardDecisionPayload,
  validateFeishuCardDecision,
  ExpiringTokenDeduper
} from "./feishu-approval.js";

// ============ Constants ============

const FEISHU_APPROVAL_CARD_TTL_MS = 15 * 60 * 1000;
const FEISHU_CARD_ACTION_TOKEN_TTL_MS = 15 * 60 * 1000;
const FEISHU_INBOUND_MESSAGE_DEDUP_TTL_MS = 10 * 60 * 1000;
const FEISHU_SENDER_NAME_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const EMAIL_INBOUND_LEDGER_CONFIG_KEY = "email-inbound-ledger";

// ============ Config helpers ============

export function resolveFeishuConnectionMode(getRuntimeValue: (key: string) => string): FeishuConnectionMode {
  const mode = getRuntimeValue("FEISHU_CONNECTION_MODE").trim().toLowerCase();
  return mode === "webhook" ? "webhook" : "websocket";
}

export function createFeishuClient(getRuntimeValue: (key: string) => string): FeishuClient {
  return new FeishuClient({
    appId: getRuntimeValue("FEISHU_APP_ID"),
    appSecret: getRuntimeValue("FEISHU_APP_SECRET"),
    domain: getRuntimeValue("FEISHU_DOMAIN")
  });
}

export function resolveFeishuOwnerOpenIds(getRuntimeValue: (key: string) => string, envFeishuOwnerOpenIds: string[]): string[] {
  const runtimeConfigured = getRuntimeValue("FEISHU_OWNER_OPEN_IDS")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (runtimeConfigured.length > 0) {
    return runtimeConfigured;
  }
  return envFeishuOwnerOpenIds.map((entry) => entry.trim()).filter(Boolean);
}

export function isFeishuApprovalCardEnabled(getRuntimeValue: (key: string) => string): boolean {
  const raw = getRuntimeValue("FEISHU_APPROVAL_CARD_ENABLED").trim().toLowerCase();
  return raw === "" || raw === "true" || raw === "1";
}

export function isFeishuApprovalRequesterNotifyEnabled(getRuntimeValue: (key: string) => string): boolean {
  const raw = getRuntimeValue("FEISHU_APPROVAL_REQUESTER_NOTIFY_ENABLED").trim().toLowerCase();
  return raw === "" || raw === "true" || raw === "1";
}

export function shouldResolveFeishuSenderNames(getRuntimeValue: (key: string) => string): boolean {
  const raw = getRuntimeValue("FEISHU_RESOLVE_SENDER_NAMES").trim().toLowerCase();
  return raw === "" || raw === "true" || raw === "1";
}

export function isLikelyFeishuOpenId(value: string): boolean {
  return /^ou_[a-z0-9]{8,}$/i.test(value.trim());
}

export function resolveApprovalRequesterOpenId(
  requestedBy: string | undefined,
  getRuntimeValue: (key: string) => string,
  envFeishuOwnerOpenIds: string[]
): string | undefined {
  const normalized = requestedBy?.trim() ?? "";
  if (isLikelyFeishuOpenId(normalized)) {
    return normalized;
  }
  if (normalized.toLowerCase() !== "owner") {
    return undefined;
  }
  return resolveFeishuOwnerOpenIds(getRuntimeValue, envFeishuOwnerOpenIds).find((openId) =>
    isLikelyFeishuOpenId(openId)
  );
}

export function resolveFeishuApproverOpenIdsForRole(
  roleId: RoleId,
  getRuntimeValue: (key: string) => string,
  envFeishuOwnerOpenIds: string[]
): string[] {
  return resolveFeishuApproverOpenIds({
    roleId,
    approverOpenIdsJson: getRuntimeValue("FEISHU_APPROVER_OPEN_IDS_JSON"),
    fallbackOwnerOpenIds: resolveFeishuOwnerOpenIds(getRuntimeValue, envFeishuOwnerOpenIds)
  });
}

// ============ Feishu approval card helpers ============

export function buildApprovalRequesterReminderText(input: {
  approvalId: string;
  summary: string;
  failureReason?: string | undefined;
}): string {
  const approvalShortId = input.approvalId.slice(0, 8);
  if (!input.failureReason) {
    return [
      `审批提醒：审批单 ${approvalShortId} 已创建（${input.summary}）。请在飞书审批卡或控制台处理。`,
      `若卡片按钮不可用，可直接回复：1（同意）或 0（拒绝）。若存在多个待审批，再补编号：1 ${approvalShortId} / 0 ${approvalShortId}。`
    ].join("\n");
  }
  return [
    `审批提醒：审批单 ${approvalShortId} 已创建（${input.summary}）。`,
    "当前审批卡发送给审批人失败，请先在控制台处理审批。",
    `失败原因：${input.failureReason.slice(0, 160)}`,
    `可直接回复：1（同意）或 0（拒绝）。若存在多个待审批，再补编号：1 ${approvalShortId} / 0 ${approvalShortId}。`,
    "请检查 FEISHU_APPROVER_OPEN_IDS_JSON / FEISHU_OWNER_OPEN_IDS 配置。"
  ].join("\n");
}

export function buildFeishuApprovalDecisionCard(input: {
  approvalId: string;
  stepId: string;
  roleId: RoleId;
  summary: string;
  requestedBy?: string | undefined;
  approverOpenId: string;
}): Record<string, unknown> {
  const expiresAt = Date.now() + FEISHU_APPROVAL_CARD_TTL_MS;
  const decisionValue = {
    kind: "approval_decision",
    approvalId: input.approvalId,
    stepId: input.stepId,
    roleId: input.roleId,
    approverOpenId: input.approverOpenId,
    expiresAt
  };
  return {
    config: {
      wide_screen_mode: true
    },
    header: {
      title: {
        tag: "plain_text",
        content: "审批请求"
      },
      template: "orange"
    },
    elements: [
      {
        tag: "markdown",
        content: [
          `**审批单**: ${input.approvalId.slice(0, 8)}`,
          `**步骤角色**: ${input.roleId}`,
          `**摘要**: ${input.summary}`,
          `**发起人**: ${input.requestedBy?.trim() || "unknown"}`
        ].join("\n")
      },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            text: {
              tag: "plain_text",
              content: "批准"
            },
            type: "primary",
            value: {
              ...decisionValue,
              decision: "approved"
            }
          },
          {
            tag: "button",
            text: {
              tag: "plain_text",
              content: "拒绝"
            },
            type: "danger",
            value: {
              ...decisionValue,
              decision: "rejected"
            }
          }
        ]
      }
    ]
  };
}

// ============ Feishu text normalization ============

export function normalizeFeishuInboundText(raw: string): string {
  const normalized = raw
    .replace(/<at\b[^>]*>(.*?)<\/at>/gi, (_match, label: string) => {
      const trimmed = String(label ?? "").trim();
      if (!trimmed || /^_user_\d+$/i.test(trimmed)) {
        return " ";
      }
      return ` @${trimmed} `;
    })
    .replace(/@_user_\d+\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized || raw.trim();
}

export function sanitizeFeishuAckMessage(message: string): string {
  const blockedPatterns = [
    /根据系统策略/u,
    /该消息被识别为闲聊/u,
    /无需触发任务创建或审批流程/u,
    /回复礼貌问候/u,
    /保持系统待命状态/u,
    /等待用户后续输入具体任务需求/u,
    /思考过程/u,
    /推理过程/u,
    /收到.+通过飞书发送(?:的)?(?:问候)?消息/u
  ];
  const sanitized = message
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !blockedPatterns.some((pattern) => pattern.test(line)))
    .join("\n")
    .trim();
  return sanitized || "收到，我在。请直接告诉我要完成的任务。";
}

// ============ Channel status ============

export function getChannelStatus(
  getRuntimeValue: (key: string) => string,
  parseRuntimeBoolean: (key: string, fallback: boolean) => boolean,
  envFeishuOwnerOpenIds: string[]
) {
  const feishuMissing: string[] = [];
  if (!getRuntimeValue("FEISHU_APP_ID")) {
    feishuMissing.push("FEISHU_APP_ID");
  }
  if (!getRuntimeValue("FEISHU_APP_SECRET")) {
    feishuMissing.push("FEISHU_APP_SECRET");
  }
  const feishuDomain = getRuntimeValue("FEISHU_DOMAIN") || "feishu";
  const feishuConnectionMode = resolveFeishuConnectionMode(getRuntimeValue);
  const verificationTokenConfigured = Boolean(getRuntimeValue("FEISHU_VERIFICATION_TOKEN"));
  const encryptKeyConfigured = Boolean(getRuntimeValue("FEISHU_ENCRYPT_KEY"));
  const resolveSenderNames = shouldResolveFeishuSenderNames(getRuntimeValue);

  const emailMissing: string[] = [];
  if (!getRuntimeValue("SMTP_URL")) {
    emailMissing.push("SMTP_URL");
  }
  if (!getRuntimeValue("EMAIL_DEFAULT_FROM")) {
    emailMissing.push("EMAIL_DEFAULT_FROM");
  }

  const inboundEnabled = parseRuntimeBoolean("EMAIL_INBOUND_ENABLED", false);
  const inboundMissing: string[] = [];
  const inboundHost = getRuntimeValue("EMAIL_INBOUND_IMAP_HOST");
  const inboundUsername = getRuntimeValue("EMAIL_INBOUND_USERNAME");
  const inboundMailbox = getRuntimeValue("EMAIL_INBOUND_MAILBOX") || "INBOX";
  const inboundSubjectPrefix = getRuntimeValue("EMAIL_INBOUND_SUBJECT_PREFIX");
  const inboundPollIntervalMs = Number(getRuntimeValue("EMAIL_INBOUND_POLL_INTERVAL_MS") || "15000");
  const inboundRateLimitPerMinute = Number(getRuntimeValue("EMAIL_INBOUND_RATE_LIMIT_PER_MINUTE") || "20");
  const inboundAllowedSenders = getRuntimeValue("EMAIL_INBOUND_ALLOWED_SENDERS")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    feishu: {
      configured: feishuMissing.length === 0,
      missing: feishuMissing,
      ownerOpenIdsConfigured: envFeishuOwnerOpenIds.length > 0,
      domain: feishuDomain,
      connectionMode: feishuConnectionMode,
      resolveSenderNames,
      verificationTokenConfigured,
      encryptKeyConfigured
    },
    email: {
      configured: emailMissing.length === 0,
      missing: emailMissing,
      inbound: {
        enabled: inboundEnabled,
        configured: !inboundEnabled || inboundMissing.length === 0,
        missing: inboundMissing,
        mailbox: inboundMailbox,
        subjectPrefix: inboundSubjectPrefix,
        pollIntervalSeconds: Number.isFinite(inboundPollIntervalMs)
          ? Math.max(1, Math.round(inboundPollIntervalMs / 1000))
          : 15,
        rateLimitPerMinute: Number.isFinite(inboundRateLimitPerMinute)
          ? Math.max(1, Math.round(inboundRateLimitPerMinute))
          : 20,
        allowedSendersConfigured: inboundAllowedSenders.length > 0,
        allowedSendersCount: inboundAllowedSenders.length
      }
    }
  };
}

// ============ FeishuHandlers class ============

export interface FeishuHandlerDeps {
  store: VinkoStore;
  env: RuntimeEnv;
  getRuntimeValue: (key: string) => string;
  parseRuntimeBoolean: (key: string, fallback: boolean) => boolean;
  parseRuntimeInteger: (key: string, fallback: number, options?: { min?: number; max?: number }) => number;
  parseRuntimeList: (key: string) => string[];
  parseIsoMs: (value: string | undefined) => number | undefined;
  listToolProviderStatuses: (
    env: RuntimeEnv,
    policy: { providerOrder: string[] },
    secrets: Record<string, string>
  ) => Array<{ providerId: string; available: boolean }>;
  sanitizeApprovalRecord: <T extends { payload: Record<string, unknown> }>(approval: T) => T;
  sanitizeOperatorActionRecord: <T extends { payload: Record<string, unknown> }>(action: T) => T;
  resolveFeishuApproverOpenIdsForRole: (roleId: RoleId) => string[];
  notifyApprovalRequesterViaFeishu: (input: {
    approvalId: string;
    stepId: string;
    summary: string;
    requestedBy?: string | undefined;
    failureReason?: string | undefined;
  }) => Promise<void>;
  safeEmitApprovalLifecycleEvent: (input: {
    phase: string;
    approvalId: string;
    kind: string;
    status: string;
    requestedBy?: string | undefined;
    decidedBy?: string | undefined;
  }) => Promise<void>;
  applyApprovalDecisionEffects: (approval: ApprovalRecord | undefined) => Promise<void>;
  processFeishuInboundMessage: (message: FeishuMessageEvent) => Promise<unknown>;
}

export interface FeishuHandlers {
  normalizeFeishuInboundText(raw: string): string;
  sanitizeFeishuAckMessage(message: string): string;
  resolveFeishuConnectionMode(): FeishuConnectionMode;
  getChannelStatus(): ReturnType<typeof getChannelStatus>;
  handleFeishuCardAction(cardAction: FeishuCardActionEvent): Promise<void>;
  sendFeishuInboundAck(
    message: FeishuMessageEvent,
    result: { message: string },
    scene?: EmojiScene,
    options?: { forceText?: boolean; skipReaction?: boolean }
  ): Promise<void>;
  notifyApprovalStepViaFeishu(approvalId: string, stepId?: string): Promise<void>;
  handleFeishuEventsWebhook(request: express.Request, response: express.Response): Promise<void>;
  startFeishuInboundTransport(): void;
  stopFeishuInboundTransport(): void;
}

export function createFeishuHandlers(deps: FeishuHandlerDeps): FeishuHandlers {
  const {
    store,
    env,
    getRuntimeValue,
    parseRuntimeBoolean,
    parseRuntimeInteger,
    parseIsoMs,
    sanitizeApprovalRecord,
    sanitizeOperatorActionRecord,
    resolveFeishuApproverOpenIdsForRole,
    notifyApprovalRequesterViaFeishu,
    safeEmitApprovalLifecycleEvent,
    applyApprovalDecisionEffects,
    processFeishuInboundMessage
  } = deps;

  // State
  const feishuCardActionTokenDeduper = new ExpiringTokenDeduper(FEISHU_CARD_ACTION_TOKEN_TTL_MS);
  const feishuNotifiedApprovalSteps = new Set<string>();
  const feishuRequesterApprovalReminders = new Set<string>();
  const feishuSenderNameCache = new Map<string, { name: string; expiresAt: number }>();
  let feishuWebSocketMonitor: FeishuWebSocketMonitor | undefined;

  function createClient(): FeishuClient {
    return new FeishuClient({
      appId: getRuntimeValue("FEISHU_APP_ID"),
      appSecret: getRuntimeValue("FEISHU_APP_SECRET"),
      domain: getRuntimeValue("FEISHU_DOMAIN")
    });
  }

  async function sendFeishuPrivateFeedback(openId: string, text: string): Promise<void> {
    try {
      await createClient().sendTextToUser(openId, text);
    } catch (error) {
      store.appendAuditEvent({
        category: "feishu",
        entityType: "card_action",
        entityId: openId,
        message: "Failed to send Feishu private feedback",
        payload: {
          error: error instanceof Error ? error.message : String(error)
        }
      });
    }
  }

  async function resolveFeishuSenderName(senderId: string): Promise<string | undefined> {
    if (!shouldResolveFeishuSenderNames(getRuntimeValue)) {
      return undefined;
    }

    const normalizedSenderId = senderId.trim();
    if (!normalizedSenderId) {
      return undefined;
    }

    const cached = feishuSenderNameCache.get(normalizedSenderId);
    if (cached) {
      if (cached.expiresAt > Date.now()) {
        return cached.name;
      }
      feishuSenderNameCache.delete(normalizedSenderId);
    }

    const feishuAppId = getRuntimeValue("FEISHU_APP_ID");
    const feishuAppSecret = getRuntimeValue("FEISHU_APP_SECRET");
    if (!feishuAppId || !feishuAppSecret) {
      return undefined;
    }

    try {
      const resolved = (await createClient().resolveUserDisplayName(normalizedSenderId))?.trim();
      if (!resolved) {
        return undefined;
      }
      feishuSenderNameCache.delete(normalizedSenderId);
      feishuSenderNameCache.set(normalizedSenderId, {
        name: resolved,
        expiresAt: Date.now() + FEISHU_SENDER_NAME_CACHE_TTL_MS
      });
      while (feishuSenderNameCache.size > 2000) {
        const oldestKey = feishuSenderNameCache.keys().next().value as string | undefined;
        if (oldestKey) {
          feishuSenderNameCache.delete(oldestKey);
        } else {
          break;
        }
      }
      return resolved;
    } catch (error) {
      store.appendAuditEvent({
        category: "feishu",
        entityType: "user",
        entityId: normalizedSenderId,
        message: "Failed to resolve Feishu sender profile",
        payload: {
          error: error instanceof Error ? error.message : String(error)
        }
      });
      return undefined;
    }
  }

  async function handleFeishuCardAction(cardAction: FeishuCardActionEvent): Promise<void> {
    if (!feishuCardActionTokenDeduper.claim(cardAction.token)) {
      return;
    }

    // task_feedback: user rated a completed light_collaboration task 👍 or 👎
    const actionKind = cardAction.actionValue.kind;
    if (actionKind === "task_feedback") {
      const taskId = cardAction.actionValue.taskId as string | undefined;
      const rating = cardAction.actionValue.rating as "good" | "poor" | undefined;
      const chatId = cardAction.actionValue.chatId as string | undefined;
      const task = taskId ? store.getTask(taskId) : undefined;
      if (!task || !chatId) return;

      if (rating === "good") {
        store.addWorkspaceDecision(
          `任务「${task.title}」用户评为满意`,
          `角色 ${task.roleId} 执行的任务获得正面反馈`,
          "quality_signal"
        );
        try {
          await createClient().sendCardToChat(chatId, buildFeedbackGoodCard());
        } catch { /* best-effort */ }
      } else if (rating === "poor") {
        store.createTask({
          sessionId: task.sessionId,
          source: task.source,
          requestedBy: task.requestedBy,
          chatId: task.chatId,
          roleId: task.roleId,
          title: `[重试] ${task.title}`,
          instruction: `上次结果用户不满意，请重新完成以下任务：\n\n${task.instruction}`,
          priority: task.priority,
          metadata: { retriedFromTaskId: task.id }
        });
        try {
          await createClient().sendCardToChat(chatId, buildFeedbackPoorCard());
        } catch { /* best-effort */ }
      }
      return;
    }

    const payload = parseFeishuCardDecisionPayload(cardAction.actionValue);
    const approval = payload ? store.getApproval(payload.approvalId) : undefined;
    const pendingStep = payload ? store.getPendingApprovalWorkflowStep(payload.approvalId) : undefined;
    const allowedApprovers = pendingStep ? resolveFeishuApproverOpenIdsForRole(pendingStep.step.roleId) : [];
    const validation = validateFeishuCardDecision({
      payload,
      operatorOpenId: cardAction.operatorOpenId,
      approvalExists: Boolean(approval),
      pendingStepId: pendingStep?.step.id,
      allowedApproverOpenIds: allowedApprovers
    });

    if (!validation.ok) {
      store.appendAuditEvent({
        category: "feishu",
        entityType: "card_action",
        entityId: cardAction.operatorOpenId,
        message: "Rejected Feishu card action",
        payload: {
          reason: validation.reason,
          token: cardAction.token
        }
      });
      await sendFeishuPrivateFeedback(cardAction.operatorOpenId, validation.feedback);
      return;
    }

    if (!approval || !pendingStep || !payload) {
      await sendFeishuPrivateFeedback(cardAction.operatorOpenId, "审批上下文缺失，请重新触发审批。");
      return;
    }

    await safeEmitApprovalLifecycleEvent({
      phase: "before_approval_decision",
      approvalId: approval.id,
      kind: approval.kind,
      status: approval.status,
      requestedBy: approval.requestedBy,
      decidedBy: cardAction.operatorOpenId
    });

    let decisionResult: ReturnType<typeof store.decideApprovalWorkflowStep> | undefined;
    try {
      decisionResult = store.decideApprovalWorkflowStep({
        approvalId: payload.approvalId,
        stepId: payload.stepId,
        status: payload.decision,
        decidedBy: cardAction.operatorOpenId,
        decisionNote: `via_feishu_card:${cardAction.token}`
      });
    } catch (error) {
      await sendFeishuPrivateFeedback(
        cardAction.operatorOpenId,
        `审批提交失败：${error instanceof Error ? error.message : String(error)}`
      );
      return;
    }

    const decidedApproval = decisionResult?.approval ?? store.getApproval(approval.id) ?? approval;
    await safeEmitApprovalLifecycleEvent({
      phase: "after_approval_decision",
      approvalId: decidedApproval.id,
      kind: decidedApproval.kind,
      status: decidedApproval.status,
      requestedBy: decidedApproval.requestedBy,
      decidedBy: decidedApproval.decidedBy
    });

    try {
      await applyApprovalDecisionEffects(decidedApproval);
    } catch (error) {
      await sendFeishuPrivateFeedback(
        cardAction.operatorOpenId,
        `审批已记录，但执行失败：${error instanceof Error ? error.message : String(error)}`
      );
      return;
    }

    await notifyApprovalStepViaFeishu(approval.id);
    const stillPending = store.getPendingApprovalWorkflowStep(approval.id);
    if (stillPending) {
      await sendFeishuPrivateFeedback(
        cardAction.operatorOpenId,
        `已${payload.decision === "approved" ? "批准" : "拒绝"}，审批单进入下一步（${stillPending.step.roleId}）。`
      );
      return;
    }
    await sendFeishuPrivateFeedback(
      cardAction.operatorOpenId,
      `已${payload.decision === "approved" ? "批准" : "拒绝"}：${approval.summary}`
    );
  }

  async function sendFeishuInboundAck(
    message: FeishuMessageEvent,
    result: { message: string },
    scene?: EmojiScene,
    options?: { forceText?: boolean; skipReaction?: boolean }
  ): Promise<void> {
    const feishuAppId = getRuntimeValue("FEISHU_APP_ID");
    const feishuAppSecret = getRuntimeValue("FEISHU_APP_SECRET");
    if (!feishuAppId || !feishuAppSecret) {
      return;
    }

    const mode = resolveFeishuAckMode(getRuntimeValue("FEISHU_ACK_MODE"));
    const client = createClient();
    let reactionSucceeded = false;
    if (!options?.skipReaction && (mode === "reaction_only" || mode === "reaction_plus_text")) {
      try {
        const emoji = getEmojiSelector().selectEmoji(scene ?? "taskQueued");
        await client.addReactionToMessage(message.messageId, emoji);
        reactionSucceeded = true;
      } catch (error) {
        store.appendAuditEvent({
          category: "feishu",
          entityType: "chat",
          entityId: message.chatId,
          message: "Failed to send Feishu reaction ack",
          payload: {
            messageId: message.messageId,
            error: error instanceof Error ? error.message : String(error)
          }
        });
      }
    }

    const shouldSendText =
      Boolean(options?.forceText) ||
      mode === "text" ||
      mode === "reaction_plus_text" ||
      !reactionSucceeded;
    if (!shouldSendText) {
      return;
    }
    const userFacingMessage = sanitizeFeishuAckMessage(result.message);
    try {
      await client.sendTextToChat(message.chatId, userFacingMessage);
    } catch (error) {
      store.appendAuditEvent({
        category: "feishu",
        entityType: "chat",
        entityId: message.chatId,
        message: "Failed to send Feishu acknowledgement",
        payload: {
          error: error instanceof Error ? error.message : String(error)
        }
      });
    }
  }

  async function notifyApprovalStepViaFeishu(approvalId: string, stepId?: string): Promise<void> {
    if (!isFeishuApprovalCardEnabled(getRuntimeValue)) {
      return;
    }
    const approval = store.getApproval(approvalId);
    if (!approval || approval.status !== "pending") {
      return;
    }

    const pending = store.getPendingApprovalWorkflowStep(approvalId);
    if (!pending) {
      return;
    }
    if (stepId && pending.step.id !== stepId) {
      return;
    }
    if (feishuNotifiedApprovalSteps.has(pending.step.id)) {
      return;
    }

    const client = createClient();
    const approverOpenIds = resolveFeishuApproverOpenIdsForRole(pending.step.roleId);
    if (approverOpenIds.length === 0) {
      store.appendAuditEvent({
        category: "approval",
        entityType: "approval",
        entityId: approvalId,
        message: "No Feishu approver configured for pending approval step",
        payload: {
          roleId: pending.step.roleId
        }
      });
      await notifyApprovalRequesterViaFeishu({
        approvalId: approval.id,
        stepId: pending.step.id,
        summary: approval.summary,
        requestedBy: approval.requestedBy,
        failureReason: "No approver configured for this approval step"
      });
      return;
    }

    let deliveredCount = 0;
    let firstDeliveryError = "";
    for (const approverOpenId of approverOpenIds) {
      try {
        const card = buildFeishuApprovalDecisionCard({
          approvalId: approval.id,
          stepId: pending.step.id,
          roleId: pending.step.roleId,
          summary: approval.summary,
          requestedBy: approval.requestedBy,
          approverOpenId
        });
        await client.sendCardToUser(approverOpenId, card);
        deliveredCount += 1;
      } catch (error) {
        if (!firstDeliveryError) {
          firstDeliveryError = error instanceof Error ? error.message : String(error);
        }
        store.appendAuditEvent({
          category: "feishu",
          entityType: "approval",
          entityId: approval.id,
          message: "Failed to send Feishu approval card",
          payload: {
            stepId: pending.step.id,
            approverOpenId,
            error: error instanceof Error ? error.message : String(error)
          }
        });
      }
    }

    await notifyApprovalRequesterViaFeishu({
      approvalId: approval.id,
      stepId: pending.step.id,
      summary: approval.summary,
      requestedBy: approval.requestedBy,
      ...(deliveredCount === 0 ? { failureReason: firstDeliveryError || "Unknown delivery error" } : {})
    });

    if (deliveredCount > 0) {
      feishuNotifiedApprovalSteps.add(pending.step.id);
      store.appendAuditEvent({
        category: "feishu",
        entityType: "approval",
        entityId: approval.id,
        message: "Sent Feishu approval card",
        payload: {
          stepId: pending.step.id,
          roleId: pending.step.roleId,
          deliveredCount
        }
      });
    }
  }

  async function handleFeishuEventsWebhook(request: express.Request, response: express.Response) {
    const parseInput: {
      verificationToken?: string;
      encryptKey?: string;
      headers?: Record<string, string | string[] | undefined>;
      rawBody?: string;
    } = {
      verificationToken: getRuntimeValue("FEISHU_VERIFICATION_TOKEN"),
      encryptKey: getRuntimeValue("FEISHU_ENCRYPT_KEY"),
      headers: request.headers
    };
    const rawBody = (request as express.Request & { rawBody?: string }).rawBody;
    if (rawBody) {
      parseInput.rawBody = rawBody;
    }

    const parsed = parseFeishuEvent(request.body, {
      ...parseInput
    });

    if (parsed.kind === "challenge") {
      store.appendAuditEvent({
        category: "feishu",
        entityType: "verification",
        entityId: "url_verification",
        message: "Received Feishu URL verification challenge"
      });
      response.json({ challenge: parsed.challenge });
      return;
    }

    if (parsed.kind === "ignored") {
      store.appendAuditEvent({
        category: "feishu",
        entityType: "event",
        entityId: "ignored",
        message: "Ignored Feishu event",
        payload: {
          reason: parsed.reason
        }
      });
      response.json({ ok: true, reason: parsed.reason });
      return;
    }

    if (parsed.kind === "card_action") {
      await handleFeishuCardAction(parsed.cardAction);
      response.json({ ok: true, kind: "card_action" });
      return;
    }

    const result = await processFeishuInboundMessage(parsed.message);
    response.json({ ok: true, result });
  }

  function stopFeishuInboundTransport(): void {
    feishuWebSocketMonitor?.stop();
    feishuWebSocketMonitor = undefined;
  }

  function startFeishuInboundTransport(): void {
    if (resolveFeishuConnectionMode(getRuntimeValue) !== "websocket") {
      return;
    }
    if (feishuWebSocketMonitor) {
      return;
    }

    const appId = getRuntimeValue("FEISHU_APP_ID");
    const appSecret = getRuntimeValue("FEISHU_APP_SECRET");
    const domain = getRuntimeValue("FEISHU_DOMAIN");
    if (!appId || !appSecret) {
      store.appendAuditEvent({
        category: "feishu",
        entityType: "monitor",
        entityId: "websocket",
        message: "Skipped Feishu websocket monitor startup: missing credentials",
        payload: {
          appIdConfigured: Boolean(appId),
          appSecretConfigured: Boolean(appSecret)
        }
      });
      return;
    }

    feishuWebSocketMonitor = new FeishuWebSocketMonitor({
      appId,
      appSecret,
      domain,
      verificationToken: getRuntimeValue("FEISHU_VERIFICATION_TOKEN"),
      encryptKey: getRuntimeValue("FEISHU_ENCRYPT_KEY"),
      onMessage: async (message) => {
        await processFeishuInboundMessage(message);
      },
      onCardAction: async (cardAction) => {
        await handleFeishuCardAction(cardAction);
      },
      onIgnored: (reason) => {
        store.appendAuditEvent({
          category: "feishu",
          entityType: "event",
          entityId: "ignored",
          message: "Ignored Feishu websocket event",
          payload: { reason }
        });
      },
      onError: (error) => {
        store.appendAuditEvent({
          category: "feishu",
          entityType: "monitor",
          entityId: "websocket",
          message: "Feishu websocket monitor error",
          payload: {
            error: error instanceof Error ? error.message : String(error)
          }
        });
      },
      onLog: (line) => {
        // Use logger from deps if needed
      }
    });

    feishuWebSocketMonitor.start();
    store.appendAuditEvent({
      category: "feishu",
      entityType: "monitor",
      entityId: "websocket",
      message: "Feishu websocket monitor started",
      payload: { domain: domain || "feishu" }
    });
  }

  return {
    normalizeFeishuInboundText,
    sanitizeFeishuAckMessage,
    resolveFeishuConnectionMode: () => resolveFeishuConnectionMode(getRuntimeValue),
    getChannelStatus: () => getChannelStatus(getRuntimeValue, parseRuntimeBoolean, env.feishuOwnerOpenIds),
    handleFeishuCardAction,
    sendFeishuInboundAck,
    notifyApprovalStepViaFeishu,
    handleFeishuEventsWebhook,
    startFeishuInboundTransport,
    stopFeishuInboundTransport
  };
}

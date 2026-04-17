import express from "express";
import nodemailer from "nodemailer";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createLogger,
  createRuntimeValueResolver,
  buildWorkflowStatusSummary,
  getEmojiSelector,
  listRoles,
  listSkills,
  searchMarketplaceSkills,
  createOrchestrationState,
  getMarketplaceSkillDetail,
  getMarketplaceRecommendation,
  getSkillDefinition,
  listToolProviderStatuses,
  loadEnv,
  renderPrometheusMetrics,
  normalizeToolExecPolicy,
  parseOperatorActionFromText,
  parseOperatorConfigInputRequirementFromText,
  parseTemplateToggleCommand,
  resolveFeishuAckMode,
  resolveFeishuApproverOpenIds,
  resolveSearchProviderApiKeyEnv,
  resolveSearchProviderId,
  resolveRoleId,
  roleCanUseSkill,
  isSkillAutoApproveAllowed,
  summarizeOperatorAction,
  VinkoStore,
  type ApprovalDecisionInput,
  type CreateRoutingTemplateInput,
  type CreateTaskInput,
  type EmojiScene,
  type RoleId,
  type ToolExecPolicy,
  type TaskAttachment,
  type TaskMetadata,
  type OperatorActionRecord,
  type GoalRunRecord,
  type TaskRecord,
  type RoutingTemplate,
  type UpdateRoutingTemplateInput,
  // Plugin imports
  listPlugins,
  getPlugin,
  enablePlugin,
  disablePlugin,
  emitApprovalLifecycle,
  getPluginState,
  updatePluginConfig,
  loadBundledPlugins,
  type PluginInstance
} from "@vinko/shared";
import {
  FeishuClient,
  FeishuWebSocketMonitor,
  parseFeishuEvent,
  buildNeedsClarificationCard,
  buildTaskQueuedCard,
  buildApprovalResultCard,
  type FeishuConnectionMode,
  type FeishuCardActionEvent,
  type FeishuMessageEvent
} from "@vinko/feishu-gateway";
import { registerTaskRoutes } from "./routes/tasks.js";
import { registerApprovalRoutes } from "./routes/approvals.js";
import { registerGoalRunRoutes } from "./routes/goal-runs.js";
import { registerSelfCheckRoutes } from "./routes/self-check.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerSystemRoutes } from "./routes/system.js";
import { registerConfigRoutes } from "./routes/config.js";
import { registerPluginRoutes } from "./routes/plugins.js";
import { registerRoutingTemplateRoutes } from "./routes/routing-templates.js";
import { registerSkillsMarketplaceRoutes } from "./routes/skills-marketplace.js";
import { summarizeLatencyMetrics } from "./routes/response-utils.js";
import {
  buildSmalltalkReply,
  resolveCollaborationEntryRole,
  isContinueSignal,
  isOwnerLowRiskOperatorAction,
  isOwnerRequester,
  isSmalltalkMessage
} from "./inbound-policy.js";
import { shouldRouteToGoalRun } from "./goal-run-routing.js";
import { initGlobalTelemetry } from "@vinko/agent-runtime";
import { resolveDataPath } from "@vinko/shared";
import {
  formatSkillSearchResultsMessage,
  isExactMarketplaceSkillMatch,
  parseSkillInstallIntent,
  parseSkillSearchIntent
} from "./skills-marketplace-flow.js";
import {
  analyzeIntakeClarity,
  isObviouslyClear,
  mergeClarificationResponse,
  formatClarificationMessage
} from "./intake-analyzer.js";
import { classifyInboundIntent, analyzeCollaborationNeed } from "./intent-classifier.js";
import { selectRoleFromText } from "./role-selection.js";
import {
  formatAwaitingCollaborationMessage,
  resolveAwaitingCollaborationTaskForInbound,
  resumeAwaitingCollaborationTask
} from "./inbound-collaboration.js";
import {
  ExpiringTokenDeduper,
  parseFeishuCardDecisionPayload,
  validateFeishuCardDecision
} from "./feishu-approval.js";

const env = loadEnv();
const store = VinkoStore.fromEnv(env);
const telemetryDb = resolveDataPath(env, "telemetry.db");
initGlobalTelemetry(telemetryDb);
const logger = createLogger("orchestrator");
const runtimeValues = createRuntimeValueResolver({
  env,
  getRuntimeSettings: () => store.getRuntimeSettings(),
  getRuntimeSecrets: () => store.getRuntimeSecrets()
});
const app = express();
const controlCenterRoot = path.resolve(fileURLToPath(new URL("../../../apps/control-center/public", import.meta.url)));
const productSelfcheckDir = path.resolve(fileURLToPath(new URL("../../../.run/product-selfcheck", import.meta.url)));
const harnessReportDir = path.resolve(fileURLToPath(new URL("../../../.run/harness", import.meta.url)));
const productSelfcheckLatestFile = path.join(productSelfcheckDir, "latest.json");
const productSelfcheckHistoryFile = path.join(productSelfcheckDir, "history.jsonl");
const productSelfcheckWatcherPidFile = path.join(productSelfcheckDir, "watch.pid");
const EMAIL_INBOUND_LEDGER_CONFIG_KEY = "email-inbound-ledger";
let feishuWebSocketMonitor: FeishuWebSocketMonitor | undefined;
const FEISHU_APPROVAL_CARD_TTL_MS = 15 * 60 * 1000;
const FEISHU_CARD_ACTION_TOKEN_TTL_MS = 15 * 60 * 1000;
const FEISHU_INBOUND_MESSAGE_DEDUP_TTL_MS = 10 * 60 * 1000;
const FEISHU_SENDER_NAME_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const feishuCardActionTokenDeduper = new ExpiringTokenDeduper(FEISHU_CARD_ACTION_TOKEN_TTL_MS);
const feishuInboundMessageDeduper = new ExpiringTokenDeduper(FEISHU_INBOUND_MESSAGE_DEDUP_TTL_MS);
const feishuNotifiedApprovalSteps = new Set<string>();
const feishuRequesterApprovalReminders = new Set<string>();
const feishuSenderNameCache = new Map<string, { name: string; expiresAt: number }>();

type AuthenticatedUser = {
  id: string;
  username: string;
  role: string;
  displayName: string;
};

type TokenValidation =
  | { valid: false }
  | { valid: true; user: AuthenticatedUser };

function createSession(
  userId: string,
  username: string,
  role: string,
  displayName: string,
  remember: boolean,
  request?: express.Request
): { token: string; user: AuthenticatedUser; expiresAt: number } {
  const record = store.createAuthSession({
    userId,
    rememberMe: remember,
    userAgent: request?.headers["user-agent"],
    ipAddress: request?.ip
  });
  const expiresAt = new Date(record.expiresAt).getTime();
  return {
    token: record.token,
    user: { id: userId, username, role, displayName },
    expiresAt
  };
}

function validateToken(token: string): TokenValidation {
  const record = store.getAuthSessionByToken(token);
  if (!record) {
    return { valid: false };
  }
  if (Date.now() > new Date(record.expiresAt).getTime()) {
    store.deleteAuthSessionByToken(token);
    return { valid: false };
  }
  // Best-effort update last accessed timestamp
  try {
    store.updateAuthSessionLastAccessed(record.id);
  } catch {
    // non-critical
  }
  // Reconstruct user from userId convention: userId = "user-<username>"
  const username = record.userId.startsWith("user-") ? record.userId.slice(5) : record.userId;
  return {
    valid: true,
    user: {
      id: record.userId,
      username,
      role: "owner",
      displayName: username
    }
  };
}

function revokeToken(token: string): void {
  store.deleteAuthSessionByToken(token);
}

// Purge expired auth sessions from DB every 30 minutes
setInterval(() => {
  try {
    store.deleteExpiredAuthSessions();
  } catch {
    // non-critical
  }
}, 30 * 60 * 1000).unref();

function getAuthCredentials(): { username: string; password: string }[] {
  const raw = getRuntimeValue("AUTH_CREDENTIALS");
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter((cred): cred is { username: string; password: string } =>
          typeof cred?.username === "string" && typeof cred?.password === "string"
        );
      }
    } catch {
      // Ignore parse errors
    }
  }
  const defaultUser = getRuntimeValue("AUTH_USERNAME");
  const defaultPass = getRuntimeValue("AUTH_PASSWORD");
  if (defaultUser && defaultPass) {
    return [{ username: defaultUser, password: defaultPass }];
  }
  return [{ username: "admin", password: "vinkoclaw" }];
}

function extractBearerToken(request: express.Request): string | null {
  const auth = request.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) {
    return null;
  }
  return auth.slice(7).trim();
}

function authMiddleware(request: express.Request, response: express.Response, next: express.NextFunction): void {
  const token = extractBearerToken(request);
  if (!token) {
    response.status(401).json({ error: "missing_authorization" });
    return;
  }
  const validation = validateToken(token);
  if (!validation.valid) {
    response.status(401).json({ error: "invalid_token" });
    return;
  }
  (request as express.Request & { user?: AuthenticatedUser }).user = validation.user;
  next();
}

// Initialize plugins
async function initializePlugins(): Promise<void> {
  // Load persisted plugin states from store
  const pluginStates = store.listPluginStates();
  for (const state of pluginStates) {
    const { loadPluginState } = await import("@vinko/shared");
    loadPluginState(state);
  }

  // Load bundled plugins
  const pluginsDir = path.resolve(fileURLToPath(new URL("../../../packages/plugins", import.meta.url)));
  try {
    await loadBundledPlugins(pluginsDir);
    logger.info("Loaded bundled plugins", { count: listPlugins().length });
  } catch (error) {
    logger.error("Failed to load bundled plugins", error);
  }
}

app.use(
  express.json({
    limit: "2mb",
    verify: (request, _response, buffer) => {
      (request as express.Request & { rawBody?: string }).rawBody = buffer.toString("utf8");
    }
  })
);

function getRuntimeValue(key: string): string {
  return runtimeValues.get(key);
}

function parseRuntimeBoolean(key: string, fallback: boolean): boolean {
  return runtimeValues.getBoolean(key, fallback);
}

function parseRuntimeList(key: string): string[] {
  return runtimeValues.getList(key);
}

function parseRuntimeInteger(
  key: string,
  fallback: number,
  options?: { min?: number | undefined; max?: number | undefined }
): number {
  const rawText = getRuntimeValue(key).trim();
  const raw = rawText ? Number(rawText) : Number.NaN;
  const base = Number.isFinite(raw) ? Math.round(raw) : Math.round(fallback);
  const min = options?.min ?? Number.MIN_SAFE_INTEGER;
  const max = options?.max ?? Number.MAX_SAFE_INTEGER;
  return Math.max(min, Math.min(max, base));
}

function parseIsoMs(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function getStatusCount(map: Record<string, number>, key: string): number {
  return Number(map[key] ?? 0);
}

function isSyntheticSelfcheckRequester(requestedBy: string | undefined): boolean {
  const normalized = (requestedBy ?? "").trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    normalized.startsWith("ou_selfcheck") ||
    normalized.startsWith("ou_product-selfcheck") ||
    normalized.startsWith("selfcheck-")
  );
}

function countStatuses<T>(items: T[], resolveStatus: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = resolveStatus(item);
    if (!key) {
      continue;
    }
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function resolveLowRiskAutoApproveScope(): "owner" | "owner_or_control_center" | "all" | "none" {
  const raw = getRuntimeValue("OPERATOR_LOW_RISK_AUTO_APPROVE_SCOPE").trim().toLowerCase();
  if (raw === "owner" || raw === "owner_or_control_center" || raw === "all" || raw === "none") {
    return raw;
  }
  return "owner_or_control_center";
}

function isLowRiskAutoApproveEnabled(): boolean {
  return parseRuntimeBoolean("OPERATOR_LOW_RISK_AUTO_APPROVE_ENABLED", true);
}

function resolveFeishuConnectionMode(): FeishuConnectionMode {
  const mode = getRuntimeValue("FEISHU_CONNECTION_MODE").trim().toLowerCase();
  return mode === "webhook" ? "webhook" : "websocket";
}

function createFeishuClient(): FeishuClient {
  return new FeishuClient({
    appId: getRuntimeValue("FEISHU_APP_ID"),
    appSecret: getRuntimeValue("FEISHU_APP_SECRET"),
    domain: getRuntimeValue("FEISHU_DOMAIN")
  });
}

function resolveFeishuOwnerOpenIds(): string[] {
  const runtimeConfigured = parseRuntimeList("FEISHU_OWNER_OPEN_IDS");
  if (runtimeConfigured.length > 0) {
    return runtimeConfigured;
  }
  return env.feishuOwnerOpenIds.map((entry) => entry.trim()).filter(Boolean);
}

function isFeishuApprovalCardEnabled(): boolean {
  return parseRuntimeBoolean("FEISHU_APPROVAL_CARD_ENABLED", true);
}

function isFeishuApprovalRequesterNotifyEnabled(): boolean {
  return parseRuntimeBoolean("FEISHU_APPROVAL_REQUESTER_NOTIFY_ENABLED", true);
}

function shouldResolveFeishuSenderNames(): boolean {
  return parseRuntimeBoolean("FEISHU_RESOLVE_SENDER_NAMES", true);
}

function isLikelyFeishuOpenId(value: string): boolean {
  return /^ou_[a-z0-9]{8,}$/i.test(value.trim());
}

function resolveApprovalRequesterOpenId(requestedBy?: string | undefined): string | undefined {
  const normalized = requestedBy?.trim() ?? "";
  if (isLikelyFeishuOpenId(normalized)) {
    return normalized;
  }
  if (normalized.toLowerCase() !== "owner") {
    return undefined;
  }
  return resolveFeishuOwnerOpenIds().find((openId) => isLikelyFeishuOpenId(openId));
}

function buildApprovalRequesterReminderText(input: {
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

async function notifyApprovalRequesterViaFeishu(input: {
  client: FeishuClient;
  approvalId: string;
  stepId: string;
  summary: string;
  requestedBy?: string | undefined;
  failureReason?: string | undefined;
}): Promise<void> {
  if (!isFeishuApprovalRequesterNotifyEnabled()) {
    return;
  }
  const requesterOpenId = resolveApprovalRequesterOpenId(input.requestedBy);
  if (!requesterOpenId) {
    return;
  }
  const dedupeKey = `${input.stepId}:${requesterOpenId}`;
  if (feishuRequesterApprovalReminders.has(dedupeKey)) {
    return;
  }

  try {
    await input.client.sendTextToUser(
      requesterOpenId,
      buildApprovalRequesterReminderText({
        approvalId: input.approvalId,
        summary: input.summary,
        ...(input.failureReason ? { failureReason: input.failureReason } : {})
      })
    );
    feishuRequesterApprovalReminders.add(dedupeKey);
    store.appendAuditEvent({
      category: "feishu",
      entityType: "approval",
      entityId: input.approvalId,
      message: "Sent Feishu approval reminder to requester",
      payload: {
        stepId: input.stepId,
        requesterOpenId
      }
    });
  } catch (error) {
    store.appendAuditEvent({
      category: "feishu",
      entityType: "approval",
      entityId: input.approvalId,
      message: "Failed to send Feishu approval reminder to requester",
      payload: {
        stepId: input.stepId,
        requesterOpenId,
        error: error instanceof Error ? error.message : String(error)
      }
    });
  }
}

function resolveFeishuApproverOpenIdsForRole(roleId: RoleId): string[] {
  return resolveFeishuApproverOpenIds({
    roleId,
    approverOpenIdsJson: getRuntimeValue("FEISHU_APPROVER_OPEN_IDS_JSON"),
    fallbackOwnerOpenIds: resolveFeishuOwnerOpenIds()
  });
}

function buildFeishuApprovalDecisionCard(input: {
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

async function notifyApprovalStepViaFeishu(approvalId: string, stepId?: string): Promise<void> {
  if (!isFeishuApprovalCardEnabled()) {
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

  const client = createFeishuClient();
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
      client,
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
    client,
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

function getChannelStatus() {
  const feishuMissing: string[] = [];
  if (!getRuntimeValue("FEISHU_APP_ID")) {
    feishuMissing.push("FEISHU_APP_ID");
  }
  if (!getRuntimeValue("FEISHU_APP_SECRET")) {
    feishuMissing.push("FEISHU_APP_SECRET");
  }
  const feishuDomain = getRuntimeValue("FEISHU_DOMAIN") || "feishu";
  const feishuConnectionMode = resolveFeishuConnectionMode();
  const verificationTokenConfigured = Boolean(getRuntimeValue("FEISHU_VERIFICATION_TOKEN"));
  const encryptKeyConfigured = Boolean(getRuntimeValue("FEISHU_ENCRYPT_KEY"));
  const resolveSenderNames = shouldResolveFeishuSenderNames();

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
  const inboundAllowedSenders = parseRuntimeList("EMAIL_INBOUND_ALLOWED_SENDERS");
  const inboundLedger =
    store.getConfigEntry<Array<{ receivedAt?: unknown }>>(EMAIL_INBOUND_LEDGER_CONFIG_KEY) ?? [];
  const inboundLastReceivedAt =
    inboundLedger.length > 0 && typeof inboundLedger[0]?.receivedAt === "string"
      ? String(inboundLedger[0].receivedAt)
      : "";

  if (inboundEnabled) {
    if (!inboundHost) {
      inboundMissing.push("EMAIL_INBOUND_IMAP_HOST");
    }
    if (!inboundUsername) {
      inboundMissing.push("EMAIL_INBOUND_USERNAME");
    }
    if (!getRuntimeValue("EMAIL_INBOUND_PASSWORD")) {
      inboundMissing.push("EMAIL_INBOUND_PASSWORD");
    }
  }

  return {
    feishu: {
      configured: feishuMissing.length === 0,
      missing: feishuMissing,
      ownerOpenIdsConfigured: env.feishuOwnerOpenIds.length > 0,
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
        allowedSendersCount: inboundAllowedSenders.length,
        ledgerCount: inboundLedger.length,
        lastReceivedAt: inboundLastReceivedAt
      }
    }
  };
}

let metricsSnapshotCache: { data: Record<string, unknown>; expiresAt: number } | undefined;

function buildSystemMetricsSnapshot(): Record<string, unknown> {
  if (metricsSnapshotCache && Date.now() < metricsSnapshotCache.expiresAt) {
    return metricsSnapshotCache.data;
  }
  const nowMs = Date.now();
  const since24hMs = nowMs - 24 * 60 * 60 * 1000;
  const rawStatusCounts = store.getStatusCounts();
  const tasks = store.listTasks(3000).filter((task) => !isSyntheticSelfcheckRequester(task.requestedBy));
  const goalRuns = store
    .listGoalRuns({ limit: 500 })
    .filter((run) => !isSyntheticSelfcheckRequester(run.requestedBy));
  const approvals = store
    .listApprovals(500)
    .filter((approval) => !isSyntheticSelfcheckRequester(approval.requestedBy));
  const operatorActions = store
    .listOperatorActions(1200)
    .filter((action) => !isSyntheticSelfcheckRequester(action.createdBy));
  const statusCounts = {
    tasks: countStatuses(tasks, (task) => task.status),
    goalRuns: countStatuses(goalRuns, (run) => run.status),
    approvals: countStatuses(approvals, (approval) => approval.status),
    operatorActions: countStatuses(operatorActions, (action) => action.status),
    toolRuns: rawStatusCounts.toolRuns
  };
  const latency = summarizeLatencyMetrics({
    tasks,
    goalRuns,
    sinceMs: since24hMs
  });

  const completedTasks24h = tasks.filter((task) => {
    if (task.status !== "completed") {
      return false;
    }
    const completedMs = parseIsoMs(task.completedAt);
    return completedMs !== undefined && completedMs >= since24hMs;
  }).length;
  const failedTasks24h = tasks.filter((task) => {
    if (task.status !== "failed" && task.status !== "cancelled") {
      return false;
    }
    const completedMs = parseIsoMs(task.completedAt);
    return completedMs !== undefined && completedMs >= since24hMs;
  }).length;
  const terminalTasks24h = completedTasks24h + failedTasks24h;

  const completedGoalRuns24h = goalRuns.filter((run) => {
    if (run.status !== "completed") {
      return false;
    }
    const completedMs = parseIsoMs(run.completedAt);
    return completedMs !== undefined && completedMs >= since24hMs;
  }).length;
  const failedGoalRuns24h = goalRuns.filter((run) => {
    if (run.status !== "failed" && run.status !== "cancelled") {
      return false;
    }
    const completedMs = parseIsoMs(run.completedAt);
    return completedMs !== undefined && completedMs >= since24hMs;
  }).length;
  const terminalGoalRuns24h = completedGoalRuns24h + failedGoalRuns24h;

  const approvalDecisions24h = approvals.filter((approval) => {
    if (approval.status !== "approved" && approval.status !== "rejected") {
      return false;
    }
    const decidedMs = parseIsoMs(approval.decidedAt);
    return decidedMs !== undefined && decidedMs >= since24hMs;
  });
  const rejectedApprovals24h = approvalDecisions24h.filter((item) => item.status === "rejected").length;

  const snapshot = {
    timestamp: new Date().toISOString(),
    scope: "24h",
    statusCounts,
    queueDepth: {
      queuedTasks: getStatusCount(statusCounts.tasks, "queued"),
      runningTasks: getStatusCount(statusCounts.tasks, "running"),
      waitingApprovalTasks: getStatusCount(statusCounts.tasks, "waiting_approval"),
      queuedGoalRuns: getStatusCount(statusCounts.goalRuns, "queued"),
      runningGoalRuns: getStatusCount(statusCounts.goalRuns, "running")
    },
    throughput: {
      completedTasks24h,
      failedTasks24h,
      completedGoalRuns24h,
      failedGoalRuns24h,
      approvalDecisions24h: approvalDecisions24h.length
    },
    quality: {
      taskFailureRate24h:
        terminalTasks24h === 0 ? 0 : Number((failedTasks24h / terminalTasks24h).toFixed(4)),
      goalRunFailureRate24h:
        terminalGoalRuns24h === 0 ? 0 : Number((failedGoalRuns24h / terminalGoalRuns24h).toFixed(4)),
      approvalRejectRate24h:
        approvalDecisions24h.length === 0
          ? 0
          : Number((rejectedApprovals24h / approvalDecisions24h.length).toFixed(4))
    },
    latency
  };
  metricsSnapshotCache = { data: snapshot, expiresAt: Date.now() + 30_000 };
  return snapshot;
}

function buildSystemDailyKpi(days: number): Record<string, unknown> {
  const metrics = store.getDailyOutcomeMetrics({ days });
  const compose = (entry: { date: string; completed: number; failed: number }) => {
    const total = entry.completed + entry.failed;
    return {
      ...entry,
      successRate: total === 0 ? 0 : Number((entry.completed / total).toFixed(4))
    };
  };
  const tasks = metrics.tasks.map(compose);
  const goalRuns = metrics.goalRuns.map(compose);
  const latestTask = tasks[tasks.length - 1];
  const latestGoalRun = goalRuns[goalRuns.length - 1];
  return {
    timestamp: new Date().toISOString(),
    windowDays: metrics.windowDays,
    since: metrics.since,
    kpi: {
      tasks,
      goalRuns
    },
    summary: {
      latestTaskSuccessRate: latestTask?.successRate ?? 0,
      latestGoalRunSuccessRate: latestGoalRun?.successRate ?? 0,
      targetTaskCompletionRate: 0.7
    }
  };
}

function buildSystemHealthReport(): Record<string, unknown> {
  const nowMs = Date.now();
  const runtimeConfig = store.getRuntimeConfig();
  const statusCounts = store.getStatusCounts();
  const queueMetrics = store.getQueueMetrics();
  const channels = getChannelStatus();
  const providers = listToolProviderStatuses(env, runtimeConfig.tools, store.getRuntimeSecrets());
  const taskStaleThresholdMinutes = parseRuntimeInteger(
    "SYSTEM_HEALTH_TASK_STALE_MINUTES",
    parseRuntimeInteger("RUNNER_STALE_RUNNING_RECOVERY_MINUTES", 5, { min: 1, max: 120 }),
    { min: 1, max: 240 }
  );
  const goalRunStaleThresholdMinutes = parseRuntimeInteger(
    "SYSTEM_HEALTH_GOALRUN_STALE_MINUTES",
    parseRuntimeInteger("RUNNER_STALE_GOALRUN_RECOVERY_MINUTES", 10, { min: 2, max: 240 }),
    { min: 2, max: 480 }
  );
  const pendingApprovalStaleThresholdMinutes = parseRuntimeInteger("SYSTEM_HEALTH_APPROVAL_STALE_MINUTES", 30, {
    min: 5,
    max: 1440
  });
  const staleTaskCriticalCount = parseRuntimeInteger("SYSTEM_HEALTH_STALE_TASK_CRITICAL_COUNT", 3, {
    min: 1,
    max: 100
  });
  const staleGoalRunCriticalCount = parseRuntimeInteger("SYSTEM_HEALTH_STALE_GOALRUN_CRITICAL_COUNT", 2, {
    min: 1,
    max: 50
  });
  const taskStaleThresholdMs = taskStaleThresholdMinutes * 60_000;
  const goalRunStaleThresholdMs = goalRunStaleThresholdMinutes * 60_000;
  const pendingApprovalStaleThresholdMs = pendingApprovalStaleThresholdMinutes * 60_000;

  const runningTasks = store.listTasks(2000).filter((task) => task.status === "running");
  const staleRunningTasks = runningTasks.filter((task) => {
    const updatedMs = parseIsoMs(task.updatedAt);
    return updatedMs !== undefined && nowMs - updatedMs >= taskStaleThresholdMs;
  });
  const runningGoalRuns = store.listGoalRuns({ status: "running", limit: 500 });
  const staleRunningGoalRuns = runningGoalRuns.filter((run) => {
    const updatedMs = parseIsoMs(run.updatedAt);
    return updatedMs !== undefined && nowMs - updatedMs >= goalRunStaleThresholdMs;
  });
  const stalePendingApprovals = store.listApprovals(400).filter((approval) => {
    if (approval.status !== "pending") {
      return false;
    }
    const updatedMs = parseIsoMs(approval.updatedAt);
    return updatedMs !== undefined && nowMs - updatedMs >= pendingApprovalStaleThresholdMs;
  });
  const pausedInputTasks = store.listTasks(2000).filter((task) => task.status === "paused_input");
  const stalePausedInputTasks = pausedInputTasks.filter((task) => {
    const updatedMs = parseIsoMs(task.updatedAt);
    return updatedMs !== undefined && nowMs - updatedMs >= taskStaleThresholdMs;
  });
  const queueBacklogWithoutRunningWorkers =
    queueMetrics.queuedCount > 0 &&
    getStatusCount(statusCounts.tasks, "running") === 0 &&
    getStatusCount(statusCounts.goalRuns, "running") === 0;

  const alerts: Array<{
    level: "critical" | "warning";
    code: string;
    message: string;
    count?: number;
    sampleIds?: string[];
  }> = [];

  if (staleRunningTasks.length > 0) {
    alerts.push({
      level: staleRunningTasks.length >= staleTaskCriticalCount ? "critical" : "warning",
      code: "stale_running_tasks",
      message: `存在长时间运行未更新的任务（阈值 ${taskStaleThresholdMinutes} 分钟）`,
      count: staleRunningTasks.length,
      sampleIds: staleRunningTasks.slice(0, 5).map((task) => task.id)
    });
  }
  if (staleRunningGoalRuns.length > 0) {
    alerts.push({
      level: staleRunningGoalRuns.length >= staleGoalRunCriticalCount ? "critical" : "warning",
      code: "stale_running_goal_runs",
      message: `存在长时间无进展的 GoalRun（阈值 ${goalRunStaleThresholdMinutes} 分钟）`,
      count: staleRunningGoalRuns.length,
      sampleIds: staleRunningGoalRuns.slice(0, 5).map((run) => run.id)
    });
  }
  if (stalePendingApprovals.length > 0) {
    alerts.push({
      level: "warning",
      code: "stale_pending_approvals",
      message: `存在等待时间过长的审批单（>${pendingApprovalStaleThresholdMinutes} 分钟）`,
      count: stalePendingApprovals.length,
      sampleIds: stalePendingApprovals.slice(0, 5).map((item) => item.id)
    });
  }
  if (stalePausedInputTasks.length > 0) {
    alerts.push({
      level: "warning",
      code: "stale_paused_input_tasks",
      message: `存在长时间停留在等待补充输入的任务（阈值 ${taskStaleThresholdMinutes} 分钟）`,
      count: stalePausedInputTasks.length,
      sampleIds: stalePausedInputTasks.slice(0, 5).map((task) => task.id)
    });
  }
  if (queueBacklogWithoutRunningWorkers) {
    alerts.push({
      level: queueMetrics.oldestQueuedWaitMs >= runtimeConfig.queue.sla.criticalWaitMs ? "critical" : "warning",
      code: "queued_without_runner_progress",
      message: "存在排队任务，但当前没有 running task/goal run，疑似 task-runner 不消费队列",
      count: queueMetrics.queuedCount
    });
  }
  if (!channels.feishu.configured && runtimeConfig.channels.feishuEnabled) {
    alerts.push({
      level: "warning",
      code: "feishu_not_configured",
      message: "飞书通道已启用但关键配置不完整",
      count: channels.feishu.missing.length,
      sampleIds: channels.feishu.missing
    });
  }
  if (!channels.email.configured && runtimeConfig.channels.emailEnabled) {
    alerts.push({
      level: "warning",
      code: "email_not_configured",
      message: "邮件通道已启用但关键配置不完整",
      count: channels.email.missing.length,
      sampleIds: channels.email.missing
    });
  }
  if (providers.filter((provider) => provider.available).length === 0) {
    alerts.push({
      level: "critical",
      code: "no_available_tool_provider",
      message: "没有可用的工具执行 Provider，代码类任务将无法完成"
    });
  }

  const criticalCount = alerts.filter((item) => item.level === "critical").length;
  const warningCount = alerts.filter((item) => item.level === "warning").length;
  const recommendedResetMode = (() => {
    if (providers.filter((provider) => provider.available).length === 0) {
      return "investigate_providers";
    }
    if (criticalCount > 0 && queueBacklogWithoutRunningWorkers && staleRunningTasks.length > 0) {
      return "factory-reset";
    }
    if (staleRunningTasks.length > 0 || staleRunningGoalRuns.length > 0 || stalePendingApprovals.length > 0 || stalePausedInputTasks.length > 0) {
      return "drain";
    }
    if (queueBacklogWithoutRunningWorkers) {
      return "drain";
    }
    return "none";
  })();
  const recoveryActions =
    recommendedResetMode === "factory-reset"
      ? [
          "执行 `npm run reset:runtime:factory-reset`，终止检查/服务进程并重建 runtime 数据库",
          "重启 orchestrator 与 task-runner，再重新执行 harness 自检"
        ]
      : recommendedResetMode === "drain"
        ? [
            "执行 `npm run reset:runtime:drain -- --kill-check-processes`，清理卡住的 tasks / goal runs / approvals / paused_input",
            "确认 task-runner 重新启动后队列持续下降"
          ]
        : recommendedResetMode === "investigate_providers"
          ? [
              "先修复工具执行 Provider 或模型后端可用性，再决定是否需要 reset runtime"
            ]
          : [];

  return {
    ok: criticalCount === 0,
    timestamp: new Date().toISOString(),
    summary: {
      critical: criticalCount,
      warning: warningCount
    },
    statusCounts,
    queue: {
      queueMetrics,
      queuedTasks: getStatusCount(statusCounts.tasks, "queued"),
      runningTasks: getStatusCount(statusCounts.tasks, "running"),
      waitingApprovalTasks: getStatusCount(statusCounts.tasks, "waiting_approval"),
      pausedInputTasks: pausedInputTasks.length,
      queuedGoalRuns: getStatusCount(statusCounts.goalRuns, "queued"),
      runningGoalRuns: getStatusCount(statusCounts.goalRuns, "running"),
      queueBacklogWithoutRunningWorkers
    },
    thresholds: {
      taskStaleMinutes: taskStaleThresholdMinutes,
      goalRunStaleMinutes: goalRunStaleThresholdMinutes,
      approvalStaleMinutes: pendingApprovalStaleThresholdMinutes,
      staleTaskCriticalCount,
      staleGoalRunCriticalCount
    },
    channels,
    toolProviders: providers,
    recovery: {
      recommendedResetMode,
      actions: recoveryActions
    },
    alerts
  };
}

function hasConfiguredSecret(secretEnvName: string): boolean {
  return getRuntimeValue(secretEnvName).trim().length > 0;
}

function isSensitiveFieldName(key: string): boolean {
  return /(api[-_]?key|secret|token|password)/i.test(key);
}

function isSensitiveRuntimeSettingKey(key: string): boolean {
  return /(KEY|SECRET|TOKEN|PASSWORD)$/i.test(key) || key.toUpperCase() === "SMTP_URL";
}

function redactSecretValue(value: string): string {
  if (!value) {
    return value;
  }
  if (value.length <= 8) {
    return "***";
  }
  return `${value.slice(0, 3)}***${value.slice(-2)}`;
}

function redactSmtpUrlCredentials(url: string): string {
  const normalized = url.trim();
  const match = normalized.match(/^(smtps?:\/\/[^:\s\/]+:)([^@\s\/]+)(@.+)$/i);
  if (!match) {
    return normalized;
  }
  return `${match[1]}***${match[3]}`;
}

function redactApprovalOrActionPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = { ...payload };
  const keyField = typeof redacted.key === "string" ? redacted.key.toUpperCase() : "";
  if (
    keyField &&
    typeof redacted.value === "string" &&
    (isSensitiveRuntimeSettingKey(keyField) || keyField === "SMTP_URL")
  ) {
    redacted.value =
      keyField === "SMTP_URL"
        ? redactSmtpUrlCredentials(String(redacted.value))
        : redactSecretValue(String(redacted.value));
  }

  if (typeof redacted.apiKey === "string" && redacted.apiKey.trim()) {
    redacted.apiKey = redactSecretValue(redacted.apiKey);
  }

  for (const [entryKey, entryValue] of Object.entries(redacted)) {
    if (typeof entryValue !== "string") {
      continue;
    }
    if (entryKey === "SMTP_URL") {
      redacted[entryKey] = redactSmtpUrlCredentials(entryValue);
      continue;
    }
    if (isSensitiveFieldName(entryKey)) {
      redacted[entryKey] = redactSecretValue(entryValue);
    }
  }

  return redacted;
}

function sanitizeApprovalRecord<T extends { payload: Record<string, unknown> }>(approval: T): T {
  return {
    ...approval,
    payload: redactApprovalOrActionPayload(approval.payload)
  };
}

function sanitizeOperatorActionRecord<T extends { payload: Record<string, unknown> }>(action: T): T {
  return {
    ...action,
    payload: redactApprovalOrActionPayload(action.payload)
  };
}

async function safeEmitApprovalLifecycleEvent(
  input: Parameters<typeof emitApprovalLifecycle>[0]
): Promise<void> {
  try {
    await emitApprovalLifecycle(input);
  } catch (error) {
    logger.error("failed to emit approval lifecycle event", error, {
      approvalId: input.approvalId,
      phase: input.phase
    });
  }
}

function resolveWorkflowLevelsForApproval(approval: {
  kind: string;
  payload: Record<string, unknown>;
}): RoleId[] {
  if (approval.kind === "task_execution") {
    const riskLevel = typeof approval.payload.riskLevel === "string" ? approval.payload.riskLevel : "";
    if (riskLevel === "high") {
      return ["cto"];  // User (CEO) handles final approval via the UI/Feishu
    }
    return ["cto"];
  }
  return ["cto"];
}

function ensureApprovalWorkflowForRecord(approvalId: string) {
  const approval = store.getApproval(approvalId);
  if (!approval) {
    return undefined;
  }
  return store.ensureApprovalWorkflow(approvalId, resolveWorkflowLevelsForApproval(approval));
}

async function applyApprovalDecisionEffects(approval: ReturnType<typeof store.getApproval>): Promise<unknown> {
  if (!approval) {
    return undefined;
  }
  if (approval.kind === "task_execution" && approval.taskId) {
    if (approval.status === "approved") {
      const toolRun = store.approveToolRunByApproval(approval.id, approval.decidedBy ?? "system");
      const task = store.requeueTask(approval.taskId);
      return {
        kind: "task_execution",
        status: "approved",
        toolRun,
        task
      };
    }

    if (approval.status === "rejected") {
      const toolRun = store.rejectToolRunByApproval(
        approval.id,
        approval.decidedBy ?? "system",
        approval.decisionNote ?? "Task execution approval rejected"
      );
      const task = store.failTask(
        approval.taskId,
        approval.decisionNote ?? "Task execution approval rejected"
      );
      return {
        kind: "task_execution",
        status: "rejected",
        toolRun,
        task
      };
    }
    return undefined;
  }

  if (!approval.operatorActionId) {
    return undefined;
  }

  if (approval.status === "approved") {
    const action = store.getOperatorAction(approval.operatorActionId);
    if (action?.kind === "send_email") {
      await sendApprovedEmail(action.payload);
      return store.markOperatorActionStatus(action.id, "applied", new Date().toISOString());
    }
    return store.applyOperatorAction(approval.operatorActionId, approval.decidedBy ?? "system");
  }

  if (approval.status === "rejected") {
    return store.markOperatorActionStatus(approval.operatorActionId, "rejected");
  }

  return undefined;
}

function shorten(value: string, length = 48): string {
  return value.length <= length ? value : `${value.slice(0, length - 1)}...`;
}

function updateSessionProjectMemoryFromInbound(input: {
  sessionId?: string | undefined;
  requesterName?: string | undefined;
  requestedBy?: string | undefined;
  source: CreateTaskInput["source"];
  inboundText: string;
  taskText: string;
  stage: string;
  unresolvedQuestions?: string[] | undefined;
  nextActions?: string[] | undefined;
}): void {
  if (!input.sessionId) {
    return;
  }
  const normalizedTaskText = input.taskText.replace(/\s+/g, " ").trim();
  const shouldPromoteGoal =
    normalizedTaskText.length >= 8 ||
    /(?:帮我|请|做|写|实现|开发|构建|创建|生成|调研|分析|规划|build|create|implement|develop|research|plan)/i.test(
      normalizedTaskText
    );
  store.updateSessionProjectMemory(
    input.sessionId,
    {
      ...(shouldPromoteGoal ? { currentGoal: shorten(normalizedTaskText, 160) } : {}),
      currentStage: input.stage,
      latestUserRequest: input.inboundText.trim(),
      ...(input.unresolvedQuestions !== undefined ? { unresolvedQuestions: input.unresolvedQuestions } : {}),
      ...(input.nextActions !== undefined ? { nextActions: input.nextActions } : {}),
      updatedBy: input.requesterName?.trim() || input.requestedBy?.trim() || input.source
    },
    {
      lastInboundSource: input.source,
      lastRequesterName: input.requesterName?.trim() ?? "",
      lastRequestedBy: input.requestedBy?.trim() ?? ""
    }
  );
}

function parseSkillSelectionReply(
  text: string
): { selection: number; roleId?: RoleId | undefined } | undefined {
  const normalized = text.trim();
  const match = normalized.match(/^([1-9]\d?)(?:\s+([a-zA-Z_-]+))?$/);
  if (!match) {
    return undefined;
  }
  const selection = Number(match[1]);
  if (!Number.isFinite(selection) || selection <= 0) {
    return undefined;
  }
  const roleId = match[2] ? resolveRoleId(match[2]) : undefined;
  return { selection, roleId };
}

function normalizeKeywords(values: string[]): string[] {
  return values
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

function renderTemplate(value: string, inputText: string): string {
  const trimmedInput = inputText.trim();
  const shortInput = shorten(trimmedInput.replace(/\s+/g, " "), 56);
  return value
    .replaceAll("{{input}}", trimmedInput)
    .replaceAll("{{input_short}}", shortInput);
}

function normalizeRoutingTemplateBody(
  body: Partial<CreateRoutingTemplateInput> | Partial<UpdateRoutingTemplateInput>
): Partial<CreateRoutingTemplateInput> | Partial<UpdateRoutingTemplateInput> {
  const normalized = { ...body };
  if (Array.isArray(body.triggerKeywords)) {
    normalized.triggerKeywords = normalizeKeywords(body.triggerKeywords);
  }
  return normalized;
}

function selectRoutingTemplate(text: string, templates: RoutingTemplate[]): RoutingTemplate | undefined {
  const normalizedText = text.toLowerCase();
  return templates
    .filter((template) => template.enabled)
    .find((template) => {
      const keywords = normalizeKeywords(template.triggerKeywords);
      if (keywords.length === 0) {
        return false;
      }

      return template.matchMode === "all"
        ? keywords.every((keyword) => normalizedText.includes(keyword))
        : keywords.some((keyword) => normalizedText.includes(keyword));
    });
}

function normalizeAttachments(value: unknown): TaskAttachment[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => {
      if (typeof entry !== "object" || entry === null) {
        return undefined;
      }

      const kind = "kind" in entry ? entry.kind : undefined;
      const url = "url" in entry ? entry.url : undefined;
      const detail = "detail" in entry ? entry.detail : undefined;
      const name = "name" in entry ? entry.name : undefined;

      if ((kind !== "image" && kind !== "video") || typeof url !== "string" || !url.trim()) {
        return undefined;
      }

      const normalized: TaskAttachment = {
        kind,
        url: url.trim()
      };

      if ((detail === "auto" || detail === "low" || detail === "high") && kind === "image") {
        normalized.detail = detail;
      }

      if (typeof name === "string" && name.trim()) {
        normalized.name = name.trim();
      }

      return normalized;
    })
    .filter((entry): entry is TaskAttachment => Boolean(entry));
}

function resolveTemplateByQuery(query: string): RoutingTemplate | undefined {
  const templates = store.listRoutingTemplates();
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return undefined;
  }

  const exactId = templates.find((template) => template.id.toLowerCase() === normalizedQuery);
  if (exactId) {
    return exactId;
  }

  const exactName = templates.find((template) => template.name.trim().toLowerCase() === normalizedQuery);
  if (exactName) {
    return exactName;
  }

  return templates.find(
    (template) =>
      template.id.toLowerCase().includes(normalizedQuery) ||
      template.name.trim().toLowerCase().includes(normalizedQuery)
  );
}

async function sendApprovedEmail(payload: Record<string, unknown>): Promise<void> {
  const smtpUrl = getRuntimeValue("SMTP_URL");
  const emailDefaultFrom = getRuntimeValue("EMAIL_DEFAULT_FROM");
  if (!smtpUrl || !emailDefaultFrom) {
    throw new Error("SMTP is not configured");
  }

  const transporter = nodemailer.createTransport(smtpUrl);
  const to = String(payload.to ?? "");
  const subject = String(payload.subject ?? "VinkoClaw outbound message");
  const body = String(payload.body ?? payload.prompt ?? "");
  await transporter.sendMail({
    from: emailDefaultFrom,
    to,
    subject,
    text: body
  });
}

function createTask(input: {
  sessionId?: string | undefined;
  instruction: string;
  source: CreateTaskInput["source"];
  requestedBy?: string | undefined;
  chatId?: string | undefined;
  roleId?: RoleId | undefined;
  title?: string | undefined;
  priority?: number | undefined;
  metadata?: TaskMetadata | undefined;
}): ReturnType<typeof store.createTask> {
  return store.createTask({
    sessionId: input.sessionId,
    source: input.source,
    roleId: input.roleId ?? selectRoleFromText(input.instruction),
    title: input.title ?? shorten(input.instruction.replace(/\s+/g, " ").trim() || "Untitled task"),
    instruction: input.instruction,
    priority: input.priority,
    requestedBy: input.requestedBy,
    chatId: input.chatId,
    metadata: input.metadata ?? {}
  });
}

function createSkillRuntimeIntegrationTask(input: {
  sessionId?: string | undefined;
  source: CreateTaskInput["source"];
  requestedBy?: string | undefined;
  chatId?: string | undefined;
  targetRoleId?: RoleId | undefined;
  skill: {
    skillId: string;
    name: string;
    summary: string;
    description?: string | undefined;
    source?: string | undefined;
    sourceLabel?: string | undefined;
    sourceUrl?: string | undefined;
    version?: string | undefined;
    allowedRoles?: RoleId[] | undefined;
  };
}): ReturnType<typeof store.createTask> {
  const targetRole = input.targetRoleId ? formatRoleLabel(input.targetRoleId) : "目标角色";
  const sourceLabel = input.skill.sourceLabel || input.skill.source || "remote registry";
  const versionLabel = input.skill.version ? `版本：${input.skill.version}` : "版本：未声明";
  const allowedRolesLabel =
    Array.isArray(input.skill.allowedRoles) && input.skill.allowedRoles.length > 0
      ? input.skill.allowedRoles.join(", ")
      : "未声明";
  const sourceUrlLine = input.skill.sourceUrl ? `来源地址：${input.skill.sourceUrl}` : "来源地址：未提供";
  const originalInfo = [
    `skillId：${input.skill.skillId}`,
    `技能名称：${input.skill.name}`,
    versionLabel,
    `来源：${sourceLabel}`,
    sourceUrlLine,
    `适用角色：${allowedRolesLabel}`,
    `目标安装角色：${targetRole}`,
    `摘要：${input.skill.summary}`,
    input.skill.description ? `详细说明：${input.skill.description}` : ""
  ]
    .filter(Boolean)
    .join("\n");
  const template = store.getRoutingTemplate("tpl-skill-runtime-integration");
  const templateTask = template?.tasks.find((entry) => entry.roleId === "engineering");
  const title = templateTask
    ? renderTemplate(templateTask.titleTemplate, `${input.skill.name} ${input.skill.skillId}`)
    : `接入 Skill Runtime: ${input.skill.name}`;
  const instruction = templateTask
    ? renderTemplate(templateTask.instructionTemplate, originalInfo)
    : [
        `请将 marketplace 中发现的 skill 接入本地运行时，并确保后续可以直接安装到 ${targetRole}。`,
        "",
        originalInfo
      ].join("\n");
  return createTask({
    sessionId: input.sessionId,
    source: input.source,
    requestedBy: input.requestedBy,
    chatId: input.chatId,
    roleId: "engineering",
    priority: templateTask?.priority ?? 91,
    title,
    instruction,
    metadata: {
      ...(template ? { routeTemplateId: template.id, routeTemplateName: template.name } : {}),
      ...(templateTask?.deliverableMode ? { deliverableMode: templateTask.deliverableMode } : { deliverableMode: "artifact_required" }),
      ...(Array.isArray(templateTask?.deliverableSections) && templateTask.deliverableSections.length > 0
        ? { deliverableSections: templateTask.deliverableSections }
        : { deliverableSections: ["接入方案", "技能定义", "代码改动", "安装验证", "剩余限制"] }),
      requestedSkillId: input.skill.skillId,
      requestedSkillName: input.skill.name,
      requestedSkillSource: input.skill.source ?? "remote",
      requestedSkillSourceLabel: sourceLabel,
      requestedSkillSourceUrl: input.skill.sourceUrl ?? "",
      requestedSkillVersion: input.skill.version ?? "",
      requestedSkillTargetRoleId: input.targetRoleId ?? ""
    }
  });
}

function createSkillSmokeVerifyTask(input: {
  sessionId?: string | undefined;
  source: CreateTaskInput["source"];
  requestedBy?: string | undefined;
  chatId?: string | undefined;
  targetRoleId: RoleId;
  skill: {
    skillId: string;
    name: string;
    source?: string | undefined;
    sourceLabel?: string | undefined;
    sourceUrl?: string | undefined;
    version?: string | undefined;
  };
}): ReturnType<typeof store.createTask> {
  const sourceLabel = input.skill.sourceLabel || input.skill.source || "marketplace";
  const originalInfo = [
    `skillId：${input.skill.skillId}`,
    `技能名称：${input.skill.name}`,
    input.skill.version ? `版本：${input.skill.version}` : "",
    `来源：${sourceLabel}`,
    input.skill.sourceUrl ? `来源地址：${input.skill.sourceUrl}` : "",
    `目标角色：${formatRoleLabel(input.targetRoleId)}`
  ]
    .filter(Boolean)
    .join("\n");
  const template = store.getRoutingTemplate("tpl-skill-smoke-verify");
  const templateTask = template?.tasks[0];
  const title = templateTask
    ? renderTemplate(templateTask.titleTemplate, `${input.skill.name} ${input.skill.skillId}`)
    : `验证 Skill: ${input.skill.name}`;
  const instruction = templateTask
    ? renderTemplate(templateTask.instructionTemplate, originalInfo)
    : `请使用已安装的 skill 做一个最小验证，并说明 skill 如何影响输出。\n\n${originalInfo}`;
  return createTask({
    sessionId: input.sessionId,
    source: input.source,
    requestedBy: input.requestedBy,
    chatId: input.chatId,
    roleId: input.targetRoleId,
    priority: templateTask?.priority ?? 84,
    title,
    instruction,
    metadata: {
      ...(template ? { routeTemplateId: template.id, routeTemplateName: template.name } : {}),
      ...(templateTask?.deliverableMode ? { deliverableMode: templateTask.deliverableMode } : { deliverableMode: "artifact_preferred" }),
      ...(Array.isArray(templateTask?.deliverableSections) && templateTask.deliverableSections.length > 0
        ? { deliverableSections: templateTask.deliverableSections }
        : { deliverableSections: ["验证任务", "执行结果", "Skill 使用证据", "结论"] }),
      verifyInstalledSkillId: input.skill.skillId,
      verifyInstalledSkillName: input.skill.name,
      verifyInstalledSkillSourceLabel: sourceLabel,
      verifyInstalledSkillSourceUrl: input.skill.sourceUrl ?? "",
      verifyInstalledSkillVersion: input.skill.version ?? ""
    }
  });
}

function createTemplateTasks(input: {
  sessionId?: string | undefined;
  template: RoutingTemplate;
  text: string;
  source: CreateTaskInput["source"];
  requestedBy?: string | undefined;
  requesterName?: string | undefined;
  chatId?: string | undefined;
  attachments?: TaskAttachment[] | undefined;
}): ReturnType<typeof store.createTask>[] {
  const total = input.template.tasks.length;
  const attachmentsMetadata = input.attachments && input.attachments.length > 0 ? { attachments: input.attachments } : {};

  return input.template.tasks.map((taskTemplate, index) =>
    createTask({
      title: renderTemplate(taskTemplate.titleTemplate, input.text),
      instruction: renderTemplate(taskTemplate.instructionTemplate, input.text),
      sessionId: input.sessionId,
      source: input.source,
      priority: taskTemplate.priority,
      requestedBy: input.requestedBy,
      chatId: input.chatId,
      roleId: taskTemplate.roleId,
      metadata: {
        ...attachmentsMetadata,
        ...(input.requesterName ? { requesterName: input.requesterName } : {}),
        ...(taskTemplate.deliverableMode ? { deliverableMode: taskTemplate.deliverableMode } : {}),
        ...(Array.isArray(taskTemplate.deliverableSections) && taskTemplate.deliverableSections.length > 0
          ? { deliverableSections: taskTemplate.deliverableSections }
          : {}),
        routeTemplateId: input.template.id,
        routeTemplateName: input.template.name,
        routeTaskIndex: index + 1,
        routeTaskTotal: total,
        originalInstruction: input.text
      }
    })
  );
}

function createFounderDeliveryWorkflow(input: {
  sessionId?: string | undefined;
  template: RoutingTemplate;
  text: string;
  source: CreateTaskInput["source"];
  requestedBy?: string | undefined;
  requesterName?: string | undefined;
  chatId?: string | undefined;
  attachments?: TaskAttachment[] | undefined;
}): ReturnType<typeof store.createTask>[] {
  const prdTaskTemplate = input.template.tasks[0];
  if (!prdTaskTemplate) {
    return [];
  }
  const workflowId = randomUUID();
  const attachmentsMetadata = input.attachments && input.attachments.length > 0 ? { attachments: input.attachments } : {};
  const task = createTask({
    title: renderTemplate(prdTaskTemplate.titleTemplate, input.text),
    instruction: renderTemplate(prdTaskTemplate.instructionTemplate, input.text),
    sessionId: input.sessionId,
    source: input.source,
    priority: prdTaskTemplate.priority,
    requestedBy: input.requestedBy,
    chatId: input.chatId,
    roleId: prdTaskTemplate.roleId,
    metadata: {
      ...attachmentsMetadata,
      ...(input.requesterName ? { requesterName: input.requesterName } : {}),
      ...(prdTaskTemplate.deliverableMode ? { deliverableMode: prdTaskTemplate.deliverableMode } : {}),
      ...(Array.isArray(prdTaskTemplate.deliverableSections) && prdTaskTemplate.deliverableSections.length > 0
        ? { deliverableSections: prdTaskTemplate.deliverableSections }
        : {}),
      routeTemplateId: input.template.id,
      routeTemplateName: input.template.name,
      routeTaskIndex: 1,
      routeTaskTotal: 4,
      originalInstruction: input.text,
      founderWorkflowKind: "founder_delivery",
      founderWorkflowId: workflowId,
      founderWorkflowStage: "prd",
      founderWorkflowStepIndex: 1,
      founderWorkflowStepTotal: 4,
      founderWorkflowOriginalInstruction: input.text,
      orchestrationMode: "main_agent",
      orchestrationState: createOrchestrationState({
        ownerRoleId: prdTaskTemplate.roleId,
        goal: input.text,
        stage: "spec",
        successCriteria: [
          "产出结构化需求与验收标准",
          "生成可见 artifact",
          "为实现与验证阶段提供明确输入"
        ],
        constraints: ["用户作为 CEO，不引入 AI CEO 默认接力", "所有后续阶段必须回流到主流程状态"],
        scope: ["spec", "implementation", "verification", "delivery_recap"],
        nextActions: ["完成 spec 并决定是否需要并行执行"],
        updatedBy: String(prdTaskTemplate.roleId)
      })
    }
  });
  return [task];
}

function buildAutoSplitSpecs(task: TaskRecord, maxTasks = 6): Array<{
  roleId: RoleId;
  title: string;
  instruction: string;
  priority: number;
}> {
  const specs: Array<{
    roleId: RoleId;
    title: string;
    instruction: string;
    priority: number;
  }> = [
    {
      roleId: "product",
      title: `拆解需求: ${shorten(task.title, 40)}`,
      instruction: `请将以下任务拆解为可执行需求与验收标准，并标记范围边界：\n${task.instruction}`,
      priority: 92
    },
    {
      roleId: "uiux",
      title: `交互方案: ${shorten(task.title, 40)}`,
      instruction: `请针对以下任务输出页面/交互方案，包含关键状态与异常状态：\n${task.instruction}`,
      priority: 88
    },
    {
      roleId: "frontend",
      title: `前端实现: ${shorten(task.title, 40)}`,
      instruction: `请基于任务实现前端方案，明确组件边界、状态管理与交互细节：\n${task.instruction}`,
      priority: 86
    },
    {
      roleId: "backend",
      title: `后端实现: ${shorten(task.title, 40)}`,
      instruction: `请基于任务实现后端方案，明确 API、数据结构、错误处理与观测点：\n${task.instruction}`,
      priority: 86
    },
    {
      roleId: "qa",
      title: `测试验收: ${shorten(task.title, 40)}`,
      instruction: `请为以下任务设计测试矩阵与验收用例，覆盖异常路径：\n${task.instruction}`,
      priority: 90
    },
    {
      roleId: "operations",
      title: `结果汇总: ${shorten(task.title, 40)}`,
      instruction:
        `请汇总各子任务输出，形成最终可执行结论与风险清单，原始任务：\n${task.instruction}`,
      priority: 84
    }
  ];
  return specs.slice(0, Math.max(1, Math.min(maxTasks, specs.length)));
}

function splitTaskIntoChildren(input: {
  parentTask: TaskRecord;
  requestedBy?: string | undefined;
  specs: Array<{
    roleId: RoleId;
    title: string;
    instruction: string;
    priority?: number | undefined;
  }>;
}): TaskRecord[] {
  const children: TaskRecord[] = [];
  for (const spec of input.specs) {
    const child = store.createTask({
      sessionId: input.parentTask.sessionId,
      source: input.parentTask.source,
      roleId: spec.roleId,
      title: spec.title,
      instruction: spec.instruction,
      priority: spec.priority ?? 80,
      chatId: input.parentTask.chatId,
      requestedBy: input.requestedBy ?? input.parentTask.requestedBy,
      metadata: {
        ...(input.parentTask.metadata ?? {}),
        parentTaskId: input.parentTask.id,
        splitFromTaskId: input.parentTask.id
      }
    });
    store.createTaskRelation({
      parentTaskId: input.parentTask.id,
      childTaskId: child.id,
      relationType: "split"
    });
    children.push(child);
  }
  return children;
}

const FEISHU_ROLE_LABELS: Record<RoleId, string> = {
  ceo: "首席执行官助理",
  cto: "首席技术官助理",
  product: "产品经理助理",
  uiux: "UI/UX 助理",
  frontend: "前端助理",
  backend: "后端助理",
  algorithm: "算法助理",
  qa: "测试助理",
  developer: "开发助理",
  engineering: "工程助理",
  research: "研究助理",
  operations: "运营助理"
};

function formatRoleLabel(roleIdRaw: string | undefined): string {
  const roleId = (roleIdRaw ?? "").trim() as RoleId;
  return FEISHU_ROLE_LABELS[roleId] ?? roleIdRaw ?? "指定角色";
}

function formatOperatorActionSummaryForUser(action: OperatorActionRecord): string {
  switch (action.kind) {
    case "set_runtime_setting": {
      const key = typeof action.payload.key === "string" ? action.payload.key.trim().toUpperCase() : "未知配置项";
      return `设置运行时配置 ${key}`;
    }
    case "set_tool_provider_config": {
      const providerId =
        typeof action.payload.providerId === "string" ? action.payload.providerId.trim().toLowerCase() : "opencode";
      return `更新工具提供商配置（${providerId}）`;
    }
    case "set_channel_enabled": {
      const channel = String(action.payload.channel ?? "channel");
      const enabled = Boolean(action.payload.enabled);
      return `${enabled ? "启用" : "禁用"} ${channel} 通道`;
    }
    case "set_memory_backend": {
      const roleLabel = formatRoleLabel(action.targetRoleId);
      const backend = String(action.payload.backend ?? "未知后端");
      return `设置 ${roleLabel} 的记忆后端为 ${backend}`;
    }
    case "install_skill": {
      return `为 ${formatRoleLabel(action.targetRoleId)} 安装技能 ${action.skillId ?? "未知技能"}`;
    }
    case "disable_skill": {
      return `为 ${formatRoleLabel(action.targetRoleId)} 停用技能 ${action.skillId ?? "未知技能"}`;
    }
    case "add_agent_instance": {
      return `新增 ${formatRoleLabel(action.targetRoleId)} 角色实例`;
    }
    case "remove_agent_instance": {
      return `移除 ${formatRoleLabel(action.targetRoleId)} 角色实例`;
    }
    case "set_agent_tone_policy": {
      return `更新 ${formatRoleLabel(action.targetRoleId)} 语气策略`;
    }
    case "send_email": {
      const to = String(action.payload.to ?? "未知收件人");
      return `发送邮件给 ${to}`;
    }
    default:
      return action.summary;
  }
}

function buildSearchConfigFollowupMessage(action: OperatorActionRecord): string | undefined {
  if (action.kind !== "set_runtime_setting") {
    return undefined;
  }
  const key = typeof action.payload.key === "string" ? action.payload.key.trim().toUpperCase() : "";
  if (key !== "SEARCH_PROVIDER" && key !== "TAVILY_API_KEY" && key !== "SERPAPI_API_KEY") {
    return undefined;
  }

  const providerId = resolveSearchProviderId(getRuntimeValue("SEARCH_PROVIDER"));
  if (!providerId) {
    return "搜索能力配置已更新，但还未识别到有效搜索提供商。请发送：设置搜索工具为 tavily（或 serpapi）";
  }
  const apiKeyEnv = resolveSearchProviderApiKeyEnv(providerId);
  if (!hasConfiguredSecret(apiKeyEnv)) {
    return `已设置搜索提供商为 ${providerId}，还缺少密钥 ${apiKeyEnv}。请发送：设置 ${apiKeyEnv} 为 <your-key>`;
  }
  return `搜索能力已配置完成，当前提供商：${providerId}。你现在可以直接让我“联网搜索 + 总结并附链接”。`;
}

function formatTaskQueuedMessage(source: CreateTaskInput["source"], taskId: string, roleId: RoleId): string {
  if (source !== "feishu") {
    return `任务已入队（${taskId.slice(0, 8)}），执行角色：${FEISHU_ROLE_LABELS[roleId]}。`;
  }
  return `收到，我先让${FEISHU_ROLE_LABELS[roleId]}开工，关键进展会同步你。`;
}

function formatSkillIntegrationTaskQueuedMessage(input: {
  source: CreateTaskInput["source"];
  taskId: string;
  skillName: string;
}): string {
  if (input.source === "feishu") {
    return `这个 skill 还没接入本地运行时。我已经为工程助理创建接入任务（${input.taskId.slice(0, 8)}），完成后你就可以直接安装它。`;
  }
  return `已创建 skill 接入任务（${input.taskId.slice(0, 8)}）：${input.skillName}。工程助理会继续把它接到本地 runtime。`;
}

function appendSessionSkillEvent(input: {
  sessionId?: string | undefined;
  content: string;
  metadata: Record<string, unknown>;
}): void {
  if (!input.sessionId) {
    return;
  }
  store.appendSessionMessage({
    sessionId: input.sessionId,
    actorType: "system",
    actorId: "orchestrator",
    messageType: "event",
    content: input.content,
    metadata: input.metadata
  });
}

function formatTemplateTasksQueuedMessage(
  source: CreateTaskInput["source"],
  templateName: string,
  taskCount: number
): string {
  if (source !== "feishu") {
    return `已按模板「${templateName}」创建 ${taskCount} 个并行任务，任务已入队。`;
  }
  return `已收到，已按模板「${templateName}」创建 ${taskCount} 个并行任务，完成后会继续回复你。`;
}

function formatFounderWorkflowQueuedMessage(source: CreateTaskInput["source"], templateName: string): string {
  if (source === "feishu") {
    return `收到，我会按「${templateName}」顺序推进：先产出 PRD，再接实现、验证和 recap，并持续同步进展。`;
  }
  return `已启动「${templateName}」：系统会按 PRD → 实现 → QA → Recap 顺序自动推进。`;
}

function formatGoalRunQueuedMessage(source: CreateTaskInput["source"], goalRunId: string): string {
  if (source === "feishu") {
    return `收到，我会按阶段主动推进（${goalRunId.slice(0, 8)}）：先澄清关键信息，再计划、执行、验证、部署，并持续同步进展。`;
  }
  return `已创建目标流程（${goalRunId.slice(0, 8)}），将按“澄清→计划→执行→验证→部署→验收”自动推进。`;
}

function formatOperatorActionPendingMessage(
  source: CreateTaskInput["source"],
  approvalId: string,
  summary: string
): string {
  if (source !== "feishu") {
    return `已创建审批单（${approvalId.slice(0, 8)}）：${summary}`;
  }
  return `👌 收到。这个操作需要先审批，我已发出审批卡（${approvalId.slice(0, 8)}）。你也可直接回复 1 同意或 0 拒绝。通过后我会马上继续并同步结果。`;
}

type ParsedApprovalDecisionCommand = {
  status: "approved" | "rejected";
  approvalToken?: string | undefined;
  decisionNote?: string | undefined;
};

function parseApprovalDecisionCommand(text: string): ParsedApprovalDecisionCommand | undefined {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (!normalized) {
    return undefined;
  }

  const quickMatch = normalized.match(
    /^([01０１])(?:\s+([a-f0-9-]{6,36}))?(?:\s*(?:原因|备注|note)\s*[:：]\s*(.+))?$/i
  );
  if (quickMatch?.[1]) {
    const rawDecision = quickMatch[1].trim();
    const status = rawDecision === "1" || rawDecision === "１" ? "approved" : "rejected";
    const approvalToken = (quickMatch[2] ?? "").trim().toLowerCase();
    const decisionNote = (quickMatch[3] ?? "").trim();
    return {
      status,
      ...(approvalToken ? { approvalToken } : {}),
      ...(decisionNote ? { decisionNote } : {})
    };
  }

  const token = "([a-f0-9-]{6,36})";
  const suffix = "(?:\\s*(?:原因|备注|note)\\s*[:：]\\s*(.+))?$";
  const patterns: Array<{ regex: RegExp; status: "approved" | "rejected" }> = [
    {
      regex: new RegExp(`^(?:批准|同意|通过|approve)\\s*(?:审批单|审批|approval)?\\s*${token}${suffix}`, "i"),
      status: "approved"
    },
    {
      regex: new RegExp(`^(?:审批单|审批|approval)\\s*${token}\\s*(?:批准|同意|通过|approve)${suffix}`, "i"),
      status: "approved"
    },
    {
      regex: new RegExp(`^(?:拒绝|驳回|否决|reject)\\s*(?:审批单|审批|approval)?\\s*${token}${suffix}`, "i"),
      status: "rejected"
    },
    {
      regex: new RegExp(`^(?:审批单|审批|approval)\\s*${token}\\s*(?:拒绝|驳回|否决|reject)${suffix}`, "i"),
      status: "rejected"
    }
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern.regex);
    if (!match) {
      continue;
    }
    const approvalToken = (match[1] ?? "").trim().toLowerCase();
    if (!approvalToken) {
      continue;
    }
    const decisionNote = (match[2] ?? "").trim();
    return {
      status: pattern.status,
      approvalToken,
      ...(decisionNote ? { decisionNote } : {})
    };
  }

  return undefined;
}

function resolvePendingApprovalByToken(approvalToken: string): {
  approval?: ReturnType<typeof store.getApproval> | undefined;
  message?: string | undefined;
} {
  const token = approvalToken.trim().toLowerCase();
  if (!token) {
    return {
      message: "审批单编号为空，请发送：批准审批单 <编号> 或 拒绝审批单 <编号>。"
    };
  }

  const approvals = store.listApprovals(500);
  const pending = approvals.filter((item) => item.status === "pending");
  const matchedPending = pending.filter((item) => item.id.toLowerCase().startsWith(token));
  if (matchedPending.length === 1) {
    return { approval: matchedPending[0] };
  }
  if (matchedPending.length > 1) {
    return {
      message: `命中多个待审批单，请补充更多编号位数：${matchedPending
        .slice(0, 5)
        .map((item) => item.id.slice(0, 8))
        .join("、")}`
    };
  }

  const historical = approvals.find((item) => item.id.toLowerCase().startsWith(token));
  if (historical) {
    return {
      message: `审批单 ${historical.id.slice(0, 8)} 当前状态是 ${historical.status}，不在待审批状态。`
    };
  }

  return {
    message: `未找到审批单 ${token}，请确认编号后重试。`
  };
}

function resolvePendingApprovalForRequester(requestedBy?: string | undefined): {
  approval?: ReturnType<typeof store.getApproval> | undefined;
  message?: string | undefined;
} {
  const pending = store.listApprovals(500).filter((item) => item.status === "pending");
  if (pending.length === 0) {
    return {
      message: "当前没有待审批单。"
    };
  }

  const requester = (requestedBy ?? "").trim();
  if (requester) {
    const mine = pending.filter((item) => (item.requestedBy ?? "").trim() === requester);
    if (mine.length === 1) {
      return { approval: mine[0] };
    }
    if (mine.length > 1) {
      return {
        message: `你当前有多个待审批单：${mine
          .slice(0, 5)
          .map((item) => item.id.slice(0, 8))
          .join("、")}。请回复 1 <编号> 或 0 <编号>。`
      };
    }
  }

  if (pending.length === 1) {
    return { approval: pending[0] };
  }
  return {
    message: `当前有多个待审批单：${pending
      .slice(0, 5)
      .map((item) => item.id.slice(0, 8))
      .join("、")}。请回复 1 <编号> 或 0 <编号>。`
  };
}

async function applyApprovalDecisionFromCommand(input: {
  approvalToken?: string | undefined;
  status: "approved" | "rejected";
  decidedBy?: string | undefined;
  decisionNote?: string | undefined;
  requestedBy?: string | undefined;
}): Promise<{ ok: true; approvalId: string; message: string } | { ok: false; message: string }> {
  const resolved = input.approvalToken
    ? resolvePendingApprovalByToken(input.approvalToken)
    : resolvePendingApprovalForRequester(input.requestedBy);
  if (!resolved.approval) {
    return {
      ok: false,
      message: resolved.message ?? "未找到待审批单。"
    };
  }

  const approval = resolved.approval;
  const ensured = ensureApprovalWorkflowForRecord(approval.id);
  if (!ensured) {
    return {
      ok: false,
      message: `审批单 ${approval.id.slice(0, 8)} 缺少审批流程数据，请在控制台处理。`
    };
  }
  const pendingStep = store.getPendingApprovalWorkflowStep(approval.id);
  if (!pendingStep) {
    return {
      ok: false,
      message: `审批单 ${approval.id.slice(0, 8)} 当前没有待处理步骤。`
    };
  }

  const decidedBy = (input.decidedBy ?? "owner").trim() || "owner";
  await safeEmitApprovalLifecycleEvent({
    phase: "before_approval_decision",
    approvalId: approval.id,
    kind: approval.kind,
    status: approval.status,
    requestedBy: approval.requestedBy,
    decidedBy
  });

  let decisionResult:
    | ReturnType<typeof store.decideApprovalWorkflowStep>
    | undefined;
  try {
    decisionResult = store.decideApprovalWorkflowStep({
      approvalId: approval.id,
      stepId: pendingStep.step.id,
      status: input.status,
      decidedBy,
      decisionNote: input.decisionNote
    });
  } catch (error) {
    return {
      ok: false,
      message: `审批处理失败：${error instanceof Error ? error.message : String(error)}`
    };
  }

  const decidedApproval = decisionResult.approval ?? store.getApproval(approval.id) ?? approval;
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
    return {
      ok: false,
      message: `审批已记录，但执行动作失败：${error instanceof Error ? error.message : String(error)}`
    };
  }

  await notifyApprovalStepViaFeishu(approval.id);
  const stillPending = store.getPendingApprovalWorkflowStep(approval.id);
  if (stillPending) {
    return {
      ok: true,
      approvalId: approval.id,
      message: `已${input.status === "approved" ? "批准" : "拒绝"}审批单 ${approval.id.slice(0, 8)} 当前步骤，下一审批步骤已推送。`
    };
  }

  return {
    ok: true,
    approvalId: approval.id,
    message: `已${input.status === "approved" ? "批准" : "拒绝"}审批单 ${approval.id.slice(0, 8)}。`
  };
}

function resolveAwaitingGoalRunForInbound(input: {
  source: CreateTaskInput["source"];
  requestedBy?: string | undefined;
  chatId?: string | undefined;
}): GoalRunRecord | undefined {
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

function resolveLatestGoalRunForInbound(input: {
  source: CreateTaskInput["source"];
  requestedBy?: string | undefined;
  chatId?: string | undefined;
}): GoalRunRecord | undefined {
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

function resolveLatestInFlightGoalRunForInbound(input: {
  source: CreateTaskInput["source"];
  requestedBy?: string | undefined;
  chatId?: string | undefined;
}): GoalRunRecord | undefined {
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

function isGoalRunStatusQuery(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  if (hasActionIntent(normalized)) {
    return false;
  }
  const patterns = [
    "进度",
    "状态",
    "做到哪",
    "完成了吗",
    "开发好了吗",
    "写好了吗",
    "现在怎么样",
    "情况如何"
  ];
  const hasKeyword = patterns.some((keyword) => normalized.includes(keyword));
  if (!hasKeyword) {
    return false;
  }
  const querySignals = ["吗", "？", "?", "如何", "怎么样", "做到哪", "完成没", "完成了没"];
  return querySignals.some((token) => normalized.includes(token));
}

function isTaskStatusQuery(text: string): boolean {
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

function formatGoalInputField(field: string): string {
  const configured = GOAL_INPUT_FIELD_LABELS[field];
  if (!configured) {
    return field;
  }
  return `${configured.label}(${field})`;
}

function formatGoalInputFields(fields: string[]): string {
  const normalized = fields.map((field) => field.trim()).filter(Boolean);
  if (normalized.length === 0) {
    return "关键信息";
  }
  return normalized.map((field) => formatGoalInputField(field)).join("、");
}

function buildGoalInputExpectedCommand(fields: string[]): string {
  const normalized = fields.map((field) => field.trim()).filter(Boolean);
  if (normalized.length === 0) {
    return "";
  }
  return normalized
    .map((field) => {
      const configured = GOAL_INPUT_FIELD_LABELS[field];
      if (!configured) {
        return `${field}: <value>`;
      }
      return `${configured.label}: <value>`;
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

function formatGoalRunStatusMessage(goalRun: GoalRunRecord): string {
  if (goalRun.status === "completed") {
    return `你上一个目标（${goalRun.id.slice(0, 8)}）已完成。若要继续下一步（优化/上线/复盘），直接告诉我目标即可。`;
  }
  if (goalRun.status === "awaiting_input") {
    const fields = formatGoalInputFields(goalRun.awaitingInputFields);
    return `当前在补充信息阶段（${goalRun.id.slice(0, 8)}），还需要：${fields}。你直接回复这些信息即可，我会继续推进。`;
  }
  if (goalRun.status === "awaiting_authorization") {
    return `当前在授权阶段（${goalRun.id.slice(0, 8)}），授权后我会继续执行部署。`;
  }
  const currentTask = goalRun.currentTaskId ? store.getTask(goalRun.currentTaskId) : undefined;
  const collaborationProgress = currentTask ? formatCollaborationProgress(currentTask) : undefined;
  const base = `当前目标（${goalRun.id.slice(0, 8)}）正在${formatGoalRunStageLabel(goalRun.currentStage)}，我会持续同步关键进展。`;
  return collaborationProgress ? `${base}\n${collaborationProgress}` : base;
}

function formatGoalRunStageLabel(stage: string): string {
  const normalized = stage.trim().toLowerCase();
  switch (normalized) {
    case "accept":
      return "受理阶段";
    case "discover":
      return "信息澄清阶段";
    case "plan":
      return "计划拆解阶段";
    case "execute":
      return "执行阶段";
    case "verify":
      return "验证阶段";
    case "deploy":
      return "部署阶段";
    default:
      return `${stage}阶段`;
  }
}

function resolveLatestActiveTaskForInbound(input: {
  source: CreateTaskInput["source"];
  requestedBy?: string | undefined;
  chatId?: string | undefined;
}): TaskRecord | undefined {
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

function formatActiveTaskStatusMessage(task: TaskRecord): string {
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

function normalizeConversationCandidate(text: string): string {
  let normalized = text.trim();
  if (!normalized) {
    return "";
  }
  const stripPatterns = [
    /^@[\w\u4e00-\u9fa5-]{1,32}\s*/i,
    /^[a-z][\w-]{0,31}\s*[:：]\s*/i
  ];
  for (const pattern of stripPatterns) {
    const next = normalized.replace(pattern, "").trim();
    if (next && next !== normalized) {
      normalized = next;
    }
  }
  return normalized;
}

const DIRECT_ACTION_INTENT_PATTERN =
  /(?:帮我|请|配置|设置|安装|新增|添加|删除|移除|创建|调研|分析|处理|执行|安排|切换|启用|禁用|部署|上线|run|install|set|configure|add|remove|delete|create|deploy|build)/i;

function hasActionIntent(text: string): boolean {
  return DIRECT_ACTION_INTENT_PATTERN.test(text);
}

function formatTaskProgressStatus(status: TaskRecord["status"]): string {
  switch (status) {
    case "queued":
    case "waiting_approval":
      return "待处理";
    case "running":
      return "进行中";
    case "completed":
      return "已完成";
    case "failed":
    case "cancelled":
      return "受阻";
    default:
      return status;
  }
}

function extractTaskProgressHighlight(task: TaskRecord): string | undefined {
  const sourceText =
    task.status === "completed"
      ? [task.result?.summary ?? "", task.result?.deliverable ?? ""].join(" ").trim()
      : task.status === "failed" || task.status === "cancelled"
        ? (task.errorText ?? "").trim()
        : "";
  if (!sourceText) {
    return undefined;
  }
  const normalized = sourceText
    .replace(/\s+/g, " ")
    .replace(/^CHANGED_FILES:\s*/i, "已变更文件：")
    .trim();
  if (!normalized) {
    return undefined;
  }
  return shorten(normalized, 36);
}

function summarizeRoleProgressSnapshots(children: TaskRecord[]): string {
  const latestByRole = new Map<string, TaskRecord>();
  for (const child of children) {
    const prev = latestByRole.get(child.roleId);
    if (!prev || prev.updatedAt.localeCompare(child.updatedAt) < 0) {
      latestByRole.set(child.roleId, child);
    }
  }
  const ordered = Array.from(latestByRole.values()).sort((left, right) => left.roleId.localeCompare(right.roleId));
  const maxRoles = 6;
  const segments = ordered.slice(0, maxRoles).map((task) => {
    const status = formatTaskProgressStatus(task.status);
    const highlight = extractTaskProgressHighlight(task);
    const base = `${formatRoleLabel(task.roleId)} ${status}`;
    return highlight ? `${base}：${highlight}` : base;
  });
  if (ordered.length > maxRoles) {
    segments.push(`其余 ${ordered.length - maxRoles} 个角色持续推进`);
  }
  return segments.join("；");
}

function formatCollaborationProgress(task: TaskRecord): string | undefined {
  const metadata = task.metadata as {
    collaborationMode?: boolean;
    collaborationId?: string;
    isAggregation?: boolean;
  };
  if (!metadata.collaborationMode && !metadata.collaborationId) {
    return undefined;
  }
  if (metadata.isAggregation) {
    return undefined;
  }
  const children = store.listTaskChildren(task.id).filter((child) => {
    const childMetadata = child.metadata as { collaborationId?: string; isAggregation?: boolean };
    if (childMetadata.isAggregation) {
      return false;
    }
    if (metadata.collaborationId && childMetadata.collaborationId) {
      return childMetadata.collaborationId === metadata.collaborationId;
    }
    return true;
  });
  if (children.length === 0) {
    return "团队协作已启动，正在分配子任务。";
  }
  const completed = children.filter((child) => child.status === "completed");
  const failed = children.filter((child) => child.status === "failed" || child.status === "cancelled");
  const running = children.filter((child) => child.status === "running");
  const queued = children.filter((child) => child.status === "queued" || child.status === "waiting_approval");
  const summarizeRoles = (items: TaskRecord[]) =>
    Array.from(new Set(items.map((entry) => formatRoleLabel(entry.roleId)))).slice(0, 4).join("、");
  const parts: string[] = [];
  parts.push(`协作进展：已完成 ${completed.length}/${children.length}${completed.length > 0 ? `（${summarizeRoles(completed)}）` : ""}`);
  if (running.length > 0) {
    parts.push(`进行中 ${running.length}（${summarizeRoles(running)}）`);
  }
  if (queued.length > 0) {
    parts.push(`待处理 ${queued.length}（${summarizeRoles(queued)}）`);
  }
  if (failed.length > 0) {
    parts.push(`受阻 ${failed.length}（${summarizeRoles(failed)}）`);
  }
  parts.push(`成员动态：${summarizeRoleProgressSnapshots(children)}`);
  return parts.join("；");
}

function isDirectConversationTurn(text: string): boolean {
  const normalized = normalizeConversationCandidate(text);
  if (!normalized) {
    return false;
  }
  if (shouldRouteToGoalRun(normalized)) {
    return false;
  }
  if (hasActionIntent(normalized)) {
    return false;
  }
  const compact = normalized.toLowerCase().replace(/\s+/g, "");
  const conversationPatterns = [
    "你是谁",
    "你能做什么",
    "你可以做什么",
    "会做什么",
    "介绍一下你们团队",
    "介绍你们团队",
    "团队都有谁",
    "团队是谁",
    "团队有多少人",
    "为什么",
    "啥意思",
    "什么意思",
    "你是个笨蛋",
    "你好笨",
    "太慢",
    "不理我",
    "在吗",
    "在不在"
  ];
  if (conversationPatterns.some((keyword) => compact.includes(keyword))) {
    return true;
  }
  return /(?:你|团队|我们|为什么|怎么|啥|什么|在吗|介绍)[^。！？!?]{0,30}[?？]?$/.test(normalized) && normalized.length <= 24;
}

function buildDirectConversationReply(text: string): string {
  const compact = normalizeConversationCandidate(text).toLowerCase().replace(/\s+/g, "");
  if (compact.includes("你是谁")) {
    return "我是 VinkoClaw 的执行入口。你可以把我当成一个可调度多角色团队的总入口，能接任务、拆分角色、推进执行、同步进度。";
  }
  if (compact.includes("你能做什么") || compact.includes("你可以做什么") || compact.includes("会做什么")) {
    return "我可以直接帮你推进真实工作：拆解需求、写代码、联调测试、配置工具、发审批并回报进度。你给一条明确目标，我就按同一工作流持续做完。";
  }
  if (
    compact.includes("团队有多少人") ||
    compact.includes("介绍你们团队") ||
    compact.includes("介绍一下你们团队") ||
    compact.includes("团队都有谁") ||
    compact.includes("团队是谁")
  ) {
    const defaults = store.getRuntimeConfig().collaboration.defaultParticipants;
    const participants = defaults.length > 0 ? defaults : ["product", "uiux", "frontend", "backend", "qa"];
    return `当前默认协作角色有：${participants.map((roleId) => formatRoleLabel(roleId)).join("、")}。你给一条工作指令后，我会按团队协作方式推进并同步每个角色进展。`;
  }
  if (compact.includes("你是个笨蛋") || compact.includes("你好笨") || compact.includes("太慢") || compact.includes("不理我")) {
    return "收到反馈。我不会和你抬杠，后面我会尽量少说空话，直接给结论、动作和结果。你要是愿意，可以直接给我一个具体任务试一下。";
  }
  if (compact.includes("在吗") || compact.includes("在不在")) {
    return "在的。你直接给目标，我会连续推进直到完成。";
  }
  if (compact.includes("为什么") || compact.includes("啥意思") || compact.includes("什么意思")) {
    return "你这个问题我理解了。请直接说你要的结果，我会给你简短结论，并把执行动作落地。";
  }
  return "我在。你直接说目标结果即可，我会按同一条工作流持续推进。";
}

function parseGoalRunInputFromText(rawText: string, expectedFields: string[]): Record<string, string> | undefined {
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

function parseKeyValuePairsFromText(rawText: string): Record<string, string> | undefined {
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

function requestsNewIndependentGoal(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  const patterns = ["新任务", "另一个任务", "另外一个任务", "重新开始", "开新", "new task", "another task", "start over"];
  return patterns.some((keyword) => normalized.includes(keyword));
}

function resolveSessionSourceKey(input: {
  source: CreateTaskInput["source"];
  requestedBy?: string | undefined;
  chatId?: string | undefined;
}): string | undefined {
  if (input.source === "feishu") {
    return input.chatId ? `chat:${input.chatId}` : input.requestedBy ? `sender:${input.requestedBy}` : undefined;
  }
  if (input.source === "email") {
    return input.requestedBy ? `sender:${input.requestedBy}` : undefined;
  }
  if (input.source === "control-center") {
    return input.requestedBy ? `operator:${input.requestedBy}` : undefined;
  }
  return undefined;
}

function ensureInboundSession(input: {
  source: CreateTaskInput["source"];
  requestedBy?: string | undefined;
  requesterName?: string | undefined;
  chatId?: string | undefined;
  titleHint: string;
}): string | undefined {
  const sourceKey = resolveSessionSourceKey(input);
  if (!sourceKey) {
    return undefined;
  }
  const sessionTitle =
    input.source === "feishu" && input.chatId
      ? `Feishu ${input.chatId}`
      : input.source === "email" && input.requestedBy
        ? `Email ${input.requestedBy}`
        : input.source === "control-center" && input.requestedBy
          ? `ControlCenter ${input.requestedBy}`
          : input.titleHint;
  return store.ensureSession({
    source: input.source,
    sourceKey,
    title: sessionTitle,
    metadata: {
      requestedBy: input.requestedBy ?? "",
      requesterName: input.requesterName ?? "",
      chatId: input.chatId ?? ""
    }
  }).id;
}

async function handleInboundMessage(input: {
  text: string;
  taskText?: string | undefined;
  source: CreateTaskInput["source"];
  requestedBy?: string | undefined;
  requesterName?: string | undefined;
  chatId?: string | undefined;
  attachments?: TaskAttachment[] | undefined;
}): Promise<
  | { type: "template_updated"; message: string; templateId: string; enabled: boolean }
  | { type: "template_not_found"; message: string; query: string }
  | { type: "smalltalk_replied"; message: string }
  | { type: "needs_clarification"; message: string; questions: string[] }
  | { type: "config_input_required"; message: string; missingField: string; expectedCommand: string }
  | { type: "operator_action_pending"; message: string; approvalId: string }
  | { type: "operator_action_applied"; message: string; actionId: string }
  | { type: "template_tasks_queued"; message: string; templateId: string; taskIds: string[] }
  | { type: "goal_run_queued"; message: string; goalRunId: string }
  | { type: "task_queued"; message: string; taskId: string }
> {
  const inboundText = input.text.trim();
  const taskText = (input.taskText ?? inboundText).trim() || inboundText;
  const requesterName = input.requesterName?.trim() ?? "";

  // Fire collaboration analysis immediately (fire-and-forget, not blocking).
  // The result will be used by whichever path actually creates a task.
  const collaborationConfig = store.getRuntimeConfig().collaboration;
  const collabStartTime = Date.now();
  const collaborationPlanPromise = analyzeCollaborationNeed(inboundText, {
    triggerKeywords: collaborationConfig.triggerKeywords
  });
  collaborationPlanPromise.then((plan) => {
    logger.info("collaboration analysis completed", { elapsed: Date.now() - collabStartTime, plan });
  }).catch((err) => {
    logger.error("collaboration analysis failed", { elapsed: Date.now() - collabStartTime, error: (err as Error)?.message });
  });

  // Helper: apply collaboration plan to a just-created task (async, non-blocking).
  // Call this right after createTask() in every path that creates a task.
  const applyCollaborationPlanToTask = (
    taskId: string,
    planPromise: Promise<Awaited<ReturnType<typeof analyzeCollaborationNeed>>> = collaborationPlanPromise
  ) => {
    planPromise.then((plan) => {
      logger.info("collaboration plan resolved", { taskId, plan });
      const patch: Record<string, unknown> = { collaborationPlan: plan };
      if (collaborationConfig.enabled && (plan.level === "light")) {
        // Light collaboration: only set lightCollaboration flag, NOT collaborationMode.
        // collaborationMode triggers the full collaboration flow in the worker,
        // which we don't want for light collaboration tasks.
        patch.lightCollaboration = true;
        // If the task was not yet assigned to a specialist (ceo or undefined), assign to
        // the domain specialist indicated by the plan's first suggested reviewer.
        const task = store.getTask(taskId);
        if (task && (task.roleId === "ceo" || task.roleId === undefined) && plan.suggestedReviewers.length > 0) {
          const executionRole: string = plan.suggestedReviewers[0]!;
          store.patchTaskRole(taskId, executionRole);
        }
      } else if (collaborationConfig.enabled && (plan.level === "standard" || plan.level === "full")) {
        patch.collaborationMode = true;
        patch.lightCollaboration = true;
      }
      store.patchTaskMetadata(taskId, patch);
    }).catch(() => { /* ignore — keyword fallback will be used by worker */ });
  };

  const sessionId = ensureInboundSession({
    source: input.source,
    requestedBy: input.requestedBy,
    requesterName: requesterName || undefined,
    chatId: input.chatId,
    titleHint: shorten(taskText.replace(/\s+/g, " ").trim() || inboundText)
  });
  if (sessionId) {
    store.appendSessionMessage({
      sessionId,
      actorType: "user",
      actorId: input.requestedBy ?? "anonymous",
      messageType: "text",
      content: inboundText,
      metadata: {
        source: input.source,
        chatId: input.chatId ?? "",
        requesterName
      }
    });
    updateSessionProjectMemoryFromInbound({
      sessionId,
      requesterName,
      requestedBy: input.requestedBy,
      source: input.source,
      inboundText,
      taskText,
      stage: "intake"
    });
  }

  type InboundResult =
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

  const finalize = (result: InboundResult): InboundResult => {
    if (sessionId) {
      store.appendSessionMessage({
        sessionId,
        actorType: "system",
        actorId: "orchestrator",
        messageType: "event",
        content: result.message,
        metadata: {
          type: "inbound_ack",
          source: input.source
        }
      });
    }
    return result;
  };

  const session = sessionId ? store.getSession(sessionId) : undefined;
  const pendingSkillSearch = (session?.metadata?.pendingSkillSearch ?? null) as
    | {
        query?: unknown;
        targetRoleId?: unknown;
        results?: unknown;
        createdAt?: unknown;
      }
    | null;
  const skillSelection = parseSkillSelectionReply(inboundText);
  if (sessionId && pendingSkillSearch && skillSelection) {
    const results = Array.isArray(pendingSkillSearch.results)
      ? pendingSkillSearch.results
          .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
      : [];
    const selected = results[skillSelection.selection - 1];
    const skillId = typeof selected?.skillId === "string" ? selected.skillId : "";
    const targetRoleId =
      skillSelection.roleId ??
      (typeof pendingSkillSearch.targetRoleId === "string" ? resolveRoleId(pendingSkillSearch.targetRoleId) : undefined);
    if (skillId && targetRoleId) {
      const definition = getSkillDefinition(skillId);
      if (!definition) {
        const integrationTask = createSkillRuntimeIntegrationTask({
          sessionId,
          source: input.source,
          requestedBy: input.requestedBy,
          chatId: input.chatId,
          targetRoleId,
          skill: {
            skillId,
            name: typeof selected?.name === "string" ? selected.name : skillId,
            summary: typeof selected?.summary === "string" ? selected.summary : "",
            source: typeof selected?.source === "string" ? selected.source : "remote",
            sourceLabel: typeof selected?.sourceLabel === "string" ? selected.sourceLabel : "remote",
            sourceUrl: typeof selected?.sourceUrl === "string" ? selected.sourceUrl : undefined,
            version: typeof selected?.version === "string" ? selected.version : undefined,
            allowedRoles: Array.isArray(selected?.allowedRoles)
              ? selected.allowedRoles.filter((entry): entry is RoleId => typeof entry === "string")
              : []
          }
        });
        store.patchSessionMetadata(sessionId, {
          pendingSkillSearch: null
        });
        updateSessionProjectMemoryFromInbound({
          sessionId,
          requesterName,
          requestedBy: input.requestedBy,
          source: input.source,
          inboundText,
          taskText: `接入 skill runtime: ${skillId}`,
          stage: "skill_integration_queued",
          nextActions: ["等待工程助理接入 skill runtime 并完成验证"]
        });
        appendSessionSkillEvent({
          sessionId,
          content: `已创建 skill 接入任务：${typeof selected?.name === "string" ? selected.name : skillId}`,
          metadata: {
            type: "skill_integration_queued",
            taskId: integrationTask.id,
            skillId,
            targetRoleId,
            source: typeof selected?.source === "string" ? selected.source : "remote",
            sourceLabel: typeof selected?.sourceLabel === "string" ? selected.sourceLabel : "remote",
            sourceUrl: typeof selected?.sourceUrl === "string" ? selected.sourceUrl : "",
            version: typeof selected?.version === "string" ? selected.version : ""
          }
        });
        return finalize({
          type: "task_queued",
          message: formatSkillIntegrationTaskQueuedMessage({
            source: input.source,
            taskId: integrationTask.id,
            skillName: typeof selected?.name === "string" ? selected.name : skillId
          }),
          taskId: integrationTask.id
        });
      }
      if (!definition.allowedRoles.includes(targetRoleId)) {
        return finalize({
          type: "config_input_required",
          message: `${skillId} 不能安装到 ${targetRoleId}，请换一个角色。`,
          missingField: "targetRoleId",
          expectedCommand: `${skillSelection.selection} product`
        });
      }
      store.setSkillBinding({
        scope: "role",
        scopeId: targetRoleId,
        skillId,
        status: "enabled",
        verificationStatus: "unverified",
        config: definition.defaultConfig,
        installedBy: input.requestedBy,
        source: typeof selected?.source === "string" ? selected.source : "marketplace",
        sourceLabel: typeof selected?.sourceLabel === "string" ? selected.sourceLabel : "marketplace",
        sourceUrl: typeof selected?.sourceUrl === "string" ? selected.sourceUrl : undefined,
        version: typeof selected?.version === "string" ? selected.version : undefined
      });
      const verifyTask = createSkillSmokeVerifyTask({
        sessionId,
        source: input.source,
        requestedBy: input.requestedBy,
        chatId: input.chatId,
        targetRoleId,
        skill: {
          skillId,
          name: typeof selected?.name === "string" ? selected.name : skillId,
          source: typeof selected?.source === "string" ? selected.source : "marketplace",
          sourceLabel: typeof selected?.sourceLabel === "string" ? selected.sourceLabel : "marketplace",
          sourceUrl: typeof selected?.sourceUrl === "string" ? selected.sourceUrl : undefined,
          version: typeof selected?.version === "string" ? selected.version : undefined
        }
      });
      updateSessionProjectMemoryFromInbound({
        sessionId,
        requesterName,
        requestedBy: input.requestedBy,
        source: input.source,
        inboundText,
        taskText: `安装 skill: ${skillId}`,
        stage: "team_configured",
        nextActions: [
          `等待 ${targetRoleId} 执行 skill smoke verify`,
          `查看验证任务 ${verifyTask.id.slice(0, 8)} 的结果`
        ]
      });
      appendSessionSkillEvent({
        sessionId,
        content: `已安装 skill：${skillId} -> ${targetRoleId}`,
        metadata: {
          type: "skill_installed",
          skillId,
          targetRoleId,
          source: typeof selected?.source === "string" ? selected.source : "marketplace",
          sourceLabel: typeof selected?.sourceLabel === "string" ? selected.sourceLabel : "marketplace",
          sourceUrl: typeof selected?.sourceUrl === "string" ? selected.sourceUrl : "",
          version: typeof selected?.version === "string" ? selected.version : "",
          verifyTaskId: verifyTask.id
        }
      });
      store.patchSessionMetadata(sessionId, {
        pendingSkillSearch: null
      });
      return finalize({
        type: "operator_action_applied",
        message: `已安装 skill：${skillId} -> ${targetRoleId}。我还创建了验证任务（${verifyTask.id.slice(0, 8)}），会检查这个 skill 是否真的生效。`,
        actionId: `${targetRoleId}:${skillId}`
      });
    }
    if (!targetRoleId) {
      return finalize({
        type: "config_input_required",
        message: "还缺安装目标角色。请回复“编号 + 角色”，例如：1 product",
        missingField: "targetRoleId",
        expectedCommand: "1 product"
      });
    }
  }

  const skillSearchIntent = parseSkillSearchIntent(inboundText);
  if (sessionId && skillSearchIntent) {
    const results = await searchMarketplaceSkills({
      query: skillSearchIntent.query,
      limit: 5
    });
    store.patchSessionMetadata(sessionId, {
      pendingSkillSearch: {
        query: skillSearchIntent.query,
        targetRoleId: skillSearchIntent.roleId ?? "",
        results: results.map((entry) => ({
          skillId: entry.skillId,
          name: entry.name,
          summary: entry.summary,
          allowedRoles: entry.allowedRoles,
          source: entry.source,
          sourceLabel: entry.sourceLabel,
          sourceUrl: entry.sourceUrl,
          version: entry.version,
          installState: entry.installState
        })),
        createdAt: new Date().toISOString()
      }
    });
    return finalize({
      type: "smalltalk_replied",
      message: formatSkillSearchResultsMessage({
        query: skillSearchIntent.query,
        roleId: skillSearchIntent.roleId,
        results: results.map((entry) => ({
          skillId: entry.skillId,
          name: entry.name,
          summary: entry.summary,
          allowedRoles: entry.allowedRoles,
          version: entry.version,
          installState: entry.installState
        }))
      })
    });
  }

  const templateToggle = parseTemplateToggleCommand(inboundText);
  if (templateToggle) {
    const template = resolveTemplateByQuery(templateToggle.templateQuery);
    if (!template) {
      return finalize({
        type: "template_not_found",
        message: `未找到模板：${templateToggle.templateQuery}`,
        query: templateToggle.templateQuery
      });
    }

    const enabled = templateToggle.action === "enable";
    const updated = store.updateRoutingTemplate(template.id, { enabled });
    if (!updated) {
      return finalize({
        type: "template_not_found",
        message: `未找到模板：${templateToggle.templateQuery}`,
        query: templateToggle.templateQuery
      });
    }

    return finalize({
      type: "template_updated",
      message: `${enabled ? "已启用" : "已停用"} 模板 ${updated.name}（${updated.id}）`,
      templateId: updated.id,
      enabled: updated.enabled
    });
  }

  if (isSmalltalkMessage(inboundText)) {
    return finalize({
      type: "smalltalk_replied",
      message: buildSmalltalkReply(inboundText)
    });
  }

  if (isGoalRunStatusQuery(inboundText)) {
    const latestGoalRun = resolveLatestGoalRunForInbound({
      source: input.source,
      requestedBy: input.requestedBy,
      chatId: input.chatId
    });
    if (latestGoalRun) {
      return finalize({
        type: "smalltalk_replied",
        message: formatGoalRunStatusMessage(latestGoalRun)
      });
    }
  }

  if (isTaskStatusQuery(inboundText)) {
    const awaitingCollaboration = resolveAwaitingCollaborationTaskForInbound({
      source: input.source,
      requestedBy: input.requestedBy,
      chatId: input.chatId
    }, store.listTasks(500));
    if (awaitingCollaboration) {
      return finalize({
        type: "smalltalk_replied",
        message: formatAwaitingCollaborationMessage(awaitingCollaboration)
      });
    }
    const activeTask = resolveLatestActiveTaskForInbound({
      source: input.source,
      requestedBy: input.requestedBy,
      chatId: input.chatId
    });
    if (activeTask) {
      return finalize({
        type: "smalltalk_replied",
        message: formatActiveTaskStatusMessage(activeTask)
      });
    }
  }

  const approvalDecisionCommand = parseApprovalDecisionCommand(inboundText);
  if (approvalDecisionCommand) {
    const decisionResult = await applyApprovalDecisionFromCommand({
      ...(approvalDecisionCommand.approvalToken ? { approvalToken: approvalDecisionCommand.approvalToken } : {}),
      status: approvalDecisionCommand.status,
      decidedBy: input.requestedBy,
      decisionNote: approvalDecisionCommand.decisionNote,
      requestedBy: input.requestedBy
    });
    if (!decisionResult.ok) {
      return finalize({
        type: "config_input_required",
        message: decisionResult.message,
        missingField: "approvalId",
        expectedCommand: "回复 1 同意（或 0 拒绝）；若有多个待审批，回复 1 <编号> 或 0 <编号>"
      });
    }
    return finalize({
      type: "operator_action_applied",
      message: decisionResult.message,
      actionId: decisionResult.approvalId
    });
  }

  const awaitingGoalRun = resolveAwaitingGoalRunForInbound({
    source: input.source,
    requestedBy: input.requestedBy,
    chatId: input.chatId
  });
  if (awaitingGoalRun) {
    const parsedInputs = parseGoalRunInputFromText(inboundText, awaitingGoalRun.awaitingInputFields);
    if (!parsedInputs) {
      if (isDirectConversationTurn(inboundText)) {
        return finalize({
          type: "smalltalk_replied",
          message: `我可以继续帮你推进当前目标。现在还缺：${formatGoalInputFields(awaitingGoalRun.awaitingInputFields)}。你直接回复这些信息后，我会立刻继续。`
        });
      }
      return finalize({
        type: "config_input_required",
        message: `当前任务（${awaitingGoalRun.id.slice(0, 8)}）还缺：${formatGoalInputFields(awaitingGoalRun.awaitingInputFields)}。你可以按顺序回复，或用 key:value 格式。`,
        missingField: awaitingGoalRun.awaitingInputFields[0] ?? "input",
        expectedCommand: buildGoalInputExpectedCommand(awaitingGoalRun.awaitingInputFields)
      });
    }

    for (const [key, value] of Object.entries(parsedInputs)) {
      store.upsertGoalRunInput({
        goalRunId: awaitingGoalRun.id,
        inputKey: key,
        value,
        createdBy: input.requestedBy
      });
    }
    store.updateGoalRunContext(awaitingGoalRun.id, parsedInputs);
    const resumedGoalRun = store.queueGoalRun(awaitingGoalRun.id, awaitingGoalRun.currentStage) ?? awaitingGoalRun;
    store.appendGoalRunTimelineEvent({
      goalRunId: awaitingGoalRun.id,
      stage: resumedGoalRun.currentStage,
      eventType: "input_received",
      message: `Received ${Object.keys(parsedInputs).length} input item(s)`,
      payload: {
        keys: Object.keys(parsedInputs)
      }
    });
    return finalize({
      type: "operator_action_applied",
      message: `收到，已补充 ${Object.keys(parsedInputs).join(", ")}，我先让流程继续推进，关键进展会同步你。`,
      actionId: awaitingGoalRun.id
    });
  }

  const inFlightGoalRun = resolveLatestInFlightGoalRunForInbound({
    source: input.source,
    requestedBy: input.requestedBy,
    chatId: input.chatId
  });
  if (inFlightGoalRun) {
    const prefilledInputs = parseKeyValuePairsFromText(inboundText);
    if (prefilledInputs) {
      for (const [key, value] of Object.entries(prefilledInputs)) {
        store.upsertGoalRunInput({
          goalRunId: inFlightGoalRun.id,
          inputKey: key,
          value,
          createdBy: input.requestedBy
        });
      }
      store.updateGoalRunContext(inFlightGoalRun.id, prefilledInputs);
      store.appendGoalRunTimelineEvent({
        goalRunId: inFlightGoalRun.id,
        stage: inFlightGoalRun.currentStage,
        eventType: "input_received",
        message: `Prefilled ${Object.keys(prefilledInputs).length} input item(s) while run in-flight`,
        payload: {
          keys: Object.keys(prefilledInputs)
        }
      });
      return finalize({
        type: "operator_action_applied",
        message: `收到，已记录补充信息 ${Object.keys(prefilledInputs).join(", ")}，我会继续推进当前目标流程。`,
        actionId: inFlightGoalRun.id
      });
    }
    if (isContinueSignal(inboundText)) {
      updateSessionProjectMemoryFromInbound({
        sessionId,
        requesterName,
        requestedBy: input.requestedBy,
        source: input.source,
        inboundText,
        taskText,
        stage: "goal_run_in_progress"
      });
      return finalize({
        type: "smalltalk_replied",
        message: `${formatGoalRunStatusMessage(inFlightGoalRun)} 你无需重复下发，我会持续推进并在关键节点同步。`
      });
    }
  }

  const awaitingCollaboration = resolveAwaitingCollaborationTaskForInbound({
    source: input.source,
    requestedBy: input.requestedBy,
    chatId: input.chatId
  }, store.listTasks(500));
  if (awaitingCollaboration) {
    const resumedTask = resumeAwaitingCollaborationTask(store, {
      task: awaitingCollaboration,
      text: inboundText,
      requesterName
    });
    updateSessionProjectMemoryFromInbound({
      sessionId: resumedTask.sessionId,
      requesterName,
      requestedBy: input.requestedBy,
      source: input.source,
      inboundText,
      taskText,
      stage: "resuming_collaboration",
      unresolvedQuestions: [],
      nextActions: ["等待团队重新汇总并继续交付"]
    });
    if (resumedTask.sessionId) {
      store.appendSessionMessage({
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
    return finalize({
      type: "operator_action_applied",
      message: `收到，我已把这次补充信息续接到原协作任务（${awaitingCollaboration.id.slice(0, 8)}），现在继续汇总并推进交付。`,
      actionId: awaitingCollaboration.id
    });
  }

  if (isDirectConversationTurn(inboundText)) {
    return finalize({
      type: "smalltalk_replied",
      message: buildDirectConversationReply(inboundText)
    });
  }

  const parsedAction = parseOperatorActionFromText(inboundText, input.requestedBy);
  const marketplaceInstallIntent = !parsedAction ? parseSkillInstallIntent(inboundText) : undefined;
  if (!parsedAction && marketplaceInstallIntent) {
    const results = await searchMarketplaceSkills({
      query: marketplaceInstallIntent.query,
      limit: 5
    });
    if (results.length === 0) {
      return finalize({
        type: "config_input_required",
        message: `没有找到和「${marketplaceInstallIntent.query}」相关的 skill。你可以换个关键词，或者先搜索 skill 再确认安装。`,
        missingField: "skillId",
        expectedCommand: `搜索 ${marketplaceInstallIntent.query} skill`
      });
    }

    const exactMatch = results.find((entry) => isExactMarketplaceSkillMatch(entry, marketplaceInstallIntent.query));
    const selected = exactMatch ?? (results.length === 1 ? results[0] : undefined);
    if (!selected) {
      if (sessionId) {
        store.patchSessionMetadata(sessionId, {
          pendingSkillSearch: {
            query: marketplaceInstallIntent.query,
            targetRoleId: marketplaceInstallIntent.roleId,
            results: results.map((entry) => ({
              skillId: entry.skillId,
              name: entry.name,
              summary: entry.summary,
              allowedRoles: entry.allowedRoles,
              aliases: entry.aliases,
              source: entry.source,
              sourceLabel: entry.sourceLabel,
              sourceUrl: entry.sourceUrl,
              version: entry.version,
              installState: entry.installState
            })),
            createdAt: new Date().toISOString()
          }
        });
      }
      return finalize({
        type: "smalltalk_replied",
        message: formatSkillSearchResultsMessage({
          query: marketplaceInstallIntent.query,
          roleId: marketplaceInstallIntent.roleId,
          results: results.map((entry) => ({
            skillId: entry.skillId,
            name: entry.name,
            summary: entry.summary,
            allowedRoles: entry.allowedRoles,
            version: entry.version,
            installState: entry.installState
          }))
        })
      });
    }

    if (!selected.allowedRoles.includes(marketplaceInstallIntent.roleId)) {
      return finalize({
        type: "config_input_required",
        message: `${selected.skillId} 不能安装到 ${marketplaceInstallIntent.roleId}，请换一个角色。`,
        missingField: "targetRoleId",
        expectedCommand: `给 product 安装 ${selected.skillId} skill`
      });
    }

    const definition = getSkillDefinition(selected.skillId);
    if (!definition) {
      const integrationTask = createSkillRuntimeIntegrationTask({
        sessionId,
        source: input.source,
        requestedBy: input.requestedBy,
        chatId: input.chatId,
        targetRoleId: marketplaceInstallIntent.roleId,
        skill: selected
      });
      updateSessionProjectMemoryFromInbound({
        sessionId,
        requesterName,
        requestedBy: input.requestedBy,
        source: input.source,
        inboundText,
        taskText: `接入 skill runtime: ${selected.skillId}`,
        stage: "skill_integration_queued",
        nextActions: ["等待工程助理接入 skill runtime 并完成验证"]
      });
      appendSessionSkillEvent({
        sessionId,
        content: `已创建 skill 接入任务：${selected.name}`,
        metadata: {
          type: "skill_integration_queued",
          taskId: integrationTask.id,
          skillId: selected.skillId,
          targetRoleId: marketplaceInstallIntent.roleId,
          source: selected.source,
          sourceLabel: selected.sourceLabel ?? "",
          sourceUrl: selected.sourceUrl ?? "",
          version: selected.version ?? ""
        }
      });
      return finalize({
        type: "task_queued",
        message: formatSkillIntegrationTaskQueuedMessage({
          source: input.source,
          taskId: integrationTask.id,
          skillName: selected.name
        }),
        taskId: integrationTask.id
      });
    }

    store.setSkillBinding({
      scope: "role",
      scopeId: marketplaceInstallIntent.roleId,
      skillId: selected.skillId,
      status: "enabled",
      verificationStatus: "unverified",
      config: definition.defaultConfig,
      installedBy: input.requestedBy,
      source: selected.source,
      sourceLabel: selected.sourceLabel,
      sourceUrl: selected.sourceUrl,
      version: selected.version
    });
    const verifyTask = createSkillSmokeVerifyTask({
      sessionId,
      source: input.source,
      requestedBy: input.requestedBy,
      chatId: input.chatId,
      targetRoleId: marketplaceInstallIntent.roleId,
      skill: selected
    });
    updateSessionProjectMemoryFromInbound({
      sessionId,
      requesterName,
      requestedBy: input.requestedBy,
      source: input.source,
      inboundText,
      taskText: `安装 skill: ${selected.skillId}`,
      stage: "team_configured",
      nextActions: [
        `等待 ${marketplaceInstallIntent.roleId} 执行 skill smoke verify`,
        `查看验证任务 ${verifyTask.id.slice(0, 8)} 的结果`
      ]
    });
    appendSessionSkillEvent({
      sessionId,
      content: `已安装 skill：${selected.skillId} -> ${marketplaceInstallIntent.roleId}`,
      metadata: {
        type: "skill_installed",
        skillId: selected.skillId,
        targetRoleId: marketplaceInstallIntent.roleId,
        source: selected.source,
        sourceLabel: selected.sourceLabel ?? "",
        sourceUrl: selected.sourceUrl ?? "",
        version: selected.version ?? "",
        verifyTaskId: verifyTask.id
      }
    });
    return finalize({
      type: "operator_action_applied",
      message: `已安装 skill：${selected.skillId} -> ${marketplaceInstallIntent.roleId}。我还创建了验证任务（${verifyTask.id.slice(0, 8)}），会检查这个 skill 是否真的生效。`,
      actionId: `${marketplaceInstallIntent.roleId}:${selected.skillId}`
    });
  }
  if (parsedAction) {
    if (parsedAction.action.kind === "set_tool_provider_config") {
      const requiresApiKey = Boolean(parsedAction.action.payload.requiresApiKey);
      const apiKeyEnv =
        typeof parsedAction.action.payload.apiKeyEnv === "string"
          ? parsedAction.action.payload.apiKeyEnv
          : "";
      const hasInlineApiKey =
        typeof parsedAction.action.payload.apiKey === "string" &&
        parsedAction.action.payload.apiKey.trim().length > 0;

      if (requiresApiKey && apiKeyEnv && !hasInlineApiKey && !hasConfiguredSecret(apiKeyEnv)) {
        return finalize({
          type: "config_input_required",
          message: `模型切换依赖 ${apiKeyEnv}，请先配置密钥后再重试。`,
          missingField: apiKeyEnv,
          expectedCommand: `设置 ${apiKeyEnv.toLowerCase()} 为 <your-key>`
        });
      }
    }

    if (parsedAction.action.kind === "send_email") {
      const missing: string[] = [];
      if (!getRuntimeValue("SMTP_URL")) {
        missing.push("SMTP_URL");
      }
      if (!getRuntimeValue("EMAIL_DEFAULT_FROM")) {
        missing.push("EMAIL_DEFAULT_FROM");
      }
      if (missing.length > 0) {
        return finalize({
          type: "config_input_required",
          message: `邮件通道配置不完整，缺少：${missing.join(", ")}`,
          missingField: missing[0] ?? "SMTP_URL",
          expectedCommand:
            missing[0] === "SMTP_URL"
              ? "设置邮件smtp为 smtps://your_email%40qq.com:auth_code@smtp.qq.com:465"
              : "设置邮件发件人为 VinkoClaw <your_email@qq.com>"
        });
      }
    }

    if (parsedAction.action.kind === "set_runtime_setting") {
      const key =
        typeof parsedAction.action.payload.key === "string"
          ? parsedAction.action.payload.key.trim().toUpperCase()
          : "";
      const value =
        typeof parsedAction.action.payload.value === "string"
          ? parsedAction.action.payload.value.trim()
          : "";
      if (key === "SEARCH_PROVIDER") {
        const providerId = resolveSearchProviderId(value);
        if (!providerId) {
          return finalize({
            type: "config_input_required",
            message: "搜索工具提供商不受支持，请在 tavily / serpapi 中选择。",
            missingField: "SEARCH_PROVIDER",
            expectedCommand: "设置搜索工具为 tavily（可选: tavily / serpapi）"
          });
        }
        const apiKeyEnv = resolveSearchProviderApiKeyEnv(providerId);
        if (!hasConfiguredSecret(apiKeyEnv)) {
          return finalize({
            type: "config_input_required",
            message: `已识别搜索提供商 ${providerId}，还缺少密钥 ${apiKeyEnv}。`,
            missingField: apiKeyEnv,
            expectedCommand: `设置 ${apiKeyEnv} 为 <your-key>（设置后会自动启用 ${providerId} 搜索）`
          });
        }
      }
    }

    if (parsedAction.action.kind === "install_skill") {
      const targetRoleId = parsedAction.action.targetRoleId;
      const skillId = parsedAction.action.skillId;
      if (targetRoleId && skillId && !roleCanUseSkill(targetRoleId, skillId)) {
        return finalize({
          type: "config_input_required",
          message: `角色 ${targetRoleId} 不支持技能 ${skillId}，请更换角色或技能后重试。`,
          missingField: "targetRoleId",
          expectedCommand: `给 ${targetRoleId === "backend" ? "frontend" : "backend"} 安装 ${skillId} skill`
        });
      }
    }

    if (parsedAction.action.kind === "remove_agent_instance") {
      const roleId =
        parsedAction.action.targetRoleId ??
        (typeof parsedAction.action.payload.roleId === "string"
          ? resolveRoleId(parsedAction.action.payload.roleId)
          : undefined);
      if (!roleId) {
        return finalize({
          type: "config_input_required",
          message: "缺少要移除的 Agent 角色。",
          missingField: "targetRoleId",
          expectedCommand: "移除一个测试 agent"
        });
      }
      const activeInstances = store.listActiveAgentInstances(roleId);
      if (activeInstances.length === 0) {
        return finalize({
          type: "config_input_required",
          message: `当前没有可移除的 ${roleId} Agent 实例。`,
          missingField: "targetRoleId",
          expectedCommand: "加一个测试 agent"
        });
      }
    }

    if (parsedAction.action.kind === "set_agent_tone_policy") {
      const roleId =
        parsedAction.action.targetRoleId ??
        (typeof parsedAction.action.payload.roleId === "string"
          ? resolveRoleId(parsedAction.action.payload.roleId)
          : undefined);
      if (!roleId) {
        return finalize({
          type: "config_input_required",
          message: "缺少要设置语气策略的 Agent 角色。",
          missingField: "targetRoleId",
          expectedCommand: "把测试 agent 的语气改为更专业、客观、简洁"
        });
      }
      const activeInstances = store.listActiveAgentInstances(roleId);
      if (activeInstances.length === 0) {
        return finalize({
          type: "config_input_required",
          message: `当前没有活跃的 ${roleId} Agent 实例，请先创建。`,
          missingField: "targetRoleId",
          expectedCommand: "加一个测试 agent"
        });
      }
    }

    const action = store.createOperatorAction({
      ...parsedAction.action,
      summary: summarizeOperatorAction(parsedAction.action)
    });
    const actionSummaryForUser = formatOperatorActionSummaryForUser(action);

    const lowRiskAction = isOwnerLowRiskOperatorAction(action);
    const ownerRequester = isOwnerRequester({
      source: input.source,
      requestedBy: input.requestedBy,
      ownerOpenIds: resolveFeishuOwnerOpenIds()
    });
    const lowRiskAutoApproveScope = resolveLowRiskAutoApproveScope();
    const ownerLowRiskAutoApply =
      isLowRiskAutoApproveEnabled() &&
      lowRiskAction &&
      (lowRiskAutoApproveScope === "all" ||
        (lowRiskAutoApproveScope === "owner" && ownerRequester) ||
        (lowRiskAutoApproveScope === "owner_or_control_center" &&
          (ownerRequester || input.source === "control-center")));

    const autoApproveAllowlist = getRuntimeValue("SKILL_AUTO_APPROVE_ALLOWLIST");
    const allowlistAutoApply =
      action.kind === "install_skill" &&
      action.targetRoleId &&
      action.skillId &&
      isSkillAutoApproveAllowed({
        rawAllowlist: autoApproveAllowlist,
        roleId: action.targetRoleId,
        skillId: action.skillId
      });

    if (ownerLowRiskAutoApply || allowlistAutoApply) {
      let verifyTask:
        | ReturnType<typeof store.createTask>
        | undefined;
      try {
        store.applyOperatorAction(action.id, input.requestedBy ?? "system");
        if (action.kind === "install_skill" && action.targetRoleId && action.skillId) {
          const definition = getSkillDefinition(action.skillId);
          if (definition) {
            verifyTask = createSkillSmokeVerifyTask({
              sessionId,
              source: input.source,
              requestedBy: input.requestedBy,
              chatId: input.chatId,
              targetRoleId: action.targetRoleId,
              skill: {
                skillId: action.skillId,
                name: definition.name,
                source: typeof action.payload.source === "string" ? action.payload.source : "catalog",
                sourceLabel: typeof action.payload.sourceLabel === "string" ? action.payload.sourceLabel : "catalog",
                sourceUrl: typeof action.payload.sourceUrl === "string" ? action.payload.sourceUrl : undefined,
                version: typeof action.payload.version === "string" ? action.payload.version : undefined
              }
            });
          }
        }
        if (ownerLowRiskAutoApply) {
          store.appendAuditEvent({
            category: "approval",
            entityType: "operator_action",
            entityId: action.id,
            message: "Auto-approved operator action by low-risk policy",
            payload: {
              requestedBy: input.requestedBy ?? "",
              source: input.source,
              kind: action.kind,
              scope: lowRiskAutoApproveScope
            }
          });
        }
      } catch (error) {
        return finalize({
          type: "config_input_required",
          message: `自动执行失败：${error instanceof Error ? error.message : String(error)}`,
          missingField: "skillId",
          expectedCommand: `给 ${action.targetRoleId} 安装 ${action.skillId} skill`
        });
      }
      return finalize({
        type: "operator_action_applied",
        message: (() => {
          const searchFollowup = buildSearchConfigFollowupMessage(action);
          if (searchFollowup) {
            return searchFollowup;
          }
          if (input.source === "feishu") {
            return ownerLowRiskAutoApply
              ? `已为你自动执行（低风险免审）：${actionSummaryForUser}。${verifyTask ? ` 验证任务 ${verifyTask.id.slice(0, 8)} 已创建。` : ""}`
              : `已按白名单自动执行：${actionSummaryForUser}。${verifyTask ? ` 验证任务 ${verifyTask.id.slice(0, 8)} 已创建。` : ""}`;
          }
          return ownerLowRiskAutoApply
            ? `已自动执行（低风险免审）：${actionSummaryForUser}${verifyTask ? `；验证任务 ${verifyTask.id.slice(0, 8)} 已创建` : ""}`
            : `已按白名单自动执行：${actionSummaryForUser}${verifyTask ? `；验证任务 ${verifyTask.id.slice(0, 8)} 已创建` : ""}`;
        })(),
        actionId: action.id
      });
    }

    const approval = store.createApproval({
      kind: action.kind,
      operatorActionId: action.id,
      summary: action.summary,
      payload: action.payload,
      requestedBy: input.requestedBy
    });
    const ensured = store.ensureApprovalWorkflow(approval.id, resolveWorkflowLevelsForApproval(approval));
    store.attachApprovalToOperatorAction(action.id, approval.id);
    void notifyApprovalStepViaFeishu(approval.id, ensured.steps[0]?.id);

    return finalize({
      type: "operator_action_pending",
      message: formatOperatorActionPendingMessage(input.source, approval.id, actionSummaryForUser),
      approvalId: approval.id
    });
  }

  const inputRequirement = parseOperatorConfigInputRequirementFromText(inboundText);
  if (inputRequirement) {
    return finalize({
      type: "config_input_required",
      message: inputRequirement.message,
      missingField: inputRequirement.missingField,
      expectedCommand: inputRequirement.expectedCommand
    });
  }

  const template = selectRoutingTemplate(inboundText, store.listRoutingTemplates());
  if (template) {
    const tasks =
      template.id === "tpl-founder-delivery-loop"
        ? createFounderDeliveryWorkflow({
            sessionId,
            template,
            text: taskText,
            source: input.source,
            requestedBy: input.requestedBy,
            requesterName: requesterName || undefined,
            chatId: input.chatId,
            attachments: input.attachments
          })
        : createTemplateTasks({
            sessionId,
            template,
            text: taskText,
            source: input.source,
            requestedBy: input.requestedBy,
            requesterName: requesterName || undefined,
            chatId: input.chatId,
            attachments: input.attachments
          });
    return finalize({
      type: "template_tasks_queued",
      message:
        template.id === "tpl-founder-delivery-loop"
          ? formatFounderWorkflowQueuedMessage(input.source, template.name)
          : formatTemplateTasksQueuedMessage(input.source, template.name, tasks.length),
      templateId: template.id,
      taskIds: tasks.map((task) => task.id)
    });
  }

  // --- Task-level user interaction: handle paused task response ---
  const pausedTask = sessionId ? store.getPausedTask(input.source, input.requestedBy, input.chatId) : undefined;
  if (sessionId && pausedTask && pausedTask.pendingInput) {
    const originalInstruction = pausedTask.instruction;
    const userAnswer = inboundText.trim();
    const enrichedInstruction = `${originalInstruction}\n\n用户补充信息：${userAnswer}`;
    store.resumeTask(pausedTask.id, enrichedInstruction);
    updateSessionProjectMemoryFromInbound({
      sessionId,
      requesterName,
      requestedBy: input.requestedBy,
      source: input.source,
      inboundText,
      taskText: enrichedInstruction,
      stage: "task_input_received",
      nextActions: ["任务已恢复执行"]
    });
    store.appendSessionMessage({
      sessionId,
      actorType: "system",
      actorId: "orchestrator",
      roleId: pausedTask.roleId,
      messageType: "event",
      content: "任务已恢复执行",
      metadata: {
        type: "task_resumed",
        taskId: pausedTask.id
      }
    });
    return finalize({
      type: "task_queued",
      message: formatTaskQueuedMessage(input.source, pausedTask.id, pausedTask.roleId),
      taskId: pausedTask.id
    });
  }

  // --- Intake clarification: handle pending clarification response ---
  const pendingClarification = (session?.metadata?.pendingClarification ?? null) as
    | {
        originalText?: unknown;
        questions?: unknown;
        createdAt?: unknown;
        roleId?: unknown;
      }
    | null;
  if (sessionId && pendingClarification && typeof pendingClarification.originalText === "string") {
    const originalText = pendingClarification.originalText;
    const questions = Array.isArray(pendingClarification.questions)
      ? pendingClarification.questions.filter((q): q is string => typeof q === "string")
      : [];
    const enrichedInstruction = mergeClarificationResponse(originalText, questions, inboundText);
    store.patchSessionMetadata(sessionId, { pendingClarification: null });
    updateSessionProjectMemoryFromInbound({
      sessionId,
      requesterName,
      requestedBy: input.requestedBy,
      source: input.source,
      inboundText,
      taskText: enrichedInstruction,
      stage: "clarification_received",
      nextActions: ["创建任务并开始执行"]
    });
    const clarifiedIntentStartTime = Date.now();
    const clarifiedIntent = await classifyInboundIntent(enrichedInstruction, {
      triggerKeywords: collaborationConfig.triggerKeywords
    });
    logger.info("clarification intent classification done", {
      elapsed: Date.now() - clarifiedIntentStartTime,
      sinceFunctionStart: Date.now() - collabStartTime,
      clarifiedIntent
    });

    if (clarifiedIntent === "operator_config") {
      const clarifiedInputRequirement = parseOperatorConfigInputRequirementFromText(enrichedInstruction);
      if (clarifiedInputRequirement) {
        return finalize({
          type: "config_input_required",
          message: clarifiedInputRequirement.message,
          missingField: clarifiedInputRequirement.missingField,
          expectedCommand: clarifiedInputRequirement.expectedCommand
        });
      }
      return finalize({
        type: "config_input_required",
        message: "我理解你想配置系统能力，请告诉我具体的操作，例如：「设置搜索工具为 tavily」、「切换模型到 glm-5」或「给 research 安装 web-search skill」。",
        missingField: "action",
        expectedCommand: "设置搜索工具为 tavily"
      });
    }

    if (clarifiedIntent === "goalrun") {
      if (inFlightGoalRun && !requestsNewIndependentGoal(enrichedInstruction)) {
        return finalize({
          type: "smalltalk_replied",
          message: `当前已有进行中的目标（${inFlightGoalRun.id.slice(0, 8)}，${formatGoalRunStageLabel(inFlightGoalRun.currentStage)}）。我会先把这条主线推进完成。若你要并行开新目标，请发送”新任务：<你的目标>”。`
        });
      }
      const goalRun = store.createGoalRun({
        source: input.source,
        objective: enrichedInstruction,
        requestedBy: input.requestedBy,
        chatId: input.chatId,
        sessionId,
        language: /[\u4e00-\u9fff]/.test(enrichedInstruction) ? "zh-CN" : "en-US",
        metadata: {
          inboundText: enrichedInstruction,
          ...(requesterName ? { requesterName } : {}),
          attachments: input.attachments ?? []
        },
        context: {}
      });
      updateSessionProjectMemoryFromInbound({
        sessionId,
        requesterName,
        requestedBy: input.requestedBy,
        source: input.source,
        inboundText: enrichedInstruction,
        taskText: enrichedInstruction,
        stage: "goal_run_discover",
        nextActions: ["等待目标流程完成 discover/plan/execute 阶段"]
      });
      return finalize({
        type: "goal_run_queued",
        message: formatGoalRunQueuedMessage(input.source, goalRun.id),
        goalRunId: goalRun.id
      });
    }

    const clarifiedCollaborationMode = collaborationConfig.enabled && (clarifiedIntent === "collaboration");
    const clarifiedLightCollaborationMode =
      collaborationConfig.enabled && (clarifiedIntent === "light_collaboration") && !clarifiedCollaborationMode;
    const clarifiedRoleId = clarifiedCollaborationMode ? resolveCollaborationEntryRole(enrichedInstruction) : undefined;
    const clarifiedMetadata: Record<string, unknown> = requesterName ? { requesterName } : {};
    if (input.attachments && input.attachments.length > 0) {
      clarifiedMetadata.attachments = input.attachments;
    }
    if (clarifiedCollaborationMode) {
      clarifiedMetadata.collaborationMode = true;
      clarifiedMetadata.collaborationEntryRole = clarifiedRoleId;
    }
    if (clarifiedLightCollaborationMode) {
      clarifiedMetadata.lightCollaboration = true;
    }
    const clarifiedTask = createTask({
      sessionId,
      instruction: enrichedInstruction,
      source: input.source,
      requestedBy: input.requestedBy,
      chatId: input.chatId,
      roleId: clarifiedRoleId,
      metadata: clarifiedMetadata
    });
    const clarifiedCollaborationPlanPromise = analyzeCollaborationNeed(enrichedInstruction, {
      triggerKeywords: collaborationConfig.triggerKeywords
    });
    applyCollaborationPlanToTask(clarifiedTask.id, clarifiedCollaborationPlanPromise);
    updateSessionProjectMemoryFromInbound({
      sessionId,
      requesterName,
      requestedBy: input.requestedBy,
      source: input.source,
      inboundText: enrichedInstruction,
      taskText: enrichedInstruction,
      stage: clarifiedCollaborationMode
        ? "collaboration_queued"
        : clarifiedLightCollaborationMode
        ? "light_collaboration_queued"
        : "task_queued",
      nextActions: [
        clarifiedCollaborationMode
          ? "等待团队分工执行并汇总"
          : clarifiedLightCollaborationMode
          ? "等待主执行者完成并审阅"
          : "等待角色执行并返回结果"
      ]
    });
    const clarifiedMessage = clarifiedCollaborationMode
      ? formatTaskQueuedMessage(input.source, clarifiedTask.id, clarifiedTask.roleId) + "（已启动多角色协作模式）"
      : clarifiedLightCollaborationMode
      ? formatTaskQueuedMessage(input.source, clarifiedTask.id, clarifiedTask.roleId) + "（已启动轻量协作模式：主执行 + 审阅）"
      : formatTaskQueuedMessage(input.source, clarifiedTask.id, clarifiedTask.roleId);
    return finalize({
      type: "task_queued",
      message: clarifiedMessage,
      taskId: clarifiedTask.id
    });
  }

  // --- Intake clarification: analyze new requests for clarity ---
  if (sessionId && !isObviouslyClear(inboundText)) {
    const analysis = await analyzeIntakeClarity(inboundText);
    if (!analysis.isClear && analysis.clarifyingQuestions.length > 0) {
      store.patchSessionMetadata(sessionId, {
        pendingClarification: {
          originalText: inboundText,
          questions: analysis.clarifyingQuestions,
          createdAt: new Date().toISOString()
        }
      });
      updateSessionProjectMemoryFromInbound({
        sessionId,
        requesterName,
        requestedBy: input.requestedBy,
        source: input.source,
        inboundText,
        taskText,
        stage: "awaiting_clarification",
        unresolvedQuestions: analysis.clarifyingQuestions,
        nextActions: ["等待用户回复澄清问题"]
      });
      return finalize({
        type: "needs_clarification",
        message: formatClarificationMessage(analysis.clarifyingQuestions),
        questions: analysis.clarifyingQuestions
      });
    }
  }

  // Classify intent (for routing: goalrun / operator_config / task).
  // collaborationPlanPromise was already fired at the top of handleInboundMessage
  // and has been running in parallel throughout all early-return checks above.
  const intentStartTime = Date.now();
  const intent = await classifyInboundIntent(inboundText, {
    triggerKeywords: collaborationConfig.triggerKeywords
  });
  logger.info("intent classification done", { elapsed: Date.now() - intentStartTime, sinceFunctionStart: Date.now() - collabStartTime, intent });

  if (intent === "operator_config") {
    // The precise operator action path (parseOperatorActionFromText) already ran above and
    // returned nothing — so the user expressed a config intent but without a complete command.
    // Guide them toward the correct format.
    const inputRequirement = parseOperatorConfigInputRequirementFromText(inboundText);
    if (inputRequirement) {
      return finalize({
        type: "config_input_required",
        message: inputRequirement.message,
        missingField: inputRequirement.missingField,
        expectedCommand: inputRequirement.expectedCommand
      });
    }
    return finalize({
      type: "config_input_required",
      message: "我理解你想配置系统能力，请告诉我具体的操作，例如：「设置搜索工具为 tavily」、「切换模型到 glm-5」或「给 research 安装 web-search skill」。",
      missingField: "action",
      expectedCommand: "设置搜索工具为 tavily"
    });
  }

  if (intent === "goalrun") {
    if (inFlightGoalRun && !requestsNewIndependentGoal(inboundText)) {
      return finalize({
        type: "smalltalk_replied",
        message: `当前已有进行中的目标（${inFlightGoalRun.id.slice(0, 8)}，${formatGoalRunStageLabel(inFlightGoalRun.currentStage)}）。我会先把这条主线推进完成。若你要并行开新目标，请发送”新任务：<你的目标>”。`
      });
    }
    const goalRun = store.createGoalRun({
      source: input.source,
      objective: taskText,
      requestedBy: input.requestedBy,
      chatId: input.chatId,
      sessionId,
      language: /[\u4e00-\u9fff]/.test(taskText) ? "zh-CN" : "en-US",
      metadata: {
        inboundText,
        ...(requesterName ? { requesterName } : {}),
        attachments: input.attachments ?? []
      },
      context: {}
    });
    updateSessionProjectMemoryFromInbound({
      sessionId,
      requesterName,
      requestedBy: input.requestedBy,
      source: input.source,
      inboundText,
      taskText,
      stage: "goal_run_discover",
      nextActions: ["等待目标流程完成 discover/plan/execute 阶段"]
    });
    return finalize({
      type: "goal_run_queued",
      message: formatGoalRunQueuedMessage(input.source, goalRun.id),
      goalRunId: goalRun.id
    });
  }

  // For the main task path, we don't block on collaborationPlan — the LLM analysis can take
  // 30-60s. Instead, use intent for initial routing and let applyCollaborationPlanToTask()
  // async-patch the plan into task metadata before the worker processes it.
  const collaborationMode = collaborationConfig.enabled && (intent === "collaboration");
  const lightCollaborationMode = collaborationConfig.enabled && (intent === "light_collaboration") && !collaborationMode;
  const roleId = collaborationMode ? resolveCollaborationEntryRole(inboundText) : undefined;
  const metadata: Record<string, unknown> = requesterName ? { requesterName } : {};
  if (input.attachments && input.attachments.length > 0) {
    metadata.attachments = input.attachments;
  }
  if (collaborationMode) {
    metadata.collaborationMode = true;
    metadata.collaborationEntryRole = roleId;
  }
  if (lightCollaborationMode) {
    metadata.lightCollaboration = true;
  }

  const task = createTask({
    sessionId,
    instruction: taskText,
    source: input.source,
    requestedBy: input.requestedBy,
    chatId: input.chatId,
    roleId,
    metadata
  });
  // Async-patch collaboration plan into task metadata once the LLM analysis completes.
  // The worker reads this lazily before creating review tasks, so it will see the final plan.
  applyCollaborationPlanToTask(task.id);

  updateSessionProjectMemoryFromInbound({
    sessionId,
    requesterName,
    requestedBy: input.requestedBy,
    source: input.source,
    inboundText,
    taskText,
    stage: collaborationMode ? "collaboration_queued" : lightCollaborationMode ? "light_collaboration_queued" : "task_queued",
    nextActions: [
      collaborationMode
        ? "等待团队分工执行并汇总"
        : lightCollaborationMode
        ? "等待主执行者完成并审阅"
        : "等待角色执行并返回结果"
    ]
  });

  const message = collaborationMode
    ? formatTaskQueuedMessage(input.source, task.id, task.roleId) + "（已启动多角色协作模式）"
    : lightCollaborationMode
    ? formatTaskQueuedMessage(input.source, task.id, task.roleId) + "（已启动轻量协作模式：主执行 + 审阅）"
    : formatTaskQueuedMessage(input.source, task.id, task.roleId);

  return finalize({
    type: "task_queued",
    message,
    taskId: task.id
  });
}

function normalizeFeishuInboundText(raw: string): string {
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

async function resolveFeishuSenderName(senderId: string): Promise<string | undefined> {
  if (!shouldResolveFeishuSenderNames()) {
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
    const resolved = (await createFeishuClient().resolveUserDisplayName(normalizedSenderId))?.trim();
    if (!resolved) {
      return undefined;
    }
    // Refresh insertion order so eviction targets genuinely oldest entry
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

async function sendFeishuPrivateFeedback(openId: string, payload: string | Record<string, unknown>): Promise<void> {
  try {
    const client = createFeishuClient();
    if (typeof payload === "string") {
      await client.sendTextToUser(openId, payload);
    } else {
      await client.sendCardToUser(openId, payload);
    }
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

async function handleFeishuCardAction(cardAction: FeishuCardActionEvent): Promise<void> {
  if (!feishuCardActionTokenDeduper.claim(cardAction.token)) {
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

  let decisionResult:
    | ReturnType<typeof store.decideApprovalWorkflowStep>
    | undefined;
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

  const decidedApproval = decisionResult.approval ?? store.getApproval(approval.id) ?? approval;
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
      buildApprovalResultCard({
        summary: `审批单进入下一步（${stillPending.step.roleId}）。`,
        decision: payload.decision,
      })
    );
    return;
  }
  await sendFeishuPrivateFeedback(
    cardAction.operatorOpenId,
    buildApprovalResultCard({
      summary: approval.summary,
      decision: payload.decision,
    })
  );
}

async function sendFeishuInboundAck(
  message: FeishuMessageEvent,
  result: { type?: string; message: string; questions?: string[]; taskId?: string },
  scene?: EmojiScene,
  options?: { forceText?: boolean | undefined; skipReaction?: boolean | undefined }
): Promise<void> {
  const feishuAppId = getRuntimeValue("FEISHU_APP_ID");
  const feishuAppSecret = getRuntimeValue("FEISHU_APP_SECRET");
  if (!feishuAppId || !feishuAppSecret) {
    return;
  }

  const mode = resolveFeishuAckMode(getRuntimeValue("FEISHU_ACK_MODE"));
  const client = createFeishuClient();
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

  const shouldSendText = Boolean(options?.forceText) || mode === "text" || mode === "reaction_plus_text" || !reactionSucceeded;
  if (!shouldSendText) {
    return;
  }

  try {
    if (result.type === "needs_clarification" && result.questions && result.questions.length > 0) {
      await client.sendCardToChat(message.chatId, buildNeedsClarificationCard({ questions: result.questions }));
    } else if (result.type === "task_queued" && result.taskId) {
      const task = store.getTask(result.taskId);
      if (task) {
        const roleProfile = listRoles().find((r) => r.id === task.roleId);
        const roleLabel = roleProfile?.name ?? task.roleId;
        await client.sendCardToChat(
          message.chatId,
          buildTaskQueuedCard({
            title: task.title,
            roleLabel,
            workflowSummary: buildWorkflowStatusSummary(task, { includeGoal: true })
          })
        );
      } else {
        await client.sendTextToChat(message.chatId, sanitizeFeishuAckMessage(result.message));
      }
    } else {
      const userFacingMessage = sanitizeFeishuAckMessage(result.message);
      await client.sendTextToChat(message.chatId, userFacingMessage);
    }
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

function sanitizeFeishuAckMessage(message: string): string {
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

// ============ Route Registration ============

registerAuthRoutes(app, {
  store,
  getAuthCredentials,
  createSession,
  validateToken,
  revokeToken,
  extractBearerToken
});

registerSystemRoutes(app, {
  store,
  buildSystemMetricsSnapshot,
  buildSystemHealthReport,
  buildSystemDailyKpi,
  sanitizeApprovalRecord,
  sanitizeOperatorActionRecord
});

registerSkillsMarketplaceRoutes(app, {
  store,
  createSkillSmokeVerifyTask,
  createSkillRuntimeIntegrationTask,
  formatSkillIntegrationTaskQueuedMessage
});

registerConfigRoutes(app, {
  store,
  env,
  getChannelStatus
});

registerPluginRoutes(app, {
  store
});

registerRoutingTemplateRoutes(app, {
  store
});

registerTaskRoutes(app, {
  store,
  ensureInboundSession,
  selectRoleFromText,
  shorten,
  normalizeAttachments,
  handleInboundMessage,
  buildAutoSplitSpecs,
  splitTaskIntoChildren
});

registerGoalRunRoutes(app, {
  store
});

registerApprovalRoutes(app, {
  store,
  sanitizeApprovalRecord,
  sanitizeOperatorActionRecord,
  ensureApprovalWorkflowForRecord,
  safeEmitApprovalLifecycleEvent,
  applyApprovalDecisionEffects,
  onApprovalWorkflowUpdated: async ({ approvalId, stepId }) => {
    await notifyApprovalStepViaFeishu(approvalId, stepId);
  }
});

registerSelfCheckRoutes(app, {
  latestFile: productSelfcheckLatestFile,
  historyFile: productSelfcheckHistoryFile,
  harnessRootDir: harnessReportDir,
  watcherPidFile: productSelfcheckWatcherPidFile
});

async function processFeishuInboundMessage(message: FeishuMessageEvent) {
  const dedupeToken = `${message.chatId}:${message.messageId}`;
  if (!feishuInboundMessageDeduper.claim(dedupeToken)) {
    store.appendAuditEvent({
      category: "feishu",
      entityType: "chat",
      entityId: message.chatId,
      message: "Ignored duplicate Feishu message",
      payload: {
        messageId: message.messageId,
        senderId: message.senderId
      }
    });
    return {
      type: "duplicate_ignored" as const,
      message: "duplicate_event_ignored"
    };
  }

  store.appendAuditEvent({
    category: "feishu",
    entityType: "chat",
    entityId: message.chatId,
    message: "Received Feishu message",
    payload: {
      messageId: message.messageId,
      senderId: message.senderId
    }
  });

  const normalizedText = normalizeFeishuInboundText(message.text);
  const fastConversation = isSmalltalkMessage(normalizedText) || isDirectConversationTurn(normalizedText);
  let senderName: string | undefined;
  if (!fastConversation) {
    senderName = await resolveFeishuSenderName(message.senderId);
    if (senderName) {
      store.appendAuditEvent({
        category: "feishu",
        entityType: "user",
        entityId: message.senderId,
        message: "Resolved Feishu sender profile",
        payload: {
          senderName
        }
      });
    }
  }

  const result = await handleInboundMessage({
    text: normalizedText,
    taskText: normalizedText,
    source: "feishu",
    requestedBy: message.senderId,
    requesterName: senderName,
    chatId: message.chatId
  });

  await sendFeishuInboundAck(message, result, undefined, {
    forceText: result.type === "smalltalk_replied" || result.type === "config_input_required" || result.type === "needs_clarification"
  });

  return result;
}

function stopFeishuInboundTransport(): void {
  feishuWebSocketMonitor?.stop();
  feishuWebSocketMonitor = undefined;
}

function startFeishuInboundTransport(): void {
  if (resolveFeishuConnectionMode() !== "websocket") {
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
        payload: {
          reason
        }
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
      logger.info("feishu websocket", { line });
    }
  });

  feishuWebSocketMonitor.start();
  store.appendAuditEvent({
    category: "feishu",
    entityType: "monitor",
    entityId: "websocket",
    message: "Feishu websocket monitor started",
    payload: {
      domain: domain || "feishu"
    }
  });
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

app.post("/api/feishu/events", handleFeishuEventsWebhook);
app.post("/feishu/events", handleFeishuEventsWebhook);
app.post("/api/channels/feishu/events", handleFeishuEventsWebhook);

const playgroundRoot = path.resolve(env.workspaceRoot, "playground");
app.use(
  "/playground",
  express.static(playgroundRoot, {
    dotfiles: "deny",
    index: ["index.html"]
  })
);

app.use(express.static(controlCenterRoot));

app.use((_request, response) => {
  response.sendFile(path.join(controlCenterRoot, "index.html"));
});

// Start server with plugin initialization
initializePlugins().then(() => {
  app.listen(env.port, env.host, () => {
    startFeishuInboundTransport();
    const feishuConnectionMode = resolveFeishuConnectionMode();
    logger.info("orchestrator listening", {
      host: env.host,
      port: env.port,
      feishuInboundMode: feishuConnectionMode
    });
    // Warn if running with hardcoded default credentials
    const creds = getAuthCredentials();
    if (creds.length === 1 && creds[0]!.username === "admin" && creds[0]!.password === "vinkoclaw") {
      logger.warn(
        "⚠ Default admin/vinkoclaw credentials are in use. Set AUTH_USERNAME and AUTH_PASSWORD in .env or via runtime settings before exposing this instance."
      );
    }
  });
}).catch((error) => {
  logger.error("Failed to initialize plugins", error);
  // Start server anyway
  app.listen(env.port, env.host, () => {
    startFeishuInboundTransport();
    const feishuConnectionMode = resolveFeishuConnectionMode();
    logger.info("orchestrator listening after init failure", {
      host: env.host,
      port: env.port,
      feishuInboundMode: feishuConnectionMode
    });
  });
});

process.once("SIGINT", () => {
  stopFeishuInboundTransport();
});
process.once("SIGTERM", () => {
  stopFeishuInboundTransport();
});

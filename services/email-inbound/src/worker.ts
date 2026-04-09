import { setTimeout as delay } from "node:timers/promises";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import { createLogger, createRuntimeValueResolver, loadEnv, VinkoStore } from "@vinko/shared";

const env = loadEnv();
const store = VinkoStore.fromEnv(env);
const logger = createLogger("email-inbound");
const runtimeValues = createRuntimeValueResolver({
  env,
  getRuntimeSettings: () => store.getRuntimeSettings(),
  getRuntimeSecrets: () => store.getRuntimeSecrets()
});

const SEEN_MESSAGE_IDS_CONFIG_KEY = "email-inbound-seen-message-ids";
const INBOUND_LEDGER_CONFIG_KEY = "email-inbound-ledger";
const MAX_SEEN_MESSAGE_IDS = 4000;
const MAX_INBOUND_LEDGER_RECORDS = 2000;
const FAIL_RETRY_COOLDOWN_MS = 2 * 60 * 1000;
const FETCH_LOOKBACK_COUNT = 80;

type NormalizedMessage = {
  dedupeId: string;
  messageId: string;
  sender: string;
  subject: string;
  command: string;
  sentAt: string;
};

type InboundValueLevel = "high" | "normal" | "low";

type InboundLedgerRecord = {
  dedupeId: string;
  messageId: string;
  sender: string;
  subject: string;
  commandPreview: string;
  sentAt: string;
  receivedAt: string;
  trustedSender: boolean;
  prefixed: boolean;
  valueLevel: InboundValueLevel;
  valueReason: string;
  action:
    | "command_dispatched"
    | "command_blocked_untrusted"
    | "receipt_auto_replied"
    | "triage_task_created"
    | "logged_only"
    | "rate_limited"
    | "empty_command_ignored"
    | "dispatch_failed"
    | "reply_failed"
    | "triage_failed";
  status: "ok" | "failed";
  taskId?: string;
  details?: string;
};

interface InboundConfig {
  enabled: boolean;
  missing: string[];
  orchestratorUrl: string;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  mailbox: string;
  allowedSenders: string[];
  subjectPrefix: string;
  pollIntervalMs: number;
  rateLimitPerMinute: number;
}

const seenMessageIds = new Map<string, string>();
const recentlyFailedMessages = new Map<string, number>();
const senderTimestamps = new Map<string, number[]>();

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function parseInteger(value: string | undefined, fallback: number, minimum = 0): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(minimum, Math.round(parsed));
}

function parseList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeEmailAddress(value: string): string {
  return value.trim().toLowerCase();
}

function resolveConfig(): InboundConfig {
  const enabled = runtimeValues.getBoolean("EMAIL_INBOUND_ENABLED", false);
  const host = runtimeValues.get("EMAIL_INBOUND_IMAP_HOST");
  const port = parseInteger(runtimeValues.get("EMAIL_INBOUND_IMAP_PORT"), 993, 1);
  const secure = runtimeValues.getBoolean("EMAIL_INBOUND_IMAP_SECURE", true);
  const username = runtimeValues.get("EMAIL_INBOUND_USERNAME");
  const password = runtimeValues.get("EMAIL_INBOUND_PASSWORD");
  const mailbox = runtimeValues.get("EMAIL_INBOUND_MAILBOX") || "INBOX";
  const allowedSenders = runtimeValues.getList("EMAIL_INBOUND_ALLOWED_SENDERS").map(normalizeEmailAddress);
  const subjectPrefix = runtimeValues.get("EMAIL_INBOUND_SUBJECT_PREFIX");
  const pollIntervalMs = parseInteger(runtimeValues.get("EMAIL_INBOUND_POLL_INTERVAL_MS"), 15000, 3000);
  const rateLimitPerMinute = parseInteger(runtimeValues.get("EMAIL_INBOUND_RATE_LIMIT_PER_MINUTE"), 20, 1);
  const orchestratorUrl = runtimeValues.get("VINKOCLAW_ORCHESTRATOR_URL") || env.publicUrl;

  const missing: string[] = [];
  if (enabled) {
    if (!host) {
      missing.push("EMAIL_INBOUND_IMAP_HOST");
    }
    if (!username) {
      missing.push("EMAIL_INBOUND_USERNAME");
    }
    if (!password) {
      missing.push("EMAIL_INBOUND_PASSWORD");
    }
  }

  return {
    enabled,
    missing,
    orchestratorUrl,
    host,
    port,
    secure,
    username,
    password,
    mailbox,
    allowedSenders,
    subjectPrefix,
    pollIntervalMs,
    rateLimitPerMinute
  };
}

function comparableConnectionSignature(config: InboundConfig): string {
  return [
    config.host,
    config.port,
    config.secure ? "1" : "0",
    config.username,
    config.password,
    config.mailbox
  ].join("|");
}

function audit(message: string, payload: Record<string, unknown> = {}, entityId = "email-inbound"): void {
  store.appendAuditEvent({
    category: "email-inbound",
    entityType: "email",
    entityId,
    message,
    payload
  });
}

function hydrateSeenMessageIds(): void {
  const raw = store.getConfigEntry<Record<string, string>>(SEEN_MESSAGE_IDS_CONFIG_KEY) ?? {};
  for (const [id, value] of Object.entries(raw)) {
    if (!id.trim()) {
      continue;
    }
    const timestamp = typeof value === "string" && value.trim() ? value.trim() : new Date().toISOString();
    seenMessageIds.set(id, timestamp);
  }
  compactSeenMessageIds();
}

function compactSeenMessageIds(): void {
  if (seenMessageIds.size <= MAX_SEEN_MESSAGE_IDS) {
    return;
  }
  const sorted = Array.from(seenMessageIds.entries()).sort((left, right) =>
    left[1].localeCompare(right[1])
  );
  const removeCount = sorted.length - MAX_SEEN_MESSAGE_IDS;
  for (let index = 0; index < removeCount; index += 1) {
    const entry = sorted[index];
    if (!entry) {
      continue;
    }
    seenMessageIds.delete(entry[0]);
  }
}

function persistSeenMessageIds(): void {
  compactSeenMessageIds();
  store.setConfigEntry(SEEN_MESSAGE_IDS_CONFIG_KEY, Object.fromEntries(seenMessageIds.entries()));
}

function markMessageSeen(dedupeId: string): void {
  seenMessageIds.set(dedupeId, new Date().toISOString());
  persistSeenMessageIds();
  recentlyFailedMessages.delete(dedupeId);
}

function shouldSkipBecauseFailedRecently(dedupeId: string): boolean {
  const lastFailedAt = recentlyFailedMessages.get(dedupeId);
  if (!lastFailedAt) {
    return false;
  }
  return Date.now() - lastFailedAt < FAIL_RETRY_COOLDOWN_MS;
}

function markMessageFailed(dedupeId: string): void {
  recentlyFailedMessages.set(dedupeId, Date.now());
}

function capText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(1, maxLength - 3))}...`;
}

function normalizeCommandPreview(value: string): string {
  return capText(value.replace(/\s+/g, " ").trim(), 240);
}

function classifyInboundValue(subject: string, command: string): { level: InboundValueLevel; reason: string } {
  const text = `${subject}\n${command}`.toLowerCase();
  if (!text.trim()) {
    return { level: "low", reason: "empty" };
  }

  const newsletterKeywords = [
    "view in browser",
    "unsubscribe",
    "newsletter",
    "read online",
    "manage preferences"
  ];
  if (newsletterKeywords.some((keyword) => text.includes(keyword))) {
    return { level: "low", reason: "newsletter" };
  }

  const highKeywords = [
    "紧急",
    "故障",
    "报警",
    "事故",
    "上线",
    "发布",
    "合同",
    "报价",
    "付款",
    "客户",
    "商机",
    "合作",
    "投诉",
    "审批",
    "部署",
    "urgent",
    "incident",
    "outage",
    "contract",
    "invoice",
    "payment",
    "customer",
    "proposal"
  ];
  if (highKeywords.some((keyword) => text.includes(keyword))) {
    return { level: "high", reason: "business_or_incident_keyword" };
  }

  const lowKeywords = [
    "你好",
    "hello",
    "在吗",
    "收到邮件了吗",
    "did you receive",
    "test",
    "测试"
  ];
  if (lowKeywords.some((keyword) => text.includes(keyword))) {
    return { level: "low", reason: "greeting_or_check" };
  }

  if (text.includes("?") || text.includes("？")) {
    return { level: "normal", reason: "question" };
  }

  return { level: "normal", reason: "default" };
}

function looksLikeTaskCommand(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  if (isReceiptCheckIntent(normalized)) {
    return false;
  }
  return /(请|麻烦|设置|配置|启用|禁用|发送|切换|创建|执行|修复|发布|run|set|switch|enable|disable|send|create|deploy|fix)/i.test(
    normalized
  );
}

function upsertInboundLedger(record: InboundLedgerRecord): void {
  const existing =
    store.getConfigEntry<InboundLedgerRecord[]>(INBOUND_LEDGER_CONFIG_KEY)?.filter((entry) => entry?.dedupeId) ?? [];
  const next = [record, ...existing.filter((entry) => entry.dedupeId !== record.dedupeId)].slice(
    0,
    MAX_INBOUND_LEDGER_RECORDS
  );
  store.setConfigEntry(INBOUND_LEDGER_CONFIG_KEY, next);
}

function allowSender(sender: string, allowList: string[]): boolean {
  if (allowList.length === 0) {
    return true;
  }
  return allowList.includes(sender);
}

function allowSubject(subject: string, subjectPrefix: string): boolean {
  if (!subjectPrefix.trim()) {
    return true;
  }
  return subject.toLowerCase().startsWith(subjectPrefix.trim().toLowerCase());
}

function extractCommand(subject: string, text: string, subjectPrefix: string): string {
  const prefix = subjectPrefix.trim();
  if (prefix) {
    if (subject.toLowerCase().startsWith(prefix.toLowerCase())) {
      const subjectCommand = subject.slice(prefix.length).trim();
      if (subjectCommand) {
        return subjectCommand;
      }
    }
  }

  const normalizedText = text.trim();
  if (normalizedText) {
    return normalizedText;
  }

  return "";
}

function checkRateLimit(sender: string, limitPerMinute: number): boolean {
  const nowMs = Date.now();
  const oneMinuteAgo = nowMs - 60 * 1000;
  const timestamps = senderTimestamps.get(sender) ?? [];
  const recent = timestamps.filter((timestamp) => timestamp >= oneMinuteAgo);
  if (recent.length >= limitPerMinute) {
    senderTimestamps.set(sender, recent);
    return false;
  }
  recent.push(nowMs);
  senderTimestamps.set(sender, recent);
  return true;
}

function isReceiptCheckIntent(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    normalized.includes("收到邮件") ||
    normalized.includes("收到郵件") ||
    normalized.includes("收到没") ||
    normalized.includes("收到嗎") ||
    normalized.includes("收到吗") ||
    normalized.includes("did you receive") ||
    normalized.includes("have you received")
  );
}

function formatDateLabel(isoText: string | undefined): string {
  if (!isoText) {
    return "unknown time";
  }
  const date = new Date(isoText);
  if (Number.isNaN(date.getTime())) {
    return isoText;
  }
  return date.toISOString().replace("T", " ").replace("Z", " UTC");
}

async function findPreviousMessageFromSender(
  client: ImapFlow,
  allUids: number[],
  sender: string,
  currentUid: number | undefined
): Promise<{ uid: number; subject: string; date: string } | undefined> {
  if (!Number.isFinite(currentUid)) {
    return undefined;
  }
  const uidValue = Number(currentUid);
  const previousUids = allUids.filter((entry) => entry < uidValue).slice(-200);
  if (previousUids.length === 0) {
    return undefined;
  }

  let result: { uid: number; subject: string; date: string } | undefined;
  for await (const msg of (client as any).fetch(previousUids, {
    uid: true,
    envelope: true,
    internalDate: true
  })) {
    const from = String(msg?.envelope?.from?.[0]?.address || "").trim().toLowerCase();
    if (from !== sender) {
      continue;
    }
    result = {
      uid: Number(msg.uid),
      subject: String(msg?.envelope?.subject || "").trim(),
      date: msg?.internalDate ? new Date(msg.internalDate).toISOString() : ""
    };
  }

  return result;
}

function findLatestApprovalByRequester(requester: string):
  | { id: string; summary: string; status: string; createdAt: string }
  | undefined {
  const row = store.db
    .prepare(
      `
        SELECT id, summary, status, created_at
        FROM approvals
        WHERE requested_by = ?
        ORDER BY created_at DESC
        LIMIT 1
      `
    )
    .get(requester) as
    | { id?: unknown; summary?: unknown; status?: unknown; created_at?: unknown }
    | undefined;
  if (!row || typeof row.id !== "string") {
    return undefined;
  }
  return {
    id: row.id,
    summary: typeof row.summary === "string" ? row.summary : "",
    status: typeof row.status === "string" ? row.status : "",
    createdAt: typeof row.created_at === "string" ? row.created_at : ""
  };
}

async function sendAutoReply(to: string, subject: string, body: string): Promise<void> {
  const smtpUrl = runtimeValues.get("SMTP_URL");
  const from = runtimeValues.get("EMAIL_DEFAULT_FROM");
  if (!smtpUrl || !from) {
    throw new Error("SMTP_URL or EMAIL_DEFAULT_FROM is not configured");
  }

  const transporter = nodemailer.createTransport(smtpUrl);
  await transporter.sendMail({
    from,
    to,
    subject,
    text: body
  });
}

async function postToOrchestrator(config: InboundConfig, message: NormalizedMessage): Promise<unknown> {
  const endpoint = `${config.orchestratorUrl.replace(/\/+$/, "")}/api/messages`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      source: "email",
      text: message.command,
      requestedBy: message.sender,
      chatId: message.messageId
    })
  });

  const parsedBody = await parseResponseBody(response);
  if (!response.ok) {
    throw new Error(
      `orchestrator_error status=${response.status} body=${typeof parsedBody === "string" ? parsedBody : JSON.stringify(parsedBody)}`
    );
  }
  return parsedBody;
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const rawBody = await response.text();
  let parsedBody: unknown = rawBody;
  if (rawBody) {
    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      parsedBody = rawBody;
    }
  }
  return parsedBody;
}

function buildOperationsTriageInstruction(input: {
  message: NormalizedMessage;
  valueLevel: InboundValueLevel;
  valueReason: string;
  trustedSender: boolean;
  prefixed: boolean;
}): string {
  const lines = [
    "请作为运营助手处理一封新收件邮件。",
    `价值级别：${input.valueLevel}（${input.valueReason}）`,
    `发件人：${input.message.sender}`,
    `主题：${input.message.subject || "(无主题)"}`,
    `发送时间：${formatDateLabel(input.message.sentAt)}`,
    `命令前缀命中：${input.prefixed ? "是" : "否"}`,
    `命令授权发件人：${input.trustedSender ? "是" : "否"}`,
    "邮件内容摘要：",
    normalizeCommandPreview(input.message.command || input.message.subject || "(空内容)"),
    "请给出：1) 是否需要升级汇报；2) 下一步动作建议；3) 如需回复请给出回复草案。"
  ];
  return lines.join("\n");
}

async function postOperationsTriageTask(
  config: InboundConfig,
  input: {
    message: NormalizedMessage;
    valueLevel: InboundValueLevel;
    valueReason: string;
    trustedSender: boolean;
    prefixed: boolean;
  }
): Promise<{ taskId?: string; raw: unknown }> {
  const endpoint = `${config.orchestratorUrl.replace(/\/+$/, "")}/api/tasks`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      source: "email",
      roleId: "operations",
      title: `[Inbound:${input.valueLevel}] ${capText(input.message.subject || "No subject", 72)}`,
      instruction: buildOperationsTriageInstruction(input),
      requestedBy: input.message.sender,
      chatId: input.message.messageId,
      metadata: {
        inboundEmail: {
          dedupeId: input.message.dedupeId,
          sender: input.message.sender,
          subject: input.message.subject,
          sentAt: input.message.sentAt,
          valueLevel: input.valueLevel,
          valueReason: input.valueReason,
          trustedSender: input.trustedSender,
          prefixed: input.prefixed
        }
      }
    })
  });

  const parsedBody = await parseResponseBody(response);
  if (!response.ok) {
    throw new Error(
      `orchestrator_task_error status=${response.status} body=${typeof parsedBody === "string" ? parsedBody : JSON.stringify(parsedBody)}`
    );
  }

  const taskId =
    parsedBody && typeof parsedBody === "object" && "id" in parsedBody && typeof parsedBody.id === "string"
      ? parsedBody.id
      : undefined;
  return taskId
    ? {
        taskId,
        raw: parsedBody
      }
    : {
        raw: parsedBody
      };
}

function sanitizeMessageId(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }
  return value.trim().replace(/^<|>$/g, "") || fallback;
}

async function normalizeIncomingMessage(
  rawMessage: any,
  fallbackDedupeId: string,
  subjectPrefix: string
): Promise<NormalizedMessage | null> {
  const source = rawMessage?.source;
  if (!source) {
    return null;
  }

  const parsed = await simpleParser(source as Buffer);
  const senderRaw = parsed.from?.value?.[0]?.address;
  const sender = senderRaw ? normalizeEmailAddress(senderRaw) : "";
  const subject = String(parsed.subject ?? rawMessage?.envelope?.subject ?? "").trim();
  const textBody = String(parsed.text ?? "").trim();
  const messageId = sanitizeMessageId(parsed.messageId, fallbackDedupeId);
  const command = extractCommand(subject, textBody, subjectPrefix);
  const sentAt = parsed.date ? parsed.date.toISOString() : new Date().toISOString();

  if (!sender) {
    return null;
  }

  return {
    dedupeId: messageId || fallbackDedupeId,
    messageId: messageId || fallbackDedupeId,
    sender,
    subject,
    command,
    sentAt
  };
}

async function markRemoteMessageAsSeen(client: ImapFlow, messageUid: number | undefined): Promise<void> {
  if (!Number.isFinite(messageUid)) {
    return;
  }
  try {
    await (client as any).messageFlagsAdd(messageUid, ["\\Seen"], { uid: true });
  } catch {
    // Ignore flag update errors; message dedupe still protects re-processing.
  }
}

async function processMailbox(client: ImapFlow, config: InboundConfig): Promise<void> {
  const lock = await (client as any).getMailboxLock(config.mailbox);
  try {
    const allUids = ((await (client as any).search({ all: true })) ?? []) as number[];
    if (allUids.length === 0) {
      return;
    }
    const candidateUids = allUids.slice(-FETCH_LOOKBACK_COUNT);

    for await (const rawMessage of (client as any).fetch(candidateUids, {
      uid: true,
      envelope: true,
      source: true
    })) {
      const uid = Number(rawMessage?.uid);
      const fallbackDedupeId = Number.isFinite(uid)
        ? `${config.mailbox}:${uid}`
        : `unknown:${Date.now().toString(36)}`;

      let normalizedMessage: NormalizedMessage | null = null;
      try {
        normalizedMessage = await normalizeIncomingMessage(rawMessage, fallbackDedupeId, config.subjectPrefix);
      } catch (error) {
        audit("Failed to parse inbound email", {
          dedupeId: fallbackDedupeId,
          error: error instanceof Error ? error.message : String(error)
        });
        await markRemoteMessageAsSeen(client, uid);
        markMessageSeen(fallbackDedupeId);
        continue;
      }

      if (!normalizedMessage) {
        audit("Ignored inbound email without valid sender/body", {
          dedupeId: fallbackDedupeId
        });
        await markRemoteMessageAsSeen(client, uid);
        markMessageSeen(fallbackDedupeId);
        continue;
      }

      if (seenMessageIds.has(normalizedMessage.dedupeId)) {
        await markRemoteMessageAsSeen(client, uid);
        continue;
      }
      const trustedSender = allowSender(normalizedMessage.sender, config.allowedSenders);
      const prefixed = allowSubject(normalizedMessage.subject, config.subjectPrefix);
      const value = classifyInboundValue(normalizedMessage.subject, normalizedMessage.command);

      const finalizeSuccess = async (
        action: InboundLedgerRecord["action"],
        details?: string,
        taskId?: string
      ): Promise<void> => {
        const record: InboundLedgerRecord = {
          dedupeId: normalizedMessage.dedupeId,
          messageId: normalizedMessage.messageId,
          sender: normalizedMessage.sender,
          subject: normalizedMessage.subject,
          commandPreview: normalizeCommandPreview(normalizedMessage.command),
          sentAt: normalizedMessage.sentAt,
          receivedAt: new Date().toISOString(),
          trustedSender,
          prefixed,
          valueLevel: value.level,
          valueReason: value.reason,
          action,
          status: "ok"
        };
        if (taskId) {
          record.taskId = taskId;
        }
        if (details) {
          record.details = details;
        }
        upsertInboundLedger(record);
        await markRemoteMessageAsSeen(client, uid);
        markMessageSeen(normalizedMessage.dedupeId);
      };

      const finalizeFailure = (action: InboundLedgerRecord["action"], error: unknown): void => {
        const errorText = error instanceof Error ? error.message : String(error);
        upsertInboundLedger({
          dedupeId: normalizedMessage.dedupeId,
          messageId: normalizedMessage.messageId,
          sender: normalizedMessage.sender,
          subject: normalizedMessage.subject,
          commandPreview: normalizeCommandPreview(normalizedMessage.command),
          sentAt: normalizedMessage.sentAt,
          receivedAt: new Date().toISOString(),
          trustedSender,
          prefixed,
          valueLevel: value.level,
          valueReason: value.reason,
          action,
          status: "failed",
          details: errorText
        });
        markMessageFailed(normalizedMessage.dedupeId);
      };

      if (shouldSkipBecauseFailedRecently(normalizedMessage.dedupeId)) {
        continue;
      }

      if (isReceiptCheckIntent(`${normalizedMessage.subject}\n${normalizedMessage.command}`)) {
        try {
          const previous = await findPreviousMessageFromSender(client, allUids, normalizedMessage.sender, uid);
          const latestApproval = findLatestApprovalByRequester(normalizedMessage.sender);
          const replySubject = normalizedMessage.subject
            ? `Re: ${normalizedMessage.subject}`
            : "Re: mail receipt confirmation";

          const lines: string[] = [
            "已收到你的邮件。",
            `本封邮件主题：${normalizedMessage.subject || "(无主题)"}`,
            `接收时间：${formatDateLabel(normalizedMessage.sentAt)}`
          ];
          if (previous) {
            lines.push(
              `你上一封邮件（UID ${previous.uid}）主题：${previous.subject || "(无主题)"}，时间：${formatDateLabel(previous.date)}`
            );
          } else {
            lines.push("未找到更早一封来自你地址的邮件。");
          }
          if (latestApproval) {
            lines.push(
              `系统最近一条相关审批：${latestApproval.summary}（状态：${latestApproval.status}，ID：${latestApproval.id}）`
            );
          }
          lines.push("如需下发执行命令，建议主题使用前缀 [VinkoTask]。");
          await sendAutoReply(normalizedMessage.sender, replySubject, lines.join("\n"));

          audit("Auto-replied receipt-check email", {
            dedupeId: normalizedMessage.dedupeId,
            sender: normalizedMessage.sender,
            previousUid: previous?.uid ?? null,
            latestApprovalId: latestApproval?.id ?? null
          });
          await finalizeSuccess("receipt_auto_replied");
        } catch (error) {
          audit("Failed to auto-reply receipt-check email", {
            dedupeId: normalizedMessage.dedupeId,
            sender: normalizedMessage.sender,
            error: error instanceof Error ? error.message : String(error)
          });
          finalizeFailure("reply_failed", error);
        }
        continue;
      }

      const command = extractCommand(normalizedMessage.subject, normalizedMessage.command, config.subjectPrefix);
      const commandCandidate = command || normalizedMessage.subject.trim();
      const trustedNaturalCommand = trustedSender && !prefixed && looksLikeTaskCommand(commandCandidate);
      const shouldDispatchCommand = prefixed || trustedNaturalCommand;

      if (shouldDispatchCommand) {
        if (!trustedSender) {
          try {
            const triage = await postOperationsTriageTask(config, {
              message: normalizedMessage,
              valueLevel: "high",
              valueReason: "untrusted_prefixed_command",
              trustedSender,
              prefixed
            });
            audit("Blocked untrusted command email and routed to operations triage", {
              dedupeId: normalizedMessage.dedupeId,
              sender: normalizedMessage.sender,
              taskId: triage.taskId ?? null
            });
            await finalizeSuccess("command_blocked_untrusted", "blocked_and_triaged", triage.taskId);
          } catch (error) {
            audit("Failed to triage blocked untrusted command email", {
              dedupeId: normalizedMessage.dedupeId,
              sender: normalizedMessage.sender,
              error: error instanceof Error ? error.message : String(error)
            });
            finalizeFailure("triage_failed", error);
          }
          continue;
        }

        if (!commandCandidate.trim()) {
          audit("Ignored inbound command email with empty command", {
            dedupeId: normalizedMessage.dedupeId,
            sender: normalizedMessage.sender
          });
          await finalizeSuccess("empty_command_ignored");
          continue;
        }

        if (!checkRateLimit(normalizedMessage.sender, config.rateLimitPerMinute)) {
          audit("Ignored inbound email due to sender rate limit", {
            dedupeId: normalizedMessage.dedupeId,
            sender: normalizedMessage.sender,
            rateLimitPerMinute: config.rateLimitPerMinute
          });
          await finalizeSuccess("rate_limited");
          continue;
        }

        try {
          const response = await postToOrchestrator(config, {
            ...normalizedMessage,
            command: commandCandidate
          });
          const responseType =
            response && typeof response === "object" && "type" in response
              ? String((response as { type?: unknown }).type ?? "ok")
              : "ok";
          audit("Accepted inbound email command", {
            dedupeId: normalizedMessage.dedupeId,
            sender: normalizedMessage.sender,
            subject: normalizedMessage.subject,
            sentAt: normalizedMessage.sentAt,
            result: responseType
          });
          await finalizeSuccess("command_dispatched", responseType);
        } catch (error) {
          audit("Failed to dispatch inbound email command", {
            dedupeId: normalizedMessage.dedupeId,
            sender: normalizedMessage.sender,
            error: error instanceof Error ? error.message : String(error)
          });
          finalizeFailure("dispatch_failed", error);
        }
        continue;
      }

      const shouldCreateTriageTask = value.level === "high" || (value.level === "normal" && trustedSender);
      if (shouldCreateTriageTask) {
        try {
          const triage = await postOperationsTriageTask(config, {
            message: normalizedMessage,
            valueLevel: value.level,
            valueReason: value.reason,
            trustedSender,
            prefixed
          });
          audit("Routed inbound email to operations triage", {
            dedupeId: normalizedMessage.dedupeId,
            sender: normalizedMessage.sender,
            valueLevel: value.level,
            taskId: triage.taskId ?? null
          });
          await finalizeSuccess("triage_task_created", value.reason, triage.taskId);
        } catch (error) {
          audit("Failed to create operations triage task for inbound email", {
            dedupeId: normalizedMessage.dedupeId,
            sender: normalizedMessage.sender,
            error: error instanceof Error ? error.message : String(error)
          });
          finalizeFailure("triage_failed", error);
        }
        continue;
      }

      audit("Logged inbound email without triage escalation", {
        dedupeId: normalizedMessage.dedupeId,
        sender: normalizedMessage.sender,
        valueLevel: value.level
      });
      await finalizeSuccess("logged_only", value.reason);
    }
  } finally {
    lock.release();
  }
}

async function runConnectedSession(initialConfig: InboundConfig): Promise<void> {
  const client = new ImapFlow({
    host: initialConfig.host,
    port: initialConfig.port,
    secure: initialConfig.secure,
    auth: {
      user: initialConfig.username,
      pass: initialConfig.password
    },
    logger: false
  });

  await client.connect();
  await (client as any).mailboxOpen(initialConfig.mailbox);
  audit("Connected to inbound email mailbox", {
    host: initialConfig.host,
    mailbox: initialConfig.mailbox
  });

  try {
    const initialSignature = comparableConnectionSignature(initialConfig);
    while (true) {
      const config = resolveConfig();
      if (!config.enabled || config.missing.length > 0) {
        audit("Inbound email service paused due to config change", {
          enabled: config.enabled,
          missing: config.missing
        });
        return;
      }

      if (comparableConnectionSignature(config) !== initialSignature) {
        audit("Inbound email reconnect required due to connection config change", {
          mailbox: config.mailbox
        });
        return;
      }

      await processMailbox(client, config);
      await delay(config.pollIntervalMs);
    }
  } finally {
    try {
      await client.logout();
    } catch {
      // Ignore logout errors.
    }
  }
}

async function run(): Promise<void> {
  hydrateSeenMessageIds();
  audit("Email inbound worker started", {
    host: env.host,
    port: env.port
  });

  let lastConfigState = "";
  while (true) {
    const config = resolveConfig();
    if (!config.enabled) {
      const state = "disabled";
      if (lastConfigState !== state) {
        audit("Email inbound worker is disabled");
      }
      lastConfigState = state;
      await delay(5000);
      continue;
    }

    if (config.missing.length > 0) {
      const state = `missing:${config.missing.join(",")}`;
      if (lastConfigState !== state) {
        audit("Email inbound worker waiting for required config", {
          missing: config.missing
        });
      }
      lastConfigState = state;
      await delay(8000);
      continue;
    }

    lastConfigState = "ready";
    try {
      await runConnectedSession(config);
    } catch (error) {
      audit("Inbound email session failed", {
        error: error instanceof Error ? error.message : String(error)
      });
      await delay(5000);
    }
  }
}

run().catch((error) => {
  audit("Email inbound worker crashed", {
    error: error instanceof Error ? error.message : String(error)
  });
  logger.error("email inbound worker crashed", error);
  process.exitCode = 1;
});

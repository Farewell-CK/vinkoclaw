import crypto from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import * as Lark from "@larksuiteoapi/node-sdk";
import { loadEnv } from "@vinko/shared";

export type FeishuConnectionMode = "webhook" | "websocket";

export interface FeishuMessageEvent {
  messageId: string;
  chatId: string;
  senderId: string;
  text: string;
  raw: unknown;
}

export interface FeishuCardActionEvent {
  token: string;
  operatorOpenId: string;
  operatorUserId?: string;
  operatorUnionId?: string;
  contextOpenId?: string;
  contextUserId?: string;
  contextChatId?: string;
  actionTag: string;
  actionValue: Record<string, unknown>;
  raw: unknown;
}

export type ParsedFeishuEvent =
  | {
      kind: "challenge";
      challenge: string;
    }
  | {
      kind: "message";
      message: FeishuMessageEvent;
    }
  | {
      kind: "card_action";
      cardAction: FeishuCardActionEvent;
    }
  | {
      kind: "ignored";
      reason: string;
    };

type ParseFeishuEventInput = {
  verificationToken?: string;
  encryptKey?: string;
  rawBody?: string;
  headers?: Record<string, string | string[] | undefined>;
};

type FeishuWebSocketMonitorOptions = {
  appId: string;
  appSecret: string;
  domain?: string;
  verificationToken?: string;
  encryptKey?: string;
  loggerLevel?: Lark.LoggerLevel;
  onMessage: (message: FeishuMessageEvent) => void | Promise<void>;
  onCardAction?: (cardAction: FeishuCardActionEvent) => void | Promise<void>;
  onIgnored?: (reason: string) => void;
  onError?: (error: unknown) => void;
  onLog?: (message: string) => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseJsonObject(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function normalizeHeaderValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? "";
  }
  return value ?? "";
}

function isSignatureValid(input: {
  encryptKey: string;
  rawBody: string;
  headers: Record<string, string | string[] | undefined>;
}): boolean {
  const timestamp = normalizeHeaderValue(input.headers["x-lark-request-timestamp"]);
  const nonce = normalizeHeaderValue(input.headers["x-lark-request-nonce"]);
  const signature = normalizeHeaderValue(input.headers["x-lark-signature"]);
  if (!timestamp || !nonce || !signature) {
    return false;
  }

  const computed = crypto
    .createHash("sha256")
    .update(`${timestamp}${nonce}${input.encryptKey}${input.rawBody}`)
    .digest("hex");
  const left = Buffer.from(computed, "utf8");
  const right = Buffer.from(signature, "utf8");
  if (left.length !== right.length) {
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

function decryptFeishuPayload(encryptKey: string, encrypted: string): Record<string, unknown> | undefined {
  try {
    const buffer = Buffer.from(encrypted, "base64");
    if (buffer.length <= 16) {
      return undefined;
    }
    const iv = buffer.subarray(0, 16);
    const ciphertext = buffer.subarray(16);
    const key = crypto.createHash("sha256").update(encryptKey).digest();
    const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    return parseJsonObject(plaintext);
  } catch {
    return undefined;
  }
}

function flattenPostContent(candidate: unknown): string {
  if (!candidate || typeof candidate !== "object") {
    return "";
  }

  const payload = candidate as Record<string, unknown>;
  const textNodes: string[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (!value || typeof value !== "object") {
      return;
    }
    const node = value as Record<string, unknown>;
    if (typeof node.text === "string" && node.text.trim()) {
      textNodes.push(node.text.trim());
    }
    for (const next of Object.values(node)) {
      walk(next);
    }
  };
  walk(payload);
  return textNodes.join(" ").trim();
}

function tryParseMessageContent(messageType: string, content: unknown): string {
  if (typeof content !== "string") {
    return "";
  }

  const parsed = parseJsonObject(content);
  if (!parsed) {
    return content;
  }

  if (messageType === "text") {
    const text = parsed.text;
    return typeof text === "string" ? text : content;
  }

  if (messageType === "post") {
    const post = parsed.post;
    const flattened = flattenPostContent(post ?? parsed);
    return flattened || "[Rich text message]";
  }

  return content;
}

function resolveLarkDomain(domain: string | undefined): Lark.Domain | string {
  const normalized = (domain ?? "feishu").trim().toLowerCase();
  if (normalized === "lark") {
    return Lark.Domain.Lark;
  }
  if (normalized === "feishu" || normalized === "") {
    return Lark.Domain.Feishu;
  }
  if (normalized.startsWith("http://") || normalized.startsWith("https://")) {
    return normalized.replace(/\/+$/, "");
  }
  return Lark.Domain.Feishu;
}

export function parseFeishuCardActionPayload(
  eventPayload: unknown,
  raw: unknown = eventPayload
): FeishuCardActionEvent | undefined {
  if (!isRecord(eventPayload)) {
    return undefined;
  }

  const operator = isRecord(eventPayload.operator) ? eventPayload.operator : undefined;
  const action = isRecord(eventPayload.action) ? eventPayload.action : undefined;
  const context = isRecord(eventPayload.context) ? eventPayload.context : undefined;

  if (!operator || !action || !context) {
    return undefined;
  }

  const token = typeof eventPayload.token === "string" ? eventPayload.token.trim() : "";
  const operatorOpenId = typeof operator.open_id === "string" ? operator.open_id.trim() : "";
  const actionTag = typeof action.tag === "string" ? action.tag.trim() : "";
  const actionValue = isRecord(action.value) ? action.value : undefined;
  if (!token || !operatorOpenId || !actionTag || !actionValue) {
    return undefined;
  }

  const operatorUserId = typeof operator.user_id === "string" ? operator.user_id.trim() : "";
  const operatorUnionId = typeof operator.union_id === "string" ? operator.union_id.trim() : "";
  const contextOpenId = typeof context.open_id === "string" ? context.open_id.trim() : "";
  const contextUserId = typeof context.user_id === "string" ? context.user_id.trim() : "";
  const contextChatId = typeof context.chat_id === "string" ? context.chat_id.trim() : "";

  return {
    token,
    operatorOpenId,
    ...(operatorUserId ? { operatorUserId } : {}),
    ...(operatorUnionId ? { operatorUnionId } : {}),
    ...(contextOpenId ? { contextOpenId } : {}),
    ...(contextUserId ? { contextUserId } : {}),
    ...(contextChatId ? { contextChatId } : {}),
    actionTag,
    actionValue,
    raw
  };
}

function parseMessagePayload(payload: {
  event?: {
    message?: { message_id?: string; chat_id?: string; content?: unknown; message_type?: string };
    sender?: { sender_id?: { open_id?: string; union_id?: string; user_id?: string } };
  };
}): FeishuMessageEvent | undefined {
  const message = payload.event?.message;
  const senderId =
    payload.event?.sender?.sender_id?.open_id ??
    payload.event?.sender?.sender_id?.union_id ??
    payload.event?.sender?.sender_id?.user_id;

  const messageType = typeof message?.message_type === "string" ? message.message_type.toLowerCase() : "";
  if ((messageType !== "text" && messageType !== "post") || !message?.chat_id || !message?.message_id || !senderId) {
    return undefined;
  }

  return {
    messageId: message.message_id,
    chatId: message.chat_id,
    senderId,
    text: tryParseMessageContent(messageType, message.content),
    raw: payload
  };
}

export function parseFeishuEvent(body: unknown, input: ParseFeishuEventInput = {}): ParsedFeishuEvent {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {
      kind: "ignored",
      reason: "body is not an object"
    };
  }

  if (input.encryptKey && input.rawBody && input.headers) {
    const valid = isSignatureValid({
      encryptKey: input.encryptKey,
      rawBody: input.rawBody,
      headers: input.headers
    });
    if (!valid) {
      return {
        kind: "ignored",
        reason: "invalid signature"
      };
    }
  }

  const bodyPayload = body as {
    type?: string;
    token?: string;
    challenge?: string;
    encrypt?: string;
    header?: { event_type?: string; token?: string };
    event?: {
      message?: { message_id?: string; chat_id?: string; content?: unknown; message_type?: string };
      sender?: { sender_id?: { open_id?: string; union_id?: string; user_id?: string } };
      operator?: unknown;
      action?: unknown;
      context?: unknown;
      token?: unknown;
    };
  };
  let payload = bodyPayload;
  if (typeof bodyPayload.encrypt === "string" && bodyPayload.encrypt.trim()) {
    const encryptKey = input.encryptKey?.trim();
    if (!encryptKey) {
      return {
        kind: "ignored",
        reason: "encrypted payload but FEISHU_ENCRYPT_KEY is not configured"
      };
    }
    const decrypted = decryptFeishuPayload(encryptKey, bodyPayload.encrypt.trim());
    if (!decrypted) {
      return {
        kind: "ignored",
        reason: "failed to decrypt payload"
      };
    }
    payload = decrypted as typeof payload;
  }

  const token = payload.token ?? payload.header?.token;
  if (input.verificationToken && token && input.verificationToken !== token) {
    return {
      kind: "ignored",
      reason: "verification token mismatch"
    };
  }

  if (payload.type === "url_verification" && typeof payload.challenge === "string") {
    return {
      kind: "challenge",
      challenge: payload.challenge
    };
  }

  const eventType =
    (typeof payload.header?.event_type === "string" ? payload.header.event_type : "") ||
    (typeof payload.type === "string" ? payload.type : "");
  if (eventType === "card.action.trigger") {
    const parsed = parseFeishuCardActionPayload(payload.event ?? payload, payload);
    if (!parsed) {
      return {
        kind: "ignored",
        reason: "malformed card action payload"
      };
    }
    return {
      kind: "card_action",
      cardAction: parsed
    };
  }

  const message = parseMessagePayload(payload);
  if (!message) {
    return {
      kind: "ignored",
      reason: "event is not supported"
    };
  }

  return {
    kind: "message",
    message
  };
}

export function buildFeishuTextBody(text: string): { msg_type: "text"; content: string } {
  return {
    msg_type: "text",
    content: JSON.stringify({ text })
  };
}

export function buildFeishuCardBody(card: Record<string, unknown>): {
  msg_type: "interactive";
  content: string;
} {
  return {
    msg_type: "interactive",
    content: JSON.stringify(card)
  };
}

export class FeishuWebSocketMonitor {
  private readonly options: FeishuWebSocketMonitorOptions;
  private wsClient: Lark.WSClient | undefined;
  private running = false;

  constructor(options: FeishuWebSocketMonitorOptions) {
    this.options = options;
  }

  start(): void {
    if (this.running) {
      return;
    }

    const appId = this.options.appId.trim();
    const appSecret = this.options.appSecret.trim();
    if (!appId || !appSecret) {
      throw new Error("Feishu websocket requires appId and appSecret");
    }

    const dispatcherOptions: { verificationToken?: string; encryptKey?: string } = {};
    if (this.options.verificationToken) {
      dispatcherOptions.verificationToken = this.options.verificationToken;
    }
    if (this.options.encryptKey) {
      dispatcherOptions.encryptKey = this.options.encryptKey;
    }
    const eventDispatcher = new Lark.EventDispatcher(dispatcherOptions);

    eventDispatcher.register({
      "im.message.receive_v1": async (data: unknown) => {
        try {
          const parseInput: ParseFeishuEventInput = {};
          if (this.options.verificationToken) {
            parseInput.verificationToken = this.options.verificationToken;
          }
          if (this.options.encryptKey) {
            parseInput.encryptKey = this.options.encryptKey;
          }
          const wrapped = parseFeishuEvent({ event: data }, parseInput);
          const parsed = wrapped.kind === "message" ? wrapped : parseFeishuEvent(data, parseInput);
          if (parsed.kind === "message") {
            await this.options.onMessage(parsed.message);
            return;
          }
          if (parsed.kind === "ignored") {
            this.options.onIgnored?.(parsed.reason);
            return;
          }
        } catch (error) {
          this.options.onError?.(error);
        }
      },
      "card.action.trigger": async (data: unknown) => {
        if (!this.options.onCardAction) {
          return;
        }
        try {
          const parsed = parseFeishuCardActionPayload(data, { event: data, header: { event_type: "card.action.trigger" } });
          if (!parsed) {
            this.options.onIgnored?.("malformed card action payload");
            return;
          }
          await this.options.onCardAction(parsed);
        } catch (error) {
          this.options.onError?.(error);
        }
      }
    });

    this.wsClient = new Lark.WSClient({
      appId,
      appSecret,
      domain: resolveLarkDomain(this.options.domain),
      loggerLevel: this.options.loggerLevel ?? Lark.LoggerLevel.info
    });
    this.wsClient.start({ eventDispatcher });
    this.running = true;
    this.options.onLog?.("Feishu websocket monitor started");
  }

  stop(): void {
    if (!this.running) {
      return;
    }
    try {
      this.wsClient?.close();
    } finally {
      this.running = false;
      this.wsClient = undefined;
      this.options.onLog?.("Feishu websocket monitor stopped");
    }
  }
}

export class FeishuClient {
  private readonly env = loadEnv();
  private readonly options: {
    appId?: string;
    appSecret?: string;
    domain?: string;
  };

  private tenantAccessToken?: string;

  private tenantAccessTokenExpiresAt = 0;

  constructor(options: { appId?: string; appSecret?: string; domain?: string } = {}) {
    this.options = options;
  }

  private resolveOpenBaseUrl(): string {
    const rawDomain = (this.options.domain ?? this.env.feishuDomain ?? "feishu").trim().toLowerCase();
    if (rawDomain === "lark") {
      return "https://open.larksuite.com";
    }
    if (rawDomain === "feishu" || rawDomain === "") {
      return "https://open.feishu.cn";
    }
    if (rawDomain.startsWith("http://") || rawDomain.startsWith("https://")) {
      return rawDomain.replace(/\/+$/, "");
    }
    return "https://open.feishu.cn";
  }

  private async getTenantAccessToken(): Promise<string> {
    if (
      this.tenantAccessToken &&
      this.tenantAccessTokenExpiresAt > Date.now() + 15_000
    ) {
      return this.tenantAccessToken;
    }

    const appId = this.options.appId ?? this.env.feishuAppId;
    const appSecret = this.options.appSecret ?? this.env.feishuAppSecret;
    const openBaseUrl = this.resolveOpenBaseUrl();
    if (!appId || !appSecret) {
      throw new Error("Feishu credentials are not configured");
    }

    const response = await fetch(`${openBaseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        app_id: appId,
        app_secret: appSecret
      }),
      signal: AbortSignal.timeout(20_000)
    });

    if (!response.ok) {
      throw new Error(`Feishu auth failed with ${response.status}`);
    }

    const payload = (await response.json()) as {
      tenant_access_token?: string;
      expire?: number;
      code?: number;
      msg?: string;
    };

    if (!payload.tenant_access_token) {
      throw new Error(`Feishu auth error: ${payload.msg ?? payload.code ?? "unknown"}`);
    }

    this.tenantAccessToken = payload.tenant_access_token;
    this.tenantAccessTokenExpiresAt = Date.now() + (payload.expire ?? 7200) * 1000;
    return payload.tenant_access_token;
  }

  private async sendMessage(input: {
    receiveIdType: "chat_id" | "open_id";
    receiveId: string;
    body: { msg_type: string; content: string };
  }): Promise<void> {
    const token = await this.getTenantAccessToken();
    const openBaseUrl = this.resolveOpenBaseUrl();
    const response = await fetch(
      `${openBaseUrl}/open-apis/im/v1/messages?receive_id_type=${input.receiveIdType}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          receive_id: input.receiveId,
          ...input.body
        }),
        signal: AbortSignal.timeout(20_000)
      }
    );

    const rawPayload = await response.text();
    let payload: { code?: number; msg?: string } = {};
    try {
      payload = rawPayload ? (JSON.parse(rawPayload) as { code?: number; msg?: string }) : {};
    } catch {
      payload = {};
    }

    if (!response.ok) {
      throw new Error(`Feishu send failed with ${response.status}: ${payload.msg ?? rawPayload.slice(0, 300)}`);
    }
    if ((payload.code ?? 0) !== 0) {
      throw new Error(`Feishu send error: ${payload.msg ?? payload.code ?? "unknown"}`);
    }
  }

  async sendTextToChat(chatId: string, text: string): Promise<void> {
    await this.sendMessage({
      receiveIdType: "chat_id",
      receiveId: chatId,
      body: buildFeishuTextBody(text)
    });
  }

  async sendTextToUser(openId: string, text: string): Promise<void> {
    await this.sendMessage({
      receiveIdType: "open_id",
      receiveId: openId,
      body: buildFeishuTextBody(text)
    });
  }

  async sendCardToChat(chatId: string, card: Record<string, unknown>): Promise<void> {
    await this.sendMessage({
      receiveIdType: "chat_id",
      receiveId: chatId,
      body: buildFeishuCardBody(card)
    });
  }

  async sendCardToUser(openId: string, card: Record<string, unknown>): Promise<void> {
    await this.sendMessage({
      receiveIdType: "open_id",
      receiveId: openId,
      body: buildFeishuCardBody(card)
    });
  }

  async addReactionToMessage(messageId: string, emojiType = "THUMBSUP"): Promise<void> {
    const token = await this.getTenantAccessToken();
    const openBaseUrl = this.resolveOpenBaseUrl();
    const response = await fetch(
      `${openBaseUrl}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reactions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          reaction_type: {
            emoji_type: emojiType
          }
        }),
        signal: AbortSignal.timeout(20_000)
      }
    );

    const rawPayload = await response.text();
    let payload: { code?: number; msg?: string } = {};
    try {
      payload = rawPayload ? (JSON.parse(rawPayload) as { code?: number; msg?: string }) : {};
    } catch {
      payload = {};
    }

    if (!response.ok) {
      throw new Error(
        `Feishu reaction failed with ${response.status}: ${payload.msg ?? rawPayload.slice(0, 300)}`
      );
    }
    if ((payload.code ?? 0) !== 0) {
      throw new Error(`Feishu reaction error: ${payload.msg ?? payload.code ?? "unknown"}`);
    }
  }

  private resolveUserIdType(userId: string): "open_id" | "union_id" | "user_id" {
    const normalized = userId.trim();
    if (normalized.startsWith("ou_")) {
      return "open_id";
    }
    if (normalized.startsWith("on_")) {
      return "union_id";
    }
    return "user_id";
  }

  async resolveUserDisplayName(senderId: string): Promise<string | undefined> {
    const normalizedSenderId = senderId.trim();
    if (!normalizedSenderId) {
      return undefined;
    }

    const token = await this.getTenantAccessToken();
    const openBaseUrl = this.resolveOpenBaseUrl();
    const userIdType = this.resolveUserIdType(normalizedSenderId);
    const response = await fetch(
      `${openBaseUrl}/open-apis/contact/v3/users/${encodeURIComponent(normalizedSenderId)}?user_id_type=${userIdType}`,
      {
        method: "GET",
        headers: {
          authorization: `Bearer ${token}`
        },
        signal: AbortSignal.timeout(20_000)
      }
    );

    const rawPayload = (await response.text()) as string;
    let payload: {
      code?: number;
      msg?: string;
      data?: {
        user?: {
          name?: string;
          nickname?: string;
          en_name?: string;
        };
      };
    } = {};

    try {
      payload = rawPayload ? (JSON.parse(rawPayload) as typeof payload) : {};
    } catch {
      payload = {};
    }

    if (!response.ok) {
      throw new Error(
        `Feishu user lookup failed with ${response.status}: ${
          payload.msg ?? rawPayload.slice(0, 300) ?? "unknown error"
        }`
      );
    }

    if ((payload.code ?? 0) !== 0) {
      throw new Error(`Feishu user lookup error: ${payload.msg ?? payload.code ?? "unknown"}`);
    }

    const user = payload.data?.user;
    const displayName = user?.name?.trim() || user?.nickname?.trim() || user?.en_name?.trim();
    return displayName || undefined;
  }

  /**
   * Upload a local file to Feishu and return its file_key.
   * fileType: "pdf" | "doc" | "xls" | "ppt" | "stream" | "zip" (use "stream" for unknown / .md / .txt)
   */
  async uploadFile(filePath: string, fileType = "stream"): Promise<string> {
    const token = await this.getTenantAccessToken();
    const openBaseUrl = this.resolveOpenBaseUrl();

    if (!statSync(filePath, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`uploadFile: file not found or not a file: ${filePath}`);
    }

    const fileName = path.basename(filePath);
    const formData = new FormData();
    formData.append("file_type", fileType);
    formData.append("file_name", fileName);
    const blob = new Blob([readFileSync(filePath)]);
    formData.append("file", blob, fileName);

    const response = await fetch(`${openBaseUrl}/open-apis/im/v1/files`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`
        // Do NOT set content-type — let fetch set it with boundary for multipart/form-data
      },
      body: formData,
      signal: AbortSignal.timeout(60_000)
    });

    const rawPayload = await response.text();
    let payload: { code?: number; msg?: string; data?: { file_key?: string } } = {};
    try {
      payload = rawPayload ? (JSON.parse(rawPayload) as typeof payload) : {};
    } catch {
      payload = {};
    }

    if (!response.ok) {
      throw new Error(`Feishu file upload failed with ${response.status}: ${payload.msg ?? rawPayload.slice(0, 300)}`);
    }
    if ((payload.code ?? 0) !== 0) {
      throw new Error(`Feishu file upload error: ${payload.msg ?? payload.code ?? "unknown"}`);
    }
    const fileKey = payload.data?.file_key;
    if (!fileKey) {
      throw new Error(`Feishu file upload succeeded but no file_key returned`);
    }
    return fileKey;
  }

  async sendFileToChat(chatId: string, fileKey: string): Promise<void> {
    await this.sendMessage({
      receiveIdType: "chat_id",
      receiveId: chatId,
      body: {
        msg_type: "file",
        content: JSON.stringify({ file_key: fileKey })
      }
    });
  }

  async sendFileToUser(openId: string, fileKey: string): Promise<void> {
    await this.sendMessage({
      receiveIdType: "open_id",
      receiveId: openId,
      body: {
        msg_type: "file",
        content: JSON.stringify({ file_key: fileKey })
      }
    });
  }
}

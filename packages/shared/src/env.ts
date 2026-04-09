import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));

function parseEnvFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) {
    return {};
  }

  const parsed: Record<string, string> = {};
  const content = readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/g)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim().replace(/^['"]|['"]$/g, "");
    parsed[key] = value;
  }

  return parsed;
}

export interface RuntimeEnv {
  nodeEnv: string;
  host: string;
  port: number;
  publicUrl: string;
  dataDir: string;
  workspaceRoot: string;
  primaryBackend: "sglang" | "ollama" | "zhipu";
  primaryModel: string;
  sglangBaseUrl: string;
  sglangModel: string;
  ollamaBaseUrl: string;
  ollamaModel: string;
  zhipuBaseUrl: string;
  zhipuModel: string;
  feishuAppId: string;
  feishuAppSecret: string;
  feishuDomain: string;
  feishuConnectionMode: "webhook" | "websocket";
  feishuEncryptKey: string;
  feishuVerificationToken: string;
  feishuDefaultChatId: string;
  feishuOwnerOpenIds: string[];
  smtpUrl: string;
  emailDefaultFrom: string;
  emailInboundEnabled: boolean;
  emailInboundImapHost: string;
  emailInboundImapPort: number;
  emailInboundImapSecure: boolean;
  emailInboundUsername: string;
  emailInboundPassword: string;
  emailInboundMailbox: string;
  emailInboundAllowedSenders: string[];
  emailInboundSubjectPrefix: string;
  emailInboundPollIntervalMs: number;
  emailInboundRateLimitPerMinute: number;
  useClashProxy: boolean;
  clashOnCommand: string;
  clashOffCommand: string;
  condaEnvName: string;
  opencodeModel: string;
  opencodeBaseUrl: string;
  opencodeApiKey: string;
  zhipuApiKey: string;
  openaiApiKey: string;
  anthropicApiKey: string;
  searchProvider: string;
  tavilyApiKey: string;
  serpApiKey: string;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") {
    return fallback;
  }

  return value === "1" || value.toLowerCase() === "true";
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

function parseNumber(value: string | undefined, fallback: number, minimum: number): number {
  if (value === undefined || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(minimum, Math.round(parsed));
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): RuntimeEnv {
  const merged = {
    ...parseEnvFile(path.join(PROJECT_ROOT, "config", ".env")),
    ...parseEnvFile(path.join(PROJECT_ROOT, ".env")),
    ...source
  };
  const dataDir = merged.VINKOCLAW_DATA_DIR ?? path.join(PROJECT_ROOT, ".data");
  mkdirSync(dataDir, { recursive: true });

  return {
    nodeEnv: merged.NODE_ENV ?? "development",
    host: merged.VINKOCLAW_HOST ?? "0.0.0.0",
    port: Number(merged.VINKOCLAW_PORT ?? "8098"),
    publicUrl: merged.VINKOCLAW_PUBLIC_URL ?? "http://127.0.0.1:8098",
    dataDir,
    workspaceRoot: merged.VINKOCLAW_WORKSPACE_ROOT ?? path.dirname(PROJECT_ROOT),
    primaryBackend: (merged.PRIMARY_BACKEND as "sglang" | "ollama" | "zhipu" | undefined) ?? "sglang",
    primaryModel: merged.PRIMARY_MODEL ?? "qwen3.5-coder-14b",
    sglangBaseUrl: merged.SGLANG_BASE_URL ?? "http://127.0.0.1:8000/v1",
    sglangModel: merged.SGLANG_MODEL ?? "qwen3.5-coder-14b",
    ollamaBaseUrl: merged.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434/v1",
    ollamaModel: merged.OLLAMA_MODEL ?? "qwen3.5-instruct-14b",
    zhipuBaseUrl: merged.ZHIPU_BASE_URL ?? "https://open.bigmodel.cn/api/paas/v4",
    zhipuModel: merged.ZHIPU_MODEL ?? "glm-5",
    feishuAppId: merged.FEISHU_APP_ID ?? "",
    feishuAppSecret: merged.FEISHU_APP_SECRET ?? "",
    feishuDomain: merged.FEISHU_DOMAIN ?? "feishu",
    feishuConnectionMode:
      merged.FEISHU_CONNECTION_MODE?.trim().toLowerCase() === "webhook" ? "webhook" : "websocket",
    feishuEncryptKey: merged.FEISHU_ENCRYPT_KEY ?? "",
    feishuVerificationToken: merged.FEISHU_VERIFICATION_TOKEN ?? "",
    feishuDefaultChatId: merged.FEISHU_DEFAULT_CHAT_ID ?? "",
    feishuOwnerOpenIds: parseList(merged.FEISHU_OWNER_OPEN_IDS),
    smtpUrl: merged.SMTP_URL ?? "",
    emailDefaultFrom: merged.EMAIL_DEFAULT_FROM ?? "",
    emailInboundEnabled: parseBoolean(merged.EMAIL_INBOUND_ENABLED, false),
    emailInboundImapHost: merged.EMAIL_INBOUND_IMAP_HOST ?? "",
    emailInboundImapPort: parseNumber(merged.EMAIL_INBOUND_IMAP_PORT, 993, 1),
    emailInboundImapSecure: parseBoolean(merged.EMAIL_INBOUND_IMAP_SECURE, true),
    emailInboundUsername: merged.EMAIL_INBOUND_USERNAME ?? "",
    emailInboundPassword: merged.EMAIL_INBOUND_PASSWORD ?? "",
    emailInboundMailbox: merged.EMAIL_INBOUND_MAILBOX ?? "INBOX",
    emailInboundAllowedSenders: parseList(merged.EMAIL_INBOUND_ALLOWED_SENDERS),
    emailInboundSubjectPrefix: merged.EMAIL_INBOUND_SUBJECT_PREFIX ?? "",
    emailInboundPollIntervalMs: parseNumber(merged.EMAIL_INBOUND_POLL_INTERVAL_MS, 15000, 1000),
    emailInboundRateLimitPerMinute: parseNumber(merged.EMAIL_INBOUND_RATE_LIMIT_PER_MINUTE, 20, 1),
    useClashProxy: parseBoolean(merged.USE_CLASH_PROXY, false),
    clashOnCommand: merged.CLASH_ON_COMMAND ?? "clashon",
    clashOffCommand: merged.CLASH_OFF_COMMAND ?? "clashoff",
    condaEnvName: merged.CONDA_ENV_NAME ?? "vinkoclaw",
    opencodeModel: merged.VINKOCLAW_OPENCODE_MODEL ?? "zhipuai/glm-5",
    opencodeBaseUrl: merged.VINKOCLAW_OPENCODE_BASE_URL ?? "https://open.bigmodel.cn/api/paas/v4",
    opencodeApiKey: merged.OPENCODE_API_KEY ?? merged.OPENCODE_ZEN_API_KEY ?? "",
    zhipuApiKey: merged.ZHIPUAI_API_KEY ?? "",
    openaiApiKey: merged.OPENAI_API_KEY ?? "",
    anthropicApiKey: merged.ANTHROPIC_API_KEY ?? "",
    searchProvider: merged.SEARCH_PROVIDER ?? "",
    tavilyApiKey: merged.TAVILY_API_KEY ?? "",
    serpApiKey: merged.SERPAPI_API_KEY ?? ""
  };
}

export function resolveDataPath(env: RuntimeEnv, ...parts: string[]): string {
  return path.join(env.dataDir, ...parts);
}

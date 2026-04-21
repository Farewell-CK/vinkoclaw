import type { RuntimeEnv } from "./env.js";

export interface RuntimeValueResolver {
  get(key: string): string;
  has(key: string): boolean;
  getBoolean(key: string, fallback: boolean): boolean;
  getList(key: string): string[];
}

export interface RuntimeValueResolverInput {
  env: RuntimeEnv;
  getRuntimeSettings?: (() => Record<string, string>) | undefined;
  getRuntimeSecrets?: (() => Record<string, string>) | undefined;
  processEnv?: NodeJS.ProcessEnv | undefined;
}

type RuntimeEnvGetter = (env: RuntimeEnv) => string;

const ENV_KEY_GETTERS: Record<string, RuntimeEnvGetter> = {
  FEISHU_APP_ID: (env) => env.feishuAppId,
  FEISHU_APP_SECRET: (env) => env.feishuAppSecret,
  FEISHU_DOMAIN: (env) => env.feishuDomain,
  FEISHU_CONNECTION_MODE: (env) => env.feishuConnectionMode,
  FEISHU_ENCRYPT_KEY: (env) => env.feishuEncryptKey,
  FEISHU_VERIFICATION_TOKEN: (env) => env.feishuVerificationToken,
  FEISHU_DEFAULT_CHAT_ID: (env) => env.feishuDefaultChatId,
  AUTH_USERNAME: (env) => env.authUsername,
  AUTH_PASSWORD: (env) => env.authPassword,
  AUTH_CREDENTIALS: (env) => env.authCredentials,
  SMTP_URL: (env) => env.smtpUrl,
  EMAIL_DEFAULT_FROM: (env) => env.emailDefaultFrom,
  EMAIL_INBOUND_ENABLED: (env) => (env.emailInboundEnabled ? "1" : "0"),
  EMAIL_INBOUND_IMAP_HOST: (env) => env.emailInboundImapHost,
  EMAIL_INBOUND_IMAP_PORT: (env) => String(env.emailInboundImapPort),
  EMAIL_INBOUND_IMAP_SECURE: (env) => (env.emailInboundImapSecure ? "1" : "0"),
  EMAIL_INBOUND_USERNAME: (env) => env.emailInboundUsername,
  EMAIL_INBOUND_PASSWORD: (env) => env.emailInboundPassword,
  EMAIL_INBOUND_MAILBOX: (env) => env.emailInboundMailbox,
  EMAIL_INBOUND_ALLOWED_SENDERS: (env) => env.emailInboundAllowedSenders.join(","),
  EMAIL_INBOUND_SUBJECT_PREFIX: (env) => env.emailInboundSubjectPrefix,
  EMAIL_INBOUND_POLL_INTERVAL_MS: (env) => String(env.emailInboundPollIntervalMs),
  EMAIL_INBOUND_RATE_LIMIT_PER_MINUTE: (env) => String(env.emailInboundRateLimitPerMinute),
  VINKOCLAW_ORCHESTRATOR_URL: (env) => env.publicUrl,
  OPENCODE_API_KEY: (env) => env.opencodeApiKey,
  ZHIPUAI_API_KEY: (env) => env.zhipuApiKey,
  OPENAI_API_KEY: (env) => env.openaiApiKey,
  DASHSCOPE_API_KEY: (env) => env.dashscopeApiKey,
  DASHSCOPE_BASE_URL: (env) => env.dashscopeBaseUrl,
  DASHSCOPE_MODEL: (env) => env.dashscopeModel,
  ANTHROPIC_API_KEY: (env) => env.anthropicApiKey,
  SEARCH_PROVIDER: (env) => env.searchProvider,
  TAVILY_API_KEY: (env) => env.tavilyApiKey,
  SERPAPI_API_KEY: (env) => env.serpApiKey
};

function clean(value: string | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function toBoolean(value: string, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }
  const normalized = value.toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function createRuntimeValueResolver(input: RuntimeValueResolverInput): RuntimeValueResolver {
  return {
    get(key: string): string {
      const runtimeSettings = input.getRuntimeSettings?.() ?? {};
      const runtimeSecrets = input.getRuntimeSecrets?.() ?? {};
      const runtimeValue = clean(runtimeSettings[key] ?? runtimeSecrets[key]);
      if (runtimeValue) {
        return runtimeValue;
      }

      const fromLoadedEnv = clean(ENV_KEY_GETTERS[key]?.(input.env));
      if (fromLoadedEnv) {
        return fromLoadedEnv;
      }

      return clean((input.processEnv ?? process.env)[key]);
    },

    has(key: string): boolean {
      return this.get(key).length > 0;
    },

    getBoolean(key: string, fallback: boolean): boolean {
      return toBoolean(this.get(key), fallback);
    },

    getList(key: string): string[] {
      const value = this.get(key);
      if (!value) {
        return [];
      }
      return value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
    }
  };
}

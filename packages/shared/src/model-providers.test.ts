import { describe, expect, it } from "vitest";
import type { RuntimeEnv } from "./env.js";
import type { RuntimeConfig } from "./types.js";
import { buildModelProviderReadiness, listModelProviderStatuses } from "./model-providers.js";

function createEnv(overrides: Partial<RuntimeEnv> = {}): RuntimeEnv {
  return {
    nodeEnv: "test",
    host: "0.0.0.0",
    port: 8098,
    publicUrl: "http://127.0.0.1:8098",
    dataDir: "/tmp/vinko-test",
    workspaceRoot: "/tmp",
    authUsername: "",
    authPassword: "",
    authCredentials: "",
    primaryBackend: "dashscope",
    primaryModel: "qwen3.6-plus",
    sglangBaseUrl: "http://127.0.0.1:8000/v1",
    sglangModel: "Qwen3.5-35B-A3B",
    ollamaBaseUrl: "http://127.0.0.1:11434/v1",
    ollamaModel: "qwen3.5-instruct-14b",
    openaiBaseUrl: "https://api.openai.com/v1",
    openaiModel: "gpt-4.1",
    dashscopeBaseUrl: "https://coding.dashscope.aliyuncs.com/v1",
    dashscopeModel: "qwen3.6-plus",
    zhipuBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
    zhipuModel: "glm-5",
    feishuAppId: "",
    feishuAppSecret: "",
    feishuDomain: "feishu",
    feishuConnectionMode: "websocket",
    feishuEncryptKey: "",
    feishuVerificationToken: "",
    feishuDefaultChatId: "",
    feishuOwnerOpenIds: [],
    smtpUrl: "",
    emailDefaultFrom: "",
    emailInboundEnabled: false,
    emailInboundImapHost: "",
    emailInboundImapPort: 993,
    emailInboundImapSecure: true,
    emailInboundUsername: "",
    emailInboundPassword: "",
    emailInboundMailbox: "INBOX",
    emailInboundAllowedSenders: [],
    emailInboundSubjectPrefix: "",
    emailInboundPollIntervalMs: 15000,
    emailInboundRateLimitPerMinute: 20,
    recurringRunnerEnabled: false,
    recurringRunnerIntervalMs: 300000,
    useClashProxy: false,
    clashOnCommand: "clashon",
    clashOffCommand: "clashoff",
    condaEnvName: "vinkoclaw",
    opencodeModel: "zhipuai/glm-5",
    opencodeBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
    opencodeApiKey: "",
    zhipuApiKey: "",
    dashscopeApiKey: "",
    openaiApiKey: "",
    anthropicApiKey: "",
    searchProvider: "",
    tavilyApiKey: "",
    serpApiKey: "",
    aiStudioApiKey: "",
    aiStudioBaseUrl: "",
    ...overrides
  };
}

function createRuntimeConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    memory: { defaultBackend: "sqlite", roleBackends: {} },
    routing: { primaryBackend: "dashscope", fallbackBackend: "zhipu" },
    channels: { feishuEnabled: false, emailEnabled: false },
    approvals: { requireForConfigMutation: true, requireForEmailSend: true },
    queue: { sla: { warningWaitMs: 300000, criticalWaitMs: 900000 } },
    tools: {
      providerOrder: ["opencode", "codex", "claude"],
      workspaceOnly: true,
      timeoutMs: 1200000,
      approvalMode: "cto_auto_owner_fallback",
      ctoRoleId: "cto",
      ownerRoleId: "ceo",
      highRiskKeywords: [],
      providerModels: {},
      providerBaseUrls: {}
    },
    collaboration: {
      enabled: true,
      triggerKeywords: [],
      defaultParticipants: ["product", "backend", "qa"],
      defaultConfig: {
        maxRounds: 3,
        discussionTimeoutMs: 1800000,
        requireConsensus: false,
        pushIntermediateResults: true,
        autoAggregateOnComplete: true,
        aggregateTimeoutMs: 3600000
      }
    },
    evolution: {
      router: {
        confidenceThreshold: 0.75,
        preferValidatedFallbacks: false,
        templateHints: []
      },
      intake: {
        preferClarificationForShortVagueRequests: false,
        shortVagueRequestMaxLength: 24,
        directConversationMaxLength: 24,
        ambiguousConversationMaxLength: 32,
        collaborationMinLength: 40,
        requireExplicitTeamSignal: true
      },
      collaboration: {
        partialDeliveryMinCompletedRoles: 1,
        timeoutNoProgressMode: "await_user",
        terminalFailureNoProgressMode: "blocked",
        manualResumeAggregationMode: "deliver"
      },
      skills: {
        recommendations: []
      }
    },
    ...overrides
  };
}

describe("model provider statuses", () => {
  it("marks DashScope as primary when credentials are present", () => {
    const statuses = listModelProviderStatuses(createEnv({ dashscopeApiKey: "dashscope-key" }), createRuntimeConfig());
    const dashscope = statuses.find((status) => status.providerId === "dashscope");

    expect(dashscope).toMatchObject({
      primary: true,
      configured: true,
      keyConfigured: true,
      model: "qwen3.6-plus"
    });
  });

  it("reports missing external provider keys but keeps local providers configured", () => {
    const statuses = listModelProviderStatuses(createEnv(), createRuntimeConfig());
    const dashscope = statuses.find((status) => status.providerId === "dashscope");
    const sglang = statuses.find((status) => status.providerId === "sglang");

    expect(dashscope?.configured).toBe(false);
    expect(dashscope?.missing).toContain("DASHSCOPE_API_KEY");
    expect(sglang?.configured).toBe(true);
    expect(sglang?.keyConfigured).toBe(true);
  });

  it("recommends switching when primary is missing but another provider is configured", () => {
    const statuses = listModelProviderStatuses(createEnv(), createRuntimeConfig());
    const readiness = buildModelProviderReadiness(statuses);

    expect(readiness.ok).toBe(true);
    expect(readiness.primaryProviderId).toBe("dashscope");
    expect(readiness.primaryConfigured).toBe(false);
    expect(readiness.configuredProviderIds).toContain("sglang");
    expect(readiness.unavailablePrimaryReasons).toContain("DASHSCOPE_API_KEY");
    expect(readiness.recommendedAction).toBe("switch_to_configured_provider");
  });

  it("passes readiness when the primary provider is configured", () => {
    const statuses = listModelProviderStatuses(createEnv({ dashscopeApiKey: "dashscope-key" }), createRuntimeConfig());
    const readiness = buildModelProviderReadiness(statuses);

    expect(readiness.ok).toBe(true);
    expect(readiness.primaryConfigured).toBe(true);
    expect(readiness.recommendedAction).toBe("none");
  });
});

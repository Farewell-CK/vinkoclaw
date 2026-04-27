import { describe, expect, it } from "vitest";
import type { RoutingTemplate, RuntimeConfig } from "@vinko/shared";
import { routeInboundWithRouterV2 } from "./inbound-router-v2.js";

const templates: RoutingTemplate[] = [
  {
    id: "tpl-founder-prd",
    name: "Founder PRD",
    description: "Write structured PRD",
    triggerKeywords: ["prd", "产品需求文档"],
    matchMode: "any",
    enabled: true,
    tasks: [
      {
        roleId: "product",
        titleTemplate: "PRD: {{input_short}}",
        instructionTemplate: "Write PRD {{input}}"
      }
    ],
    createdAt: "2026-04-22T00:00:00.000Z",
    updatedAt: "2026-04-22T00:00:00.000Z"
  }
];

function createRuntimeConfig(overrides?: Partial<RuntimeConfig["evolution"]>): RuntimeConfig {
  return {
    memory: { defaultBackend: "sqlite", roleBackends: {} },
    routing: { primaryBackend: "openai", fallbackBackend: "zhipu" },
    channels: { feishuEnabled: true, emailEnabled: false },
    approvals: { requireForConfigMutation: true, requireForEmailSend: true },
    queue: {
      sla: {
        warningWaitMs: 5 * 60 * 1000,
        criticalWaitMs: 15 * 60 * 1000
      }
    },
    tools: {
      providerOrder: ["opencode", "codex", "claude"],
      workspaceOnly: true,
      timeoutMs: 20 * 60 * 1000,
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
        discussionTimeoutMs: 30 * 60 * 1000,
        requireConsensus: false,
        pushIntermediateResults: true,
        autoAggregateOnComplete: true,
        aggregateTimeoutMs: 60 * 60 * 1000
      }
    },
    evolution: {
      router: {
        confidenceThreshold: overrides?.router?.confidenceThreshold ?? 0.75,
        preferValidatedFallbacks: overrides?.router?.preferValidatedFallbacks ?? false,
        templateHints: overrides?.router?.templateHints ?? []
      },
      intake: {
        preferClarificationForShortVagueRequests: overrides?.intake?.preferClarificationForShortVagueRequests ?? false,
        shortVagueRequestMaxLength: overrides?.intake?.shortVagueRequestMaxLength ?? 24,
        directConversationMaxLength: overrides?.intake?.directConversationMaxLength ?? 24,
        ambiguousConversationMaxLength: overrides?.intake?.ambiguousConversationMaxLength ?? 32,
        collaborationMinLength: overrides?.intake?.collaborationMinLength ?? 40,
        requireExplicitTeamSignal: overrides?.intake?.requireExplicitTeamSignal ?? true
      },
      collaboration: {
        partialDeliveryMinCompletedRoles: overrides?.collaboration?.partialDeliveryMinCompletedRoles ?? 1,
        timeoutNoProgressMode: overrides?.collaboration?.timeoutNoProgressMode ?? "await_user",
        terminalFailureNoProgressMode: overrides?.collaboration?.terminalFailureNoProgressMode ?? "blocked",
        manualResumeAggregationMode: overrides?.collaboration?.manualResumeAggregationMode ?? "deliver"
      },
      skills: {
        recommendations: overrides?.skills?.recommendations ?? []
      }
    }
  };
}

describe("inbound-router-v2", () => {
  it("accepts high-confidence llm template routing", async () => {
    const result = await routeInboundWithRouterV2({
      text: "帮我写一个产品需求文档",
      templates,
      runtimeConfig: createRuntimeConfig(),
      client: {
        complete: async () => ({
          text: JSON.stringify({
            mode: "template",
            templateId: "tpl-founder-prd",
            primaryRole: "product",
            supportingRoles: [],
            collaborationLevel: "none",
            needClarification: false,
            questions: [],
            risk: "low",
            confidence: 0.91,
            reason: "known_prd_workflow"
          }),
          backendUsed: "fallback",
          modelUsed: "test"
        })
      }
    });

    expect(result.decisionSource).toBe("llm");
    expect(result.decision.mode).toBe("template");
    expect(result.decision.templateId).toBe("tpl-founder-prd");
  });

  it("falls back when llm decision confidence is too low", async () => {
    const result = await routeInboundWithRouterV2({
      text: "帮我写一个产品需求文档",
      templates,
      runtimeConfig: createRuntimeConfig(),
      client: {
        complete: async () => ({
          text: JSON.stringify({
            mode: "template",
            templateId: "tpl-founder-prd",
            primaryRole: "product",
            supportingRoles: [],
            collaborationLevel: "none",
            needClarification: false,
            questions: [],
            risk: "low",
            confidence: 0.4,
            reason: "weak_guess"
          }),
          backendUsed: "fallback",
          modelUsed: "test"
        })
      }
    });

    expect(result.decisionSource).toBe("fallback");
    expect(result.fallbackReason).toBe("llm_confidence_below_threshold");
  });

  it("accepts lower-confidence llm routing after learned threshold adjustment", async () => {
    const result = await routeInboundWithRouterV2({
      text: "帮我写一个产品需求文档",
      templates,
      runtimeConfig: createRuntimeConfig({
        router: {
          confidenceThreshold: 0.4,
          preferValidatedFallbacks: false,
          templateHints: []
        }
      }),
      client: {
        complete: async () => ({
          text: JSON.stringify({
            mode: "template",
            templateId: "tpl-founder-prd",
            primaryRole: "product",
            supportingRoles: [],
            collaborationLevel: "none",
            needClarification: false,
            questions: [],
            risk: "low",
            confidence: 0.45,
            reason: "learned_lower_threshold"
          }),
          backendUsed: "fallback",
          modelUsed: "test"
        })
      }
    });

    expect(result.decisionSource).toBe("llm");
    expect(result.validatorStatus).toBe("accepted");
  });

  it("falls back when llm invents a missing template", async () => {
    const result = await routeInboundWithRouterV2({
      text: "帮我写一个产品需求文档",
      templates,
      runtimeConfig: createRuntimeConfig(),
      client: {
        complete: async () => ({
          text: JSON.stringify({
            mode: "template",
            templateId: "tpl-missing",
            primaryRole: "product",
            supportingRoles: [],
            collaborationLevel: "none",
            needClarification: false,
            questions: [],
            risk: "low",
            confidence: 0.95,
            reason: "invented_template"
          }),
          backendUsed: "fallback",
          modelUsed: "test"
        })
      }
    });

    expect(result.decisionSource).toBe("fallback");
    expect(result.fallbackReason).toBe("template_not_found");
  });

  it("prefers validated template fallback labels when enabled", async () => {
    const result = await routeInboundWithRouterV2({
      text: "帮我写一个产品需求文档",
      templates,
      runtimeConfig: createRuntimeConfig({
        router: {
          confidenceThreshold: 0.75,
          preferValidatedFallbacks: true,
          templateHints: []
        }
      }),
      client: {
        complete: async () => ({
          text: JSON.stringify({
            mode: "template",
            templateId: "tpl-founder-prd",
            primaryRole: "product",
            supportingRoles: [],
            collaborationLevel: "none",
            needClarification: false,
            questions: [],
            risk: "low",
            confidence: 0.4,
            reason: "weak_guess"
          }),
          backendUsed: "fallback",
          modelUsed: "test"
        })
      }
    });

    expect(result.decisionSource).toBe("fallback");
    expect(result.decision.mode).toBe("template");
    expect(result.fallbackReason).toBe("validated_legacy_template_policy");
  });

  it("uses learned template hints in fallback routing", async () => {
    const result = await routeInboundWithRouterV2({
      text: "帮我出一个需求澄清文档",
      templates,
      runtimeConfig: createRuntimeConfig({
        router: {
          confidenceThreshold: 0.75,
          preferValidatedFallbacks: true,
          templateHints: [
            {
              templateId: "tpl-founder-prd",
              phrases: ["需求澄清文档"],
              source: "evolution",
              updatedAt: "2026-04-22T00:00:00.000Z"
            }
          ]
        }
      }),
      client: {
        complete: async () => {
          throw new Error("llm unavailable");
        }
      }
    });

    expect(result.decisionSource).toBe("fallback");
    expect(result.decision.mode).toBe("template");
    expect(result.decision.templateId).toBe("tpl-founder-prd");
    expect(result.fallbackReason).toBe("validated_legacy_template_policy");
  });
});

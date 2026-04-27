import { describe, expect, it } from "vitest";
import type { RoutingTemplate, RuntimeConfig } from "@vinko/shared";
import { selectRoutingTemplateDecision } from "./routing-template-policy.js";

const templates: RoutingTemplate[] = [
  {
    id: "tpl-product-prd",
    name: "PRD Workflow",
    description: "",
    triggerKeywords: ["prd", "需求文档", "产品需求"],
    matchMode: "any",
    enabled: true,
    tasks: [],
    createdAt: "2026-04-22T00:00:00.000Z",
    updatedAt: "2026-04-22T00:00:00.000Z"
  },
  {
    id: "tpl-landing-page",
    name: "Landing Page Workflow",
    description: "",
    triggerKeywords: ["landing page", "落地页", "报名页"],
    matchMode: "any",
    enabled: true,
    tasks: [],
    createdAt: "2026-04-22T00:00:00.000Z",
    updatedAt: "2026-04-22T00:00:00.000Z"
  },
  {
    id: "tpl-founder-delivery-loop",
    name: "Founder Delivery Loop",
    description: "",
    triggerKeywords: ["创业", "规划", "交付", "验证"],
    matchMode: "all",
    enabled: true,
    tasks: [],
    createdAt: "2026-04-22T00:00:00.000Z",
    updatedAt: "2026-04-22T00:00:00.000Z"
  }
];

function createRuntimeConfig(): RuntimeConfig {
  return {
    memory: { defaultBackend: "sqlite", roleBackends: {} },
    routing: { primaryBackend: "openai", fallbackBackend: "zhipu" },
    channels: { feishuEnabled: true, emailEnabled: false },
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
    }
  };
}

describe("routing-template-policy", () => {
  it("selects the strongest matching enabled template with evidence", () => {
    const decision = selectRoutingTemplateDecision("请帮我写一个产品需求文档 PRD", templates);
    expect(decision?.template.id).toBe("tpl-product-prd");
    expect(decision?.matchedKeywords).toContain("prd");
    expect(decision?.reason).toBe("template_match_full_keyword_coverage");
  });

  it("supports match-all templates", () => {
    const decision = selectRoutingTemplateDecision("请按创业 规划 交付 验证 全链路推进", templates);
    expect(decision?.template.id).toBe("tpl-founder-delivery-loop");
    expect(decision?.reason).toBe("template_match_all_keywords");
    expect(decision?.confidence).toBe("high");
  });

  it("matches learned runtime hints even when static keywords do not match", () => {
    const runtimeConfig = createRuntimeConfig();
    runtimeConfig.evolution.router.templateHints = [
      {
        templateId: "tpl-product-prd",
        phrases: ["需求澄清文档"],
        source: "evolution",
        updatedAt: "2026-04-22T00:00:00.000Z"
      }
    ];

    const decision = selectRoutingTemplateDecision("请帮我写一个需求澄清文档", templates, runtimeConfig);
    expect(decision?.template.id).toBe("tpl-product-prd");
    expect(decision?.reason).toBe("template_match_learned_hint");
    expect(decision?.matchedRules).toContain("template_match_runtime_hint");
    expect(decision?.matchedKeywords).toContain("需求澄清文档");
  });

  it("ignores disabled or non-matching templates", () => {
    const decision = selectRoutingTemplateDecision("请修复登录页样式", [
      {
        id: "tpl-landing-page",
        name: "Landing Page Workflow",
        description: "",
        triggerKeywords: ["landing page", "落地页", "报名页"],
        matchMode: "any",
        enabled: false,
        tasks: [],
        createdAt: "2026-04-22T00:00:00.000Z",
        updatedAt: "2026-04-22T00:00:00.000Z"
      }
    ]);
    expect(decision).toBeUndefined();
  });
});

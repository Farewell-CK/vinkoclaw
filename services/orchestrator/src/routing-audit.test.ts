import { describe, expect, it, vi } from "vitest";
import { appendInboundIntentAuditEvent, appendRouterV2AuditEvent, appendTemplateRoutingAuditEvent } from "./routing-audit.js";

describe("routing-audit", () => {
  it("appends inbound intent audit with structured evidence", () => {
    const appendAuditEvent = vi.fn((input) => ({
      id: "audit-1",
      createdAt: "2026-04-22T12:00:00.000Z",
      ...input,
      payload: input.payload ?? {}
    }));

    const result = appendInboundIntentAuditEvent({ appendAuditEvent }, {
      stage: "initial",
      text: "给团队开启联网搜索能力",
      intent: "operator_config",
      reason: "operator_config_pattern",
      matchedRules: ["operator_config_pattern"],
      confidence: "medium",
      sessionId: "sess-1"
    });

    expect(appendAuditEvent).toHaveBeenCalledTimes(1);
    expect(result.category).toBe("inbound-routing");
    expect(result.entityId).toBe("sess-1");
    expect(result.payload).toEqual({
      stage: "initial",
      intent: "operator_config",
      reason: "operator_config_pattern",
      matchedRules: ["operator_config_pattern"],
      confidence: "medium",
      textPreview: "给团队开启联网搜索能力"
    });
  });

  it("appends template routing audit with template evidence", () => {
    const appendAuditEvent = vi.fn((input) => ({
      id: "audit-2",
      createdAt: "2026-04-22T12:01:00.000Z",
      ...input,
      payload: input.payload ?? {}
    }));

    const result = appendTemplateRoutingAuditEvent({ appendAuditEvent }, {
      text: "请帮我写一个产品需求文档 PRD",
      templateId: "tpl-product-prd",
      templateName: "PRD Workflow",
      matchedKeywords: ["prd"],
      matchedRules: ["template_match_partial_keyword_coverage"],
      reason: "template_match_partial_keyword_coverage",
      confidence: "low",
      sessionId: "sess-2"
    });

    expect(appendAuditEvent).toHaveBeenCalledTimes(1);
    expect(result.category).toBe("template-routing");
    expect(result.entityId).toBe("sess-2");
    expect(result.payload).toEqual({
      templateId: "tpl-product-prd",
      templateName: "PRD Workflow",
      reason: "template_match_partial_keyword_coverage",
      matchedRules: ["template_match_partial_keyword_coverage"],
      matchedKeywords: ["prd"],
      confidence: "low",
      textPreview: "请帮我写一个产品需求文档 PRD"
    });
  });

  it("appends router v2 audit with validator and fallback evidence", () => {
    const appendAuditEvent = vi.fn((input) => ({
      id: "audit-3",
      createdAt: "2026-04-22T12:02:00.000Z",
      ...input,
      payload: input.payload ?? {}
    }));

    const result = appendRouterV2AuditEvent({ appendAuditEvent }, {
      text: "帮我写一个产品需求文档",
      selectedMode: "template",
      decisionSource: "fallback",
      validatorStatus: "fallback",
      confidence: 0.52,
      reason: "legacy_template_policy",
      templateId: "tpl-product-prd",
      primaryRole: "product",
      supportingRoles: ["qa"],
      fallbackReason: "llm_confidence_below_threshold",
      sessionId: "sess-3"
    });

    expect(result.category).toBe("inbound-routing");
    expect(result.payload).toEqual({
      stage: "router_v2",
      routerVersion: "v2",
      selectedMode: "template",
      decisionSource: "fallback",
      validatorStatus: "fallback",
      confidence: "0.52",
      reason: "legacy_template_policy",
      templateId: "tpl-product-prd",
      primaryRole: "product",
      supportingRoles: ["qa"],
      fallbackReason: "llm_confidence_below_threshold",
      textPreview: "帮我写一个产品需求文档"
    });
  });
});

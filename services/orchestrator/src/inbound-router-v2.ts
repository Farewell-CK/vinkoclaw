import { LocalModelClient } from "@vinko/agent-runtime";
import type { RoleId, RoutingTemplate, RuntimeConfig } from "@vinko/shared";
import { selectRoleFromText } from "./role-selection.js";
import { createFallbackRouterDecision, parseRouterDecision, type RouterDecision } from "./router-decision.js";
import { buildRouterRegistrySnapshot, renderRouterRegistryForPrompt } from "./router-registry.js";
import { validateRouterDecision } from "./router-validator.js";
import { selectRoutingTemplateDecision } from "./routing-template-policy.js";

export interface InboundRouterV2Result {
  decision: RouterDecision;
  decisionSource: "llm" | "fallback";
  validatorStatus: "accepted" | "rejected" | "fallback";
  fallbackReason?: string | undefined;
  legacyTemplateId?: string | undefined;
}

const ROUTER_CONFIDENCE_THRESHOLD = 0.75;

function routerEnabled(): boolean {
  const value = String(process.env.VINKO_ROUTER_V2_ENABLED ?? "1").trim().toLowerCase();
  return value !== "0" && value !== "false" && value !== "off";
}

function shadowOnly(): boolean {
  const value = String(process.env.VINKO_ROUTER_V2_SHADOW_ONLY ?? "0").trim().toLowerCase();
  return value === "1" || value === "true" || value === "on";
}

function buildRouterSystemPrompt(templates: RoutingTemplate[]): string {
  const snapshot = buildRouterRegistrySnapshot({ templates });
  return [
    "You are Router V2 for VinkoClaw, a local-first AI team operating system.",
    "Choose the best route for the user's message.",
    "Only select templateId from the available templates. Do not invent template IDs.",
    "Do not create operator action payloads. If the user wants configuration, only set mode=operator_config.",
    "Prefer template for known repeatable workflows. Prefer goalrun for broad end-to-end objectives. Prefer task for single specialist work.",
    "Use collaboration only when multiple roles should coordinate on one result.",
    "Output ONLY valid JSON with keys: mode, templateId, primaryRole, supportingRoles, collaborationLevel, needClarification, questions, risk, confidence, reason.",
    "mode must be one of: conversation, task, template, goalrun, collaboration, operator_config.",
    "collaborationLevel must be one of: none, light, standard, full.",
    "risk must be one of: low, medium, high.",
    "confidence must be a number from 0 to 1.",
    "",
    renderRouterRegistryForPrompt(snapshot)
  ].join("\n");
}

function resolveConfidenceThreshold(runtimeConfig?: RuntimeConfig): number {
  const candidate = Number(runtimeConfig?.evolution?.router?.confidenceThreshold ?? ROUTER_CONFIDENCE_THRESHOLD);
  if (!Number.isFinite(candidate)) {
    return ROUTER_CONFIDENCE_THRESHOLD;
  }
  return Math.max(0.3, Math.min(0.98, candidate));
}

function resolveFallbackReason(
  reason: string,
  legacy: InboundRouterV2Result,
  runtimeConfig?: RuntimeConfig
): string {
  if (
    runtimeConfig?.evolution?.router?.preferValidatedFallbacks === true &&
    legacy.decision.mode === "template" &&
    legacy.decision.templateId
  ) {
    return "validated_legacy_template_policy";
  }
  return reason;
}

function fallbackDecision(
  text: string,
  templates: RoutingTemplate[],
  runtimeConfig?: RuntimeConfig
): InboundRouterV2Result {
  const legacyTemplate = selectRoutingTemplateDecision(text, templates, runtimeConfig);
  if (legacyTemplate) {
    return {
      decision: createFallbackRouterDecision({
        mode: "template",
        templateId: legacyTemplate.template.id,
        reason: legacyTemplate.reason
      }),
      decisionSource: "fallback",
      validatorStatus: "fallback",
      fallbackReason:
        runtimeConfig?.evolution?.router?.preferValidatedFallbacks === true
          ? "validated_legacy_template_policy"
          : "legacy_template_policy",
      legacyTemplateId: legacyTemplate.template.id
    };
  }
  const primaryRole = selectRoleFromText(text);
  return {
    decision: createFallbackRouterDecision({
      mode: "task",
      primaryRole,
      reason: "legacy_role_policy"
    }),
    decisionSource: "fallback",
    validatorStatus: "fallback",
    fallbackReason: "legacy_role_policy"
  };
}

export async function routeInboundWithRouterV2(input: {
  text: string;
  templates: RoutingTemplate[];
  client?: Pick<LocalModelClient, "complete"> | undefined;
  runtimeConfig?: RuntimeConfig | undefined;
}): Promise<InboundRouterV2Result> {
  const legacy = fallbackDecision(input.text, input.templates, input.runtimeConfig);
  if (!routerEnabled()) {
    return {
      ...legacy,
      fallbackReason: "router_v2_disabled"
    };
  }

  const client = input.client ?? new LocalModelClient();
  let parsed: RouterDecision | undefined;
  try {
    const completion = await client.complete([
      { role: "system", content: buildRouterSystemPrompt(input.templates) },
      { role: "user", content: input.text }
    ]);
    parsed = parseRouterDecision(completion.text);
  } catch {
    parsed = undefined;
  }

  if (!parsed) {
    return {
      ...legacy,
      fallbackReason: resolveFallbackReason("llm_router_unavailable", legacy, input.runtimeConfig)
    };
  }

  const validation = validateRouterDecision({
    decision: parsed,
    templates: input.templates
  });
  if (!validation.ok || !validation.decision) {
    return {
      ...legacy,
      validatorStatus: "rejected",
      fallbackReason: resolveFallbackReason(validation.reason, legacy, input.runtimeConfig)
    };
  }

  if (shadowOnly()) {
    return {
      ...legacy,
      fallbackReason: "router_v2_shadow_only"
    };
  }

  if (validation.decision.confidence < resolveConfidenceThreshold(input.runtimeConfig)) {
    return {
      ...legacy,
      fallbackReason: resolveFallbackReason("llm_confidence_below_threshold", legacy, input.runtimeConfig)
    };
  }

  return {
    decision: validation.decision,
    decisionSource: "llm",
    validatorStatus: "accepted",
    legacyTemplateId: legacy.decision.templateId
  };
}

export function resolveRouterPrimaryRole(decision: RouterDecision, text: string): RoleId {
  return decision.primaryRole ?? decision.supportingRoles[0] ?? selectRoleFromText(text);
}

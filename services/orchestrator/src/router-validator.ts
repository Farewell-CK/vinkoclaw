import type { RoleId, RoutingTemplate } from "@vinko/shared";
import { ROLE_IDS } from "@vinko/shared";
import type { RouterDecision } from "./router-decision.js";

export interface RouterValidationResult {
  ok: boolean;
  decision?: RouterDecision | undefined;
  reason: string;
}

const ROLE_ID_SET = new Set<string>(ROLE_IDS);

function normalizeRoles(roles: RoleId[]): RoleId[] {
  return Array.from(new Set(roles.filter((roleId) => ROLE_ID_SET.has(roleId)))).slice(0, 8);
}

export function validateRouterDecision(input: {
  decision: RouterDecision;
  templates: RoutingTemplate[];
}): RouterValidationResult {
  const decision: RouterDecision = {
    ...input.decision,
    supportingRoles: normalizeRoles(input.decision.supportingRoles)
  };

  if (decision.primaryRole && !ROLE_ID_SET.has(decision.primaryRole)) {
    return { ok: false, reason: "unknown_primary_role" };
  }

  if (decision.mode === "template") {
    if (!decision.templateId) {
      return { ok: false, reason: "template_missing_id" };
    }
    const template = input.templates.find((entry) => entry.id === decision.templateId);
    if (!template) {
      return { ok: false, reason: "template_not_found" };
    }
    if (!template.enabled) {
      return { ok: false, reason: "template_disabled" };
    }
    if (template.tasks.length === 0) {
      return { ok: false, reason: "template_empty_tasks" };
    }
  }

  if (decision.mode === "operator_config") {
    return {
      ok: true,
      decision: {
        ...decision,
        // LLM router can only identify config intent; existing operator parsers create payloads.
        templateId: undefined,
        supportingRoles: []
      },
      reason: "operator_config_intent_only"
    };
  }

  if (decision.needClarification && decision.questions.length === 0) {
    return { ok: false, reason: "clarification_missing_questions" };
  }

  return {
    ok: true,
    decision,
    reason: "valid"
  };
}

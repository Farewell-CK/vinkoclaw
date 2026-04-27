import type { AuditEventRecord, VinkoStore } from "@vinko/shared";

export function appendInboundIntentAuditEvent(
  store: Pick<VinkoStore, "appendAuditEvent">,
  input: {
    stage: "clarified" | "initial";
    text: string;
    intent: string;
    reason: string;
    matchedRules: string[];
    confidence: string;
    sessionId?: string | undefined;
  }
): AuditEventRecord {
  return store.appendAuditEvent({
    category: "inbound-routing",
    entityType: "session",
    entityId: input.sessionId || "unknown",
    message: `Inbound intent classified as ${input.intent}`,
    payload: {
      stage: input.stage,
      intent: input.intent,
      reason: input.reason,
      matchedRules: input.matchedRules,
      confidence: input.confidence,
      textPreview: input.text.slice(0, 160)
    }
  });
}

export function appendRouterV2AuditEvent(
  store: Pick<VinkoStore, "appendAuditEvent">,
  input: {
    text: string;
    selectedMode: string;
    decisionSource: "llm" | "fallback";
    validatorStatus: "accepted" | "rejected" | "fallback";
    confidence: number;
    reason: string;
    templateId?: string | undefined;
    primaryRole?: string | undefined;
    supportingRoles?: string[] | undefined;
    fallbackReason?: string | undefined;
    sessionId?: string | undefined;
  }
): AuditEventRecord {
  return store.appendAuditEvent({
    category: "inbound-routing",
    entityType: "session",
    entityId: input.sessionId || "unknown",
    message: `Router V2 selected ${input.selectedMode}`,
    payload: {
      stage: "router_v2",
      routerVersion: "v2",
      selectedMode: input.selectedMode,
      decisionSource: input.decisionSource,
      validatorStatus: input.validatorStatus,
      confidence: input.confidence.toFixed(2),
      reason: input.reason,
      ...(input.templateId ? { templateId: input.templateId } : {}),
      ...(input.primaryRole ? { primaryRole: input.primaryRole } : {}),
      ...(Array.isArray(input.supportingRoles) ? { supportingRoles: input.supportingRoles } : {}),
      ...(input.fallbackReason ? { fallbackReason: input.fallbackReason } : {}),
      textPreview: input.text.slice(0, 160)
    }
  });
}

export function appendTemplateRoutingAuditEvent(
  store: Pick<VinkoStore, "appendAuditEvent">,
  input: {
    text: string;
    templateId: string;
    templateName: string;
    matchedKeywords: string[];
    matchedRules: string[];
    reason: string;
    confidence: string;
    sessionId?: string | undefined;
  }
): AuditEventRecord {
  return store.appendAuditEvent({
    category: "template-routing",
    entityType: "session",
    entityId: input.sessionId || "unknown",
    message: `Inbound template routed to ${input.templateId}`,
    payload: {
      templateId: input.templateId,
      templateName: input.templateName,
      reason: input.reason,
      matchedRules: input.matchedRules,
      matchedKeywords: input.matchedKeywords,
      confidence: input.confidence,
      textPreview: input.text.slice(0, 160)
    }
  });
}

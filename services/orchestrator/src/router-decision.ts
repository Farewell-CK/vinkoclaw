import type { RoleId } from "@vinko/shared";

export type RouterMode = "conversation" | "task" | "template" | "goalrun" | "collaboration" | "operator_config";
export type RouterCollaborationLevel = "none" | "light" | "standard" | "full";
export type RouterRiskLevel = "low" | "medium" | "high";

export interface RouterDecision {
  mode: RouterMode;
  templateId?: string | undefined;
  primaryRole?: RoleId | undefined;
  supportingRoles: RoleId[];
  collaborationLevel: RouterCollaborationLevel;
  needClarification: boolean;
  questions: string[];
  risk: RouterRiskLevel;
  confidence: number;
  reason: string;
}

const ROUTER_MODES = new Set<RouterMode>([
  "conversation",
  "task",
  "template",
  "goalrun",
  "collaboration",
  "operator_config"
]);
const COLLABORATION_LEVELS = new Set<RouterCollaborationLevel>(["none", "light", "standard", "full"]);
const RISK_LEVELS = new Set<RouterRiskLevel>(["low", "medium", "high"]);

export function clampRouterConfidence(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return Math.max(0, Math.min(1, parsed));
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeStringList(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return Array.from(
    new Set(
      value
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean)
    )
  ).slice(0, limit);
}

export function parseRouterDecision(raw: string): RouterDecision | undefined {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) {
    return undefined;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return undefined;
  }

  const mode = normalizeString(parsed.mode);
  if (!ROUTER_MODES.has(mode as RouterMode)) {
    return undefined;
  }

  const collaborationLevel = normalizeString(parsed.collaborationLevel) || "none";
  if (!COLLABORATION_LEVELS.has(collaborationLevel as RouterCollaborationLevel)) {
    return undefined;
  }

  const risk = normalizeString(parsed.risk) || "low";
  if (!RISK_LEVELS.has(risk as RouterRiskLevel)) {
    return undefined;
  }

  const templateId = normalizeString(parsed.templateId);
  const primaryRole = normalizeString(parsed.primaryRole);

  return {
    mode: mode as RouterMode,
    ...(templateId ? { templateId } : {}),
    ...(primaryRole ? { primaryRole: primaryRole as RoleId } : {}),
    supportingRoles: normalizeStringList(parsed.supportingRoles, 8) as RoleId[],
    collaborationLevel: collaborationLevel as RouterCollaborationLevel,
    needClarification: parsed.needClarification === true,
    questions: normalizeStringList(parsed.questions, 5),
    risk: risk as RouterRiskLevel,
    confidence: clampRouterConfidence(parsed.confidence),
    reason: normalizeString(parsed.reason) || "router_decision"
  };
}

export function createFallbackRouterDecision(input: {
  mode: RouterMode;
  templateId?: string | undefined;
  primaryRole?: RoleId | undefined;
  collaborationLevel?: RouterCollaborationLevel | undefined;
  reason: string;
}): RouterDecision {
  return {
    mode: input.mode,
    ...(input.templateId ? { templateId: input.templateId } : {}),
    ...(input.primaryRole ? { primaryRole: input.primaryRole } : {}),
    supportingRoles: [],
    collaborationLevel: input.collaborationLevel ?? "none",
    needClarification: false,
    questions: [],
    risk: "low",
    confidence: 0.5,
    reason: input.reason
  };
}

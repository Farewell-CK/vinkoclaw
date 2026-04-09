import type { RoleId } from "./types.js";

export type FeishuAckMode = "reaction_only" | "text" | "reaction_plus_text";

const ACK_MODE_VALUES: FeishuAckMode[] = ["reaction_only", "text", "reaction_plus_text"];

export function resolveFeishuAckMode(rawValue: string | undefined): FeishuAckMode {
  const normalized = (rawValue ?? "").trim().toLowerCase();
  if (ACK_MODE_VALUES.includes(normalized as FeishuAckMode)) {
    return normalized as FeishuAckMode;
  }
  return "reaction_plus_text";
}

function normalizeOpenIdList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter(Boolean);
  }
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized ? [normalized] : [];
  }
  return [];
}

export function parseFeishuApproverOpenIdsMap(
  rawValue: string | undefined
): Partial<Record<RoleId, string[]>> {
  const raw = (rawValue ?? "").trim();
  if (!raw) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const output: Partial<Record<RoleId, string[]>> = {};
    for (const [rawRoleId, rawOpenIds] of Object.entries(parsed)) {
      const roleId = rawRoleId.trim() as RoleId;
      const openIds = normalizeOpenIdList(rawOpenIds);
      if (!openIds.length) {
        continue;
      }
      output[roleId] = openIds;
    }
    return output;
  } catch {
    return {};
  }
}

export function resolveFeishuApproverOpenIds(input: {
  roleId: RoleId;
  approverOpenIdsJson?: string | undefined;
  fallbackOwnerOpenIds?: string[] | undefined;
}): string[] {
  const mapped = parseFeishuApproverOpenIdsMap(input.approverOpenIdsJson)[input.roleId] ?? [];
  if (mapped.length > 0) {
    return mapped;
  }
  const fallback = (input.fallbackOwnerOpenIds ?? []).map((entry) => entry.trim()).filter(Boolean);
  return fallback;
}

type SkillAllowlistRule = {
  rolePattern: string;
  skillId: string;
};

function parseSkillAllowlistRule(rawRule: string): SkillAllowlistRule | undefined {
  const rule = rawRule.trim();
  if (!rule) {
    return undefined;
  }
  const separatorIndex = rule.indexOf(":");
  if (separatorIndex <= 0 || separatorIndex >= rule.length - 1) {
    return undefined;
  }
  const rolePattern = rule.slice(0, separatorIndex).trim().toLowerCase();
  const skillId = rule.slice(separatorIndex + 1).trim().toLowerCase();
  if (!rolePattern || !skillId) {
    return undefined;
  }
  return {
    rolePattern,
    skillId
  };
}

export function parseSkillAutoApproveAllowlist(rawValue: string | undefined): SkillAllowlistRule[] {
  const raw = (rawValue ?? "").trim();
  if (!raw) {
    return [];
  }
  return raw
    .split(",")
    .map((entry) => parseSkillAllowlistRule(entry))
    .filter((entry): entry is SkillAllowlistRule => Boolean(entry));
}

export function isSkillAutoApproveAllowed(input: {
  rawAllowlist: string | undefined;
  roleId: RoleId;
  skillId: string;
}): boolean {
  const roleId = input.roleId.trim().toLowerCase();
  const skillId = input.skillId.trim().toLowerCase();
  if (!roleId || !skillId) {
    return false;
  }
  const rules = parseSkillAutoApproveAllowlist(input.rawAllowlist);
  return rules.some((rule) => (rule.rolePattern === "*" || rule.rolePattern === roleId) && rule.skillId === skillId);
}

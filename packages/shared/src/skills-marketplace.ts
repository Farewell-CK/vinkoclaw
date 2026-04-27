import type {
  MarketplaceRecommendation,
  MarketplaceRoleBindingState,
  RoleId,
  RuntimeConfig,
  SkillDefinition,
  SkillMarketplaceEntry
} from "./types.js";
import { getSkillDefinition, listSkills } from "./skills.js";

type RemoteSkillRegistryEntry = Partial<SkillMarketplaceEntry> & {
  id?: string;
  skillId?: string;
  name?: string;
  description?: string;
  version?: string;
  sourceLabel?: string;
  sourceUrl?: string;
};

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeStringList(value: unknown, limit = 12): string[] {
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

function buildCatalogEntry(skill: SkillDefinition): SkillMarketplaceEntry {
  return {
    id: skill.id,
    skillId: skill.id,
    name: skill.name,
    description: skill.description,
    summary: skill.description,
    allowedRoles: skill.allowedRoles,
    aliases: skill.aliases,
    tags: skill.aliases.slice(0, 8),
    source: "catalog",
    sourceLabel: "catalog",
    runtimeAvailable: true,
    installState: "local_installable",
    installable: true
  };
}

function normalizeRemoteEntry(raw: RemoteSkillRegistryEntry): SkillMarketplaceEntry | undefined {
  const id = normalizeText(raw.id ?? raw.skillId);
  const skillId = normalizeText(raw.skillId ?? raw.id);
  const name = normalizeText(raw.name);
  const description = normalizeText(raw.description);
  if (!id || !skillId || !name || !description) {
    return undefined;
  }
  const summary = normalizeText(raw.summary) || description;
  const allowedRoles = Array.isArray(raw.allowedRoles) ? raw.allowedRoles : [];
  const runtimeAvailable = Boolean(getSkillDefinition(skillId));
  const installable = raw.installable === true && runtimeAvailable;
  return {
    id,
    skillId,
    name,
    description,
    summary,
    allowedRoles: allowedRoles.filter((entry): entry is SkillMarketplaceEntry["allowedRoles"][number] => typeof entry === "string"),
    aliases: normalizeStringList(raw.aliases),
    tags: normalizeStringList(raw.tags),
    source: "remote",
    sourceLabel: normalizeText(raw.sourceLabel) || "remote",
    sourceUrl: normalizeText(raw.sourceUrl) || undefined,
    version: normalizeText(raw.version) || undefined,
    runtimeAvailable,
    installState: installable ? "local_installable" : "discover_only",
    installable
  };
}

export function getLocalSkillMarketplaceEntries(): SkillMarketplaceEntry[] {
  return listSkills().map(buildCatalogEntry);
}

export async function getRemoteSkillMarketplaceEntries(): Promise<SkillMarketplaceEntry[]> {
  const registryUrl = normalizeText(process.env.VINKO_SKILL_REGISTRY_URL);
  if (!registryUrl) {
    return [];
  }
  const response = await fetch(registryUrl, {
    headers: {
      accept: "application/json"
    }
  });
  if (!response.ok) {
    throw new Error(`Skill registry request failed (${response.status})`);
  }
  const payload = (await response.json()) as unknown;
  const items = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object" && Array.isArray((payload as { items?: unknown }).items)
      ? ((payload as { items: unknown[] }).items ?? [])
      : [];
  return items
    .map((entry) => normalizeRemoteEntry((entry ?? {}) as RemoteSkillRegistryEntry))
    .filter((entry): entry is SkillMarketplaceEntry => Boolean(entry));
}

export async function listMarketplaceSkills(): Promise<SkillMarketplaceEntry[]> {
  const merged = new Map<string, SkillMarketplaceEntry>();
  for (const entry of getLocalSkillMarketplaceEntries()) {
    merged.set(entry.id, entry);
  }
  let remoteEntries: SkillMarketplaceEntry[] = [];
  try {
    remoteEntries = await getRemoteSkillMarketplaceEntries();
  } catch {
    remoteEntries = [];
  }
  for (const entry of remoteEntries) {
    const existing = merged.get(entry.id);
    if (!existing) {
      merged.set(entry.id, entry);
      continue;
    }
    merged.set(entry.id, {
      ...entry,
      ...existing,
      summary: existing.summary || entry.summary,
      description: existing.description || entry.description,
      aliases: Array.from(new Set([...existing.aliases, ...entry.aliases])).slice(0, 12),
      tags: Array.from(new Set([...existing.tags, ...entry.tags])).slice(0, 12),
      source: existing.source,
      sourceLabel: entry.sourceLabel || existing.sourceLabel,
      sourceUrl: entry.sourceUrl || existing.sourceUrl,
      version: entry.version || existing.version,
      runtimeAvailable: true,
      installState: "local_installable",
      installable: true
    });
  }
  return Array.from(merged.values()).sort((left, right) => left.name.localeCompare(right.name));
}

export async function searchMarketplaceSkills(input: {
  query?: string;
  limit?: number;
}): Promise<SkillMarketplaceEntry[]> {
  const entries = await listMarketplaceSkills();
  const query = normalizeText(input.query).toLowerCase();
  const limitRaw = Number(input.limit ?? 10);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(50, Math.round(limitRaw))) : 10;
  if (!query) {
    return entries.slice(0, limit);
  }
  const scored = entries
    .map((entry) => {
      const haystack = [
        entry.id,
        entry.skillId,
        entry.name,
        entry.description,
        entry.summary,
        ...entry.aliases,
        ...entry.tags
      ]
        .join("\n")
        .toLowerCase();
      let score = 0;
      if (entry.id.toLowerCase() === query || entry.skillId.toLowerCase() === query) {
        score += 100;
      }
      if (entry.name.toLowerCase().includes(query)) {
        score += 40;
      }
      if (entry.aliases.some((alias) => alias.toLowerCase().includes(query))) {
        score += 30;
      }
      if (haystack.includes(query)) {
        score += 10;
      }
      return { entry, score };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.entry.name.localeCompare(right.entry.name));
  return scored.slice(0, limit).map((item) => item.entry);
}

export async function getMarketplaceSkillDetail(skillId: string): Promise<SkillMarketplaceEntry | undefined> {
  const normalized = normalizeText(skillId);
  if (!normalized) {
    return undefined;
  }
  const entries = await listMarketplaceSkills();
  return entries.find((entry) => entry.id === normalized || entry.skillId === normalized);
}

export function getMarketplaceRecommendation(input: {
  entry: SkillMarketplaceEntry;
  roleBinding?: MarketplaceRoleBindingState | undefined;
  roleId?: RoleId | undefined;
  runtimeConfig?: RuntimeConfig | undefined;
}): MarketplaceRecommendation {
  const { entry, roleBinding, roleId, runtimeConfig } = input;
  const installed = roleBinding?.installed === true;
  const verificationStatus = roleBinding?.verificationStatus ?? "";
  const roleAllowed = roleId ? entry.allowedRoles.includes(roleId) : true;
  const learnedBoost =
    roleId && Array.isArray(runtimeConfig?.evolution?.skills?.recommendations)
      ? runtimeConfig!.evolution!.skills!.recommendations
          .filter((item) => item.roleId === roleId && item.skillId === entry.skillId)
          .reduce((sum, item) => sum + Math.max(0, Number(item.scoreBoost ?? 0)), 0)
      : 0;

  if (installed && verificationStatus === "verified") {
    return {
      score: 400 + (roleAllowed ? 20 : 0) + learnedBoost,
      state: "ready_verified",
      label: "verified_ready"
    };
  }
  if (installed && verificationStatus === "failed") {
    return {
      score: 40 + (roleAllowed ? 5 : 0) + learnedBoost,
      state: "ready_failed",
      label: "verification_failed"
    };
  }
  if (installed) {
    return {
      score: 260 + (roleAllowed ? 20 : 0) + learnedBoost,
      state: "ready_unverified",
      label: "verification_pending"
    };
  }
  if (entry.installState === "local_installable" && entry.installable !== false) {
    return {
      score: 180 + (roleAllowed ? 30 : 0) + learnedBoost,
      state: "install_recommended",
      label: "install_recommended"
    };
  }
  return {
    score: 60 + (roleAllowed ? 15 : 0) + learnedBoost,
    state: "integration_required",
    label: "integration_required"
  };
}

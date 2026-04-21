import { resolveRoleId, type RoleId } from "@vinko/shared";

export function parseSkillSearchIntent(text: string): { query: string; roleId?: RoleId | undefined } | undefined {
  const normalized = text.trim();
  if (!normalized) {
    return undefined;
  }
  if (!/(skill|技能|写prd|prd|需求文档|插件)/i.test(normalized)) {
    return undefined;
  }
  if (!/(搜索|查找|找|搜|search|find)/i.test(normalized)) {
    return undefined;
  }
  const roleId = resolveRoleId(normalized);
  const query = normalized
    .replace(/(?:搜索|查找|找|搜|search|find)/gi, "")
    .replace(/(?:skill|skills|技能|插件)/gi, "")
    .replace(/^[\s:：-]+|[\s:：-]+$/g, "")
    .trim();
  return {
    query: query || normalized,
    roleId
  };
}

export function parseSkillInstallIntent(text: string): { query: string; roleId: RoleId } | undefined {
  const normalized = text.trim();
  if (!normalized) {
    return undefined;
  }
  const installMatch =
    normalized.match(/(?:给|为|把)?(.+?)(?:安装|启用)(.+?)(?:skill|技能)?$/i) ??
    normalized.match(/install (.+?) (?:skill )?(?:to|for) (.+)/i);
  if (!installMatch) {
    return undefined;
  }
  const roleCandidate = /install /i.test(normalized) ? installMatch[2] : installMatch[1];
  const skillCandidate = /install /i.test(normalized) ? installMatch[1] : installMatch[2];
  const roleId = resolveRoleId(roleCandidate ?? "");
  const query = String(skillCandidate ?? "")
    .replace(/(?:skill|skills|技能|插件)/gi, "")
    .replace(/^[\s:：-]+|[\s:：-]+$/g, "")
    .trim();
  if (!roleId || !query) {
    return undefined;
  }
  return {
    roleId,
    query
  };
}

export function normalizeSkillMatchValue(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "");
}

export function isExactMarketplaceSkillMatch(entry: {
  skillId: string;
  name: string;
  aliases?: string[] | undefined;
}, query: string): boolean {
  const normalizedQuery = normalizeSkillMatchValue(query);
  if (!normalizedQuery) {
    return false;
  }
  const candidates = [entry.skillId, entry.name, ...(Array.isArray(entry.aliases) ? entry.aliases : [])];
  return candidates.some((candidate) => normalizeSkillMatchValue(candidate) === normalizedQuery);
}

export function formatSkillSearchResultsMessage(input: {
  query: string;
  roleId?: RoleId | undefined;
  results: Array<{
    skillId: string;
    name: string;
    summary: string;
    allowedRoles: RoleId[];
    version?: string | undefined;
    installState?: "local_installable" | "discover_only" | undefined;
  }>;
}): string {
  if (input.results.length === 0) {
    return `没有找到和「${input.query}」相关的 skill。你可以换个关键词再搜，比如：写 PRD、调研报告、测试回归。`;
  }
  const lines = [
    `我找到了这些和「${input.query}」相关的 skill：`,
    ...input.results.map((entry, index) => {
      const roleHint = entry.allowedRoles.length > 0 ? `（适用角色: ${entry.allowedRoles.join(", ")}）` : "";
      const versionHint = entry.version ? ` v${entry.version}` : "";
      const installHint =
        entry.installState === "discover_only" ? " [可发现，暂不可直接安装]" : " [可安装]";
      return `${index + 1}. ${entry.name}${versionHint} [${entry.skillId}]${installHint} ${roleHint}\n   ${entry.summary}`;
    }),
    "",
    input.roleId
      ? `如果要安装到 ${input.roleId}，直接回复编号，例如：1`
      : "如果要安装，回复“编号 + 角色”，例如：1 product"
  ];
  return lines.join("\n");
}

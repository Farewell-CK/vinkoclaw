import type { RoleId, SkillDefinition } from "./types.js";
import { getSkills } from "./plugins/registry.js";

export const SKILL_CATALOG: SkillDefinition[] = [
  {
    id: "vector-memory",
    name: "Vector Memory",
    description: "Persist role memory in a local vector-backed memory configuration.",
    allowedRoles: [
      "ceo",
      "cto",
      "product",
      "uiux",
      "frontend",
      "backend",
      "algorithm",
      "qa",
      "developer",
      "engineering",
      "research",
      "operations"
    ],
    defaultConfig: {
      backend: "vector-db",
      namespaceStrategy: "role"
    },
    aliases: ["vector", "vector-memory", "向量记忆", "向量数据库", "向量库"]
  },
  {
    id: "workspace-retrieval",
    name: "Workspace Retrieval",
    description: "Retrieve repo and document context from the local workspace.",
    allowedRoles: ["cto", "product", "uiux", "frontend", "backend", "algorithm", "qa", "developer", "engineering", "research"],
    defaultConfig: {
      topK: 5
    },
    aliases: ["retrieval", "rag", "workspace", "检索", "知识库"]
  },
  {
    id: "email-ops",
    name: "Email Ops",
    description: "Draft and send approval-gated outbound email.",
    allowedRoles: ["ceo", "product", "operations"],
    defaultConfig: {
      approvalRequired: true
    },
    aliases: ["email", "mail", "邮件", "发邮件"]
  },
  {
    id: "feishu-ops",
    name: "Feishu Ops",
    description: "Operate the command room via Feishu messages and notifications.",
    allowedRoles: ["ceo", "product", "operations"],
    defaultConfig: {
      notify: true
    },
    aliases: ["feishu", "lark", "飞书"]
  },
  {
    id: "web-search",
    name: "Web Search",
    description: "Search the public web using configured provider keys for latest external context.",
    allowedRoles: ["ceo", "cto", "product", "research", "operations"],
    defaultConfig: {
      provider: "tavily",
      maxResults: 5
    },
    aliases: ["web-search", "web search", "search", "联网搜索", "网页搜索", "tavily", "serpapi"]
  },
  {
    id: "code-executor",
    name: "Code Executor",
    description: "Plan and approval-gate development and code execution tasks.",
    allowedRoles: ["cto", "frontend", "backend", "algorithm", "developer", "engineering"],
    defaultConfig: {
      approvalRequired: true
    },
    aliases: ["code", "executor", "开发", "编码", "代码执行"]
  },
  {
    id: "reflection-review",
    name: "Reflection Review",
    description: "Force self-review, assumptions, and risk reporting on every task.",
    allowedRoles: [
      "ceo",
      "cto",
      "product",
      "uiux",
      "frontend",
      "backend",
      "algorithm",
      "qa",
      "developer",
      "engineering",
      "research",
      "operations"
    ],
    defaultConfig: {
      minimumBullets: 3
    },
    aliases: ["reflection", "review", "反思", "复盘", "自检"]
  }
];

/**
 * Get all skills, combining catalog skills with plugin-registered skills.
 * Plugin skills override catalog skills with the same ID.
 */
export function listSkills(): SkillDefinition[] {
  const pluginSkills = getSkills();
  const skillMap = new Map<string, SkillDefinition>();

  // First add catalog skills
  for (const skill of SKILL_CATALOG) {
    skillMap.set(skill.id, skill);
  }

  // Then add/override with plugin skills
  for (const pluginSkill of pluginSkills) {
    skillMap.set(pluginSkill.id, pluginSkill as SkillDefinition);
  }

  return Array.from(skillMap.values());
}

/**
 * Get a skill definition by ID from combined catalog and plugins.
 */
export function getSkillDefinition(skillId: string): SkillDefinition | undefined {
  // Check plugins first (they can override catalog)
  const pluginSkills = getSkills();
  const pluginSkill = pluginSkills.find((s) => s.id === skillId);
  if (pluginSkill) {
    return pluginSkill as SkillDefinition;
  }

  // Fallback to catalog
  return SKILL_CATALOG.find((entry) => entry.id === skillId);
}

/**
 * Resolve a skill ID from user input, checking both catalog and plugins.
 */
export function resolveSkillId(input: string): string | undefined {
  const normalized = input.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  // Check direct match first
  const directMatch = getSkillDefinition(normalized);
  if (directMatch) {
    return directMatch.id;
  }

  // Check aliases in all skills
  const allSkills = listSkills();
  return allSkills.find((entry) =>
    entry.aliases.some((alias) => normalized.includes(alias.toLowerCase()))
  )?.id;
}

/**
 * Check if a role can use a skill.
 */
export function roleCanUseSkill(roleId: RoleId, skillId: string): boolean {
  return Boolean(getSkillDefinition(skillId)?.allowedRoles.includes(roleId));
}

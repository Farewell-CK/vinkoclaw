import { ROLE_IDS, type RoleId } from "./types.js";

export interface RoleProfile {
  id: RoleId;
  name: string;
  aliases: string[];
  responsibility: string;
  defaultSkills: string[];
}

export const ROLE_PROFILES: RoleProfile[] = [
  {
    id: "ceo",
    name: "CEO Assistant",
    aliases: ["ceo", "ceo assistant", "老板", "总裁", "ceo助理"],
    responsibility: "Owns goals, business priorities, alignment, and approvals.",
    defaultSkills: ["reflection-review", "feishu-ops", "email-ops", "web-search"]
  },
  {
    id: "cto",
    name: "CTO Assistant",
    aliases: ["cto", "cto assistant", "技术总监", "cto助理"],
    responsibility: "Owns architecture, roadmap, technical tradeoffs, and delivery sequencing.",
    defaultSkills: ["workspace-retrieval", "code-executor", "reflection-review", "web-search"]
  },
  {
    id: "product",
    name: "Product Manager Assistant",
    aliases: ["product", "pm", "产品", "产品经理", "prd", "需求"],
    responsibility: "Owns product requirements, scope decisions, priorities, and acceptance criteria.",
    defaultSkills: ["workspace-retrieval", "feishu-ops", "reflection-review", "web-search"]
  },
  {
    id: "uiux",
    name: "UI/UX Assistant",
    aliases: ["ui", "ux", "uiux", "ui设计", "交互", "视觉"],
    responsibility: "Owns interaction flows, visual direction, information hierarchy, and usability.",
    defaultSkills: ["workspace-retrieval", "reflection-review"]
  },
  {
    id: "frontend",
    name: "Frontend Assistant",
    aliases: ["frontend", "front-end", "前端", "页面", "react", "vue"],
    responsibility: "Owns frontend implementation, component quality, performance, and UX behavior.",
    defaultSkills: ["workspace-retrieval", "code-executor", "reflection-review"]
  },
  {
    id: "backend",
    name: "Backend Assistant",
    aliases: ["backend", "back-end", "后端", "api", "服务端", "接口", "数据库"],
    responsibility: "Owns API contracts, data models, service reliability, and backend integration.",
    defaultSkills: ["workspace-retrieval", "code-executor", "reflection-review"]
  },
  {
    id: "algorithm",
    name: "Algorithm Assistant",
    aliases: ["algorithm", "algo", "算法", "模型", "llm", "推理", "rag", "embedding"],
    responsibility: "Owns model selection, prompt strategy, retrieval quality, and inference performance.",
    defaultSkills: ["workspace-retrieval", "vector-memory", "code-executor", "reflection-review"]
  },
  {
    id: "qa",
    name: "QA Assistant",
    aliases: ["qa", "test", "tester", "测试", "质量", "验证", "回归"],
    responsibility: "Owns test planning, verification strategy, quality risk reporting, and release readiness.",
    defaultSkills: ["workspace-retrieval", "reflection-review"]
  },
  {
    id: "developer",
    name: "Developer Assistant",
    aliases: ["developer", "dev", "开发人员", "程序员", "coding", "写代码", "开发工程师"],
    responsibility: "Owns concrete coding delivery, local tool execution, and implementation closure for assigned tasks.",
    defaultSkills: ["workspace-retrieval", "code-executor", "reflection-review"]
  },
  {
    id: "engineering",
    name: "Engineering Assistant",
    aliases: ["engineering", "engineer", "开发", "工程", "工程助理", "开发助理"],
    responsibility: "Legacy generalist role for implementation tasks across code and environment actions.",
    defaultSkills: ["workspace-retrieval", "code-executor", "reflection-review"]
  },
  {
    id: "research",
    name: "Research Assistant",
    aliases: ["research", "research assistant", "研究", "研究助理"],
    responsibility: "Legacy generalist role for research synthesis and knowledge curation.",
    defaultSkills: ["workspace-retrieval", "vector-memory", "reflection-review", "web-search"]
  },
  {
    id: "operations",
    name: "Operations Assistant",
    aliases: ["operations", "ops", "运营", "运营助理"],
    responsibility: "Owns outbound messaging, CRM workflow, content calendar, and operational follow-through.",
    defaultSkills: ["email-ops", "feishu-ops", "reflection-review", "web-search"]
  }
];

export function listRoles(): RoleProfile[] {
  return ROLE_PROFILES;
}

export function getRoleProfile(roleId: RoleId): RoleProfile {
  const profile = ROLE_PROFILES.find((entry) => entry.id === roleId);
  if (!profile) {
    throw new Error(`Unknown role id: ${roleId}`);
  }

  return profile;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

export function resolveRoleId(input: string): RoleId | undefined {
  const normalized = normalize(input);
  if (!normalized) {
    return undefined;
  }

  if ((ROLE_IDS as readonly string[]).includes(normalized)) {
    return normalized as RoleId;
  }

  return ROLE_PROFILES.find((entry) =>
    entry.aliases.some((alias) => normalized.includes(normalize(alias)))
  )?.id;
}

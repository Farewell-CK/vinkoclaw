import type { RoleId } from "@vinko/shared";
import { resolveExplicitRoleDirective } from "./inbound-policy.js";

function includesAny(text: string, keywords: readonly string[]): boolean {
  return keywords.some((keyword) => text.includes(keyword));
}

const PRODUCT_KEYWORDS = ["产品", "需求", "prd", "pm"] as const;
const PRODUCT_DOCUMENT_KEYWORDS = ["需求文档", "产品文档", "roadmap", "里程碑", "验收标准", "prd"] as const;
const UIUX_KEYWORDS = ["ui", "ux", "视觉", "交互", "原型", "wireframe", "prototype"] as const;
const FRONTEND_KEYWORDS = [
  "前端",
  "frontend",
  "react",
  "vue",
  "页面",
  "css",
  "组件",
  "登录页",
  "落地页",
  "官网",
  "website",
  "html",
  "web页",
  "网页",
  "网站"
] as const;
const FRONTEND_BUILD_VERBS = ["建", "搭建", "做", "开发", "实现", "build", "create", "develop", "implement"] as const;
const BACKEND_KEYWORDS = ["后端", "backend", "api", "接口", "数据库", "服务端"] as const;
const ALGORITHM_KEYWORDS = ["算法", "模型", "llm", "推理", "rag", "embedding", "量化"] as const;
const QA_KEYWORDS = ["测试", "qa", "回归", "验证", "质量"] as const;
const DEVELOPER_KEYWORDS = ["开发人员", "developer", "程序员", "写代码", "codex", "opencode"] as const;
const ENGINEERING_KEYWORDS = [
  "代码",
  "开发",
  "bug",
  "code",
  "python",
  "bash",
  "shell",
  "脚本",
  "编程",
  "实现",
  "implement",
  "编写"
] as const;
const RESEARCH_KEYWORDS = [
  "调研",
  "研究",
  "research",
  "市场",
  "分析",
  "报告",
  "总结",
  "对比",
  "搜索",
  "查找",
  "explain",
  "what is",
  "what are",
  "how to"
] as const;
const CTO_KEYWORDS = ["架构", "roadmap", "cto", "技术"] as const;
const OPERATIONS_KEYWORDS = [
  "运营",
  "邮件",
  "客户",
  "内容",
  "文章",
  "写一篇",
  "写作",
  "文案",
  "诗",
  "故事",
  "小说"
] as const;
const RESEARCH_FALLBACK_KEYWORDS = [
  "帮我",
  "帮助",
  "介绍",
  "什么是",
  "如何",
  "怎么",
  "为什么",
  "能否",
  "可以",
  "请",
  "告诉我",
  "查一下",
  "推荐",
  "建议"
] as const;

/**
 * Select a role for single-turn task routing.
 *
 * Order matters:
 * 1) explicit role directives
 * 2) concrete implementation domains (frontend/backend)
 * 3) planning/document roles (product/research/etc)
 */
export function selectRoleFromText(text: string): RoleId {
  const explicit = resolveExplicitRoleDirective(text);
  if (explicit) {
    return explicit;
  }

  const normalized = text.toLowerCase();
  const hasProductDocumentIntent = includesAny(normalized, PRODUCT_DOCUMENT_KEYWORDS);
  const hasFrontendSignal = includesAny(normalized, FRONTEND_KEYWORDS);
  const hasFrontendBuildVerb = includesAny(normalized, FRONTEND_BUILD_VERBS);

  // Website/build asks should route to frontend even when they contain "产品".
  if (hasFrontendSignal && (!hasProductDocumentIntent || hasFrontendBuildVerb)) {
    return "frontend";
  }

  if (includesAny(normalized, BACKEND_KEYWORDS)) {
    return "backend";
  }

  if (includesAny(normalized, PRODUCT_KEYWORDS)) {
    return "product";
  }

  if (includesAny(normalized, UIUX_KEYWORDS)) {
    return "uiux";
  }

  if (includesAny(normalized, ALGORITHM_KEYWORDS)) {
    return "algorithm";
  }

  if (includesAny(normalized, QA_KEYWORDS)) {
    return "qa";
  }

  if (includesAny(normalized, DEVELOPER_KEYWORDS)) {
    return "developer";
  }

  if (includesAny(normalized, ENGINEERING_KEYWORDS)) {
    return "engineering";
  }

  if (includesAny(normalized, RESEARCH_KEYWORDS)) {
    return "research";
  }

  if (includesAny(normalized, CTO_KEYWORDS)) {
    return "cto";
  }

  if (includesAny(normalized, OPERATIONS_KEYWORDS)) {
    return "operations";
  }

  if (includesAny(normalized, RESEARCH_FALLBACK_KEYWORDS)) {
    return "research";
  }

  // Default to developer — more versatile than CEO for execution tasks.
  return "developer";
}

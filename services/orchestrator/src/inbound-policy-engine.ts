import type { RuntimeConfig } from "@vinko/shared";
import { hasExplicitTeamCollaborationSignal, isSmalltalkMessage, shouldUseTeamCollaboration } from "./inbound-policy.js";

export type InboundIntent = "goalrun" | "collaboration" | "light_collaboration" | "operator_config" | "task";

export interface InboundPolicyDecision {
  intent: InboundIntent;
  matchedRules: string[];
  reason: string;
  confidence: "low" | "medium" | "high";
}

const STRONG_GOAL_KEYWORDS = [
  "全流程",
  "端到端",
  "自动完成",
  "自动推进",
  "主动执行",
  "持续推进",
  "从0到1",
  "从零到一",
  "end-to-end",
  "full pipeline",
  "autonom"
];

const DELIVERY_KEYWORDS = [
  "部署",
  "上线",
  "publish",
  "deploy",
  "launch"
];

const COMPLEX_OBJECTIVE_HINTS = [
  "官网",
  "网站",
  "系统",
  "平台",
  "产品",
  "mvp",
  "后台",
  "管理端",
  "管理系统",
  "saas",
  "应用",
  "app",
  "landing page",
  "web site",
  "system",
  "platform",
  "product",
  "admin",
  "dashboard",
  "management",
  "application",
  "pipeline",
  "工作流",
  "自动化"
];

const MULTI_STEP_CONNECTORS = ["并且", "然后", "再", "同时", "并行", "以及", "and then"];

const LIGHT_COLLABORATION_PATTERNS = [
  /(?:做完|写完|开发完|开发|写|做).*(?:检查|测试|验证|审阅|review|check)/i,
  /(?:然后|顺便).*(?:检查|测试|验证|审阅|review|check)/i
];

const OPERATOR_CONFIG_PATTERNS = [
  /(?:配置|设置|开通|启用|安装|增加|需要|开启|禁用|关闭|切换).*(?:搜索|模型|技能|邮件|api.?key|密钥|能力)/i,
  /(?:搜索|模型|技能|邮件).*(?:配置|设置|开通|启用)/i,
  /(?:set|enable|disable|configure|install)\s+(?:\w+\s+)*(?:search|model|skill|email|api.?key)/i,
  /web\s*search/i
];

function matchesAnyPattern(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

export function evaluateGoalRunRouting(text: string): InboundPolicyDecision {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return {
      intent: "task",
      matchedRules: ["empty_input"],
      reason: "empty_input",
      confidence: "high"
    };
  }

  if (isSmalltalkMessage(normalized)) {
    return {
      intent: "task",
      matchedRules: ["smalltalk_guardrail"],
      reason: "smalltalk_guardrail",
      confidence: "high"
    };
  }

  if (STRONG_GOAL_KEYWORDS.some((keyword) => normalized.includes(keyword))) {
    return {
      intent: "goalrun",
      matchedRules: ["strong_goal_keyword"],
      reason: "strong_goal_keyword",
      confidence: "high"
    };
  }

  const hasDelivery = DELIVERY_KEYWORDS.some((keyword) => normalized.includes(keyword));
  const hasComplexHint = COMPLEX_OBJECTIVE_HINTS.some((keyword) => normalized.includes(keyword));
  const hasBuildIntent =
    /(?:做|构建|搭建|开发|实现|创建|设计|写一个|build|create|develop|implement)/i.test(normalized);
  const connectorCount = MULTI_STEP_CONNECTORS.filter((keyword) => normalized.includes(keyword)).length;

  if (hasDelivery && hasComplexHint) {
    return {
      intent: "goalrun",
      matchedRules: ["delivery_plus_complex_scope"],
      reason: "delivery_plus_complex_scope",
      confidence: "high"
    };
  }

  if (hasBuildIntent && hasComplexHint && normalized.length >= 10) {
    return {
      intent: "goalrun",
      matchedRules: ["build_plus_complex_scope"],
      reason: "build_plus_complex_scope",
      confidence: "medium"
    };
  }

  if (hasComplexHint && connectorCount >= 2 && normalized.length >= 20) {
    return {
      intent: "goalrun",
      matchedRules: ["complex_scope_multi_step"],
      reason: "complex_scope_multi_step",
      confidence: "medium"
    };
  }

  return {
    intent: "task",
    matchedRules: ["goalrun_no_match"],
    reason: "goalrun_no_match",
    confidence: "high"
  };
}

export function evaluateInboundIntentPolicy(
  text: string,
  options?: {
    triggerKeywords?: string[];
    evolution?: Partial<RuntimeConfig["evolution"]["intake"]>;
  }
): InboundPolicyDecision {
  const goalRunDecision = evaluateGoalRunRouting(text);
  if (goalRunDecision.intent === "goalrun") {
    return goalRunDecision;
  }

  if (shouldUseTeamCollaboration(text, options)) {
    const explicitTeamSignal = hasExplicitTeamCollaborationSignal(text);
    return {
      intent: "collaboration",
      matchedRules: [
        explicitTeamSignal
          ? "explicit_team_signal"
          : options?.evolution?.requireExplicitTeamSignal === false
            ? "evolution_length_based_collaboration"
            : "collaboration_trigger_keyword"
      ],
      reason:
        explicitTeamSignal
          ? "explicit_team_signal"
          : options?.evolution?.requireExplicitTeamSignal === false
            ? "evolution_length_based_collaboration"
            : "collaboration_trigger_keyword",
      confidence: explicitTeamSignal ? "high" : "medium"
    };
  }

  const normalized = text.trim().toLowerCase();
  if (matchesAnyPattern(normalized, LIGHT_COLLABORATION_PATTERNS)) {
    return {
      intent: "light_collaboration",
      matchedRules: ["build_then_check_pattern"],
      reason: "build_then_check_pattern",
      confidence: "medium"
    };
  }

  if (matchesAnyPattern(normalized, OPERATOR_CONFIG_PATTERNS)) {
    return {
      intent: "operator_config",
      matchedRules: ["operator_config_pattern"],
      reason: "operator_config_pattern",
      confidence: "medium"
    };
  }

  return {
    intent: "task",
    matchedRules: ["default_task"],
    reason: "default_task",
    confidence: "high"
  };
}

export function normalizeModelInboundIntent(
  intent: InboundIntent,
  text: string,
  options?: {
    triggerKeywords?: string[];
    evolution?: Partial<RuntimeConfig["evolution"]["intake"]>;
  }
): InboundPolicyDecision {
  if (intent === "collaboration" && !hasExplicitTeamCollaborationSignal(text)) {
    const fallback = evaluateInboundIntentPolicy(text, options);
    return {
      intent: fallback.intent === "collaboration" ? "task" : fallback.intent,
      matchedRules: ["collaboration_downgraded_to_task", ...fallback.matchedRules],
      reason: "collaboration_downgraded_to_task",
      confidence: "high"
    };
  }

  if (intent === "goalrun" && evaluateGoalRunRouting(text).intent !== "goalrun") {
    return evaluateInboundIntentPolicy(text, options);
  }

  return {
    intent,
    matchedRules: ["model_decision"],
    reason: "model_decision",
    confidence: "medium"
  };
}

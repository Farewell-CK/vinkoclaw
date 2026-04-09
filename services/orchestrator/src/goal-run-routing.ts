import { isSmalltalkMessage } from "./inbound-policy.js";

// GoalRun is a multi-stage autonomous pipeline (discover → plan → execute → verify → deploy → accept).
// Only route here when the instruction is a complex end-to-end objective requiring multiple stages.
// Single-step actions — even those using "deploy" or mentioning "website" — stay as regular tasks.

// These phrases unambiguously signal a full-pipeline goal regardless of context.
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

// A delivery word signals intent to ship something.
const DELIVERY_KEYWORDS = [
  "部署",
  "上线",
  "publish",
  "deploy",
  "launch"
];

// A complex objective hint signals the scope requires building something non-trivial.
// Combined with a delivery word this is a clear multi-stage goal.
const COMPLEX_OBJECTIVE_HINTS = [
  "官网",
  "网站",
  "landing page",
  "web site",
  "pipeline",
  "工作流",
  "自动化"
];

// Chained multi-step connectors — used only in combination with strong scope signals.
const MULTI_STEP_CONNECTORS = ["并且", "然后", "再", "同时", "并行", "以及", "and then"];

export function shouldRouteToGoalRun(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  if (isSmalltalkMessage(normalized)) {
    return false;
  }

  // Unambiguous full-pipeline signals always trigger GoalRun.
  if (STRONG_GOAL_KEYWORDS.some((keyword) => normalized.includes(keyword))) {
    return true;
  }

  const hasDelivery = DELIVERY_KEYWORDS.some((keyword) => normalized.includes(keyword));
  const hasComplexHint = COMPLEX_OBJECTIVE_HINTS.some((keyword) => normalized.includes(keyword));

  // Build + deploy together: the user wants to create AND ship something — multi-stage by definition.
  if (hasDelivery && hasComplexHint) {
    return true;
  }

  // Complex scope + multiple chained steps (not just delivery alone).
  const connectorCount = MULTI_STEP_CONNECTORS.filter((keyword) => normalized.includes(keyword)).length;
  if (hasComplexHint && connectorCount >= 2 && normalized.length >= 20) {
    return true;
  }

  return false;
}

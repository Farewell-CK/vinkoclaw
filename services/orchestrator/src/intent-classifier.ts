import { loadEnv, type CollaborationPlan, type RoleId, type RuntimeConfig } from "@vinko/shared";
import {
  evaluateInboundIntentPolicy,
  type InboundPolicyDecision,
  normalizeModelInboundIntent,
  type InboundIntent
} from "./inbound-policy-engine.js";

const CLASSIFIER_TIMEOUT_MS = 45_000;

const SYSTEM_PROMPT = `You are an intent classifier for an AI team operating system.
Classify the user's message into exactly one of these intents:

- goalrun: A complex end-to-end objective requiring multiple autonomous stages (discover → plan → execute → verify → deploy). Only use this when the user wants the system to autonomously drive a full pipeline, e.g. "从0到1做一个产品", "全自动完成这个项目".
- collaboration: The user EXPLICITLY asks for multiple specialist roles to work TOGETHER on ONE task — e.g. "需要前端+后端+测试一起做", "产品和研发联合出方案". NOT just because the task involves a technical area.
- light_collaboration: The user wants a quick implementation with a light quality check — e.g. "做个登录页，做完检查一下", "写个API顺便测一下", "开发一个功能然后验证", "做完让测试看一下". Pattern: build something + quick check/review/verify.
- operator_config: A request to configure, enable, disable, or set up a system capability. Examples: "开启联网搜索", "配置邮件", "切换模型", "设置 API key", "enable web search", "configure tavily", "安装技能".
- task: Everything else — a single request that one specialist can handle alone.

Critical rules:
- DEFAULT to "task". Only deviate when the evidence is explicit and unambiguous.
- Mentioning a technology (React, Node.js, 后端, 前端, API, Python) does NOT make it collaboration — it describes the task type, not the team structure.
- "帮我写一个后端API" → task (one backend specialist handles it alone).
- "帮我做一个登录页" → task (one frontend specialist handles it alone).
- "帮我写PRD" → task (one product specialist handles it alone).
- "帮我分析市场" → task (one research specialist handles it alone).
- collaboration requires the user to EXPLICITLY request multi-role coordination in the same instruction.
- light_collaboration = build + quick verify/check, not full discussion.
- Respond with ONLY one of: goalrun, collaboration, light_collaboration, operator_config, task
- No explanation, no punctuation, just the intent word.`;

function keywordFallbackDecision(
  text: string,
  options?: {
    triggerKeywords?: string[];
    evolution?: Partial<RuntimeConfig["evolution"]["intake"]>;
  }
){
  return evaluateInboundIntentPolicy(text, options);
}

function keywordFallback(
  text: string,
  options?: {
    triggerKeywords?: string[];
    evolution?: Partial<RuntimeConfig["evolution"]["intake"]>;
  }
): InboundIntent {
  return keywordFallbackDecision(text, options).intent;
}

function singleAgentFallback(
  text: string,
  options?: {
    triggerKeywords?: string[];
    evolution?: Partial<RuntimeConfig["evolution"]["intake"]>;
  }
): InboundIntent {
  const decision = evaluateInboundIntentPolicy(text, options);
  return decision.intent === "collaboration" ? "task" : decision.intent;
}

function normalizeModelIntent(
  intent: InboundIntent,
  text: string,
  options?: {
    triggerKeywords?: string[];
    evolution?: Partial<RuntimeConfig["evolution"]["intake"]>;
  }
): InboundIntent {
  const decision = normalizeModelInboundIntent(intent, text, options);
  if (decision.intent === "collaboration" || decision.intent === "goalrun") {
    return decision.intent;
  }
  if (intent === "collaboration") {
    return singleAgentFallback(text, options);
  }
  return decision.intent;
}

function normalizeModelIntentDecision(
  intent: InboundIntent,
  text: string,
  options?: {
    triggerKeywords?: string[];
    evolution?: Partial<RuntimeConfig["evolution"]["intake"]>;
  }
): InboundPolicyDecision {
  const decision = normalizeModelInboundIntent(intent, text, options);
  if (decision.intent === "collaboration" || decision.intent === "goalrun") {
    return decision;
  }
  if (intent === "collaboration") {
    return {
      intent: singleAgentFallback(text, options),
      matchedRules: ["collaboration_single_agent_fallback"],
      reason: "collaboration_single_agent_fallback",
      confidence: "high"
    };
  }
  return decision;
}

export async function classifyInboundIntentDecision(
  text: string,
  options?: {
    triggerKeywords?: string[];
    evolution?: Partial<RuntimeConfig["evolution"]["intake"]>;
  }
): Promise<InboundPolicyDecision> {
  const env = loadEnv();

  let baseUrl: string;
  let model: string;
  let apiKey: string | undefined;

  if (env.primaryBackend === "zhipu") {
    baseUrl = env.zhipuBaseUrl.replace(/\/$/, "");
    model = env.zhipuModel;
    apiKey = env.zhipuApiKey || undefined;
  } else if (env.primaryBackend === "openai") {
    baseUrl = env.openaiBaseUrl.replace(/\/$/, "");
    model = env.openaiModel;
    apiKey = env.openaiApiKey || undefined;
  } else if (env.primaryBackend === "dashscope") {
    baseUrl = env.dashscopeBaseUrl.replace(/\/$/, "");
    model = env.dashscopeModel;
    apiKey = env.dashscopeApiKey || undefined;
  } else if (env.primaryBackend === "sglang") {
    baseUrl = env.sglangBaseUrl.replace(/\/$/, "");
    model = env.sglangModel;
  } else {
    baseUrl = env.ollamaBaseUrl.replace(/\/$/, "");
    model = env.ollamaModel;
  }

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) {
    headers["authorization"] = `Bearer ${apiKey}`;
  }

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        temperature: 0,
        thinking: { type: "enabled" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: text.trim() }
        ]
      }),
      signal: AbortSignal.timeout(CLASSIFIER_TIMEOUT_MS)
    });

    if (!response.ok) {
      return keywordFallbackDecision(text, options);
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: unknown; reasoning?: unknown; reasoning_content?: unknown } }>;
    };
    const msg = payload.choices?.[0]?.message;
    const rawContent =
      typeof msg?.content === "string" && msg.content.trim() ? msg.content :
      typeof msg?.reasoning_content === "string" ? msg.reasoning_content :
      typeof msg?.reasoning === "string" ? msg.reasoning : "";
    const raw = rawContent.trim().toLowerCase();

    if (raw === "goalrun" || raw === "collaboration" || raw === "light_collaboration" || raw === "operator_config" || raw === "task") {
      return normalizeModelIntentDecision(raw, text, options);
    }

    if (raw.includes("goalrun")) return normalizeModelIntentDecision("goalrun", text, options);
    if (raw.includes("light_collaboration")) return normalizeModelIntentDecision("light_collaboration", text, options);
    if (raw.includes("collaboration")) return normalizeModelIntentDecision("collaboration", text, options);
    if (raw.includes("operator_config") || raw.includes("operator")) return normalizeModelIntentDecision("operator_config", text, options);
    if (raw.includes("task")) return normalizeModelIntentDecision("task", text, options);

    return keywordFallbackDecision(text, options);
  } catch {
    return keywordFallbackDecision(text, options);
  }
}

export async function classifyInboundIntent(
  text: string,
  options?: {
    triggerKeywords?: string[];
    evolution?: Partial<RuntimeConfig["evolution"]["intake"]>;
  }
): Promise<InboundIntent> {
  return (await classifyInboundIntentDecision(text, options)).intent;
}

// ── Collaboration need analysis ───────────────────────────────────────────────

const COLLABORATION_ANALYSIS_TIMEOUT_MS = 60_000;

const COLLABORATION_SYSTEM_PROMPT = `You are a collaboration planner for an AI team operating system.
Analyze the user's task and output a JSON object deciding what level of multi-agent collaboration is needed.

Collaboration levels:
- "none": Simple/trivial task, one agent handles it directly. Short requests, single domain, clear requirements.
- "light": Moderate complexity, needs a quality check after primary execution. Multi-step, some ambiguity, moderate risk.
- "standard": Complex or cross-domain task requiring parallel expert review. High complexity, 2+ domains, or meaningful risk.
- "full": High-stakes task needing human confirmation. Production changes, external communication, financial impact, or irreversible actions.

Complexity:
- "trivial": < 3 steps, completely clear, no risk
- "simple": 3-6 steps, mostly clear, low risk
- "moderate": 6-12 steps, some ambiguity, or affects multiple systems
- "complex": 12+ steps, significant ambiguity, cross-domain, or high stakes

Risk:
- "low": Reversible, internal, no external impact
- "medium": Affects multiple systems, moderate coordination needed
- "high": Production, external users, data integrity, financial, or hard to reverse

For suggestedReviewers: pick from [qa, cto, product, research, engineer, operations, frontend, backend, uiux, algorithm].
- Empty array for "none" level
- 1 reviewer for "light" (best domain match)
- 2 reviewers for "standard" (complementary perspectives)
- 2-3 reviewers for "full"

Output ONLY valid JSON, no explanation:
{"level":"none","complexity":"trivial","risk":"low","suggestedReviewers":[],"rationale":"short explanation"}`;

function collaborationFallback(
  text: string,
  options?: {
    triggerKeywords?: string[];
    evolution?: Partial<RuntimeConfig["evolution"]["intake"]>;
  }
): CollaborationPlan {
  const intent = keywordFallback(text, options);
  if (intent === "light_collaboration") {
    return { level: "light", complexity: "simple", risk: "low", suggestedReviewers: [], rationale: "keyword_fallback" };
  }
  if (intent === "collaboration") {
    return { level: "standard", complexity: "moderate", risk: "medium", suggestedReviewers: [], rationale: "keyword_fallback" };
  }
  return { level: "none", complexity: "trivial", risk: "low", suggestedReviewers: [], rationale: "keyword_fallback" };
}

// Quick bypass: short text with no technical domain signals → definitely "none"
const TECH_SIGNAL_RE = /架构|重构|系统|模块|设计|数据库|API|接口|安全|部署|生产|迁移|支付|认证|授权|性能|优化|前端|后端|测试|代码|开发|实现|集成|方案|分析|调研|strategy|architecture|refactor|migrate|deploy|payment|authentication|production|database/i;

function isTrivialByLength(text: string): boolean {
  return text.trim().length < 25 && !TECH_SIGNAL_RE.test(text);
}

function parseCollaborationPlan(raw: string): CollaborationPlan | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]) as Record<string, unknown>;
    const level = obj.level;
    if (level !== "none" && level !== "light" && level !== "standard" && level !== "full") return null;
    const complexity = obj.complexity;
    if (complexity !== "trivial" && complexity !== "simple" && complexity !== "moderate" && complexity !== "complex") return null;
    const risk = obj.risk;
    if (risk !== "low" && risk !== "medium" && risk !== "high") return null;
    const reviewers = Array.isArray(obj.suggestedReviewers)
      ? (obj.suggestedReviewers as unknown[]).filter((r): r is RoleId => typeof r === "string")
      : [];
    return {
      level,
      complexity,
      risk,
      suggestedReviewers: reviewers,
      rationale: typeof obj.rationale === "string" ? obj.rationale : ""
    };
  } catch {
    return null;
  }
}

export async function analyzeCollaborationNeed(
  text: string,
  options?: {
    triggerKeywords?: string[];
    evolution?: Partial<RuntimeConfig["evolution"]["intake"]>;
  }
): Promise<CollaborationPlan> {
  // Fast path: trivially short messages need no LLM call
  if (isTrivialByLength(text)) {
    return { level: "none", complexity: "trivial", risk: "low", suggestedReviewers: [], rationale: "trivial_shortcut" };
  }

  const env = loadEnv();
  let baseUrl: string;
  let model: string;
  let apiKey: string | undefined;

  if (env.primaryBackend === "zhipu") {
    baseUrl = env.zhipuBaseUrl.replace(/\/$/, "");
    model = env.zhipuModel;
    apiKey = env.zhipuApiKey || undefined;
  } else if (env.primaryBackend === "openai") {
    baseUrl = env.openaiBaseUrl.replace(/\/$/, "");
    model = env.openaiModel;
    apiKey = env.openaiApiKey || undefined;
  } else if (env.primaryBackend === "dashscope") {
    baseUrl = env.dashscopeBaseUrl.replace(/\/$/, "");
    model = env.dashscopeModel;
    apiKey = env.dashscopeApiKey || undefined;
  } else if (env.primaryBackend === "sglang") {
    baseUrl = env.sglangBaseUrl.replace(/\/$/, "");
    model = env.sglangModel;
  } else {
    baseUrl = env.ollamaBaseUrl.replace(/\/$/, "");
    model = env.ollamaModel;
  }

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) {
    headers["authorization"] = `Bearer ${apiKey}`;
  }

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        temperature: 0,
        thinking: { type: "enabled" },
        messages: [
          { role: "system", content: COLLABORATION_SYSTEM_PROMPT },
          { role: "user", content: text.trim() }
        ]
      }),
      signal: AbortSignal.timeout(COLLABORATION_ANALYSIS_TIMEOUT_MS)
    });

    if (!response.ok) {
      return collaborationFallback(text, options);
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: unknown; reasoning?: unknown; reasoning_content?: unknown } }>;
    };
    const msg = payload.choices?.[0]?.message;
    // For GLM-5/thinking models: prefer content (final answer) over reasoning_content (CoT).
    // Only fall back to reasoning_content if content is empty/null.
    const rawContent =
      typeof msg?.content === "string" && msg.content.trim() ? msg.content :
      typeof msg?.reasoning_content === "string" ? msg.reasoning_content :
      typeof msg?.reasoning === "string" ? msg.reasoning : "";

    const plan = parseCollaborationPlan(rawContent);
    if (plan) return plan;

    console.error("[analyzeCollaborationNeed] rawContent len:", rawContent.length);
    console.error("[analyzeCollaborationNeed] content[:800]:", rawContent.slice(0, 800));
    return collaborationFallback(text, options);
  } catch (err) {
    console.error("[analyzeCollaborationNeed] exception:", (err as Error)?.message, "cause:", (err as Error)?.cause);
    return collaborationFallback(text, options);
  }
}

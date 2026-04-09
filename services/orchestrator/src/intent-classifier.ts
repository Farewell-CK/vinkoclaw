import { loadEnv } from "@vinko/shared";
import { shouldRouteToGoalRun } from "./goal-run-routing.js";
import { shouldUseTeamCollaboration } from "./inbound-policy.js";

export type InboundIntent = "goalrun" | "collaboration" | "operator_config" | "task";

const CLASSIFIER_TIMEOUT_MS = 15_000;

const SYSTEM_PROMPT = `You are an intent classifier for an AI team operating system.
Classify the user's message into exactly one of these intents:

- goalrun: A complex end-to-end objective requiring multiple autonomous stages (discover → plan → execute → verify → deploy). Only use this when the user wants the system to autonomously drive a full pipeline, e.g. "从0到1做一个产品", "全自动完成这个项目".
- collaboration: The user EXPLICITLY asks for multiple specialist roles to work TOGETHER on ONE task — e.g. "需要前端+后端+测试一起做", "产品和研发联合出方案". NOT just because the task involves a technical area.
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
- Respond with ONLY one of: goalrun, collaboration, operator_config, task
- No explanation, no punctuation, just the intent word.`;

function keywordFallback(
  text: string,
  options?: { triggerKeywords?: string[] }
): InboundIntent {
  if (shouldRouteToGoalRun(text)) {
    return "goalrun";
  }
  if (shouldUseTeamCollaboration(text, options)) {
    return "collaboration";
  }
  // Keyword fallback for operator_config — catches common patterns the LLM missed
  const normalized = text.trim().toLowerCase();
  if (
    /(?:配置|设置|开通|启用|安装|增加|需要|开启|禁用|关闭|切换).*(?:搜索|模型|技能|邮件|api.?key|密钥|能力)/i.test(normalized) ||
    /(?:搜索|模型|技能|邮件).*(?:配置|设置|开通|启用)/i.test(normalized) ||
    /(?:set|enable|disable|configure|install)\s+(?:\w+\s+)*(?:search|model|skill|email|api.?key)/i.test(normalized) ||
    /web\s*search/i.test(normalized)
  ) {
    return "operator_config";
  }
  return "task";
}

export async function classifyInboundIntent(
  text: string,
  options?: { triggerKeywords?: string[] }
): Promise<InboundIntent> {
  const env = loadEnv();

  let baseUrl: string;
  let model: string;
  let apiKey: string | undefined;

  if (env.primaryBackend === "zhipu") {
    baseUrl = env.zhipuBaseUrl.replace(/\/$/, "");
    model = env.zhipuModel;
    apiKey = env.zhipuApiKey || undefined;
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
        max_tokens: 8,
        // Disable thinking/reasoning mode for thinking models (e.g. Qwen3) so the
        // classifier returns content directly instead of burning tokens on CoT.
        chat_template_kwargs: { enable_thinking: false },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: text.trim() }
        ]
      }),
      signal: AbortSignal.timeout(CLASSIFIER_TIMEOUT_MS)
    });

    if (!response.ok) {
      return keywordFallback(text, options);
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: unknown; reasoning?: unknown } }>;
    };
    // Thinking models (e.g. Qwen3) may return content=null and put the answer in reasoning field
    const msg = payload.choices?.[0]?.message;
    const rawContent =
      typeof msg?.content === "string" ? msg.content :
      typeof msg?.reasoning === "string" ? msg.reasoning : "";
    const raw = rawContent.trim().toLowerCase();

    if (raw === "goalrun" || raw === "collaboration" || raw === "operator_config" || raw === "task") {
      return raw;
    }

    // Model returned something unexpected — extract the first known intent word
    if (raw.includes("goalrun")) return "goalrun";
    if (raw.includes("collaboration")) return "collaboration";
    if (raw.includes("operator_config") || raw.includes("operator")) return "operator_config";
    if (raw.includes("task")) return "task";

    return keywordFallback(text, options);
  } catch {
    return keywordFallback(text, options);
  }
}

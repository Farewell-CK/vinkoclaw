import { loadEnv } from "@vinko/shared";

const INTAKE_ANALYZER_TIMEOUT_MS = 8_000;

export interface IntakeAnalysis {
  isClear: boolean;
  clarifyingQuestions: string[];
}

const SYSTEM_PROMPT = `You are a requirements analyst for an AI team operating system.
Analyze the user's task request and determine whether it contains enough detail to produce a high-quality deliverable.

A request is CLEAR when it specifies:
- The core deliverable (what to build/write/analyze)
- Enough constraints that a specialist can start without guessing (scope, tech stack, format, audience, etc.)

A request is UNCLEAR when critical dimensions are ambiguous:
- "做一个登录系统" — unclear: what auth method? what tech stack? registration needed?
- "写一份PRD" — unclear: for what product? target users? core features?
- "分析竞品" — unclear: which competitors? what dimensions? what output format?

A request IS clear when it is specific enough:
- "用 React + Firebase Auth 做一个邮箱登录页，不需要注册" — clear
- "写一份针对高校学生的记账App PRD，覆盖核心流程和MVP范围" — clear
- "帮我修复登录页的样式问题" — clear (bug fix, no ambiguity)
- "你好" / "在吗" / simple greetings — treat as CLEAR (do not ask questions for greetings)

Short direct commands, bug fixes, status queries, and greetings are always CLEAR.

Output ONLY valid JSON (no code fences, no explanation):
{ "isClear": true }
or
{ "isClear": false, "clarifyingQuestions": ["问题1", "问题2", "问题3"] }

Rules:
- Maximum 3 questions.
- Questions must be in the same language as the user's message.
- Questions should be specific and actionable, not generic.
- Ask ONLY for information that would significantly change the output quality.
- Do NOT ask questions for simple/direct requests, greetings, config commands, or bug reports.`;

/**
 * Fast heuristic: messages that are obviously clear and should skip LLM analysis.
 * Covers greetings, status queries, config commands, short direct requests, bug fixes.
 */
export function isObviouslyClear(text: string): boolean {
  const trimmed = text.trim();
  // Ultra-short non-task messages (confirmations, single-word replies)
  if (trimmed.length <= 3) {
    return true;
  }
  // Greetings and smalltalk
  if (/^(?:你好|您好|嗨|哈喽|hello|hi|hey|在吗|在不在|早上好|中午好|下午好|晚上好|谢谢|多谢|thx|thanks)(?:呀|啊|哈|呢|啦|嘛|哇)?[!！。.]*$/i.test(trimmed)) {
    return true;
  }
  // Bug fix requests (specific enough)
  if (/(?:修复|修改|fix|修正|解决).*(?:bug|问题|错误|报错|异常|issue)/i.test(trimmed)) {
    return true;
  }
  // Config/operator commands
  if (/(?:配置|设置|开通|启用|安装|禁用|关闭|切换|set|enable|disable|configure|install)/i.test(trimmed)) {
    return true;
  }
  // Status queries
  if (/(?:进度|状态|怎么样了|做到哪了|进展|status|progress)/i.test(trimmed)) {
    return true;
  }
  // Template toggle commands
  if (/(?:启用|停用|enable|disable)\s*(?:模板|template)/i.test(trimmed)) {
    return true;
  }
  // Approval commands
  if (/^[01]\s/.test(trimmed) || /^(?:同意|拒绝|批准|approve|reject)/i.test(trimmed)) {
    return true;
  }
  return false;
}

/**
 * Analyze whether the user's task instruction is specific enough to produce
 * a high-quality deliverable. If not, returns clarifying questions.
 *
 * Falls back to { isClear: true } on timeout or LLM error (preserving existing behavior).
 */
export async function analyzeIntakeClarity(text: string): Promise<IntakeAnalysis> {
  if (isObviouslyClear(text)) {
    return { isClear: true, clarifyingQuestions: [] };
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
        max_tokens: 256,
        chat_template_kwargs: { enable_thinking: false },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: text.trim() }
        ]
      }),
      signal: AbortSignal.timeout(INTAKE_ANALYZER_TIMEOUT_MS)
    });

    if (!response.ok) {
      return { isClear: true, clarifyingQuestions: [] };
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: unknown; reasoning?: unknown } }>;
    };
    const msg = payload.choices?.[0]?.message;
    const rawContent =
      typeof msg?.content === "string" ? msg.content :
      typeof msg?.reasoning === "string" ? msg.reasoning : "";
    const cleaned = rawContent.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");

    const parsed = safeParseIntakeAnalysis(cleaned);
    return parsed;
  } catch {
    // Timeout or network error — degrade gracefully to existing behavior
    return { isClear: true, clarifyingQuestions: [] };
  }
}

function safeParseIntakeAnalysis(raw: string): IntakeAnalysis {
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const isClear = obj.isClear === true;
    if (isClear) {
      return { isClear: true, clarifyingQuestions: [] };
    }
    const questions = Array.isArray(obj.clarifyingQuestions)
      ? obj.clarifyingQuestions
          .filter((q): q is string => typeof q === "string")
          .map((q) => q.trim())
          .filter(Boolean)
          .slice(0, 3)
      : [];
    if (questions.length === 0) {
      return { isClear: true, clarifyingQuestions: [] };
    }
    return { isClear: false, clarifyingQuestions: questions };
  } catch {
    return { isClear: true, clarifyingQuestions: [] };
  }
}

/**
 * Merge the original instruction with clarification answers into an enriched instruction.
 */
export function mergeClarificationResponse(
  originalText: string,
  questions: string[],
  userResponse: string
): string {
  const parts = [originalText.trim()];
  parts.push("");
  parts.push("补充信息（用户确认）：");
  for (let i = 0; i < questions.length; i++) {
    parts.push(`- ${questions[i]}`);
  }
  parts.push(`用户回复：${userResponse.trim()}`);
  return parts.join("\n");
}

/**
 * Format clarifying questions into a user-facing message.
 */
export function formatClarificationMessage(questions: string[]): string {
  const lines = ["在开始之前，我需要确认几个关键信息，以便给你更好的结果："];
  for (let i = 0; i < questions.length; i++) {
    lines.push(`${i + 1}. ${questions[i]}`);
  }
  lines.push("");
  lines.push("请直接回复以上问题，我会根据你的回答创建任务。");
  return lines.join("\n");
}

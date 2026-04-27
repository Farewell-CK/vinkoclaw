import { LocalModelClient } from "@vinko/agent-runtime";
import type { RoleId, RuntimeConfig } from "@vinko/shared";

interface ConversationConfig {
  getDefaultParticipants: () => RoleId[];
  formatRoleLabel: (roleId: RoleId) => string;
  shouldRouteToGoalRun: (text: string) => boolean;
  hasActionIntent: (text: string) => boolean;
  normalizeConversationCandidate: (text: string) => string;
  shorten: (text: string, max?: number) => string;
  evolution?: Partial<RuntimeConfig["evolution"]["intake"]> | undefined;
}

function buildDirectConversationReply(text: string, config: ConversationConfig): string {
  const compact = config.normalizeConversationCandidate(text).toLowerCase().replace(/\s+/g, "");
  if (compact.includes("你是谁")) {
    return "我是 VinkoClaw 的执行入口。你可以把我当成随身 AI 执行团队的总入口。";
  }
  if (compact.includes("你能做什么") || compact.includes("你可以做什么") || compact.includes("会做什么")) {
    return "我可以帮你把目标拆成可执行任务，并持续推进到交付。";
  }
  if (
    compact.includes("团队有多少人") ||
    compact.includes("介绍你们团队") ||
    compact.includes("介绍一下你们团队") ||
    compact.includes("团队都有谁") ||
    compact.includes("团队是谁")
  ) {
    const participants = config.getDefaultParticipants();
    return `当前默认协作角色有：${participants.map((roleId) => config.formatRoleLabel(roleId)).join("、")}。`;
  }
  if (compact.includes("你是个笨蛋") || compact.includes("你好笨") || compact.includes("太慢") || compact.includes("不理我")) {
    return "收到。我会少说空话，直接给结论、动作和结果。";
  }
  if (compact.includes("在吗") || compact.includes("在不在")) {
    return "在。你直接给目标即可。";
  }
  if (compact.includes("为什么") || compact.includes("啥意思") || compact.includes("什么意思")) {
    return "你直接说具体问题，我会给简短结论和下一步动作。";
  }
  return "我在。你直接说目标结果即可。";
}

function isAmbiguousShortConversationCandidate(text: string, config: ConversationConfig): boolean {
  const normalized = config.normalizeConversationCandidate(text);
  const maxLength = normalizeLength(config.evolution?.ambiguousConversationMaxLength, 32, 8, 160);
  if (!normalized || normalized.length > maxLength) {
    return false;
  }
  if (config.shouldRouteToGoalRun(normalized) || config.hasActionIntent(normalized)) {
    return false;
  }
  return true;
}

export function isDirectConversationTurn(
  text: string,
  config: Pick<ConversationConfig, "normalizeConversationCandidate" | "shouldRouteToGoalRun" | "hasActionIntent" | "evolution">
): boolean {
  const normalized = config.normalizeConversationCandidate(text);
  if (!normalized) {
    return false;
  }
  if (config.shouldRouteToGoalRun(normalized)) {
    return false;
  }
  if (config.hasActionIntent(normalized)) {
    return false;
  }
  const compact = normalized.toLowerCase().replace(/\s+/g, "");
  const conversationPatterns = [
    "你是谁",
    "你能做什么",
    "你可以做什么",
    "会做什么",
    "介绍一下你们团队",
    "介绍你们团队",
    "团队都有谁",
    "团队是谁",
    "团队有多少人",
    "为什么",
    "啥意思",
    "什么意思",
    "你是个笨蛋",
    "你好笨",
    "太慢",
    "不理我",
    "在吗",
    "在不在"
  ];
  const maxLength = normalizeLength(config.evolution?.directConversationMaxLength, 24, 8, 120);
  if (conversationPatterns.some((keyword) => compact.includes(keyword)) && normalized.length <= maxLength) {
    return true;
  }
  return /(?:你|团队|我们|为什么|怎么|啥|什么|在吗|介绍)[^。！？!?]{0,30}[?？]?$/.test(normalized) && normalized.length <= maxLength;
}

export async function buildConversationReplyWithModel(
  text: string,
  config: ConversationConfig,
  client = new LocalModelClient()
): Promise<string> {
  const fallback = buildDirectConversationReply(text, config);
  try {
    const completion = await client.complete([
      {
        role: "system",
        content: [
          "你是 VinkoClaw 的飞书入口，用户是个人创业者 CEO。",
          "当前消息是开放式对话，不是明确任务；不要创建任务、不要假装已开始执行。",
          "自然回应用户真实情绪或追问，像靠谱同事，不要模板腔。",
          "如果缺少目标，只用一句话引导用户给具体目标。",
          "如果用户在批评你，先承认问题，再说你会怎么改，不要防御。",
          "中文回复，80 字以内。"
        ].join("\n")
      },
      {
        role: "user",
        content: text
      }
    ]);
    const reply = completion.text.trim();
    return reply ? config.shorten(reply.replace(/\s+/g, " "), 120) : fallback;
  } catch {
    return fallback;
  }
}

export async function classifyAmbiguousConversationWithModel(
  text: string,
  config: Pick<ConversationConfig, "normalizeConversationCandidate" | "shouldRouteToGoalRun" | "hasActionIntent" | "evolution">,
  client = new LocalModelClient()
): Promise<boolean> {
  if (!isAmbiguousShortConversationCandidate(text, {
    ...config,
    getDefaultParticipants: () => [],
    formatRoleLabel: (roleId) => roleId,
    shorten: (value) => value
  })) {
    return false;
  }
  try {
    const completion = await client.complete([
      {
        role: "system",
        content: [
          "判断用户消息是否只是对话/反馈/追问，而不是要创建工作任务。",
          "如果是对话、情绪反馈、质疑、闲聊、单独问号，返回 true。",
          "如果是潜在任务名、需求主题、待办标题、文档标题，返回 false。",
          "只输出 JSON：{\"conversation\":true|false}"
        ].join("\n")
      },
      {
        role: "user",
        content: text
      }
    ]);
    const match = completion.text.match(/\{[\s\S]*\}/);
    if (!match) {
      return false;
    }
    const parsed = JSON.parse(match[0]) as { conversation?: unknown };
    return parsed.conversation === true;
  } catch {
    return false;
  }
}

function normalizeLength(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

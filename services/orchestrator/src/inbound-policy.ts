import { type OperatorActionRecord, type RoleId, type TaskSource } from "@vinko/shared";

const SMALLTALK_ONLY_PATTERN =
  /^(?:你好|您好|嗨|哈喽|hello|hi|hey|在吗|在不在|早上好|中午好|下午好|晚上好|谢谢|多谢|thx|thanks|thankyou|辛苦了)(?:呀|啊|哈|呢|啦|嘛|哇)?$/i;
const ACTION_INTENT_PATTERN =
  /(?:帮我|请|配置|设置|安装|新增|添加|删除|移除|创建|调研|分析|写|做|处理|执行|安排|切换|启用|禁用|run|install|set|configure|add|remove|delete|create|search)/i;
const COLLABORATION_INTENT_PATTERN =
  /(?:帮我|请|做|开发|设计|实现|搭建|重构|优化|排查|修复|规划|计划|调研|分析|上线|部署|落地|推进|协作|团队|build|implement|design|develop|plan|research|deploy|fix)/i;
const QUICK_SINGLE_TURN_PATTERN =
  /(?:简短|一句话|简要|简洁|解释|是什么|为什么|多少|进度|状态|在吗|你可以做什么|你能做什么)/i;
const COLLABORATION_OPT_OUT_PATTERN =
  /(?:不要|不用|不需要|无需|别)(?:团队|多角色|多人)?(?:协作|合作|分工)?|(?:直接|独立|单人|单角色)(?:处理|执行|完成|输出|回复)/i;
const DOCUMENT_DELIVERABLE_PATTERN =
  /(?:\bprd\b|产品需求|需求文档|产品文档|调研报告|研究报告|分析报告|可行性报告|市场调研|竞品分析|方案文档|roadmap|里程碑|验收标准)/i;
const EXPLICIT_TEAM_REQUEST_PATTERN =
  /(?:团队协作|协作执行|多角色|多人协作|团队分工|前后端|ui设计|ux设计|qa测试|全栈团队)/i;
const THANKS_PATTERN = /^(?:谢谢|多谢|thx|thanks|thankyou|辛苦了)/i;
const PRESENCE_PATTERN = /^(?:在吗|在不在)/i;
const CONTINUE_PATTERN = /^(?:继续|请继续|继续推进|继续处理|继续执行|go\s*on|continue)(?:吧|呀|一下|下去)?$/i;

const OWNER_LOW_RISK_RUNTIME_SETTING_KEYS = new Set([
  "SEARCH_PROVIDER",
  "SEARCH_MAX_RESULTS",
  "TAVILY_API_KEY",
  "SERPAPI_API_KEY",
  "FEISHU_RESOLVE_SENDER_NAMES",
  "FEISHU_ACK_MODE"
]);
const OWNER_LOW_RISK_SEARCH_PROVIDER_IDS = new Set(["tavily", "serpapi"]);
const OWNER_LOW_RISK_SKILL_IDS = new Set([
  "vector-memory",
  "workspace-retrieval",
  "email-ops",
  "feishu-ops",
  "web-search",
  "reflection-review"
]);

export function isSmalltalkMessage(text: string): boolean {
  const normalized = normalizeSmalltalkCandidate(text);
  if (!normalized) {
    return false;
  }
  if (ACTION_INTENT_PATTERN.test(normalized)) {
    return false;
  }

  const compact = compactSmalltalk(normalized);
  return SMALLTALK_ONLY_PATTERN.test(compact);
}

export function buildSmalltalkReply(text: string): string {
  const compact = compactSmalltalk(normalizeSmalltalkCandidate(text));
  if (THANKS_PATTERN.test(compact)) {
    return "不客气，我在。你可以直接告诉我接下来要处理的任务。";
  }
  if (PRESENCE_PATTERN.test(compact)) {
    return "在的，我在线。你可以直接下达任务。";
  }
  return "你好，我在。你可以直接说你的需求。";
}

export function isContinueSignal(text: string): boolean {
  const normalized = normalizeSmalltalkCandidate(text);
  if (!normalized) {
    return false;
  }
  const compact = compactSmalltalk(normalized);
  if (compact === "继续" || compact === "请继续" || compact === "继续推进" || compact === "继续处理" || compact === "继续执行") {
    return true;
  }
  return CONTINUE_PATTERN.test(normalized);
}

export function shouldUseTeamCollaboration(
  text: string,
  options?: {
    triggerKeywords?: string[] | undefined;
  }
): boolean {
  const normalized = text.trim();
  if (!normalized) {
    return false;
  }

  if (COLLABORATION_OPT_OUT_PATTERN.test(normalized)) {
    return false;
  }

  const normalizedText = normalized.toLowerCase();
  const triggerKeywords = options?.triggerKeywords ?? [];
  if (
    triggerKeywords.some((keyword) => {
      const candidate = keyword.trim().toLowerCase();
      return Boolean(candidate) && normalizedText.includes(candidate);
    })
  ) {
    return true;
  }

  if (!COLLABORATION_INTENT_PATTERN.test(normalized)) {
    return false;
  }

  if (DOCUMENT_DELIVERABLE_PATTERN.test(normalized) && !EXPLICIT_TEAM_REQUEST_PATTERN.test(normalized)) {
    return false;
  }

  if (QUICK_SINGLE_TURN_PATTERN.test(normalized)) {
    return false;
  }

  // Collaboration requires both an explicit team signal AND sufficient complexity.
  // A short instruction that merely contains a verb like "开发" or "设计" is a single task, not a team effort.
  // Require explicit team role mention OR instruction long enough to plausibly need multiple specialists.
  if (EXPLICIT_TEAM_REQUEST_PATTERN.test(normalized)) {
    return true;
  }

  return normalized.length >= 40;
}

function normalizeSmalltalkCandidate(text: string): string {
  let normalized = text.trim();
  if (!normalized) {
    return "";
  }
  const stripPatterns = [
    /^@[\w\u4e00-\u9fa5-]{1,32}\s*/i,
    /^[\w\u4e00-\u9fa5-]{1,32}\s*[:：]\s*/i
  ];
  for (const pattern of stripPatterns) {
    const next = normalized.replace(pattern, "").trim();
    if (next && next !== normalized) {
      normalized = next;
    }
  }
  return normalized;
}

function compactSmalltalk(text: string): string {
  return text
    .toLowerCase()
    .replace(/[，。！？!?,.~～\s]/g, "")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "");
}

export function isOwnerRequester(input: {
  source: TaskSource;
  requestedBy?: string | undefined;
  ownerOpenIds: string[];
}): boolean {
  const requester = input.requestedBy?.trim();
  if (!requester) {
    return false;
  }
  if (requester.toLowerCase() === "owner") {
    return true;
  }
  if (input.source !== "feishu") {
    return false;
  }
  return input.ownerOpenIds.some((openId) => openId === requester);
}

export function isOwnerLowRiskOperatorAction(action: OperatorActionRecord): boolean {
  switch (action.kind) {
    case "add_agent_instance":
    case "remove_agent_instance":
    case "set_agent_tone_policy":
      return true;
    case "install_skill":
    case "disable_skill":
      return Boolean(
        action.targetRoleId && action.skillId && OWNER_LOW_RISK_SKILL_IDS.has(action.skillId.trim().toLowerCase())
      );
    case "set_runtime_setting": {
      const key = typeof action.payload.key === "string" ? action.payload.key.trim().toUpperCase() : "";
      return OWNER_LOW_RISK_RUNTIME_SETTING_KEYS.has(key);
    }
    case "set_tool_provider_config": {
      const providerId =
        typeof action.payload.providerId === "string" ? action.payload.providerId.trim().toLowerCase() : "";
      return OWNER_LOW_RISK_SEARCH_PROVIDER_IDS.has(providerId);
    }
    default:
      return false;
  }
}

function resolveRoleFromExplicitToken(token: string): RoleId | undefined {
  const normalized = token.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "ceo" || normalized.includes("总裁") || normalized.includes("老板")) return "ceo";
  if (normalized === "cto" || normalized.includes("技术总监")) return "cto";
  if (normalized === "product" || normalized === "pm" || normalized.includes("产品")) return "product";
  if (normalized === "uiux" || normalized === "ui" || normalized === "ux" || normalized.includes("交互")) return "uiux";
  if (normalized === "frontend" || normalized.includes("前端")) return "frontend";
  if (normalized === "backend" || normalized.includes("后端")) return "backend";
  if (normalized === "algorithm" || normalized.includes("算法")) return "algorithm";
  if (normalized === "qa" || normalized === "test" || normalized.includes("测试")) return "qa";
  if (normalized === "developer" || normalized === "dev" || normalized.includes("开发人员")) return "developer";
  if (normalized === "engineering" || normalized === "engineer" || normalized === "研发" || normalized.includes("工程")) {
    return "engineering";
  }
  if (normalized === "research" || normalized.includes("研究")) return "research";
  if (normalized === "operations" || normalized === "ops" || normalized.includes("运营")) return "operations";
  return undefined;
}

export function resolveExplicitRoleDirective(text: string): RoleId | undefined {
  const directivePatterns = [
    /(?:让|由|交给|分配给|安排给|安排)\s*([a-zA-Z\u4e00-\u9fa5-]{2,20})\s*(?:同学|助理|agent|来|先|负责|处理)?/gi,
    /请(?:由)?\s*(ceo|cto|product|pm|uiux|ui|ux|frontend|backend|algorithm|qa|developer|engineering|research|operations|总裁|老板|技术总监|产品|交互|前端|后端|算法|测试|开发人员|工程|研究|运营)\s*(?:同学|助理|agent|来|先|负责|处理)?/gi,
    /(?:assign|route|delegate)\s+(?:to\s+)?([a-z-]{2,20})/gi
  ];
  for (const pattern of directivePatterns) {
    for (const match of text.matchAll(pattern)) {
      const candidate = (match[1] ?? "").trim();
      const roleId = resolveRoleFromExplicitToken(candidate);
      if (roleId) {
        return roleId;
      }
    }
  }
  return undefined;
}

export function resolveCollaborationEntryRole(text: string): RoleId {
  const explicitRole = resolveExplicitRoleDirective(text);
  return explicitRole ?? "ceo";
}

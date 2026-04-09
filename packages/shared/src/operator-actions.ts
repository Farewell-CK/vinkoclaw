import { resolveRoleId } from "./roles.js";
import {
  resolveSearchProviderApiKeyEnv,
  resolveSearchProviderId
} from "./search-policy.js";
import { resolveSkillId } from "./skills.js";
import type {
  CreateOperatorActionInput,
  MemoryBackend,
  ParsedOperatorAction,
  RoleId
} from "./types.js";

function normalize(text: string): string {
  return text.trim().toLowerCase();
}

function resolveBackend(input: string): MemoryBackend | undefined {
  const normalized = normalize(input);

  if (
    normalized.includes("vector") ||
    normalized.includes("向量数据库") ||
    normalized.includes("向量库")
  ) {
    return "vector-db";
  }

  if (normalized.includes("sqlite") || normalized.includes("本地")) {
    return "sqlite";
  }

  if (normalized.includes("关闭") || normalized.includes("none")) {
    return "none";
  }

  return undefined;
}

function findRoleInText(text: string): RoleId | undefined {
  return resolveRoleId(text);
}

function findSearchProviderInText(text: string): "tavily" | "serpapi" | undefined {
  return resolveSearchProviderId(text);
}

function isSecretSettingKey(key: string): boolean {
  return /(KEY|SECRET|TOKEN|PASSWORD)$/i.test(key) || key.toUpperCase() === "SMTP_URL";
}

interface ToolModelPreset {
  modelId: string;
  baseUrl?: string | undefined;
  apiKeyEnv?: string | undefined;
  requiresApiKey: boolean;
}

function looksLikeModelToken(value: string): boolean {
  return /[\/:-]/.test(value) || /(glm|gpt|claude|deepseek|qwen|llama|gemini)/i.test(value);
}

function resolveToolModelPreset(rawModel: string): ToolModelPreset | undefined {
  const token = rawModel.trim();
  if (!token) {
    return undefined;
  }

  const normalized = token.toLowerCase();
  if (
    normalized === "glm-5" ||
    normalized === "glm5" ||
    normalized === "zhipuai/glm-5" ||
    normalized === "glm"
  ) {
    return {
      modelId: "zhipuai/glm-5",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      apiKeyEnv: "ZHIPUAI_API_KEY",
      requiresApiKey: true
    };
  }

  if (
    normalized === "local-qwen" ||
    normalized === "本地qwen" ||
    normalized.includes("qwen3.5-35b-a3b")
  ) {
    return {
      modelId: "Qwen3.5-35B-A3B",
      baseUrl: "http://127.0.0.1:8000/v1",
      requiresApiKey: false
    };
  }

  if (!looksLikeModelToken(token)) {
    return undefined;
  }

  return {
    modelId: token,
    apiKeyEnv: "OPENAI_API_KEY",
    requiresApiKey: true
  };
}

function parseApiKeyCommand(text: string): { providerId: string; apiKeyEnv: string; apiKey: string } | undefined {
  const normalized = text.trim();

  const patterns: Array<{ regex: RegExp; providerId: "opencode" | "codex" | "claude"; apiKeyEnv: string }> = [
    {
      regex: /(?:设置|配置|更新)\s*(?:zhipu|glm)\s*(?:api[-_\s]?key|密钥)\s*(?:为|是|=|:)\s*(\S+)/i,
      providerId: "opencode",
      apiKeyEnv: "ZHIPUAI_API_KEY"
    },
    {
      regex: /(?:设置|配置|更新)\s*(?:openai)\s*(?:api[-_\s]?key|密钥)\s*(?:为|是|=|:)\s*(\S+)/i,
      providerId: "opencode",
      apiKeyEnv: "OPENAI_API_KEY"
    },
    {
      regex: /(?:设置|配置|更新)\s*(?:opencode)\s*(?:api[-_\s]?key|密钥)\s*(?:为|是|=|:)\s*(\S+)/i,
      providerId: "opencode",
      apiKeyEnv: "OPENCODE_API_KEY"
    },
    {
      regex: /(?:设置|配置|更新)\s*(?:anthropic|claude)\s*(?:api[-_\s]?key|密钥)\s*(?:为|是|=|:)\s*(\S+)/i,
      providerId: "claude",
      apiKeyEnv: "ANTHROPIC_API_KEY"
    },
    {
      regex: /set\s+(zhipu|openai|opencode|anthropic|claude)\s+api[-_\s]?key\s*(?:to|=|:)\s*(\S+)/i,
      providerId: "opencode",
      apiKeyEnv: "OPENCODE_API_KEY"
    }
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern.regex);
    if (!match) {
      continue;
    }
    const vendor = match[1]?.toLowerCase();
    const apiKeyRaw = patterns[4] === pattern ? match[2] : match[1];
    const apiKey = (apiKeyRaw ?? "").replace(/^["'`]+|["'`]+$/g, "").trim();
    if (!apiKey) {
      continue;
    }

    if (patterns[4] === pattern) {
      if (vendor === "zhipu") {
        return { providerId: "opencode", apiKeyEnv: "ZHIPUAI_API_KEY", apiKey };
      }
      if (vendor === "openai") {
        return { providerId: "opencode", apiKeyEnv: "OPENAI_API_KEY", apiKey };
      }
      if (vendor === "anthropic" || vendor === "claude") {
        return { providerId: "claude", apiKeyEnv: "ANTHROPIC_API_KEY", apiKey };
      }
      return { providerId: "opencode", apiKeyEnv: "OPENCODE_API_KEY", apiKey };
    }

    return {
      providerId: pattern.providerId,
      apiKeyEnv: pattern.apiKeyEnv,
      apiKey
    };
  }

  return undefined;
}

function createAction(action: CreateOperatorActionInput): ParsedOperatorAction {
  return {
    action,
    needsApproval: true
  };
}

export interface OperatorConfigInputRequirement {
  message: string;
  missingField: string;
  expectedCommand: string;
}

export function summarizeOperatorAction(action: CreateOperatorActionInput): string {
  switch (action.kind) {
    case "set_memory_backend":
      return `将 ${action.targetRoleId ?? "团队"} 的记忆后端设置为 ${String(action.payload.backend)}`;
    case "install_skill":
      return `为 ${action.targetRoleId ?? "团队"} 安装技能 ${action.skillId ?? "未知技能"}`;
    case "disable_skill":
      return `为 ${action.targetRoleId ?? "团队"} 禁用技能 ${action.skillId ?? "未知技能"}`;
    case "send_email":
      return `发送邮件到 ${String(action.payload.to ?? "未知收件人")}`;
    case "set_channel_enabled": {
      const channel = String(action.payload.channel ?? "未知");
      const enabled = Boolean(action.payload.enabled);
      return `${enabled ? "启用" : "禁用"} ${channel} 通道`;
    }
    case "set_tool_provider_config": {
      const providerId = String(action.payload.providerId ?? "opencode");
      const modelId = typeof action.payload.modelId === "string" ? action.payload.modelId : "";
      const baseUrl = typeof action.payload.baseUrl === "string" ? action.payload.baseUrl : "";
      const apiKeyEnv = typeof action.payload.apiKeyEnv === "string" ? action.payload.apiKeyEnv : "";
      const parts: string[] = [`配置 ${providerId}`];
      if (modelId) {
        parts.push(`模型=${modelId}`);
      }
      if (baseUrl) {
        parts.push(`地址=${baseUrl}`);
      }
      if (apiKeyEnv) {
        parts.push(`密钥=${apiKeyEnv}`);
      }
      return parts.join(" ");
    }
    case "set_runtime_setting":
      return `设置运行时配置 ${String(action.payload.key ?? "未知项")}`;
    case "add_agent_instance":
      return `新增 ${action.targetRoleId ?? "未知角色"} 角色实例`;
    case "remove_agent_instance":
      return `移除 ${action.targetRoleId ?? "未知角色"} 角色实例`;
    case "set_agent_tone_policy":
      return `设置 ${action.targetRoleId ?? "未知角色"} 角色语气策略`;
    default:
      return "操作指令";
  }
}

export function parseOperatorActionFromText(
  text: string,
  createdBy?: string
): ParsedOperatorAction | undefined {
  const normalized = text.trim();
  const createdByField = createdBy ? { createdBy } : {};
  if (!normalized) {
    return undefined;
  }

  const addAgentMatch =
    normalized.match(
      /(?:新增|添加|增加|加|创建|招募)\s*(?:一个|1个)?\s*(.+?)(?:\s*(?:agent|智能体|人员|同学))?(?:\s*(?:叫|名为|命名为)\s*([^\s,，。]+))?$/i
    ) ??
    normalized.match(
      /(?:add|create)\s+(?:an?\s+)?(.+?)\s+agent(?:\s+(?:named|as)\s+([^\s,，。]+))?$/i
    );
  if (addAgentMatch?.[1]) {
    const roleId = findRoleInText(addAgentMatch[1]);
    if (roleId) {
      const action = {
        kind: "add_agent_instance" as const,
        targetRoleId: roleId,
        payload: {
          roleId,
          ...(addAgentMatch[2] ? { name: addAgentMatch[2].trim() } : {})
        },
        summary: `新增 ${roleId} 角色实例`,
        ...createdByField
      };
      return createAction(action);
    }
  }

  const removeAgentMatch =
    normalized.match(
      /(?:移除|删除|移掉|开除|踢掉|移除掉)\s*(.+?)(?:\s*(?:agent|智能体|人员|同学))?$/i
    ) ??
    normalized.match(/(?:remove|delete)\s+(.+?)\s+agent$/i);
  if (removeAgentMatch?.[1]) {
    const roleId = findRoleInText(removeAgentMatch[1]);
    if (roleId) {
      const action = {
        kind: "remove_agent_instance" as const,
        targetRoleId: roleId,
        payload: {
          roleId
        },
        summary: `移除 ${roleId} 角色实例`,
        ...createdByField
      };
      return createAction(action);
    }
  }

  const tonePolicyMatch =
    normalized.match(
      /(?:把|将)?(.+?)(?:的)?(?:语气|口吻|风格)\s*(?:改成|改为|换成|设置为|设为|调整为)\s*(.+)$/i
    ) ??
    normalized.match(/(?:set|change)\s+(.+?)\s+(?:tone|style)\s+(?:to|as)\s*(.+)$/i);
  if (tonePolicyMatch?.[1] && tonePolicyMatch[2]) {
    const roleId = findRoleInText(tonePolicyMatch[1]);
    if (roleId) {
      const action = {
        kind: "set_agent_tone_policy" as const,
        targetRoleId: roleId,
        payload: {
          roleId,
          tonePolicy: tonePolicyMatch[2].trim()
        },
        summary: `设置 ${roleId} 角色语气策略`,
        ...createdByField
      };
      return createAction(action);
    }
  }

  const channelToggleMatch = normalized.match(
    /(启用|开启|打开|enable|禁用|关闭|停用|disable)\s*(飞书|feishu|邮件|email)\s*(?:通道|渠道|channel)?/i
  );
  if (channelToggleMatch?.[1] && channelToggleMatch[2]) {
    const operation = channelToggleMatch[1].toLowerCase();
    const channelRaw = channelToggleMatch[2].toLowerCase();
    const enabled = operation === "启用" || operation === "开启" || operation === "打开" || operation === "enable";
    const channel = channelRaw === "飞书" || channelRaw === "feishu" ? "feishu" : "email";
    const action = {
      kind: "set_channel_enabled" as const,
      payload: {
        channel,
        enabled
      },
      summary: `${enabled ? "启用" : "禁用"} ${channel} 通道`,
      ...createdByField
    };
    return createAction(action);
  }

  const runtimeSettingGenericMatch = normalized.match(
    /(?:设置|配置)\s*(?:环境变量|配置项)?\s*([A-Z][A-Z0-9_]{2,})\s*(?:为|是|=|:)\s*(.+)$/i
  );
  if (runtimeSettingGenericMatch) {
    const keyRaw = runtimeSettingGenericMatch[1];
    const valueRaw = runtimeSettingGenericMatch[2];
    if (!keyRaw || !valueRaw) {
      return undefined;
    }
    const key = keyRaw.trim().toUpperCase();
    const value = valueRaw.trim().replace(/^["'`]+|["'`]+$/g, "");
    if (value) {
      const action = {
        kind: "set_runtime_setting" as const,
        payload: {
          key,
          value,
          isSecret: isSecretSettingKey(key)
        },
        summary: `设置运行时配置 ${key}`,
        ...createdByField
      };
      return createAction(action);
    }
  }

  const emailSmtpMatch = normalized.match(/(?:设置|配置)\s*(?:邮件|email)\s*(?:smtp|smtp_url)\s*(?:为|是|=|:)\s*(\S+)/i);
  if (emailSmtpMatch?.[1]) {
    const action = {
      kind: "set_runtime_setting" as const,
      payload: {
        key: "SMTP_URL",
        value: emailSmtpMatch[1].trim(),
        isSecret: true
      },
      summary: "设置运行时配置 SMTP_URL",
      ...createdByField
    };
    return createAction(action);
  }

  const emailFromMatch = normalized.match(/(?:设置|配置)\s*(?:邮件|email)\s*(?:发件人|from)\s*(?:为|是|=|:)\s*(.+)$/i);
  if (emailFromMatch?.[1]) {
    const action = {
      kind: "set_runtime_setting" as const,
      payload: {
        key: "EMAIL_DEFAULT_FROM",
        value: emailFromMatch[1].trim().replace(/^["'`]+|["'`]+$/g, "")
      },
      summary: "设置运行时配置 EMAIL_DEFAULT_FROM",
      ...createdByField
    };
    return createAction(action);
  }

  const feishuSettingMatch = normalized.match(
    /(?:设置|配置)\s*(?:飞书|feishu)\s*(app[_-]?id|app[_-]?secret|verification[_-]?token|encrypt[_-]?key|default[_-]?chat[_-]?id|domain|open[_-]?base[_-]?url)\s*(?:为|是|=|:)\s*(.+)$/i
  );
  if (feishuSettingMatch?.[1] && feishuSettingMatch[2]) {
    const keyToken = feishuSettingMatch[1].toLowerCase().replaceAll("-", "_");
    const key =
      keyToken === "app_id"
        ? "FEISHU_APP_ID"
        : keyToken === "app_secret"
          ? "FEISHU_APP_SECRET"
          : keyToken === "verification_token"
            ? "FEISHU_VERIFICATION_TOKEN"
            : keyToken === "encrypt_key"
              ? "FEISHU_ENCRYPT_KEY"
            : keyToken === "default_chat_id"
              ? "FEISHU_DEFAULT_CHAT_ID"
              : "FEISHU_DOMAIN";
    const action = {
      kind: "set_runtime_setting" as const,
      payload: {
        key,
        value: feishuSettingMatch[2].trim().replace(/^["'`]+|["'`]+$/g, ""),
        isSecret: isSecretSettingKey(key)
      },
      summary: `设置运行时配置 ${key}`,
      ...createdByField
    };
    return createAction(action);
  }

  const searchProviderMatch =
    normalized.match(
      /(?:设置|配置|启用|开通)\s*(?:联网)?(?:搜索|search)(?:工具|能力|provider|提供商)?\s*(?:为|是|=|:|用)?\s*(tavily|serpapi)\b/i
    ) ??
    normalized.match(/(?:set|configure)\s*(?:web\s*search|search)\s*(?:provider)?\s*(?:to|as|=|:)\s*(tavily|serpapi)\b/i);
  if (searchProviderMatch?.[1]) {
    const providerId = findSearchProviderInText(searchProviderMatch[1]);
    if (providerId) {
      const action = {
        kind: "set_runtime_setting" as const,
        payload: {
          key: "SEARCH_PROVIDER",
          value: providerId
        },
        summary: `设置运行时配置 SEARCH_PROVIDER=${providerId}`,
        ...createdByField
      };
      return createAction(action);
    }
  }

  const apiKeyConfig = parseApiKeyCommand(normalized);
  if (apiKeyConfig) {
    const action = {
      kind: "set_tool_provider_config" as const,
      payload: {
        providerId: apiKeyConfig.providerId,
        apiKeyEnv: apiKeyConfig.apiKeyEnv,
        apiKey: apiKeyConfig.apiKey
      },
      summary: `配置 ${apiKeyConfig.providerId} 密钥 ${apiKeyConfig.apiKeyEnv}`,
      ...createdByField
    };
    return createAction(action);
  }

  const modelSwitchMatch =
    normalized.match(/(?:切换|设置|改成|设为)\s*(?:开发|developer|opencode|代码)?\s*(?:模型|model)\s*(?:到|为|成|to)?\s*([^\s]+)/i) ??
    normalized.match(/(?:switch|set)\s+(?:developer|opencode)?\s*model\s+(?:to|as)\s*([^\s]+)/i) ??
    normalized.match(/(?:切换到|switch to)\s*([^\s]+)\s*(?:模型|model)?$/i);
  if (modelSwitchMatch?.[1]) {
    const preset = resolveToolModelPreset(modelSwitchMatch[1]);
    if (preset) {
      const action = {
        kind: "set_tool_provider_config" as const,
        payload: {
          providerId: "opencode",
          modelId: preset.modelId,
          ...(preset.baseUrl ? { baseUrl: preset.baseUrl } : {}),
          ...(preset.apiKeyEnv ? { apiKeyEnv: preset.apiKeyEnv } : {}),
          requiresApiKey: preset.requiresApiKey
        },
        summary: `切换 opencode 模型为 ${preset.modelId}`,
        ...createdByField
      };
      return createAction(action);
    }
  }

  const modelBaseUrlMatch =
    normalized.match(/(?:设置|配置|更新)\s*(?:开发|opencode)?\s*(?:模型)?(?:地址|base\s*url)\s*(?:为|是|=|:)\s*(https?:\/\/\S+)/i) ??
    normalized.match(/set\s+(?:opencode\s+)?base\s*url\s*(?:to|=|:)\s*(https?:\/\/\S+)/i);
  if (modelBaseUrlMatch?.[1]) {
    const baseUrl = modelBaseUrlMatch[1].trim();
    const action = {
      kind: "set_tool_provider_config" as const,
      payload: {
        providerId: "opencode",
        baseUrl
      },
      summary: `设置 opencode 地址为 ${baseUrl}`,
      ...createdByField
    };
    return createAction(action);
  }

  const memoryMatch =
    normalized.match(/(?:配置|设置|把|将)?(.+?)(?:的)?记忆(?:配置)?(?:为|成)(.+)/) ??
    normalized.match(/set (.+?) memory(?: backend)? to (.+)/i);
  if (memoryMatch) {
    const roleId = findRoleInText(memoryMatch[1] ?? normalized);
    const backend = resolveBackend(memoryMatch[2] ?? normalized);
    if (roleId && backend) {
      const action = {
        kind: "set_memory_backend" as const,
        targetRoleId: roleId,
        payload: {
          backend
        },
        summary: `设置 ${roleId} 的记忆后端为 ${backend}`,
        ...createdByField
      };
      return createAction(action);
    }
  }

  const installMatch =
    normalized.match(/(?:给|为|把)?(.+?)(?:安装|启用)(.+?)(?:skill|技能)?$/) ??
    normalized.match(/install (.+?) (?:skill )?(?:to|for) (.+)/i);
  if (installMatch) {
    const roleCandidate = /install /i.test(normalized) ? installMatch[2] : installMatch[1];
    const skillCandidate = /install /i.test(normalized) ? installMatch[1] : installMatch[2];
    const roleId = findRoleInText(roleCandidate ?? normalized);
    const skillId = resolveSkillId(skillCandidate ?? normalized);
    if (roleId && skillId) {
      const action = {
        kind: "install_skill" as const,
        targetRoleId: roleId,
        skillId,
        payload: {},
        summary: `为 ${roleId} 安装技能 ${skillId}`,
        ...createdByField
      };
      return createAction(action);
    }
  }

  const disableMatch =
    normalized.match(/(?:给|为|把)?(.+?)(?:停用|禁用|卸载)(.+?)(?:skill|技能)?$/) ??
    normalized.match(/disable (.+?) (?:skill )?(?:for) (.+)/i);
  if (disableMatch) {
    const roleCandidate = /disable /i.test(normalized) ? disableMatch[2] : disableMatch[1];
    const skillCandidate = /disable /i.test(normalized) ? disableMatch[1] : disableMatch[2];
    const roleId = findRoleInText(roleCandidate ?? normalized);
    const skillId = resolveSkillId(skillCandidate ?? normalized);
    if (roleId && skillId) {
      const action = {
        kind: "disable_skill" as const,
        targetRoleId: roleId,
        skillId,
        payload: {},
        summary: `为 ${roleId} 禁用技能 ${skillId}`,
        ...createdByField
      };
      return createAction(action);
    }
  }

  const emailMatch =
    normalized.match(/(?:发邮件给|发送邮件给|send email to)\s*([^\s,，]+)(?:\s+(.+))?$/i) ??
    normalized.match(/邮件给\s*([^\s,，]+)(?:\s+(.+))?$/);
  if (emailMatch) {
    const [, to, subjectOrBody] = emailMatch;
    if (to) {
      const action = {
        kind: "send_email" as const,
        payload: {
          to,
          prompt: subjectOrBody ?? ""
        },
        summary: `发送邮件到 ${to}`,
        ...createdByField
      };
      return createAction(action);
    }
  }

  return undefined;
}

export function parseOperatorConfigInputRequirementFromText(
  text: string
): OperatorConfigInputRequirement | undefined {
  const normalized = text.trim();
  if (!normalized) {
    return undefined;
  }

  const addAgentIntent = /(?:新增|添加|增加|加|创建|招募|add|create).*(?:agent|智能体|人员|同学)/i.test(
    normalized
  );
  if (addAgentIntent) {
    const roleId = findRoleInText(normalized);
    if (!roleId) {
      return {
        message: "缺少要新增的 Agent 角色。",
        missingField: "targetRoleId",
        expectedCommand: "加一个测试 agent"
      };
    }
  }

  const removeAgentIntent = /(?:移除|删除|开除|踢掉|remove|delete).*(?:agent|智能体|人员|同学)/i.test(
    normalized
  );
  if (removeAgentIntent) {
    const roleId = findRoleInText(normalized);
    if (!roleId) {
      return {
        message: "缺少要移除的 Agent 角色。",
        missingField: "targetRoleId",
        expectedCommand: "移除一个测试 agent"
      };
    }
  }

  const tonePolicyIntent = /(?:语气|口吻|风格|tone|style)/i.test(normalized);
  if (tonePolicyIntent) {
    const roleId = findRoleInText(normalized);
    const policyMatch =
      normalized.match(/(?:改成|改为|换成|设置为|设为|to|as)\s*(.+)$/i) ??
      normalized.match(/(?:语气|口吻|风格|tone|style)\s*[:：]?\s*(.+)$/i);
    const tonePolicy = policyMatch?.[1]?.trim() ?? "";
    if (!roleId) {
      return {
        message: "缺少要设置语气策略的 Agent 角色。",
        missingField: "targetRoleId",
        expectedCommand: "把测试 agent 的语气改为更专业、客观、简洁"
      };
    }
    if (!tonePolicy) {
      return {
        message: "缺少语气策略内容。",
        missingField: "tonePolicy",
        expectedCommand: "把测试 agent 的语气改为更专业、客观、简洁"
      };
    }
  }

  const missingApiKeyMatch = normalized.match(
    /(?:设置|配置|更新)\s*(zhipu|glm|openai|opencode|anthropic|claude)\s*(?:api[-_\s]?key|密钥)\s*(?:为|是|=|:)?\s*$/i
  );
  if (missingApiKeyMatch?.[1]) {
    const vendor = missingApiKeyMatch[1].toLowerCase();
    const apiKeyEnv =
      vendor === "zhipu" || vendor === "glm"
        ? "ZHIPUAI_API_KEY"
        : vendor === "openai"
          ? "OPENAI_API_KEY"
          : vendor === "anthropic" || vendor === "claude"
            ? "ANTHROPIC_API_KEY"
            : "OPENCODE_API_KEY";
    return {
      message: `缺少 ${vendor} 的 API Key。`,
      missingField: apiKeyEnv,
      expectedCommand: `设置 ${apiKeyEnv.toLowerCase()} 为 <your-key>`
    };
  }

  if (
    /(?:发邮件|发送邮件|send email)/i.test(normalized) &&
    !/(?:发邮件给|发送邮件给|send email to|邮件给)\s*[^\s,，]+/i.test(normalized)
  ) {
    return {
      message: "缺少邮件收件人。",
      missingField: "to",
      expectedCommand: "发邮件给 someone@example.com 这是邮件正文"
    };
  }

  if (
    /(?:切换|设置|改成|设为|switch|set)\s*(?:开发|developer|opencode|代码)?\s*(?:模型|model)/i.test(normalized) &&
    !/(?:切换|设置|改成|设为|switch|set)\s*(?:开发|developer|opencode|代码)?\s*(?:模型|model)\s*(?:到|为|成|to|as)?\s*[^\s]+/i.test(
      normalized
    )
  ) {
    return {
      message: "缺少模型 ID。",
      missingField: "modelId",
      expectedCommand: "切换开发模型到 glm-5"
    };
  }

  if (
    /(?:设置|配置|更新)\s*(?:开发|opencode)?\s*(?:模型)?(?:地址|base\s*url)/i.test(normalized) &&
    !/(https?:\/\/\S+)/i.test(normalized)
  ) {
    return {
      message: "缺少模型地址。",
      missingField: "baseUrl",
      expectedCommand: "设置开发模型地址为 http://127.0.0.1:8000/v1"
    };
  }

  const searchIntent =
    /(?:配置|设置|开通|启用|安装|增加|帮我配置|需要|想要|开启|给团队|给我).*(?:联网)?(?:搜索|search)(?:工具|能力|provider|提供商)?/i.test(
      normalized
    ) ||
    /(?:联网)?(?:搜索|search)(?:工具|能力|provider|提供商)?.*(?:配置|设置|开通|启用|安装)/i.test(normalized) ||
    /web\s*search/i.test(normalized);
  if (searchIntent) {
    const providerId = findSearchProviderInText(normalized);
    if (!providerId) {
      return {
        message: "缺少搜索提供商，请先指定 tavily 或 serpapi。",
        missingField: "SEARCH_PROVIDER",
        expectedCommand: "设置搜索工具为 tavily（可选: tavily / serpapi）"
      };
    }
    const apiKeyEnv = resolveSearchProviderApiKeyEnv(providerId);
    return {
      message: `已识别搜索提供商 ${providerId}，还缺少密钥 ${apiKeyEnv}。`,
      missingField: apiKeyEnv,
      expectedCommand: `设置 ${apiKeyEnv} 为 <your-key>`
    };
  }

  const memoryIntentMatch =
    normalized.match(/(?:配置|设置|把|将)?(.+?)(?:的)?记忆(?:配置)?(?:为|成)(.+)/) ??
    normalized.match(/set (.+?) memory(?: backend)? to (.+)/i);
  if (memoryIntentMatch) {
    const roleCandidate = memoryIntentMatch[1] ?? "";
    const backendCandidate = memoryIntentMatch[2] ?? "";
    const roleId = findRoleInText(roleCandidate);
    const backend = resolveBackend(backendCandidate);
    if (!roleId) {
      return {
        message: "缺少要设置记忆策略的角色。",
        missingField: "targetRoleId",
        expectedCommand: "请配置研究助理的记忆为向量数据库"
      };
    }
    if (!backend) {
      return {
        message: "缺少记忆后端类型。",
        missingField: "backend",
        expectedCommand: "请配置研究助理的记忆为向量数据库"
      };
    }
  }

  if (
    /(?:install|disable|安装|启用|停用|禁用|卸载)/i.test(normalized) &&
    /(?:skill|技能)/i.test(normalized)
  ) {
    const roleId = findRoleInText(normalized);
    const skillId = resolveSkillId(normalized);
    if (!roleId) {
      return {
        message: "缺少要操作的角色。",
        missingField: "targetRoleId",
        expectedCommand: "给 frontend 安装 code-executor skill"
      };
    }
    if (!skillId) {
      return {
        message: "缺少技能标识（skillId）。",
        missingField: "skillId",
        expectedCommand: "给 frontend 安装 code-executor skill"
      };
    }
  }

  const missingEmailSmtpMatch = normalized.match(
    /(?:设置|配置)\s*(?:邮件|email)\s*(?:smtp|smtp_url)\s*(?:为|是|=|:)?\s*$/i
  );
  if (missingEmailSmtpMatch) {
    return {
      message: "缺少 SMTP_URL 配置值。",
      missingField: "SMTP_URL",
      expectedCommand: "设置邮件smtp为 smtps://your_email%40qq.com:auth_code@smtp.qq.com:465"
    };
  }

  const missingEmailFromMatch = normalized.match(
    /(?:设置|配置)\s*(?:邮件|email)\s*(?:发件人|from)\s*(?:为|是|=|:)?\s*$/i
  );
  if (missingEmailFromMatch) {
    return {
      message: "缺少 EMAIL_DEFAULT_FROM 配置值。",
      missingField: "EMAIL_DEFAULT_FROM",
      expectedCommand: "设置邮件发件人为 VinkoClaw <your_email@qq.com>"
    };
  }

  const missingFeishuSettingMatch = normalized.match(
    /(?:设置|配置)\s*(?:飞书|feishu)\s*(app[_-]?id|app[_-]?secret|verification[_-]?token|encrypt[_-]?key|default[_-]?chat[_-]?id|domain|open[_-]?base[_-]?url)\s*(?:为|是|=|:)?\s*$/i
  );
  if (missingFeishuSettingMatch?.[1]) {
    const keyToken = missingFeishuSettingMatch[1].toLowerCase().replaceAll("-", "_");
    const key =
      keyToken === "app_id"
        ? "FEISHU_APP_ID"
        : keyToken === "app_secret"
          ? "FEISHU_APP_SECRET"
          : keyToken === "verification_token"
            ? "FEISHU_VERIFICATION_TOKEN"
            : keyToken === "encrypt_key"
              ? "FEISHU_ENCRYPT_KEY"
            : keyToken === "default_chat_id"
              ? "FEISHU_DEFAULT_CHAT_ID"
              : "FEISHU_DOMAIN";
    return {
      message: `缺少 ${key} 配置值。`,
      missingField: key,
      expectedCommand: `设置 ${key.toLowerCase()} 为 <value>`
    };
  }

  const missingGenericRuntimeSettingMatch = normalized.match(
    /(?:设置|配置)\s*(?:环境变量|配置项)?\s*([A-Z][A-Z0-9_]{2,})\s*(?:为|是|=|:)?\s*$/i
  );
  if (missingGenericRuntimeSettingMatch?.[1]) {
    const key = missingGenericRuntimeSettingMatch[1].trim().toUpperCase();
    return {
      message: `缺少 ${key} 配置值。`,
      missingField: key,
      expectedCommand: `设置 ${key} 为 <value>`
    };
  }

  return undefined;
}

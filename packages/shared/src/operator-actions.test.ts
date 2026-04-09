import { describe, expect, it } from "vitest";
import {
  parseOperatorActionFromText,
  parseOperatorConfigInputRequirementFromText
} from "./operator-actions.js";

describe("parseOperatorActionFromText", () => {
  it("parses vector memory configuration for a specific role", () => {
    const parsed = parseOperatorActionFromText("请配置研究助理的记忆为向量数据库", "owner");

    expect(parsed?.action.kind).toBe("set_memory_backend");
    expect(parsed?.action.targetRoleId).toBe("research");
    expect(parsed?.action.payload.backend).toBe("vector-db");
    expect(parsed?.action.createdBy).toBe("owner");
  });

  it("parses skill installation in English", () => {
    const parsed = parseOperatorActionFromText("install email skill for operations", "owner");

    expect(parsed?.action.kind).toBe("install_skill");
    expect(parsed?.action.targetRoleId).toBe("operations");
    expect(parsed?.action.skillId).toBe("email-ops");
  });

  it("parses send email command in Chinese", () => {
    const parsed = parseOperatorActionFromText("发邮件给 ceo@example.com 项目今天已经上线", "owner");

    expect(parsed?.action.kind).toBe("send_email");
    expect(parsed?.action.payload.to).toBe("ceo@example.com");
    expect(parsed?.action.payload.prompt).toBe("项目今天已经上线");
  });

  it("parses send email command in English", () => {
    const parsed = parseOperatorActionFromText("send email to ops@example.com launch report", "owner");

    expect(parsed?.action.kind).toBe("send_email");
    expect(parsed?.action.payload.to).toBe("ops@example.com");
    expect(parsed?.action.payload.prompt).toBe("launch report");
  });

  it("parses developer model switch command", () => {
    const parsed = parseOperatorActionFromText("切换开发模型到 glm-5", "owner");

    expect(parsed?.action.kind).toBe("set_tool_provider_config");
    expect(parsed?.action.payload.providerId).toBe("opencode");
    expect(parsed?.action.payload.modelId).toBe("zhipuai/glm-5");
    expect(parsed?.action.payload.apiKeyEnv).toBe("ZHIPUAI_API_KEY");
    expect(parsed?.action.payload.requiresApiKey).toBe(true);
  });

  it("parses API key setup command", () => {
    const parsed = parseOperatorActionFromText("设置 zhipu api-key 为 zhipu_test_key", "owner");

    expect(parsed?.action.kind).toBe("set_tool_provider_config");
    expect(parsed?.action.payload.providerId).toBe("opencode");
    expect(parsed?.action.payload.apiKeyEnv).toBe("ZHIPUAI_API_KEY");
    expect(parsed?.action.payload.apiKey).toBe("zhipu_test_key");
  });

  it("parses email SMTP runtime setting command", () => {
    const parsed = parseOperatorActionFromText(
      "设置邮件smtp为 smtps://3345710651%40qq.com:auth@smtp.qq.com:465",
      "owner"
    );

    expect(parsed?.action.kind).toBe("set_runtime_setting");
    expect(parsed?.action.payload.key).toBe("SMTP_URL");
    expect(parsed?.action.payload.value).toBe("smtps://3345710651%40qq.com:auth@smtp.qq.com:465");
    expect(parsed?.action.payload.isSecret).toBe(true);
  });

  it("parses generic runtime setting command", () => {
    const parsed = parseOperatorActionFromText("设置 EMAIL_DEFAULT_FROM 为 VinkoClaw <3345710651@qq.com>", "owner");

    expect(parsed?.action.kind).toBe("set_runtime_setting");
    expect(parsed?.action.payload.key).toBe("EMAIL_DEFAULT_FROM");
    expect(parsed?.action.payload.value).toBe("VinkoClaw <3345710651@qq.com>");
  });

  it("parses Feishu domain runtime setting command", () => {
    const parsed = parseOperatorActionFromText("设置飞书domain为 feishu", "owner");

    expect(parsed?.action.kind).toBe("set_runtime_setting");
    expect(parsed?.action.payload.key).toBe("FEISHU_DOMAIN");
    expect(parsed?.action.payload.value).toBe("feishu");
  });

  it("parses Feishu encrypt key runtime setting command", () => {
    const parsed = parseOperatorActionFromText("设置飞书encrypt_key为 encrypt_test_key", "owner");

    expect(parsed?.action.kind).toBe("set_runtime_setting");
    expect(parsed?.action.payload.key).toBe("FEISHU_ENCRYPT_KEY");
    expect(parsed?.action.payload.value).toBe("encrypt_test_key");
    expect(parsed?.action.payload.isSecret).toBe(true);
  });

  it("parses search provider setup command", () => {
    const parsed = parseOperatorActionFromText("设置搜索工具为 tavily", "owner");

    expect(parsed?.action.kind).toBe("set_runtime_setting");
    expect(parsed?.action.payload.key).toBe("SEARCH_PROVIDER");
    expect(parsed?.action.payload.value).toBe("tavily");
  });

  it("parses channel toggle command", () => {
    const parsed = parseOperatorActionFromText("请启用邮件通道", "owner");

    expect(parsed?.action.kind).toBe("set_channel_enabled");
    expect(parsed?.action.payload.channel).toBe("email");
    expect(parsed?.action.payload.enabled).toBe(true);
  });

  it("parses add agent instance command", () => {
    const parsed = parseOperatorActionFromText("加一个测试 agent", "owner");

    expect(parsed?.action.kind).toBe("add_agent_instance");
    expect(parsed?.action.targetRoleId).toBe("qa");
  });

  it("parses remove agent instance command", () => {
    const parsed = parseOperatorActionFromText("移除一个测试 agent", "owner");

    expect(parsed?.action.kind).toBe("remove_agent_instance");
    expect(parsed?.action.targetRoleId).toBe("qa");
  });

  it("parses set tone policy command", () => {
    const parsed = parseOperatorActionFromText("把测试 agent 的语气改为更专业、客观、简洁", "owner");

    expect(parsed?.action.kind).toBe("set_agent_tone_policy");
    expect(parsed?.action.targetRoleId).toBe("qa");
    expect(parsed?.action.payload.tonePolicy).toContain("专业");
  });
});

describe("parseOperatorConfigInputRequirementFromText", () => {
  it("returns follow-up prompt when model switch command misses model id", () => {
    const requirement = parseOperatorConfigInputRequirementFromText("切换开发模型");

    expect(requirement?.missingField).toBe("modelId");
    expect(requirement?.expectedCommand).toContain("glm-5");
  });

  it("returns follow-up prompt when memory policy command misses role", () => {
    const requirement = parseOperatorConfigInputRequirementFromText("请配置记忆为向量数据库");

    expect(requirement?.missingField).toBe("targetRoleId");
  });

  it("returns follow-up prompt when email command misses recipient", () => {
    const requirement = parseOperatorConfigInputRequirementFromText("发邮件");

    expect(requirement?.missingField).toBe("to");
  });

  it("returns follow-up prompt when Feishu domain command misses value", () => {
    const requirement = parseOperatorConfigInputRequirementFromText("设置飞书domain为");

    expect(requirement?.missingField).toBe("FEISHU_DOMAIN");
  });

  it("returns follow-up prompt when Feishu encrypt key command misses value", () => {
    const requirement = parseOperatorConfigInputRequirementFromText("设置飞书encrypt_key为");

    expect(requirement?.missingField).toBe("FEISHU_ENCRYPT_KEY");
  });

  it("returns follow-up prompt when search setup misses provider", () => {
    const requirement = parseOperatorConfigInputRequirementFromText("帮我配置搜索工具，让其具有搜索能力");

    expect(requirement?.missingField).toBe("SEARCH_PROVIDER");
    expect(requirement?.message).toContain("缺少");
    expect(requirement?.expectedCommand).toContain("tavily");
  });

  it("returns chinese follow-up prompt when api key value is missing", () => {
    const requirement = parseOperatorConfigInputRequirementFromText("设置 openai api-key 为");

    expect(requirement?.missingField).toBe("OPENAI_API_KEY");
    expect(requirement?.message).toContain("缺少");
    expect(requirement?.message.toLowerCase()).not.toContain("missing");
  });

  it("returns follow-up prompt when add-agent command misses role", () => {
    const requirement = parseOperatorConfigInputRequirementFromText("加一个agent");

    expect(requirement?.missingField).toBe("targetRoleId");
  });

  it("returns follow-up prompt when tone policy command misses role", () => {
    const requirement = parseOperatorConfigInputRequirementFromText("把他的语气改为更礼貌");

    expect(requirement?.missingField).toBe("targetRoleId");
  });
});

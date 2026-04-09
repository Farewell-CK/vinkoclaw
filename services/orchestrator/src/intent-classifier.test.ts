import { describe, expect, it, vi, beforeEach } from "vitest";
import { classifyInboundIntent } from "./intent-classifier.js";

// Force keyword fallback by making fetch fail
beforeEach(() => {
  vi.stubGlobal("fetch", () => Promise.reject(new Error("no model in test")));
});

describe("intent-classifier keyword fallback", () => {
  it("routes goalrun phrases", async () => {
    expect(await classifyInboundIntent("请端到端自动完成这个任务")).toBe("goalrun");
    expect(await classifyInboundIntent("帮我给公司写一个官网并部署")).toBe("goalrun");
  });

  it("routes operator_config: search setup phrasing", async () => {
    expect(await classifyInboundIntent("我们需要给团队开启联网搜索能力")).toBe("operator_config");
    expect(await classifyInboundIntent("帮我配置搜索工具")).toBe("operator_config");
    expect(await classifyInboundIntent("需要开启搜索能力")).toBe("operator_config");
    expect(await classifyInboundIntent("enable web search")).toBe("operator_config");
  });

  it("routes operator_config: model and API key phrasing", async () => {
    expect(await classifyInboundIntent("切换模型到 glm-5")).toBe("operator_config");
    expect(await classifyInboundIntent("需要配置 API key")).toBe("operator_config");
    expect(await classifyInboundIntent("设置模型密钥")).toBe("operator_config");
  });

  it("routes operator_config: skill install phrasing", async () => {
    expect(await classifyInboundIntent("安装 web-search 技能")).toBe("operator_config");
    expect(await classifyInboundIntent("给 research 启用搜索能力")).toBe("operator_config");
  });

  it("does not misroute normal tasks to operator_config", async () => {
    expect(await classifyInboundIntent("帮我写一份产品需求文档")).toBe("task");
    expect(await classifyInboundIntent("修复登录页的样式问题")).toBe("task");
    expect(await classifyInboundIntent("你好")).toBe("task");
    expect(await classifyInboundIntent("帮我整理本周工作日报")).toBe("task");
  });
});

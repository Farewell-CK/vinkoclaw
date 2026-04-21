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
    expect(
      await classifyInboundIntent(
        "帮我给公司写一个官网并部署\n\n补充信息：\n- 官网的主要功能模块有哪些（如：关于我们、产品展示、联系方式等）？ 公司介绍、产品展示、客户案例、联系方式。\n- 希望使用什么技术栈或平台进行开发（如：React, Vue, WordPress, 静态HTML等）？ React + TypeScript。\n- 部署的目标环境或平台是什么（如：AWS, Vercel, 公司自有服务器等）？ Vercel。"
      )
    ).toBe("goalrun");
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

  it("routes light_collaboration: build + quick check phrasing", async () => {
    expect(await classifyInboundIntent("做完检查一下")).toBe("light_collaboration");
    expect(await classifyInboundIntent("写完然后测试一下")).toBe("light_collaboration");
    expect(await classifyInboundIntent("开发完然后验证")).toBe("light_collaboration");
    expect(
      await classifyInboundIntent(
        "团队协作执行，做一个活动落地页：请前端、UIUX、QA 一起协作，使用 React + TypeScript，实现首屏、活动亮点、报名表单和移动端适配，做完检查一下。"
      )
    ).toBe("collaboration");
  });

  it("does not misroute normal tasks to operator_config", async () => {
    expect(await classifyInboundIntent("帮我写一份产品需求文档")).toBe("task");
    expect(await classifyInboundIntent("修复登录页的样式问题")).toBe("task");
    expect(await classifyInboundIntent("你好")).toBe("task");
    expect(await classifyInboundIntent("帮我整理本周工作日报")).toBe("task");
  });

  it("downgrades model collaboration overclassification without explicit team signal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ choices: [{ message: { content: "collaboration" } }] })
        })
      )
    );

    expect(
      await classifyInboundIntent(
        "请实现一个最小登录页，并补对应验证任务。技术栈：React + TypeScript。需要邮箱密码登录、忘记密码入口和基础表单校验。"
      )
    ).toBe("task");
  });
});

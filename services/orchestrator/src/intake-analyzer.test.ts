import { describe, it, expect } from "vitest";
import {
  isObviouslyClear,
  mergeClarificationResponse,
  formatClarificationMessage
} from "./intake-analyzer.js";

describe("isObviouslyClear", () => {
  it("returns true for greetings", () => {
    expect(isObviouslyClear("你好")).toBe(true);
    expect(isObviouslyClear("hello")).toBe(true);
    expect(isObviouslyClear("嗨")).toBe(true);
    expect(isObviouslyClear("在吗")).toBe(true);
    expect(isObviouslyClear("谢谢")).toBe(true);
  });

  it("returns true for very short messages", () => {
    expect(isObviouslyClear("ok")).toBe(true);
    expect(isObviouslyClear("好的")).toBe(true);
  });

  it("returns true for bug fix requests", () => {
    expect(isObviouslyClear("修复登录页的样式问题")).toBe(true);
    expect(isObviouslyClear("fix the login bug")).toBe(true);
    expect(isObviouslyClear("解决这个报错")).toBe(true);
  });

  it("returns true for config commands", () => {
    expect(isObviouslyClear("设置搜索工具为 tavily")).toBe(true);
    expect(isObviouslyClear("enable web search")).toBe(true);
    expect(isObviouslyClear("安装 prd-writer skill")).toBe(true);
  });

  it("returns true for status queries", () => {
    expect(isObviouslyClear("任务进度怎么样了")).toBe(true);
    expect(isObviouslyClear("做到哪了")).toBe(true);
  });

  it("returns true for approval commands", () => {
    expect(isObviouslyClear("1 abc12345")).toBe(true);
    expect(isObviouslyClear("0 abc12345")).toBe(true);
    expect(isObviouslyClear("同意")).toBe(true);
  });

  it("returns false for vague task requests", () => {
    expect(isObviouslyClear("帮我做一个登录系统")).toBe(false);
    expect(isObviouslyClear("写一份PRD")).toBe(false);
    expect(isObviouslyClear("分析竞品")).toBe(false);
    expect(isObviouslyClear("帮我做一个产品")).toBe(false);
  });

  it("returns false for complex but underspecified requests", () => {
    expect(isObviouslyClear("帮我开发一个电商网站")).toBe(false);
    expect(isObviouslyClear("写一个数据分析报告")).toBe(false);
  });

  it("supports evolution-driven clarification-first heuristic for short vague requests", () => {
    expect(
      isObviouslyClear("帮我做个东西", {
        evolution: {
          preferClarificationForShortVagueRequests: true,
          shortVagueRequestMaxLength: 12
        }
      })
    ).toBe(false);

    expect(
      isObviouslyClear("帮我做个 React 登录页", {
        evolution: {
          preferClarificationForShortVagueRequests: true,
          shortVagueRequestMaxLength: 18
        }
      })
    ).toBe(true);
  });
});

describe("mergeClarificationResponse", () => {
  it("merges original text with clarification answers", () => {
    const result = mergeClarificationResponse(
      "帮我做一个登录系统",
      ["认证方式？", "技术栈？"],
      "邮箱认证，React"
    );
    expect(result).toContain("帮我做一个登录系统");
    expect(result).toContain("补充信息");
    expect(result).toContain("认证方式？");
    expect(result).toContain("技术栈？");
    expect(result).toContain("邮箱认证，React");
  });
});

describe("formatClarificationMessage", () => {
  it("formats questions into a numbered list", () => {
    const message = formatClarificationMessage([
      "认证方式是什么？(邮箱/手机/第三方)",
      "前端技术栈偏好？"
    ]);
    expect(message).toContain("1. 认证方式");
    expect(message).toContain("2. 前端技术栈");
    expect(message).toContain("请直接回复");
  });

  it("handles single question", () => {
    const message = formatClarificationMessage(["目标用户群体？"]);
    expect(message).toContain("1. 目标用户群体？");
    expect(message).not.toContain("2.");
  });
});

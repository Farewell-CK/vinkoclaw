import { describe, expect, it } from "vitest";
import { resolveRoleId } from "./roles.js";

describe("role resolution", () => {
  it("resolves detailed internet company roles", () => {
    expect(resolveRoleId("请PM梳理需求并给出验收标准")).toBe("product");
    expect(resolveRoleId("请UI设计登录页风格")).toBe("uiux");
    expect(resolveRoleId("请前端实现这个页面")).toBe("frontend");
    expect(resolveRoleId("后端API设计一下")).toBe("backend");
    expect(resolveRoleId("算法侧优化推理延迟")).toBe("algorithm");
    expect(resolveRoleId("QA做回归测试")).toBe("qa");
    expect(resolveRoleId("请开发人员修复这个 bug")).toBe("developer");
  });
});

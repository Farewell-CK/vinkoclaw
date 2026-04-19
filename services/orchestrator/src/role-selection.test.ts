import { describe, expect, it } from "vitest";
import { selectRoleFromText } from "./role-selection.js";

describe("role-selection", () => {
  it("routes website build requests to frontend even with product keywords", () => {
    expect(selectRoleFromText("帮我建一个产品官网")).toBe("frontend");
    expect(selectRoleFromText("给我们做一个公司网站首页")).toBe("frontend");
  });

  it("keeps website documentation requests in product", () => {
    expect(selectRoleFromText("请写一份产品官网PRD")).toBe("product");
    expect(selectRoleFromText("输出官网需求文档与里程碑")).toBe("product");
  });

  it("routes recurring ops asks to operations", () => {
    expect(selectRoleFromText("请整理一份周期性运营执行清单，每周一整理用户反馈")).toBe("operations");
    expect(selectRoleFromText("weekly recurring growth ops checklist for customer follow-up")).toBe("operations");
  });

  it("respects explicit role directives first", () => {
    expect(selectRoleFromText("请 frontend 同学处理这个需求")).toBe("frontend");
    expect(selectRoleFromText("让产品同学先做拆解")).toBe("product");
  });
});

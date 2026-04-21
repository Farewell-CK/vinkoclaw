import { describe, expect, it } from "vitest";
import { shouldRouteToGoalRun } from "./goal-run-routing.js";

describe("goal-run-routing", () => {
  it("routes strong autonomous intents to goal run", () => {
    expect(shouldRouteToGoalRun("请端到端自动完成这个任务")).toBe(true);
    expect(shouldRouteToGoalRun("请全流程推进并持续同步进度")).toBe(true);
  });

  it("routes complex delivery objectives to goal run", () => {
    expect(shouldRouteToGoalRun("帮我给公司写一个官网并部署")).toBe(true);
    expect(shouldRouteToGoalRun("做一个网站，然后上线到生产")).toBe(true);
    expect(shouldRouteToGoalRun("从0到1做一个教务系统")).toBe(true);
    expect(shouldRouteToGoalRun("做一个管理后台并上线")).toBe(true);
    expect(shouldRouteToGoalRun("做一个 SaaS 管理平台")).toBe(true);
  });

  it("does not route simple one-shot tasks to goal run", () => {
    expect(shouldRouteToGoalRun("请帮我写一个登录页原型")).toBe(false);
    expect(shouldRouteToGoalRun("修复这个按钮样式问题")).toBe(false);
  });

  it("does not route smalltalk to goal run", () => {
    expect(shouldRouteToGoalRun("你好")).toBe(false);
    expect(shouldRouteToGoalRun("谢谢🙏")).toBe(false);
  });

  // Regression: these previously triggered GoalRun incorrectly (delivery word alone)
  it("does not route single-step deploy actions to goal run", () => {
    expect(shouldRouteToGoalRun("帮我部署这个脚本")).toBe(false);
    expect(shouldRouteToGoalRun("上线一下测试环境")).toBe(false);
    expect(shouldRouteToGoalRun("deploy this file to staging")).toBe(false);
  });

  // Regression: website mention alone is not enough
  it("does not route single-step website edits to goal run", () => {
    expect(shouldRouteToGoalRun("我们网站的首页改一下配色")).toBe(false);
    expect(shouldRouteToGoalRun("更新官网的联系邮箱")).toBe(false);
  });

  // Regression: delivery + single connector is not enough
  it("does not route short delivery+connector combos to goal run", () => {
    expect(shouldRouteToGoalRun("部署然后通知我")).toBe(false);
    expect(shouldRouteToGoalRun("deploy and let me know")).toBe(false);
  });
});

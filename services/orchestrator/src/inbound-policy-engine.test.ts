import { describe, expect, it } from "vitest";
import {
  evaluateGoalRunRouting,
  evaluateInboundIntentPolicy,
  normalizeModelInboundIntent
} from "./inbound-policy-engine.js";

describe("inbound-policy-engine", () => {
  it("returns goalrun decision with matched rule evidence", () => {
    const decision = evaluateGoalRunRouting("帮我给公司写一个官网并部署");
    expect(decision.intent).toBe("goalrun");
    expect(decision.reason).toBe("delivery_plus_complex_scope");
    expect(decision.matchedRules).toContain("delivery_plus_complex_scope");
  });

  it("keeps smalltalk out of goalrun routing", () => {
    const decision = evaluateGoalRunRouting("你好");
    expect(decision.intent).toBe("task");
    expect(decision.reason).toBe("smalltalk_guardrail");
  });

  it("classifies operator config via unified inbound policy", () => {
    const decision = evaluateInboundIntentPolicy("给团队开启联网搜索能力");
    expect(decision.intent).toBe("operator_config");
    expect(decision.reason).toBe("operator_config_pattern");
  });

  it("classifies light collaboration via unified inbound policy", () => {
    const decision = evaluateInboundIntentPolicy("开发完然后验证");
    expect(decision.intent).toBe("light_collaboration");
    expect(decision.reason).toBe("build_then_check_pattern");
  });

  it("downgrades unsupported model collaboration decision", () => {
    const decision = normalizeModelInboundIntent(
      "collaboration",
      "请实现一个最小登录页，并补对应验证任务。技术栈：React + TypeScript。"
    );
    expect(decision.intent).toBe("task");
    expect(decision.reason).toBe("collaboration_downgraded_to_task");
  });

  it("allows evolution-configured length-based collaboration when explicit signal is disabled", () => {
    const decision = evaluateInboundIntentPolicy(
      "请帮我处理一个跨角色协同事项，需要多人联动推进需求拆解、实现协调、验收校对与交付收口。",
      {
        evolution: {
          requireExplicitTeamSignal: false,
          collaborationMinLength: 18
        }
      }
    );
    expect(decision.intent).toBe("collaboration");
    expect(decision.reason).toBe("evolution_length_based_collaboration");
  });
});

import { describe, expect, it } from "vitest";
import type { OperatorActionRecord } from "@vinko/shared";
import {
  buildSmalltalkReply,
  isContinueSignal,
  isOwnerLowRiskOperatorAction,
  isOwnerRequester,
  isSmalltalkMessage,
  resolveCollaborationEntryRole,
  shouldUseTeamCollaboration
} from "./inbound-policy.js";

function buildAction(patch: Partial<OperatorActionRecord>): OperatorActionRecord {
  return {
    id: "act_1",
    kind: "add_agent_instance",
    status: "pending",
    summary: "summary",
    payload: {},
    createdAt: "2026-04-02T00:00:00.000Z",
    updatedAt: "2026-04-02T00:00:00.000Z",
    ...patch
  };
}

describe("inbound-policy", () => {
  it("detects pure smalltalk but not actionable command", () => {
    expect(isSmalltalkMessage("你好")).toBe(true);
    expect(isSmalltalkMessage("你好👋")).toBe(true);
    expect(isSmalltalkMessage("谢谢")).toBe(true);
    expect(isSmalltalkMessage("谢谢🙏")).toBe(true);
    expect(isSmalltalkMessage("杜朝科: 你好")).toBe(true);
    expect(isSmalltalkMessage("@vinkoclaw 你好")).toBe(true);
    expect(isSmalltalkMessage("你好，帮我配置搜索工具")).toBe(false);
  });

  it("builds smalltalk reply in chinese", () => {
    expect(buildSmalltalkReply("在吗")).toContain("在的");
    expect(buildSmalltalkReply("谢谢")).toContain("不客气");
  });

  it("detects continue signals", () => {
    expect(isContinueSignal("继续")).toBe(true);
    expect(isContinueSignal("请继续")).toBe(true);
    expect(isContinueSignal("continue")).toBe(true);
    expect(isContinueSignal("继续，帮我配置搜索工具")).toBe(false);
  });

  it("detects owner requester by feishu open id and owner alias", () => {
    expect(
      isOwnerRequester({
        source: "feishu",
        requestedBy: "ou_owner_1",
        ownerOpenIds: ["ou_owner_1"]
      })
    ).toBe(true);
    expect(
      isOwnerRequester({
        source: "control-center",
        requestedBy: "owner",
        ownerOpenIds: []
      })
    ).toBe(true);
    expect(
      isOwnerRequester({
        source: "feishu",
        requestedBy: "ou_other",
        ownerOpenIds: ["ou_owner_1"]
      })
    ).toBe(false);
  });

  it("recognizes owner low-risk operator actions", () => {
    expect(
      isOwnerLowRiskOperatorAction(
        buildAction({
          kind: "set_runtime_setting",
          payload: { key: "SEARCH_PROVIDER", value: "tavily" }
        })
      )
    ).toBe(true);

    expect(
      isOwnerLowRiskOperatorAction(
        buildAction({
          kind: "set_runtime_setting",
          payload: { key: "OPENAI_API_KEY", value: "sk-xxx" }
        })
      )
    ).toBe(false);

    expect(
      isOwnerLowRiskOperatorAction(
        buildAction({
          kind: "set_runtime_setting",
          payload: { key: "FEISHU_RESOLVE_SENDER_NAMES", value: "false" }
        })
      )
    ).toBe(true);

    expect(
      isOwnerLowRiskOperatorAction(
        buildAction({
          kind: "set_runtime_setting",
          payload: { key: "FEISHU_ACK_MODE", value: "reaction_plus_text" }
        })
      )
    ).toBe(true);

    expect(
      isOwnerLowRiskOperatorAction(
        buildAction({
          kind: "install_skill",
          targetRoleId: "research",
          skillId: "web-search",
          payload: {}
        })
      )
    ).toBe(true);

    expect(
      isOwnerLowRiskOperatorAction(
        buildAction({
          kind: "install_skill",
          targetRoleId: "backend",
          skillId: "code-executor",
          payload: {}
        })
      )
    ).toBe(false);

    expect(
      isOwnerLowRiskOperatorAction(
        buildAction({
          kind: "set_tool_provider_config",
          payload: { providerId: "opencode", modelId: "zhipuai/glm-5" }
        })
      )
    ).toBe(false);
  });

  it("uses ceo as default collaboration entry role without explicit role", () => {
    expect(resolveCollaborationEntryRole("团队协作执行，交付上线方案")).toBe("ceo");
    expect(resolveCollaborationEntryRole("团队协作执行，让产品同学先拆需求")).toBe("product");
    expect(resolveCollaborationEntryRole("团队协作执行，做一个活动报名系统，含前后端与测试")).toBe("ceo");
    expect(resolveCollaborationEntryRole("团队协作执行，请写一份具身智能产品PRD")).toBe("ceo");
    expect(resolveCollaborationEntryRole("团队协作执行，请产品同学先拆需求")).toBe("product");
  });

  it("keeps document tasks out of collaboration unless explicitly requested", () => {
    expect(
      shouldUseTeamCollaboration("请写一份具身智能产品PRD，包含背景、用户、场景、需求列表、里程碑、风险与验收标准。")
    ).toBe(false);
    expect(
      shouldUseTeamCollaboration("请写一份具身智能行业调研报告，包含市场格局、主要玩家、技术路线、风险与机会，并给出信息来源。")
    ).toBe(false);
    expect(
      shouldUseTeamCollaboration("不要团队协作，请直接写一份具身智能行业调研报告。", {
        triggerKeywords: ["团队协作执行"]
      })
    ).toBe(false);
    expect(
      shouldUseTeamCollaboration("团队协作执行，请写一份具身智能产品PRD。", {
        triggerKeywords: ["团队协作执行"]
      })
    ).toBe(true);
    expect(shouldUseTeamCollaboration("请团队协作，前后端和测试一起输出实现方案。")).toBe(true);
  });
});

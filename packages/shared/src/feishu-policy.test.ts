import { describe, expect, it } from "vitest";
import {
  isSkillAutoApproveAllowed,
  parseFeishuApproverOpenIdsMap,
  parseSkillAutoApproveAllowlist,
  resolveFeishuAckMode,
  resolveFeishuApproverOpenIds
} from "./feishu-policy.js";

describe("feishu-policy", () => {
  it("resolves ack mode with fallback", () => {
    expect(resolveFeishuAckMode("text")).toBe("text");
    expect(resolveFeishuAckMode("reaction_plus_text")).toBe("reaction_plus_text");
    expect(resolveFeishuAckMode("invalid")).toBe("reaction_plus_text");
  });

  it("parses approver mapping from json", () => {
    const map = parseFeishuApproverOpenIdsMap(
      JSON.stringify({
        cto: ["ou_cto_1", "ou_cto_2"],
        ceo: "ou_ceo_1"
      })
    );
    expect(map.cto).toEqual(["ou_cto_1", "ou_cto_2"]);
    expect(map.ceo).toEqual(["ou_ceo_1"]);
  });

  it("falls back to owner list when role mapping missing", () => {
    const openIds = resolveFeishuApproverOpenIds({
      roleId: "operations",
      approverOpenIdsJson: JSON.stringify({
        cto: ["ou_cto_1"]
      }),
      fallbackOwnerOpenIds: ["ou_owner_1"]
    });
    expect(openIds).toEqual(["ou_owner_1"]);
  });

  it("parses skill auto-approve allowlist", () => {
    expect(parseSkillAutoApproveAllowlist("ceo:feishu-ops,*:workspace-retrieval")).toEqual([
      { rolePattern: "ceo", skillId: "feishu-ops" },
      { rolePattern: "*", skillId: "workspace-retrieval" }
    ]);
  });

  it("matches skill auto-approve rules", () => {
    const raw = "ceo:feishu-ops,*:workspace-retrieval";
    expect(
      isSkillAutoApproveAllowed({
        rawAllowlist: raw,
        roleId: "ceo",
        skillId: "feishu-ops"
      })
    ).toBe(true);
    expect(
      isSkillAutoApproveAllowed({
        rawAllowlist: raw,
        roleId: "backend",
        skillId: "workspace-retrieval"
      })
    ).toBe(true);
    expect(
      isSkillAutoApproveAllowed({
        rawAllowlist: raw,
        roleId: "backend",
        skillId: "feishu-ops"
      })
    ).toBe(false);
  });
});

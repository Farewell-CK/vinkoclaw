import { describe, expect, it } from "vitest";
import {
  formatSkillSearchResultsMessage,
  isExactMarketplaceSkillMatch,
  parseSkillInstallIntent,
  parseSkillSearchIntent
} from "./skills-marketplace-flow.js";

describe("skills-marketplace-flow", () => {
  it("parses explicit skill search intent", () => {
    const parsed = parseSkillSearchIntent("搜索给 product 用的 写prd skill");
    expect(parsed?.roleId).toBe("product");
    expect(parsed?.query).toContain("写prd");
  });

  it("parses direct install intent before local skill resolution", () => {
    const parsed = parseSkillInstallIntent("给 research 安装 竞品分析 skill");
    expect(parsed?.roleId).toBe("research");
    expect(parsed?.query).toBe("竞品分析");
  });

  it("matches exact marketplace aliases", () => {
    const matched = isExactMarketplaceSkillMatch(
      {
        skillId: "competitor-research-pro",
        name: "Competitor Research Pro",
        aliases: ["竞品分析", "竞争分析"]
      },
      "竞品分析"
    );
    expect(matched).toBe(true);
  });

  it("formats discover_only candidates clearly", () => {
    const message = formatSkillSearchResultsMessage({
      query: "竞品分析",
      roleId: "research",
      results: [
        {
          skillId: "competitor-research-pro",
          name: "Competitor Research Pro",
          summary: "Deep benchmark research.",
          allowedRoles: ["research", "ceo"],
          version: "0.3.1",
          installState: "discover_only"
        }
      ]
    });
    expect(message).toContain("可发现，暂不可直接安装");
    expect(message).toContain("0.3.1");
    expect(message).toContain("research");
  });
});

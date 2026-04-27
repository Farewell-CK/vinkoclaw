import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "./types.js";
import {
  getMarketplaceRecommendation,
  getMarketplaceSkillDetail,
  getLocalSkillMarketplaceEntries,
  searchMarketplaceSkills
} from "./skills-marketplace.js";

const originalRegistryUrl = process.env.VINKO_SKILL_REGISTRY_URL;

function createRuntimeConfig(): RuntimeConfig {
  return {
    memory: { defaultBackend: "sqlite", roleBackends: {} },
    routing: { primaryBackend: "openai", fallbackBackend: "zhipu" },
    channels: { feishuEnabled: true, emailEnabled: false },
    approvals: { requireForConfigMutation: true, requireForEmailSend: true },
    queue: { sla: { warningWaitMs: 300000, criticalWaitMs: 900000 } },
    tools: {
      providerOrder: ["opencode", "codex", "claude"],
      workspaceOnly: true,
      timeoutMs: 1200000,
      approvalMode: "cto_auto_owner_fallback",
      ctoRoleId: "cto",
      ownerRoleId: "ceo",
      highRiskKeywords: [],
      providerModels: {},
      providerBaseUrls: {}
    },
    collaboration: {
      enabled: true,
      triggerKeywords: [],
      defaultParticipants: ["product", "backend", "qa"],
      defaultConfig: {
        maxRounds: 3,
        discussionTimeoutMs: 1800000,
        requireConsensus: false,
        pushIntermediateResults: true,
        autoAggregateOnComplete: true,
        aggregateTimeoutMs: 3600000
      }
    },
    evolution: {
      router: {
        confidenceThreshold: 0.75,
        preferValidatedFallbacks: false,
        templateHints: []
      },
      intake: {
        preferClarificationForShortVagueRequests: false,
        shortVagueRequestMaxLength: 24,
        directConversationMaxLength: 24,
        ambiguousConversationMaxLength: 32,
        collaborationMinLength: 40,
        requireExplicitTeamSignal: true
      },
      collaboration: {
        partialDeliveryMinCompletedRoles: 1,
        timeoutNoProgressMode: "await_user",
        terminalFailureNoProgressMode: "blocked",
        manualResumeAggregationMode: "deliver"
      },
      skills: {
        recommendations: []
      }
    }
  };
}

afterEach(() => {
  if (originalRegistryUrl === undefined) {
    delete process.env.VINKO_SKILL_REGISTRY_URL;
  } else {
    process.env.VINKO_SKILL_REGISTRY_URL = originalRegistryUrl;
  }
  vi.restoreAllMocks();
});

describe("skills-marketplace", () => {
  it("lists local catalog skills as marketplace entries", () => {
    const entries = getLocalSkillMarketplaceEntries();
    expect(entries.some((entry) => entry.skillId === "prd-writer")).toBe(true);
    expect(entries.some((entry) => entry.skillId === "web-search")).toBe(true);
  });

  it("finds prd skills by natural query", async () => {
    const results = await searchMarketplaceSkills({ query: "写prd", limit: 5 });
    expect(results[0]?.skillId).toBe("prd-writer");
  });

  it("returns detail for a known skill", async () => {
    const detail = await getMarketplaceSkillDetail("prd-writer");
    expect(detail?.skillId).toBe("prd-writer");
    expect(detail?.installable).toBe(true);
    expect(detail?.runtimeAvailable).toBe(true);
    expect(detail?.installState).toBe("local_installable");
  });

  it("marks remote-only skills as discover_only when local runtime is missing", async () => {
    process.env.VINKO_SKILL_REGISTRY_URL = "https://registry.example.test/skills.json";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          items: [
            {
              id: "competitor-research-pro",
              skillId: "competitor-research-pro",
              name: "Competitor Research Pro",
              description: "Deep competitor benchmarking.",
              summary: "Community remote skill.",
              allowedRoles: ["research", "ceo"],
              aliases: ["竞品分析"],
              tags: ["research", "remote"],
              sourceLabel: "community-registry",
              sourceUrl: "https://registry.example.test/competitor-research-pro",
              version: "0.3.1",
              installable: true
            }
          ]
        })
      }))
    );

    const detail = await getMarketplaceSkillDetail("competitor-research-pro");
    expect(detail?.runtimeAvailable).toBe(false);
    expect(detail?.installable).toBe(false);
    expect(detail?.installState).toBe("discover_only");
    expect(detail?.sourceLabel).toBe("community-registry");
    expect(detail?.version).toBe("0.3.1");
  });

  it("merges remote metadata into local catalog skills", async () => {
    process.env.VINKO_SKILL_REGISTRY_URL = "https://registry.example.test/skills.json";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          items: [
            {
              id: "prd-writer",
              skillId: "prd-writer",
              name: "PRD Writer",
              description: "Remote metadata for PRD writer.",
              summary: "Remote summary.",
              allowedRoles: ["product", "ceo"],
              aliases: ["写prd", "product-prd"],
              tags: ["product", "template"],
              sourceLabel: "official-registry",
              sourceUrl: "https://registry.example.test/prd-writer",
              version: "1.2.0",
              installable: true
            }
          ]
        })
      }))
    );

    const detail = await getMarketplaceSkillDetail("prd-writer");
    expect(detail?.runtimeAvailable).toBe(true);
    expect(detail?.installable).toBe(true);
    expect(detail?.installState).toBe("local_installable");
    expect(detail?.source).toBe("catalog");
    expect(detail?.sourceLabel).toBe("official-registry");
    expect(detail?.sourceUrl).toBe("https://registry.example.test/prd-writer");
    expect(detail?.version).toBe("1.2.0");
  });

  it("falls back to local catalog when remote registry is unavailable", async () => {
    process.env.VINKO_SKILL_REGISTRY_URL = "https://registry.example.test/skills.json";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("registry offline");
      })
    );

    const detail = await getMarketplaceSkillDetail("prd-writer");
    expect(detail?.skillId).toBe("prd-writer");
    expect(detail?.installState).toBe("local_installable");
    expect(detail?.runtimeAvailable).toBe(true);
  });

  it("prefers verified skills over unverified and failed bindings", () => {
    const entry = getLocalSkillMarketplaceEntries().find((item) => item.skillId === "prd-writer");
    expect(entry).toBeTruthy();
    const verified = getMarketplaceRecommendation({
      entry: entry!,
      roleId: "product",
      roleBinding: { installed: true, verificationStatus: "verified" }
    });
    const unverified = getMarketplaceRecommendation({
      entry: entry!,
      roleId: "product",
      roleBinding: { installed: true, verificationStatus: "unverified" }
    });
    const failed = getMarketplaceRecommendation({
      entry: entry!,
      roleId: "product",
      roleBinding: { installed: true, verificationStatus: "failed" }
    });
    expect(verified.score).toBeGreaterThan(unverified.score);
    expect(unverified.score).toBeGreaterThan(failed.score);
    expect(verified.state).toBe("ready_verified");
    expect(failed.state).toBe("ready_failed");
  });

  it("boosts recommendation score from learned runtime recommendations", () => {
    const entry = getLocalSkillMarketplaceEntries().find((item) => item.skillId === "prd-writer");
    expect(entry).toBeTruthy();
    const runtimeConfig = createRuntimeConfig();
    runtimeConfig.evolution.skills.recommendations = [
      {
        roleId: "product",
        skillId: "prd-writer",
        reason: "Repeated successful PRD work",
        scoreBoost: 40,
        updatedAt: "2026-04-22T00:00:00.000Z"
      }
    ];

    const boosted = getMarketplaceRecommendation({
      entry: entry!,
      roleId: "product",
      roleBinding: { installed: false, verificationStatus: "unverified" },
      runtimeConfig
    });
    const baseline = getMarketplaceRecommendation({
      entry: entry!,
      roleId: "product",
      roleBinding: { installed: false, verificationStatus: "unverified" }
    });

    expect(boosted.score).toBeGreaterThan(baseline.score);
    expect(boosted.state).toBe("install_recommended");
  });
});

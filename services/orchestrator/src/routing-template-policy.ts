import type { RoutingTemplate, RuntimeConfig } from "@vinko/shared";

export interface RoutingTemplateDecision {
  template: RoutingTemplate;
  matchedRules: string[];
  reason: string;
  confidence: "low" | "medium" | "high";
  matchedKeywords: string[];
}

function normalizeKeywords(values: string[]): string[] {
  return values
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

export function selectRoutingTemplateDecision(
  text: string,
  templates: RoutingTemplate[],
  runtimeConfig?: RuntimeConfig
): RoutingTemplateDecision | undefined {
  const normalizedText = text.trim().toLowerCase();
  if (!normalizedText) {
    return undefined;
  }
  const learnedHints = Array.isArray(runtimeConfig?.evolution?.router?.templateHints)
    ? runtimeConfig!.evolution!.router!.templateHints
    : [];

  const ranked = templates
    .filter((template) => template.enabled)
    .map((template) => {
      const keywords = normalizeKeywords(template.triggerKeywords);
      const hintKeywords = learnedHints
        .filter((entry) => entry.templateId === template.id)
        .flatMap((entry) => normalizeKeywords(entry.phrases));
      const allKeywords = Array.from(new Set([...keywords, ...hintKeywords]));
      if (allKeywords.length === 0) {
        return undefined;
      }

      const matchedKeywords = allKeywords.filter((keyword) => normalizedText.includes(keyword));
      const matchedStaticKeywords = keywords.filter((keyword) => normalizedText.includes(keyword));
      const matchedHintKeywords = hintKeywords.filter((keyword) => normalizedText.includes(keyword));
      const matched =
        template.matchMode === "all"
          ? matchedStaticKeywords.length === keywords.length
          : matchedKeywords.length > 0;
      if (!matched) {
        return undefined;
      }

      return {
        template,
        matchedKeywords,
        matchedStaticKeywords,
        matchedHintKeywords,
        matchedCount: matchedKeywords.length,
        longestKeywordLength: matchedKeywords.reduce((max, keyword) => Math.max(max, keyword.length), 0),
        totalKeywordLength: matchedKeywords.reduce((sum, keyword) => sum + keyword.length, 0)
      };
    })
    .filter((entry): entry is {
      template: RoutingTemplate;
      matchedKeywords: string[];
      matchedStaticKeywords: string[];
      matchedHintKeywords: string[];
      matchedCount: number;
      longestKeywordLength: number;
      totalKeywordLength: number;
    } => Boolean(entry))
    .sort((left, right) => {
      if (right.matchedCount !== left.matchedCount) {
        return right.matchedCount - left.matchedCount;
      }
      if (right.longestKeywordLength !== left.longestKeywordLength) {
        return right.longestKeywordLength - left.longestKeywordLength;
      }
      return right.totalKeywordLength - left.totalKeywordLength;
    });

  const selected = ranked[0];
  if (!selected) {
    return undefined;
  }

  const exactCoverage = selected.matchedStaticKeywords.length === normalizeKeywords(selected.template.triggerKeywords).length;
  const reason =
    selected.template.matchMode === "all"
      ? "template_match_all_keywords"
      : selected.matchedHintKeywords.length > 0 && selected.matchedStaticKeywords.length === 0
        ? "template_match_learned_hint"
        : exactCoverage
        ? "template_match_full_keyword_coverage"
        : "template_match_partial_keyword_coverage";

  return {
    template: selected.template,
    matchedKeywords: selected.matchedKeywords,
    matchedRules: [
      reason,
      ...(selected.matchedHintKeywords.length > 0 ? ["template_match_runtime_hint"] : [])
    ],
    reason,
    confidence:
      exactCoverage || selected.matchedHintKeywords.length >= 2
        ? "high"
        : selected.matchedKeywords.length >= 2
          ? "medium"
          : "low"
  };
}

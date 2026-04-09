export const SEARCH_PROVIDER_IDS = ["tavily", "serpapi"] as const;
export type SearchProviderId = (typeof SEARCH_PROVIDER_IDS)[number];

export function resolveSearchProviderId(rawValue: string | undefined): SearchProviderId | undefined {
  const normalized = (rawValue ?? "").trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  if (normalized.includes("tavily")) {
    return "tavily";
  }
  if (normalized.includes("serpapi") || normalized.includes("serp")) {
    return "serpapi";
  }
  return undefined;
}

export function resolveSearchProviderApiKeyEnv(providerId: SearchProviderId): string {
  return providerId === "tavily" ? "TAVILY_API_KEY" : "SERPAPI_API_KEY";
}

export function parseSearchMaxResults(rawValue: string | undefined, fallback = 5): number {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(1, Math.min(10, Math.round(parsed)));
}

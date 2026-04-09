import { describe, expect, it } from "vitest";
import {
  parseSearchMaxResults,
  resolveSearchProviderApiKeyEnv,
  resolveSearchProviderId
} from "./search-policy.js";

describe("search-policy", () => {
  it("resolves search provider id", () => {
    expect(resolveSearchProviderId("tavily")).toBe("tavily");
    expect(resolveSearchProviderId("use serpapi")).toBe("serpapi");
    expect(resolveSearchProviderId("unknown")).toBeUndefined();
  });

  it("resolves api key env name", () => {
    expect(resolveSearchProviderApiKeyEnv("tavily")).toBe("TAVILY_API_KEY");
    expect(resolveSearchProviderApiKeyEnv("serpapi")).toBe("SERPAPI_API_KEY");
  });

  it("parses search max results with bounds", () => {
    expect(parseSearchMaxResults("7", 5)).toBe(7);
    expect(parseSearchMaxResults("99", 5)).toBe(10);
    expect(parseSearchMaxResults("-1", 5)).toBe(1);
    expect(parseSearchMaxResults("invalid", 5)).toBe(5);
  });
});

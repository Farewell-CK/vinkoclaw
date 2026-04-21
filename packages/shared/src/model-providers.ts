import type { RuntimeEnv } from "./env.js";
import type { RuntimeConfig } from "./types.js";

export type ModelProviderId = RuntimeEnv["primaryBackend"];

export interface ModelProviderStatus {
  providerId: ModelProviderId;
  label: string;
  baseUrl: string;
  model: string;
  primary: boolean;
  fallback: boolean;
  configured: boolean;
  keyConfigured: boolean;
  missing: string[];
}

export interface ModelProviderReadiness {
  ok: boolean;
  primaryProviderId: ModelProviderId;
  fallbackProviderId?: ModelProviderId | undefined;
  primaryConfigured: boolean;
  fallbackConfigured: boolean;
  configuredProviderIds: ModelProviderId[];
  unavailablePrimaryReasons: string[];
  recommendedAction: "none" | "configure_primary" | "switch_to_configured_provider" | "configure_any_provider";
}

function hasValue(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function secret(runtimeSecrets: Record<string, string>, key: string): string {
  return runtimeSecrets[key] ?? "";
}

function buildStatus(input: {
  providerId: ModelProviderId;
  label: string;
  baseUrl: string;
  model: string;
  primaryBackend: ModelProviderId;
  fallbackBackend: ModelProviderId | undefined;
  keyRequired: boolean;
  apiKey: string;
  keyEnvName?: string | undefined;
}): ModelProviderStatus {
  const missing: string[] = [];
  if (!hasValue(input.baseUrl)) {
    missing.push("baseUrl");
  }
  if (!hasValue(input.model)) {
    missing.push("model");
  }
  if (input.keyRequired && !hasValue(input.apiKey)) {
    missing.push(input.keyEnvName ?? "apiKey");
  }

  return {
    providerId: input.providerId,
    label: input.label,
    baseUrl: input.baseUrl,
    model: input.model,
    primary: input.primaryBackend === input.providerId,
    fallback: input.fallbackBackend === input.providerId,
    configured: missing.length === 0,
    keyConfigured: input.keyRequired ? hasValue(input.apiKey) : true,
    missing
  };
}

export function listModelProviderStatuses(
  env: RuntimeEnv,
  runtimeConfig?: RuntimeConfig | undefined,
  runtimeSecrets: Record<string, string> = {}
): ModelProviderStatus[] {
  const fallbackBackend = runtimeConfig?.routing.fallbackBackend;
  return [
    buildStatus({
      providerId: "openai",
      label: "OpenAI",
      baseUrl: env.openaiBaseUrl,
      model: env.openaiModel,
      primaryBackend: env.primaryBackend,
      fallbackBackend,
      keyRequired: true,
      apiKey: env.openaiApiKey || secret(runtimeSecrets, "OPENAI_API_KEY"),
      keyEnvName: "OPENAI_API_KEY"
    }),
    buildStatus({
      providerId: "dashscope",
      label: "DashScope / Qwen",
      baseUrl: env.dashscopeBaseUrl,
      model: env.dashscopeModel,
      primaryBackend: env.primaryBackend,
      fallbackBackend,
      keyRequired: true,
      apiKey: env.dashscopeApiKey || secret(runtimeSecrets, "DASHSCOPE_API_KEY"),
      keyEnvName: "DASHSCOPE_API_KEY"
    }),
    buildStatus({
      providerId: "zhipu",
      label: "Zhipu / GLM",
      baseUrl: env.zhipuBaseUrl,
      model: env.zhipuModel,
      primaryBackend: env.primaryBackend,
      fallbackBackend,
      keyRequired: true,
      apiKey: env.zhipuApiKey || secret(runtimeSecrets, "ZHIPUAI_API_KEY"),
      keyEnvName: "ZHIPUAI_API_KEY"
    }),
    buildStatus({
      providerId: "sglang",
      label: "SGLang",
      baseUrl: env.sglangBaseUrl,
      model: env.sglangModel,
      primaryBackend: env.primaryBackend,
      fallbackBackend,
      keyRequired: false,
      apiKey: ""
    }),
    buildStatus({
      providerId: "ollama",
      label: "Ollama",
      baseUrl: env.ollamaBaseUrl,
      model: env.ollamaModel,
      primaryBackend: env.primaryBackend,
      fallbackBackend,
      keyRequired: false,
      apiKey: ""
    })
  ];
}

export function buildModelProviderReadiness(statuses: ModelProviderStatus[]): ModelProviderReadiness {
  const primary = statuses.find((status) => status.primary);
  const fallback = statuses.find((status) => status.fallback);
  const configuredProviderIds = statuses
    .filter((status) => status.configured)
    .map((status) => status.providerId);
  const primaryProviderId = primary?.providerId ?? "sglang";
  const primaryConfigured = Boolean(primary?.configured);
  const fallbackConfigured = Boolean(fallback?.configured);
  const ok = primaryConfigured || fallbackConfigured || configuredProviderIds.length > 0;
  const recommendedAction: ModelProviderReadiness["recommendedAction"] = primaryConfigured
    ? "none"
    : configuredProviderIds.length > 0
      ? "switch_to_configured_provider"
      : primary
        ? "configure_primary"
        : "configure_any_provider";

  return {
    ok,
    primaryProviderId,
    fallbackProviderId: fallback?.providerId,
    primaryConfigured,
    fallbackConfigured,
    configuredProviderIds,
    unavailablePrimaryReasons: primary?.missing ?? ["primary_provider_not_found"],
    recommendedAction
  };
}

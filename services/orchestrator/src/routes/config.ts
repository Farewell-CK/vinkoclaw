import express from "express";
import { listToolProviderStatuses, normalizeToolExecPolicy } from "@vinko/shared";
import type { ToolExecPolicy, VinkoStore, RuntimeEnv } from "@vinko/shared";

const EMAIL_INBOUND_LEDGER_CONFIG_KEY = "email-inbound-ledger";

export interface ConfigRoutesDeps {
  store: VinkoStore;
  env: RuntimeEnv;
  getChannelStatus: () => {
    feishu: { configured: boolean; missing: string[]; ownerOpenIdsConfigured: boolean; domain: string; connectionMode: string; resolveSenderNames: boolean; verificationTokenConfigured: boolean; encryptKeyConfigured: boolean };
    email: { configured: boolean; missing: string[]; inbound: Record<string, unknown> };
  };
}

export function registerConfigRoutes(app: express.Express, deps: ConfigRoutesDeps): void {
  const { store, env, getChannelStatus } = deps;

  app.get("/api/config", (_request, response) => {
    response.json(store.getRuntimeConfig());
  });

  app.get("/api/channels/status", (_request, response) => {
    response.json({
      channels: store.getRuntimeConfig().channels,
      status: getChannelStatus()
    });
  });

  app.get("/api/email-inbound/records", (request, response) => {
    const limitRaw = Number(request.query.limit);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, Math.round(limitRaw))) : 100;
    const records = store.getConfigEntry<unknown[]>(EMAIL_INBOUND_LEDGER_CONFIG_KEY) ?? [];
    response.json({
      count: records.length,
      records: records.slice(0, limit)
    });
  });

  app.get("/api/tool-providers", (_request, response) => {
    const runtimeConfig = store.getRuntimeConfig();
    response.json({
      providers: listToolProviderStatuses(env, runtimeConfig.tools, store.getRuntimeSecrets()),
      policy: runtimeConfig.tools
    });
  });

  app.put("/api/config/tool-exec-policy", (request, response) => {
    const body = request.body as Partial<ToolExecPolicy>;
    const nextConfig = store.patchRuntimeConfig((config) => {
      config.tools = normalizeToolExecPolicy({
        ...config.tools,
        ...body,
        providerOrder: Array.isArray(body.providerOrder) ? body.providerOrder : config.tools.providerOrder,
        highRiskKeywords: Array.isArray(body.highRiskKeywords)
          ? body.highRiskKeywords.map((entry) => String(entry))
          : config.tools.highRiskKeywords
      });
      return config;
    });

    response.json({
      ok: true,
      tools: nextConfig.tools
    });
  });

  app.put("/api/config/queue-sla", (request, response) => {
    const body = request.body as Partial<{ warningWaitMs: number; criticalWaitMs: number }>;
    const warningWaitMs = Number(body.warningWaitMs);
    const criticalWaitMs = Number(body.criticalWaitMs);
    if (!Number.isFinite(warningWaitMs) || !Number.isFinite(criticalWaitMs)) {
      response.status(400).json({ error: "warningWaitMs_and_criticalWaitMs_required" });
      return;
    }

    if (warningWaitMs < 0 || criticalWaitMs <= warningWaitMs) {
      response.status(400).json({ error: "invalid_sla_thresholds" });
      return;
    }

    const nextConfig = store.patchRuntimeConfig((config) => {
      config.queue.sla.warningWaitMs = Math.round(warningWaitMs);
      config.queue.sla.criticalWaitMs = Math.round(criticalWaitMs);
      return config;
    });

    response.json({
      ok: true,
      queue: nextConfig.queue
    });
  });

  app.get("/api/tool-runs", (_request, response) => {
    response.json(store.listToolRuns(200));
  });

  app.get("/api/tool-runs/:toolRunId", (request, response) => {
    const toolRun = store.getToolRun(request.params.toolRunId);
    if (!toolRun) {
      response.status(404).json({ error: "tool_run_not_found" });
      return;
    }

    response.json(toolRun);
  });
}

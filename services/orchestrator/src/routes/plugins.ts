import express from "express";
import {
  listPlugins,
  getPlugin,
  enablePlugin,
  disablePlugin,
  updatePluginConfig,
  getPluginState
} from "@vinko/shared";
import type { VinkoStore } from "@vinko/shared";

export interface PluginRoutesDeps {
  store: VinkoStore;
}

export function registerPluginRoutes(app: express.Express, deps: PluginRoutesDeps): void {
  const { store } = deps;

  app.get("/api/plugins", (_request, response) => {
    const plugins = listPlugins();
    response.json(plugins.map((p) => ({
      id: p.definition.id,
      name: p.definition.name,
      version: p.definition.version,
      kind: p.definition.kind,
      description: p.definition.description,
      status: p.status,
      skillsCount: p.skills.length,
      providersCount: p.providers.length,
      commandsCount: p.commands.length,
      allowedRoles: p.definition.allowedRoles,
      config: p.config
    })));
  });

  app.get("/api/plugins/:pluginId", (request, response) => {
    const instance = getPlugin(request.params.pluginId);
    if (!instance) {
      response.status(404).json({ error: "plugin_not_found" });
      return;
    }

    response.json({
      id: instance.definition.id,
      name: instance.definition.name,
      version: instance.definition.version,
      kind: instance.definition.kind,
      description: instance.definition.description,
      status: instance.status,
      skills: instance.skills,
      providers: instance.providers,
      commands: instance.commands,
      allowedRoles: instance.definition.allowedRoles,
      config: instance.config,
      manifest: instance.manifest
    });
  });

  app.post("/api/plugins/:pluginId/enable", (request, response) => {
    const instance = getPlugin(request.params.pluginId);
    if (!instance) {
      response.status(404).json({ error: "plugin_not_found" });
      return;
    }

    try {
      enablePlugin(request.params.pluginId);
      const state = getPluginState(request.params.pluginId);
      if (state) {
        store.setPluginState(state.id, state.enabled, state.config);
      }
      response.json({ ok: true, status: "enabled" });
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/plugins/:pluginId/disable", (request, response) => {
    const instance = getPlugin(request.params.pluginId);
    if (!instance) {
      response.status(404).json({ error: "plugin_not_found" });
      return;
    }

    try {
      disablePlugin(request.params.pluginId);
      const state = getPluginState(request.params.pluginId);
      if (state) {
        store.setPluginState(state.id, state.enabled, state.config);
      }
      response.json({ ok: true, status: "disabled" });
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.put("/api/plugins/:pluginId/config", (request, response) => {
    const instance = getPlugin(request.params.pluginId);
    if (!instance) {
      response.status(404).json({ error: "plugin_not_found" });
      return;
    }

    const body = request.body as Record<string, unknown>;
    try {
      updatePluginConfig(request.params.pluginId, body);
      const state = getPluginState(request.params.pluginId);
      if (state) {
        store.setPluginState(state.id, state.enabled, state.config);
      }
      response.json({ ok: true, config: body });
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}

/**
 * Plugin Runtime - Plugin Registry
 *
 * Central registry for managing loaded plugins.
 */

import type {
  PluginDefinition,
  PluginInstance,
  PluginManifest,
  PluginSkillDefinition,
  PluginLogger,
  VinkoPluginApi,
  PluginProviderDefinition,
  PluginCommandDefinition,
  PluginState,
  TaskLifecycleEvent,
  ApprovalLifecycleEvent
} from "@vinko/plugin-sdk";
import { createPluginLogger } from "@vinko/plugin-sdk";
import type { PluginEventHandler } from "./types.js";

/**
 * Create a fallback manifest from a plugin definition.
 */
function createFallbackManifest(definition: PluginDefinition): PluginManifest {
  const manifest: PluginManifest = {
    id: definition.id,
    name: definition.name,
    version: definition.version ?? "0.0.0",
    kind: definition.kind
  };
  if (definition.description !== undefined) {
    manifest.description = definition.description;
  }
  if (definition.configSchema !== undefined) {
    manifest.configSchema = definition.configSchema;
  }
  if (definition.allowedRoles !== undefined) {
    manifest.allowedRoles = definition.allowedRoles;
  }
  return manifest;
}

/**
 * Plugin registry - manages loaded plugins.
 *
 * Can be instantiated for testing or used as singleton.
 */
export class PluginRegistry {
  private plugins: Map<string, PluginInstance> = new Map();
  private states: Map<string, PluginState> = new Map();
  private eventHandlers: Map<string, PluginEventHandler[]> = new Map();

  /**
   * Clear all plugins (useful for testing).
   */
  clear(): void {
    this.plugins.clear();
    this.states.clear();
    this.eventHandlers.clear();
  }

  /**
   * Register a plugin definition.
   * Handles both sync and async register functions.
   */
  async registerPluginAsync(definition: PluginDefinition, manifest?: PluginManifest): Promise<PluginInstance> {
    const existing = this.plugins.get(definition.id);
    if (existing) {
      throw new Error(`Plugin '${definition.id}' is already registered`);
    }

    const state = this.states.get(definition.id);
    const enabled = state?.enabled ?? true;
    const config = state?.config ?? {};

    const instance: PluginInstance = {
      definition,
      manifest: manifest ?? createFallbackManifest(definition),
      status: enabled ? "pending" : "disabled",
      skills: [],
      providers: [],
      commands: [],
      config
    };

    this.plugins.set(definition.id, instance);

    if (enabled) {
      await this.runRegistration(instance);
    }

    return instance;
  }

  /**
   * Register a plugin synchronously (for plugins with sync register only).
   */
  registerPlugin(definition: PluginDefinition, manifest?: PluginManifest): PluginInstance {
    const existing = this.plugins.get(definition.id);
    if (existing) {
      throw new Error(`Plugin '${definition.id}' is already registered`);
    }

    const state = this.states.get(definition.id);
    const enabled = state?.enabled ?? true;
    const config = state?.config ?? {};

    const instance: PluginInstance = {
      definition,
      manifest: manifest ?? createFallbackManifest(definition),
      status: enabled ? "pending" : "disabled",
      skills: [],
      providers: [],
      commands: [],
      config
    };

    this.plugins.set(definition.id, instance);

    if (enabled) {
      this.runRegistrationSync(instance);
    }

    return instance;
  }

  /**
   * Run the plugin's registration function (async).
   */
  private async runRegistration(instance: PluginInstance): Promise<void> {
    const api = this.createApi(instance);
    try {
      await instance.definition.register(api);
      instance.status = "enabled";
    } catch (error) {
      instance.status = "error";
      instance.error = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  /**
   * Run the plugin's registration function (sync).
   */
  private runRegistrationSync(instance: PluginInstance): void {
    const api = this.createApi(instance);
    try {
      const result = instance.definition.register(api);
      // Handle if register returns a promise
      if (result instanceof Promise) {
        throw new Error(`Plugin '${instance.definition.id}' has async register, use registerPluginAsync instead`);
      }
      instance.status = "enabled";
    } catch (error) {
      instance.status = "error";
      instance.error = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  /**
   * Create the VinkoPluginApi for a plugin instance.
   */
  private createApi(instance: PluginInstance): VinkoPluginApi {
    const logger = createPluginLogger(instance.definition.name);

    return {
      id: instance.definition.id,
      name: instance.definition.name,
      version: instance.definition.version ?? "0.0.0",
      logger,
      config: instance.config,

      registerSkill: (skill: PluginSkillDefinition) => {
        instance.skills.push(skill);
      },

      registerProvider: (provider: PluginProviderDefinition) => {
        instance.providers.push(provider);
      },

      registerCommand: (command: PluginCommandDefinition) => {
        instance.commands.push(command);
      },

      on: (event: string, handler: PluginEventHandler) => {
        const handlers = this.eventHandlers.get(event) ?? [];
        handlers.push(handler);
        this.eventHandlers.set(event, handlers);
      },

      resolvePath: (input: string) => input
    };
  }

  /**
   * Get a plugin by ID.
   */
  getPlugin(id: string): PluginInstance | undefined {
    return this.plugins.get(id);
  }

  /**
   * List all plugins.
   */
  listPlugins(): PluginInstance[] {
    return Array.from(this.plugins.values());
  }

  /**
   * Enable a plugin.
   */
  async enablePluginAsync(id: string): Promise<void> {
    const instance = this.plugins.get(id);
    if (!instance) {
      throw new Error(`Plugin '${id}' not found`);
    }

    if (instance.status === "enabled") {
      return;
    }

    if (instance.status === "disabled" || instance.status === "error") {
      if (instance.definition.onEnable) {
        const api = this.createApi(instance);
        await instance.definition.onEnable(api);
      }
      // Re-run registration if needed
      if (instance.skills.length === 0) {
        await this.runRegistration(instance);
      }
    }

    instance.status = "enabled";
    delete instance.error;
    this.states.set(id, { id, enabled: true, config: instance.config });
    this.emitEvent("enable", { pluginId: id });
  }

  /**
   * Enable a plugin (sync).
   */
  enablePlugin(id: string): void {
    const instance = this.plugins.get(id);
    if (!instance) {
      throw new Error(`Plugin '${id}' not found`);
    }

    if (instance.status === "enabled") {
      return;
    }

    if (instance.definition.onEnable) {
      const api = this.createApi(instance);
      const result = instance.definition.onEnable(api);
      if (result instanceof Promise) {
        throw new Error(`Plugin '${id}' has async onEnable, use enablePluginAsync instead`);
      }
    }

    instance.status = "enabled";
    delete instance.error;
    this.states.set(id, { id, enabled: true, config: instance.config });
    this.emitEvent("enable", { pluginId: id });
  }

  /**
   * Disable a plugin.
   */
  disablePlugin(id: string): void {
    const instance = this.plugins.get(id);
    if (!instance) {
      throw new Error(`Plugin '${id}' not found`);
    }

    if (instance.status === "disabled") {
      return;
    }

    if (instance.definition.onDisable) {
      const api = this.createApi(instance);
      instance.definition.onDisable(api);
    }

    instance.status = "disabled";
    this.states.set(id, { id, enabled: false, config: instance.config });
    this.emitEvent("disable", { pluginId: id });
  }

  /**
   * Get all skills from enabled plugins.
   */
  getSkills(): PluginSkillDefinition[] {
    const skills: PluginSkillDefinition[] = [];
    for (const instance of this.plugins.values()) {
      if (instance.status === "enabled") {
        skills.push(...instance.skills);
      }
    }
    return skills;
  }

  /**
   * Get skills available to a specific role.
   */
  getSkillsForRole(roleId: string): PluginSkillDefinition[] {
    return this.getSkills().filter(skill =>
      skill.allowedRoles.includes(roleId) || skill.allowedRoles.length === 0
    );
  }

  /**
   * Load persisted state for a plugin.
   */
  loadPluginState(state: PluginState): void {
    this.states.set(state.id, state);
  }

  /**
   * Get persisted state for a plugin.
   */
  getPluginState(id: string): PluginState | undefined {
    return this.states.get(id);
  }

  /**
   * Get all plugin states.
   */
  getAllPluginStates(): PluginState[] {
    return Array.from(this.states.values());
  }

  /**
   * Emit an event to registered handlers.
   */
  private emitEvent(event: string, payload: unknown): void {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(event, payload);
        } catch (error) {
          console.error(`Plugin event handler error for '${event}':`, error);
        }
      }
    }
  }

  /**
   * Update plugin configuration.
   */
  updateConfig(id: string, config: Record<string, unknown>): void {
    const instance = this.plugins.get(id);
    if (!instance) {
      throw new Error(`Plugin '${id}' not found`);
    }

    instance.config = config;
    this.states.set(id, { id, enabled: instance.status === "enabled", config });

    if (instance.definition.onConfigChange) {
      const api = this.createApi(instance);
      instance.definition.onConfigChange(api, config);
    }

    this.emitEvent("configChange", { pluginId: id, config });
  }

  /**
   * Emit task lifecycle hook to enabled plugins.
   */
  async emitTaskLifecycle(event: TaskLifecycleEvent): Promise<void> {
    for (const instance of this.plugins.values()) {
      if (instance.status !== "enabled") {
        continue;
      }
      if (!instance.definition.onTaskLifecycle) {
        continue;
      }
      const api = this.createApi(instance);
      try {
        await instance.definition.onTaskLifecycle(api, event);
      } catch (error) {
        instance.error = error instanceof Error ? error.message : String(error);
        this.emitEvent("error", {
          pluginId: instance.definition.id,
          phase: "onTaskLifecycle",
          error: instance.error
        });
      }
    }
  }

  /**
   * Emit approval lifecycle hook to enabled plugins.
   */
  async emitApprovalLifecycle(event: ApprovalLifecycleEvent): Promise<void> {
    for (const instance of this.plugins.values()) {
      if (instance.status !== "enabled") {
        continue;
      }
      if (!instance.definition.onApprovalLifecycle) {
        continue;
      }
      const api = this.createApi(instance);
      try {
        await instance.definition.onApprovalLifecycle(api, event);
      } catch (error) {
        instance.error = error instanceof Error ? error.message : String(error);
        this.emitEvent("error", {
          pluginId: instance.definition.id,
          phase: "onApprovalLifecycle",
          error: instance.error
        });
      }
    }
  }

  /**
   * Check if a plugin is registered.
   */
  hasPlugin(id: string): boolean {
    return this.plugins.has(id);
  }
}

// Singleton instance for production use
export const pluginRegistry = new PluginRegistry();

// Export convenience functions using the singleton
export function registerPlugin(definition: PluginDefinition, manifest?: PluginManifest): PluginInstance {
  return pluginRegistry.registerPlugin(definition, manifest);
}

export async function registerPluginAsync(definition: PluginDefinition, manifest?: PluginManifest): Promise<PluginInstance> {
  return pluginRegistry.registerPluginAsync(definition, manifest);
}

export function getPlugin(id: string): PluginInstance | undefined {
  return pluginRegistry.getPlugin(id);
}

export function listPlugins(): PluginInstance[] {
  return pluginRegistry.listPlugins();
}

export function enablePlugin(id: string): void {
  pluginRegistry.enablePlugin(id);
}

export async function enablePluginAsync(id: string): Promise<void> {
  await pluginRegistry.enablePluginAsync(id);
}

export function disablePlugin(id: string): void {
  pluginRegistry.disablePlugin(id);
}

export function getSkills(): PluginSkillDefinition[] {
  return pluginRegistry.getSkills();
}

export function getSkillsForRole(roleId: string): PluginSkillDefinition[] {
  return pluginRegistry.getSkillsForRole(roleId);
}

export function loadPluginState(state: PluginState): void {
  pluginRegistry.loadPluginState(state);
}

export function getPluginState(id: string): PluginState | undefined {
  return pluginRegistry.getPluginState(id);
}

export function getAllPluginStates(): PluginState[] {
  return pluginRegistry.getAllPluginStates();
}

export function updatePluginConfig(id: string, config: Record<string, unknown>): void {
  pluginRegistry.updateConfig(id, config);
}

export function hasPlugin(id: string): boolean {
  return pluginRegistry.hasPlugin(id);
}

export function clearPluginRegistry(): void {
  pluginRegistry.clear();
}

export async function emitTaskLifecycle(event: TaskLifecycleEvent): Promise<void> {
  await pluginRegistry.emitTaskLifecycle(event);
}

export async function emitApprovalLifecycle(event: ApprovalLifecycleEvent): Promise<void> {
  await pluginRegistry.emitApprovalLifecycle(event);
}

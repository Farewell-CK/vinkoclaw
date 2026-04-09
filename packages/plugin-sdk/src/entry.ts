/**
 * Plugin SDK - Entry point helper for defining plugins
 *
 * This module provides the definePluginEntry function that plugin authors
 * use to define their plugin's metadata and registration logic.
 */

import type { DefinePluginEntryOptions, PluginDefinition } from "./types.js";

/**
 * Define a plugin entry point.
 *
 * Plugin authors use this function to declare their plugin's identity,
 * capabilities, and registration logic.
 *
 * @example
 * ```typescript
 * import { definePluginEntry, type VinkoPluginApi } from "@vinko/plugin-sdk";
 *
 * export default definePluginEntry({
 *   id: "vector-memory",
 *   name: "Vector Memory",
 *   version: "1.0.0",
 *   kind: "skill",
 *   description: "Persist role memory in vector database",
 *   allowedRoles: ["ceo", "cto", "backend"],
 *   register(api: VinkoPluginApi) {
 *     api.logger.info(`${api.name} plugin registered`);
 *     api.registerSkill({
 *       id: "vector-memory",
 *       name: "Vector Memory",
 *       description: "Persist role memory in vector database",
 *       allowedRoles: ["ceo", "cto", "backend"],
 *       defaultConfig: { backend: "vector-db" },
 *       aliases: ["vector", "向量记忆"]
 *     });
 *   }
 * });
 * ```
 */
export function definePluginEntry(options: DefinePluginEntryOptions): PluginDefinition {
  const definition: PluginDefinition = {
    id: options.id,
    name: options.name,
    kind: options.kind,
    register: options.register
  };

  // Only add optional fields if they are defined
  if (options.version !== undefined) {
    definition.version = options.version;
  }
  if (options.description !== undefined) {
    definition.description = options.description;
  }
  if (options.configSchema !== undefined) {
    definition.configSchema = options.configSchema;
  }
  if (options.allowedRoles !== undefined) {
    definition.allowedRoles = options.allowedRoles;
  }
  if (options.onEnable !== undefined) {
    definition.onEnable = options.onEnable;
  }
  if (options.onDisable !== undefined) {
    definition.onDisable = options.onDisable;
  }
  if (options.onConfigChange !== undefined) {
    definition.onConfigChange = options.onConfigChange;
  }
  if (options.onTaskLifecycle !== undefined) {
    definition.onTaskLifecycle = options.onTaskLifecycle;
  }
  if (options.onApprovalLifecycle !== undefined) {
    definition.onApprovalLifecycle = options.onApprovalLifecycle;
  }

  return definition;
}

/**
 * @vinko/plugin-sdk - VinkoClaw Plugin SDK
 *
 * This package provides the public API for developing VinkoClaw plugins.
 * It defines the contract between plugins and the VinkoClaw core.
 *
 * @example Defining a skill plugin
 * ```typescript
 * import { definePluginEntry, type VinkoPluginApi } from "@vinko/plugin-sdk";
 *
 * export default definePluginEntry({
 *   id: "my-skill",
 *   name: "My Skill",
 *   kind: "skill",
 *   register(api: VinkoPluginApi) {
 *     api.registerSkill({
 *       id: "my-skill",
 *       name: "My Skill",
 *       description: "A custom skill",
 *       allowedRoles: ["developer"],
 *       defaultConfig: {},
 *       aliases: ["my"]
 *     });
 *   }
 * });
 * ```
 */

// Core types
export type {
  PluginKind,
  PluginManifest,
  PluginConfigSchema,
  PluginConfigProperty,
  PluginLogger,
  PluginEvent,
  TaskLifecycleEvent,
  ApprovalLifecycleEvent,
  PluginDefinition,
  PluginSkillDefinition,
  PluginProviderDefinition,
  PluginCommandDefinition,
  VinkoPluginApi,
  PluginInstance,
  PluginState,
  DefinePluginEntryOptions
} from "./types.js";

// Entry point helper
export { definePluginEntry } from "./entry.js";

// Configuration utilities
export {
  validateConfig,
  applyDefaults,
  stringProperty,
  numberProperty,
  booleanProperty,
  createSchema
} from "./config.js";

// Logger utilities
export { createPluginLogger, silentLogger, createFileLogger } from "./logger.js";

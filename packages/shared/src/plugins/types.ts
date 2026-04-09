/**
 * Plugin Runtime - Runtime-specific types
 *
 * These types are used internally by the plugin runtime and are not
 * part of the public plugin SDK.
 */

import type {
  PluginDefinition,
  PluginInstance,
  PluginManifest,
  PluginSkillDefinition,
  PluginState
} from "@vinko/plugin-sdk";

/**
 * Plugin module - the result of loading a plugin file
 */
export interface PluginModule {
  default: PluginDefinition;
  manifest?: PluginManifest;
}

/**
 * Plugin registry - manages loaded plugins
 */
export interface PluginRegistryInterface {
  registerPlugin(definition: PluginDefinition, manifest?: PluginManifest): PluginInstance;
  getPlugin(id: string): PluginInstance | undefined;
  listPlugins(): PluginInstance[];
  enablePlugin(id: string): void;
  disablePlugin(id: string): void;
  getSkills(): PluginSkillDefinition[];
  getSkillsForRole(roleId: string): PluginSkillDefinition[];
  loadPluginState(state: PluginState): void;
  getPluginState(id: string): PluginState | undefined;
}

/**
 * Plugin loader - loads plugins from modules and manifests
 */
export interface PluginLoaderInterface {
  loadFromManifest(manifest: PluginManifest): PluginInstance;
  loadBundledPlugins(): PluginInstance[];
  validateManifest(raw: unknown): PluginManifest | null;
}

/**
 * Plugin event handler
 */
export type PluginEventHandler = (event: string, payload: unknown) => void;

/**
 * Bundled plugin info - describes a bundled plugin location
 */
export interface BundledPluginInfo {
  id: string;
  manifestPath: string;
  entryPath: string;
}
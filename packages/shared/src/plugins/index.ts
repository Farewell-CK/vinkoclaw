/**
 * @vinko/shared/plugins - Plugin Runtime Module
 *
 * This module provides the plugin registry and loader for VinkoClaw.
 * It is internal to the VinkoClaw core and not part of the public SDK.
 */

// Types
export type {
  PluginModule,
  PluginRegistryInterface,
  PluginLoaderInterface,
  PluginEventHandler,
  BundledPluginInfo
} from "./types.js";

// Manifest validation
export { validateManifest, isValidManifestId, MANIFEST_FILE_NAME } from "./manifest.js";

// Registry
export {
  PluginRegistry,
  pluginRegistry,
  registerPlugin,
  registerPluginAsync,
  getPlugin,
  listPlugins,
  enablePlugin,
  enablePluginAsync,
  disablePlugin,
  getSkills,
  getSkillsForRole,
  loadPluginState,
  getPluginState,
  getAllPluginStates,
  updatePluginConfig,
  hasPlugin,
  clearPluginRegistry,
  emitTaskLifecycle,
  emitApprovalLifecycle
} from "./registry.js";

// Loader functions
export {
  loadPluginFromModule,
  loadPluginFromManifestPath,
  loadBundledPlugins,
  scanBundledPlugins,
  loadPluginDefinitionSync
} from "./loader.js";

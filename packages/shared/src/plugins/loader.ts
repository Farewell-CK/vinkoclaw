/**
 * Plugin Runtime - Plugin Loader
 *
 * Loads plugins from modules and manifest files.
 */

import type { PluginDefinition, PluginManifest, PluginInstance } from "@vinko/plugin-sdk";
import { validateManifest, MANIFEST_FILE_NAME } from "./manifest.js";
import { registerPlugin } from "./registry.js";
import type { BundledPluginInfo } from "./types.js";

/**
 * Load a plugin from a module (imported entry file).
 */
export function loadPluginFromModule(module: { default: PluginDefinition }, manifest?: PluginManifest): PluginInstance {
  const definition = module.default;

  if (!definition || typeof definition !== "object") {
    throw new Error("Invalid plugin module: missing default export");
  }

  if (!definition.id || !definition.name || !definition.kind) {
    throw new Error("Invalid plugin definition: missing required fields (id, name, kind)");
  }

  return registerPlugin(definition, manifest);
}

/**
 * Load a plugin from a manifest file path (async).
 *
 * This reads the manifest and dynamically imports the entry file.
 */
export async function loadPluginFromManifestPath(manifestPath: string): Promise<PluginInstance | null> {
  try {
    // Read manifest
    const fs = await import("node:fs/promises");
    const manifestContent = await fs.readFile(manifestPath, "utf-8");
    const manifestRaw = JSON.parse(manifestContent);

    const manifest = validateManifest(manifestRaw);
    if (!manifest) {
      console.error(`Invalid manifest at ${manifestPath}`);
      return null;
    }

    // Determine entry path
    const entryPath = manifest.entry ?? "./src/index.js";
    const baseDir = manifestPath.substring(0, manifestPath.lastIndexOf("/"));
    const fullEntryPath = `${baseDir}/${entryPath}`;

    // Import entry
    const module = await import(fullEntryPath) as { default: PluginDefinition };
    return loadPluginFromModule(module, manifest);
  } catch (error) {
    console.error(`Failed to load plugin from ${manifestPath}:`, error);
    return null;
  }
}

/**
 * Load bundled plugins from a directory.
 *
 * Scans the directory for vinkoclaw.plugin.json files and loads each plugin.
 */
export async function loadBundledPlugins(pluginsDir: string): Promise<PluginInstance[]> {
  const instances: PluginInstance[] = [];

  try {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");

    // Scan for plugin directories
    const entries = await fs.readdir(pluginsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const pluginDir = path.join(pluginsDir, entry.name);
      const manifestPath = path.join(pluginDir, MANIFEST_FILE_NAME);

      try {
        const instance = await loadPluginFromManifestPath(manifestPath);
        if (instance) {
          instances.push(instance);
        }
      } catch {
        // Skip plugins that fail to load
      }
    }
  } catch (error) {
    console.error(`Failed to scan plugins directory ${pluginsDir}:`, error);
  }

  return instances;
}

/**
 * Get bundled plugin info from a directory.
 */
export async function scanBundledPlugins(pluginsDir: string): Promise<BundledPluginInfo[]> {
  const infos: BundledPluginInfo[] = [];

  try {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");

    const entries = await fs.readdir(pluginsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const pluginDir = path.join(pluginsDir, entry.name);
      const manifestPath = path.join(pluginDir, MANIFEST_FILE_NAME);

      try {
        const manifestContent = await fs.readFile(manifestPath, "utf-8");
        const manifest = validateManifest(JSON.parse(manifestContent));

        if (manifest) {
          infos.push({
            id: manifest.id,
            manifestPath,
            entryPath: path.join(pluginDir, manifest.entry ?? "./src/index.ts")
          });
        }
      } catch {
        // Skip invalid
      }
    }
  } catch {
    // Directory might not exist
  }

  return infos;
}

/**
 * Sync version for use when dynamic import isn't needed.
 */
export function loadPluginDefinitionSync(definition: PluginDefinition, manifest?: PluginManifest): PluginInstance {
  return registerPlugin(definition, manifest);
}
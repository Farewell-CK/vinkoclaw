/**
 * Plugin Runtime - Manifest validation
 *
 * Validates plugin manifests against the expected schema.
 */

import type { PluginKind, PluginManifest, PluginConfigSchema } from "@vinko/plugin-sdk";

const VALID_KINDS: PluginKind[] = ["skill", "provider", "channel", "tool", "command"];

/**
 * Validate a raw manifest object.
 *
 * @param raw - The raw manifest data (usually from JSON)
 * @returns Validated manifest or null if invalid
 */
export function validateManifest(raw: unknown): PluginManifest | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }

  const data = raw as Record<string, unknown>;

  // Required fields
  if (typeof data.id !== "string" || !data.id.trim()) {
    return null;
  }
  if (typeof data.name !== "string" || !data.name.trim()) {
    return null;
  }
  if (typeof data.version !== "string" || !data.version.trim()) {
    return null;
  }

  // Validate kind
  const kind = data.kind as PluginKind;
  if (!VALID_KINDS.includes(kind)) {
    return null;
  }

  // Validate configSchema if present
  if (data.configSchema && typeof data.configSchema === "object") {
    const schema = data.configSchema as Record<string, unknown>;
    if (schema.type !== "object") {
      return null;
    }
  }

  // Validate allowedRoles if present
  if (data.allowedRoles !== undefined) {
    if (!Array.isArray(data.allowedRoles)) {
      return null;
    }
    for (const role of data.allowedRoles) {
      if (typeof role !== "string") {
        return null;
      }
    }
  }

  // Validate dependencies if present
  if (data.dependencies !== undefined) {
    if (typeof data.dependencies !== "object" || Array.isArray(data.dependencies)) {
      return null;
    }
    for (const [key, value] of Object.entries(data.dependencies as Record<string, unknown>)) {
      if (typeof key !== "string" || typeof value !== "string") {
        return null;
      }
    }
  }

  const manifest: PluginManifest = {
    id: data.id.trim(),
    name: data.name.trim(),
    version: data.version.trim(),
    kind,
    description: typeof data.description === "string" ? data.description.trim() : undefined,
    configSchema: data.configSchema as PluginConfigSchema | undefined,
    dependencies: data.dependencies as Record<string, string> | undefined,
    allowedRoles: data.allowedRoles as string[] | undefined,
    entry: typeof data.entry === "string" ? data.entry.trim() : undefined
  };

  return manifest;
}

/**
 * Check if a manifest ID is valid (no special chars, reasonable length).
 */
export function isValidManifestId(id: string): boolean {
  if (!id || id.length > 64) {
    return false;
  }
  // Allow alphanumeric, hyphens, underscores
  return /^[\w-]+$/.test(id);
}

/**
 * Get the default manifest file name.
 */
export const MANIFEST_FILE_NAME = "vinkoclaw.plugin.json";
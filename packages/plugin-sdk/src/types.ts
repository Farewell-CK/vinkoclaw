/**
 * Plugin SDK - Core type definitions for VinkoClaw plugins
 *
 * This module defines the public contract between plugins and the VinkoClaw core.
 */

export type PluginKind = "skill" | "provider" | "channel" | "tool" | "command";

/**
 * Plugin manifest - metadata loaded from vinkoclaw.plugin.json
 */
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string | undefined;
  kind: PluginKind;
  configSchema?: PluginConfigSchema | undefined;
  dependencies?: Record<string, string> | undefined;
  allowedRoles?: string[] | undefined;
  entry?: string | undefined;
}

/**
 * JSON Schema style configuration definition
 */
export interface PluginConfigSchema {
  type: "object";
  properties?: Record<string, PluginConfigProperty> | undefined;
  required?: string[] | undefined;
  [key: string]: unknown;
}

/**
 * Individual property definition in config schema
 */
export interface PluginConfigProperty {
  type: "string" | "number" | "boolean" | "object" | "array";
  description?: string | undefined;
  default?: unknown | undefined;
  enum?: string[] | undefined;
  minimum?: number | undefined;
  maximum?: number | undefined;
  [key: string]: unknown;
}

/**
 * Plugin logger interface - provided by core to plugins
 */
export interface PluginLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
}

/**
 * Plugin event types for lifecycle hooks
 */
export type PluginEvent = "enable" | "disable" | "configChange" | "error";

export interface TaskLifecycleEvent {
  phase: "before_task" | "after_task";
  taskId: string;
  roleId: string;
  source: string;
  status?: string | undefined;
  summary?: string | undefined;
  errorText?: string | undefined;
}

export interface ApprovalLifecycleEvent {
  phase: "before_approval_decision" | "after_approval_decision";
  approvalId: string;
  kind: string;
  status?: string | undefined;
  requestedBy?: string | undefined;
  decidedBy?: string | undefined;
}

/**
 * Plugin definition - returned by definePluginEntry
 */
export interface PluginDefinition {
  id: string;
  name: string;
  version?: string | undefined;
  description?: string | undefined;
  kind: PluginKind;
  configSchema?: PluginConfigSchema | undefined;
  allowedRoles?: string[] | undefined;
  register: (api: VinkoPluginApi) => void | Promise<void>;
  onEnable?: (api: VinkoPluginApi) => void | Promise<void> | undefined;
  onDisable?: (api: VinkoPluginApi) => void | Promise<void> | undefined;
  onConfigChange?: (api: VinkoPluginApi, newConfig: Record<string, unknown>) => void | undefined;
  onTaskLifecycle?: (api: VinkoPluginApi, event: TaskLifecycleEvent) => void | Promise<void> | undefined;
  onApprovalLifecycle?: (api: VinkoPluginApi, event: ApprovalLifecycleEvent) => void | Promise<void> | undefined;
}

/**
 * Skill definition - for skill plugins
 */
export interface PluginSkillDefinition {
  id: string;
  name: string;
  description: string;
  allowedRoles: string[];
  defaultConfig: Record<string, unknown>;
  aliases: string[];
}

/**
 * Provider definition - for provider plugins
 */
export interface PluginProviderDefinition {
  id: string;
  name: string;
  type: "model" | "tool" | "memory";
  configSchema?: PluginConfigSchema;
}

/**
 * Command definition - for command plugins
 */
export interface PluginCommandDefinition {
  id: string;
  name: string;
  description?: string;
  handler: (args: Record<string, unknown>) => void | Promise<void>;
}

/**
 * VinkoPluginApi - interface provided to plugins during registration
 */
export interface VinkoPluginApi {
  // Plugin identity
  readonly id: string;
  readonly name: string;
  readonly version: string;

  // Runtime utilities
  readonly logger: PluginLogger;
  readonly config: Record<string, unknown>;

  // Registration methods
  registerSkill(skill: PluginSkillDefinition): void;
  registerProvider(provider: PluginProviderDefinition): void;
  registerCommand(command: PluginCommandDefinition): void;

  // Lifecycle hooks
  on(event: PluginEvent, handler: (...args: unknown[]) => void): void;

  // Utility methods
  resolvePath(input: string): string;
}

/**
 * Plugin instance - runtime representation of a loaded plugin
 */
export interface PluginInstance {
  definition: PluginDefinition;
  manifest: PluginManifest;
  status: "pending" | "enabled" | "disabled" | "error";
  skills: PluginSkillDefinition[];
  providers: PluginProviderDefinition[];
  commands: PluginCommandDefinition[];
  config: Record<string, unknown>;
  error?: string;
}

/**
 * Plugin state - persisted state for a plugin
 */
export interface PluginState {
  id: string;
  enabled: boolean;
  config: Record<string, unknown>;
}

/**
 * Options for definePluginEntry function
 */
export interface DefinePluginEntryOptions {
  id: string;
  name: string;
  version?: string;
  description?: string;
  kind: PluginKind;
  configSchema?: PluginConfigSchema;
  allowedRoles?: string[];
  register: (api: VinkoPluginApi) => void | Promise<void>;
  onEnable?: (api: VinkoPluginApi) => void | Promise<void>;
  onDisable?: (api: VinkoPluginApi) => void | Promise<void>;
  onConfigChange?: (api: VinkoPluginApi, newConfig: Record<string, unknown>) => void;
  onTaskLifecycle?: (api: VinkoPluginApi, event: TaskLifecycleEvent) => void | Promise<void>;
  onApprovalLifecycle?: (api: VinkoPluginApi, event: ApprovalLifecycleEvent) => void | Promise<void>;
}

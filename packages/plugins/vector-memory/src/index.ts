/**
 * Vector Memory Plugin - VinkoClaw Plugin Example
 *
 * This plugin provides vector-backed memory persistence for roles.
 */

import { definePluginEntry, type VinkoPluginApi, type PluginSkillDefinition } from "@vinko/plugin-sdk";

const ALLOWED_ROLES = [
  "ceo",
  "cto",
  "product",
  "uiux",
  "frontend",
  "backend",
  "algorithm",
  "qa",
  "developer",
  "engineering",
  "research",
  "operations"
];

const skillDefinition: PluginSkillDefinition = {
  id: "vector-memory",
  name: "Vector Memory",
  description: "Persist role memory in a local vector-backed memory configuration.",
  allowedRoles: ALLOWED_ROLES,
  defaultConfig: {
    backend: "vector-db",
    namespaceStrategy: "role"
  },
  aliases: ["vector", "vector-memory", "向量记忆", "向量数据库", "向量库"]
};

export default definePluginEntry({
  id: "vector-memory",
  name: "Vector Memory",
  version: "1.0.0",
  kind: "skill",
  description: "Persist role memory in vector database",
  allowedRoles: ALLOWED_ROLES,

  register(api: VinkoPluginApi) {
    api.logger.info(`${api.name} plugin registering...`);
    api.registerSkill(skillDefinition);
    api.logger.info(`${api.name} plugin registered successfully`);
  },

  onEnable(api: VinkoPluginApi) {
    api.logger.info(`${api.name} plugin enabled`);
  },

  onDisable(api: VinkoPluginApi) {
    api.logger.info(`${api.name} plugin disabled`);
  },

  onConfigChange(api: VinkoPluginApi, newConfig: Record<string, unknown>) {
    api.logger.info(`${api.name} config changed:`, newConfig);
  }
});
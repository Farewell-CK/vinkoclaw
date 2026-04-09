/**
 * Code Executor Plugin - VinkoClaw Plugin Example
 *
 * This plugin provides code execution capabilities with approval gating.
 */

import { definePluginEntry, type VinkoPluginApi, type PluginSkillDefinition } from "@vinko/plugin-sdk";

const ALLOWED_ROLES = [
  "cto",
  "frontend",
  "backend",
  "algorithm",
  "developer",
  "engineering"
];

const skillDefinition: PluginSkillDefinition = {
  id: "code-executor",
  name: "Code Executor",
  description: "Plan and approval-gate development and code execution tasks.",
  allowedRoles: ALLOWED_ROLES,
  defaultConfig: {
    approvalRequired: true,
    timeoutMs: 60000
  },
  aliases: ["code", "executor", "开发", "编码", "代码执行"]
};

export default definePluginEntry({
  id: "code-executor",
  name: "Code Executor",
  version: "1.0.0",
  kind: "skill",
  description: "Plan and approval-gate development and code execution tasks",
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
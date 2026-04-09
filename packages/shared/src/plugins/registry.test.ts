import { describe, it, expect, beforeEach } from "vitest";
import { PluginRegistry, clearPluginRegistry } from "./registry.js";
import type { PluginDefinition, PluginSkillDefinition } from "@vinko/plugin-sdk";

// Helper to create a test plugin definition
function createTestPlugin(id: string, options?: {
  kind?: "skill" | "provider" | "channel" | "tool" | "command";
  skills?: PluginSkillDefinition[];
}): PluginDefinition {
  return {
    id,
    name: `Test Plugin ${id}`,
    kind: options?.kind ?? "skill",
    register: (api) => {
      if (options?.skills) {
        for (const skill of options.skills) {
          api.registerSkill(skill);
        }
      }
      api.logger.info(`${id} registered`);
    }
  };
}

describe("PluginRegistry", () => {
  let registry: PluginRegistry;

  beforeEach(() => {
    registry = new PluginRegistry();
  });

  describe("registerPlugin", () => {
    it("should register a plugin successfully", () => {
      const plugin = createTestPlugin("test-plugin");
      const instance = registry.registerPlugin(plugin);

      expect(instance.definition.id).toBe("test-plugin");
      expect(instance.status).toBe("enabled");
      expect(registry.hasPlugin("test-plugin")).toBe(true);
    });

    it("should throw if plugin is already registered", () => {
      const plugin = createTestPlugin("duplicate-plugin");
      registry.registerPlugin(plugin);

      expect(() => registry.registerPlugin(plugin)).toThrow("already registered");
    });

    it("should register skills during registration", () => {
      const skill: PluginSkillDefinition = {
        id: "test-skill",
        name: "Test Skill",
        description: "A test skill",
        allowedRoles: ["developer"],
        defaultConfig: {},
        aliases: ["test"]
      };

      const plugin = createTestPlugin("skill-plugin", { skills: [skill] });
      const instance = registry.registerPlugin(plugin);

      expect(instance.skills.length).toBe(1);
      expect(instance.skills[0]?.id).toBe("test-skill");
    });

    it("should respect enabled state from loaded state", () => {
      registry.loadPluginState({ id: "disabled-plugin", enabled: false, config: {} });

      const plugin = createTestPlugin("disabled-plugin");
      const instance = registry.registerPlugin(plugin);

      expect(instance.status).toBe("disabled");
    });

    it("should apply config from loaded state", () => {
      registry.loadPluginState({ id: "config-plugin", enabled: true, config: { setting: "value" } });

      const plugin = createTestPlugin("config-plugin");
      const instance = registry.registerPlugin(plugin);

      expect(instance.config).toEqual({ setting: "value" });
    });
  });

  describe("enablePlugin / disablePlugin", () => {
    it("should enable a disabled plugin", () => {
      registry.loadPluginState({ id: "toggle-plugin", enabled: false, config: {} });
      const plugin = createTestPlugin("toggle-plugin");
      registry.registerPlugin(plugin);

      expect(registry.getPlugin("toggle-plugin")?.status).toBe("disabled");

      registry.enablePlugin("toggle-plugin");

      expect(registry.getPlugin("toggle-plugin")?.status).toBe("enabled");
    });

    it("should disable an enabled plugin", () => {
      const plugin = createTestPlugin("enabled-plugin");
      registry.registerPlugin(plugin);

      expect(registry.getPlugin("enabled-plugin")?.status).toBe("enabled");

      registry.disablePlugin("enabled-plugin");

      expect(registry.getPlugin("enabled-plugin")?.status).toBe("disabled");
    });

    it("should throw if enabling non-existent plugin", () => {
      expect(() => registry.enablePlugin("nonexistent")).toThrow("not found");
    });

    it("should throw if disabling non-existent plugin", () => {
      expect(() => registry.disablePlugin("nonexistent")).toThrow("not found");
    });
  });

  describe("getSkills", () => {
    it("should return skills from enabled plugins only", () => {
      const skill1: PluginSkillDefinition = {
        id: "skill-1",
        name: "Skill 1",
        description: "First skill",
        allowedRoles: ["developer"],
        defaultConfig: {},
        aliases: []
      };

      const skill2: PluginSkillDefinition = {
        id: "skill-2",
        name: "Skill 2",
        description: "Second skill",
        allowedRoles: ["cto"],
        defaultConfig: {},
        aliases: []
      };

      registry.registerPlugin(createTestPlugin("plugin-1", { skills: [skill1] }));
      registry.loadPluginState({ id: "plugin-2", enabled: false, config: {} });
      registry.registerPlugin(createTestPlugin("plugin-2", { skills: [skill2] }));

      const skills = registry.getSkills();

      expect(skills.length).toBe(1);
      expect(skills[0]?.id).toBe("skill-1");
    });

    it("should return empty array if no plugins registered", () => {
      expect(registry.getSkills()).toEqual([]);
    });
  });

  describe("getSkillsForRole", () => {
    it("should filter skills by role", () => {
      const skill: PluginSkillDefinition = {
        id: "role-skill",
        name: "Role Skill",
        description: "A role-specific skill",
        allowedRoles: ["developer", "cto"],
        defaultConfig: {},
        aliases: []
      };

      registry.registerPlugin(createTestPlugin("role-plugin", { skills: [skill] }));

      expect(registry.getSkillsForRole("developer").length).toBe(1);
      expect(registry.getSkillsForRole("qa").length).toBe(0);
    });

    it("should include skills with empty allowedRoles", () => {
      const universalSkill: PluginSkillDefinition = {
        id: "universal-skill",
        name: "Universal Skill",
        description: "Available to all",
        allowedRoles: [],
        defaultConfig: {},
        aliases: []
      };

      registry.registerPlugin(createTestPlugin("universal-plugin", { skills: [universalSkill] }));

      expect(registry.getSkillsForRole("any-role").length).toBe(1);
    });
  });

  describe("updateConfig", () => {
    it("should update plugin config", () => {
      const plugin = createTestPlugin("config-update-plugin");
      registry.registerPlugin(plugin);

      registry.updateConfig("config-update-plugin", { newSetting: 42 });

      expect(registry.getPlugin("config-update-plugin")?.config).toEqual({ newSetting: 42 });
    });

    it("should throw if updating non-existent plugin", () => {
      expect(() => registry.updateConfig("nonexistent", {})).toThrow("not found");
    });
  });

  describe("clear", () => {
    it("should clear all registered plugins", () => {
      registry.registerPlugin(createTestPlugin("plugin-a"));
      registry.registerPlugin(createTestPlugin("plugin-b"));

      expect(registry.listPlugins().length).toBe(2);

      registry.clear();

      expect(registry.listPlugins().length).toBe(0);
      expect(registry.hasPlugin("plugin-a")).toBe(false);
    });
  });

  describe("listPlugins", () => {
    it("should return all registered plugins", () => {
      registry.registerPlugin(createTestPlugin("list-1"));
      registry.registerPlugin(createTestPlugin("list-2"));

      const plugins = registry.listPlugins();

      expect(plugins.length).toBe(2);
      expect(plugins.map(p => p.definition.id)).toContain("list-1");
      expect(plugins.map(p => p.definition.id)).toContain("list-2");
    });
  });

  describe("lifecycle hooks", () => {
    it("emits task lifecycle events to enabled plugins", async () => {
      const events: string[] = [];
      registry.registerPlugin({
        id: "lifecycle-task-plugin",
        name: "Lifecycle Task Plugin",
        kind: "skill",
        register: () => {},
        onTaskLifecycle: async (_api, event) => {
          events.push(`${event.phase}:${event.taskId}`);
        }
      });

      await registry.emitTaskLifecycle({
        phase: "before_task",
        taskId: "task-1",
        roleId: "developer",
        source: "system",
        status: "running"
      });

      expect(events).toEqual(["before_task:task-1"]);
    });

    it("emits approval lifecycle events to enabled plugins", async () => {
      const events: string[] = [];
      registry.registerPlugin({
        id: "lifecycle-approval-plugin",
        name: "Lifecycle Approval Plugin",
        kind: "skill",
        register: () => {},
        onApprovalLifecycle: (_api, event) => {
          events.push(`${event.phase}:${event.approvalId}:${event.status ?? ""}`);
        }
      });

      await registry.emitApprovalLifecycle({
        phase: "after_approval_decision",
        approvalId: "approval-1",
        kind: "task_execution",
        status: "approved",
        decidedBy: "ceo"
      });

      expect(events).toEqual(["after_approval_decision:approval-1:approved"]);
    });
  });
});

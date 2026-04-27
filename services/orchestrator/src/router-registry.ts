import type { RoleId, RoutingTemplate } from "@vinko/shared";
import { listRoles } from "@vinko/shared";

export interface RouterRoleCandidate {
  id: RoleId;
  name: string;
  aliases: string[];
  responsibility: string;
}

export interface RouterTemplateCandidate {
  id: string;
  name: string;
  description: string;
  triggerKeywords: string[];
  taskRoles: RoleId[];
}

export interface RouterRegistrySnapshot {
  roles: RouterRoleCandidate[];
  templates: RouterTemplateCandidate[];
}

export function buildRouterRegistrySnapshot(input: {
  templates: RoutingTemplate[];
}): RouterRegistrySnapshot {
  return {
    roles: listRoles().map((role) => ({
      id: role.id,
      name: role.name,
      aliases: role.aliases.slice(0, 8),
      responsibility: role.responsibility
    })),
    templates: input.templates
      .filter((template) => template.enabled && template.tasks.length > 0)
      .map((template) => ({
        id: template.id,
        name: template.name,
        description: template.description,
        triggerKeywords: template.triggerKeywords.slice(0, 12),
        taskRoles: Array.from(new Set(template.tasks.map((task) => task.roleId))).slice(0, 8)
      }))
  };
}

export function renderRouterRegistryForPrompt(snapshot: RouterRegistrySnapshot): string {
  const templates = snapshot.templates
    .map((template) =>
      [
        `- ${template.id}: ${template.name}`,
        template.description ? `  description: ${template.description}` : "",
        template.triggerKeywords.length > 0 ? `  triggers: ${template.triggerKeywords.join(", ")}` : "",
        template.taskRoles.length > 0 ? `  roles: ${template.taskRoles.join(", ")}` : ""
      ]
        .filter(Boolean)
        .join("\n")
    )
    .join("\n");
  const roles = snapshot.roles
    .map((role) => `- ${role.id}: ${role.name}; ${role.responsibility}; aliases=${role.aliases.join(", ")}`)
    .join("\n");
  return [
    "Available templates:",
    templates || "- none",
    "",
    "Available roles:",
    roles || "- none"
  ].join("\n");
}

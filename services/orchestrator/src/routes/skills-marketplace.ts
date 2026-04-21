import express from "express";
import {
  searchMarketplaceSkills,
  getMarketplaceSkillDetail,
  getMarketplaceRecommendation,
  getSkillDefinition,
  resolveRoleId
} from "@vinko/shared";
import type {
  SkillMarketplaceEntry,
  VinkoStore,
  TaskRecord,
  SkillBindingRecord,
  TaskSource,
  RoleId
} from "@vinko/shared";

type SkillDetail = Awaited<ReturnType<typeof getMarketplaceSkillDetail>>;

export interface SkillsMarketplaceRoutesDeps {
  store: VinkoStore;
  createSkillSmokeVerifyTask: (input: {
    sessionId?: string | undefined;
    source: TaskSource;
    requestedBy?: string | undefined;
    chatId?: string | undefined;
    targetRoleId: RoleId;
    skill: NonNullable<SkillDetail>;
  }) => TaskRecord;
  createSkillRuntimeIntegrationTask: (input: {
    sessionId?: string | undefined;
    source: TaskSource;
    requestedBy?: string | undefined;
    chatId?: string | undefined;
    targetRoleId?: RoleId | undefined;
    skill: NonNullable<SkillDetail>;
  }) => TaskRecord;
  formatSkillIntegrationTaskQueuedMessage: (input: {
    source: TaskSource;
    taskId: string;
    skillName: string;
  }) => string;
}

export function registerSkillsMarketplaceRoutes(app: express.Express, deps: SkillsMarketplaceRoutesDeps): void {
  const { store, createSkillSmokeVerifyTask, createSkillRuntimeIntegrationTask, formatSkillIntegrationTaskQueuedMessage } = deps;

  app.get("/api/skills/market/search", async (request, response) => {
    const query = typeof request.query.q === "string" ? request.query.q : "";
    const roleId = typeof request.query.roleId === "string" ? resolveRoleId(request.query.roleId) : undefined;
    const limitRaw = Number(request.query.limit);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(20, Math.round(limitRaw))) : 8;
    try {
      const results = await searchMarketplaceSkills({ query, limit });
      const roleBindings = roleId ? store.resolveSkillsForRole(roleId) : [];
      const enrichedResults = results
        .map((entry) => {
        const binding = roleBindings.find((item) => item.skillId === entry.skillId);
        const roleBinding: {
          installed: boolean;
          verificationStatus: "" | "verified" | "unverified" | "failed";
          installedAt?: string;
          verifiedAt?: string;
        } = binding
          ? {
              installed: true,
              verificationStatus: binding.verificationStatus ?? "unverified",
              installedAt: binding.installedAt ?? "",
              verifiedAt: binding.verifiedAt ?? ""
            }
          : {
              installed: false,
              verificationStatus: ""
            };
        const recommendation = getMarketplaceRecommendation({
          entry,
          roleBinding,
          roleId
        });
        return {
          ...entry,
          roleBinding,
          recommendation
        };
        })
        .sort((left, right) => {
          const scoreDelta = (right.recommendation?.score ?? 0) - (left.recommendation?.score ?? 0);
          return scoreDelta || left.name.localeCompare(right.name);
        });
      response.json({
        query,
        roleId: roleId ?? "",
        results: enrichedResults
      });
    } catch (error) {
      response.status(502).json({
        error: "skill_market_search_failed",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  });

  app.get("/api/skills/market/:skillId", async (request, response) => {
    try {
      const detail = await getMarketplaceSkillDetail(request.params.skillId);
      if (!detail) {
        response.status(404).json({ error: "skill_not_found" });
        return;
      }
      response.json(detail);
    } catch (error) {
      response.status(502).json({
        error: "skill_market_detail_failed",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  });

  app.post("/api/skills/market/install", express.json(), async (request, response) => {
    const body =
      typeof request.body === "object" && request.body !== null ? (request.body as Record<string, unknown>) : {};
    const skillId = typeof body.skillId === "string" ? body.skillId.trim() : "";
    const roleId = typeof body.roleId === "string" ? resolveRoleId(body.roleId) : undefined;
    const installedBy = typeof body.installedBy === "string" ? body.installedBy.trim() : "";
    if (!skillId || !roleId) {
      response.status(400).json({ error: "invalid_skill_install_request" });
      return;
    }

    const detail = await getMarketplaceSkillDetail(skillId);
    if (!detail) {
      response.status(404).json({ error: "skill_not_found" });
      return;
    }

    const definition = getSkillDefinition(detail.skillId);
    if (!definition) {
      response.status(409).json({
        error: "skill_not_installable",
        message: "This skill was discovered but is not yet available in the local runtime.",
        installState: detail.installState
      });
      return;
    }

    if (!definition.allowedRoles.includes(roleId)) {
      response.status(409).json({
        error: "skill_role_not_allowed",
        message: `${detail.skillId} cannot be installed for ${roleId}.`
      });
      return;
    }

    const binding = store.setSkillBinding({
      scope: "role",
      scopeId: roleId,
      skillId: detail.skillId,
      status: "enabled",
      verificationStatus: "unverified",
      config: definition.defaultConfig,
      installedBy: installedBy || undefined,
      source: detail.source,
      sourceLabel: detail.sourceLabel,
      sourceUrl: detail.sourceUrl,
      version: detail.version
    });
    const verifyTask = createSkillSmokeVerifyTask({
      source: "control-center",
      requestedBy: installedBy || undefined,
      targetRoleId: roleId,
      skill: detail
    });
    response.status(201).json({
      ok: true,
      roleId,
      skill: detail,
      binding,
      verifyTask: {
        id: verifyTask.id,
        roleId: verifyTask.roleId,
        title: verifyTask.title
      }
    });
  });

  app.post("/api/skills/market/request-integration", express.json(), async (request, response) => {
    const body =
      typeof request.body === "object" && request.body !== null ? (request.body as Record<string, unknown>) : {};
    const skillId = typeof body.skillId === "string" ? body.skillId.trim() : "";
    const targetRoleId = typeof body.targetRoleId === "string" ? resolveRoleId(body.targetRoleId) : undefined;
    const requestedBy = typeof body.requestedBy === "string" ? body.requestedBy.trim() : "";
    const source = body.source === "feishu" || body.source === "email" || body.source === "system" ? body.source : "control-center";
    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : undefined;
    const chatId = typeof body.chatId === "string" ? body.chatId.trim() : undefined;
    if (!skillId) {
      response.status(400).json({ error: "invalid_skill_integration_request" });
      return;
    }

    const detail = await getMarketplaceSkillDetail(skillId);
    if (!detail) {
      response.status(404).json({ error: "skill_not_found" });
      return;
    }

    const task = createSkillRuntimeIntegrationTask({
      sessionId,
      source,
      requestedBy: requestedBy || undefined,
      chatId,
      targetRoleId,
      skill: detail
    });

    response.status(201).json({
      ok: true,
      taskId: task.id,
      roleId: task.roleId,
      targetRoleId,
      skill: detail,
      message: formatSkillIntegrationTaskQueuedMessage({
        source,
        taskId: task.id,
        skillName: detail.name
      })
    });
  });
}

import express from "express";
import type { CreateCrmLeadInput, CrmLeadStage, UpdateCrmLeadInput, VinkoStore } from "@vinko/shared";

export interface CrmRoutesDeps {
  store: VinkoStore;
}

export function registerCrmRoutes(app: express.Express, deps: CrmRoutesDeps): void {
  const { store } = deps;

  app.get("/api/crm/leads", (request, response) => {
    const includeArchived = request.query.includeArchived === "1" || request.query.includeArchived === "true";
    const stage = (typeof request.query.stage === "string" ? request.query.stage : undefined) as
      | CrmLeadStage
      | undefined;
    const linkedProjectId =
      typeof request.query.linkedProjectId === "string" && request.query.linkedProjectId.trim()
        ? request.query.linkedProjectId.trim()
        : undefined;
    response.json({
      leads: store.listCrmLeads({
        status: includeArchived ? undefined : "active",
        stage,
        linkedProjectId
      })
    });
  });

  app.post("/api/crm/leads", (request, response) => {
    const body = request.body as Partial<CreateCrmLeadInput>;
    if (typeof body?.name !== "string" || !body.name.trim()) {
      response.status(400).json({ error: "lead_name_required" });
      return;
    }
    if (typeof body?.source !== "string" || !body.source.trim()) {
      response.status(400).json({ error: "lead_source_required" });
      return;
    }
    const lead = store.createCrmLead({
      name: body.name.trim(),
      company: typeof body.company === "string" ? body.company.trim() : undefined,
      title: typeof body.title === "string" ? body.title.trim() : undefined,
      email: typeof body.email === "string" ? body.email.trim() : undefined,
      source: body.source.trim(),
      stage: body.stage,
      tags: Array.isArray(body.tags) ? body.tags.map((tag) => String(tag).trim()).filter(Boolean) : undefined,
      latestSummary: typeof body.latestSummary === "string" ? body.latestSummary.trim() : undefined,
      nextAction: typeof body.nextAction === "string" ? body.nextAction.trim() : undefined,
      ownerRoleId: body.ownerRoleId,
      linkedProjectId: typeof body.linkedProjectId === "string" ? body.linkedProjectId.trim() : undefined,
      lastContactAt: typeof body.lastContactAt === "string" ? body.lastContactAt : undefined,
      metadata: typeof body.metadata === "object" && body.metadata !== null ? body.metadata : undefined
    });
    response.status(201).json({ lead });
  });

  app.get("/api/crm/leads/:leadId", (request, response) => {
    const lead = store.getCrmLead(request.params.leadId);
    if (!lead) {
      response.status(404).json({ error: "lead_not_found" });
      return;
    }
    response.json({ lead });
  });

  app.patch("/api/crm/leads/:leadId", (request, response) => {
    const body = request.body as UpdateCrmLeadInput;
    const lead = store.updateCrmLead(request.params.leadId, {
      ...body,
      name: typeof body.name === "string" ? body.name.trim() : body.name,
      company: typeof body.company === "string" ? body.company.trim() : body.company,
      title: typeof body.title === "string" ? body.title.trim() : body.title,
      email: typeof body.email === "string" ? body.email.trim() : body.email,
      source: typeof body.source === "string" ? body.source.trim() : body.source,
      latestSummary: typeof body.latestSummary === "string" ? body.latestSummary.trim() : body.latestSummary,
      nextAction: typeof body.nextAction === "string" ? body.nextAction.trim() : body.nextAction,
      linkedProjectId:
        typeof body.linkedProjectId === "string" ? body.linkedProjectId.trim() : body.linkedProjectId,
      tags: Array.isArray(body.tags) ? body.tags.map((tag) => String(tag).trim()).filter(Boolean) : body.tags
    });
    if (!lead) {
      response.status(404).json({ error: "lead_not_found" });
      return;
    }
    response.json({ lead });
  });

  app.post("/api/crm/leads/:leadId/archive", (_request, response) => {
    const lead = store.archiveCrmLead(_request.params.leadId);
    if (!lead) {
      response.status(404).json({ error: "lead_not_found" });
      return;
    }
    response.json({ lead });
  });
}

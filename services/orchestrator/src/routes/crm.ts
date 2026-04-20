import express from "express";
import type {
  CreateCrmCadenceInput,
  CreateCrmLeadInput,
  CrmCadenceStatus,
  CrmLeadStage,
  UpdateCrmCadenceInput,
  UpdateCrmLeadInput,
  VinkoStore
} from "@vinko/shared";

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

  app.get("/api/crm/cadences", (request, response) => {
    const includeArchived = request.query.includeArchived === "1" || request.query.includeArchived === "true";
    const status =
      typeof request.query.status === "string" && request.query.status.trim()
        ? (request.query.status.trim() as CrmCadenceStatus)
        : undefined;
    const leadId =
      typeof request.query.leadId === "string" && request.query.leadId.trim()
        ? request.query.leadId.trim()
        : undefined;
    const dueBefore =
      typeof request.query.dueBefore === "string" && request.query.dueBefore.trim()
        ? request.query.dueBefore.trim()
        : undefined;
    response.json({
      cadences: store.listCrmCadences({
        leadId,
        status: includeArchived ? status : status ?? "active",
        dueBefore
      })
    });
  });

  app.get("/api/crm/dashboard", (_request, response) => {
    const leads = store.listCrmLeads({ limit: 500 });
    const activeCadences = store.listCrmCadences({ status: "active", limit: 500 });
    const nowIso = new Date().toISOString();
    const overdueCadences = store.listCrmCadences({
      status: "active",
      dueBefore: nowIso,
      limit: 500
    });
    response.json({
      generatedAt: nowIso,
      summary: {
        activeLeads: leads.filter((lead) => lead.status === "active").length,
        activeCadences: activeCadences.length,
        overdueCadences: overdueCadences.length,
        projectLinkedLeads: leads.filter((lead) => Boolean(lead.linkedProjectId)).length
      },
      overdueCadences: overdueCadences.slice(0, 20),
      activeLeads: leads.slice(0, 20)
    });
  });

  app.post("/api/crm/cadences", (request, response) => {
    const body = request.body as Partial<CreateCrmCadenceInput>;
    if (typeof body?.leadId !== "string" || !body.leadId.trim()) {
      response.status(400).json({ error: "cadence_lead_id_required" });
      return;
    }
    if (!store.getCrmLead(body.leadId.trim())) {
      response.status(404).json({ error: "lead_not_found" });
      return;
    }
    if (typeof body?.label !== "string" || !body.label.trim()) {
      response.status(400).json({ error: "cadence_label_required" });
      return;
    }
    if (typeof body?.intervalDays !== "number" || !Number.isFinite(body.intervalDays) || body.intervalDays <= 0) {
      response.status(400).json({ error: "cadence_interval_days_invalid" });
      return;
    }
    if (typeof body?.objective !== "string" || !body.objective.trim()) {
      response.status(400).json({ error: "cadence_objective_required" });
      return;
    }
    if (typeof body?.nextRunAt !== "string" || !body.nextRunAt.trim()) {
      response.status(400).json({ error: "cadence_next_run_at_required" });
      return;
    }
    const cadence = store.createCrmCadence({
      leadId: body.leadId.trim(),
      label: body.label.trim(),
      channel: body.channel,
      intervalDays: body.intervalDays,
      objective: body.objective.trim(),
      nextRunAt: body.nextRunAt.trim(),
      ownerRoleId: body.ownerRoleId,
      metadata: typeof body.metadata === "object" && body.metadata !== null ? body.metadata : undefined
    });
    response.status(201).json({ cadence });
  });

  app.get("/api/crm/cadences/:cadenceId", (request, response) => {
    const cadence = store.getCrmCadence(request.params.cadenceId);
    if (!cadence) {
      response.status(404).json({ error: "cadence_not_found" });
      return;
    }
    response.json({ cadence });
  });

  app.patch("/api/crm/cadences/:cadenceId", (request, response) => {
    const body = request.body as UpdateCrmCadenceInput;
    const cadence = store.updateCrmCadence(request.params.cadenceId, {
      ...body,
      label: typeof body.label === "string" ? body.label.trim() : body.label,
      objective: typeof body.objective === "string" ? body.objective.trim() : body.objective,
      nextRunAt: typeof body.nextRunAt === "string" ? body.nextRunAt.trim() : body.nextRunAt
    });
    if (!cadence) {
      response.status(404).json({ error: "cadence_not_found" });
      return;
    }
    response.json({ cadence });
  });

  app.post("/api/crm/cadences/:cadenceId/archive", (request, response) => {
    const cadence = store.archiveCrmCadence(request.params.cadenceId);
    if (!cadence) {
      response.status(404).json({ error: "cadence_not_found" });
      return;
    }
    response.json({ cadence });
  });
}

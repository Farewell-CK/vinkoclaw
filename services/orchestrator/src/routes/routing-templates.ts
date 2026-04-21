import express from "express";
import type {
  CreateRoutingTemplateInput,
  UpdateRoutingTemplateInput,
  RoutingTemplate,
  VinkoStore
} from "@vinko/shared";

type NormalizedTemplateBody = CreateRoutingTemplateInput | UpdateRoutingTemplateInput;

function normalizeRoutingTemplateBody(
  raw: Partial<CreateRoutingTemplateInput | UpdateRoutingTemplateInput>
): Partial<NormalizedTemplateBody> {
  const body: Partial<NormalizedTemplateBody> = {};
  if (raw.name != null) {
    body.name = String(raw.name);
  }
  if (raw.description != null) {
    body.description = String(raw.description || "");
  }
  if (Array.isArray(raw.triggerKeywords)) {
    body.triggerKeywords = raw.triggerKeywords.map((entry) => String(entry));
  }
  if (raw.matchMode === "any" || raw.matchMode === "all") {
    body.matchMode = raw.matchMode;
  }
  if (raw.enabled != null) {
    body.enabled = Boolean(raw.enabled);
  }
  if (Array.isArray(raw.tasks)) {
    body.tasks = raw.tasks;
  }
  return body;
}

export interface RoutingTemplateRoutesDeps {
  store: VinkoStore;
}

export function registerRoutingTemplateRoutes(app: express.Express, deps: RoutingTemplateRoutesDeps): void {
  const { store } = deps;

  app.get("/api/routing-templates", (_request, response) => {
    response.json(store.listRoutingTemplates());
  });

  app.get("/api/routing-templates/export", (_request, response) => {
    response.json({
      version: 1,
      exportedAt: new Date().toISOString(),
      templates: store.listRoutingTemplates()
    });
  });

  app.post("/api/routing-templates", (request, response) => {
    const body = normalizeRoutingTemplateBody(request.body as Partial<CreateRoutingTemplateInput>);
    if (!body.name || !Array.isArray(body.triggerKeywords) || !Array.isArray(body.tasks)) {
      response.status(400).json({ error: "invalid_template_payload" });
      return;
    }

    try {
      const template = store.createRoutingTemplate({
        name: body.name,
        description: body.description,
        triggerKeywords: body.triggerKeywords,
        matchMode: body.matchMode,
        enabled: body.enabled,
        tasks: body.tasks
      });
      response.status(201).json(template);
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/routing-templates/import", (request, response) => {
    const body = request.body as {
      templates?: unknown;
      mode?: "merge" | "replace";
    };
    const mode = body.mode === "replace" ? "replace" : "merge";
    if (!Array.isArray(body.templates)) {
      response.status(400).json({ error: "templates_array_required" });
      return;
    }

    try {
      const nextTemplates = store.importRoutingTemplates(body.templates as RoutingTemplate[], mode);
      response.status(201).json({
        ok: true,
        mode,
        count: nextTemplates.length,
        templates: nextTemplates
      });
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.put("/api/routing-templates/:templateId", (request, response) => {
    const body = normalizeRoutingTemplateBody(request.body as Partial<UpdateRoutingTemplateInput>);
    try {
      const updated = store.updateRoutingTemplate(request.params.templateId, body);
      if (!updated) {
        response.status(404).json({ error: "template_not_found" });
        return;
      }

      response.json(updated);
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.delete("/api/routing-templates/:templateId", (request, response) => {
    const deleted = store.deleteRoutingTemplate(request.params.templateId);
    if (!deleted) {
      response.status(404).json({ error: "template_not_found" });
      return;
    }

    response.status(204).end();
  });
}

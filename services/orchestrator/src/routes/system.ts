import express from "express";
import type { RoleId, VinkoStore, DashboardSnapshot } from "@vinko/shared";
import { listRoles, listSkills, renderPrometheusMetrics } from "@vinko/shared";
import { createToolBackedRegistry, createDefaultRulesEngine, globalTelemetry } from "@vinko/agent-runtime";

export interface SystemRoutesDeps {
  store: VinkoStore;
  buildSystemMetricsSnapshot: () => Record<string, unknown>;
  buildSystemHealthReport: () => Record<string, unknown>;
  buildSystemDailyKpi: (days: number) => Record<string, unknown>;
  sanitizeApprovalRecord: <T extends { payload: Record<string, unknown> }>(approval: T) => T;
  sanitizeOperatorActionRecord: <T extends { payload: Record<string, unknown> }>(action: T) => T;
}

export function registerSystemRoutes(app: express.Express, deps: SystemRoutesDeps): void {
  const { store, buildSystemMetricsSnapshot, buildSystemHealthReport, buildSystemDailyKpi, sanitizeApprovalRecord, sanitizeOperatorActionRecord } = deps;

  app.get("/health", (_request, response) => {
    response.json({
      ok: true,
      timestamp: new Date().toISOString(),
      config: store.getRuntimeConfig()
    });
  });

  app.get("/metrics", (_request, response) => {
    const snapshot = store.getDashboardSnapshot();
    response.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    response.send(renderPrometheusMetrics(snapshot));
  });

  app.get("/api/dashboard", (_request, response) => {
    const snapshot = store.getDashboardSnapshot();
    response.json({
      ...snapshot,
      approvals: snapshot.approvals.map((approval) => sanitizeApprovalRecord(approval)),
      operatorActions: snapshot.operatorActions.map((action) => sanitizeOperatorActionRecord(action))
    });
  });

  app.get("/api/system/metrics", (_request, response) => {
    response.json(buildSystemMetricsSnapshot());
  });

  app.get("/api/system/health-report", (_request, response) => {
    const report = buildSystemHealthReport();
    response.status(report.ok ? 200 : 503).json(report);
  });

  app.get("/api/system/kpi/daily", (request, response) => {
    const daysRaw = Number(request.query.days);
    const days = Number.isFinite(daysRaw) ? Math.max(1, Math.min(90, Math.round(daysRaw))) : 14;
    response.json(buildSystemDailyKpi(days));
  });

  app.get("/api/roles", (_request, response) => {
    response.json({
      roles: listRoles().map((role) => ({
        ...role,
        skills: store.resolveSkillsForRole(role.id)
      })),
      catalog: listSkills()
    });
  });

  // ─── Telemetry routes ────────────────────────────────────────────────────

  app.get("/api/system/telemetry", (_request, response) => {
    const traces = globalTelemetry.listTraces();
    const limit = Math.min(Number(_request.query.limit) || 20, 100);
    response.json({
      total: traces.length,
      traces: traces.slice(-limit).reverse()
    });
  });

  app.get("/api/system/runtime-harness", (_request, response) => {
    const registry = createToolBackedRegistry({
      workDir: "/tmp/vinkoclaw-runtime-harness",
      secrets: {},
      searchProvider: ""
    });
    const rulesEngine = createDefaultRulesEngine();
    const catalog = listSkills();
    const roles = listRoles().map((role) => {
      const bindings = store.resolveSkillsForRole(role.id as RoleId);
      return {
        roleId: role.id,
        roleName: role.name,
        total: bindings.length,
        verified: bindings.filter((binding) => binding.verificationStatus === "verified").length,
        unverified: bindings.filter((binding) => (binding.verificationStatus ?? "unverified") === "unverified").length,
        failed: bindings.filter((binding) => binding.verificationStatus === "failed").length,
        bindings: bindings.map((binding) => ({
          skillId: binding.skillId,
          verificationStatus: binding.verificationStatus ?? "unverified",
          source: binding.source ?? "",
          sourceLabel: binding.sourceLabel ?? "",
          version: binding.version ?? "",
          installedAt: binding.installedAt ?? "",
          verifiedAt: binding.verifiedAt ?? ""
        }))
      };
    });
    response.json({
      toolRegistry: {
        mode: "default",
        total: registry.list().length,
        tools: registry.list().map((tool) => ({
          id: tool.id,
          name: tool.name,
          category: tool.category,
          riskLevel: tool.riskLevel,
          enabledByDefault: tool.enabledByDefault !== false,
          tags: tool.tags
        }))
      },
      rulesEngine: {
        mode: "default",
        total: rulesEngine.listRules().length,
        rules: rulesEngine.listRules().map((rule) => ({
          id: rule.id,
          toolId: rule.toolId,
          phase: rule.phase,
          action: rule.action,
          reason: rule.reason
        }))
      },
      skills: {
        mode: "role_bound",
        catalogTotal: catalog.length,
        catalog: catalog.map((skill) => ({
          skillId: skill.id,
          name: skill.name,
          allowedRoles: skill.allowedRoles,
          aliases: skill.aliases
        })),
        roles
      }
    });
  });

  app.get("/api/tasks/:id/trace", (request, response) => {
    const trace = globalTelemetry.getTrace(request.params.id);
    if (!trace) {
      return response.status(404).json({ error: "No trace found for this task" });
    }
    response.json(trace);
  });
}

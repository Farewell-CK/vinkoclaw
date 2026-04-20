import express from "express";
import type { VinkoStore } from "@vinko/shared";
import { buildCrmDashboardSnapshot, runDueCadences } from "./crm.js";

export interface RecurringRoutesDeps {
  store: VinkoStore;
}

export function registerRecurringRoutes(app: express.Express, deps: RecurringRoutesDeps): void {
  const { store } = deps;

  app.get("/api/recurring/dashboard", (_request, response) => {
    const crm = buildCrmDashboardSnapshot(store);
    response.json({
      generatedAt: new Date().toISOString(),
      summary: {
        dueCadences: Number(crm.summary.overdueCadences ?? 0),
        activeCadences: Number(crm.summary.activeCadences ?? 0),
        activeLeads: Number(crm.summary.activeLeads ?? 0)
      },
      crm
    });
  });

  app.post("/api/recurring/run-due", (_request, response) => {
    const crm = runDueCadences(store);
    response.json({
      generatedAt: new Date().toISOString(),
      summary: {
        triggered: Number(crm.summary.triggered ?? 0),
        skipped: Number(crm.summary.skipped ?? 0),
        dueCadences: Number(crm.summary.dueCadences ?? 0)
      },
      crm
    });
  });
}

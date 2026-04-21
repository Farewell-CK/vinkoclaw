import express from "express";
import type { VinkoStore } from "@vinko/shared";
import { buildCrmDashboardSnapshot, runDueCadences } from "./crm.js";

export interface RecurringRoutesDeps {
  store: VinkoStore;
}

export interface RecurringScheduler {
  tickOnce: () => ReturnType<typeof runDueCadences>;
  stop: () => void;
}

export function buildRecurringHistorySnapshot(store: VinkoStore) {
  const runs = (store.listTasks?.(500) ?? [])
    .filter((task) => {
      const metadata = task.metadata ?? {};
      return task.requestedBy === "crm-cadence" || metadata.workflowLabel === "crm_follow_up";
    })
    .map((task) => {
      const metadata = task.metadata ?? {};
      const triggeredAt =
        (typeof metadata.cadenceTriggeredAt === "string" && metadata.cadenceTriggeredAt.trim()) || task.createdAt;
      return {
        taskId: task.id,
        cadenceId: typeof metadata.crmCadenceId === "string" ? metadata.crmCadenceId : "",
        leadId: typeof metadata.crmLeadId === "string" ? metadata.crmLeadId : "",
        title: task.title,
        status: task.status,
        triggeredAt
      };
    })
    .sort((left, right) => Date.parse(right.triggeredAt) - Date.parse(left.triggeredAt));

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      totalRuns: runs.length,
      successfulRuns: runs.filter((run) => run.status === "completed").length,
      inFlightRuns: runs.filter((run) => run.status === "queued" || run.status === "running").length,
      lastRunAt: runs[0]?.triggeredAt ?? ""
    },
    recentRuns: runs.slice(0, 20)
  };
}

export function createRecurringScheduler(input: {
  store: VinkoStore;
  enabled: boolean;
  intervalMs: number;
  onRun?: ((summary: ReturnType<typeof runDueCadences>["summary"]) => void) | undefined;
  onError?: ((error: unknown) => void) | undefined;
}): RecurringScheduler {
  let running = false;
  const tickOnce = () => {
    if (running) {
      return {
        generatedAt: new Date().toISOString(),
        summary: { dueCadences: 0, triggered: 0, skipped: 0 },
        triggered: [],
        skipped: [{ cadenceId: "scheduler", error: "tick_already_running" }]
      };
    }
    running = true;
    try {
      const result = runDueCadences(input.store);
      input.onRun?.(result.summary);
      return result;
    } catch (error) {
      input.onError?.(error);
      return {
        generatedAt: new Date().toISOString(),
        summary: { dueCadences: 0, triggered: 0, skipped: 1 },
        triggered: [],
        skipped: [{ cadenceId: "scheduler", error: error instanceof Error ? error.message : "unknown_error" }]
      };
    } finally {
      running = false;
    }
  };

  const intervalMs = Math.max(10000, Math.round(input.intervalMs));
  const timer = input.enabled ? setInterval(tickOnce, intervalMs) : undefined;
  timer?.unref?.();

  return {
    tickOnce,
    stop: () => {
      if (timer) {
        clearInterval(timer);
      }
    }
  };
}

export function registerRecurringRoutes(app: express.Express, deps: RecurringRoutesDeps): void {
  const { store } = deps;

  app.get("/api/recurring/dashboard", (_request, response) => {
    const crm = buildCrmDashboardSnapshot(store);
    const history = buildRecurringHistorySnapshot(store);
    response.json({
      generatedAt: new Date().toISOString(),
      summary: {
        dueCadences: Number(crm.summary.overdueCadences ?? 0),
        activeCadences: Number(crm.summary.activeCadences ?? 0),
        activeLeads: Number(crm.summary.activeLeads ?? 0),
        lastRunAt: history.summary.lastRunAt
      },
      crm,
      history
    });
  });

  app.get("/api/recurring/history", (_request, response) => {
    response.json(buildRecurringHistorySnapshot(store));
  });

  app.post("/api/recurring/run-due", (_request, response) => {
    const crm = runDueCadences(store);
    const history = buildRecurringHistorySnapshot(store);
    response.json({
      generatedAt: new Date().toISOString(),
      summary: {
        triggered: Number(crm.summary.triggered ?? 0),
        skipped: Number(crm.summary.skipped ?? 0),
        dueCadences: Number(crm.summary.dueCadences ?? 0)
      },
      crm,
      history
    });
  });

  app.post("/api/recurring/tick", (_request, response) => {
    const crm = runDueCadences(store);
    const history = buildRecurringHistorySnapshot(store);
    response.json({
      generatedAt: new Date().toISOString(),
      mode: "auto",
      summary: {
        triggered: Number(crm.summary.triggered ?? 0),
        skipped: Number(crm.summary.skipped ?? 0),
        dueCadences: Number(crm.summary.dueCadences ?? 0),
        lastRunAt: history.summary.lastRunAt
      },
      crm,
      history
    });
  });
}

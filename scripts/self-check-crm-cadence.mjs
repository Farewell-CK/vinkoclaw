#!/usr/bin/env node

import { runResetRuntimeDrain } from "./harness-preflight.mjs";

const ORCH_BASE = process.env.ORCH_BASE_URL ?? "http://127.0.0.1:8098";
const PREFLIGHT_TIMEOUT_MS = Number(process.env.CRM_CADENCE_PREFLIGHT_TIMEOUT_MS ?? 120_000);

function emitHarnessMeta(patch) {
  process.stderr.write(`HARNESS_META ${JSON.stringify({ suite: "crm-cadence", ...patch })}\n`);
}

function fail(message, patch = {}) {
  emitHarnessMeta({ regressionCategory: patch.regressionCategory ?? "failed", status: "failed", detail: message, ...patch });
  process.stderr.write(`[self-check:crm-cadence] FAIL: ${message}\n`);
  process.exit(1);
}

function info(message) {
  process.stdout.write(`[self-check:crm-cadence] ${message}\n`);
}

async function fetchJson(pathname, init = undefined) {
  const response = await fetch(`${ORCH_BASE}${pathname}`, init);
  const text = await response.text();
  if (!response.ok) {
    fail(`HTTP ${response.status} ${pathname}: ${text}`, { regressionCategory: "http_error" });
  }
  try {
    return JSON.parse(text);
  } catch {
    fail(`invalid json response for ${pathname}: ${text}`, { regressionCategory: "parse_error" });
  }
}

async function runQueuePreflightDrain() {
  emitHarnessMeta({
    stage: "preflight-drain",
    status: "in_progress",
    regressionCategory: "preflight_start",
    timeoutMs: PREFLIGHT_TIMEOUT_MS
  });
  const exitCode = await runResetRuntimeDrain({
    orchBase: ORCH_BASE,
    timeoutMs: PREFLIGHT_TIMEOUT_MS,
    maxBusyTasks: 0,
    reason: `crm-cadence-selfcheck-${Date.now()}`
  });
  if (exitCode !== 0) {
    fail(`preflight drain failed with exitCode=${exitCode}`, {
      stage: "preflight-drain",
      regressionCategory: "preflight_failed"
    });
  }
  emitHarnessMeta({
    stage: "preflight-drain",
    status: "completed",
    regressionCategory: "none",
    statePresent: true,
    stateStage: "preflight",
    stateStatus: "clean"
  });
}

async function main() {
  info(`orchestrator=${ORCH_BASE}`);
  await runQueuePreflightDrain();

  const unique = `crm-cadence-selfcheck-${Date.now()}`;

  emitHarnessMeta({ stage: "lead", status: "in_progress", regressionCategory: "in_progress" });
  const leadPayload = await fetchJson("/api/crm/leads", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      name: `Lead ${unique}`,
      company: "Selfcheck Labs",
      source: "system",
      stage: "qualified",
      latestSummary: "对 AI 创业团队产品表达兴趣",
      nextAction: "安排产品演示",
      ownerRoleId: "operations",
      linkedProjectId: "project:vinkoclaw"
    })
  });
  const lead = leadPayload?.lead;
  if (!lead?.id) {
    fail("lead creation did not return an id", {
      stage: "lead",
      regressionCategory: "lead_missing"
    });
  }
  emitHarnessMeta({
    stage: "lead",
    status: "completed",
    regressionCategory: "none",
    detail: `lead=${lead.id}`,
    statePresent: true,
    stateStage: "lead",
    stateStatus: "created"
  });

  emitHarnessMeta({ stage: "cadence", status: "in_progress", regressionCategory: "in_progress" });
  const cadencePayload = await fetchJson("/api/crm/cadences", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      leadId: lead.id,
      label: `weekly follow-up ${unique}`,
      channel: "email",
      intervalDays: 7,
      objective: "发送演示邀请并确认下次沟通时间",
      nextRunAt: "2026-04-19T09:00:00.000Z",
      ownerRoleId: "operations",
      metadata: { suite: "crm-cadence" }
    })
  });
  const cadence = cadencePayload?.cadence;
  if (!cadence?.id) {
    fail("cadence creation did not return an id", {
      stage: "cadence",
      regressionCategory: "cadence_missing"
    });
  }
  emitHarnessMeta({
    stage: "cadence",
    status: "completed",
    regressionCategory: "none",
    detail: `cadence=${cadence.id}`,
    statePresent: true,
    stateStage: "cadence",
    stateStatus: "created"
  });

  emitHarnessMeta({ stage: "dashboard", status: "in_progress", regressionCategory: "in_progress" });
  const dashboard = await fetchJson("/api/crm/dashboard");
  if (Number(dashboard?.summary?.activeLeads ?? 0) < 1 || Number(dashboard?.summary?.activeCadences ?? 0) < 1) {
    fail(`crm dashboard summary incomplete: ${JSON.stringify(dashboard?.summary ?? null)}`, {
      stage: "dashboard",
      regressionCategory: "dashboard_missing_summary"
    });
  }
  emitHarnessMeta({
    stage: "dashboard",
    status: "completed",
    regressionCategory: "none",
    detail: `activeLeads=${Number(dashboard.summary.activeLeads)} activeCadences=${Number(dashboard.summary.activeCadences)}`,
    statePresent: true,
    stateStage: "dashboard",
    stateStatus: "observed"
  });

  emitHarnessMeta({ stage: "trigger", status: "in_progress", regressionCategory: "in_progress" });
  const trigger = await fetchJson(`/api/crm/cadences/${cadence.id}/trigger-followup`, {
    method: "POST"
  });
  if (!trigger?.task?.id || !trigger?.session?.id) {
    fail(`trigger-followup missing task/session: ${JSON.stringify(trigger)}`, {
      stage: "trigger",
      regressionCategory: "followup_missing_task"
    });
  }
  emitHarnessMeta({
    stage: "trigger",
    status: "completed",
    regressionCategory: "none",
    detail: `task=${trigger.task.id} session=${trigger.session.id}`,
    statePresent: true,
    stateStage: "trigger",
    stateStatus: "created"
  });

  emitHarnessMeta({ stage: "run-due", status: "in_progress", regressionCategory: "in_progress" });
  const runDue = await fetchJson("/api/crm/cadences/run-due", {
    method: "POST"
  });
  const triggered = Number(runDue?.summary?.triggered ?? 0);
  if (triggered < 0 || !Array.isArray(runDue?.triggered)) {
    fail(`run-due returned invalid payload: ${JSON.stringify(runDue)}`, {
      stage: "run-due",
      regressionCategory: "run_due_invalid"
    });
  }
  emitHarnessMeta({
    stage: "run-due",
    status: "completed",
    regressionCategory: "none",
    detail: `triggered=${triggered} skipped=${Number(runDue?.summary?.skipped ?? 0)}`,
    completedStages: ["lead", "cadence", "dashboard", "trigger", "run-due"],
    statePresent: true,
    stateStage: "crm_cadence",
    stateStatus: "active"
  });

  info("PASS");
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error), { regressionCategory: "exception" });
});

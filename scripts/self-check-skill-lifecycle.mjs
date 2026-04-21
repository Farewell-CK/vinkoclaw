#!/usr/bin/env node

import { runResetRuntimeDrain, startHarnessTaskRunner } from "./harness-preflight.mjs";

const ORCH_BASE = process.env.ORCH_BASE_URL ?? "http://127.0.0.1:8098";
const PREFLIGHT_TIMEOUT_MS = Number(process.env.SKILL_LIFECYCLE_PREFLIGHT_TIMEOUT_MS ?? 120_000);

function emitHarnessMeta(patch) {
  process.stderr.write(`HARNESS_META ${JSON.stringify({ suite: "skill-lifecycle", ...patch })}\n`);
}

function fail(message, patch = {}) {
  emitHarnessMeta({ regressionCategory: patch.regressionCategory ?? "failed", status: "failed", detail: message, ...patch });
  process.stderr.write(`[self-check:skill-lifecycle] FAIL: ${message}\n`);
  process.exit(1);
}

function info(message) {
  process.stdout.write(`[self-check:skill-lifecycle] ${message}\n`);
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
    reason: `skill-lifecycle-selfcheck-${Date.now()}`
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

function pickInstallCandidate(results) {
  if (!Array.isArray(results)) {
    return undefined;
  }
  return results.find((entry) => {
    if (!entry || typeof entry !== "object") return false;
    if (entry.installState !== "local_installable") return false;
    const roles = Array.isArray(entry.allowedRoles) ? entry.allowedRoles : [];
    return roles.includes("product") || roles.includes("engineering") || roles.includes("research");
  });
}

async function main() {
  info(`orchestrator=${ORCH_BASE}`);
  await runQueuePreflightDrain();
  let taskRunner;
  try {
    taskRunner = await startHarnessTaskRunner({
      label: "skill-lifecycle"
    });
    emitHarnessMeta({ stage: "search", status: "in_progress", regressionCategory: "in_progress" });

    const searchPayload = await fetchJson("/api/skills/market/search?q=prd&roleId=product&limit=8");
    const results = Array.isArray(searchPayload?.results) ? searchPayload.results : [];
    if (results.length === 0) {
      fail("market search returned no skills", { stage: "search", regressionCategory: "market_empty" });
    }
    const candidate = pickInstallCandidate(results);
    if (!candidate) {
      fail("no local_installable candidate from marketplace search", {
        stage: "search",
        regressionCategory: "market_not_installable"
      });
    }

    emitHarnessMeta({
      stage: "search",
      status: "completed",
      regressionCategory: "none",
      detail: `candidate=${candidate.skillId}`,
      statePresent: true,
      stateStage: "discover",
      stateStatus: "active"
    });

    const targetRole = Array.isArray(candidate.allowedRoles) && candidate.allowedRoles.includes("product")
      ? "product"
      : Array.isArray(candidate.allowedRoles) && candidate.allowedRoles.includes("engineering")
        ? "engineering"
        : "research";

    emitHarnessMeta({ stage: "install", status: "in_progress", regressionCategory: "in_progress" });
    const installPayload = await fetchJson("/api/skills/market/install", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        skillId: candidate.skillId,
        roleId: targetRole,
        installedBy: "selfcheck-skill-lifecycle"
      })
    });

    const bindingSkillId = installPayload?.binding?.skillId;
    const verifyTaskId = installPayload?.verifyTask?.id;
    if (bindingSkillId !== candidate.skillId) {
      fail(`installed skill mismatch: expected=${candidate.skillId}, got=${String(bindingSkillId)}`, {
        stage: "install",
        regressionCategory: "install_mismatch"
      });
    }
    if (!verifyTaskId || typeof verifyTaskId !== "string") {
      fail("install did not return verify task id", {
        stage: "install",
        regressionCategory: "verify_task_missing"
      });
    }

    const verifyTaskPayload = await fetchJson(`/api/tasks/${verifyTaskId}`);
    const verifyTask = verifyTaskPayload?.task ?? verifyTaskPayload;
    if (!verifyTask || verifyTask.id !== verifyTaskId) {
      fail(`verify task ${verifyTaskId} could not be loaded`, {
        stage: "verify",
        regressionCategory: "verify_task_unreachable"
      });
    }

    emitHarnessMeta({
      stage: "install",
      status: "completed",
      regressionCategory: "none",
      detail: `skill=${candidate.skillId}, role=${targetRole}, verifyTask=${verifyTaskId}`,
      completedStages: ["search", "install"],
      statePresent: true,
      stateStage: "verify",
      stateStatus: "active"
    });

    emitHarnessMeta({
      stage: "verify",
      status: "completed",
      regressionCategory: "none",
      detail: `verifyTask=${verifyTaskId}, status=${String(verifyTask.status ?? "")}`,
      completedStages: ["search", "install", "verify"],
      statePresent: true,
      stateStage: "verify",
      stateStatus: String(verifyTask.status ?? "active")
    });

    info("PASS");
  } finally {
    await taskRunner?.stop().catch(() => undefined);
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error), { regressionCategory: "exception" });
});

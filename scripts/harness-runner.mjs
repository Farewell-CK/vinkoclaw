#!/usr/bin/env node

import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HARNESS_ROOT = path.join(ROOT, ".run", "harness");
const ORCH_BASE = process.env.ORCH_BASE_URL ?? "http://127.0.0.1:8098";

const SUITES = {
  product: {
    label: "Product Self Check",
    command: ["npm", "run", "self-check:product"],
    budgetMs: 5 * 60_000
  },
  "founder-delivery": {
    label: "Founder Delivery Loop",
    command: ["npm", "run", "self-check:founder-delivery"],
    budgetMs: 8 * 60_000
  },
  "founder-ops": {
    label: "Founder Ops Follow-up",
    command: ["npm", "run", "self-check:founder-ops"],
    budgetMs: 5 * 60_000
  },
  "founder-ops-recurring": {
    label: "Founder Ops Recurring",
    command: ["npm", "run", "self-check:founder-ops-recurring"],
    budgetMs: 5 * 60_000
  },
  "founder-research": {
    label: "Founder Research Report",
    command: ["npm", "run", "self-check:founder-research"],
    budgetMs: 5 * 60_000
  },
  "founder-recap": {
    label: "Founder Weekly Recap",
    command: ["npm", "run", "self-check:founder-recap"],
    budgetMs: 5 * 60_000
  },
  "founder-implementation": {
    label: "Founder Implementation Task",
    command: ["npm", "run", "self-check:founder-implementation"],
    budgetMs: 5 * 60_000
  },
  "artifact-export": {
    label: "Artifact Export Self Check",
    command: ["npm", "run", "self-check:artifact-export"],
    budgetMs: 6 * 60_000
  },
  persona: {
    label: "Persona Test",
    command: ["npm", "run", "persona-test"],
    budgetMs: 5 * 60_000
  },
  collaboration: {
    label: "Collaboration Self Check",
    command: ["npm", "run", "self-check:collaboration"],
    budgetMs: 6 * 60_000
  },
  "skill-lifecycle": {
    label: "Skill Lifecycle Self Check",
    command: ["npm", "run", "self-check:skill-lifecycle"],
    budgetMs: 6 * 60_000
  }
};

function fail(message) {
  process.stderr.write(`[harness-runner] ${message}\n`);
  process.exit(1);
}

function log(message) {
  process.stdout.write(`[harness-runner] ${message}\n`);
}

async function fetchJson(pathname) {
  const response = await fetch(`${ORCH_BASE}${pathname}`);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${pathname}: ${text}`);
  }
  return JSON.parse(text);
}

function terminateChildTree(child, signal) {
  if (!child) {
    return;
  }
  if (process.platform !== "win32" && typeof child.pid === "number" && child.pid > 0) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to direct child kill below.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Ignore kill failures; close handler will surface the final state.
  }
}

function parseHarnessMetas(output) {
  const lines = String(output ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("HARNESS_META "));
  return lines
    .map((line) => {
      try {
        return JSON.parse(line.slice("HARNESS_META ".length));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function parseFounderRootTaskId(output) {
  const match = String(output ?? "").match(/\[founder-delivery-selfcheck\]\s+root task=([a-f0-9-]+)/i);
  return match?.[1] ? String(match[1]) : undefined;
}

function unwrapTaskResponse(payload) {
  if (payload && typeof payload === "object" && payload.task && typeof payload.task === "object") {
    return payload.task;
  }
  return payload;
}

function buildStageSummary(metas) {
  const summary = {};
  for (const meta of metas) {
    const stageKey =
      typeof meta?.stage === "string" && meta.stage
        ? meta.stage
        : typeof meta?.check === "string" && meta.check
          ? meta.check
          : undefined;
    if (!stageKey) {
      continue;
    }
    summary[stageKey] = {
      regressionCategory: typeof meta?.regressionCategory === "string" ? meta.regressionCategory : undefined,
      status: typeof meta?.status === "string" ? meta.status : undefined,
      deliverableMode: typeof meta?.deliverableMode === "string" ? meta.deliverableMode : undefined,
      artifactCount: typeof meta?.artifactCount === "number" ? meta.artifactCount : undefined,
      deliverableContractViolated: meta?.deliverableContractViolated === true,
      statePresent: meta?.statePresent === true,
      stateStage: typeof meta?.stateStage === "string" ? meta.stateStage : undefined,
      stateStatus: typeof meta?.stateStatus === "string" ? meta.stateStatus : undefined
    };
  }
  return Object.keys(summary).length > 0 ? summary : undefined;
}

function classifyFounderTimeout(stageSummary, failedStage) {
  if (!stageSummary || !failedStage) {
    return {
      regressionCategory: "timeout",
      detail: undefined
    };
  }
  const stage = stageSummary[failedStage];
  if (!stage) {
    return {
      regressionCategory: "timeout",
      detail: undefined
    };
  }
  if (stage.status === "queued") {
    return {
      regressionCategory: "queue_delay",
      detail: `${failedStage} stage remained queued without starting`
    };
  }
  if (stage.status === "running") {
    const startedAtMs = typeof stage.startedAt === "string" ? Date.parse(stage.startedAt) : NaN;
    const runningMs = Number.isFinite(startedAtMs) ? Math.max(0, Date.now() - startedAtMs) : undefined;
    return {
      regressionCategory: "running_timeout",
      detail: `${failedStage} stage started but did not finish before timeout${typeof runningMs === "number" ? ` (${runningMs}ms elapsed)` : ""}`
    };
  }
  if (stage.status === "completed" && stage.deliverableContractViolated === true) {
    return {
      regressionCategory: "contract_violation",
      detail: `${failedStage} stage completed but violated deliverable contract`
    };
  }
  if (stage.status === "completed" && Number(stage.artifactCount ?? 0) === 0) {
    return {
      regressionCategory: "no_artifact",
      detail: `${failedStage} stage completed without persisted artifacts`
    };
  }
  const orderedStages = ["prd", "implementation", "qa", "recap"];
  const stageIndex = orderedStages.indexOf(failedStage);
  if (stage.status === "completed" && stageIndex >= 0 && stageIndex < orderedStages.length - 1) {
    const nextStage = orderedStages[stageIndex + 1];
    if (!stageSummary[nextStage]) {
      return {
        regressionCategory: "child_not_spawned",
        detail: `${failedStage} stage completed but ${nextStage} child task was not created`
      };
    }
  }
  return {
    regressionCategory: "timeout",
    detail: undefined
  };
}

function normalizeGrade(input) {
  if (input.stateCompleteness === false) {
    return "fail";
  }
  if (input.ok === true && !input.timedOut && !input.exceededBudget) {
    return "pass";
  }
  if (input.ok === true && input.exceededBudget) {
    return "warn";
  }
  return "fail";
}

function buildFailedInvariant(input) {
  if (input.stateCompleteness === false) {
    return "orchestration_state_complete";
  }
  if (input.ok === true && !input.exceededBudget) {
    return undefined;
  }
  if (input.timedOut) {
    return "workflow_completed_within_timeout";
  }
  if (input.exceededBudget) {
    return "workflow_completed_within_budget";
  }
  switch (input.regressionCategory) {
    case "queue_delay":
      return "stage_started_before_queue_slo";
    case "running_timeout":
      return "stage_completed_before_running_timeout";
    case "contract_violation":
      return "deliverable_contract_satisfied";
    case "no_artifact":
      return "artifact_files_persisted";
    case "child_not_spawned":
      return "next_stage_child_created";
    default:
      return input.failedStage ? `${input.failedStage}_stage_passed` : "suite_passed";
  }
}

function countStageStatuses(stageSummary, predicate) {
  if (!stageSummary || typeof stageSummary !== "object") {
    return 0;
  }
  return Object.values(stageSummary).filter((value) => predicate(value)).length;
}

function getFounderStageBudgetMs(stage) {
  switch (stage) {
    case "prd":
      return 30_000;
    case "implementation":
      return 5 * 60_000;
    case "qa":
      return 2 * 60_000;
    case "recap":
      return 60_000;
    default:
      return undefined;
  }
}

function findFounderBudgetRegression(stageSummary) {
  if (!stageSummary || typeof stageSummary !== "object") {
    return undefined;
  }
  const entries = Object.entries(stageSummary)
    .map(([stage, value]) => {
      const budgetMs = getFounderStageBudgetMs(stage);
      const executionMs = typeof value?.executionMs === "number" ? value.executionMs : undefined;
      const overBudgetMs =
        typeof budgetMs === "number" && typeof executionMs === "number" ? Math.max(0, executionMs - budgetMs) : 0;
      return {
        stage,
        budgetMs,
        executionMs,
        overBudgetMs
      };
    })
    .filter((entry) => typeof entry.budgetMs === "number" && typeof entry.executionMs === "number" && entry.overBudgetMs > 0)
    .sort((left, right) => right.overBudgetMs - left.overBudgetMs);
  return entries[0];
}

async function fetchFounderStageSummary(rootTaskId) {
  if (!rootTaskId) {
    return undefined;
  }
  const visited = new Set();
  const summary = {};

  async function walk(taskId) {
    if (!taskId || visited.has(taskId)) {
      return;
    }
    visited.add(taskId);
    const task = unwrapTaskResponse(await fetchJson(`/api/tasks/${taskId}`));
    const stage = typeof task?.metadata?.founderWorkflowStage === "string" ? task.metadata.founderWorkflowStage : undefined;
    if (stage) {
      const evidence = task?.completionEvidence ?? {};
      const orchestration = evidence?.orchestration ?? {};
      summary[stage] = {
        taskId,
        status: typeof task?.status === "string" ? task.status : undefined,
        deliverableMode: typeof evidence?.deliverableMode === "string" ? evidence.deliverableMode : undefined,
        artifactCount: Array.isArray(evidence?.artifactFiles) ? evidence.artifactFiles.length : 0,
        deliverableContractViolated: evidence?.deliverableContractViolated === true,
        executionMs: typeof evidence?.executionMs === "number" ? evidence.executionMs : undefined,
        startedAt: typeof task?.startedAt === "string" ? task.startedAt : undefined,
        completedAt: typeof task?.completedAt === "string" ? task.completedAt : undefined,
        statePresent: Boolean(orchestration && typeof orchestration === "object" && Object.keys(orchestration).length > 0),
        stateStage: typeof orchestration?.progress?.stage === "string" ? orchestration.progress.stage : undefined,
        stateStatus: typeof orchestration?.progress?.status === "string" ? orchestration.progress.status : undefined
      };
    }
    const childPayload = await fetchJson(`/api/tasks/${taskId}/children`).catch(() => null);
    const children = Array.isArray(childPayload?.children) ? childPayload.children : [];
    for (const child of children) {
      if (typeof child?.id === "string") {
        await walk(child.id);
      }
    }
  }

  await walk(rootTaskId);
  return Object.keys(summary).length > 0 ? summary : undefined;
}

async function runSuite(suite) {
  const config = SUITES[suite];
  if (!config) {
    fail(`unknown suite: ${suite}`);
  }
  const startedAt = new Date().toISOString();
  const startedAtMs = Date.now();
  const child = spawn(config.command[0], config.command.slice(1), {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
    detached: process.platform !== "win32"
  });
  let stdout = "";
  let stderr = "";
  let hardTimedOut = false;
  let childClosed = false;
  const budgetMsRaw = Number(process.env.HARNESS_SUITE_BUDGET_MS ?? config.budgetMs ?? 300_000);
  const budgetMs = Number.isFinite(budgetMsRaw) ? Math.max(30_000, Math.round(budgetMsRaw)) : 300_000;
  const killOnTimeout = process.env.HARNESS_KILL_ON_TIMEOUT === "1";
  const hardTimeoutMsRaw = Number(process.env.HARNESS_HARD_TIMEOUT_MS ?? "");
  const hardTimeoutMs =
    Number.isFinite(hardTimeoutMsRaw) && hardTimeoutMsRaw > 0 ? Math.max(30_000, Math.round(hardTimeoutMsRaw)) : undefined;
  let hardTimeout;
  if (killOnTimeout && typeof hardTimeoutMs === "number") {
    hardTimeout = setTimeout(() => {
      hardTimedOut = true;
      stderr += `\n[harness-runner] suite hard-timed out after ${hardTimeoutMs}ms\n`;
      terminateChildTree(child, "SIGTERM");
      setTimeout(() => {
        if (!childClosed) {
          terminateChildTree(child, "SIGKILL");
        }
      }, 10_000).unref();
    }, hardTimeoutMs);
  }

  child.stdout.on("data", (chunk) => {
    const text = String(chunk);
    stdout += text;
    process.stdout.write(text);
  });
  child.stderr.on("data", (chunk) => {
    const text = String(chunk);
    stderr += text;
    process.stderr.write(text);
  });

  const exitCode = await new Promise((resolve) => {
    child.on("close", (code) => {
      childClosed = true;
      resolve(code ?? -1);
    });
  });
  if (hardTimeout) {
    clearTimeout(hardTimeout);
  }
  const durationMs = Date.now() - startedAtMs;
  const finishedAt = new Date().toISOString();
  const overBudgetMs = Math.max(0, durationMs - budgetMs);
  const exceededBudget = overBudgetMs > 0;

  let health = null;
  let projectBoard = null;
  let observeError = undefined;
  let postmortemStageSummary = undefined;
  try {
    health = await fetchJson("/health");
    projectBoard = await fetchJson("/api/project-board");
    if (suite === "founder-delivery") {
      const founderRootTaskId = parseFounderRootTaskId(stdout);
      postmortemStageSummary = await fetchFounderStageSummary(founderRootTaskId);
    }
  } catch (error) {
    observeError = error instanceof Error ? error.message : String(error);
  }

  const suiteDir = path.join(HARNESS_ROOT, suite);
  mkdirSync(suiteDir, { recursive: true });
  const latestFile = path.join(suiteDir, "latest.json");
  const historyFile = path.join(suiteDir, "history.jsonl");
  const harnessMetas = parseHarnessMetas(`${stdout}\n${stderr}`);
  const harnessMeta = harnessMetas.length > 0 ? harnessMetas[harnessMetas.length - 1] : null;
  const stageSummary = postmortemStageSummary ?? buildStageSummary(harnessMetas);
  const failedStage =
    typeof harnessMeta?.stage === "string"
      ? harnessMeta.stage
      : typeof harnessMeta?.check === "string"
        ? harnessMeta.check
        : undefined;
  const founderBudgetRegression = suite === "founder-delivery" && exceededBudget ? findFounderBudgetRegression(stageSummary) : undefined;
  const founderTimeoutClassification =
    suite === "founder-delivery" && hardTimedOut === true
      ? classifyFounderTimeout(stageSummary, failedStage)
      : undefined;
  const normalizedRegressionCategory =
    founderBudgetRegression
      ? "over_budget"
      :
    founderTimeoutClassification?.regressionCategory ??
    (hardTimedOut === true
      ? harnessMeta?.regressionCategory && harnessMeta.regressionCategory !== "in_progress"
        ? harnessMeta.regressionCategory
        : "hard_timeout"
      : exceededBudget === true
        ? "over_budget"
      : harnessMeta?.regressionCategory ?? "unknown");

  const effectiveFailedStage = founderBudgetRegression?.stage ?? failedStage;
  const failedStageBudgetMs =
    founderBudgetRegression?.budgetMs ?? (suite === "founder-delivery" ? getFounderStageBudgetMs(effectiveFailedStage) : undefined);
  const failedStageExecutionMs =
    founderBudgetRegression?.executionMs ??
    (suite === "founder-delivery" && effectiveFailedStage && stageSummary?.[effectiveFailedStage]
      ? Number(stageSummary[effectiveFailedStage].executionMs ?? 0) ||
        (typeof stageSummary[effectiveFailedStage].startedAt === "string"
          ? Math.max(0, Date.now() - Date.parse(stageSummary[effectiveFailedStage].startedAt))
          : undefined)
      : undefined);
  const failedStageOverBudgetMs =
    founderBudgetRegression?.overBudgetMs ??
    (typeof failedStageBudgetMs === "number" && typeof failedStageExecutionMs === "number"
      ? Math.max(0, failedStageExecutionMs - failedStageBudgetMs)
      : undefined);

  const stateCompleteness =
    stageSummary && typeof stageSummary === "object"
      ? Object.values(stageSummary).every((value) => value?.statePresent === true)
      : undefined;

  const record = {
    suite,
    label: config.label,
    ok: exitCode === 0 && !hardTimedOut,
    exitCode,
    timedOut: hardTimedOut,
    timeoutMs: hardTimeoutMs,
    budgetMs,
    exceededBudget,
    overBudgetMs,
    startedAt,
    finishedAt,
    durationMs,
    command: config.command.join(" "),
    orchBase: ORCH_BASE,
    healthOk: health?.ok === true,
    projectBoardSummary: projectBoard?.summary ?? null,
    regressionCategory: normalizedRegressionCategory,
    failedStage: effectiveFailedStage,
    failedStageBudgetMs,
    failedStageExecutionMs,
    failedStageOverBudgetMs,
    detail:
      founderBudgetRegression
        ? `${founderBudgetRegression.stage} stage exceeded budget by ${founderBudgetRegression.overBudgetMs}ms`
        :
      founderTimeoutClassification?.detail ??
      (typeof harnessMeta?.detail === "string" ? harnessMeta.detail : undefined),
    completedStages: Array.isArray(harnessMeta?.completedStages) ? harnessMeta.completedStages : undefined,
    stageSummary,
    stateCompleteness,
    observeError,
    stdoutTail: stdout.slice(-8000),
    stderrTail: stderr.slice(-8000)
  };

  const totalStages = stageSummary && typeof stageSummary === "object" ? Object.keys(stageSummary).length : 0;
  const completedStagesCount = countStageStatuses(stageSummary, (value) => value?.status === "completed");
  const approvalStagesCount = countStageStatuses(
    stageSummary,
    (value) => value?.regressionCategory === "authorization_required" || value?.status === "awaiting_authorization"
  );
  const resumableStagesCount = countStageStatuses(
    stageSummary,
    (value) => value?.status === "queued" || value?.status === "running" || value?.status === "awaiting_authorization"
  );
  record.grade = normalizeGrade(record);
  record.failedInvariant = buildFailedInvariant(record);
  record.traceSummary = totalStages > 0 ? `${completedStagesCount}/${totalStages} stages completed` : undefined;
  record.handoffCoverage = totalStages > 0 ? Number((completedStagesCount / totalStages).toFixed(2)) : undefined;
  record.approvalCoverage = totalStages > 0 ? Number((approvalStagesCount / totalStages).toFixed(2)) : undefined;
  record.resumeCoverage = totalStages > 0 ? Number((resumableStagesCount / totalStages).toFixed(2)) : undefined;

  appendFileSync(historyFile, `${JSON.stringify(record)}\n`, "utf8");
  writeFileSync(latestFile, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  log(`${suite} ${record.ok ? "PASS" : "FAIL"} duration=${durationMs}ms`);
  return record.ok;
}

async function main() {
  const suites = process.argv.slice(2);
  const targetSuites = suites.length > 0 ? suites : ["product", "founder-delivery"];
  for (const suite of targetSuites) {
    if (suite === "all") {
      for (const name of Object.keys(SUITES)) {
        const ok = await runSuite(name);
        if (!ok) {
          process.exitCode = 1;
          return;
        }
      }
      continue;
    }
    const ok = await runSuite(suite);
    if (!ok) {
      process.exitCode = 1;
      return;
    }
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});

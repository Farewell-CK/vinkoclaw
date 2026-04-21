#!/usr/bin/env node

import { runResetRuntimeDrain, startHarnessTaskRunner } from "./harness-preflight.mjs";

const ORCH_BASE = process.env.ORCH_BASE_URL ?? "http://127.0.0.1:8098";
const RUN_ID = `founder-delivery-selfcheck-${Date.now()}`;
const FOUNDER_TIMEOUT_MS = Number(process.env.FOUNDER_LOOP_TIMEOUT_MS ?? 15 * 60 * 1000);
const FOUNDER_REQUESTED_BY_PREFIX = "ou_founder-delivery-selfcheck-";
const FOUNDER_PREFLIGHT_TIMEOUT_MS = Number(process.env.FOUNDER_PREFLIGHT_TIMEOUT_MS ?? 120_000);
let currentStage = "boot";

const REQUIRED_ORCHESTRATION_SECTIONS = ["spec", "progress", "decision", "artifactIndex"];

function emitHarnessMeta(patch) {
  console.error(`HARNESS_META ${JSON.stringify({ suite: "founder-delivery", stage: currentStage, ...patch })}`);
}

function setStage(stage) {
  currentStage = stage;
  emitHarnessMeta({
    ok: null,
    regressionCategory: "in_progress"
  });
}

function stageArtifactCount(task) {
  const evidence = task?.completionEvidence;
  const files = Array.isArray(evidence?.artifactFiles) ? evidence.artifactFiles : [];
  return files.length;
}

function unwrapTaskResponse(payload) {
  if (payload && typeof payload === "object" && payload.task && typeof payload.task === "object") {
    return payload.task;
  }
  return payload;
}

function getOrchestration(task) {
  return task?.completionEvidence?.orchestration ?? null;
}

function assertOrchestrationCompleteness(task, stage) {
  const orchestration = getOrchestration(task);
  assert(orchestration, `${stage} stage missing orchestration state`);
  for (const key of REQUIRED_ORCHESTRATION_SECTIONS) {
    assert(orchestration[key], `${stage} stage orchestration missing ${key}`);
  }
  assert(Array.isArray(orchestration.spec?.successCriteria), `${stage} stage missing success criteria`);
  assert(Array.isArray(orchestration.progress?.nextActions), `${stage} stage missing nextActions`);
  assert(Array.isArray(orchestration.decision?.entries), `${stage} stage missing decision entries`);
  assert(Array.isArray(orchestration.artifactIndex?.items), `${stage} stage missing artifactIndex items`);
}

function isCompletedFounderStageSettled(task, expectedStage) {
  const orchestration = getOrchestration(task);
  if (!orchestration) {
    return false;
  }
  if (
    !Array.isArray(orchestration.spec?.successCriteria) ||
    !Array.isArray(orchestration.progress?.nextActions) ||
    !Array.isArray(orchestration.decision?.entries) ||
    !Array.isArray(orchestration.artifactIndex?.items)
  ) {
    return false;
  }
  if (expectedStage === "prd") {
    return orchestration.progress?.stage === "implementation";
  }
  if (expectedStage === "implementation") {
    return orchestration.progress?.stage === "verify";
  }
  if (expectedStage === "qa") {
    return orchestration.verificationStatus === "verified";
  }
  if (expectedStage === "recap") {
    return orchestration.progress?.status === "completed";
  }
  return true;
}

function emitStageCompletion(task, stage) {
  const orchestration = getOrchestration(task);
  emitHarnessMeta({
    ok: null,
    regressionCategory: "stage_completed",
    stage,
    status: String(task?.status ?? ""),
    deliverableMode:
      typeof task?.completionEvidence?.deliverableMode === "string"
        ? task.completionEvidence.deliverableMode
        : typeof task?.metadata?.deliverableMode === "string"
          ? task.metadata.deliverableMode
          : undefined,
    artifactCount: stageArtifactCount(task),
    deliverableContractViolated: task?.completionEvidence?.deliverableContractViolated === true,
    statePresent: Boolean(orchestration),
    stateStage: typeof orchestration?.progress?.stage === "string" ? orchestration.progress.stage : "",
    stateStatus: typeof orchestration?.progress?.status === "string" ? orchestration.progress.status : ""
  });
}

function info(message) {
  console.log(`[founder-delivery-selfcheck] ${message}`);
}

function fail(message) {
  emitHarnessMeta({
    ok: false,
    regressionCategory:
      currentStage === "boot" ? "backend" : currentStage === "project-board" ? "memory" : "delivery",
    detail: message
  });
  console.error(`[founder-delivery-selfcheck] FAIL: ${message}`);
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function getJson(path) {
  const response = await fetch(`${ORCH_BASE}${path}`);
  const text = await response.text();
  if (!response.ok) {
    fail(`HTTP ${response.status} GET ${path}: ${text}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    fail(`invalid JSON for GET ${path}: ${text}`);
  }
}

async function postJson(path, payload) {
  const response = await fetch(`${ORCH_BASE}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  const text = await response.text();
  if (!response.ok) {
    fail(`HTTP ${response.status} POST ${path}: ${text}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    fail(`invalid JSON for POST ${path}: ${text}`);
  }
}

function buildIdentity() {
  return {
    requestedBy: `ou_${RUN_ID}`,
    chatId: `oc_${RUN_ID}`
  };
}

function isPreviousFounderSelfcheckTask(task, currentRequestedBy) {
  const requestedBy = typeof task?.requestedBy === "string" ? task.requestedBy : "";
  return (
    requestedBy.startsWith(FOUNDER_REQUESTED_BY_PREFIX) &&
    requestedBy !== currentRequestedBy &&
    ["queued", "running", "waiting_approval", "paused_input"].includes(String(task?.status ?? ""))
  );
}

async function cleanupPreviousFounderRuns(currentRequestedBy) {
  setStage("cleanup");
  const tasks = await getJson("/api/tasks");
  const candidates = Array.isArray(tasks) ? tasks.filter((task) => isPreviousFounderSelfcheckTask(task, currentRequestedBy)) : [];
  for (const task of candidates) {
    await postJson(`/api/tasks/${task.id}/cancel`, {
      reason: `${RUN_ID} preflight-cleanup`
    }).catch(() => null);
  }
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const snapshot = await getJson("/api/tasks");
    const remaining = Array.isArray(snapshot)
      ? snapshot.filter((task) => isPreviousFounderSelfcheckTask(task, currentRequestedBy))
      : [];
    if (remaining.length === 0) {
      emitHarnessMeta({
        ok: null,
        regressionCategory: "cleanup_complete",
        cleanedCount: candidates.length
      });
      return;
    }
    await sleep(1000);
  }
  fail("previous founder self-check tasks are still active after preflight cleanup");
}

async function runQueuePreflightDrain() {
  setStage("preflight-drain");
  emitHarnessMeta({
    ok: null,
    regressionCategory: "preflight_start",
    timeoutMs: FOUNDER_PREFLIGHT_TIMEOUT_MS
  });
  const exitCode = await runResetRuntimeDrain({
    orchBase: ORCH_BASE,
    timeoutMs: FOUNDER_PREFLIGHT_TIMEOUT_MS,
    maxBusyTasks: 0,
    reason: RUN_ID
  });
  assert(exitCode === 0, `preflight drain failed with exitCode=${exitCode}`);
  emitHarnessMeta({
    ok: null,
    regressionCategory: "preflight_complete"
  });
}

async function waitTask(taskId, expectedStage, timeoutMs = FOUNDER_TIMEOUT_MS) {
  setStage(expectedStage);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = unwrapTaskResponse(await getJson(`/api/tasks/${taskId}`));
    const metadata = task?.metadata || {};
    if (
      metadata.founderWorkflowKind === "founder_delivery" &&
      metadata.founderWorkflowStage === expectedStage &&
      ["completed", "failed", "cancelled"].includes(task.status)
    ) {
      if (task.status === "completed" && !isCompletedFounderStageSettled(task, expectedStage)) {
        await sleep(1000);
        continue;
      }
      return task;
    }
    if (
      metadata.founderWorkflowKind === "founder_delivery" &&
      metadata.founderWorkflowStage === expectedStage &&
      task.status === "paused_input"
    ) {
      const question = typeof task?.pendingInput?.question === "string" ? task.pendingInput.question : "";
      fail(
        `founder workflow stage ${expectedStage} paused for input${question ? `: ${question}` : ""}`
      );
    }
    await sleep(1500);
  }
  fail(`founder workflow stage ${expectedStage} task ${taskId} not terminal in ${timeoutMs}ms`);
}

async function waitSingleChild(parentTaskId, expectedStage, timeoutMs = FOUNDER_TIMEOUT_MS) {
  setStage(`${expectedStage}-spawn`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const payload = await getJson(`/api/tasks/${parentTaskId}/children`);
    const children = Array.isArray(payload?.children) ? payload.children : [];
    const matched = children.find((child) => child?.metadata?.founderWorkflowStage === expectedStage);
    if (matched) {
      return matched;
    }
    await sleep(1500);
  }
  fail(`expected founder workflow child stage ${expectedStage} under ${parentTaskId}`);
}

async function main() {
  info(`orchestrator=${ORCH_BASE}`);
  setStage("health");
  const health = await getJson("/health");
  assert(health?.ok === true, "health endpoint not ok");

  const identity = buildIdentity();
  let taskRunner;
  try {
    await runQueuePreflightDrain();
    await cleanupPreviousFounderRuns(identity.requestedBy);
    taskRunner = await startHarnessTaskRunner({
      label: "founder-delivery"
    });
    setStage("dispatch");
    const initial = await postJson("/api/messages", {
      source: "feishu",
      requestedBy: identity.requestedBy,
      chatId: identity.chatId,
      text: "请按从想法到交付的方式，做一个登录页 MVP"
    });
    assert(initial.type === "template_tasks_queued", `expected template_tasks_queued, got ${JSON.stringify(initial)}`);
    assert(initial.templateId === "tpl-founder-delivery-loop", `unexpected template ${JSON.stringify(initial)}`);
    const rootTaskId = String(initial.taskIds?.[0] ?? "");
    assert(rootTaskId.length > 0, "missing founder workflow root task");

    info(`root task=${rootTaskId}`);
    const prdTask = await waitTask(rootTaskId, "prd");
    assert(prdTask.status === "completed", `prd stage failed: ${JSON.stringify(prdTask)}`);
    assert(prdTask.metadata?.deliverableMode === "artifact_required", "prd stage should require artifact");
    assertOrchestrationCompleteness(prdTask, "prd");
    emitStageCompletion(prdTask, "prd");

    const implementationTask = await waitSingleChild(rootTaskId, "implementation");
    const implementationTerminal = await waitTask(implementationTask.id, "implementation");
    assert(
      implementationTerminal.status === "completed",
      `implementation stage failed: ${JSON.stringify(implementationTerminal)}`
    );
    assertOrchestrationCompleteness(implementationTerminal, "implementation");
    emitStageCompletion(implementationTerminal, "implementation");

    const qaTask = await waitSingleChild(implementationTask.id, "qa");
    const qaTerminal = await waitTask(qaTask.id, "qa");
    assert(qaTerminal.status === "completed", `qa stage failed: ${JSON.stringify(qaTerminal)}`);
    assertOrchestrationCompleteness(qaTerminal, "qa");
    assert(
      getOrchestration(qaTerminal)?.verificationStatus === "verified",
      `qa stage should mark verificationStatus=verified: ${JSON.stringify(getOrchestration(qaTerminal))}`
    );
    emitStageCompletion(qaTerminal, "qa");

    const recapTask = await waitSingleChild(qaTask.id, "recap");
    const recapTerminal = await waitTask(recapTask.id, "recap");
    assert(recapTerminal.status === "completed", `recap stage failed: ${JSON.stringify(recapTerminal)}`);
    assertOrchestrationCompleteness(recapTerminal, "recap");
    const recapOrchestration = getOrchestration(recapTerminal);
    assert(
      recapOrchestration?.progress?.status === "completed",
      `recap stage should complete founder loop progress: ${JSON.stringify(recapOrchestration?.progress)}`
    );
    assert(
      Array.isArray(recapOrchestration?.progress?.completed) && recapOrchestration.progress.completed.length >= 4,
      `recap stage should record completed founder stages: ${JSON.stringify(recapOrchestration?.progress)}`
    );
    emitStageCompletion(recapTerminal, "recap");

    setStage("project-board");
    const board = await getJson("/api/project-board");
    assert(board?.summary?.activeProjects >= 1, `project board missing active project: ${JSON.stringify(board)}`);
    emitHarnessMeta({
      ok: true,
      regressionCategory: "none",
      stage: "completed",
      completedStages: ["prd", "implementation", "qa", "recap", "project-board"]
    });
    info("PASS");
  } finally {
    await taskRunner?.stop().catch(() => undefined);
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});

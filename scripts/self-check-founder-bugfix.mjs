#!/usr/bin/env node

import { runResetRuntimeDrain, startHarnessTaskRunner } from "./harness-preflight.mjs";

const ORCH_BASE = process.env.ORCH_BASE_URL ?? "http://127.0.0.1:8098";
const PREFLIGHT_TIMEOUT_MS = Number(process.env.FOUNDER_BUGFIX_PREFLIGHT_TIMEOUT_MS ?? 120_000);

function emitHarnessMeta(patch) {
  process.stderr.write(`HARNESS_META ${JSON.stringify({ suite: "founder-bugfix", ...patch })}\n`);
}

function fail(message, patch = {}) {
  emitHarnessMeta({ regressionCategory: patch.regressionCategory ?? "failed", status: "failed", detail: message, ...patch });
  process.stderr.write(`[self-check:founder-bugfix] FAIL: ${message}\n`);
  process.exit(1);
}

function info(message) {
  process.stdout.write(`[self-check:founder-bugfix] ${message}\n`);
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
    reason: `founder-bugfix-selfcheck-${Date.now()}`
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

function unwrapTask(payload) {
  if (payload && typeof payload === "object" && payload.task && typeof payload.task === "object") {
    return payload.task;
  }
  return payload;
}

async function main() {
  info(`orchestrator=${ORCH_BASE}`);
  await runQueuePreflightDrain();
  let taskRunner;
  try {
    taskRunner = await startHarnessTaskRunner({
      label: "founder-bugfix"
    });
    emitHarnessMeta({ stage: "dispatch", status: "in_progress", regressionCategory: "in_progress" });

    const created = await fetchJson("/api/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        source: "control-center",
        requestedBy: `selfcheck-founder-bugfix-${Date.now()}`,
        text: [
          "请帮我排查并修复登录页的一个 bug。",
          "现象：手机号输入为空时点击提交会直接白屏。",
          "请输出修复方案、代码变更、验证结果和剩余风险。"
        ].join("\n")
      })
    });

    if (created?.type !== "template_tasks_queued") {
      fail(`expected template_tasks_queued, got ${JSON.stringify(created)}`, {
        stage: "dispatch",
        regressionCategory: "routing"
      });
    }
    if (created?.templateId !== "tpl-founder-bugfix-followup") {
      fail(`expected templateId tpl-founder-bugfix-followup, got ${String(created?.templateId ?? "")}`, {
        stage: "dispatch",
        regressionCategory: "template_mismatch"
      });
    }
    if (!Array.isArray(created?.taskIds) || created.taskIds.length !== 1) {
      fail(`expected exactly one bugfix task, got ${JSON.stringify(created?.taskIds ?? null)}`, {
        stage: "dispatch",
        regressionCategory: "task_count_mismatch"
      });
    }

    const taskId = String(created.taskIds[0]);
    const taskPayload = await fetchJson(`/api/tasks/${taskId}`);
    const task = unwrapTask(taskPayload);

    if (!task || task.id !== taskId) {
      fail(`bugfix task ${taskId} could not be loaded`, {
        stage: "inspect",
        regressionCategory: "task_unreachable"
      });
    }
    if (task.roleId !== "engineering") {
      fail(`expected engineering role, got ${String(task.roleId ?? "")}`, {
        stage: "inspect",
        regressionCategory: "route_mismatch"
      });
    }

    const allowedStatuses = new Set(["queued", "running", "completed"]);
    if (!allowedStatuses.has(String(task.status ?? ""))) {
      fail(`unexpected task status ${String(task.status ?? "")}`, {
        stage: "inspect",
        regressionCategory: "task_terminal_failed"
      });
    }

    const deliverableMode =
      typeof task?.completionEvidence?.deliverableMode === "string"
        ? task.completionEvidence.deliverableMode
        : typeof task?.metadata?.deliverableMode === "string"
          ? task.metadata.deliverableMode
          : "";
    if (deliverableMode !== "artifact_required") {
      fail(`expected artifact_required deliverableMode, got ${deliverableMode || "empty"}`, {
        stage: "inspect",
        regressionCategory: "deliverable_contract"
      });
    }

    emitHarnessMeta({
      stage: "dispatch",
      status: "completed",
      regressionCategory: "none",
      completedStages: ["dispatch", "inspect"],
      detail: `template=${created.templateId}, task=${taskId}, status=${String(task.status ?? "")}`,
      statePresent: true,
      stateStage: "bugfix_followup",
      stateStatus: String(task.status ?? "")
    });

    info("PASS");
  } finally {
    await taskRunner?.stop().catch(() => undefined);
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error), { regressionCategory: "exception" });
});

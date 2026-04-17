#!/usr/bin/env node

import { runResetRuntimeDrain, startHarnessTaskRunner } from "./harness-preflight.mjs";

const ORCH_BASE = process.env.ORCH_BASE_URL ?? "http://127.0.0.1:8098";
const PREFLIGHT_TIMEOUT_MS = Number(process.env.FOUNDER_IMPLEMENTATION_PREFLIGHT_TIMEOUT_MS ?? 120_000);

function emitHarnessMeta(patch) {
  process.stderr.write(`HARNESS_META ${JSON.stringify({ suite: "founder-implementation", ...patch })}\n`);
}

function fail(message, patch = {}) {
  emitHarnessMeta({ regressionCategory: patch.regressionCategory ?? "failed", status: "failed", detail: message, ...patch });
  process.stderr.write(`[self-check:founder-implementation] FAIL: ${message}\n`);
  process.exit(1);
}

function info(message) {
  process.stdout.write(`[self-check:founder-implementation] ${message}\n`);
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
    reason: `founder-implementation-selfcheck-${Date.now()}`
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
      label: "founder-implementation"
    });
    emitHarnessMeta({ stage: "dispatch", status: "in_progress", regressionCategory: "in_progress" });

    const created = await fetchJson("/api/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        source: "control-center",
        requestedBy: `selfcheck-founder-implementation-${Date.now()}`,
        text: [
          "请实现一个最小登录页，并补对应验证任务。",
          "技术栈：React + TypeScript。",
          "需要邮箱密码登录、忘记密码入口和基础表单校验。"
        ].join("\n")
      })
    });

    const tasks = [];
    let acceptedMode = "";
    let detail = "";

    if (created?.type === "template_tasks_queued") {
      if (created?.templateId !== "tpl-founder-implementation-task") {
        fail(`expected templateId tpl-founder-implementation-task, got ${String(created?.templateId ?? "")}`, {
          stage: "dispatch",
          regressionCategory: "template_mismatch"
        });
      }
      if (!Array.isArray(created?.taskIds) || created.taskIds.length !== 2) {
        fail(`expected exactly two implementation tasks, got ${JSON.stringify(created?.taskIds ?? null)}`, {
          stage: "dispatch",
          regressionCategory: "task_count_mismatch"
        });
      }

      for (const taskId of created.taskIds) {
        const taskPayload = await fetchJson(`/api/tasks/${taskId}`);
        const task = unwrapTask(taskPayload);
        if (!task || task.id !== taskId) {
          fail(`implementation task ${taskId} could not be loaded`, {
            stage: "inspect",
            regressionCategory: "task_unreachable"
          });
        }
        tasks.push(task);
      }

      const roles = tasks.map((task) => String(task.roleId ?? ""));
      if (!roles.includes("frontend") || !roles.includes("qa")) {
        fail(`expected roles frontend and qa, got ${roles.join(",")}`, {
          stage: "inspect",
          regressionCategory: "route_mismatch"
        });
      }
      acceptedMode = "template_tasks_queued";
      detail = `template=${created.templateId}, roles=${roles.join(",")}, statuses=${tasks.map((task) => task.status).join(",")}`;
    } else if (created?.type === "task_queued" && typeof created?.taskId === "string") {
      const taskPayload = await fetchJson(`/api/tasks/${created.taskId}`);
      const task = unwrapTask(taskPayload);
      if (!task || task.id !== created.taskId) {
        fail(`implementation task ${created.taskId} could not be loaded`, {
          stage: "inspect",
          regressionCategory: "task_unreachable"
        });
      }
      tasks.push(task);
      if (String(task.roleId ?? "") !== "frontend") {
        fail(`expected frontend role for direct implementation task, got ${String(task.roleId ?? "")}`, {
          stage: "inspect",
          regressionCategory: "route_mismatch"
        });
      }
      if (task?.metadata?.lightCollaboration !== true) {
        fail("direct implementation task did not enable light collaboration review mode", {
          stage: "inspect",
          regressionCategory: "collaboration_missing"
        });
      }
      acceptedMode = "task_queued";
      detail = `task=${created.taskId}, role=frontend, status=${String(task.status ?? "")}, lightCollaboration=true`;
    } else {
      fail(`expected template_tasks_queued|task_queued, got ${JSON.stringify(created)}`, {
        stage: "dispatch",
        regressionCategory: "routing"
      });
    }

    const allowedStatuses = new Set(["queued", "running", "completed"]);
    const invalidStatus = tasks.find((task) => !allowedStatuses.has(String(task.status ?? "")));
    if (invalidStatus) {
      fail(`unexpected task status ${String(invalidStatus.status ?? "")}`, {
        stage: "inspect",
        regressionCategory: "task_terminal_failed"
      });
    }

    const invalidDeliverable = tasks.find((task) => {
      const deliverableMode =
        typeof task?.completionEvidence?.deliverableMode === "string"
          ? task.completionEvidence.deliverableMode
          : typeof task?.metadata?.deliverableMode === "string"
            ? task.metadata.deliverableMode
            : "";
      if (acceptedMode === "task_queued") {
        return !["", "artifact_required"].includes(deliverableMode);
      }
      return deliverableMode !== "artifact_required";
    });
    if (invalidDeliverable) {
      fail(`unexpected deliverableMode on implementation path`, {
        stage: "inspect",
        regressionCategory: "deliverable_contract"
      });
    }

    emitHarnessMeta({
      stage: "dispatch",
      status: "completed",
      regressionCategory: "none",
      completedStages: ["dispatch", "inspect"],
      detail,
      statePresent: true,
      stateStage: acceptedMode === "task_queued" ? "light_collaboration_queued" : "implementation_task",
      stateStatus: "queued"
    });

    info("PASS");
  } finally {
    await taskRunner?.stop().catch(() => undefined);
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error), { regressionCategory: "exception" });
});

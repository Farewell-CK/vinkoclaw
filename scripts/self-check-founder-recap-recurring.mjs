#!/usr/bin/env node

import { runResetRuntimeDrain, startHarnessTaskRunner } from "./harness-preflight.mjs";

const ORCH_BASE = process.env.ORCH_BASE_URL ?? "http://127.0.0.1:8098";
const PREFLIGHT_TIMEOUT_MS = Number(process.env.FOUNDER_RECAP_RECURRING_PREFLIGHT_TIMEOUT_MS ?? 120_000);

function emitHarnessMeta(patch) {
  process.stderr.write(`HARNESS_META ${JSON.stringify({ suite: "founder-recap-recurring", ...patch })}\n`);
}

function fail(message, patch = {}) {
  emitHarnessMeta({ regressionCategory: patch.regressionCategory ?? "failed", status: "failed", detail: message, ...patch });
  process.stderr.write(`[self-check:founder-recap-recurring] FAIL: ${message}\n`);
  process.exit(1);
}

function info(message) {
  process.stdout.write(`[self-check:founder-recap-recurring] ${message}\n`);
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
    reason: `founder-recap-recurring-selfcheck-${Date.now()}`
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
      label: "founder-recap-recurring"
    });
    emitHarnessMeta({ stage: "dispatch", status: "in_progress", regressionCategory: "in_progress" });

    const requestedBy = `selfcheck-founder-recap-recurring-${Date.now()}`;
    const postMessage = async (text) =>
      await fetchJson("/api/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          source: "control-center",
          requestedBy,
          text
        })
      });

    let created = await postMessage(
      [
        "请帮我整理一份每周固定复盘清单。",
        "每周五下午固定做周期复盘，汇总本周已完成事项、关键指标、阻塞问题和下周重点。",
        "输出时要明确周期、输入项、输出结构、责任归属、完成信号和下一步。"
      ].join("\n")
    );

    if (created?.type === "needs_clarification") {
      if (!Array.isArray(created.questions) || created.questions.length === 0) {
        fail(`needs_clarification missing questions: ${JSON.stringify(created)}`, {
          stage: "dispatch",
          regressionCategory: "clarification_missing_questions"
        });
      }
      created = await postMessage(
        [
          "请继续按周期复盘清单处理。",
          "请由 operations 负责。",
          "业务场景：AI 个人创业团队产品的每周创始人复盘。",
          "输出格式：Markdown 清单。"
        ].join("\n")
      );
    }

    let taskId = "";
    let acceptedMode = "";
    if (created?.type === "template_tasks_queued") {
      if (created?.templateId !== "tpl-founder-recap-recurring") {
        fail(`expected templateId tpl-founder-recap-recurring, got ${String(created?.templateId ?? "")}`, {
          stage: "dispatch",
          regressionCategory: "template_mismatch"
        });
      }
      if (!Array.isArray(created?.taskIds) || created.taskIds.length !== 1) {
        fail(`expected exactly one recurring recap task, got ${JSON.stringify(created?.taskIds ?? null)}`, {
          stage: "dispatch",
          regressionCategory: "task_count_mismatch"
        });
      }
      taskId = String(created.taskIds[0]);
      acceptedMode = "template_tasks_queued";
    } else if (created?.type === "task_queued" && typeof created?.taskId === "string") {
      taskId = created.taskId;
      acceptedMode = "task_queued";
    } else {
      fail(`expected template_tasks_queued|task_queued, got ${JSON.stringify(created)}`, {
        stage: "dispatch",
        regressionCategory: "routing"
      });
    }

    const taskPayload = await fetchJson(`/api/tasks/${taskId}`);
    const task = unwrapTask(taskPayload);

    if (!task || task.id !== taskId) {
      fail(`recurring recap task ${taskId} could not be loaded`, {
        stage: "inspect",
        regressionCategory: "task_unreachable"
      });
    }
    if (task.roleId !== "operations") {
      fail(`expected operations role, got ${String(task.roleId ?? "")}`, {
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
    const deliverableModeAllowed =
      acceptedMode === "task_queued" ? ["", "artifact_required"].includes(deliverableMode) : deliverableMode === "artifact_required";
    if (!deliverableModeAllowed) {
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
      detail:
        acceptedMode === "template_tasks_queued"
          ? `template=${created.templateId}, task=${taskId}, status=${String(task.status ?? "")}`
          : `task=${taskId}, role=${String(task.roleId ?? "")}, status=${String(task.status ?? "")}`,
      statePresent: true,
      stateStage: "recap_recurring",
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

#!/usr/bin/env node

import { runResetRuntimeDrain, startHarnessTaskRunner } from "./harness-preflight.mjs";

const ORCH_BASE = process.env.ORCH_BASE_URL ?? "http://127.0.0.1:8098";
const PREFLIGHT_TIMEOUT_MS = Number(process.env.ARTIFACT_EXPORT_PREFLIGHT_TIMEOUT_MS ?? 120_000);
const TASK_TIMEOUT_MS = Number(process.env.ARTIFACT_EXPORT_TASK_TIMEOUT_MS ?? 300_000);
const POLL_INTERVAL_MS = Number(process.env.ARTIFACT_EXPORT_POLL_INTERVAL_MS ?? 3_000);

function emitHarnessMeta(patch) {
  process.stderr.write(`HARNESS_META ${JSON.stringify({ suite: "artifact-export", ...patch })}\n`);
}

function fail(message, patch = {}) {
  emitHarnessMeta({ regressionCategory: patch.regressionCategory ?? "failed", status: "failed", detail: message, ...patch });
  process.stderr.write(`[self-check:artifact-export] FAIL: ${message}\n`);
  process.exit(1);
}

function info(message) {
  process.stdout.write(`[self-check:artifact-export] ${message}\n`);
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

function unwrapTask(payload) {
  if (payload && typeof payload === "object" && payload.task && typeof payload.task === "object") {
    return payload.task;
  }
  return payload;
}

async function postExportRequest(text) {
  return await fetchJson("/api/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      source: "control-center",
      requestedBy: exportRequestedBy,
      text
    })
  });
}

const exportRequestedBy = `selfcheck-artifact-export-${Date.now()}`;

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
    reason: `artifact-export-selfcheck-${Date.now()}`
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTaskCompletion(taskId) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < TASK_TIMEOUT_MS) {
    const taskPayload = await fetchJson(`/api/tasks/${taskId}`);
    const task = unwrapTask(taskPayload);
    if (!task || task.id !== taskId) {
      fail(`export task ${taskId} could not be loaded`, {
        stage: "poll",
        regressionCategory: "task_unreachable"
      });
    }
    if (task.status === "completed") {
      return task;
    }
    if (task.status === "failed" || task.status === "cancelled") {
      fail(`export task terminated with status=${task.status}`, {
        stage: "poll",
        regressionCategory: "task_terminal_failed"
      });
    }
    await sleep(POLL_INTERVAL_MS);
  }
  fail(`export task did not complete within ${TASK_TIMEOUT_MS}ms`, {
    stage: "poll",
    regressionCategory: "running_timeout"
  });
}

function collectArtifactFiles(task) {
  const fromEvidence = Array.isArray(task?.completionEvidence?.artifactFiles) ? task.completionEvidence.artifactFiles : [];
  const fromMetadata = Array.isArray(task?.metadata?.toolChangedFiles) ? task.metadata.toolChangedFiles : [];
  return Array.from(
    new Set([...fromEvidence, ...fromMetadata].filter((item) => typeof item === "string" && item.trim()))
  );
}

async function main() {
  info(`orchestrator=${ORCH_BASE}`);
  await runQueuePreflightDrain();
  let taskRunner;
  try {
    taskRunner = await startHarnessTaskRunner({
      label: "artifact-export"
    });
    emitHarnessMeta({ stage: "dispatch", status: "in_progress", regressionCategory: "in_progress" });

    let created = await postExportRequest(
      [
        "请生成一份 AI Agent 工具对比报告。",
        "必须输出结构化 Markdown 文档，并包含一个 Markdown 表格。",
        "表格必须严格使用这一行表头：| 工具 | 定位 | 价格带 | 适用场景 |",
        "表格下面至少给出 4 行数据。",
        "不要只返回文件路径，必须在回复正文中直接给出完整 Markdown 内容。",
        "最后给出 3 条下一步建议。"
      ].join("\n")
    );

    if (created?.type === "needs_clarification") {
      if (!Array.isArray(created.questions) || created.questions.length === 0) {
        fail(`needs_clarification missing questions: ${JSON.stringify(created)}`, {
          stage: "dispatch",
          regressionCategory: "clarification_missing_questions"
        });
      }
      created = await postExportRequest(
        [
          "对比工具：LangChain、CrewAI、AutoGen、OpenAI Agents SDK。",
          "目标受众：个人创业者和技术型创始人。",
          "场景重点：产品研发和多智能体执行协作。",
          "请务必包含 Markdown 表格，并使用表头：| 工具 | 定位 | 价格带 | 适用场景 |",
          "不要只返回文件路径，必须直接输出完整 Markdown 正文。"
        ].join("\n")
      );
    }

    let taskId = "";
    if (created?.type === "template_tasks_queued" && created?.templateId === "tpl-founder-research-report") {
      if (!Array.isArray(created?.taskIds) || created.taskIds.length !== 1) {
        fail(`expected exactly one export task, got ${JSON.stringify(created?.taskIds ?? null)}`, {
          stage: "dispatch",
          regressionCategory: "task_count_mismatch"
        });
      }
      taskId = String(created.taskIds[0]);
    } else if (created?.type === "task_queued" && typeof created?.taskId === "string") {
      taskId = created.taskId;
    } else {
      fail(`expected export task dispatch, got ${JSON.stringify(created)}`, {
        stage: "dispatch",
        regressionCategory: "routing"
      });
    }
    emitHarnessMeta({
      stage: "dispatch",
      status: "completed",
      regressionCategory: "none",
      detail: `dispatchType=${created.type}, task=${taskId}`,
      statePresent: true,
      stateStage: "artifact_export",
      stateStatus: "queued"
    });

    emitHarnessMeta({ stage: "poll", status: "in_progress", regressionCategory: "in_progress" });
    const task = await waitForTaskCompletion(taskId);
    const artifactFiles = collectArtifactFiles(task);

    const requiredExtensions = [".md", ".html"];
    const missing = requiredExtensions.filter((extension) => !artifactFiles.some((file) => String(file).toLowerCase().endsWith(extension)));
    if (missing.length > 0) {
      fail(`missing exported companion artifacts: ${missing.join(", ")}`, {
        stage: "validate",
        regressionCategory: "artifact_export_missing"
      });
    }
    const csvPresent = artifactFiles.some((file) => String(file).toLowerCase().endsWith(".csv"));

    emitHarnessMeta({
      stage: "validate",
      status: "completed",
      regressionCategory: "none",
      completedStages: ["dispatch", "poll", "validate"],
      artifactCount: artifactFiles.length,
      deliverableMode:
        typeof task?.completionEvidence?.deliverableMode === "string"
          ? task.completionEvidence.deliverableMode
          : typeof task?.metadata?.deliverableMode === "string"
            ? task.metadata.deliverableMode
            : "",
      detail: `${artifactFiles.join(", ")}${csvPresent ? " | csv=true" : " | csv=false"}`,
      statePresent: true,
      stateStage: "artifact_export",
      stateStatus: "completed"
    });

    info("PASS");
  } finally {
    await taskRunner?.stop().catch(() => undefined);
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error), { regressionCategory: "exception" });
});

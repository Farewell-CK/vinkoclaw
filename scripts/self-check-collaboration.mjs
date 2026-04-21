#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { runResetRuntimeDrain, startHarnessTaskRunner } from "./harness-preflight.mjs";

const ORCH_BASE = process.env.ORCH_BASE_URL ?? "http://127.0.0.1:8098";
const DB_PATH = process.env.VINKO_DB_PATH ?? ".data/vinkoclaw.sqlite";
const PREFLIGHT_TIMEOUT_MS = Number(process.env.COLLABORATION_PREFLIGHT_TIMEOUT_MS ?? 120_000);

function emitHarnessMeta(patch) {
  process.stderr.write(`HARNESS_META ${JSON.stringify({ suite: "collaboration", ...patch })}\n`);
}

function fail(message, patch = {}) {
  emitHarnessMeta({ regressionCategory: patch.regressionCategory ?? "failed", status: "failed", detail: message, ...patch });
  process.stderr.write(`[self-check:collaboration] FAIL: ${message}\n`);
  process.exit(1);
}

function info(message) {
  process.stdout.write(`[self-check:collaboration] ${message}\n`);
}

function sqlValue(query) {
  const output = execFileSync("sqlite3", [DB_PATH, query], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8"
  }).trim();
  return output;
}

async function postJson(pathname, payload) {
  const response = await fetch(`${ORCH_BASE}${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    reason: `collaboration-selfcheck-${Date.now()}`
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
  let taskRunner;
  try {
    taskRunner = await startHarnessTaskRunner({
      label: "collaboration"
    });
    emitHarnessMeta({ stage: "collaboration", status: "in_progress", regressionCategory: "in_progress" });

    const sender = `selfcheck-collab-${Date.now()}`;
    const created = await postJson("/api/messages", {
      source: "control-center",
      requestedBy: sender,
      text: [
        "帮我做一个活动报名系统，包含产品、前后端和测试。",
        "技术栈：React + Node.js + PostgreSQL。",
        "范围：报名表单、后台列表、审核、二维码签到，不做支付。",
        "目标用户：线下活动运营团队；并发规模：峰值 2000 人。"
      ].join("\n")
    });

    const acceptedType = created?.type;
    if (acceptedType !== "goal_run_queued" && acceptedType !== "task_queued") {
      fail(`expected goal_run_queued|task_queued, got ${JSON.stringify(created)}`, { regressionCategory: "routing" });
    }

    const goalRunId = String(created.goalRunId ?? "");
    const directTaskId = String(created.taskId ?? "");

    const deadline = Date.now() + 120_000;
    let executeTaskId = "";
    let collaborationCount = 0;
    while (Date.now() < deadline) {
      if (acceptedType === "goal_run_queued") {
        executeTaskId = sqlValue(
          `SELECT COALESCE((
             SELECT id FROM tasks
             WHERE json_extract(metadata_json, '$.goalRunId')='${goalRunId.replace(/'/g, "''")}'
               AND json_extract(metadata_json, '$.goalRunStage')='execute'
             ORDER BY created_at DESC
             LIMIT 1
           ), '');`
        );
      } else {
        executeTaskId = directTaskId;
      }

      if (executeTaskId) {
        collaborationCount = Number(
          sqlValue(`SELECT COUNT(*) FROM agent_collaborations WHERE parent_task_id='${executeTaskId.replace(/'/g, "''")}';`)
        );
        if (collaborationCount > 0) {
          break;
        }
        const collaborationMode = Number(
          sqlValue(`SELECT COALESCE(json_extract(metadata_json, '$.collaborationMode'), 0) FROM tasks WHERE id='${executeTaskId.replace(/'/g, "''")}';`)
        );
        if (acceptedType === "task_queued" && collaborationMode === 1) {
          break;
        }
      }
      await sleep(1200);
    }

    if (!executeTaskId) {
      fail(
        acceptedType === "goal_run_queued"
          ? `goalRun ${goalRunId} did not create execute task in time`
          : `task route did not return taskId in time`,
        { stage: "execute", regressionCategory: "queue_delay" }
      );
    }
    if (collaborationCount <= 0) {
      const collaborationMode = Number(
        sqlValue(`SELECT COALESCE(json_extract(metadata_json, '$.collaborationMode'), 0) FROM tasks WHERE id='${executeTaskId.replace(/'/g, "''")}';`)
      );
      if (collaborationMode !== 1) {
        fail(`execute task ${executeTaskId} did not start collaboration`, {
          stage: "execute",
          regressionCategory: "collaboration_missing"
        });
      }
    }

    emitHarnessMeta({
      stage: "collaboration",
      status: "completed",
      regressionCategory: "none",
      completedStages: ["collaboration"],
      detail: `executeTask=${executeTaskId}, collaborations=${collaborationCount}`,
      statePresent: true,
      stateStage: "execute",
      stateStatus: "active"
    });
    info("PASS");
  } finally {
    await taskRunner?.stop().catch(() => undefined);
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error), { regressionCategory: "exception" });
});

#!/usr/bin/env node
import { execSync } from "node:child_process";

const ORCH_BASE = process.env.ORCH_BASE_URL ?? "http://127.0.0.1:8098";
const DB_PATH = process.env.VINKO_DB_PATH ?? ".data/vinkoclaw.sqlite";

function fail(message) {
  console.error(`[self-check] FAIL: ${message}`);
  process.exit(1);
}

function info(message) {
  console.log(`[self-check] ${message}`);
}

function sqlValue(query) {
  const output = execSync(`cd /home/xsuper/workspace/vinkoclaw && sqlite3 ${DB_PATH} "${query}"`, {
    encoding: "utf8"
  }).trim();
  return output;
}

function getGlobalCounts() {
  const row = sqlValue("SELECT (SELECT COUNT(*) FROM tasks) || '|' || (SELECT COUNT(*) FROM goal_runs);");
  const [tasksRaw, goalsRaw] = row.split("|");
  return {
    tasks: Number(tasksRaw ?? "0"),
    goalRuns: Number(goalsRaw ?? "0")
  };
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
    fail(`HTTP ${response.status} ${path}: ${text}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`invalid json response for ${path}: ${text}`);
  }
}

function assertType(result, expected, scene) {
  if (!result || result.type !== expected) {
    fail(`${scene}: expected type=${expected}, got ${JSON.stringify(result)}`);
  }
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForQueueToSettle(input = { maxBusyTasks: 2, timeoutMs: 90_000 }) {
  const deadline = Date.now() + input.timeoutMs;
  while (Date.now() < deadline) {
    const busy = Number(
      sqlValue("SELECT COUNT(*) FROM tasks WHERE status IN ('queued','running');")
    );
    if (busy <= input.maxBusyTasks) {
      return;
    }
    await sleep(2000);
  }
}

async function runSmalltalkCheck() {
  info("smalltalk should not create tasks");
  const before = getGlobalCounts();
  const chatId = `oc_selfcheck_smalltalk_${Date.now()}`;
  const sender = "ou_selfcheck_smalltalk";
  const messages = ["你好", "你可以做什么？", "并行的", "在吗"];
  for (const text of messages) {
    const result = await postJson("/api/messages", {
      source: "feishu",
      chatId,
      requestedBy: sender,
      text
    });
    assertType(result, "smalltalk_replied", "smalltalk");
  }
  const after = getGlobalCounts();
  if (after.tasks !== before.tasks || after.goalRuns !== before.goalRuns) {
    fail(`smalltalk changed counts: before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
  }
}

async function runGoalRunRaceCheck() {
  info("goalrun should accept immediate key:value inputs without creating tasks");
  const before = getGlobalCounts();
  const chatId = `oc_selfcheck_goal_${Date.now()}`;
  const sender = "ou_selfcheck_goal";

  const created = await postJson("/api/messages", {
    source: "feishu",
    chatId,
    requestedBy: sender,
    text: "帮我给公司写一个官网并部署"
  });
  assertType(created, "goal_run_queued", "goalrun create");

  const prefetched = await postJson("/api/messages", {
    source: "feishu",
    chatId,
    requestedBy: sender,
    text: "company_name: 可交付科技, business_domain: AI效率工具, target_audience: 企业团队"
  });
  assertType(prefetched, "operator_action_applied", "goalrun prefill");

  await sleep(1200);
  const progress = await postJson("/api/messages", {
    source: "feishu",
    chatId,
    requestedBy: sender,
    text: "进度如何"
  });
  assertType(progress, "smalltalk_replied", "goalrun progress");

  const after = getGlobalCounts();
  if (after.goalRuns !== before.goalRuns + 1) {
    fail(`goalrun count mismatch: before=${before.goalRuns}, after=${after.goalRuns}`);
  }
}

async function runDuplicateEventCheck() {
  info("duplicate webhook event should be ignored");
  const chatId = `oc_selfcheck_dedup_${Date.now()}`;
  const messageId = `om_selfcheck_${Date.now()}`;
  const eventBody = {
    header: {
      event_type: "im.message.receive_v1"
    },
    event: {
      message: {
        message_id: messageId,
        chat_id: chatId,
        message_type: "text",
        content: JSON.stringify({
          text: "请帮我调研重复事件测试"
        })
      },
      sender: {
        sender_id: {
          open_id: "ou_selfcheck_dedup"
        }
      }
    }
  };

  const first = await postJson("/api/feishu/events", eventBody);
  if (!first.result || typeof first.result.type !== "string") {
    fail(`first dedupe event result invalid: ${JSON.stringify(first)}`);
  }
  const second = await postJson("/api/feishu/events", eventBody);
  if (!second.result || second.result.type !== "duplicate_ignored") {
    fail(`second dedupe event should be duplicate_ignored: ${JSON.stringify(second)}`);
  }

  await sleep(500);
  const goalCount = Number(
    sqlValue(`SELECT COUNT(*) FROM goal_runs WHERE chat_id='${chatId.replace(/'/g, "''")}';`)
  );
  const taskCount = Number(
    sqlValue(`SELECT COUNT(*) FROM tasks WHERE chat_id='${chatId.replace(/'/g, "''")}';`)
  );
  const total = goalCount + taskCount;
  if (total !== 1) {
    fail(`duplicate event created ${total} work items (goal=${goalCount}, task=${taskCount}), expected 1`);
  }
}

async function runCollaborationCheck() {
  info("complex objective should trigger real collaboration in execute stage");
  await waitForQueueToSettle();
  const sender = `selfcheck-collab-${Date.now()}`;
  const created = await postJson("/api/messages", {
    source: "control-center",
    requestedBy: sender,
    text: "帮我做一个活动报名系统，包含产品、前后端和测试"
  });
  assertType(created, "goal_run_queued", "collaboration create");
  const goalRunId = String(created.goalRunId ?? "");
  if (!goalRunId) {
    fail(`collaboration check: missing goalRunId in response ${JSON.stringify(created)}`);
  }

  const deadline = Date.now() + 120_000;
  let executeTaskId = "";
  let collaborationCount = 0;
  while (Date.now() < deadline) {
    executeTaskId = sqlValue(
      `SELECT COALESCE((
         SELECT id FROM tasks
         WHERE json_extract(metadata_json, '$.goalRunId')='${goalRunId.replace(/'/g, "''")}'
           AND json_extract(metadata_json, '$.goalRunStage')='execute'
         ORDER BY created_at DESC
         LIMIT 1
       ), '');`
    );
    if (executeTaskId) {
      collaborationCount = Number(
        sqlValue(
          `SELECT COUNT(*) FROM agent_collaborations WHERE parent_task_id='${executeTaskId.replace(/'/g, "''")}';`
        )
      );
      if (collaborationCount > 0) {
        break;
      }
    }
    await sleep(1200);
  }

  if (!executeTaskId) {
    fail(`collaboration check: goalRun ${goalRunId} did not create execute task in time`);
  }
  if (collaborationCount <= 0) {
    fail(`collaboration check: execute task ${executeTaskId} did not start collaboration`);
  }
}

async function main() {
  info(`orchestrator=${ORCH_BASE}`);
  await runSmalltalkCheck();
  await runGoalRunRaceCheck();
  await runDuplicateEventCheck();
  await runCollaborationCheck();
  info("PASS");
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});

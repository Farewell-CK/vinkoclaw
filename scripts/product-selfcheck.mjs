#!/usr/bin/env node

const ORCH_BASE = process.env.ORCH_BASE_URL ?? "http://127.0.0.1:8098";
const RUN_ID = `product-selfcheck-${Date.now()}`;

function info(message) {
  console.log(`[product-selfcheck] ${message}`);
}

function fail(message) {
  console.error(`[product-selfcheck] FAIL: ${message}`);
  process.exit(1);
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

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

function uniqueIdentity(suffix) {
  const token = `${RUN_ID}-${suffix}`;
  return {
    requestedBy: `ou_${token}`,
    chatId: `oc_${token}`
  };
}

async function waitTaskTerminal(taskId, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = await getJson(`/api/tasks/${taskId}`);
    if (["completed", "failed", "cancelled"].includes(task.status)) {
      return task;
    }
    await sleep(1000);
  }
  fail(`task ${taskId} not terminal in ${timeoutMs}ms`);
}

async function runHealthCheck() {
  info("health check");
  const health = await getJson("/health");
  assert(health?.ok === true, "health endpoint not ok");
}

async function runSmalltalkFastPathCheck() {
  info("smalltalk fast-path check");
  const identity = uniqueIdentity("smalltalk");
  const beforeTasks = await getJson("/api/tasks");
  const beforeCount = Array.isArray(beforeTasks) ? beforeTasks.length : 0;

  const result = await postJson("/api/messages", {
    source: "feishu",
    requestedBy: identity.requestedBy,
    chatId: identity.chatId,
    text: "你好👋"
  });
  assert(result.type === "smalltalk_replied", `smalltalk should reply directly, got ${JSON.stringify(result)}`);

  const afterTasks = await getJson("/api/tasks");
  const afterCount = Array.isArray(afterTasks) ? afterTasks.length : 0;
  assert(afterCount === beforeCount, `smalltalk should not create tasks (${beforeCount} -> ${afterCount})`);
}

async function runSimpleTaskRoutingCheck() {
  info("simple task routing check");
  const identity = uniqueIdentity("simple-task");
  const result = await postJson("/api/messages", {
    source: "feishu",
    requestedBy: identity.requestedBy,
    chatId: identity.chatId,
    text: "请帮我写一个登录页原型"
  });
  assert(result.type === "task_queued", `expected task_queued, got ${JSON.stringify(result)}`);
  const taskId = String(result.taskId ?? "");
  assert(taskId.length > 0, "task_queued response missing taskId");

  const task = await getJson(`/api/tasks/${taskId}`);
  assert(
    task.roleId === "uiux" || task.roleId === "frontend",
    `simple task should route to uiux/frontend, got ${task.roleId}`
  );

  await postJson(`/api/tasks/${taskId}/cancel`, {
    reason: `${RUN_ID} cleanup`
  });
  await waitTaskTerminal(taskId, 30_000);
}

async function runGoalRunAndContinueCheck() {
  info("goal run + continue signal check");
  const identity = uniqueIdentity("goalrun");
  const created = await postJson("/api/messages", {
    source: "feishu",
    requestedBy: identity.requestedBy,
    chatId: identity.chatId,
    text: "帮我给公司写一个官网并部署"
  });
  assert(created.type === "goal_run_queued", `expected goal_run_queued, got ${JSON.stringify(created)}`);
  const goalRunId = String(created.goalRunId ?? "");
  assert(goalRunId.length > 0, "goal_run_queued response missing goalRunId");

  const continued = await postJson("/api/messages", {
    source: "feishu",
    requestedBy: identity.requestedBy,
    chatId: identity.chatId,
    text: "继续"
  });
  assert(continued.type === "smalltalk_replied", `continue should return smalltalk_replied, got ${JSON.stringify(continued)}`);
  assert(
    typeof continued.message === "string" && continued.message.includes(goalRunId.slice(0, 8)),
    `continue response should include goal run hint: ${JSON.stringify(continued)}`
  );
  assert(
    !/\baccept\b|\bdiscover\b|\bplan\b|\bexecute\b|\bverify\b|\bdeploy\b/i.test(String(continued.message ?? "")),
    `continue response should avoid raw english stage ids: ${JSON.stringify(continued)}`
  );

  const statusReply = await postJson("/api/messages", {
    source: "feishu",
    requestedBy: identity.requestedBy,
    chatId: identity.chatId,
    text: "现在进度如何？"
  });
  assert(statusReply.type === "smalltalk_replied", `status query should return smalltalk_replied, got ${JSON.stringify(statusReply)}`);
  assert(
    /阶段/.test(String(statusReply.message ?? "")),
    `status query should include chinese stage wording: ${JSON.stringify(statusReply)}`
  );

  const cancelled = await postJson(`/api/goal-runs/${goalRunId}/cancel`, {
    reason: `${RUN_ID} cleanup`
  });
  assert(cancelled?.goalRun?.status === "cancelled", `goal run cancel failed: ${JSON.stringify(cancelled)}`);
}

async function runStatusIntentDisambiguationCheck() {
  info("status keyword disambiguation check");
  const identity = uniqueIdentity("status-disambiguation");
  const configReply = await postJson("/api/messages", {
    source: "feishu",
    requestedBy: identity.requestedBy,
    chatId: identity.chatId,
    text: "帮我配置搜索工具，状态改成可用"
  });
  assert(
    configReply.type === "config_input_required" || configReply.type === "operator_action_pending" || configReply.type === "operator_action_applied",
    `status keyword in action sentence should not be treated as pure status query: ${JSON.stringify(configReply)}`
  );

  const collaborationCreated = await postJson("/api/messages", {
    source: "feishu",
    requestedBy: identity.requestedBy,
    chatId: identity.chatId,
    text: "团队协作执行，做一个活动落地页"
  });
  assert(collaborationCreated.type === "task_queued", `expected task_queued for collaboration, got ${JSON.stringify(collaborationCreated)}`);
  const taskId = String(collaborationCreated.taskId ?? "");
  assert(taskId.length > 0, "collaboration task response missing taskId");

  const progressReply = await postJson("/api/messages", {
    source: "feishu",
    requestedBy: identity.requestedBy,
    chatId: identity.chatId,
    text: "当前进度怎么样？"
  });
  assert(progressReply.type === "smalltalk_replied", `progress query should return smalltalk_replied, got ${JSON.stringify(progressReply)}`);
  assert(
    /协作进展|成员动态|团队协作已启动/.test(String(progressReply.message ?? "")),
    `progress reply should include collaboration role progress hint: ${JSON.stringify(progressReply)}`
  );

  await postJson(`/api/tasks/${taskId}/cancel`, {
    reason: `${RUN_ID} cleanup`
  });
  await waitTaskTerminal(taskId, 30_000);
}

async function runStaleTaskAndGoalRunCleanupApiCheck() {
  info("stale task/goal-run cleanup api check");
  const identity = uniqueIdentity("stale-cleanup");

  const taskCreated = await postJson("/api/messages", {
    source: "feishu",
    requestedBy: identity.requestedBy,
    chatId: identity.chatId,
    text: "请帮我整理本周工作日报"
  });
  assert(taskCreated.type === "task_queued", `expected task_queued, got ${JSON.stringify(taskCreated)}`);
  const taskId = String(taskCreated.taskId ?? "");
  assert(taskId.length > 0, "task_queued response missing taskId");

  const taskDryRun = await postJson("/api/tasks/cancel-stale", {
    olderThanMinutes: 0,
    includeRunning: true,
    requestedBy: identity.requestedBy,
    dryRun: true
  });
  assert(taskDryRun.dryRun === true, `task cancel-stale dryRun failed: ${JSON.stringify(taskDryRun)}`);
  assert(Array.isArray(taskDryRun.candidateTaskIds), `task cancel-stale candidate ids missing: ${JSON.stringify(taskDryRun)}`);

  if (taskDryRun.candidateTaskIds.includes(taskId)) {
    const taskCleanup = await postJson("/api/tasks/cancel-stale", {
      olderThanMinutes: 0,
      includeRunning: true,
      requestedBy: identity.requestedBy,
      dryRun: false
    });
    assert(Array.isArray(taskCleanup.errors) && taskCleanup.errors.length === 0, `task cancel-stale errors: ${JSON.stringify(taskCleanup)}`);
  } else {
    await postJson(`/api/tasks/${taskId}/cancel`, {
      reason: `${RUN_ID} cleanup-fallback`
    });
  }

  const goalRunCreated = await postJson("/api/messages", {
    source: "feishu",
    requestedBy: identity.requestedBy,
    chatId: identity.chatId,
    text: "帮我做一个公司官网并部署上线"
  });
  assert(goalRunCreated.type === "goal_run_queued", `expected goal_run_queued, got ${JSON.stringify(goalRunCreated)}`);
  const goalRunId = String(goalRunCreated.goalRunId ?? "");
  assert(goalRunId.length > 0, "goal_run_queued response missing goalRunId");

  const goalRunDryRun = await postJson("/api/goal-runs/cancel-stale", {
    olderThanMinutes: 0,
    requestedBy: identity.requestedBy,
    statuses: ["queued", "running", "awaiting_input", "awaiting_authorization"],
    dryRun: true
  });
  assert(goalRunDryRun.dryRun === true, `goal-run cancel-stale dryRun failed: ${JSON.stringify(goalRunDryRun)}`);
  assert(
    Array.isArray(goalRunDryRun.candidateGoalRunIds),
    `goal-run cancel-stale candidate ids missing: ${JSON.stringify(goalRunDryRun)}`
  );

  if (goalRunDryRun.candidateGoalRunIds.includes(goalRunId)) {
    const goalRunCleanup = await postJson("/api/goal-runs/cancel-stale", {
      olderThanMinutes: 0,
      requestedBy: identity.requestedBy,
      statuses: ["queued", "running", "awaiting_input", "awaiting_authorization"],
      dryRun: false
    });
    assert(
      Array.isArray(goalRunCleanup.errors) && goalRunCleanup.errors.length === 0,
      `goal-run cancel-stale errors: ${JSON.stringify(goalRunCleanup)}`
    );
  } else {
    await postJson(`/api/goal-runs/${goalRunId}/cancel`, {
      reason: `${RUN_ID} cleanup-fallback`
    });
  }
}

async function runApprovalCancelChecks() {
  info("approval cancel check");
  const identity = uniqueIdentity("approval-single");
  const pending = await postJson("/api/messages", {
    source: "feishu",
    requestedBy: identity.requestedBy,
    chatId: identity.chatId,
    text: "设置 OPENAI_API_KEY 为 sk-self-check-value"
  });
  assert(pending.type === "operator_action_pending", `expected operator_action_pending, got ${JSON.stringify(pending)}`);
  const approvalId = String(pending.approvalId ?? "");
  assert(approvalId.length > 0, "operator_action_pending response missing approvalId");

  const cancelled = await postJson(`/api/approvals/${approvalId}/cancel`, {
    decidedBy: "owner",
    reason: `${RUN_ID} single-cancel`
  });
  assert(cancelled?.approval?.status === "rejected", `approval cancel failed: ${JSON.stringify(cancelled)}`);
}

async function runStaleApprovalCleanupCheck() {
  info("stale approval cleanup check");
  const identity = uniqueIdentity("approval-batch");
  const pending = await postJson("/api/messages", {
    source: "feishu",
    requestedBy: identity.requestedBy,
    chatId: identity.chatId,
    text: "设置 OPENAI_API_KEY 为 sk-self-check-batch"
  });
  assert(pending.type === "operator_action_pending", `expected operator_action_pending, got ${JSON.stringify(pending)}`);

  const cleanup = await postJson("/api/approvals/cancel-stale", {
    olderThanMinutes: 0,
    requestedBy: identity.requestedBy,
    limit: 20,
    decidedBy: "owner",
    reasonPrefix: `${RUN_ID} batch-cancel`
  });
  assert(Number(cleanup.cancelledCount ?? 0) >= 1, `expected >=1 stale approval cancelled, got ${JSON.stringify(cleanup)}`);
  assert(Array.isArray(cleanup.errors) && cleanup.errors.length === 0, `stale cleanup has errors: ${JSON.stringify(cleanup)}`);
}

async function runFinalMetricsCheck() {
  info("final metrics check");
  const metrics = await getJson("/api/system/metrics");
  assert(metrics?.queueDepth?.queuedTasks === 0, `queuedTasks should be 0, got ${JSON.stringify(metrics?.queueDepth)}`);
  assert(metrics?.queueDepth?.queuedGoalRuns === 0, `queuedGoalRuns should be 0, got ${JSON.stringify(metrics?.queueDepth)}`);
}

async function main() {
  info(`orchestrator=${ORCH_BASE}`);
  await runHealthCheck();
  await runSmalltalkFastPathCheck();
  await runSimpleTaskRoutingCheck();
  await runGoalRunAndContinueCheck();
  await runStatusIntentDisambiguationCheck();
  await runStaleTaskAndGoalRunCleanupApiCheck();
  await runApprovalCancelChecks();
  await runStaleApprovalCleanupCheck();
  await runFinalMetricsCheck();
  info("PASS");
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});

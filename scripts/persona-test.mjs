#!/usr/bin/env node
/**
 * persona-test.mjs — 拟人化端到端测试
 * 模拟真实用户通过飞书发送的消息，验证路由、执行和回复质量。
 * Usage: node scripts/persona-test.mjs
 * Prerequisite: orchestrator + task-runner running (npm run dev)
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ORCH_BASE = process.env.ORCH_BASE_URL ?? "http://127.0.0.1:8098";
const TASK_TIMEOUT_MS = Number(process.env.PERSONA_TASK_TIMEOUT_MS ?? "900000"); // 15 min
const MAX_WALL_CLOCK_MS = Number(process.env.PERSONA_MAX_WALL_CLOCK_MS ?? "1800000"); // 30 min
const POLL_INTERVAL_MS = 2000;
const RUN_ID = `persona-${Date.now()}`;
const ROOT = join(fileURLToPath(import.meta.url), "../../");
const REPORT_DIR = join(ROOT, ".run/persona-test");

// ─── ANSI colors ───────────────────────────────────────────────────────────
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

// ─── HTTP helpers ──────────────────────────────────────────────────────────
async function getJson(path) {
  const res = await fetch(`${ORCH_BASE}${path}`);
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} GET ${path}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

async function postJson(path, payload) {
  const res = await fetch(`${ORCH_BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} POST ${path}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function createPersonaError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  return Object.assign(error, extra);
}

// ─── Task polling ──────────────────────────────────────────────────────────
async function waitTaskTerminal(taskId, options = {}) {
  const taskTimeoutMs = Number.isFinite(options.taskTimeoutMs) ? options.taskTimeoutMs : TASK_TIMEOUT_MS;
  const wallClockDeadlineMs =
    Number.isFinite(options.wallClockDeadlineMs) && options.wallClockDeadlineMs > 0
      ? options.wallClockDeadlineMs
      : Number.POSITIVE_INFINITY;
  const taskDeadlineMs = Date.now() + taskTimeoutMs;

  while (Date.now() < taskDeadlineMs) {
    if (Date.now() >= wallClockDeadlineMs) {
      throw createPersonaError(
        "global_wall_clock_timeout",
        `persona run exceeded wall-clock budget (${Math.round((wallClockDeadlineMs - (taskDeadlineMs - taskTimeoutMs)) / 1000)}s)`
      );
    }
    const task = await getJson(`/api/tasks/${taskId}`);
    if (["completed", "failed", "cancelled"].includes(task.status)) return task;
    await sleep(POLL_INTERVAL_MS);
  }
  throw createPersonaError(
    "task_timeout",
    `task ${taskId} did not reach terminal status within ${Math.round(taskTimeoutMs / 1000)}s`
  );
}

async function classifyPollingFailure(taskId, error) {
  let taskSnapshot;
  try {
    taskSnapshot = await getJson(`/api/tasks/${taskId}`);
  } catch {
    taskSnapshot = undefined;
  }

  if (error?.code === "global_wall_clock_timeout") {
    return {
      failureCategory: "global_wall_clock_timeout",
      taskStatus: taskSnapshot?.status,
      errorText: error.message
    };
  }

  const status = taskSnapshot?.status;
  const toolSummary = taskSnapshot?.completionEvidence?.toolRunSummary;
  const toolLikelyStalled =
    status === "running" &&
    toolSummary &&
    Number(toolSummary.total ?? 0) > 0 &&
    Number(toolSummary.completed ?? 0) === 0 &&
    Number(toolSummary.failed ?? 0) === 0;

  if (toolLikelyStalled) {
    return {
      failureCategory: "tool_run_stalled",
      taskStatus: status,
      errorText: error?.message ?? "tool run stalled"
    };
  }

  if (status === "running" || status === "queued" || status === "waiting_approval") {
    return {
      failureCategory: "task_stalled",
      taskStatus: status,
      errorText: error?.message ?? "task stalled"
    };
  }

  return {
    failureCategory: "task_polling_failed",
    taskStatus: status,
    errorText: error?.message ?? "polling failed"
  };
}

// ─── Test scenarios ────────────────────────────────────────────────────────
const SCENARIOS = [
  {
    id: 1,
    name: "问候——你好",
    input: "你好",
    expectType: "smalltalk_replied",
    expectRole: null,
    note: "纯问候，不应创建任务",
  },
  {
    id: 2,
    name: "感谢——谢谢",
    input: "谢谢你",
    expectType: "smalltalk_replied",
    expectRole: null,
    note: "感谢语，不应创建任务",
  },
  {
    id: 3,
    name: "自我介绍询问",
    input: "你是谁，你能做什么",
    expectType: ["smalltalk_replied", "task_queued"],
    expectRole: null,
    note: "介绍性问题，应快速回复",
  },
  {
    id: 4,
    name: "PRD 写作",
    input: "帮我写个用户登录功能的PRD",
    expectType: "task_queued",
    expectRole: "product",
    note: "产品文档请求，应路由到 product 角色",
  },
  {
    id: 5,
    name: "市场调研分析",
    input: "帮我分析一下具身智能的市场现状和发展趋势",
    expectType: "task_queued",
    expectRole: "research",
    note: "调研分析请求，应路由到 research 角色",
  },
  {
    id: 6,
    name: "代码 Bug 检查",
    input: "帮我看看这段代码有没有bug：for i in range(10): print(i",
    expectType: "task_queued",
    expectRole: "engineering",
    note: "代码 bug 请求，应路由到 engineering 角色",
  },
  {
    id: 7,
    name: "前端登录页开发",
    input: "帮我做一个登录页，用React写",
    expectType: "task_queued",
    expectRole: "frontend",
    note: "React 前端请求，应路由到 frontend 角色",
  },
  {
    id: 8,
    name: "建设产品官网",
    input: "帮我建一个产品官网",
    expectType: ["task_queued", "goal_run_queued"],
    expectRole: ["frontend", null],
    note: "网站建设请求，可路由到 frontend 任务或 goal_run（复杂程度合理）",
  },
  {
    id: 9,
    name: "战略方向决策",
    input: "我们的AI产品下一步战略方向怎么定，需要考虑哪些核心要素",
    expectType: "task_queued",
    expectRole: ["product", "ceo", "cto", "research"],
    note: "战略问题，可接受 product/ceo/cto/research",
  },
  {
    id: 10,
    name: "后端 API 开发",
    input: "帮我写一个后端API，实现用户注册，用Node.js",
    expectType: "task_queued",
    expectRole: "backend",
    note: "后端 API 请求，应路由到 backend 角色",
  },
  {
    id: 11,
    name: "竞品分析报告（含发我）",
    input: "帮我写一份主流AI助手竞争对手分析报告，写完发我",
    expectType: "task_queued",
    expectRole: "research",
    note: '包含"发我"，应路由到 research，完成后发送文件',
  },
  {
    id: 12,
    name: "技术架构设计",
    input: "我们系统的技术架构该如何设计，微服务和单体架构各有什么优劣",
    expectType: "task_queued",
    expectRole: ["cto", "backend", "engineering", "research"],
    note: "架构问题，可接受 cto/backend/engineering/research",
  },
];

// ─── Result tracking ───────────────────────────────────────────────────────
const results = [];

function pass(scenario, detail) {
  results.push({ ...scenario, status: "PASS", detail });
  console.log(`  ${green("✅ PASS")} ${dim(detail)}`);
}

function fail(scenario, detail) {
  results.push({ ...scenario, status: "FAIL", detail });
  console.log(`  ${red("❌ FAIL")} ${detail}`);
}

function roleMatch(expectRole, actualRole) {
  if (expectRole === null) return true;
  if (Array.isArray(expectRole)) return expectRole.includes(actualRole);
  return expectRole === actualRole;
}

function typeMatch(expectType, actualType) {
  if (Array.isArray(expectType)) return expectType.includes(actualType);
  return expectType === actualType;
}

// ─── Run a single scenario ─────────────────────────────────────────────────
async function runScenario(scenario, context = {}) {
  const { id, name, input, expectType, expectRole, note } = scenario;
  const wallClockDeadlineMs =
    Number.isFinite(context.wallClockDeadlineMs) && context.wallClockDeadlineMs > 0
      ? context.wallClockDeadlineMs
      : Number.POSITIVE_INFINITY;
  const identity = {
    requestedBy: `ou_persona_${RUN_ID}_${id}`,
    chatId: `oc_persona_${RUN_ID}_${id}`,
  };

  console.log(`\n${bold(`[${id}/12]`)} ${name}`);
  console.log(`  ${dim("Input:")} ${yellow(`"${input}"`)}`);
  console.log(`  ${dim("Expect:")} type=${Array.isArray(expectType) ? expectType.join("|") : expectType}, role=${Array.isArray(expectRole) ? expectRole.join("|") : (expectRole ?? "—")}`);

  if (Date.now() >= wallClockDeadlineMs) {
    const detail = "persona run exceeded global wall-clock budget before this scenario started";
    fail(scenario, detail);
    return { ...scenario, status: "FAIL", detail, failureCategory: "global_wall_clock_timeout" };
  }

  const startMs = Date.now();
  let msgResult;

  try {
    msgResult = await postJson("/api/messages", {
      text: input,
      source: "feishu",
      requestedBy: identity.requestedBy,
      chatId: identity.chatId,
    });
  } catch (err) {
    fail(scenario, `POST /api/messages failed: ${err.message}`);
    return {
      ...scenario,
      status: "FAIL",
      error: err.message,
      ackMs: Date.now() - startMs,
      failureCategory: "message_submit_failed"
    };
  }

  const ackMs = Date.now() - startMs;
  const actualType = msgResult.type;

  // ── Smalltalk / conversation path (no task) ──────────────────────────────
  if (!msgResult.taskId && !msgResult.goalRunId) {
    if (typeMatch(expectType, actualType)) {
      const detail = `type=${actualType}, reply="${(msgResult.message ?? "").slice(0, 60)}", ackMs=${ackMs}`;
      pass(scenario, detail);
      return { ...scenario, status: "PASS", actualType, ackMs, reply: msgResult.message };
    } else {
      const detail = `expected type=${Array.isArray(expectType) ? expectType.join("|") : expectType}, got type=${actualType}`;
      fail(scenario, detail);
      return { ...scenario, status: "FAIL", actualType, ackMs, detail, failureCategory: "response_type_mismatch" };
    }
  }

  // ── Goal run queued path (accept as pass if expected) ────────────────────
  if (msgResult.goalRunId && !msgResult.taskId) {
    if (typeMatch(expectType, actualType)) {
      const detail = `type=${actualType}, goalRunId=${msgResult.goalRunId?.slice(0, 8)}, ackMs=${ackMs}`;
      pass(scenario, detail);
      return { ...scenario, status: "PASS", actualType, ackMs, goalRunId: msgResult.goalRunId };
    } else {
      const detail = `expected type=${Array.isArray(expectType) ? expectType.join("|") : expectType}, got type=${actualType} (goalRunId=${msgResult.goalRunId?.slice(0, 8)})`;
      fail(scenario, detail);
      return { ...scenario, status: "FAIL", actualType, ackMs, detail, failureCategory: "response_type_mismatch" };
    }
  }

  // ── Task queued path ─────────────────────────────────────────────────────
  if (!typeMatch(expectType, actualType)) {
    const detail = `expected type=${Array.isArray(expectType) ? expectType.join("|") : expectType}, got type=${actualType}`;
    fail(scenario, detail);
    return { ...scenario, status: "FAIL", actualType, ackMs, detail, failureCategory: "response_type_mismatch" };
  }

  const taskId = msgResult.taskId;
  if (!taskId) {
    const detail = `type=${actualType} but no taskId in response`;
    fail(scenario, detail);
    return { ...scenario, status: "FAIL", actualType, ackMs, detail, failureCategory: "invalid_response_shape" };
  }

  console.log(`  ${dim("Task ID:")} ${taskId} — polling...`);

  let task;
  try {
    task = await waitTaskTerminal(taskId, {
      taskTimeoutMs: TASK_TIMEOUT_MS,
      wallClockDeadlineMs
    });
  } catch (err) {
    const classified = await classifyPollingFailure(taskId, err);
    const detail = `Polling failed: ${classified.errorText}`;
    fail(scenario, detail);
    return {
      ...scenario,
      status: "FAIL",
      actualType,
      taskId,
      ackMs,
      detail,
      failureCategory: classified.failureCategory,
      taskStatus: classified.taskStatus,
      errorText: classified.errorText
    };
  }

  const totalMs = Date.now() - startMs;
  const actualRole = task.roleId;
  const taskStatus = task.status;
  const summaryPreview = (task.result?.summary ?? "").slice(0, 100);
  const deliverableLen = (task.result?.deliverable ?? "").length;
  const artifactFiles = task.completionEvidence?.artifactFiles ?? [];
  const errorText = task.errorText ?? "";

  // Build detail string
  const details = [
    `type=${actualType}`,
    `role=${actualRole}`,
    `status=${taskStatus}`,
    `summaryLen=${(task.result?.summary ?? "").length}`,
    `deliverableLen=${deliverableLen}`,
    `totalMs=${totalMs}`,
  ];
  if (artifactFiles.length > 0) details.push(`artifacts=[${artifactFiles.join(", ")}]`);

  // Validate
  const roleOk = roleMatch(expectRole, actualRole);
  const statusOk = taskStatus === "completed";
  const summaryOk = (task.result?.summary ?? "").trim().length > 0;
  const deliverableOk = deliverableLen > 0;

  if (!statusOk) {
    fail(scenario, `task ${taskId} status=${taskStatus}. Error: ${errorText.slice(0, 120)}`);
    return {
      ...scenario,
      status: "FAIL",
      actualType,
      actualRole,
      taskId,
      taskStatus,
      totalMs,
      errorText,
      failureCategory: "task_terminal_failed"
    };
  }

  if (!roleOk) {
    fail(scenario, `expected role=${Array.isArray(expectRole) ? expectRole.join("|") : expectRole}, got role=${actualRole}`);
    return {
      ...scenario,
      status: "FAIL",
      actualType,
      actualRole,
      taskId,
      taskStatus,
      totalMs,
      summaryPreview,
      failureCategory: "route_mismatch"
    };
  }

  if (!summaryOk || !deliverableOk) {
    fail(scenario, `empty output: summary=${summaryOk}, deliverable=${deliverableOk}`);
    return {
      ...scenario,
      status: "FAIL",
      actualType,
      actualRole,
      taskId,
      taskStatus,
      totalMs,
      summaryPreview,
      failureCategory: "empty_output"
    };
  }

  pass(scenario, details.join(", "));
  return { ...scenario, status: "PASS", actualType, actualRole, taskId, taskStatus, totalMs, summaryPreview, deliverableLen, artifactFiles };
}

// ─── Generate markdown report ──────────────────────────────────────────────
function buildReport(scenarioResults, totalMs) {
  const passed = scenarioResults.filter((r) => r.status === "PASS").length;
  const failed = scenarioResults.filter((r) => r.status === "FAIL").length;
  const passRate = scenarioResults.length === 0 ? 0 : (passed / scenarioResults.length) * 100;
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  const rootCauseHints = {
    route_mismatch: "路由策略未命中预期角色，需调整意图判定或角色选择规则。",
    response_type_mismatch: "消息入口返回类型与预期不一致，需检查 intent classifier 与入口分流。",
    task_stalled: "任务未在预算内收敛，需检查任务心跳、任务状态推进与异常分支。",
    tool_run_stalled: "工具执行长期 running，需检查 provider 调用、超时回收与任务失败回填。",
    global_wall_clock_timeout: "整轮测试超过总时长预算，建议缩减场景或并行分层执行。",
    task_terminal_failed: "任务终态为 failed/cancelled，需查看 errorText 与审计日志。",
    empty_output: "任务完成但摘要或交付为空，需强化输出格式约束。",
    message_submit_failed: "消息提交失败，需检查 orchestrator 可用性与接口契约。",
    task_polling_failed: "轮询阶段异常，需检查接口稳定性与网络可达性。",
    invalid_response_shape: "接口返回结构异常，需修复字段契约。"
  };

  const lines = [
    `# Persona Test Report`,
    ``,
    `**Date**: ${ts}  `,
    `**Run ID**: ${RUN_ID}  `,
    `**Orchestrator**: ${ORCH_BASE}  `,
    ``,
    `## Summary`,
    ``,
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Tests run | ${scenarioResults.length} |`,
    `| Passed | ${passed} |`,
    `| Failed | ${failed} |`,
    `| Task timeout | ${(TASK_TIMEOUT_MS / 1000).toFixed(0)}s |`,
    `| Max wall clock | ${(MAX_WALL_CLOCK_MS / 1000).toFixed(0)}s |`,
    `| Total wall time | ${(totalMs / 1000).toFixed(1)}s |`,
    `| Pass rate | ${passRate.toFixed(0)}% |`,
    ``,
    `## Scenario Results`,
    ``,
  ];

  for (const r of scenarioResults) {
    const icon = r.status === "PASS" ? "✅" : "❌";
    lines.push(`### ${icon} Test ${r.id}: ${r.name}`);
    lines.push(``);
    lines.push(`**Input**: \`${r.input}\``);
    lines.push(`**Note**: ${r.note}`);
    lines.push(`**Expected**: type=${Array.isArray(r.expectType) ? r.expectType.join("|") : r.expectType}, role=${Array.isArray(r.expectRole) ? r.expectRole.join("|") : (r.expectRole ?? "—")}`);
    lines.push(`**Result**: ${r.status}`);
    lines.push(``);
    lines.push(`| Field | Value |`);
    lines.push(`|-------|-------|`);
    if (r.actualType) lines.push(`| Response type | \`${r.actualType}\` |`);
    if (r.actualRole) lines.push(`| Role assigned | \`${r.actualRole}\` |`);
    if (r.taskId) lines.push(`| Task ID | \`${r.taskId}\` |`);
    if (r.taskStatus) lines.push(`| Task status | \`${r.taskStatus}\` |`);
    if (r.failureCategory) lines.push(`| Failure category | \`${r.failureCategory}\` |`);
    if (r.ackMs !== undefined) lines.push(`| Ack time | ${r.ackMs}ms |`);
    if (r.totalMs !== undefined) lines.push(`| Total execution | ${(r.totalMs / 1000).toFixed(1)}s |`);
    if (r.summaryPreview) lines.push(`| Summary (preview) | ${r.summaryPreview.replace(/\|/g, "\\|").replace(/\n/g, " ")} |`);
    if (r.deliverableLen !== undefined) lines.push(`| Deliverable length | ${r.deliverableLen} chars |`);
    if (r.artifactFiles?.length > 0) lines.push(`| Artifact files | ${r.artifactFiles.join(", ")} |`);
    if (r.reply) lines.push(`| Reply message | ${r.reply.slice(0, 120).replace(/\|/g, "\\|")} |`);
    if (r.errorText) lines.push(`| Error | ${r.errorText.slice(0, 200).replace(/\|/g, "\\|")} |`);
    if (r.detail) lines.push(`| Detail | ${r.detail.replace(/\|/g, "\\|")} |`);
    lines.push(``);
  }

  if (failed > 0) {
    lines.push(`## Failures Analysis`);
    lines.push(``);
    const failures = scenarioResults.filter((r) => r.status === "FAIL");
    for (const r of failures) {
      lines.push(`### ❌ Test ${r.id}: ${r.name}`);
      lines.push(``);
      lines.push(`- **Input**: \`${r.input}\``);
      lines.push(`- **Expected role**: ${Array.isArray(r.expectRole) ? r.expectRole.join("|") : (r.expectRole ?? "—")}`);
      lines.push(`- **Got role**: ${r.actualRole ?? "—"}`);
      lines.push(`- **Got type**: ${r.actualType ?? "—"}`);
      lines.push(`- **Failure category**: ${r.failureCategory ?? "unknown"}`);
      if (r.errorText) lines.push(`- **Error**: ${r.errorText.slice(0, 300)}`);
      lines.push(``);
      lines.push(
        `**Root cause analysis**: ${rootCauseHints[r.failureCategory] ?? "需结合 task/tool-run/audit 日志进一步定位。"}`
      );
      lines.push(``);
    }
  }

  return lines.join("\n");
}

// ─── Main ──────────────────────────────────────────────────────────────────
async function main() {
  console.log(bold(`\n🧪 VinkoClaw Persona Test`));
  console.log(dim(`   Run ID: ${RUN_ID}`));
  console.log(dim(`   Orchestrator: ${ORCH_BASE}`));
  console.log(dim(`   Scenarios: ${SCENARIOS.length}`));
  console.log(dim(`   Task timeout: ${TASK_TIMEOUT_MS / 1000}s per task`));
  console.log(dim(`   Max wall clock: ${MAX_WALL_CLOCK_MS / 1000}s`));

  // Pre-flight health check
  try {
    const health = await getJson("/health");
    if (!health?.ok) throw new Error("health.ok is not true");
    console.log(green("\n✓ Orchestrator healthy"));
  } catch (err) {
    console.error(red(`\n✗ Orchestrator not reachable at ${ORCH_BASE}: ${err.message}`));
    console.error(red("  Start it with: npm run dev"));
    process.exit(1);
  }

  const scenarioResults = [];
  const globalStart = Date.now();
  const globalDeadlineMs = globalStart + MAX_WALL_CLOCK_MS;

  // Run sequentially to avoid overwhelming the runner
  for (const scenario of SCENARIOS) {
    if (Date.now() >= globalDeadlineMs) {
      const detail = "persona run exceeded global wall-clock budget and was stopped";
      fail(scenario, detail);
      scenarioResults.push({
        ...scenario,
        status: "FAIL",
        detail,
        failureCategory: "global_wall_clock_timeout"
      });
      break;
    }
    const result = await runScenario(scenario, { wallClockDeadlineMs: globalDeadlineMs });
    scenarioResults.push(result);
    // Brief pause between scenarios to let the system settle
    await sleep(500);
  }

  const totalMs = Date.now() - globalStart;

  // Summary
  const passed = scenarioResults.filter((r) => r.status === "PASS").length;
  const failed = scenarioResults.filter((r) => r.status === "FAIL").length;

  console.log(`\n${"─".repeat(60)}`);
  console.log(bold(`Results: ${green(`${passed} passed`)}, ${failed > 0 ? red(`${failed} failed`) : dim("0 failed")} / ${SCENARIOS.length} total`));
  console.log(dim(`Total wall time: ${(totalMs / 1000).toFixed(1)}s`));

  if (failed > 0) {
    console.log(red(`\nFailed tests:`));
    for (const r of scenarioResults.filter((r) => r.status === "FAIL")) {
      console.log(red(`  [${r.id}] ${r.name}: ${r.detail ?? r.errorText ?? "—"}`));
    }
  }

  // Write report
  mkdirSync(REPORT_DIR, { recursive: true });
  const reportTs = new Date().toISOString().replace(/:/g, "-").slice(0, 19);
  const reportPath = join(REPORT_DIR, `${reportTs}-persona-test.md`);
  const report = buildReport(scenarioResults, totalMs);
  writeFileSync(reportPath, report, "utf8");
  console.log(`\n${dim(`Report written to: ${reportPath}`)}`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(red(`\nUnexpected error: ${err.message}`));
  console.error(err.stack);
  process.exit(1);
});

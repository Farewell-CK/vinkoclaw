#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildHarnessReportRecord,
  deriveHarnessGrade,
  getHarnessSuiteCommandString,
  getHarnessSuiteDefinition,
  summarizeHarnessQueueDepth
} from "@vinko/shared";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ORCH_BASE = process.env.ORCH_BASE_URL ?? "http://127.0.0.1:8098";
const intervalMinutesRaw = Number(process.env.PRODUCT_SELFCHECK_INTERVAL_MINUTES ?? "20");
const intervalMinutes = Number.isFinite(intervalMinutesRaw) ? Math.max(1, Math.round(intervalMinutesRaw)) : 20;
const intervalMs = intervalMinutes * 60 * 1000;
const once = process.argv.includes("--once");

const reportDir = path.join(ROOT, ".run", "product-selfcheck");
const historyFile = path.join(reportDir, "history.jsonl");
const latestFile = path.join(reportDir, "latest.json");
const harnessProductDir = path.join(ROOT, ".run", "harness", "product");
const harnessProductHistoryFile = path.join(harnessProductDir, "history.jsonl");
const harnessProductLatestFile = path.join(harnessProductDir, "latest.json");
const productHarnessSuite = getHarnessSuiteDefinition("product");
mkdirSync(reportDir, { recursive: true });
mkdirSync(harnessProductDir, { recursive: true });

function log(message) {
  process.stdout.write(`[product-selfcheck-watch] ${message}\n`);
}

function parseHarnessMetas(output) {
  return String(output ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("HARNESS_META "))
    .map((line) => {
      try {
        return JSON.parse(line.slice("HARNESS_META ".length));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function fetchJson(pathname) {
  const response = await fetch(`${ORCH_BASE}${pathname}`);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${pathname}: ${text}`);
  }
  return JSON.parse(text);
}

function runProductSelfcheck() {
  return new Promise((resolve) => {
    const startedAtMs = Date.now();
    const child = spawn("npm", ["run", "self-check:product"], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";

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
    child.on("close", (code) => {
      resolve({
        ok: code === 0,
        code: code ?? -1,
        durationMs: Date.now() - startedAtMs,
        stdout,
        stderr
      });
    });
  });
}

async function runOnce() {
  const timestamp = new Date().toISOString();
  const result = await runProductSelfcheck();
  let health = null;
  let metrics = null;
  let observeError = null;

  try {
    health = await fetchJson("/health");
    metrics = await fetchJson("/api/system/metrics");
  } catch (error) {
    observeError = error instanceof Error ? error.message : String(error);
  }

  const record = {
    timestamp,
    ok: result.ok,
    exitCode: result.code,
    durationMs: result.durationMs,
    healthOk: health?.ok === true,
    queueDepth: metrics?.queueDepth ?? null,
    observeError
  };

  appendFileSync(historyFile, `${JSON.stringify(record)}\n`, "utf8");
  writeFileSync(
    latestFile,
    JSON.stringify(
      {
        ...record,
        lastStdout: result.stdout.slice(-4000),
        lastStderr: result.stderr.slice(-4000)
      },
      null,
      2
    ),
    "utf8"
  );

  const metas = parseHarnessMetas(`${result.stdout}\n${result.stderr}`);
  const finalMeta = metas.length > 0 ? metas[metas.length - 1] : null;
  const completedChecks = metas.filter((entry) => entry.ok === null && entry.regressionCategory === "in_progress").map((entry) => entry.check).filter(Boolean);
  const uniqueChecks = Array.from(new Set(completedChecks));
  const harnessRecord = buildHarnessReportRecord({
    suite: "product",
    ok: result.ok,
    exitCode: result.code,
    timedOut: false,
    budgetMs: productHarnessSuite?.budgetMs,
    startedAt: timestamp,
    finishedAt: new Date().toISOString(),
    durationMs: result.durationMs,
    command: getHarnessSuiteCommandString(productHarnessSuite),
    orchBase: ORCH_BASE,
    healthOk: health?.ok === true,
    projectBoardSummary: null,
    regressionCategory: finalMeta?.regressionCategory ?? (result.ok ? "none" : "unknown"),
    failedStage: typeof finalMeta?.check === "string" ? finalMeta.check : undefined,
    detail: typeof finalMeta?.detail === "string" ? finalMeta.detail : observeError,
    completedStages: result.ok ? uniqueChecks : undefined,
    stageSummary: Object.fromEntries(
      metas
        .filter((entry) => typeof entry?.check === "string")
        .map((entry) => [
          entry.check,
          {
            regressionCategory: typeof entry.regressionCategory === "string" ? entry.regressionCategory : undefined,
            deliverableContractViolated: entry.deliverableContractViolated === true
          }
        ])
    ),
    stateCompleteness: undefined,
    observeError,
    stdoutTail: result.stdout.slice(-8000),
    stderrTail: result.stderr.slice(-8000),
    failedInvariant: result.ok ? undefined : finalMeta?.check ? `${finalMeta.check}_stage_passed` : "suite_passed",
    traceSummary: result.ok ? `${uniqueChecks.length}/${uniqueChecks.length} stages completed` : undefined,
    handoffCoverage: result.ok ? 1 : 0,
    approvalCoverage: metas.some((entry) => String(entry?.check ?? "").includes("approval")) ? 1 : 0,
    resumeCoverage: metas.some((entry) => String(entry?.check ?? "").includes("routing")) ? 1 : 0,
    queueDepth: summarizeHarnessQueueDepth(metrics?.queueDepth ?? null)
  });
  harnessRecord.grade = deriveHarnessGrade(harnessRecord);

  appendFileSync(harnessProductHistoryFile, `${JSON.stringify(harnessRecord)}\n`, "utf8");
  writeFileSync(harnessProductLatestFile, `${JSON.stringify(harnessRecord, null, 2)}\n`, "utf8");

  if (result.ok) {
    log(`PASS duration=${result.durationMs}ms`);
  } else {
    log(`FAIL exit=${result.code} duration=${result.durationMs}ms`);
  }

  return result.ok;
}

async function main() {
  if (once) {
    const ok = await runOnce();
    process.exitCode = ok ? 0 : 1;
    return;
  }

  log(`watch mode started, interval=${intervalMinutes}m, reportDir=${reportDir}`);
  while (true) {
    await runOnce();
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

main().catch((error) => {
  log(`fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

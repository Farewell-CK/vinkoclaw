#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = "/home/xsuper/workspace/vinkoclaw";
const ORCH_BASE = process.env.ORCH_BASE_URL ?? "http://127.0.0.1:8098";
const intervalMinutesRaw = Number(process.env.PRODUCT_SELFCHECK_INTERVAL_MINUTES ?? "20");
const intervalMinutes = Number.isFinite(intervalMinutesRaw) ? Math.max(1, Math.round(intervalMinutesRaw)) : 20;
const intervalMs = intervalMinutes * 60 * 1000;
const once = process.argv.includes("--once");

const reportDir = path.join(ROOT, ".run", "product-selfcheck");
const historyFile = path.join(reportDir, "history.jsonl");
const latestFile = path.join(reportDir, "latest.json");
mkdirSync(reportDir, { recursive: true });

function log(message) {
  process.stdout.write(`[product-selfcheck-watch] ${message}\n`);
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

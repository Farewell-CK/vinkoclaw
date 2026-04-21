#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, openSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reportDir = path.join(ROOT, ".run", "product-selfcheck");
const pidFile = path.join(reportDir, "watch.pid");
const logFile = path.join(reportDir, "watch.log");
const watcherScript = path.join(ROOT, "scripts", "product-selfcheck-watch.mjs");
const action = (process.argv[2] ?? "status").trim().toLowerCase();

mkdirSync(reportDir, { recursive: true });

function log(message) {
  process.stdout.write(`[product-selfcheck-daemon] ${message}\n`);
}

function isProcessRunning(pid) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPidMetadata() {
  if (!existsSync(pidFile)) {
    return null;
  }
  try {
    const raw = readFileSync(pidFile, "utf8");
    const parsed = JSON.parse(raw);
    const pid = Number(parsed?.pid);
    if (!Number.isFinite(pid) || pid <= 0) {
      return null;
    }
    return {
      pid,
      startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : ""
    };
  } catch {
    return null;
  }
}

function clearStalePidFile() {
  if (existsSync(pidFile)) {
    rmSync(pidFile);
  }
}

function start() {
  const existing = readPidMetadata();
  if (existing && isProcessRunning(existing.pid)) {
    log(`already running pid=${existing.pid}`);
    return;
  }
  if (existing && !isProcessRunning(existing.pid)) {
    clearStalePidFile();
  }

  const outFd = openSync(logFile, "a");
  const errFd = openSync(logFile, "a");
  const child = spawn(process.execPath, [watcherScript], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", outFd, errFd],
    env: process.env
  });
  child.unref();

  writeFileSync(
    pidFile,
    JSON.stringify(
      {
        pid: child.pid,
        startedAt: new Date().toISOString()
      },
      null,
      2
    ),
    "utf8"
  );
  log(`started pid=${child.pid} log=${logFile}`);
}

async function stop() {
  const existing = readPidMetadata();
  if (!existing) {
    log("not running (no pid file)");
    return;
  }
  if (!isProcessRunning(existing.pid)) {
    clearStalePidFile();
    log(`not running (stale pid=${existing.pid} removed)`);
    return;
  }

  try {
    process.kill(existing.pid, "SIGTERM");
  } catch (error) {
    log(`stop failed pid=${existing.pid}: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }

  const timeoutAt = Date.now() + 5000;
  while (Date.now() < timeoutAt) {
    if (!isProcessRunning(existing.pid)) {
      clearStalePidFile();
      log(`stopped pid=${existing.pid}`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  log(`stop timeout pid=${existing.pid}`);
  process.exitCode = 1;
}

function status() {
  const existing = readPidMetadata();
  if (!existing) {
    log("status stopped");
    return;
  }
  const running = isProcessRunning(existing.pid);
  log(`status ${running ? "running" : "stopped"} pid=${existing.pid} startedAt=${existing.startedAt || "unknown"}`);
  if (!running) {
    clearStalePidFile();
    log("removed stale pid file");
  }
}

async function main() {
  if (action === "start") {
    start();
    return;
  }
  if (action === "stop") {
    await stop();
    return;
  }
  if (action === "restart") {
    await stop();
    start();
    return;
  }
  if (action === "status") {
    status();
    return;
  }

  log(`unknown action: ${action}`);
  log("usage: node scripts/product-selfcheck-daemon.mjs <start|stop|restart|status>");
  process.exitCode = 1;
}

main().catch((error) => {
  log(`fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

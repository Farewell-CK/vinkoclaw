#!/usr/bin/env node
import { spawn } from "node:child_process";

function parsePositiveInt(rawValue, fallback) {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  return Math.max(1, Math.floor(parsed));
}

const modeArg = process.argv[2]?.trim().toLowerCase() === "start" ? "start" : "dev";
const defaultInstances = 1;
const instances = parsePositiveInt(process.env.TASK_RUNNER_INSTANCES, defaultInstances);
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const npmArgs = ["run", modeArg, "-w", "@vinko/task-runner"];

let shuttingDown = false;

function shutdown(signal = "SIGTERM") {
  if (shuttingDown) return;
  shuttingDown = true;
  process.exit(0);
}

function spawnInstance(instanceId, restartCount = 0) {
  if (shuttingDown) return;

  const child = spawn(npmCommand, npmArgs, {
    stdio: "inherit",
    env: { ...process.env, RUNNER_INSTANCE_ID: String(instanceId) }
  });

  child.on("exit", (code, signal) => {
    if (shuttingDown) return;

    const isExpected = code === 0 || signal === "SIGTERM" || signal === "SIGINT";
    if (isExpected) {
      process.exit(0);
    }

    // Unexpected exit — restart with exponential backoff (max 30s)
    const delay = Math.min(1000 * Math.pow(2, restartCount), 30_000);
    console.error(
      `[task-runner-multi] instance ${instanceId} exited (code=${code ?? "null"}, signal=${signal ?? "null"}), restarting in ${delay}ms (attempt ${restartCount + 1})`
    );
    setTimeout(() => spawnInstance(instanceId, restartCount + 1), delay);
  });
}

for (let index = 0; index < instances; index += 1) {
  spawnInstance(index + 1);
}

console.log(`[task-runner-multi] mode=${modeArg} instances=${instances} (auto-restart enabled)`);

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function runResetRuntimeDrain(input = {}) {
  const args = [
    "./scripts/reset-runtime-state.mjs",
    "drain",
    "--max-busy-tasks",
    String(Number.isFinite(input.maxBusyTasks) ? Math.max(0, Math.round(input.maxBusyTasks)) : 0),
    "--timeout-ms",
    String(Number.isFinite(input.timeoutMs) ? Math.max(1_000, Math.round(input.timeoutMs)) : 120_000),
    "--reason",
    typeof input.reason === "string" && input.reason.trim() ? input.reason.trim() : `harness-preflight-${Date.now()}`
  ];

  if (input.killCheckProcesses !== false) {
    args.splice(2, 0, "--kill-check-processes");
  }

  return await new Promise((resolve, reject) => {
    const child = spawn("node", args, {
      cwd: ROOT,
      stdio: ["ignore", "inherit", "inherit"],
      env: {
        ...process.env,
        ...(typeof input.orchBase === "string" && input.orchBase.trim() ? { ORCH_BASE_URL: input.orchBase.trim() } : {})
      }
    });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? -1));
  });
}

function appendTail(current, chunk, limit = 4000) {
  const next = `${current}${chunk}`;
  return next.length <= limit ? next : next.slice(-limit);
}

function terminateChildTree(child, signal) {
  if (!child) {
    return;
  }
  if (process.platform !== "win32" && typeof child.pid === "number" && child.pid > 0) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall through to direct child kill below.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Ignore kill failures.
  }
}

export async function startHarnessTaskRunner(input = {}) {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const label = typeof input.label === "string" && input.label.trim() ? input.label.trim() : "harness";
  const readyTimeoutMs =
    Number.isFinite(input.readyTimeoutMs) && input.readyTimeoutMs > 0 ? Math.max(1000, Math.round(input.readyTimeoutMs)) : 15_000;
  const env = {
    ...process.env,
    RUNNER_INSTANCE_ID:
      typeof input.instanceId === "string" && input.instanceId.trim()
        ? input.instanceId.trim()
        : `harness-${label}-${Date.now()}`
  };

  let stdoutTail = "";
  let stderrTail = "";
  let stopPromise;

  const child = spawn(npmCommand, ["run", "start", "-w", "@vinko/task-runner"], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32"
  });

  const cleanupOnExit = () => {
    terminateChildTree(child, "SIGTERM");
  };
  process.once("exit", cleanupOnExit);

  const ready = await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      finish(
        reject,
        new Error(
          `task runner did not become ready within ${readyTimeoutMs}ms (stdoutTail=${JSON.stringify(stdoutTail)}, stderrTail=${JSON.stringify(stderrTail)})`
        )
      );
    }, readyTimeoutMs);
    if (typeof timer.unref === "function") {
      timer.unref();
    }

    const onChunk = (text) => {
      if (/"scope":"task-runner"/.test(text) && /"message":"task runner started"/.test(text)) {
        finish(resolve, {
          pid: child.pid ?? -1
        });
      }
    };

    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      stdoutTail = appendTail(stdoutTail, text);
      process.stdout.write(text);
      onChunk(text);
    });

    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      stderrTail = appendTail(stderrTail, text);
      process.stderr.write(text);
    });

    child.once("error", (error) => {
      finish(reject, error);
    });

    child.once("close", (code, signal) => {
      finish(
        reject,
        new Error(
          `task runner exited before ready (code=${code ?? "null"}, signal=${signal ?? "null"}, stdoutTail=${JSON.stringify(stdoutTail)}, stderrTail=${JSON.stringify(stderrTail)})`
        )
      );
    });
  });

  async function stop(signal = "SIGTERM") {
    if (stopPromise) {
      return stopPromise;
    }
    stopPromise = new Promise((resolve) => {
      process.removeListener("exit", cleanupOnExit);
      if (child.exitCode !== null) {
        resolve();
        return;
      }

      let closed = false;
      const finalize = () => {
        if (closed) {
          return;
        }
        closed = true;
        resolve();
      };

      child.once("close", () => finalize());
      terminateChildTree(child, signal);

      const timer = setTimeout(() => {
        terminateChildTree(child, "SIGKILL");
        finalize();
      }, 10_000);
      if (typeof timer.unref === "function") {
        timer.unref();
      }
    });
    return stopPromise;
  }

  return {
    ...ready,
    stop,
    getOutputTail() {
      return {
        stdoutTail,
        stderrTail
      };
    }
  };
}

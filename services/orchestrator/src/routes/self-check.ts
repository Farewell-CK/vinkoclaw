import express from "express";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import {
  listHarnessGrades,
  listHarnessSuiteSnapshots,
  normalizeHarnessSuiteName,
  parseHarnessHistoryFile,
  readHarnessSuiteLatest
} from "@vinko/shared";

type SelfCheckFs = {
  existsSync: (path: string) => boolean;
  readFileSync: (path: string, encoding: "utf8") => string;
  readdirSync: (path: string) => Array<{ name: string; isDirectory: () => boolean }>;
};

export interface SelfCheckRoutesDeps {
  latestFile: string;
  historyFile: string;
  harnessRootDir?: string | undefined;
  watcherPidFile?: string | undefined;
  isProcessRunning?: (pid: number) => boolean;
  fs?: SelfCheckFs;
}

export function registerSelfCheckRoutes(app: express.Express, deps: SelfCheckRoutesDeps): void {
  const isProcessRunning =
    deps.isProcessRunning ??
    ((pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
  const fs: SelfCheckFs = deps.fs ?? {
    existsSync,
    readFileSync: (filePath, encoding) => readFileSync(filePath, encoding),
    readdirSync: (filePath) => readdirSync(filePath, { withFileTypes: true })
  };

  app.get("/api/system/self-check/latest", (_request, response) => {
    if (!fs.existsSync(deps.latestFile)) {
      response.status(404).json({ error: "self_check_latest_not_found" });
      return;
    }
    try {
      const raw = fs.readFileSync(deps.latestFile, "utf8");
      response.json(JSON.parse(raw));
    } catch (error) {
      response.status(500).json({
        error: "self_check_latest_read_failed",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  });

  app.get("/api/system/self-check/history", (request, response) => {
    if (!fs.existsSync(deps.historyFile)) {
      response.status(404).json({ error: "self_check_history_not_found" });
      return;
    }
    const limitRaw = Number(request.query.limit);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, Math.round(limitRaw))) : 50;
    try {
      response.json(parseHarnessHistoryFile(deps.historyFile, limit, fs));
    } catch (error) {
      response.status(500).json({
        error: "self_check_history_read_failed",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  });

  app.get("/api/system/harness", (_request, response) => {
    if (!deps.harnessRootDir) {
      response.json({
        configured: false,
        suites: []
      });
      return;
    }
    if (!fs.existsSync(deps.harnessRootDir)) {
      response.json({
        configured: true,
        suites: []
      });
      return;
    }
    try {
      response.json({
        configured: true,
        suites: listHarnessSuiteSnapshots(deps.harnessRootDir, fs)
      });
    } catch (error) {
      response.status(500).json({
        error: "harness_list_failed",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  });

  app.get("/api/system/harness/:suite/latest", (request, response) => {
    const suite = normalizeHarnessSuiteName(request.params.suite);
    if (!suite || !deps.harnessRootDir) {
      response.status(404).json({ error: "harness_suite_not_found" });
      return;
    }
    const latestFile = `${deps.harnessRootDir}/${suite}/latest.json`;
    if (!fs.existsSync(latestFile)) {
      response.status(404).json({ error: "harness_latest_not_found" });
      return;
    }
    try {
      response.json(readHarnessSuiteLatest(deps.harnessRootDir, suite, fs));
    } catch (error) {
      response.status(500).json({
        error: "harness_latest_read_failed",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  });

  app.get("/api/system/harness/:suite/history", (request, response) => {
    const suite = normalizeHarnessSuiteName(request.params.suite);
    if (!suite || !deps.harnessRootDir) {
      response.status(404).json({ error: "harness_suite_not_found" });
      return;
    }
    const historyFile = `${deps.harnessRootDir}/${suite}/history.jsonl`;
    if (!fs.existsSync(historyFile)) {
      response.status(404).json({ error: "harness_history_not_found" });
      return;
    }
    const limitRaw = Number(request.query.limit);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, Math.round(limitRaw))) : 50;
    try {
      response.json(parseHarnessHistoryFile(historyFile, limit, fs));
    } catch (error) {
      response.status(500).json({
        error: "harness_history_read_failed",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  });

  app.get("/api/system/harness/grades", (_request, response) => {
    if (!deps.harnessRootDir || !fs.existsSync(deps.harnessRootDir)) {
      response.json({
        configured: Boolean(deps.harnessRootDir),
        grades: []
      });
      return;
    }
    try {
      response.json({
        configured: true,
        grades: listHarnessGrades(deps.harnessRootDir, fs)
      });
    } catch (error) {
      response.status(500).json({
        error: "harness_grades_failed",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  });

  app.get("/api/system/self-check/watcher", (_request, response) => {
    if (!deps.watcherPidFile) {
      response.json({
        configured: false,
        running: false
      });
      return;
    }
    if (!fs.existsSync(deps.watcherPidFile)) {
      response.json({
        configured: true,
        running: false
      });
      return;
    }
    try {
      const raw = fs.readFileSync(deps.watcherPidFile, "utf8").trim();
      const parsed = JSON.parse(raw) as {
        pid?: unknown;
        startedAt?: unknown;
      };
      const pid = Number(parsed.pid);
      if (!Number.isFinite(pid) || pid <= 0) {
        response.status(500).json({
          configured: true,
          running: false,
          error: "watcher_pid_file_invalid"
        });
        return;
      }
      response.json({
        configured: true,
        running: isProcessRunning(pid),
        pid,
        startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : undefined
      });
    } catch (error) {
      response.status(500).json({
        configured: true,
        running: false,
        error: "watcher_pid_read_failed",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  });
}

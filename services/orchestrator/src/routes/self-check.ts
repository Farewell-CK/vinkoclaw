import express from "express";
import { existsSync, readFileSync } from "node:fs";

type SelfCheckFs = {
  existsSync: (path: string) => boolean;
  readFileSync: (path: string, encoding: "utf8") => string;
};

export interface SelfCheckRoutesDeps {
  latestFile: string;
  historyFile: string;
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
    readFileSync: (filePath, encoding) => readFileSync(filePath, encoding)
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
      const raw = fs.readFileSync(deps.historyFile, "utf8");
      const rows = raw
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(-limit)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return { parseError: true, raw: line };
          }
        });
      response.json({
        count: rows.length,
        rows
      });
    } catch (error) {
      response.status(500).json({
        error: "self_check_history_read_failed",
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

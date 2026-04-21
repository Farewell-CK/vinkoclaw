import express from "express";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerSelfCheckRoutes } from "./self-check.js";

async function withServer(app: express.Express, fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("listening", () => resolve());
      server.once("error", reject);
    });
    const address = server.address() as AddressInfo | null;
    if (!address) {
      throw new Error("server_address_unavailable");
    }
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("self-check routes", () => {
  it("returns 404 when latest report does not exist", async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "vinko-selfcheck-"));
    const latestFile = path.join(tempDir, "latest.json");
    const historyFile = path.join(tempDir, "history.jsonl");
    const app = express();
    registerSelfCheckRoutes(app, { latestFile, historyFile });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/system/self-check/latest`);
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({
        error: "self_check_latest_not_found"
      });
    });
  });

  it("returns latest self-check payload", async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "vinko-selfcheck-"));
    const latestFile = path.join(tempDir, "latest.json");
    const historyFile = path.join(tempDir, "history.jsonl");
    writeFileSync(
      latestFile,
      JSON.stringify({
        timestamp: "2026-04-07T01:23:45.000Z",
        ok: true,
        queueDepth: 0
      }),
      "utf8"
    );
    const app = express();
    registerSelfCheckRoutes(app, { latestFile, historyFile });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/system/self-check/latest`);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        timestamp: "2026-04-07T01:23:45.000Z",
        ok: true,
        queueDepth: 0
      });
    });
  });

  it("returns parsed history rows with line-level parse fallback", async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "vinko-selfcheck-"));
    const latestFile = path.join(tempDir, "latest.json");
    const historyFile = path.join(tempDir, "history.jsonl");
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(
      historyFile,
      [
        JSON.stringify({ id: 1, ok: true }),
        "this-is-not-json",
        JSON.stringify({ id: 2, ok: false })
      ].join("\n"),
      "utf8"
    );
    const app = express();
    registerSelfCheckRoutes(app, { latestFile, historyFile });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/system/self-check/history?limit=2`);
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        count: number;
        rows: Array<Record<string, unknown>>;
      };
      expect(payload.count).toBe(2);
      expect(payload.rows[0]?.parseError).toBe(true);
      expect(payload.rows[1]).toMatchObject({ id: 2, ok: false });
    });
  });

  it("returns watcher status from pid file", async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "vinko-selfcheck-"));
    const latestFile = path.join(tempDir, "latest.json");
    const historyFile = path.join(tempDir, "history.jsonl");
    const watcherPidFile = path.join(tempDir, "watch.pid");
    writeFileSync(
      watcherPidFile,
      JSON.stringify({
        pid: 12345,
        startedAt: "2026-04-07T02:00:00.000Z"
      }),
      "utf8"
    );
    const app = express();
    registerSelfCheckRoutes(app, {
      latestFile,
      historyFile,
      watcherPidFile,
      isProcessRunning: (pid) => pid === 12345
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/system/self-check/watcher`);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        configured: true,
        running: true,
        pid: 12345,
        startedAt: "2026-04-07T02:00:00.000Z"
      });
    });
  });

  it("lists harness suites and returns latest payload", async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "vinko-harness-"));
    const latestFile = path.join(tempDir, "latest.json");
    const historyFile = path.join(tempDir, "history.jsonl");
    const harnessRootDir = path.join(tempDir, "harness");
    const founderDir = path.join(harnessRootDir, "founder-delivery");
    mkdirSync(founderDir, { recursive: true });
    writeFileSync(
      path.join(founderDir, "latest.json"),
      JSON.stringify({
        suite: "founder-delivery",
        ok: true,
        durationMs: 1234
      }),
      "utf8"
    );
    writeFileSync(
      path.join(founderDir, "history.jsonl"),
      [JSON.stringify({ suite: "founder-delivery", ok: false }), JSON.stringify({ suite: "founder-delivery", ok: true })].join("\n"),
      "utf8"
    );

    const app = express();
    registerSelfCheckRoutes(app, { latestFile, historyFile, harnessRootDir });

    await withServer(app, async (baseUrl) => {
      const listResponse = await fetch(`${baseUrl}/api/system/harness`);
      expect(listResponse.status).toBe(200);
      await expect(listResponse.json()).resolves.toEqual({
        configured: true,
        suites: [
          {
            suite: "founder-delivery",
            latest: {
              suite: "founder-delivery",
              ok: true,
              durationMs: 1234
            }
          }
        ]
      });

      const latestResponse = await fetch(`${baseUrl}/api/system/harness/founder-delivery/latest`);
      expect(latestResponse.status).toBe(200);
      await expect(latestResponse.json()).resolves.toEqual({
        suite: "founder-delivery",
        ok: true,
        durationMs: 1234
      });

      const historyResponse = await fetch(`${baseUrl}/api/system/harness/founder-delivery/history?limit=1`);
      expect(historyResponse.status).toBe(200);
      await expect(historyResponse.json()).resolves.toEqual({
        count: 1,
        rows: [{ suite: "founder-delivery", ok: true }]
      });

      const gradesResponse = await fetch(`${baseUrl}/api/system/harness/grades`);
      expect(gradesResponse.status).toBe(200);
      await expect(gradesResponse.json()).resolves.toEqual({
        configured: true,
        grades: [
          {
            suite: "founder-delivery",
            grade: "unknown",
            failedInvariant: undefined,
            traceSummary: undefined,
            handoffCoverage: undefined,
            approvalCoverage: undefined,
            resumeCoverage: undefined,
            stateCompleteness: undefined,
            generatedAt: "1970-01-01T00:00:00.000Z"
          }
        ]
      });
    });
  });

  it("returns harness grades from latest report fields", async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "vinko-harness-"));
    const latestFile = path.join(tempDir, "latest.json");
    const historyFile = path.join(tempDir, "history.jsonl");
    const harnessRootDir = path.join(tempDir, "harness");
    const founderDir = path.join(harnessRootDir, "founder-delivery");
    mkdirSync(founderDir, { recursive: true });
    writeFileSync(
      path.join(founderDir, "latest.json"),
      JSON.stringify({
        suite: "founder-delivery",
        grade: "pass",
        failedInvariant: undefined,
        traceSummary: "4/4 stages completed",
        handoffCoverage: 1,
        approvalCoverage: 0.25,
        resumeCoverage: 0.25,
        stateCompleteness: true,
        finishedAt: "2026-04-07T03:00:00.000Z"
      }),
      "utf8"
    );

    const app = express();
    registerSelfCheckRoutes(app, { latestFile, historyFile, harnessRootDir });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/system/harness/grades`);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        configured: true,
        grades: [
          {
            suite: "founder-delivery",
            grade: "pass",
            failedInvariant: undefined,
            traceSummary: "4/4 stages completed",
            handoffCoverage: 1,
            approvalCoverage: 0.25,
            resumeCoverage: 0.25,
            stateCompleteness: true,
            generatedAt: "2026-04-07T03:00:00.000Z"
          }
        ]
      });
    });
  });
});

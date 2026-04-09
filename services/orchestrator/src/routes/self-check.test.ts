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
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VinkoStore } from "@vinko/shared";
import { notifyEvolutionAppliedChanges } from "./evolution-notifier.js";

const tempDirs: string[] = [];

function createStore(): VinkoStore {
  const dir = mkdtempSync(path.join(tmpdir(), "vinkoclaw-evolution-notifier-"));
  tempDirs.push(dir);
  return new VinkoStore(path.join(dir, "test.sqlite"));
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("notifyEvolutionAppliedChanges", () => {
  it("does nothing when there is no new applied change", async () => {
    const store = createStore();
    const sendCardToChat = vi.fn(async () => undefined);

    await notifyEvolutionAppliedChanges({
      store,
      feishuClient: { sendCardToChat } as never,
      chatId: "oc_1234567890abcdefghijklmn"
    });

    expect(sendCardToChat).not.toHaveBeenCalled();
  });

  it("sends a card when a new applied change appears", async () => {
    const store = createStore();
    store.setConfigEntry("evolution-state", {
      version: 1,
      signals: [],
      proposals: [],
      appliedChanges: [
        {
          id: "evo-change:1",
          proposalId: "proposal-1",
          kind: "router_bias",
          before: {},
          after: {},
          appliedAt: "2026-04-23T00:00:00.000Z"
        }
      ],
      updatedAt: "2026-04-23T00:00:00.000Z"
    });
    const sendCardToChat = vi.fn(async () => undefined);

    await notifyEvolutionAppliedChanges({
      store,
      feishuClient: { sendCardToChat } as never,
      chatId: "oc_1234567890abcdefghijklmn",
      beforeState: {
        version: 1,
        signals: [],
        proposals: [],
        appliedChanges: [],
        updatedAt: "2026-04-22T00:00:00.000Z"
      }
    });

    expect(sendCardToChat).toHaveBeenCalledTimes(1);
    expect(sendCardToChat).toHaveBeenCalledWith(
      "oc_1234567890abcdefghijklmn",
      expect.objectContaining({
        schema: "2.0"
      })
    );
    const firstCall = sendCardToChat.mock.calls[0];
    expect(firstCall).toBeDefined();
    expect(JSON.stringify((firstCall as unknown[])[1] ?? {})).toContain("router_bias");
  });
});

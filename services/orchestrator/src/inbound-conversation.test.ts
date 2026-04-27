import type { RoleId } from "@vinko/shared";
import { describe, expect, it, vi } from "vitest";
import {
  buildConversationReplyWithModel,
  classifyAmbiguousConversationWithModel,
  isDirectConversationTurn
} from "./inbound-conversation.js";

const config = {
  getDefaultParticipants: (): RoleId[] => ["product", "frontend", "qa"],
  formatRoleLabel: (roleId: string) => roleId,
  shouldRouteToGoalRun: () => false,
  hasActionIntent: () => false,
  normalizeConversationCandidate: (text: string) => text.trim(),
  shorten: (text: string) => text
};

describe("inbound-conversation", () => {
  it("detects direct conversation turns", () => {
    expect(isDirectConversationTurn("你是谁？", config)).toBe(true);
    expect(isDirectConversationTurn("介绍一下你们团队", config)).toBe(true);
    expect(isDirectConversationTurn("写一个登录页", config)).toBe(false);
  });

  it("respects evolution thresholds for direct and ambiguous conversation", async () => {
    expect(
      isDirectConversationTurn("你们最近怎么样呀，为什么还是这么慢", {
        ...config,
        evolution: {
          directConversationMaxLength: 12
        }
      })
    ).toBe(false);

    const client = {
      complete: vi.fn(() =>
        Promise.resolve({
          text: "{\"conversation\":true}"
        })
      )
    };

    await expect(
      classifyAmbiguousConversationWithModel(
        "最近怎么样呀",
        {
          ...config,
          evolution: {
            ambiguousConversationMaxLength: 40
          }
        },
        client as never
      )
    ).resolves.toBe(true);
  });

  it("falls back to deterministic reply when model fails", async () => {
    const client = {
      complete: vi.fn(() => Promise.reject(new Error("no model")))
    };

    await expect(buildConversationReplyWithModel("你是谁", config, client as never)).resolves.toContain("VinkoClaw");
  });

  it("classifies ambiguous conversation through model json response", async () => {
    const client = {
      complete: vi.fn(() =>
        Promise.resolve({
          text: "{\"conversation\":true}"
        })
      )
    };

    await expect(classifyAmbiguousConversationWithModel("？？？", config, client as never)).resolves.toBe(true);
  });
});

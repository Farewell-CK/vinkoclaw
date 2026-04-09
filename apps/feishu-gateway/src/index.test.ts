import { describe, expect, it } from "vitest";
import { parseFeishuCardActionPayload, parseFeishuEvent } from "./index.js";

describe("feishu-gateway parser", () => {
  it("parses message events", () => {
    const parsed = parseFeishuEvent({
      header: {
        event_type: "im.message.receive_v1"
      },
      event: {
        sender: {
          sender_id: {
            open_id: "ou_user_1"
          }
        },
        message: {
          message_id: "om_message_1",
          chat_id: "oc_chat_1",
          message_type: "text",
          content: JSON.stringify({ text: "hello" })
        }
      }
    });

    expect(parsed.kind).toBe("message");
    if (parsed.kind !== "message") {
      return;
    }
    expect(parsed.message.chatId).toBe("oc_chat_1");
    expect(parsed.message.senderId).toBe("ou_user_1");
    expect(parsed.message.text).toBe("hello");
  });

  it("parses card action events", () => {
    const parsed = parseFeishuEvent({
      header: {
        event_type: "card.action.trigger"
      },
      event: {
        token: "token-1",
        operator: {
          open_id: "ou_operator_1",
          user_id: "u_operator_1"
        },
        context: {
          chat_id: "oc_chat_1",
          open_id: "ou_operator_1"
        },
        action: {
          tag: "button",
          value: {
            kind: "approval_decision",
            approvalId: "approval-1"
          }
        }
      }
    });
    expect(parsed.kind).toBe("card_action");
    if (parsed.kind !== "card_action") {
      return;
    }
    expect(parsed.cardAction.operatorOpenId).toBe("ou_operator_1");
    expect(parsed.cardAction.actionTag).toBe("button");
    expect(parsed.cardAction.actionValue.approvalId).toBe("approval-1");
  });

  it("ignores malformed card action", () => {
    const parsed = parseFeishuEvent({
      header: {
        event_type: "card.action.trigger"
      },
      event: {
        token: "token-1",
        operator: {
          open_id: "ou_operator_1"
        },
        context: {
          chat_id: "oc_chat_1"
        },
        action: {
          tag: "button",
          value: "not-an-object"
        }
      }
    });
    expect(parsed.kind).toBe("ignored");
  });

  it("parses raw card action payload helper", () => {
    const parsed = parseFeishuCardActionPayload({
      token: "token-2",
      operator: {
        open_id: "ou_operator_2"
      },
      context: {
        chat_id: "oc_chat_2"
      },
      action: {
        tag: "button",
        value: {
          decision: "approved"
        }
      }
    });
    expect(parsed?.token).toBe("token-2");
    expect(parsed?.contextChatId).toBe("oc_chat_2");
    expect(parsed?.actionValue.decision).toBe("approved");
  });
});

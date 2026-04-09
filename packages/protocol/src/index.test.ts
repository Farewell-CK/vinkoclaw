import { describe, expect, it } from "vitest";
import {
  orchestratorApprovalEscalationSchema,
  orchestratorTaskSplitSchema,
  validateProtocolEnvelope,
  validateProtocolPayload
} from "./index.js";

describe("@vinko/protocol", () => {
  it("validates orchestrator inbound message payload", () => {
    const parsed = validateProtocolPayload("orchestrator.message.inbound", {
      text: "你好",
      source: "feishu",
      chatId: "oc_xxx",
      attachments: [
        {
          kind: "image",
          url: "https://example.com/a.png",
          detail: "low"
        }
      ]
    });
    expect(parsed.text).toBe("你好");
    expect(parsed.attachments?.length).toBe(1);
  });

  it("rejects empty decision.decidedBy", () => {
    expect(() =>
      validateProtocolPayload("orchestrator.approval.decide", {
        status: "approved",
        decidedBy: "   "
      })
    ).toThrow();
  });

  it("validates envelope and payload together", () => {
    const parsed = validateProtocolEnvelope({
      method: "orchestrator.task.create",
      payload: {
        instruction: "实现一个健康检查",
        source: "control-center",
        priority: 80
      }
    });
    expect(parsed.method).toBe("orchestrator.task.create");
  });

  it("validates task split schema", () => {
    const parsed = orchestratorTaskSplitSchema.parse({
      strategy: "manual",
      tasks: [
        {
          roleId: "backend",
          title: "后端实现",
          instruction: "实现 API",
          priority: 80
        }
      ]
    });
    expect(parsed.tasks?.[0]?.roleId).toBe("backend");
  });

  it("validates approval escalation schema", () => {
    const parsed = orchestratorApprovalEscalationSchema.parse({
      roleId: "ceo",
      requestedBy: "operator"
    });
    expect(parsed.roleId).toBe("ceo");
  });
});

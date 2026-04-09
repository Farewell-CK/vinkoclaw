import { describe, expect, it } from "vitest";
import { createRuntimeValueResolver, type RuntimeValueResolverInput } from "./runtime-config.js";

function createInput(overrides: Partial<RuntimeValueResolverInput> = {}): RuntimeValueResolverInput {
  return {
    env: {
      nodeEnv: "test",
      host: "0.0.0.0",
      port: 8098,
      publicUrl: "http://127.0.0.1:8098",
      dataDir: "/tmp/vinko-test",
      workspaceRoot: "/tmp",
      primaryBackend: "sglang",
      primaryModel: "m",
      sglangBaseUrl: "http://127.0.0.1:8000/v1",
      sglangModel: "m",
      ollamaBaseUrl: "http://127.0.0.1:11434/v1",
      ollamaModel: "m",
      zhipuBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
      zhipuModel: "glm-5",
      feishuAppId: "env-app-id",
      feishuAppSecret: "env-app-secret",
      feishuDomain: "feishu",
      feishuConnectionMode: "websocket",
      feishuEncryptKey: "",
      feishuVerificationToken: "",
      feishuDefaultChatId: "",
      feishuOwnerOpenIds: [],
      smtpUrl: "",
      emailDefaultFrom: "",
      emailInboundEnabled: false,
      emailInboundImapHost: "",
      emailInboundImapPort: 993,
      emailInboundImapSecure: true,
      emailInboundUsername: "",
      emailInboundPassword: "",
      emailInboundMailbox: "INBOX",
      emailInboundAllowedSenders: [],
      emailInboundSubjectPrefix: "",
      emailInboundPollIntervalMs: 15000,
      emailInboundRateLimitPerMinute: 20,
      useClashProxy: false,
      clashOnCommand: "clashon",
      clashOffCommand: "clashoff",
      condaEnvName: "vinkoclaw",
      opencodeModel: "zhipuai/glm-5",
      opencodeBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
      opencodeApiKey: "",
      zhipuApiKey: "",
      openaiApiKey: "",
      anthropicApiKey: "",
      searchProvider: "",
      tavilyApiKey: "",
      serpApiKey: ""
    },
    ...overrides
  };
}

describe("runtime-config resolver", () => {
  it("prefers runtime settings over env and process env", () => {
    const resolver = createRuntimeValueResolver(
      createInput({
        getRuntimeSettings: () => ({ FEISHU_APP_ID: "runtime-id" }),
        processEnv: { FEISHU_APP_ID: "process-id" }
      })
    );
    expect(resolver.get("FEISHU_APP_ID")).toBe("runtime-id");
  });

  it("falls back to loaded env when runtime settings are empty", () => {
    const resolver = createRuntimeValueResolver(createInput());
    expect(resolver.get("FEISHU_APP_ID")).toBe("env-app-id");
  });

  it("parses boolean and list values", () => {
    const resolver = createRuntimeValueResolver(
      createInput({
        getRuntimeSettings: () => ({
          EMAIL_INBOUND_ENABLED: "true",
          EMAIL_INBOUND_ALLOWED_SENDERS: "a@example.com, b@example.com"
        })
      })
    );
    expect(resolver.getBoolean("EMAIL_INBOUND_ENABLED", false)).toBe(true);
    expect(resolver.getList("EMAIL_INBOUND_ALLOWED_SENDERS")).toEqual(["a@example.com", "b@example.com"]);
  });
});

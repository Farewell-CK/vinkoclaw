import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadEnv } from "./env.js";

function createBaseEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    VINKOCLAW_DATA_DIR: mkdtempSync(path.join(tmpdir(), "vinko-env-test-")),
    SGLANG_BASE_URL: "",
    OPENAI_API_KEY: "",
    ZHIPUAI_API_KEY: "",
    OLLAMA_BASE_URL: "",
    ...overrides
  };
}

describe("loadEnv", () => {
  it("supports DashScope as a first-class model backend", () => {
    const env = loadEnv(
      createBaseEnv({
        PRIMARY_BACKEND: "dashscope",
        DASHSCOPE_BASE_URL: "https://coding.dashscope.aliyuncs.com/v1",
        DASHSCOPE_MODEL: "qwen3.6-plus",
        DASHSCOPE_API_KEY: "dashscope-key"
      })
    );

    expect(env.primaryBackend).toBe("dashscope");
    expect(env.dashscopeBaseUrl).toBe("https://coding.dashscope.aliyuncs.com/v1");
    expect(env.dashscopeModel).toBe("qwen3.6-plus");
    expect(env.dashscopeApiKey).toBe("dashscope-key");
  });

  it("selects DashScope by default when only DashScope credentials are configured", () => {
    const env = loadEnv(
      createBaseEnv({
        PRIMARY_BACKEND: "",
        DASHSCOPE_API_KEY: "dashscope-key"
      })
    );

    expect(env.primaryBackend).toBe("dashscope");
  });
});

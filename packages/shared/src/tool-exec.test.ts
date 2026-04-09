import { describe, expect, it } from "vitest";
import {
  buildToolCommand,
  detectToolProviderError,
  extractToolOutput,
  hasMeaningfulToolProgress,
  shouldUseCodeExecutorTask
} from "./tool-exec.js";

describe("detectToolProviderError", () => {
  it("detects opencode error events in json stream", () => {
    const stdout = [
      '{"type":"thread.started","thread_id":"x"}',
      '{"type":"error","error":{"name":"APIError","data":{"message":"auth failed"}}}'
    ].join("\n");
    expect(detectToolProviderError("opencode", stdout)).toBe("auth failed");
  });

  it("returns undefined when there is no error event", () => {
    const stdout = '{"type":"text","part":{"text":"OK"}}';
    expect(detectToolProviderError("opencode", stdout)).toBeUndefined();
  });
});

describe("shouldUseCodeExecutorTask", () => {
  it("keeps developer analysis-only prompts on model path", () => {
    const decision = shouldUseCodeExecutorTask({
      roleId: "developer",
      instruction: "请分析当前系统状态",
      skillIds: ["code-executor"]
    });
    expect(decision).toBe(false);
  });

  it("uses code executor for explicit engineering implementation requests", () => {
    const decision = shouldUseCodeExecutorTask({
      roleId: "engineering",
      instruction: "请修复这个登录 bug，并修改相关文件后给出变更路径",
      skillIds: ["code-executor"]
    });
    expect(decision).toBe(true);
  });

  it("avoids code executor for analysis-only prompts on non-developer roles", () => {
    const decision = shouldUseCodeExecutorTask({
      roleId: "backend",
      instruction: "请分析当前邮件链路并给出建议",
      skillIds: ["code-executor"]
    });
    expect(decision).toBe(false);
  });

  it("uses code executor for concrete implementation prompts on non-developer roles", () => {
    const decision = shouldUseCodeExecutorTask({
      roleId: "backend",
      instruction: "请实现邮件分流模块并修复相关接口",
      skillIds: ["code-executor"]
    });
    expect(decision).toBe(true);
  });
});

describe("extractToolOutput", () => {
  it("returns empty string for opencode lifecycle-only json stream", () => {
    const stdout = [
      '{"type":"step_start","timestamp":1}',
      '{"type":"step_finish","timestamp":2}'
    ].join("\n");
    expect(extractToolOutput("opencode", stdout, "")).toBe("");
  });

  it("returns parsed text for opencode text events", () => {
    const stdout = '{"type":"text","part":{"text":"CHANGED_FILES: src/a.ts"}}';
    expect(extractToolOutput("opencode", stdout, "")).toBe("CHANGED_FILES: src/a.ts");
  });
});

describe("hasMeaningfulToolProgress", () => {
  it("ignores opencode lifecycle-only events", () => {
    const chunk = [
      '{"type":"thread.started","thread_id":"x"}',
      '{"type":"step_start","timestamp":1}',
      '{"type":"step_finish","timestamp":2}'
    ].join("\n");
    expect(hasMeaningfulToolProgress("opencode", chunk)).toBe(false);
  });

  it("detects opencode text/error payload as progress", () => {
    expect(hasMeaningfulToolProgress("opencode", '{"type":"text","part":{"text":"done"}}')).toBe(true);
    expect(hasMeaningfulToolProgress("opencode", '{"type":"error","error":{"message":"boom"}}')).toBe(true);
  });

  it("treats permission prompts as non-meaningful progress for opencode", () => {
    expect(hasMeaningfulToolProgress("opencode", "Permission requested: external_directory")).toBe(false);
    expect(
      hasMeaningfulToolProgress("opencode", '{"type":"text","part":{"text":"Permission requested: external_directory"}}')
    ).toBe(false);
  });

  it("treats non-opencode chunk output as progress", () => {
    expect(hasMeaningfulToolProgress("codex", '{"type":"item.completed"}')).toBe(true);
    expect(hasMeaningfulToolProgress("claude", "plain output")).toBe(true);
  });
});

describe("buildToolCommand", () => {
  it("builds opencode command with thinking by default", () => {
    const command = buildToolCommand({
      providerId: "opencode",
      instruction: "实现一个接口",
      workspaceRoot: "/workspace",
      statuses: [
        {
          providerId: "opencode",
          binaryName: "opencode",
          available: true,
          binaryPath: "/usr/bin/opencode",
          keyConfigured: true
        }
      ],
      modelId: "zhipuai/glm-5"
    });
    expect(command?.command).toBe("/usr/bin/opencode");
    expect(command?.args).toContain("run");
    expect(command?.args).toContain("--format");
    expect(command?.args).toContain("json");
    expect(command?.args).toContain("--dir");
    expect(command?.args).toContain("/workspace");
    expect(command?.args).toContain("--model");
    expect(command?.args).toContain("zhipuai/glm-5");
    expect(command?.args).toContain("--thinking");
  });

  it("can disable thinking for opencode retry convergence", () => {
    const command = buildToolCommand({
      providerId: "opencode",
      instruction: "实现一个接口",
      workspaceRoot: "/workspace",
      statuses: [
        {
          providerId: "opencode",
          binaryName: "opencode",
          available: true,
          binaryPath: "/usr/bin/opencode",
          keyConfigured: true
        }
      ],
      enableThinking: false
    });
    expect(command?.args).not.toContain("--thinking");
  });
});

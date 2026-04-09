import { accessSync, constants } from "node:fs";
import path from "node:path";
import { loadEnv, type RuntimeEnv } from "./env.js";
import type {
  RoleId,
  ToolApprovalMode,
  ToolExecPolicy,
  ToolProviderId,
  ToolProviderStatus,
  ToolRiskLevel
} from "./types.js";

const DEFAULT_HIGH_RISK_KEYWORDS = [
  "rm -rf",
  "sudo ",
  "reboot",
  "shutdown",
  "systemctl",
  "docker rm",
  "docker rmi",
  "drop table",
  "truncate table",
  "delete from",
  "git push",
  "git reset --hard",
  "curl | bash",
  "deploy",
  "production"
];

const MEDIUM_RISK_KEYWORDS = [
  "npm install",
  "pip install",
  "apt ",
  "yum ",
  "dnf ",
  "brew install",
  "docker build",
  "docker run",
  "kubectl",
  "migrate",
  "migration"
];

export const DEFAULT_TOOL_EXEC_POLICY: ToolExecPolicy = {
  providerOrder: ["opencode", "codex", "claude"],
  workspaceOnly: true,
  timeoutMs: 20 * 60 * 1000,
  approvalMode: "cto_auto_owner_fallback",
  ctoRoleId: "cto",
  ownerRoleId: "ceo",
  highRiskKeywords: DEFAULT_HIGH_RISK_KEYWORDS,
  providerModels: {},
  providerBaseUrls: {}
};

function isExecutable(filePath: string): boolean {
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveFromPath(binaryName: string, environmentPath: string | undefined): string | undefined {
  if (!environmentPath) {
    return undefined;
  }

  for (const segment of environmentPath.split(path.delimiter)) {
    const trimmed = segment.trim();
    if (!trimmed) {
      continue;
    }
    const candidate = path.join(trimmed, binaryName);
    if (isExecutable(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function firstExecutable(candidates: Array<string | undefined>): string | undefined {
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    if (isExecutable(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function resolveOpencodeBinary(): string | undefined {
  const fromPath = resolveFromPath("opencode", process.env.PATH);
  if (fromPath) {
    return fromPath;
  }

  return firstExecutable([
    process.env.OPENCODE_BIN_PATH,
    path.join(process.env.HOME ?? "", ".npm-global", "bin", "opencode"),
    path.join(process.env.HOME ?? "", ".opencode", "bin", "opencode")
  ]);
}

function resolveCodexBinary(): string | undefined {
  return firstExecutable([
    resolveFromPath("codex", process.env.PATH),
    path.join(process.env.HOME ?? "", ".npm-global", "bin", "codex")
  ]);
}

function resolveClaudeBinary(): string | undefined {
  return firstExecutable([
    resolveFromPath("claude", process.env.PATH),
    path.join(process.env.HOME ?? "", ".npm-global", "bin", "claude")
  ]);
}

function hasAnyEnv(keys: string[], runtimeSecrets: Record<string, string> = {}): boolean {
  return keys.some((key) => {
    const value = runtimeSecrets[key] ?? process.env[key];
    return typeof value === "string" && value.trim().length > 0;
  });
}

export function listToolProviderStatuses(
  _env: RuntimeEnv = loadEnv(),
  _policy?: Partial<ToolExecPolicy>,
  runtimeSecrets: Record<string, string> = {}
): ToolProviderStatus[] {
  const opencodePath = resolveOpencodeBinary();
  const codexPath = resolveCodexBinary();
  const claudePath = resolveClaudeBinary();
  const opencodeKeyConfigured = Boolean(
    _env.opencodeApiKey ||
      _env.zhipuApiKey ||
      _env.openaiApiKey ||
      hasAnyEnv(["OPENCODE_API_KEY", "OPENCODE_ZEN_API_KEY", "ZHIPUAI_API_KEY", "OPENAI_API_KEY"], runtimeSecrets)
  );
  const codexKeyConfigured = Boolean(
    _env.openaiApiKey || hasAnyEnv(["OPENAI_API_KEY"], runtimeSecrets)
  );
  const claudeKeyConfigured = Boolean(
    _env.anthropicApiKey || hasAnyEnv(["ANTHROPIC_API_KEY"], runtimeSecrets)
  );

  return [
    {
      providerId: "opencode",
      binaryName: "opencode",
      available: Boolean(opencodePath),
      binaryPath: opencodePath,
      keyEnvName: "OPENCODE_API_KEY",
      keyConfigured: opencodeKeyConfigured,
      note: opencodePath ? undefined : "opencode binary not found in PATH"
    },
    {
      providerId: "codex",
      binaryName: "codex",
      available: Boolean(codexPath),
      binaryPath: codexPath,
      keyEnvName: "OPENAI_API_KEY",
      keyConfigured: codexKeyConfigured,
      note: codexPath ? undefined : "codex binary not found in PATH"
    },
    {
      providerId: "claude",
      binaryName: "claude",
      available: Boolean(claudePath),
      binaryPath: claudePath,
      keyEnvName: "ANTHROPIC_API_KEY",
      keyConfigured: claudeKeyConfigured,
      note: claudePath ? undefined : "claude binary not found in PATH"
    }
  ];
}

function normalizeProviderOrder(order: ToolProviderId[] | undefined): ToolProviderId[] {
  const value = Array.isArray(order) ? order : DEFAULT_TOOL_EXEC_POLICY.providerOrder;
  const set = new Set<ToolProviderId>();
  for (const providerId of value) {
    if (providerId === "opencode" || providerId === "codex" || providerId === "claude") {
      set.add(providerId);
    }
  }
  return set.size === 0 ? [...DEFAULT_TOOL_EXEC_POLICY.providerOrder] : Array.from(set);
}

function normalizeApprovalMode(value: ToolApprovalMode | undefined): ToolApprovalMode {
  if (value === "manual_owner" || value === "cto_auto_owner_fallback") {
    return value;
  }
  return DEFAULT_TOOL_EXEC_POLICY.approvalMode;
}

function normalizeRoleId(value: RoleId | undefined, fallback: RoleId): RoleId {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

function normalizeKeywords(value: string[] | undefined): string[] {
  const raw = Array.isArray(value) ? value : DEFAULT_HIGH_RISK_KEYWORDS;
  const normalized = raw.map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  return normalized.length > 0 ? normalized : [...DEFAULT_HIGH_RISK_KEYWORDS];
}

function normalizeProviderValueMap(
  input: Partial<Record<ToolProviderId, string>> | undefined
): Partial<Record<ToolProviderId, string>> {
  const normalized: Partial<Record<ToolProviderId, string>> = {};
  if (!input) {
    return normalized;
  }

  const providerIds: ToolProviderId[] = ["opencode", "codex", "claude"];
  for (const providerId of providerIds) {
    const raw = input[providerId];
    if (typeof raw !== "string") {
      continue;
    }
    const value = raw.trim();
    if (!value) {
      continue;
    }
    normalized[providerId] = value;
  }

  return normalized;
}

export function normalizeToolExecPolicy(input: Partial<ToolExecPolicy> | undefined): ToolExecPolicy {
  const timeoutCandidate = Number(input?.timeoutMs ?? DEFAULT_TOOL_EXEC_POLICY.timeoutMs);
  const timeoutMs = Number.isFinite(timeoutCandidate)
    ? Math.max(30_000, Math.round(timeoutCandidate))
    : DEFAULT_TOOL_EXEC_POLICY.timeoutMs;

  return {
    providerOrder: normalizeProviderOrder(input?.providerOrder),
    workspaceOnly: input?.workspaceOnly ?? DEFAULT_TOOL_EXEC_POLICY.workspaceOnly,
    timeoutMs,
    approvalMode: normalizeApprovalMode(input?.approvalMode),
    ctoRoleId: normalizeRoleId(input?.ctoRoleId, DEFAULT_TOOL_EXEC_POLICY.ctoRoleId),
    ownerRoleId: normalizeRoleId(input?.ownerRoleId, DEFAULT_TOOL_EXEC_POLICY.ownerRoleId),
    highRiskKeywords: normalizeKeywords(input?.highRiskKeywords),
    providerModels: normalizeProviderValueMap(input?.providerModels),
    providerBaseUrls: normalizeProviderValueMap(input?.providerBaseUrls)
  };
}

export function detectToolRiskLevel(instruction: string, policy: ToolExecPolicy): ToolRiskLevel {
  const normalized = instruction.trim().toLowerCase();
  if (!normalized) {
    return "low";
  }

  const highRiskKeywords = normalizeKeywords(policy.highRiskKeywords);
  if (highRiskKeywords.some((keyword) => normalized.includes(keyword))) {
    return "high";
  }

  if (MEDIUM_RISK_KEYWORDS.some((keyword) => normalized.includes(keyword))) {
    return "medium";
  }

  return "low";
}

export function shouldUseCodeExecutorTask(input: {
  roleId: RoleId;
  instruction: string;
  skillIds: string[];
}): boolean {
  if (!input.skillIds.includes("code-executor")) {
    return false;
  }

  const normalized = input.instruction.toLowerCase();
  const executionIntent =
    normalized.includes("实现") ||
    normalized.includes("开发") ||
    normalized.includes("修复") ||
    normalized.includes("重构") ||
    normalized.includes("改代码") ||
    normalized.includes("改一下") ||
    normalized.includes("新增") ||
    normalized.includes("创建") ||
    normalized.includes("生成") ||
    normalized.includes("写一个") ||
    normalized.includes("写出") ||
    normalized.includes("commit") ||
    normalized.includes("patch") ||
    normalized.includes("apply") ||
    normalized.includes("implement") ||
    normalized.includes("build") ||
    normalized.includes("create");

  const codeIntent =
    normalized.includes("代码") ||
    normalized.includes("开发") ||
    normalized.includes("实现") ||
    normalized.includes("修复") ||
    normalized.includes("bug") ||
    normalized.includes("test") ||
    normalized.includes("refactor") ||
    normalized.includes("重构") ||
    normalized.includes("patch") ||
    normalized.includes("commit");

  if (!codeIntent) {
    return false;
  }

  const actionOrArtifact =
    normalized.includes("文件") ||
    normalized.includes("模块") ||
    normalized.includes("函数") ||
    normalized.includes("接口") ||
    normalized.includes("api") ||
    normalized.includes("测试用例") ||
    normalized.includes("单测") ||
    normalized.includes("frontend") ||
    normalized.includes("backend");
  const analysisOnly =
    normalized.includes("说明") ||
    normalized.includes("分析") ||
    normalized.includes("看看") ||
    normalized.includes("检查") ||
    normalized.includes("有没有") ||
    normalized.includes("是否有") ||
    normalized.includes("排查") ||
    normalized.includes("解释") ||
    normalized.includes("review") ||
    normalized.includes("总结") ||
    normalized.includes("评审") ||
    normalized.includes("列出") ||
    normalized.includes("建议");

  if (input.roleId === "developer" || input.roleId === "engineering") {
    if (analysisOnly && !executionIntent && !actionOrArtifact) {
      return false;
    }
    return executionIntent || actionOrArtifact;
  }

  if (!codeIntent) {
    return false;
  }
  if (analysisOnly && !executionIntent && !actionOrArtifact) {
    return false;
  }
  return actionOrArtifact || executionIntent || !analysisOnly;
}

export interface ToolCommandSpec {
  command: string;
  args: string[];
}

function ensureProviderPath(
  providerId: ToolProviderId,
  statuses: ToolProviderStatus[]
): string | undefined {
  return statuses.find((status) => status.providerId === providerId)?.binaryPath;
}

export function buildToolCommand(input: {
  providerId: ToolProviderId;
  instruction: string;
  workspaceRoot: string;
  statuses: ToolProviderStatus[];
  modelId?: string | undefined;
  enableThinking?: boolean | undefined;
}): ToolCommandSpec | undefined {
  const providerPath = ensureProviderPath(input.providerId, input.statuses);
  if (!providerPath) {
    return undefined;
  }

  const instruction = input.instruction.trim();
  if (!instruction) {
    return undefined;
  }

  if (input.providerId === "opencode") {
    const args = ["run", "--format", "json"];
    if (input.enableThinking ?? true) {
      args.push("--thinking");
    }
    args.push("--dir", input.workspaceRoot);
    if (input.modelId) {
      args.push("--model", input.modelId);
    }
    args.push(instruction);
    return {
      command: providerPath,
      args
    };
  }

  if (input.providerId === "codex") {
    return {
      command: providerPath,
      args: ["exec", "--skip-git-repo-check", "--json", "--cd", input.workspaceRoot, instruction]
    };
  }

  return {
    command: providerPath,
    args: [
      "--print",
      "--output-format",
      "json",
      "--permission-mode",
      "dontAsk",
      "--add-dir",
      input.workspaceRoot,
      instruction
    ]
  };
}

export function selectAvailableProviders(policy: ToolExecPolicy, statuses: ToolProviderStatus[]): ToolProviderStatus[] {
  const byId = new Map(statuses.map((entry) => [entry.providerId, entry] as const));
  return policy.providerOrder
    .map((providerId) => byId.get(providerId))
    .filter((entry): entry is ToolProviderStatus => Boolean(entry?.available && entry.keyConfigured));
}

function parseJsonLines(stdout: string): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const line of stdout.split(/\r?\n/g)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      rows.push(parsed);
    } catch {
      continue;
    }
  }
  return rows;
}

const OPENCODE_NON_PROGRESS_TYPES = new Set([
  "thread.started",
  "thread.updated",
  "step_start",
  "step_finish",
  "token_usage",
  "usage",
  "heartbeat",
  "ping"
]);

const OPENCODE_PROGRESS_TYPES = new Set([
  "text",
  "message",
  "assistant_message",
  "result",
  "final",
  "completed",
  "error",
  "tool_call",
  "tool_result",
  "patch",
  "file_write",
  "file_update"
]);

const OPENCODE_PROGRESS_TYPES_REQUIRING_PAYLOAD = new Set([
  "text",
  "message",
  "assistant_message",
  "result"
]);

function isLikelyContentText(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function isPermissionPromptText(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    /permission requested/.test(normalized) ||
    /external[_\s-]?directory/.test(normalized) ||
    /awaiting (approval|permission)/.test(normalized) ||
    /approve|reject/.test(normalized)
  );
}

function isLikelyProgressText(value: unknown): boolean {
  return isLikelyContentText(value) && !isPermissionPromptText(String(value));
}

function hasJsonProgressPayload(row: Record<string, unknown>): boolean {
  if (isLikelyProgressText(row.message) || isLikelyProgressText(row.result) || isLikelyProgressText(row.output)) {
    return true;
  }
  if (row.error && typeof row.error === "object") {
    return true;
  }
  if (row.part && typeof row.part === "object") {
    const part = row.part as Record<string, unknown>;
    if (isLikelyProgressText(part.text) || isLikelyProgressText(part.content)) {
      return true;
    }
  }
  if (row.delta && typeof row.delta === "object") {
    const delta = row.delta as Record<string, unknown>;
    if (isLikelyProgressText(delta.text) || isLikelyProgressText(delta.content)) {
      return true;
    }
  }
  return false;
}

export function hasMeaningfulToolProgress(providerId: ToolProviderId, chunk: string): boolean {
  const text = chunk.trim();
  if (!text) {
    return false;
  }
  if (providerId !== "opencode") {
    return true;
  }

  for (const line of text.split(/\r?\n/g)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
      // Non-JSON output from opencode is usually actionable text.
      return !isPermissionPromptText(trimmed);
    }
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const typeValue = typeof parsed.type === "string" ? parsed.type.toLowerCase() : "";
      if (OPENCODE_PROGRESS_TYPES.has(typeValue)) {
        if (typeValue === "error") {
          return true;
        }
        if (OPENCODE_PROGRESS_TYPES_REQUIRING_PAYLOAD.has(typeValue)) {
          if (hasJsonProgressPayload(parsed)) {
            return true;
          }
          continue;
        }
        return true;
      }
      if (hasJsonProgressPayload(parsed)) {
        return true;
      }
      if (!OPENCODE_NON_PROGRESS_TYPES.has(typeValue) && typeValue.length > 0) {
        // Unknown event types are treated as non-progress unless they carry text payload.
        continue;
      }
    } catch {
      // Malformed JSON line should still be considered progress-like output.
      return true;
    }
  }

  return false;
}

function parseOpencodeOutput(stdout: string): string {
  const rows = parseJsonLines(stdout);
  const textParts: string[] = [];
  for (const row of rows) {
    if (row.type === "text" && row.part && typeof row.part === "object") {
      const part = row.part as Record<string, unknown>;
      if (typeof part.text === "string" && part.text.trim()) {
        textParts.push(part.text.trim());
      }
    }
  }
  return textParts.join("\n").trim();
}

function parseCodexOutput(stdout: string): string {
  const rows = parseJsonLines(stdout);
  const agentMessages: string[] = [];
  for (const row of rows) {
    if (row.type !== "item.completed") {
      continue;
    }
    if (!row.item || typeof row.item !== "object") {
      continue;
    }
    const item = row.item as Record<string, unknown>;
    if (item.type === "agent_message" && typeof item.text === "string" && item.text.trim()) {
      agentMessages.push(item.text.trim());
    }
  }
  if (agentMessages.length > 0) {
    return agentMessages[agentMessages.length - 1] ?? "";
  }

  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (!row) {
      continue;
    }
    if (typeof row.last_assistant_message === "string" && row.last_assistant_message.trim()) {
      return row.last_assistant_message.trim();
    }
    if (typeof row.message === "string" && row.message.trim()) {
      return row.message.trim();
    }
  }

  return stdout.trim();
}

function parseClaudeOutput(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return "";
  }

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (typeof parsed.result === "string" && parsed.result.trim()) {
      return parsed.result.trim();
    }
    if (typeof parsed.content === "string" && parsed.content.trim()) {
      return parsed.content.trim();
    }
  } catch {
    return trimmed;
  }

  return trimmed;
}

export function extractToolOutput(providerId: ToolProviderId, stdout: string, stderr: string): string {
  const parsed =
    providerId === "opencode"
      ? parseOpencodeOutput(stdout)
      : providerId === "codex"
        ? parseCodexOutput(stdout)
        : parseClaudeOutput(stdout);

  if (parsed) {
    return parsed;
  }

  if (providerId === "opencode") {
    // Opencode can emit JSON lifecycle events without human-readable content.
    // Returning raw event stream degrades user output quality.
    return "";
  }

  return stdout.trim() || stderr.trim();
}

export function detectToolProviderError(providerId: ToolProviderId, stdout: string): string | undefined {
  const rows = parseJsonLines(stdout);
  if (rows.length === 0) {
    return undefined;
  }

  for (const row of rows) {
    if (row.type !== "error") {
      continue;
    }

    const error = row.error;
    if (!error || typeof error !== "object") {
      return `${providerId} reported an error`;
    }
    const payload = error as Record<string, unknown>;
    if (typeof payload.message === "string" && payload.message.trim()) {
      return payload.message.trim();
    }
    if (payload.data && typeof payload.data === "object") {
      const data = payload.data as Record<string, unknown>;
      if (typeof data.message === "string" && data.message.trim()) {
        return data.message.trim();
      }
    }
    return `${providerId} reported an error`;
  }

  return undefined;
}

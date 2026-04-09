import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { AgentRuntime, type TaskContextSnippet } from "@vinko/agent-runtime";
import { buildWorkDir } from "@vinko/agent-runtime/tool-executor";
import { FeishuClient } from "@vinko/feishu-gateway";
import { WorkspaceKnowledgeBase } from "@vinko/knowledge-base";
import {
  buildToolCommand,
  createLogger,
  createRuntimeValueResolver,
  detectToolRiskLevel,
  detectToolProviderError,
  emitTaskLifecycle,
  extractToolOutput,
  hasMeaningfulToolProgress,
  parseSearchMaxResults,
  resolveFeishuApproverOpenIds,
  resolveSearchProviderApiKeyEnv,
  resolveSearchProviderId,
  listToolProviderStatuses,
  loadEnv,
  ROLE_IDS,
  selectAvailableProviders,
  shouldUseCodeExecutorTask,
  VinkoStore,
  type GoalRunRecord,
  type GoalRunResult,
  type ReflectionNote,
  type RoleId,
  type TaskRecord,
  type TaskResult,
  type ToolProviderId,
  type ToolRunRecord
} from "@vinko/shared";
import { CollaborationManager } from "./collaboration-manager.js";
import { notifyGoalRunProgressSafely } from "./goal-run-progress.js";

const env = loadEnv();
const store = VinkoStore.fromEnv(env);
const logger = createLogger("task-runner");
const runtimeValues = createRuntimeValueResolver({
  env,
  getRuntimeSettings: () => store.getRuntimeSettings(),
  getRuntimeSecrets: () => store.getRuntimeSecrets()
});
const runtime = new AgentRuntime();
const knowledgeBase = new WorkspaceKnowledgeBase();
const FEISHU_APPROVAL_CARD_TTL_MS = 15 * 60 * 1000;
const runnerInstanceId = (process.env.RUNNER_INSTANCE_ID ?? String(process.pid)).trim() || String(process.pid);
const taskHeartbeatMsRaw = Number(process.env.RUNNER_TASK_HEARTBEAT_MS ?? "30000");
const taskHeartbeatMs = Number.isFinite(taskHeartbeatMsRaw) ? Math.max(5_000, Math.round(taskHeartbeatMsRaw)) : 30_000;
const codeExecutorEnabled = runtimeValues.getBoolean("CODE_EXECUTOR_ENABLED", false);
const goalRunExecSoftTimeoutMsRaw = Number(process.env.GOAL_RUN_EXEC_SOFT_TIMEOUT_MS ?? "45000");
const goalRunExecSoftTimeoutMs = Number.isFinite(goalRunExecSoftTimeoutMsRaw)
  ? Math.max(10_000, Math.round(goalRunExecSoftTimeoutMsRaw))
  : 45_000;
const goalRunExecHardTimeoutMsRaw = Number(process.env.GOAL_RUN_EXEC_HARD_TIMEOUT_MS ?? "1800000");
const goalRunExecHardTimeoutMs = Number.isFinite(goalRunExecHardTimeoutMsRaw)
  ? Math.max(120_000, Math.round(goalRunExecHardTimeoutMsRaw))
  : 1_800_000;
const goalRunCollaborationTimeoutMsRaw = Number(process.env.GOAL_RUN_COLLAB_TIMEOUT_MS ?? "1800000");
const goalRunCollaborationTimeoutMs = Number.isFinite(goalRunCollaborationTimeoutMsRaw)
  ? Math.max(180_000, Math.round(goalRunCollaborationTimeoutMsRaw))
  : 1_800_000;
const goalRunCollabHeartbeatMsRaw = Number(process.env.GOAL_RUN_COLLAB_HEARTBEAT_MS ?? "45000");
const goalRunCollabHeartbeatMs = Number.isFinite(goalRunCollabHeartbeatMsRaw)
  ? Math.max(10_000, Math.round(goalRunCollabHeartbeatMsRaw))
  : 45_000;
const goalRunCollabRetryEnabled = runtimeValues.getBoolean("GOAL_RUN_COLLAB_RETRY_ENABLED", true);
const goalRunCollabVerifyRetryEnabled = runtimeValues.getBoolean("GOAL_RUN_COLLAB_VERIFY_RETRY_ENABLED", true);
const toolRunNoOutputTimeoutMsRaw = Number(process.env.TOOL_RUN_NO_OUTPUT_TIMEOUT_MS ?? "180000");
const toolRunNoOutputTimeoutMs = Number.isFinite(toolRunNoOutputTimeoutMsRaw)
  ? Math.max(15_000, Math.round(toolRunNoOutputTimeoutMsRaw))
  : 180_000;
const toolRunNoProgressTimeoutMsRaw = Number(process.env.TOOL_RUN_NO_PROGRESS_TIMEOUT_MS ?? "300000");
const toolRunNoProgressTimeoutMs = Number.isFinite(toolRunNoProgressTimeoutMsRaw)
  ? Math.max(30_000, Math.round(toolRunNoProgressTimeoutMsRaw))
  : 300_000;
const toolRunMaxRunningMsRaw = Number(process.env.TOOL_RUN_MAX_RUNNING_MS ?? "900000");
const toolRunMaxRunningMs = Number.isFinite(toolRunMaxRunningMsRaw)
  ? Math.max(60_000, Math.round(toolRunMaxRunningMsRaw))
  : 900_000;
const toolRunCollabTimeoutMsRaw = Number(process.env.TOOL_RUN_COLLAB_TIMEOUT_MS ?? "360000");
const toolRunCollabTimeoutMs = Number.isFinite(toolRunCollabTimeoutMsRaw)
  ? Math.max(60_000, Math.round(toolRunCollabTimeoutMsRaw))
  : 360_000;
const taskConcurrencyRaw = Number(process.env.RUNNER_TASK_CONCURRENCY ?? "1");
const taskConcurrency = Number.isFinite(taskConcurrencyRaw) ? Math.max(1, Math.min(12, Math.round(taskConcurrencyRaw))) : 1;
const FEISHU_SMALLTALK_ONLY_PATTERN =
  /^(?:你好|您好|嗨|哈喽|hello|hi|hey|在吗|在不在|早上好|中午好|下午好|晚上好|谢谢|多谢|thx|thanks|thankyou|辛苦了)(?:呀|啊|哈|呢|啦|嘛|哇)?$/i;
const FEISHU_SMALLTALK_ACTION_PATTERN =
  /(?:帮我|请|配置|设置|安装|新增|添加|删除|移除|创建|调研|分析|写|做|处理|执行|安排|切换|启用|禁用|run|install|set|configure|add|remove|delete|create|search)/i;
const GOAL_RUN_ARTIFACT_OBJECTIVE_PATTERN =
  /(?:写|实现|开发|构建|创建|搭建|生成|小游戏|网站|官网|前端|后端|代码|测试用例|编写|build|implement|develop|create|generate|website|landing\s*page|game|app|frontend|backend|code|test\s*case|repository|repo)/i;
const ARTIFACT_FILE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".html",
  ".css",
  ".scss",
  ".yaml",
  ".yml",
  ".sh",
  ".sql"
]);
const ARTIFACT_SCAN_IGNORED_DIRS = new Set([
  ".git",
  ".run",
  "node_modules",
  ".data",
  "dist",
  "build",
  "coverage",
  ".turbo",
  ".next",
  ".cache",
  ".vscode",
  ".idea"
]);
const KNOWN_ROLE_IDS = new Set<RoleId>(ROLE_IDS);
const goalRunCollabLastHeartbeatMs = new Map<string, number>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isDatabaseLockedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes("database is locked");
}

async function safeEmitTaskLifecycleEvent(input: Parameters<typeof emitTaskLifecycle>[0]): Promise<void> {
  try {
    await emitTaskLifecycle(input);
  } catch (error) {
    logger.error("failed to emit task lifecycle event", error, {
      taskId: input.taskId,
      phase: input.phase,
      instanceId: runnerInstanceId
    });
  }
}

function createFeishuClient(): FeishuClient | undefined {
  const appId = runtimeValues.get("FEISHU_APP_ID");
  const appSecret = runtimeValues.get("FEISHU_APP_SECRET");
  const domain = runtimeValues.get("FEISHU_DOMAIN");
  if (!appId || !appSecret) {
    return undefined;
  }
  return new FeishuClient({
    appId,
    appSecret,
    domain
  });
}

function isLikelyFeishuChatId(chatId: string): boolean {
  return /^oc_[a-z0-9]{20,}$/i.test(chatId.trim());
}

function sanitizeFeishuReplyText(message: string): string {
  if (/当前提供的(?:本地)?上下文(?:仅包含)?|必须仅基于提供的上下文|仅使用基于提供上下文|无法(?:提供|生成).*(?:趋势分析|可靠结论)/u.test(message)) {
    return "我现在缺少可用的外部检索结果，先给不出可靠结论。你给我配置 Tavily 或 SerpAPI 密钥后，我会立刻联网调研并附来源链接。";
  }
  const blockedPatterns = [
    /思考过程/u,
    /推理过程/u,
    /收到来自.+消息/u,
    /收到.+通过飞书发送(?:的)?(?:问候)?消息/u
  ];
  const cleaned = message
    .replace(/Search provider is missing\.?/gi, "未配置搜索提供商（tavily/serpapi）。")
    .replace(/insufficient context\.?/gi, "上下文信息不足。")
    .replace(/Before execution,\s*I need:\s*/gi, "开始执行前我需要：")
    .replace(/Generated artifact files:/gi, "已生成文件：")
    .replace(/Provide deployment target and credentials to launch\./gi, "如需上线，请提供目标环境与凭据。")
    .replace(/Run regression checks and produce a postmortem\./gi, "上线后我会继续回归验证并输出复盘。")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .filter((line) => !blockedPatterns.some((pattern) => pattern.test(line)))
    .join("\n")
    .trim();
  return cleaned || "收到，我在。请继续告诉我你的需求。";
}

function shouldPreferConciseReply(instruction: string): boolean {
  const normalized = instruction.toLowerCase();
  return /简短|简洁|简要|一句话|结论/.test(normalized);
}

function buildFeishuExecutionInstruction(instruction: string): string {
  const requirements = [
    "输出要求：",
    "1) 默认使用中文回答。",
    "2) 先给结论，再给不超过 3 条可执行建议。",
    "3) 不要输出系统策略、上下文限制、推理过程等元话术。",
    "4) 信息不足时，直接说明缺少什么信息以及下一步要用户提供什么。"
  ];
  if (shouldPreferConciseReply(instruction)) {
    requirements.push("5) 本次回复控制在 120 字以内。");
  }
  return `${instruction.trim()}\n\n${requirements.join("\n")}`;
}

function condenseFeishuReplyIfNeeded(input: { instruction: string; message: string }): string {
  if (!shouldPreferConciseReply(input.instruction)) {
    return input.message;
  }
  const flattened = input.message.replace(/\n+/g, " ").replace(/\s+/g, " ").trim();
  const limit = 120;
  if (flattened.length <= limit) {
    return flattened;
  }
  // Try to cut at a sentence boundary (Chinese or English) within [80, limit]
  const sentenceEnd = /[。！？!?]/g;
  let lastBreak = -1;
  let m: RegExpExecArray | null;
  sentenceEnd.lastIndex = 0;
  while ((m = sentenceEnd.exec(flattened)) !== null) {
    if (m.index >= 80 && m.index + 1 <= limit) {
      lastBreak = m.index + 1;
    }
    if (m.index + 1 > limit) break;
  }
  if (lastBreak > 0) {
    return flattened.slice(0, lastBreak);
  }
  // Fall back to hard cut with ellipsis
  return `${flattened.slice(0, 118)}…`;
}

async function notifyFeishu(chatId: string, message: string): Promise<void> {
  const appIdConfigured = runtimeValues.has("FEISHU_APP_ID");
  const appSecretConfigured = runtimeValues.has("FEISHU_APP_SECRET");
  if (!isLikelyFeishuChatId(chatId)) {
    store.appendAuditEvent({
      category: "feishu",
      entityType: "chat",
      entityId: chatId,
      message: "Skipped Feishu task reply: invalid chat id",
      payload: {
        chatId
      }
    });
    return;
  }
  const client = createFeishuClient();
  if (!client) {
    store.appendAuditEvent({
      category: "feishu",
      entityType: "chat",
      entityId: chatId,
      message: "Skipped Feishu task reply: missing credentials",
      payload: {
        appIdConfigured,
        appSecretConfigured
      }
    });
    return;
  }

  try {
    await client.sendTextToChat(chatId, sanitizeFeishuReplyText(message));
  } catch (error) {
    store.appendAuditEvent({
      category: "feishu",
      entityType: "chat",
      entityId: chatId,
      message: "Failed to send Feishu task reply",
      payload: {
        error: error instanceof Error ? error.message : String(error)
      }
    });
  }
}

function shouldSendArtifactsToFeishu(instruction: string): boolean {
  return /发\s*(?:给\s*)?我|发送给我|send\s+(?:to\s+)?me/iu.test(instruction);
}

async function sendArtifactsToFeishuChat(chatId: string, artifactFiles: string[]): Promise<void> {
  if (artifactFiles.length === 0) {
    return;
  }
  const client = createFeishuClient();
  if (!client) {
    return;
  }
  for (const relPath of artifactFiles) {
    const absPath = path.join(env.workspaceRoot, relPath);
    if (!existsSync(absPath)) {
      continue;
    }
    const ext = path.extname(relPath).toLowerCase();
    const fileType = ext === ".pdf" ? "pdf" : ext === ".doc" || ext === ".docx" ? "doc" : "stream";
    try {
      const fileKey = await client.uploadFile(absPath, fileType);
      await client.sendFileToChat(chatId, fileKey);
      store.appendAuditEvent({
        category: "feishu",
        entityType: "chat",
        entityId: chatId,
        message: "Sent artifact file to Feishu chat",
        payload: { relPath, fileType }
      });
    } catch (error) {
      store.appendAuditEvent({
        category: "feishu",
        entityType: "chat",
        entityId: chatId,
        message: "Failed to send artifact file to Feishu chat",
        payload: { relPath, error: error instanceof Error ? error.message : String(error) }
      });
    }
  }
}

function resolveToolRunTimeoutMs(task: TaskRecord, configuredTimeoutMs: number): number {
  const metadata = task.metadata as {
    collaborationId?: string;
    isAggregation?: boolean;
  };
  const inCollaborationExecution =
    typeof metadata.collaborationId === "string" &&
    metadata.collaborationId.trim().length > 0 &&
    metadata.isAggregation !== true;
  if (!inCollaborationExecution) {
    return configuredTimeoutMs;
  }
  return Math.max(60_000, Math.min(configuredTimeoutMs, toolRunCollabTimeoutMs));
}

function resolveFeishuOwnerOpenIds(): string[] {
  const configured = runtimeValues.getList("FEISHU_OWNER_OPEN_IDS");
  if (configured.length > 0) {
    return configured;
  }
  return env.feishuOwnerOpenIds.map((entry) => entry.trim()).filter(Boolean);
}

function resolveFeishuApproversForRole(roleId: RoleId): string[] {
  return resolveFeishuApproverOpenIds({
    roleId,
    approverOpenIdsJson: runtimeValues.get("FEISHU_APPROVER_OPEN_IDS_JSON"),
    fallbackOwnerOpenIds: resolveFeishuOwnerOpenIds()
  });
}

function buildFeishuApprovalDecisionCard(input: {
  approvalId: string;
  stepId: string;
  roleId: RoleId;
  summary: string;
  requestedBy?: string | undefined;
  approverOpenId: string;
}): Record<string, unknown> {
  const expiresAt = Date.now() + FEISHU_APPROVAL_CARD_TTL_MS;
  const decisionValue = {
    kind: "approval_decision",
    approvalId: input.approvalId,
    stepId: input.stepId,
    roleId: input.roleId,
    approverOpenId: input.approverOpenId,
    expiresAt
  };
  return {
    schema: "2.0",
    config: {
      wide_screen_mode: true
    },
    header: {
      title: {
        tag: "plain_text",
        content: "审批请求"
      },
      template: "orange"
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: [
            `**审批单**: ${input.approvalId.slice(0, 8)}`,
            `**步骤角色**: ${input.roleId}`,
            `**摘要**: ${input.summary}`,
            `**发起人**: ${input.requestedBy?.trim() || "unknown"}`
          ].join("\n")
        },
        {
          tag: "action",
          actions: [
            {
              tag: "button",
              text: {
                tag: "plain_text",
                content: "批准"
              },
              type: "primary",
              value: {
                ...decisionValue,
                decision: "approved"
              }
            },
            {
              tag: "button",
              text: {
                tag: "plain_text",
                content: "拒绝"
              },
              type: "danger",
              value: {
                ...decisionValue,
                decision: "rejected"
              }
            }
          ]
        }
      ]
    }
  };
}

async function notifyFeishuApprovalStep(input: {
  approvalId: string;
  stepId: string;
  roleId: RoleId;
  summary: string;
  requestedBy?: string | undefined;
}): Promise<void> {
  const enabled = runtimeValues.getBoolean("FEISHU_APPROVAL_CARD_ENABLED", true);
  if (!enabled) {
    return;
  }
  const client = createFeishuClient();
  if (!client) {
    return;
  }
  const approvers = resolveFeishuApproversForRole(input.roleId);
  if (approvers.length === 0) {
    store.appendAuditEvent({
      category: "approval",
      entityType: "approval",
      entityId: input.approvalId,
      message: "No Feishu approver configured for approval step",
      payload: {
        roleId: input.roleId
      }
    });
    return;
  }

  for (const approverOpenId of approvers) {
    try {
      await client.sendCardToUser(
        approverOpenId,
        buildFeishuApprovalDecisionCard({
          approvalId: input.approvalId,
          stepId: input.stepId,
          roleId: input.roleId,
          summary: input.summary,
          requestedBy: input.requestedBy,
          approverOpenId
        })
      );
    } catch (error) {
      store.appendAuditEvent({
        category: "feishu",
        entityType: "approval",
        entityId: input.approvalId,
        message: "Failed to send Feishu approval card",
        payload: {
          roleId: input.roleId,
          approverOpenId,
          error: error instanceof Error ? error.message : String(error)
        }
      });
    }
  }
}

function buildWebSearchQuery(rawInstruction: string): string {
  const withoutPrefix = rawInstruction.replace(/^[^:：]{1,24}[:：]\s*/, "").trim();
  return withoutPrefix.slice(0, 240);
}

function shouldRunWebSearch(query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized || normalized.length < 6) {
    return false;
  }
  if (/^(你好|您好|hi|hello|hey)\b/i.test(normalized)) {
    return false;
  }
  return true;
}

function buildWebSearchSnippet(input: {
  providerId: "tavily" | "serpapi";
  title: string;
  url: string;
  snippet: string;
}): TaskContextSnippet {
  return {
    path: input.url,
    excerpt: `[web:${input.providerId}] ${input.title}\n${input.snippet}`.slice(0, 1200)
  };
}

async function retrieveWebSearchSnippets(task: TaskRecord, skillIds: string[]): Promise<TaskContextSnippet[]> {
  if (!skillIds.includes("web-search")) {
    return [];
  }

  const query = buildWebSearchQuery(task.instruction);
  if (!shouldRunWebSearch(query)) {
    return [];
  }

  const providerId = resolveSearchProviderId(runtimeValues.get("SEARCH_PROVIDER"));
  if (!providerId) {
    return [];
  }
  const apiKeyEnv = resolveSearchProviderApiKeyEnv(providerId);
  const apiKey = runtimeValues.get(apiKeyEnv);
  if (!apiKey) {
    store.appendAuditEvent({
      category: "search",
      entityType: "web-search",
      entityId: task.id,
      message: "Skipped web search: missing API key",
      payload: {
        providerId,
        apiKeyEnv
      }
    });
    return [];
  }

  const maxResults = parseSearchMaxResults(runtimeValues.get("SEARCH_MAX_RESULTS"), 5);
  try {
    if (providerId === "tavily") {
      const response = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          api_key: apiKey,
          query,
          max_results: maxResults,
          search_depth: "basic",
          include_answer: false
        }),
        signal: AbortSignal.timeout(15_000)
      });
      if (!response.ok) {
        throw new Error(`Tavily search failed with ${response.status}`);
      }
      const payload = (await response.json()) as {
        results?: Array<{ title?: string; url?: string; content?: string }>;
      };
      const snippets = (payload.results ?? [])
        .map((item) => {
          const title = String(item.title ?? "").trim();
          const url = String(item.url ?? "").trim();
          const snippet = String(item.content ?? "").trim();
          if (!url || !snippet) {
            return undefined;
          }
          return buildWebSearchSnippet({
            providerId,
            title: title || url,
            url,
            snippet
          });
        })
        .filter((item): item is TaskContextSnippet => Boolean(item));
      if (snippets.length > 0) {
        store.appendAuditEvent({
          category: "search",
          entityType: "web-search",
          entityId: task.id,
          message: "Retrieved web search snippets",
          payload: {
            providerId,
            count: snippets.length
          }
        });
      }
      return snippets;
    }

    const searchUrl = new URL("https://serpapi.com/search.json");
    searchUrl.searchParams.set("engine", "google");
    searchUrl.searchParams.set("q", query);
    searchUrl.searchParams.set("api_key", apiKey);
    searchUrl.searchParams.set("num", String(maxResults));
    searchUrl.searchParams.set("hl", "zh-cn");

    const response = await fetch(searchUrl, {
      method: "GET",
      signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) {
      throw new Error(`SerpAPI search failed with ${response.status}`);
    }
    const payload = (await response.json()) as {
      organic_results?: Array<{ title?: string; link?: string; snippet?: string }>;
    };
    const snippets = (payload.organic_results ?? [])
      .map((item) => {
        const title = String(item.title ?? "").trim();
        const url = String(item.link ?? "").trim();
        const snippet = String(item.snippet ?? "").trim();
        if (!url || !snippet) {
          return undefined;
        }
        return buildWebSearchSnippet({
          providerId,
          title: title || url,
          url,
          snippet
        });
      })
      .filter((item): item is TaskContextSnippet => Boolean(item));
    if (snippets.length > 0) {
      store.appendAuditEvent({
        category: "search",
        entityType: "web-search",
        entityId: task.id,
        message: "Retrieved web search snippets",
        payload: {
          providerId,
          count: snippets.length
        }
      });
    }
    return snippets;
  } catch (error) {
    store.appendAuditEvent({
      category: "search",
      entityType: "web-search",
      entityId: task.id,
      message: "Web search failed",
      payload: {
        providerId,
        error: error instanceof Error ? error.message : String(error)
      }
    });
    return [];
  }
}

function capText(value: string, maxLength = 12_000): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}\n\n[truncated]`;
}

function capJsonText(value: unknown, maxLength = 2_400): string {
  const text = JSON.stringify(value, null, 2);
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}\n... [truncated]`;
}

function summarizeToolFailureLogs(input: {
  providerId: ToolProviderId;
  stdout: string;
  stderr: string;
}): string {
  const merged = `${input.stderr}\n${input.stdout}`.trim();
  if (input.providerId !== "opencode") {
    return capText(merged, 1600);
  }
  const parsed = extractToolOutput(input.providerId, input.stdout, input.stderr).trim();
  if (parsed.length > 0) {
    return capText(parsed, 1600);
  }
  const filtered = merged
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => !/^\s*\{"type":/.test(line))
    .join("\n")
    .trim();
  return capText(filtered || merged, 1600);
}

function shouldAttachFeishuAuditSnippet(task: TaskRecord): boolean {
  const text = `${task.title}\n${task.instruction}`.toLowerCase();
  return [
    "飞书",
    "feishu",
    "receive_id",
    "审批卡",
    "websocket",
    "通道",
    "发送失败",
    "排查",
    "故障",
    "邮件"
  ].some((keyword) => text.includes(keyword));
}

function buildRuntimeContextSnippets(task: TaskRecord): TaskContextSnippet[] {
  const runtimeConfig = store.getRuntimeConfig();
  const feishuStatus = {
    FEISHU_APP_ID: runtimeValues.has("FEISHU_APP_ID"),
    FEISHU_APP_SECRET: runtimeValues.has("FEISHU_APP_SECRET"),
    FEISHU_DOMAIN: runtimeValues.get("FEISHU_DOMAIN") || "feishu",
    FEISHU_VERIFICATION_TOKEN: runtimeValues.has("FEISHU_VERIFICATION_TOKEN"),
    FEISHU_ENCRYPT_KEY: runtimeValues.has("FEISHU_ENCRYPT_KEY")
  };
  const emailStatus = {
    SMTP_URL: runtimeValues.has("SMTP_URL"),
    EMAIL_DEFAULT_FROM: runtimeValues.has("EMAIL_DEFAULT_FROM"),
    EMAIL_INBOUND_ENABLED: runtimeValues.get("EMAIL_INBOUND_ENABLED") || "0",
    EMAIL_INBOUND_IMAP_HOST: runtimeValues.has("EMAIL_INBOUND_IMAP_HOST"),
    EMAIL_INBOUND_USERNAME: runtimeValues.has("EMAIL_INBOUND_USERNAME")
  };
  const searchProvider = resolveSearchProviderId(runtimeValues.get("SEARCH_PROVIDER"));
  const searchApiKeyEnv = searchProvider ? resolveSearchProviderApiKeyEnv(searchProvider) : "";
  const searchStatus = {
    provider: searchProvider ?? "unconfigured",
    apiKeyEnv: searchApiKeyEnv || "unconfigured",
    apiKeyConfigured: searchApiKeyEnv ? runtimeValues.has(searchApiKeyEnv) : false,
    maxResults: parseSearchMaxResults(runtimeValues.get("SEARCH_MAX_RESULTS"), 5)
  };
  const recentFeishuAudit = shouldAttachFeishuAuditSnippet(task)
    ? store
        .getDashboardSnapshot()
        .auditEvents.filter((event) => event.category === "feishu")
        .slice(0, 8)
        .map((event) => ({
          message: event.message,
          createdAt: event.createdAt,
          payload: event.payload
        }))
    : [];

  return [
    {
      path: "runtime://config/channels",
      excerpt: capJsonText(
        {
          taskRole: task.roleId,
          taskSource: task.source,
          runtimeConfig: runtimeConfig.channels,
          feishuStatus,
          emailStatus,
          searchStatus
        },
        2200
      )
    },
    {
      path: "runtime://audit/feishu",
      excerpt: capJsonText(recentFeishuAudit, 1800)
    }
  ];
}

function buildConversationHistory(task: TaskRecord): Array<{ role: "user" | "assistant"; content: string }> {
  if (!task.sessionId) {
    return [];
  }

  // Fetch more messages but be generous with content — this goes into real message turns
  const recentMessages = store
    .listSessionMessages(task.sessionId, 120)
    .slice(-30);

  const turns: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const message of recentMessages) {
    const isUser = message.actorType === "user";
    const isAssistant = message.actorType === "role";
    if (!isUser && !isAssistant) continue;
    // Truncate individual messages to 800 chars — generous enough for most context
    const content = message.content.slice(0, 800);
    if (!content.trim()) continue;
    turns.push({ role: isUser ? "user" : "assistant", content });
  }

  return turns;
}

function buildSessionContextSnippets(task: TaskRecord): TaskContextSnippet[] {
  if (!task.sessionId) {
    return [];
  }

  const relatedTasks = store
    .listTasks(500)
    .filter((item) => item.sessionId === task.sessionId && item.id !== task.id)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

  const activeTasks = relatedTasks
    .filter((item) => item.status === "queued" || item.status === "running" || item.status === "waiting_approval")
    .slice(0, 8)
    .map((item) => ({
      id: item.id.slice(0, 8),
      roleId: item.roleId,
      status: item.status,
      title: item.title,
      updatedAt: item.updatedAt
    }));

  const recentCompleted = relatedTasks
    .filter((item) => item.status === "completed")
    .slice(0, 6)
    .map((item) => ({
      id: item.id.slice(0, 8),
      roleId: item.roleId,
      title: item.title,
      summary: item.result?.summary ?? "",
      updatedAt: item.updatedAt
    }));

  const activeCollaborations = store
    .listActiveAgentCollaborations()
    .filter((item) => item.sessionId === task.sessionId)
    .slice(0, 4)
    .map((item) => ({
      id: item.id.slice(0, 8),
      facilitator: item.facilitator,
      phase: item.currentPhase,
      participants: item.participants
    }));

  return [
    {
      path: "runtime://session/workflow-state",
      excerpt: capJsonText(
        {
          activeTasks,
          recentCompleted,
          activeCollaborations
        },
        2400
      )
    }
  ];
}

function buildToolTaskResult(input: {
  task: TaskRecord;
  providerId: ToolProviderId;
  outputText: string;
  changedFiles: string[];
}): { result: TaskResult; reflection: ReflectionNote } {
  const changedPreview = input.changedFiles.slice(0, 15);
  // If no changed files detected, scan for file-path-like mentions in the tool output as a hint
  const outputMentionedFiles: string[] =
    changedPreview.length === 0
      ? (() => {
          const matches = input.outputText.match(/[\w\u4e00-\u9fff\-./]+\.\w{1,10}/g) ?? [];
          return matches
            .filter((m) => /\.(md|txt|json|yaml|yml|html|csv|pdf|py|sh|ts|js|sql)$/i.test(m))
            .filter((m) => !m.startsWith("http"))
            .slice(0, 5);
        })()
      : [];
  const changedText =
    changedPreview.length > 0
      ? `产物文件:\n${changedPreview.map((file) => `- ${file}`).join("\n")}`
      : outputMentionedFiles.length > 0
        ? `产物文件（工具自述，未经系统验证）:\n${outputMentionedFiles.map((f) => `- ${f}`).join("\n")}`
        : "产物文件: 未检测到文件变更（请人工确认工作目录）。";
  const normalizedOutput = input.outputText.trim();
  const outputText =
    normalizedOutput.length > 0
      ? `执行摘要:\n${capText(normalizedOutput, 3600)}`
      : "执行摘要:\n工具未返回可读文本结果。";
  const summary =
    input.changedFiles.length > 0
      ? `开发任务已执行（${input.providerId}），落地 ${input.changedFiles.length} 个文件`
      : `开发任务已执行（${input.providerId}），请确认产物文件`;
  return {
    result: {
      summary,
      deliverable: capText([changedText, "", outputText].join("\n"), 5000),
      citations: [],
      followUps: [
        "Review the generated code/output in workspace.",
        "Run project-specific tests before merge.",
        "If needed, request another iteration with narrower acceptance criteria."
      ]
    },
    reflection: {
      score: 7,
      confidence: "medium",
      assumptions: [
        "The chosen tool provider produced actionable output for the requested task.",
        "Workspace state remained consistent during execution."
      ],
      risks: [
        "Tool output may include partial changes that still require manual verification.",
        "Provider behavior can vary across model/tool versions."
      ],
      improvements: [
        "Add deterministic post-run checks for changed files and test status.",
        "Attach richer execution metadata in dashboard for faster review."
      ]
    }
  };
}

async function runToolCommand(input: {
  providerId: ToolProviderId;
  command: string;
  args: string[];
  timeoutMs: number;
  workspaceRoot: string;
  opencodeBaseUrl?: string | undefined;
  runtimeSecrets: Record<string, string>;
}): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  noOutputTimedOut: boolean;
  noProgressTimedOut: boolean;
}> {
  const safeSecrets = Object.fromEntries(
    Object.entries(input.runtimeSecrets).filter(([key, value]) => /^[A-Z0-9_]+$/.test(key) && value.trim().length > 0)
  );
  const childEnv = {
    ...process.env,
    ...safeSecrets,
    ...(env.opencodeApiKey ? { OPENCODE_API_KEY: env.opencodeApiKey } : {}),
    ...(env.zhipuApiKey ? { ZHIPUAI_API_KEY: env.zhipuApiKey } : {}),
    ...(env.openaiApiKey && input.providerId !== "opencode" ? { OPENAI_API_KEY: env.openaiApiKey } : {}),
    ...(env.anthropicApiKey ? { ANTHROPIC_API_KEY: env.anthropicApiKey } : {}),
    ...(input.opencodeBaseUrl && input.providerId === "opencode" ? { OPENAI_BASE_URL: input.opencodeBaseUrl } : {})
  };

  return await new Promise((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      cwd: input.workspaceRoot,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"]
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let noOutputTimedOut = false;
    let noProgressTimedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let noOutputTimer: NodeJS.Timeout | undefined;
    let noProgressTimer: NodeJS.Timeout | undefined;

    const resetNoOutputTimer = (): void => {
      if (noOutputTimer) {
        clearTimeout(noOutputTimer);
      }
      noOutputTimer = setTimeout(() => {
        if (settled) {
          return;
        }
        noOutputTimedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => {
          if (!settled) {
            child.kill("SIGKILL");
          }
        }, 1500);
      }, toolRunNoOutputTimeoutMs);
    };

    const resetNoProgressTimer = (): void => {
      if (noProgressTimer) {
        clearTimeout(noProgressTimer);
      }
      noProgressTimer = setTimeout(() => {
        if (settled) {
          return;
        }
        noProgressTimedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => {
          if (!settled) {
            child.kill("SIGKILL");
          }
        }, 1500);
      }, toolRunNoProgressTimeoutMs);
    };

    const settle = (result: {
      exitCode: number;
      stdout: string;
      stderr: string;
      timedOut: boolean;
      noOutputTimedOut: boolean;
      noProgressTimedOut: boolean;
    }): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      if (noOutputTimer) {
        clearTimeout(noOutputTimer);
      }
      if (noProgressTimer) {
        clearTimeout(noProgressTimer);
      }
      resolve(result);
    };

    resetNoOutputTimer();
    resetNoProgressTimer();
    child.stdout.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutChunks.push(buffer);
      resetNoOutputTimer();
      if (hasMeaningfulToolProgress(input.providerId, buffer.toString("utf8"))) {
        resetNoProgressTimer();
      }
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stderrChunks.push(buffer);
      resetNoOutputTimer();
      if (hasMeaningfulToolProgress(input.providerId, buffer.toString("utf8"))) {
        resetNoProgressTimer();
      }
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      if (noOutputTimer) {
        clearTimeout(noOutputTimer);
      }
      if (noProgressTimer) {
        clearTimeout(noProgressTimer);
      }
      reject(error);
    });
    child.on("close", (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      settle({
        exitCode: typeof code === "number" ? code : 1,
        stdout,
        stderr,
        timedOut,
        noOutputTimedOut,
        noProgressTimedOut
      });
    });

    timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) {
          child.kill("SIGKILL");
        }
      }, 1500);
    }, input.timeoutMs);
  });
}

async function ensureToolRunApproval(task: TaskRecord, toolRun: ToolRunRecord): Promise<{
  state: "approved" | "pending";
  approvedRun?: ToolRunRecord | undefined;
}> {
  const policy = store.getRuntimeConfig().tools;
  const needsOwnerApproval =
    policy.approvalMode === "manual_owner" ||
    (policy.approvalMode === "cto_auto_owner_fallback" && toolRun.riskLevel === "high");

  if (!needsOwnerApproval) {
    const approved = store.markToolRunAutoApproved(toolRun.id, policy.ctoRoleId);
    return {
      state: "approved",
      approvedRun: approved
    };
  }

  const approval = store.createApproval({
    kind: "task_execution",
    taskId: task.id,
    summary: `Tool execution approval required (${toolRun.providerId}, risk=${toolRun.riskLevel})`,
    payload: {
      taskId: task.id,
      toolRunId: toolRun.id,
      providerId: toolRun.providerId,
      command: toolRun.command,
      args: toolRun.args,
      riskLevel: toolRun.riskLevel,
      roleId: task.roleId
    },
    requestedBy: task.requestedBy
  });
  const workflow = store.ensureApprovalWorkflow(
    approval.id,
    toolRun.riskLevel === "high" ? ["cto", "ceo"] : ["cto"]
  );
  store.markToolRunApprovalPending(toolRun.id, approval.id);
  store.markTaskWaitingApproval(
    task.id,
    `Waiting approval ${approval.id} for ${toolRun.providerId} (risk=${toolRun.riskLevel})`
  );

  const firstStep = workflow.steps[0];
  if (firstStep) {
    await notifyFeishuApprovalStep({
      approvalId: approval.id,
      stepId: firstStep.id,
      roleId: firstStep.roleId,
      summary: approval.summary,
      requestedBy: approval.requestedBy
    });
  }

  return {
    state: "pending"
  };
}

async function executeApprovedToolRun(task: TaskRecord, toolRun: ToolRunRecord): Promise<{
  ok: boolean;
  outputText: string;
  changedFiles: string[];
  errorText?: string | undefined;
}> {
  const started = store.startToolRun(toolRun.id) ?? toolRun;
  const config = store.getRuntimeConfig();
  const runtimeSecrets = store.getRuntimeSecrets();
  const opencodeBaseUrl = config.tools.providerBaseUrls.opencode ?? env.opencodeBaseUrl;
  const effectiveTimeoutMs = resolveToolRunTimeoutMs(task, config.tools.timeoutMs);
  const runResult = await runToolCommand({
    providerId: started.providerId,
    command: started.command,
    args: started.args,
    timeoutMs: effectiveTimeoutMs,
    workspaceRoot: env.workspaceRoot,
    opencodeBaseUrl,
    runtimeSecrets
  });

  const outputText = extractToolOutput(started.providerId, runResult.stdout, runResult.stderr);
  const providerError = detectToolProviderError(started.providerId, runResult.stdout);
  const workspaceBoundaryError = detectWorkspaceBoundaryError(runResult.stdout, runResult.stderr);
  const changedFiles = listWorkspaceArtifactsModifiedSince(started.startedAt ?? started.createdAt, 60);
  if (
    runResult.exitCode === 0 &&
    !runResult.timedOut &&
    !runResult.noOutputTimedOut &&
    !runResult.noProgressTimedOut &&
    !providerError
  ) {
    store.completeToolRun(started.id, outputText);
    return {
      ok: true,
      outputText,
      changedFiles
    };
  }

  const errorText = capText(
    [
      workspaceBoundaryError ?? "",
      providerError ?? "",
      runResult.noProgressTimedOut
        ? `Tool produced no meaningful progress for ${toolRunNoProgressTimeoutMs}ms and was terminated`
        : runResult.noOutputTimedOut
        ? `Tool produced no output for ${toolRunNoOutputTimeoutMs}ms and was terminated`
        : runResult.timedOut
          ? `Tool execution timed out (${effectiveTimeoutMs}ms)`
          : `Tool exited with code ${runResult.exitCode}`,
      summarizeToolFailureLogs({
        providerId: started.providerId,
        stdout: runResult.stdout,
        stderr: runResult.stderr
      })
    ]
      .filter(Boolean)
      .join("\n\n"),
    6000
  );
  store.failToolRun(started.id, errorText);
  return {
    ok: false,
    outputText,
    changedFiles,
    errorText
  };
}

async function completeToolTask(
  task: TaskRecord,
  providerId: ToolProviderId,
  outputText: string,
  changedFiles: string[]
): Promise<void> {
  const normalizedChangedFiles = dedupeSortedStrings(changedFiles.flatMap((file) => extractArtifactFilesFromText(file)));
  const completion = buildToolTaskResult({
    task,
    providerId,
    outputText,
    changedFiles: normalizedChangedFiles
  });
  const completed = store.completeTask(task.id, completion.result, completion.reflection);
  if (completed) {
    store.patchTaskMetadata(completed.id, {
      toolProviderId: providerId,
      toolChangedFiles: normalizedChangedFiles
    });
  }
  if (completed?.sessionId) {
    store.appendSessionMessage({
      sessionId: completed.sessionId,
      actorType: "role",
      actorId: completed.roleId,
      roleId: completed.roleId,
      messageType: "text",
      content: `${completion.result.summary}\n\n${completion.result.deliverable.slice(0, 1200)}`,
      metadata: {
        taskId: completed.id,
        providerId
      }
    });
  }
  if (completed?.source === "feishu" && completed.chatId) {
    const message = [
      `${completed.title}`,
      completion.result.summary,
      "",
      completion.result.deliverable.slice(0, 1200)
    ].join("\n");
    await notifyFeishu(completed.chatId, message);
  }
}

async function processCodeExecutionTask(task: TaskRecord): Promise<boolean> {
  const config = store.getRuntimeConfig();
  const runtimeSecrets = store.getRuntimeSecrets();
  const queuedRun = store.getQueuedExecutableToolRunForTask(task.id);
  if (queuedRun) {
    const executed = await executeApprovedToolRun(task, queuedRun);
    if (executed.ok) {
      await completeToolTask(task, queuedRun.providerId, executed.outputText, executed.changedFiles);
      return true;
    }

    if (queuedRun.riskLevel === "high") {
      store.failTask(task.id, executed.errorText ?? "Approved high-risk tool run failed.");
      return true;
    }
  }

  const statuses = listToolProviderStatuses(env, config.tools, runtimeSecrets);
  const providers = selectAvailableProviders(config.tools, statuses);
  if (providers.length === 0) {
    store.failTask(task.id, "No tool provider is available. Install opencode/codex/claude binary first.");
    return true;
  }

  const riskLevel = detectToolRiskLevel(task.instruction, config.tools);
  let lastError = "";

  for (const provider of providers) {
    const instructions = [buildWorkspaceConstrainedInstruction(task.instruction)];
    if (provider.providerId === "opencode") {
      instructions.push(buildWorkspaceStrictRetryInstruction(task.instruction));
    }
    for (let attemptIndex = 0; attemptIndex < instructions.length; attemptIndex += 1) {
      const instruction = instructions[attemptIndex] ?? task.instruction;
      const commandSpec = buildToolCommand({
        providerId: provider.providerId,
        instruction,
        workspaceRoot: env.workspaceRoot,
        statuses,
        enableThinking: provider.providerId === "opencode" ? attemptIndex === 0 : undefined,
        modelId:
          provider.providerId === "opencode"
            ? config.tools.providerModels.opencode ?? env.opencodeModel
            : config.tools.providerModels[provider.providerId]
      });
      if (!commandSpec) {
        continue;
      }

      const toolRun = store.createToolRun({
        taskId: task.id,
        roleId: task.roleId,
        providerId: provider.providerId,
        title: attemptIndex === 0 ? task.title : `${task.title} (retry-${attemptIndex})`,
        instruction,
        command: commandSpec.command,
        args: commandSpec.args,
        riskLevel,
        requestedBy: task.requestedBy,
        status: "queued",
        approvalStatus: "not_required"
      });

      const approval = await ensureToolRunApproval(task, toolRun);
      if (approval.state === "pending") {
        return true;
      }

      const executableRun = approval.approvedRun ?? store.getToolRun(toolRun.id) ?? toolRun;
      const executed = await executeApprovedToolRun(task, executableRun);
      if (executed.ok) {
        await completeToolTask(task, provider.providerId, executed.outputText, executed.changedFiles);
        return true;
      }

      lastError = executed.errorText ?? "unknown tool execution error";
      if (!isWorkspaceBoundaryErrorText(lastError)) {
        break;
      }
    }
  }

  store.failTask(task.id, lastError || "All available tool providers failed.");
  return true;
}

async function processNormalTask(task: TaskRecord): Promise<boolean> {
  const config = store.getRuntimeConfig();
  const runtimeSecrets = store.getRuntimeSecrets();
  const skills = store.resolveSkillsForRole(task.roleId);
  const skillIds = skills.map((skill) => skill.skillId);
  const memoryBackend = config.memory.roleBackends[task.roleId] ?? config.memory.defaultBackend;
  const preferSemanticRetrieval = memoryBackend === "vector-db";
  const snippets = await knowledgeBase.retrieve(task.instruction, 5, {
    keywordWeight: preferSemanticRetrieval ? 0.45 : 0.7,
    semanticWeight: preferSemanticRetrieval ? 0.55 : 0.3,
    minSemanticScore: preferSemanticRetrieval ? 0.05 : 0.1
  });
  // Pre-fetch web search only when tool calling is NOT available (local-only mode without zhipu)
  const hasToolCallingBackend = env.primaryBackend === "zhipu" || env.primaryBackend === "sglang";
  const webSearchSnippets =
    !hasToolCallingBackend && skillIds.includes("web-search")
      ? await retrieveWebSearchSnippets(task, skillIds)
      : [];
  const runtimeSnippets = buildRuntimeContextSnippets(task);
  const sessionSnippets = buildSessionContextSnippets(task);
  const conversationHistory = buildConversationHistory(task);
  const runtimeTask =
    task.source === "feishu"
      ? {
          ...task,
          instruction: buildFeishuExecutionInstruction(task.instruction)
        }
      : task;

  // Build tool context so the agent can call tools autonomously
  const searchProvider = resolveSearchProviderId(store.getRuntimeSettings()["SEARCH_PROVIDER"]) ?? "";
  const toolContext = {
    workDir: buildWorkDir(env.workspaceRoot, task.id),
    secrets: runtimeSecrets,
    searchProvider
  };

  const output = await runtime.execute({
    task: runtimeTask,
    config,
    skills,
    snippets: [...runtimeSnippets, ...sessionSnippets, ...webSearchSnippets, ...snippets],
    toolContext,
    conversationHistory
  });

  const rawMessage = `${output.result.summary}\n\n${output.result.deliverable.slice(0, 1200)}`;
  const userFacingMessage =
    task.source === "feishu"
      ? condenseFeishuReplyIfNeeded({
          instruction: task.instruction,
          message: sanitizeFeishuReplyText(rawMessage)
        })
      : rawMessage;
  // Persist any files created by tool calls (run_code / write_file) to task metadata
  if (output.artifactFiles.length > 0) {
    store.patchTaskMetadata(task.id, { toolChangedFiles: output.artifactFiles });
  }
  const completed = store.completeTask(task.id, output.result, output.reflection);
  if (completed?.sessionId) {
    store.appendSessionMessage({
      sessionId: completed.sessionId,
      actorType: "role",
      actorId: completed.roleId,
      roleId: completed.roleId,
      messageType: "text",
      content: userFacingMessage,
      metadata: {
        taskId: completed.id
      }
    });
  }
  if (completed?.source === "feishu" && completed.chatId) {
    const message = [`${completed.title}`, userFacingMessage].join("\n");
    await notifyFeishu(completed.chatId, message);
    // If instruction asked to "send me" the file, upload and send artifacts
    if (shouldSendArtifactsToFeishu(completed.instruction)) {
      const allArtifacts = collectTaskArtifactFiles(completed);
      await sendArtifactsToFeishuChat(completed.chatId, allArtifacts);
    }
  }

  return true;
}

function resolveGoalRunLocale(run: GoalRunRecord): "zh" | "en" {
  if (/[\u4e00-\u9fff]/u.test(run.objective)) {
    return "zh";
  }
  return run.language.toLowerCase().startsWith("zh") ? "zh" : "en";
}

function normalizeSmalltalkInstruction(text: string): string {
  let normalized = text.trim();
  if (!normalized) {
    return "";
  }
  const stripPatterns = [
    /^@[\w\u4e00-\u9fa5-]{1,32}\s*/i,
    /^[\w\u4e00-\u9fa5-]{1,32}\s*[:：]\s*/i
  ];
  for (const pattern of stripPatterns) {
    const next = normalized.replace(pattern, "").trim();
    if (next && next !== normalized) {
      normalized = next;
    }
  }
  return normalized;
}

function buildWorkspaceConstrainedInstruction(instruction: string): string {
  return [
    instruction.trim(),
    "",
    `执行约束:`,
    "- 输出结构必须包含：结论、关键依据、下一步行动（不超过 3 条）。",
    `- 仅可在工作目录 ${env.workspaceRoot} 内读写文件。`,
    "- 严禁访问或操作任何目录外路径。",
    "- 完成后必须输出实际变更文件路径（相对工作目录）。"
  ].join("\n");
}

function buildWorkspaceStrictRetryInstruction(instruction: string): string {
  return [
    instruction.trim(),
    "",
    `重试约束(严格):`,
    "- 输出结构必须包含：结论、关键依据、下一步行动（不超过 3 条）。",
    `- 只允许使用当前目录 ${env.workspaceRoot}。`,
    "- 禁止请求 external_directory 权限。",
    "- 如果无法完成，直接说明阻塞原因并停止。"
  ].join("\n");
}

function detectWorkspaceBoundaryError(stdout: string, stderr: string): string | undefined {
  const merged = `${stdout}\n${stderr}`;
  if (/permission requested:\s*external_directory/i.test(merged) || /auto-rejecting/i.test(merged)) {
    return "Tool requested external directory permission and was auto-rejected.";
  }
  return undefined;
}

function isWorkspaceBoundaryErrorText(text: string): boolean {
  return /external[_\s-]?directory|auto-rejecting|directory permission/i.test(text);
}

function isFeishuSmalltalkInstruction(text: string): boolean {
  const normalized = normalizeSmalltalkInstruction(text);
  if (!normalized) {
    return false;
  }
  if (FEISHU_SMALLTALK_ACTION_PATTERN.test(normalized)) {
    return false;
  }
  const compact = normalized.toLowerCase().replace(/[，。！？!?,.~～\s]/g, "");
  return FEISHU_SMALLTALK_ONLY_PATTERN.test(compact);
}

function buildFeishuSmalltalkResponse(text: string): string {
  const compact = normalizeSmalltalkInstruction(text).toLowerCase().replace(/[，。！？!?,.~～\s]/g, "");
  if (/^(?:谢谢|多谢|thx|thanks|thankyou|辛苦了)/i.test(compact)) {
    return "不客气，我在。你可以直接告诉我接下来要处理的任务。";
  }
  if (/^(?:在吗|在不在)/i.test(compact)) {
    return "在的，我在线。你可以直接下达任务。";
  }
  return "你好，我在。你可以直接说你的需求。";
}

function contextString(context: Record<string, unknown>, key: string): string | undefined {
  const value = context[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function contextStringArray(context: Record<string, unknown>, key: string): string[] {
  const value = context[key];
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  if (typeof value === "string" && value.trim()) {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return [];
}

function contextBoolean(context: Record<string, unknown>, key: string): boolean | undefined {
  const value = context[key];
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1" || normalized === "yes") {
      return true;
    }
    if (normalized === "false" || normalized === "0" || normalized === "no") {
      return false;
    }
  }
  return undefined;
}

function normalizeArtifactPath(input: string): string | undefined {
  let candidate = input.trim();
  if (!candidate) {
    return undefined;
  }
  candidate = candidate.replace(/^[`"'()[\]{}<]+|[`"',;()[\]{}>]+$/g, "").trim();
  if (!candidate) {
    return undefined;
  }
  if (/^(?:https?:\/\/|data:|mailto:|tel:)/i.test(candidate)) {
    return undefined;
  }
  candidate = candidate.replaceAll("\\", "/");
  if (path.isAbsolute(candidate)) {
    const normalizedAbsolute = path.normalize(candidate);
    const normalizedRoot = path.normalize(env.workspaceRoot);
    if (!normalizedAbsolute.startsWith(normalizedRoot)) {
      return undefined;
    }
    candidate = path.relative(env.workspaceRoot, normalizedAbsolute);
  }
  candidate = candidate.replace(/^\.\//, "").trim();
  if (!candidate || candidate.startsWith("../")) {
    return undefined;
  }
  const ext = path.extname(candidate).toLowerCase();
  if (!ARTIFACT_FILE_EXTENSIONS.has(ext)) {
    return undefined;
  }
  const normalized = path.normalize(candidate).replaceAll(path.sep, "/");
  if (!normalized || normalized.startsWith("../")) {
    return undefined;
  }
  return normalized;
}

function dedupeSortedStrings(values: string[]): string[] {
  return Array.from(
    new Set(
      values
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
    )
  ).sort((left, right) => left.localeCompare(right));
}

function extractArtifactFilesFromText(text: string): string[] {
  if (!text.trim()) {
    return [];
  }
  const found: string[] = [];
  const changedFilesPattern = /CHANGED_FILES\s*:\s*([^\n]+)/gi;
  for (const match of text.matchAll(changedFilesPattern)) {
    const group = match[1] ?? "";
    const pieces = group.split(/[,\s]+/);
    for (const piece of pieces) {
      const normalized = normalizeArtifactPath(piece);
      if (normalized) {
        found.push(normalized);
      }
    }
  }
  const genericPathPattern = /(?:^|[\s`"'(])((?:\.{0,2}\/)?(?:[\w.-]+\/)*[\w.-]+\.[a-zA-Z0-9]{1,8})(?=$|[\s`"'),:;])/g;
  for (const match of text.matchAll(genericPathPattern)) {
    const normalized = normalizeArtifactPath(match[1] ?? "");
    if (normalized) {
      found.push(normalized);
    }
  }
  return dedupeSortedStrings(found);
}

function normalizeRoleId(value: string | undefined): RoleId | undefined {
  if (!value) {
    return undefined;
  }
  const candidate = value.trim() as RoleId;
  return KNOWN_ROLE_IDS.has(candidate) ? candidate : undefined;
}

function dedupeSortedRoles(values: RoleId[]): RoleId[] {
  return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right));
}

function inferRequiredRolesFromObjective(objective: string): RoleId[] {
  const required = new Set<RoleId>();
  const normalized = objective.toLowerCase();
  if (/(前端|页面|网页|官网|web|website|landing|ui|ux|小游戏|game|app)/i.test(objective)) {
    required.add("frontend");
  }
  if (/(后端|接口|api|数据库|服务端|backend|server|database|db)/i.test(objective)) {
    required.add("backend");
  }
  if (/(测试|验收|回归|qa|test|testing|e2e|unit\s*test)/i.test(objective)) {
    required.add("qa");
  }
  if (required.size === 0 && /(build|implement|develop|create|generate|代码|开发|实现|构建)/i.test(normalized)) {
    required.add("frontend");
  }
  return dedupeSortedRoles(Array.from(required));
}

function collectTaskArtifactFiles(task: TaskRecord): string[] {
  const metadata = task.metadata as {
    toolChangedFiles?: unknown;
  };
  const metadataFilesRaw = metadata.toolChangedFiles;
  const metadataFiles = Array.isArray(metadataFilesRaw)
    ? metadataFilesRaw
        .filter((item): item is string => typeof item === "string")
        .flatMap((item) => extractArtifactFilesFromText(item))
    : typeof metadataFilesRaw === "string"
      ? extractArtifactFilesFromText(metadataFilesRaw)
      : [];
  const resultFiles = extractArtifactFilesFromText(
    [task.result?.summary ?? "", task.result?.deliverable ?? ""].filter(Boolean).join("\n")
  );
  const toolRunFiles = store
    .listToolRunsByTask(task.id)
    .flatMap((toolRun) => extractArtifactFilesFromText([toolRun.outputText ?? "", toolRun.errorText ?? ""].join("\n")));
  return dedupeSortedStrings([...metadataFiles, ...resultFiles, ...toolRunFiles]);
}

function collectGoalExecutionEvidence(task: TaskRecord): {
  artifactFiles: string[];
  completedRoles: RoleId[];
  failedRoles: RoleId[];
  collaborationEnabled: boolean;
} {
  const taskMetadata = task.metadata as {
    collaborationMode?: boolean;
    collaborationId?: string;
    isAggregation?: boolean;
  };
  const collaborationId =
    typeof taskMetadata.collaborationId === "string" && taskMetadata.collaborationId.trim().length > 0
      ? taskMetadata.collaborationId.trim()
      : undefined;
  const collaborationEnabled = Boolean(taskMetadata.collaborationMode || collaborationId);
  const artifactFiles = collectTaskArtifactFiles(task);
  if (!collaborationEnabled) {
    return {
      artifactFiles,
      completedRoles: task.status === "completed" ? [task.roleId] : [],
      failedRoles: task.status === "failed" || task.status === "cancelled" ? [task.roleId] : [],
      collaborationEnabled
    };
  }

  const children = store.listTaskChildren(task.id).filter((child) => {
    const childMetadata = child.metadata as {
      collaborationId?: string;
      isAggregation?: boolean;
    };
    if (childMetadata.isAggregation) {
      return false;
    }
    if (collaborationId) {
      return childMetadata.collaborationId === collaborationId;
    }
    return Boolean(childMetadata.collaborationId);
  });
  const completedRoles: RoleId[] = [];
  const failedRoles: RoleId[] = [];
  const childFiles: string[] = [];
  for (const child of children) {
    if (child.status === "completed") {
      completedRoles.push(child.roleId);
    }
    if (child.status === "failed" || child.status === "cancelled") {
      failedRoles.push(child.roleId);
    }
    childFiles.push(...collectTaskArtifactFiles(child));
  }
  return {
    artifactFiles: dedupeSortedStrings([...artifactFiles, ...childFiles]),
    completedRoles: dedupeSortedRoles(completedRoles),
    failedRoles: dedupeSortedRoles(failedRoles),
    collaborationEnabled
  };
}

function shouldPushGoalRunCollaborationHeartbeat(goalRunId: string): boolean {
  const nowMs = Date.now();
  const last = goalRunCollabLastHeartbeatMs.get(goalRunId) ?? 0;
  if (nowMs - last < goalRunCollabHeartbeatMs) {
    return false;
  }
  goalRunCollabLastHeartbeatMs.set(goalRunId, nowMs);
  if (goalRunCollabLastHeartbeatMs.size > 4000) {
    const oldestKey = goalRunCollabLastHeartbeatMs.keys().next().value as string | undefined;
    if (oldestKey) {
      goalRunCollabLastHeartbeatMs.delete(oldestKey);
    }
  }
  return true;
}

function formatCollaborationStatusLabel(status: TaskRecord["status"]): string {
  switch (status) {
    case "completed":
      return "已完成";
    case "running":
      return "进行中";
    case "queued":
    case "waiting_approval":
      return "待处理";
    case "failed":
    case "cancelled":
      return "受阻";
    default:
      return status;
  }
}

function formatHeartbeatRoleLabel(roleId: RoleId): string {
  switch (roleId) {
    case "product":
      return "产品";
    case "uiux":
      return "设计";
    case "frontend":
      return "前端";
    case "backend":
      return "后端";
    case "qa":
      return "测试";
    case "ceo":
      return "CEO";
    case "cto":
      return "CTO";
    case "developer":
      return "开发";
    case "engineering":
      return "工程";
    case "research":
      return "研究";
    case "operations":
      return "运营";
    case "algorithm":
      return "算法";
    default:
      return roleId;
  }
}

function compactHeartbeatText(text: string, maxLength = 26): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(1, maxLength - 1))}…`;
}

function extractCollaborationHighlight(task: TaskRecord): string | undefined {
  const metadata = task.metadata as { toolChangedFiles?: unknown };
  const metadataFiles = Array.isArray(metadata.toolChangedFiles)
    ? metadata.toolChangedFiles
        .filter((entry): entry is string => typeof entry === "string")
        .flatMap((entry) => extractArtifactFilesFromText(entry))
    : typeof metadata.toolChangedFiles === "string"
      ? extractArtifactFilesFromText(metadata.toolChangedFiles)
      : [];
  const resultFiles = extractArtifactFilesFromText(`${task.result?.summary ?? ""}\n${task.result?.deliverable ?? ""}`);
  const toolRuns = store.listToolRunsByTask(task.id);
  const toolRunFiles = toolRuns.flatMap((entry) => extractArtifactFilesFromText(`${entry.outputText ?? ""}\n${entry.errorText ?? ""}`));
  const files = dedupeSortedStrings([...metadataFiles, ...resultFiles, ...toolRunFiles]).slice(0, 2);
  const latestToolRun = toolRuns.slice().sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  const commandDigest = latestToolRun
    ? latestToolRun.status === "completed"
      ? `命令成功(${latestToolRun.providerId})`
      : latestToolRun.status === "failed"
        ? `命令失败(${latestToolRun.providerId})`
        : latestToolRun.status === "running"
          ? `命令执行中(${latestToolRun.providerId})`
          : ""
    : "";
  const summaryDigest =
    compactHeartbeatText(task.result?.summary ?? "", 24) || compactHeartbeatText(task.errorText ?? "", 24);
  const segments: string[] = [];
  if (files.length > 0) {
    segments.push(`文件:${files.join(",")}`);
  }
  if (commandDigest) {
    segments.push(commandDigest);
  }
  if (summaryDigest) {
    segments.push(summaryDigest);
  }
  const combined = segments.join(" | ");
  return compactHeartbeatText(combined, 38) || undefined;
}

function buildGoalRunCollaborationHeartbeat(task: TaskRecord): string | undefined {
  const metadata = task.metadata as {
    collaborationId?: string;
    collaborationMode?: boolean;
  };
  const collaborationId =
    typeof metadata.collaborationId === "string" && metadata.collaborationId.trim().length > 0
      ? metadata.collaborationId.trim()
      : undefined;
  if (!collaborationId && !metadata.collaborationMode) {
    return undefined;
  }

  const children = store.listTaskChildren(task.id).filter((child) => {
    const childMetadata = child.metadata as {
      collaborationId?: string;
      isAggregation?: boolean;
    };
    if (childMetadata.isAggregation) {
      return false;
    }
    if (collaborationId) {
      return childMetadata.collaborationId === collaborationId;
    }
    return Boolean(childMetadata.collaborationId);
  });
  if (children.length === 0) {
    return "协作执行中：团队已启动，正在分配子任务。";
  }

  const completed = children.filter((child) => child.status === "completed");
  const failed = children.filter((child) => child.status === "failed" || child.status === "cancelled");
  const running = children.filter((child) => child.status === "running");
  const pending = children.filter((child) => child.status === "queued" || child.status === "waiting_approval");

  const latestByRole = new Map<RoleId, TaskRecord>();
  for (const child of children) {
    const previous = latestByRole.get(child.roleId);
    if (!previous || previous.updatedAt.localeCompare(child.updatedAt) < 0) {
      latestByRole.set(child.roleId, child);
    }
  }
  const snapshots = Array.from(latestByRole.values())
    .sort((left, right) => left.roleId.localeCompare(right.roleId))
    .slice(0, 6)
    .map((entry) => {
      const status = formatCollaborationStatusLabel(entry.status);
      const highlight = extractCollaborationHighlight(entry);
      const label = formatHeartbeatRoleLabel(entry.roleId);
      return highlight ? `${label} ${status}:${highlight}` : `${label} ${status}`;
    });
  const roleDigest = snapshots.join("；");

  return [
    `协作执行中：已完成 ${completed.length}/${children.length}${failed.length > 0 ? `，受阻 ${failed.length}` : ""}`,
    running.length > 0 ? `进行中：${running.map((item) => item.roleId).join("、")}` : "",
    pending.length > 0 ? `待处理：${pending.map((item) => item.roleId).join("、")}` : "",
    roleDigest ? `角色动态：${roleDigest}` : ""
  ]
    .filter((item) => item.length > 0)
    .join("\n");
}

function shouldRetryCollaborationExecutionFailure(input: {
  task: TaskRecord;
  completedRoles: RoleId[];
  failedRoles: RoleId[];
}): boolean {
  if (!goalRunCollabRetryEnabled) {
    return false;
  }
  if (input.failedRoles.length === 0) {
    return false;
  }
  const errorText = (input.task.errorText ?? "").toLowerCase();
  const transientFailure =
    /timeout|timed out|超时|database is locked|temporar|transient|rate limit|429|network|econn|unavailable/.test(
      errorText
    );
  if (transientFailure) {
    return true;
  }
  if (input.completedRoles.length > 0) {
    return true;
  }
  const criticalRoles = new Set<RoleId>(["product", "uiux", "frontend", "backend", "qa"]);
  return input.failedRoles.some((roleId) => criticalRoles.has(roleId));
}

function parseIsoMs(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function goalRunNeedsConcreteArtifacts(run: GoalRunRecord): boolean {
  return GOAL_RUN_ARTIFACT_OBJECTIVE_PATTERN.test(run.objective);
}

function listWorkspaceArtifactsModifiedSince(sinceIso: string | undefined, limit = 80): string[] {
  const sinceMs = parseIsoMs(sinceIso);
  if (sinceMs === undefined) {
    return [];
  }

  const stack: string[] = [env.workspaceRoot];
  const files: string[] = [];

  while (stack.length > 0 && files.length < limit) {
    const currentDir = stack.pop();
    if (!currentDir) {
      continue;
    }
    let entries;
    try {
      entries = readdirSync(currentDir, { withFileTypes: true, encoding: "utf8" });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (files.length >= limit) {
        break;
      }
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        if (ARTIFACT_SCAN_IGNORED_DIRS.has(entry.name)) {
          continue;
        }
        if (entry.name.startsWith(".") && entry.name !== ".vinko") {
          continue;
        }
        stack.push(path.join(currentDir, entry.name));
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const extension = path.extname(entry.name).toLowerCase();
      if (!ARTIFACT_FILE_EXTENSIONS.has(extension)) {
        continue;
      }

      const absolutePath = path.join(currentDir, entry.name);
      let modifiedMs = 0;
      try {
        modifiedMs = statSync(absolutePath).mtimeMs;
      } catch {
        continue;
      }
      if (modifiedMs < sinceMs) {
        continue;
      }
      files.push(path.relative(env.workspaceRoot, absolutePath).replaceAll(path.sep, "/"));
    }
  }

  files.sort((left, right) => left.localeCompare(right));
  return files;
}

function buildGoalRunPlan(run: GoalRunRecord): Record<string, unknown> {
  const locale = resolveGoalRunLocale(run);
  if (locale === "zh") {
    return {
      objective: run.objective,
      phases: [
        "澄清业务目标与约束",
        "拆分可执行工作包",
        "执行与中间验证",
        "部署准备与上线检查",
        "最终交付与复盘"
      ],
      acceptance: ["需求目标达成", "关键风险可控", "交付内容可复用"]
    };
  }
  return {
    objective: run.objective,
    phases: [
      "Clarify constraints and success criteria",
      "Create executable work packages",
      "Execute and validate incrementally",
      "Prepare deployment and launch checks",
      "Deliver final report and follow-ups"
    ],
    acceptance: ["Goal achieved", "Risks controlled", "Deliverables reusable"]
  };
}

function requiresWebsiteClarification(run: GoalRunRecord): string[] {
  const objective = run.objective.toLowerCase();
  if (!/(网站|官网|landing page|website|web site)/i.test(objective)) {
    return [];
  }
  const required = ["company_name", "business_domain", "target_audience"];
  return required.filter((key) => !contextString(run.context, key));
}

/**
 * Returns field names that must be clarified before planning can proceed for
 * data-analysis / report goals. Only fires when the objective is clearly about
 * analysing a dataset and the data source has not been provided yet.
 */
function requiresDataAnalysisClarification(run: GoalRunRecord): string[] {
  const objective = run.objective;
  if (!/(数据分析|数据报告|analyse|analyze|data analysis|数据集|dataset|csv|excel|报表|report from data)/i.test(objective)) {
    return [];
  }
  const required = ["data_source"];
  return required.filter((key) => !contextString(run.context, key));
}

/**
 * Returns field names needed for API-integration goals when the target service
 * has not been specified in the context.
 */
function requiresApiIntegrationClarification(run: GoalRunRecord): string[] {
  const objective = run.objective;
  if (!/(对接|集成|接入|integrate|connect to|接口对接|api integration)/i.test(objective)) {
    return [];
  }
  if (/企业微信|feishu|飞书|slack|notion|jira/i.test(objective)) {
    // Target service is inferred from the objective itself — no clarification needed
    return [];
  }
  const required = ["target_service"];
  return required.filter((key) => !contextString(run.context, key));
}

/** Combined discover-stage clarification check across all goal types. */
function requiresDiscoverClarification(run: GoalRunRecord): string[] {
  return (
    requiresWebsiteClarification(run) ||
    requiresDataAnalysisClarification(run) ||
    requiresApiIntegrationClarification(run)
  );
}

function formatGoalInputFieldForPrompt(field: string, locale: "zh" | "en"): string {
  if (locale !== "zh") {
    return field;
  }
  switch (field) {
    case "company_name":
      return "公司名称(company_name)";
    case "business_domain":
      return "业务方向(business_domain)";
    case "target_audience":
      return "目标用户(target_audience)";
    case "deploy_target":
      return "部署目标(deploy_target)";
    case "data_source":
      return "数据来源/数据文件(data_source)";
    case "target_service":
      return "目标服务/平台(target_service)";
    default:
      return field;
  }
}

function formatGoalInputFieldsForPrompt(fields: string[], locale: "zh" | "en"): string {
  const normalized = fields.map((field) => field.trim()).filter(Boolean);
  if (normalized.length === 0) {
    return locale === "zh" ? "关键信息" : "required inputs";
  }
  return normalized.map((field) => formatGoalInputFieldForPrompt(field, locale)).join(locale === "zh" ? "、" : ", ");
}

function wantsDeployment(run: GoalRunRecord): boolean {
  const objective = run.objective;
  const mentionsDeployment = /(部署|上线|发布|deploy|ship|launch)/i.test(objective);
  if (!mentionsDeployment) {
    return false;
  }
  const docsOnly =
    /(部署步骤|部署说明|部署文档|deployment\s+steps?|deploy\s+guide|部署方式)/i.test(objective) &&
    !/(帮我部署|请部署|执行部署|去部署|上线到|部署到|发布到|deploy\s+to|ship\s+to|launch\s+to)/i.test(objective);
  return !docsOnly;
}

function inferDeployTarget(run: GoalRunRecord): string | undefined {
  const direct = contextString(run.context, "deploy_target");
  if (direct) {
    return direct.toLowerCase();
  }
  const objective = run.objective.toLowerCase();
  if (objective.includes("阿里云") || objective.includes("aliyun")) {
    return "aliyun";
  }
  if (objective.includes("vercel")) {
    return "vercel";
  }
  return undefined;
}

function resolveDeployCredentialSpec(target: string): { providerId: string; keys: string[] } | undefined {
  switch (target) {
    case "aliyun":
      return {
        providerId: "deploy.aliyun",
        keys: ["access_key_id", "access_key_secret"]
      };
    case "vercel":
      return {
        providerId: "deploy.vercel",
        keys: ["api_token"]
      };
    default:
      return undefined;
  }
}

async function notifyGoalRunProgress(run: GoalRunRecord, message: string): Promise<void> {
  await notifyGoalRunProgressSafely({
    run,
    message,
    notifyFeishu,
    audit: store
  });
}

function buildGoalExecutionInstruction(run: GoalRunRecord): string {
  const planText = JSON.stringify(run.plan ?? {}, null, 2);
  const inputText = JSON.stringify(store.getGoalRunInputMap(run.id), null, 2);
  const lines = [
    `你正在执行一个阶段化 GoalRun，目标：${run.objective}`,
    "",
    "请按以下要求推进：",
    "1) 先输出关键假设与风险。",
    "2) 直接给出可执行产物（方案/代码/配置/检查清单）。",
    "3) 输出下一步建议。"
  ];
  if (goalRunNeedsConcreteArtifacts(run)) {
    lines.push("4) 本任务必须落地：至少在 workspace 实际创建或修改文件，并明确列出文件路径。");
    lines.push("5) 禁止只给方案文本后结束，必须包含可运行命令或可验证步骤。");
  }
  lines.push("", "Plan:", planText, "", "补充输入:", inputText);
  return lines.join("\n");
}

function buildGoalRunResult(run: GoalRunRecord): GoalRunResult {
  const locale = resolveGoalRunLocale(run);
  const summary = contextString(run.context, "last_task_summary") ?? (locale === "zh" ? "目标任务已完成" : "Goal completed");
  let deliverable =
    contextString(run.context, "last_task_deliverable") ??
    (locale === "zh"
      ? "已完成需求澄清、方案规划、执行与验证，并完成部署前检查。可按目标环境继续上线。"
      : "Clarification, planning, execution, and verification are complete. Deployment preflight is ready.");
  const artifactFiles = contextStringArray(run.context, "last_artifact_files");
  if (artifactFiles.length > 0) {
    const previews = artifactFiles.slice(0, 12).map((file) => `- ${file}`);
    deliverable =
      locale === "zh"
        ? `${deliverable}\n\n已落地产物文件：\n${previews.join("\n")}`
        : `${deliverable}\n\nGenerated artifact files:\n${previews.join("\n")}`;
  }
  const nextActions =
    locale === "zh"
      ? ["如需上线，请提供目标环境与凭据。", "上线后我会继续回归验证并输出复盘。"]
      : ["Provide deployment target and credentials to launch.", "Run regression checks and produce a postmortem."];
  return {
    summary,
    deliverable,
    nextActions
  };
}

async function processGoalRun(): Promise<boolean> {
  const claimed = store.claimNextQueuedGoalRun() ?? store.listGoalRuns({ status: "running", limit: 1 })[0];
  if (!claimed) {
    return false;
  }
  let run = claimed;
  try {
    const inputMap = store.getGoalRunInputMap(run.id);
    if (Object.keys(inputMap).length > 0) {
      run = store.updateGoalRunContext(run.id, inputMap) ?? run;
    }

    if (run.currentStage === "discover") {
      const missing = requiresDiscoverClarification(run);
      if (missing.length > 0) {
        const locale = resolveGoalRunLocale(run);
        const prompt =
          locale === "zh"
            ? `开始执行前需要你补充：${formatGoalInputFieldsForPrompt(missing, locale)}。`
            : `Before execution, I need: ${missing.join(", ")}.`;
        const waiting = store.markGoalRunAwaitingInput({
          goalRunId: run.id,
          stage: "discover",
          prompt,
          fields: missing
        });
        const updated = waiting ?? run;
        store.appendGoalRunTimelineEvent({
          goalRunId: run.id,
          stage: "discover",
          eventType: "input_required",
          message: prompt,
          payload: {
            fields: missing
          }
        });
        await notifyGoalRunProgress(updated, prompt);
        return true;
      }

      store.appendGoalRunTimelineEvent({
        goalRunId: run.id,
        stage: "discover",
        eventType: "stage_changed",
        message: "Discover completed, moving to plan",
        payload: {}
      });
      store.queueGoalRun(run.id, "plan");
      return true;
    }

    if (run.currentStage === "plan") {
      const plan = buildGoalRunPlan(run);
      const planned = store.setGoalRunPlan(run.id, plan) ?? run;
      store.appendGoalRunTimelineEvent({
        goalRunId: run.id,
        stage: "plan",
        eventType: "stage_changed",
        message: "Plan generated, moving to execute",
        payload: {
          plan
        }
      });
      store.queueGoalRun(planned.id, "execute");
      return true;
    }

    if (run.currentStage === "execute") {
      const executeWithTasks = runtimeValues.getBoolean("GOAL_RUN_EXECUTE_WITH_TASKS", true);
      if (!executeWithTasks) {
        const locale = resolveGoalRunLocale(run);
        const synthesizedSummary = locale === "zh" ? "已生成执行方案和落地清单" : "Execution plan and deliverables prepared";
        const synthesizedDeliverable =
          locale === "zh"
            ? [
                `目标：${run.objective}`,
                "",
                "当前产出：",
                "- 已完成可执行实施方案。",
                "- 已给出页面/模块划分与关键里程碑。",
                "- 已给出测试与上线前检查清单。",
                "- 你确认后我可以继续进入代码实现与部署。"
              ].join("\n")
            : [
                `Goal: ${run.objective}`,
                "",
                "Current deliverables:",
                "- An executable implementation plan.",
                "- Module/page breakdown with key milestones.",
                "- Test and pre-launch checklist.",
                "- I can continue with coding and deployment once you confirm."
              ].join("\n");
        store.updateGoalRunContext(run.id, {
          last_task_id: "",
          last_task_status: "synthesized",
          last_task_summary: synthesizedSummary,
          last_task_deliverable: synthesizedDeliverable
        });
        store.appendGoalRunTimelineEvent({
          goalRunId: run.id,
          stage: "execute",
          eventType: "task_completed",
          message: "Execution synthesized without blocking task runner",
          payload: {
            mode: "fast_path"
          }
        });
        store.queueGoalRun(run.id, "verify");
        return true;
      }

      if (!run.currentTaskId) {
        const requiresArtifacts = goalRunNeedsConcreteArtifacts(run);
        const task = store.createTask({
          sessionId: run.sessionId,
          source: run.source,
          roleId: "ceo",
          title: `GoalRun执行: ${run.objective.slice(0, 48)}`,
          instruction: buildGoalExecutionInstruction(run),
          priority: 95,
          requestedBy: run.requestedBy,
          chatId: run.chatId,
          metadata: {
            goalRunId: run.id,
            goalRunStage: "execute",
            autonomous: true,
            collaborationMode: true,
            collaborationEntryRole: "ceo",
            requiresArtifacts
          }
        });
        store.setGoalRunCurrentTask(run.id, task.id);
        store.appendGoalRunTimelineEvent({
          goalRunId: run.id,
          stage: "execute",
          eventType: "task_created",
          message: "Execution task created",
          payload: {
            taskId: task.id,
            roleId: task.roleId
          }
        });
        await notifyGoalRunProgress(run, `已进入执行阶段，创建任务 ${task.id.slice(0, 8)}。`);
        return true;
      }

      const task = store.getTask(run.currentTaskId);
      if (!task) {
        store.setGoalRunCurrentTask(run.id, undefined);
        store.queueGoalRun(run.id, "execute");
        return true;
      }

      if (task.status === "queued") {
        return false;
      }

      if (task.status === "running" || task.status === "waiting_approval") {
        const startedMs = parseIsoMs(task.startedAt) ?? parseIsoMs(task.updatedAt) ?? parseIsoMs(task.createdAt);
        const elapsedMs = startedMs !== undefined ? Date.now() - startedMs : undefined;
        const taskMetadata = task.metadata as {
          collaborationMode?: boolean;
          collaborationId?: string;
        };
        const isCollaborationTask = Boolean(taskMetadata.collaborationMode || taskMetadata.collaborationId);
        const requiresArtifacts = goalRunNeedsConcreteArtifacts(run);

        if (isCollaborationTask) {
          if (shouldPushGoalRunCollaborationHeartbeat(run.id)) {
            const heartbeat = buildGoalRunCollaborationHeartbeat(task);
            if (heartbeat) {
              await notifyGoalRunProgress(run, heartbeat);
            }
          }
          if (elapsedMs !== undefined && elapsedMs >= goalRunCollaborationTimeoutMs) {
            const failed = store.failGoalRun(run.id, "collaboration execution timeout") ?? run;
            store.appendGoalRunTimelineEvent({
              goalRunId: run.id,
              stage: "execute",
              eventType: "run_failed",
              message: "Collaboration execution timeout",
              payload: {
                taskId: task.id,
                timeoutMs: goalRunCollaborationTimeoutMs
              }
            });
            await notifyGoalRunProgress(failed, "执行失败：协作执行超时，请重试或拆分更小任务。");
            return true;
          }
          return false;
        }

        if (requiresArtifacts) {
          if (elapsedMs !== undefined && elapsedMs >= goalRunExecHardTimeoutMs) {
            const failed = store.failGoalRun(run.id, "execution timeout without concrete artifacts") ?? run;
            store.appendGoalRunTimelineEvent({
              goalRunId: run.id,
              stage: "execute",
              eventType: "run_failed",
              message: "Execution hard-timeout before artifact delivery",
              payload: {
                taskId: task.id,
                timeoutMs: goalRunExecHardTimeoutMs
              }
            });
            await notifyGoalRunProgress(failed, "执行失败：超时且未交付可验证产物文件。");
            return true;
          }
          return false;
        }

        if (startedMs !== undefined && Date.now() - startedMs >= goalRunExecSoftTimeoutMs) {
          const locale = resolveGoalRunLocale(run);
          const fallbackSummary =
            locale === "zh"
              ? "执行耗时较长，已先产出当前阶段可交付结果"
              : "Execution is taking longer; produced interim deliverables first";
          const fallbackDeliverable =
            locale === "zh"
              ? `目标：${run.objective}\n\n当前执行任务耗时较长，我已基于现有计划和输入先给出可落地结果，并继续推进后续步骤。`
              : `Goal: ${run.objective}\n\nExecution is taking longer; interim actionable deliverables were generated from current plan and context.`;
          store.updateGoalRunContext(run.id, {
            last_task_id: task.id,
            last_task_status: "timeout_fallback",
            last_task_summary: fallbackSummary,
            last_task_deliverable: fallbackDeliverable
          });
          store.setGoalRunCurrentTask(run.id, undefined);
          store.appendGoalRunTimelineEvent({
            goalRunId: run.id,
            stage: "execute",
            eventType: "task_failed",
            message: "Execution task soft-timeout fallback triggered",
            payload: {
              taskId: task.id,
              timeoutMs: goalRunExecSoftTimeoutMs
            }
          });
          store.queueGoalRun(run.id, "verify");
          return true;
        }
        return false;
      }

      if (task.status === "completed") {
        const evidence = collectGoalExecutionEvidence(task);
        const artifactFiles = goalRunNeedsConcreteArtifacts(run)
          ? dedupeSortedStrings([
              ...evidence.artifactFiles,
              ...listWorkspaceArtifactsModifiedSince(run.startedAt ?? run.createdAt, 80)
            ])
          : evidence.artifactFiles;
        store.updateGoalRunContext(run.id, {
          last_task_id: task.id,
          last_task_status: task.status,
          last_task_summary: task.result?.summary ?? "",
          last_task_deliverable: task.result?.deliverable ?? "",
          last_artifact_files: artifactFiles,
          last_completed_roles: evidence.completedRoles,
          last_failed_roles: evidence.failedRoles,
          last_collaboration_enabled: evidence.collaborationEnabled
        });
        store.setGoalRunCurrentTask(run.id, undefined);
        store.appendGoalRunTimelineEvent({
          goalRunId: run.id,
          stage: "execute",
          eventType: "task_completed",
          message: "Execution task completed",
          payload: {
            taskId: task.id,
            artifactCount: artifactFiles.length,
            completedRoles: evidence.completedRoles,
            failedRoles: evidence.failedRoles,
            collaborationEnabled: evidence.collaborationEnabled
          }
        });
        store.queueGoalRun(run.id, "verify");
        return true;
      }

      if (task.status === "failed" || task.status === "cancelled") {
        const taskMetadata = task.metadata as {
          collaborationMode?: boolean;
          collaborationId?: string;
        };
        const isCollaborationTask = Boolean(taskMetadata.collaborationMode || taskMetadata.collaborationId);
        if (isCollaborationTask) {
          const pendingChildren = store.listTaskChildren(task.id).filter((child) => {
            if (child.status === "completed" || child.status === "failed" || child.status === "cancelled") {
              return false;
            }
            const metadata = child.metadata as {
              collaborationId?: string;
              isAggregation?: boolean;
            };
            if (metadata.isAggregation) {
              return false;
            }
            if (typeof taskMetadata.collaborationId === "string" && taskMetadata.collaborationId.trim()) {
              return metadata.collaborationId === taskMetadata.collaborationId;
            }
            return true;
          });
          if (pendingChildren.length > 0) {
            return false;
          }

          const evidence = collectGoalExecutionEvidence(task);
          if (
            run.retryCount < run.maxRetries &&
            shouldRetryCollaborationExecutionFailure({
              task,
              completedRoles: evidence.completedRoles,
              failedRoles: evidence.failedRoles
            })
          ) {
            const retried = store.incrementGoalRunRetry(run.id) ?? run;
            store.setGoalRunCurrentTask(run.id, undefined);
            store.appendGoalRunTimelineEvent({
              goalRunId: run.id,
              stage: "execute",
              eventType: "retry_scheduled",
              message: "Collaboration execution failed, retry scheduled",
              payload: {
                taskId: task.id,
                retryCount: retried.retryCount,
                maxRetries: retried.maxRetries,
                errorText: task.errorText ?? "",
                completedRoles: evidence.completedRoles,
                failedRoles: evidence.failedRoles
              }
            });
            store.queueGoalRun(run.id, "execute");
            await notifyGoalRunProgress(
              retried,
              `协作执行未完全通过（完成角色：${evidence.completedRoles.join("、") || "无"}；失败角色：${
                evidence.failedRoles.join("、") || "无"
              }），已自动重试（${retried.retryCount}/${retried.maxRetries}）。`
            );
            return true;
          }

          const failed = store.failGoalRun(
            run.id,
            task.errorText ??
              `collaboration execution failed; completed roles=${evidence.completedRoles.join(",") || "none"}, failed roles=${
                evidence.failedRoles.join(",") || "none"
              }`
          ) ?? run;
          store.appendGoalRunTimelineEvent({
            goalRunId: run.id,
            stage: "execute",
            eventType: "run_failed",
            message: "Collaboration execution failed without auto retry",
            payload: {
              taskId: task.id,
              errorText: task.errorText ?? "",
              completedRoles: evidence.completedRoles,
              failedRoles: evidence.failedRoles
            }
          });
          await notifyGoalRunProgress(
            failed,
            `执行失败：协作任务未通过（完成角色：${evidence.completedRoles.join("、") || "无"}；失败角色：${
              evidence.failedRoles.join("、") || "无"
            }）。`
          );
          return true;
        }
        if (run.retryCount < run.maxRetries) {
          const retried = store.incrementGoalRunRetry(run.id) ?? run;
          store.setGoalRunCurrentTask(run.id, undefined);
          store.appendGoalRunTimelineEvent({
            goalRunId: run.id,
            stage: "execute",
            eventType: "retry_scheduled",
            message: `Execution failed, retry scheduled (${retried.retryCount}/${retried.maxRetries})`,
            payload: {
              taskId: task.id,
              errorText: task.errorText ?? ""
            }
          });
          store.queueGoalRun(run.id, "execute");
          return true;
        }
        const failed = store.failGoalRun(run.id, task.errorText ?? "Execution task failed after retries") ?? run;
        store.appendGoalRunTimelineEvent({
          goalRunId: run.id,
          stage: "execute",
          eventType: "run_failed",
          message: "Goal run failed in execute stage",
          payload: {
            taskId: task.id,
            errorText: task.errorText ?? ""
          }
        });
        await notifyGoalRunProgress(failed, `执行失败：${task.errorText ?? "未知错误"}`);
        return true;
      }
      return true;
    }

    if (run.currentStage === "verify") {
      const lastStatus = contextString(run.context, "last_task_status");
      if (goalRunNeedsConcreteArtifacts(run)) {
        const artifactFiles = contextStringArray(run.context, "last_artifact_files");
        if (lastStatus !== "completed") {
          const failed = store.failGoalRun(run.id, "verify failed: concrete artifact task not completed") ?? run;
          store.appendGoalRunTimelineEvent({
            goalRunId: run.id,
            stage: "verify",
            eventType: "run_failed",
            message: "Verification failed: task completion required",
            payload: {
              lastStatus: lastStatus ?? ""
            }
          });
          await notifyGoalRunProgress(failed, "校验失败：需要完成真实执行任务，不能使用文本兜底。");
          return true;
        }
        if (artifactFiles.length === 0) {
          const failed = store.failGoalRun(run.id, "verify failed: no filesystem artifacts generated") ?? run;
          store.appendGoalRunTimelineEvent({
            goalRunId: run.id,
            stage: "verify",
            eventType: "run_failed",
            message: "Verification failed: no artifact files",
            payload: {}
          });
          await notifyGoalRunProgress(failed, "校验失败：未检测到产物文件变更。");
          return true;
        }

        const collaborationEnabled = contextBoolean(run.context, "last_collaboration_enabled") ?? false;
        if (collaborationEnabled) {
          const requiredRoles = inferRequiredRolesFromObjective(run.objective);
          const completedRoles = contextStringArray(run.context, "last_completed_roles")
            .map((role) => normalizeRoleId(role))
            .filter((role): role is RoleId => role !== undefined);
          const failedRoles = contextStringArray(run.context, "last_failed_roles")
            .map((role) => normalizeRoleId(role))
            .filter((role): role is RoleId => role !== undefined);
          const missingRequired = requiredRoles.filter((role) => !completedRoles.includes(role));
          const failedRequired = requiredRoles.filter((role) => failedRoles.includes(role));
          if (missingRequired.length > 0 || failedRequired.length > 0) {
            if (goalRunCollabVerifyRetryEnabled && run.retryCount < run.maxRetries) {
              const retried = store.incrementGoalRunRetry(run.id) ?? run;
              store.setGoalRunCurrentTask(run.id, undefined);
              store.appendGoalRunTimelineEvent({
                goalRunId: run.id,
                stage: "verify",
                eventType: "retry_scheduled",
                message: "Verification failed for collaboration role completeness, retry scheduled",
                payload: {
                  retryCount: retried.retryCount,
                  maxRetries: retried.maxRetries,
                  requiredRoles,
                  completedRoles,
                  failedRoles,
                  missingRequired,
                  failedRequired
                }
              });
              store.queueGoalRun(run.id, "execute");
              await notifyGoalRunProgress(
                retried,
                `校验发现关键角色交付不完整（缺失：${missingRequired.join("、") || "无"}；失败：${
                  failedRequired.join("、") || "无"
                }），已自动重试（${retried.retryCount}/${retried.maxRetries}）。`
              );
              return true;
            }

            const failed = store.failGoalRun(
              run.id,
              `verify failed: required collaboration roles not satisfied (missing=${missingRequired.join(",") || "none"}, failed=${
                failedRequired.join(",") || "none"
              })`
            ) ?? run;
            store.appendGoalRunTimelineEvent({
              goalRunId: run.id,
              stage: "verify",
              eventType: "run_failed",
              message: "Verification failed: required collaboration roles missing/failed",
              payload: {
                requiredRoles,
                completedRoles,
                failedRoles,
                missingRequired,
                failedRequired
              }
            });
            await notifyGoalRunProgress(
              failed,
              `校验失败：关键角色交付不完整（缺失：${missingRequired.join("、") || "无"}；失败：${
                failedRequired.join("、") || "无"
              }）。`
            );
            return true;
          }
        }
      } else if (lastStatus !== "completed" && lastStatus !== "synthesized" && lastStatus !== "timeout_fallback") {
        const failed = store.failGoalRun(run.id, "verify failed: last task not completed") ?? run;
        store.appendGoalRunTimelineEvent({
          goalRunId: run.id,
          stage: "verify",
          eventType: "run_failed",
          message: "Verification failed",
          payload: {
            lastStatus: lastStatus ?? ""
          }
        });
        await notifyGoalRunProgress(failed, "校验失败：缺少可验证的执行结果。");
        return true;
      }
      store.appendGoalRunTimelineEvent({
        goalRunId: run.id,
        stage: "verify",
        eventType: "stage_changed",
        message: "Verify completed, moving to deploy",
        payload: {}
      });
      store.queueGoalRun(run.id, "deploy");
      return true;
    }

    if (run.currentStage === "deploy") {
      if (!wantsDeployment(run)) {
        store.appendGoalRunTimelineEvent({
          goalRunId: run.id,
          stage: "deploy",
          eventType: "stage_changed",
          message: "No deploy requested, moving to accept",
          payload: {}
        });
        store.queueGoalRun(run.id, "accept");
        return true;
      }

      const target = inferDeployTarget(run);
      if (!target) {
        const prompt =
          resolveGoalRunLocale(run) === "zh"
            ? "请提供部署目标(deploy_target)（例如 aliyun / vercel）。"
            : "Please provide deploy_target (aliyun / vercel).";
        const waiting = store.markGoalRunAwaitingInput({
          goalRunId: run.id,
          stage: "deploy",
          prompt,
          fields: ["deploy_target"]
        });
        store.appendGoalRunTimelineEvent({
          goalRunId: run.id,
          stage: "deploy",
          eventType: "input_required",
          message: prompt,
          payload: {
            fields: ["deploy_target"]
          }
        });
        await notifyGoalRunProgress(waiting ?? run, prompt);
        return true;
      }

      store.updateGoalRunContext(run.id, { deploy_target: target });
      const spec = resolveDeployCredentialSpec(target);
      if (spec) {
        const missingKeys: string[] = [];
        for (const key of spec.keys) {
          const contextKey = `credential.${spec.providerId}.${key}`;
          const fromInput = contextString(run.context, contextKey);
          if (fromInput) {
            store.upsertCredential({
              providerId: spec.providerId,
              credentialKey: key,
              value: fromInput,
              createdBy: run.requestedBy
            });
          }
          const secret = store.resolveCredentialSecret(spec.providerId, key);
          if (!secret) {
            missingKeys.push(contextKey);
          } else {
            store.touchCredentialUsage(spec.providerId, key);
          }
        }

        if (missingKeys.length > 0) {
          const prompt =
            resolveGoalRunLocale(run) === "zh"
              ? `部署到 ${target} 还缺少凭据：${missingKeys.join(", ")}。请通过输入或 /api/credentials 提供。`
              : `Missing credentials for ${target}: ${missingKeys.join(", ")}. Provide via input or /api/credentials.`;
          const waiting = store.markGoalRunAwaitingInput({
            goalRunId: run.id,
            stage: "deploy",
            prompt,
            fields: missingKeys
          });
          store.appendGoalRunTimelineEvent({
            goalRunId: run.id,
            stage: "deploy",
            eventType: "input_required",
            message: prompt,
            payload: {
              fields: missingKeys
            }
          });
          await notifyGoalRunProgress(waiting ?? run, prompt);
          return true;
        }
      }

      const authorizedAt = contextString(run.context, "deploy_authorized_at");
      if (!authorizedAt) {
        const scope = `deploy:${target}`;
        const token = store.createRunAuthToken({
          goalRunId: run.id,
          scope,
          ttlMs: 15 * 60 * 1000,
          reason: `authorize ${target} deployment`
        });
        const waiting = store.markGoalRunAwaitingAuthorization({
          goalRunId: run.id,
          stage: "deploy",
          reason: `awaiting authorization token (${scope})`
        });
        store.appendGoalRunTimelineEvent({
          goalRunId: run.id,
          stage: "deploy",
          eventType: "authorization_required",
          message: "Deployment authorization required",
          payload: {
            scope,
            tokenHint: token.token.slice(0, 8),
            expiresAt: token.expiresAt
          }
        });
        await notifyGoalRunProgress(
          waiting ?? run,
          `部署前需要一次授权。请在控制台调用 /api/goal-runs/${run.id}/authorize 并提交 token（前缀 ${token.token.slice(0, 8)}）。`
        );
        return true;
      }

      store.appendGoalRunTimelineEvent({
        goalRunId: run.id,
        stage: "deploy",
        eventType: "stage_changed",
        message: `Deployment preflight passed for ${target}`,
        payload: {
          target
        }
      });
      store.queueGoalRun(run.id, "accept");
      return true;
    }

    if (run.currentStage === "accept") {
      const result = buildGoalRunResult(run);
      const completed = store.completeGoalRun(run.id, result) ?? run;
      store.appendGoalRunTimelineEvent({
        goalRunId: run.id,
        stage: "accept",
        eventType: "run_completed",
        message: "Goal run completed",
        payload: {
          summary: result.summary
        }
      });
      await notifyGoalRunProgress(
        completed,
        `${result.summary}\n\n${result.deliverable.slice(0, 1200)}`
      );
      return true;
    }

    const failed = store.failGoalRun(run.id, `不支持的 GoalRun 阶段：${run.currentStage}`) ?? run;
    store.appendGoalRunTimelineEvent({
      goalRunId: run.id,
      stage: run.currentStage,
      eventType: "run_failed",
      message: "Unsupported goal run stage",
      payload: {
        stage: run.currentStage
      }
    });
    await notifyGoalRunProgress(failed, `执行失败：不支持的阶段 ${run.currentStage}`);
    return true;
  } catch (error) {
    if (isDatabaseLockedError(error)) {
      logger.error("goal run processing skipped due to transient db lock", error, {
        goalRunId: run.id,
        stage: run.currentStage,
        instanceId: runnerInstanceId
      });
      await sleep(150);
      return true;
    }
    const message = error instanceof Error ? error.message : String(error);
    const failed = store.failGoalRun(run.id, message) ?? run;
    store.appendGoalRunTimelineEvent({
      goalRunId: run.id,
      stage: run.currentStage,
      eventType: "run_failed",
      message: "GoalRun crashed",
      payload: {
        error: message
      }
    });
    logger.error("goal run processing failed", error, {
      goalRunId: run.id,
      stage: run.currentStage,
      instanceId: runnerInstanceId
    });
    await notifyGoalRunProgress(failed, `GoalRun执行异常：${message}`);
    return true;
  }
}

async function processTask(): Promise<boolean> {
  const task = store.claimNextQueuedTask();
  if (!task) {
    return false;
  }
  if (task.source === "feishu" && isFeishuSmalltalkInstruction(task.instruction)) {
    const message = buildFeishuSmalltalkResponse(task.instruction);
    const result: TaskResult = {
      summary: "问候消息已快速回复",
      deliverable: message,
      citations: [],
      followUps: []
    };
    const reflection: ReflectionNote = {
      score: 9,
      confidence: "high",
      assumptions: [],
      risks: [],
      improvements: []
    };
    const completed = store.completeTask(task.id, result, reflection) ?? task;
    if (completed.sessionId) {
      store.appendSessionMessage({
        sessionId: completed.sessionId,
        actorType: "role",
        actorId: completed.roleId,
        roleId: completed.roleId,
        messageType: "text",
        content: message,
        metadata: {
          taskId: completed.id,
          fastPath: "smalltalk"
        }
      });
    }
    if (completed.chatId) {
      await notifyFeishu(completed.chatId, message);
    }
    return true;
  }
  const heartbeatTimer = setInterval(() => {
    try {
      store.touchRunningTask(task.id);
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
      if (message.includes("database is locked")) {
        return;
      }
      logger.error("failed to update running task heartbeat", error, {
        taskId: task.id,
        instanceId: runnerInstanceId
      });
    }
  }, taskHeartbeatMs);
  if (typeof heartbeatTimer.unref === "function") {
    heartbeatTimer.unref();
  }
  const metadata = task.metadata as {
    collaborationMode?: boolean;
    collaborationId?: string;
    isAggregation?: boolean;
  };

  await safeEmitTaskLifecycleEvent({
    phase: "before_task",
    taskId: task.id,
    roleId: task.roleId,
    source: task.source,
    status: task.status
  });

  try {
    // 检查是否需要启动协作流程
    if (metadata.collaborationMode && !metadata.collaborationId) {
      const feishuClient = createFeishuClient();
      const manager = new CollaborationManager(feishuClient ? { store, feishuClient } : { store });
      const collaborationId = await manager.startCollaboration(task);
      const current = store.patchTaskMetadata(task.id, {
        collaborationId,
        collaborationStatus: "active"
      }) ?? task;
      await safeEmitTaskLifecycleEvent({
        phase: "after_task",
        taskId: task.id,
        roleId: task.roleId,
        source: task.source,
        status: current.status,
        summary: `Collaboration ${collaborationId.slice(0, 8)} started`
      });
      return true;
    }

    const skills = store.resolveSkillsForRole(task.roleId);
    const skillIds = skills.map((skill) => skill.skillId);
    let handled: boolean;
    if (
      codeExecutorEnabled &&
      shouldUseCodeExecutorTask({
        roleId: task.roleId,
        instruction: task.instruction,
        skillIds
      })
    ) {
      handled = await processCodeExecutionTask(task);
    } else {
      handled = await processNormalTask(task);
    }

    // 检查是否是协作任务的完成
    if (metadata.collaborationId) {
      const feishuClient = createFeishuClient();
      const manager = new CollaborationManager(feishuClient ? { store, feishuClient } : { store });
      await manager.handleTaskCompletion(store.getTask(task.id) ?? task);
    }

    const current = store.getTask(task.id) ?? task;
    await safeEmitTaskLifecycleEvent({
      phase: "after_task",
      taskId: task.id,
      roleId: task.roleId,
      source: task.source,
      status: current.status,
      summary: current.result?.summary,
      errorText: current.errorText
    });

    return handled;
  } catch (error) {
    if (isDatabaseLockedError(error)) {
      logger.error("task processing deferred due to transient db lock", error, {
        taskId: task.id,
        roleId: task.roleId,
        instanceId: runnerInstanceId
      });
      try {
        store.requeueTask(task.id);
      } catch {
        // best-effort
      }
      return true;
    }
    logger.error("task processing failed", error, {
      taskId: task.id,
      roleId: task.roleId,
      instanceId: runnerInstanceId
    });
    const failed = store.failTask(task.id, error instanceof Error ? error.message : String(error));
    if (metadata.collaborationId) {
      const feishuClient = createFeishuClient();
      const manager = new CollaborationManager(feishuClient ? { store, feishuClient } : { store });
      await manager.handleTaskCompletion(failed ?? task);
    }
    if (failed?.sessionId) {
      store.appendSessionMessage({
        sessionId: failed.sessionId,
        actorType: "role",
        actorId: failed.roleId,
        roleId: failed.roleId,
        messageType: "event",
        content: `任务失败：${failed.errorText ?? "未知错误"}`,
        metadata: {
          taskId: failed.id,
          status: failed.status
        }
      });
    }
    await safeEmitTaskLifecycleEvent({
      phase: "after_task",
      taskId: task.id,
      roleId: task.roleId,
      source: task.source,
      status: failed?.status ?? "failed",
      summary: failed?.result?.summary,
      errorText: failed?.errorText ?? (error instanceof Error ? error.message : String(error))
    });
    if (failed?.source === "feishu" && failed.chatId) {
      await notifyFeishu(failed.chatId, `任务「${failed.title}」执行失败：${failed.errorText ?? "未知错误"}`);
    }
    return true;
  } finally {
    clearInterval(heartbeatTimer);
  }
}

async function runTaskProcessingLoop(slot: number): Promise<never> {
  logger.info("task processing loop started", {
    slot,
    instanceId: runnerInstanceId
  });
  while (true) {
    try {
      const didWork = await processTask();
      await sleep(didWork ? 250 : 1200);
    } catch (error) {
      logger.error("task processing loop iteration failed", error, {
        slot,
        instanceId: runnerInstanceId
      });
      await sleep(500);
    }
  }
}

function runStaleRunningTaskRecovery(staleRecoveryMinutes: number): void {
  const staleAfterMs = Math.max(1, Math.round(staleRecoveryMinutes)) * 60_000;
  const nowMs = Date.now();
  const runningTasks = store.listTasks(1200).filter((task) => task.status === "running");
  let recovered = 0;
  let skippedActiveCollab = 0;

  for (const task of runningTasks) {
    const updatedMs = parseIsoMs(task.updatedAt);
    if (updatedMs === undefined || nowMs - updatedMs < staleAfterMs) {
      continue;
    }
    const metadata = task.metadata as {
      collaborationMode?: boolean;
      collaborationId?: string;
      isAggregation?: boolean;
    };
    const collaborationId =
      typeof metadata.collaborationId === "string" && metadata.collaborationId.trim().length > 0
        ? metadata.collaborationId.trim()
        : undefined;
    const collaboration = collaborationId ? store.getAgentCollaboration(collaborationId) : undefined;
    const isActiveCollaborationTask =
      metadata.isAggregation !== true &&
      (metadata.collaborationMode === true || (collaboration ? collaboration.status === "active" : false));
    if (isActiveCollaborationTask) {
      // Allow collaboration tasks more time before recovery, but don't skip them forever.
      // If a collab task has been stuck for 4× the normal stale threshold (e.g. 20 min),
      // requeue it like any other stale task.
      const collabStaleMs = staleAfterMs * 4;
      if (updatedMs !== undefined && nowMs - updatedMs < collabStaleMs) {
        skippedActiveCollab += 1;
        continue;
      }
    }
    store.requeueTask(task.id);
    recovered += 1;
  }

  if (recovered > 0 || skippedActiveCollab > 0) {
    logger.info("recovered stale running tasks", {
      recovered,
      skippedActiveCollab,
      scanned: runningTasks.length,
      staleAfterMinutes: staleRecoveryMinutes,
      instanceId: runnerInstanceId
    });
  }
}

function runStaleGoalRunRecovery(input?: {
  runningStaleAfterMinutes?: number;
  awaitingExpireAfterHours?: number;
}): void {
  const runningStaleAfterMinutes = Math.max(2, Math.round(input?.runningStaleAfterMinutes ?? 10));
  const awaitingExpireAfterHours = Math.max(1, Math.round(input?.awaitingExpireAfterHours ?? 36));
  const runningStaleAfterMs = runningStaleAfterMinutes * 60_000;
  const awaitingExpireAfterMs = awaitingExpireAfterHours * 60 * 60_000;
  const nowMs = Date.now();
  const runs = store.listGoalRuns({ limit: 1200 });
  let recoveredRunning = 0;
  let cancelledAwaiting = 0;

  for (const run of runs) {
    if (run.status === "running") {
      const runUpdatedMs = parseIsoMs(run.updatedAt);
      if (runUpdatedMs === undefined || nowMs - runUpdatedMs < runningStaleAfterMs) {
        continue;
      }
      if (run.currentTaskId) {
        const task = store.getTask(run.currentTaskId);
        if (!task) {
          store.setGoalRunCurrentTask(run.id, undefined);
          store.queueGoalRun(run.id, run.currentStage);
          recoveredRunning += 1;
          continue;
        }
        if (task.status === "completed" || task.status === "failed" || task.status === "cancelled") {
          store.setGoalRunCurrentTask(run.id, undefined);
          store.queueGoalRun(run.id, run.currentStage);
          recoveredRunning += 1;
        }
        continue;
      }
      store.queueGoalRun(run.id, run.currentStage);
      recoveredRunning += 1;
      continue;
    }

    if (run.status !== "awaiting_input" && run.status !== "awaiting_authorization") {
      continue;
    }
    const runUpdatedMs = parseIsoMs(run.updatedAt);
    if (runUpdatedMs === undefined || nowMs - runUpdatedMs < awaitingExpireAfterMs) {
      continue;
    }
    const reason =
      run.status === "awaiting_input"
        ? `Awaiting input expired after ${awaitingExpireAfterHours}h`
        : `Awaiting authorization expired after ${awaitingExpireAfterHours}h`;
    const cancelled = store.cancelGoalRun(run.id, reason);
    if (!cancelled) {
      continue;
    }
    store.appendGoalRunTimelineEvent({
      goalRunId: run.id,
      stage: run.currentStage,
      eventType: "run_cancelled",
      message: "GoalRun cancelled by stale-awaiting cleanup",
      payload: {
        reason
      }
    });
    cancelledAwaiting += 1;
  }

  if (recoveredRunning > 0 || cancelledAwaiting > 0) {
    logger.info("goal-run stale cleanup applied", {
      recoveredRunning,
      cancelledAwaiting,
      runningStaleAfterMinutes,
      awaitingExpireAfterHours,
      instanceId: runnerInstanceId
    });
  }
}

function runGoalRunFastReconciliation(input?: {
  runningWithoutProgressMs?: number;
}): void {
  const runningWithoutProgressMs = Math.max(10_000, Math.round(input?.runningWithoutProgressMs ?? 30_000));
  const nowMs = Date.now();
  const runs = store.listGoalRuns({ status: "running", limit: 1200 });
  let requeued = 0;

  for (const run of runs) {
    const runUpdatedMs = parseIsoMs(run.updatedAt);
    if (runUpdatedMs === undefined || nowMs - runUpdatedMs < runningWithoutProgressMs) {
      continue;
    }
    if (!run.currentTaskId) {
      const queued = store.queueGoalRun(run.id, run.currentStage);
      if (queued) {
        requeued += 1;
      }
      continue;
    }
    const task = store.getTask(run.currentTaskId);
    if (!task || task.status === "completed" || task.status === "failed" || task.status === "cancelled") {
      store.setGoalRunCurrentTask(run.id, undefined);
      const queued = store.queueGoalRun(run.id, run.currentStage);
      if (queued) {
        requeued += 1;
      }
    }
  }

  if (requeued > 0) {
    logger.info("goal-run fast reconciliation applied", {
      requeued,
      scanned: runs.length,
      runningWithoutProgressMs,
      instanceId: runnerInstanceId
    });
  }
}

function runStaleWaitingApprovalTaskCleanup(maxAgeHours: number): void {
  const thresholdMs = Math.max(1, Math.round(maxAgeHours)) * 60 * 60_000;
  const nowMs = Date.now();
  const tasks = store.listTasks(1200).filter((task) => task.status === "waiting_approval");
  let cleaned = 0;
  for (const task of tasks) {
    const updatedMs = parseIsoMs(task.updatedAt);
    if (updatedMs === undefined || nowMs - updatedMs < thresholdMs) {
      continue;
    }
    store.failTask(task.id, `Waiting approval expired after ${Math.round(maxAgeHours)}h`);
    cleaned += 1;
  }
  if (cleaned > 0) {
    logger.info("cleaned stale waiting-approval tasks", {
      cleaned,
      maxAgeHours: Math.round(maxAgeHours),
      instanceId: runnerInstanceId
    });
  }
}

function runOrphanedCollaborationTaskCleanup(): void {
  const candidates = store.listTasks(800).filter((task) => task.status === "queued" || task.status === "running");
  let cleaned = 0;
  for (const task of candidates) {
    const metadata = task.metadata as {
      parentTaskId?: string;
      collaborationId?: string;
      isAggregation?: boolean;
    };
    const parentTaskId = typeof metadata.parentTaskId === "string" ? metadata.parentTaskId : "";
    if (parentTaskId) {
      const parent = store.getTask(parentTaskId);
      if (parent && (parent.status === "failed" || parent.status === "completed" || parent.status === "cancelled")) {
        store.failTask(task.id, `Parent task ${parent.id.slice(0, 8)} is ${parent.status}; closed orphan child`);
        cleaned += 1;
        continue;
      }
    }

    const collaborationId = typeof metadata.collaborationId === "string" ? metadata.collaborationId : "";
    if (collaborationId) {
      const collaboration = store.getAgentCollaboration(collaborationId);
      if (collaboration && collaboration.status !== "active") {
        store.failTask(
          task.id,
          `Collaboration ${collaboration.id.slice(0, 8)} is ${collaboration.status}; closed orphan task`
        );
        cleaned += 1;
      }
    }
  }
  if (cleaned > 0) {
    logger.info("cleaned orphaned collaboration tasks", {
      cleaned,
      instanceId: runnerInstanceId
    });
  }
}

function runOrphanedToolRunCleanup(): void {
  const candidates = store
    .listToolRuns(1200)
    .filter((item) => item.status === "queued" || item.status === "approval_pending" || item.status === "running");
  let cleaned = 0;
  let timedOut = 0;
  const nowMs = Date.now();
  for (const toolRun of candidates) {
    try {
      const task = store.getTask(toolRun.taskId);
      if (!task) {
        store.failToolRun(toolRun.id, "Parent task not found; cleaned orphan tool run");
        cleaned += 1;
        continue;
      }
      if (toolRun.status === "running") {
        const startedMs = parseIsoMs(toolRun.startedAt ?? toolRun.updatedAt ?? toolRun.createdAt);
        if (startedMs !== undefined && nowMs - startedMs >= toolRunMaxRunningMs) {
          const reason = `Tool run exceeded max running time (${toolRunMaxRunningMs}ms)`;
          store.failToolRun(toolRun.id, reason);
          const siblingRunning = store
            .listToolRunsByTask(task.id)
            .some(
              (entry) =>
                entry.id !== toolRun.id &&
                (entry.status === "queued" || entry.status === "approval_pending" || entry.status === "running")
            );
          if (task.status === "running" && !siblingRunning) {
            store.failTask(task.id, reason);
          }
          cleaned += 1;
          timedOut += 1;
          continue;
        }
      }
      if (task.status === "completed" || task.status === "failed" || task.status === "cancelled") {
        store.failToolRun(
          toolRun.id,
          `Parent task ${task.id.slice(0, 8)} is ${task.status}; cleaned orphan tool run`
        );
        cleaned += 1;
      }
    } catch (error) {
      logger.error("failed to cleanup orphan tool run", error, {
        toolRunId: toolRun.id,
        instanceId: runnerInstanceId
      });
    }
  }
  if (cleaned > 0) {
    logger.info("cleaned orphaned tool runs", {
      cleaned,
      timedOut,
      instanceId: runnerInstanceId
    });
  }
}

async function main(): Promise<void> {
  logger.info("task runner started", {
    instanceId: runnerInstanceId,
    pid: process.pid,
    taskConcurrency
  });
  const staleRecoveryMinutesRaw = Number(process.env.RUNNER_STALE_RUNNING_RECOVERY_MINUTES ?? "5");
  const staleRecoveryMinutes = Number.isFinite(staleRecoveryMinutesRaw)
    ? Math.max(1, Math.round(staleRecoveryMinutesRaw))
    : 20;
  const staleRecoveryIntervalSecRaw = Number(process.env.RUNNER_STALE_RECOVERY_INTERVAL_SECONDS ?? "30");
  const staleRecoveryIntervalMs = Number.isFinite(staleRecoveryIntervalSecRaw)
    ? Math.max(10_000, Math.round(staleRecoveryIntervalSecRaw * 1000))
    : 30_000;
  const staleGoalRunMinutesRaw = Number(process.env.RUNNER_STALE_GOALRUN_RECOVERY_MINUTES ?? "10");
  const staleGoalRunMinutes = Number.isFinite(staleGoalRunMinutesRaw)
    ? Math.max(2, Math.round(staleGoalRunMinutesRaw))
    : 10;
  const staleAwaitingHoursRaw = Number(process.env.RUNNER_STALE_AWAITING_HOURS ?? "36");
  const staleAwaitingHours = Number.isFinite(staleAwaitingHoursRaw)
    ? Math.max(1, Math.round(staleAwaitingHoursRaw))
    : 36;
  const staleWaitingApprovalHoursRaw = Number(process.env.RUNNER_STALE_WAITING_APPROVAL_HOURS ?? "36");
  const staleWaitingApprovalHours = Number.isFinite(staleWaitingApprovalHoursRaw)
    ? Math.max(1, Math.round(staleWaitingApprovalHoursRaw))
    : 36;

  for (let index = 0; index < taskConcurrency; index += 1) {
    const slot = index + 1;
    void runTaskProcessingLoop(slot);
  }

  let nextRecoveryAt = 0;
  while (true) {
    if (Date.now() >= nextRecoveryAt) {
      runGoalRunFastReconciliation({
        runningWithoutProgressMs: Math.max(15_000, Math.round(staleRecoveryIntervalMs))
      });
      runStaleRunningTaskRecovery(staleRecoveryMinutes);
      runStaleGoalRunRecovery({
        runningStaleAfterMinutes: staleGoalRunMinutes,
        awaitingExpireAfterHours: staleAwaitingHours
      });
      runStaleWaitingApprovalTaskCleanup(staleWaitingApprovalHours);
      runOrphanedCollaborationTaskCleanup();
      runOrphanedToolRunCleanup();
      nextRecoveryAt = Date.now() + staleRecoveryIntervalMs;
    }
    const didGoalRunWork = await processGoalRun();
    await sleep(didGoalRunWork ? 200 : 500);
  }
}

main().catch((error) => {
  logger.error("task runner crashed", error, {
    instanceId: runnerInstanceId
  });
  process.exitCode = 1;
});

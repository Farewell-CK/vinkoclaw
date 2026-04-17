import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { AgentRuntime, type RuntimeExecutionInput, type TaskContextSnippet, globalTelemetry, initGlobalTelemetry, TelemetryCollector } from "@vinko/agent-runtime";
import { buildWorkDir } from "@vinko/agent-runtime/tool-executor";
import { FeishuClient, buildTaskCompletedCard, buildTaskFailedCard, buildTaskPausedCard, buildLightReviewQueuedCard, buildLightIterationQueuedCard, buildEscalationCard } from "@vinko/feishu-gateway";
import { WorkspaceKnowledgeBase } from "@vinko/knowledge-base";
import {
  buildToolCommand,
  buildWorkflowStatusSummary,
  createLogger,
  createRuntimeValueResolver,
  detectToolRiskLevel,
  detectToolProviderError,
  emitTaskLifecycle,
  extractToolOutput,
  getSkillDefinition,
  hasMeaningfulToolProgress,
  parseSearchMaxResults,
  createOrchestrationState,
  mergeOrchestrationState,
  normalizeOrchestrationState,
  type OrchestrationArtifactItem,
  type OrchestrationStatePatch,
  type OrchestrationStateRecord,
  resolveFeishuApproverOpenIds,
  resolveSearchProviderApiKeyEnv,
  resolveSearchProviderId,
  listToolProviderStatuses,
  loadEnv,
  resolveDataPath,
  ROLE_IDS,
  selectAvailableProviders,
  shouldUseCodeExecutorTask,
  AgentCollaborationService,
  VinkoStore,
  type GoalRunRecord,
  type GoalRunResult,
  type ReflectionNote,
  type RoleId,
  type SkillBindingRecord,
  type TaskRecord,
  type TaskResult,
  type ToolProviderId,
  type ToolRunRecord
} from "@vinko/shared";
import { CollaborationManager } from "./collaboration-manager.js";
import { buildCompanionArtifacts } from "./artifact-export.js";
import { resolveDeliverableMode, validateDeliverableArtifacts } from "./deliverable-contract.js";
import { notifyGoalRunProgressSafely } from "./goal-run-progress.js";

const env = loadEnv();
const store = VinkoStore.fromEnv(env);
const telemetryDb = resolveDataPath(env, "telemetry.db");
initGlobalTelemetry(telemetryDb);
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

const ROLE_LABELS: Record<RoleId, string> = {
  ceo: "CEO",
  cto: "CTO",
  product: "产品经理",
  uiux: "UI/UX",
  frontend: "前端",
  backend: "后端",
  algorithm: "算法",
  qa: "测试",
  developer: "开发",
  engineering: "工程",
  research: "研究",
  operations: "运营"
};

/**
 * Light collaboration reviewer map: primary executor → reviewer role.
 * Used in "build + quick check" mode.
 * Note: "ceo" is intentionally absent — that role belongs to the user (operator),
 * not an AI agent. Product tasks are reviewed by CTO for feasibility instead.
 */
const LIGHT_REVIEWER_MAP: Partial<Record<RoleId, RoleId>> = {
  frontend: "qa",
  uiux: "qa",
  backend: "qa",
  product: "cto",
  algorithm: "research",
  developer: "qa",
  engineering: "qa",
  operations: "product",
  research: "cto"
};

function resolveLightCollaborationReviewer(roleId: RoleId): RoleId {
  return LIGHT_REVIEWER_MAP[roleId] ?? "qa";
}

function buildRuntimeSkillBindingSnapshot(skills: SkillBindingRecord[]): Array<Record<string, unknown>> {
  return skills.map((skill) => ({
    skillId: skill.skillId,
    verificationStatus: skill.verificationStatus ?? "unverified",
    source: skill.source ?? "",
    sourceLabel: skill.sourceLabel ?? "",
    version: skill.version ?? "",
    installedAt: skill.installedAt ?? "",
    verifiedAt: skill.verifiedAt ?? "",
    runtimeAvailable: Boolean(getSkillDefinition(skill.skillId))
  }));
}

function persistTaskRuntimeSkillSnapshot(task: TaskRecord, skills: SkillBindingRecord[]): void {
  store.patchTaskMetadata(task.id, {
    runtimeSkillBindings: buildRuntimeSkillBindingSnapshot(skills)
  });
}

/** Role-specific review checklists for light collaboration. */
const REVIEW_CHECKLISTS: Partial<Record<RoleId, string[]>> = {
  qa: [
    "测试覆盖是否充分？边界用例和异常路径是否考虑到？",
    "错误处理是否完善？是否存在未捕获的异常场景？",
    "代码/逻辑是否具备可测性？是否有难以测试的隐藏依赖？"
  ],
  cto: [
    "架构设计是否合理？是否引入了不必要的技术债？",
    "方案的可扩展性和可维护性如何？是否有安全隐患？",
    "技术选型是否适合当前阶段？是否过度设计或设计不足？"
  ],
  research: [
    "分析方法论是否严谨？结论是否有数据支撑？",
    "是否存在明显的遗漏视角或样本偏差？",
    "结论的可信度和适用边界是否清晰说明？"
  ],
  product: [
    "用户故事和验收标准是否完整、可执行？",
    "功能优先级是否合理？是否遗漏了关键用户场景？",
    "需求描述是否足够清晰，开发侧是否能无歧义理解？"
  ]
};

const DEFAULT_REVIEW_CHECKLIST = [
  "输出内容是否逻辑清晰、结构完整？",
  "是否完整覆盖了原任务的所有要求？",
  "是否有明显可执行的改进空间？"
];

const ROLE_REVIEW_LABELS: Partial<Record<RoleId, string>> = {
  qa: "测试工程师",
  cto: "技术负责人",
  research: "研究员",
  product: "产品经理"
};

/**
 * Build a role-specific review instruction with a structured checklist.
 */
function buildReviewInstruction(
  primaryTask: TaskRecord,
  primaryOutput: TaskResult,
  reviewerRoleId: RoleId,
  collaborationContext?: string
): string {
  const checklist = REVIEW_CHECKLISTS[reviewerRoleId] ?? DEFAULT_REVIEW_CHECKLIST;
  const roleLabel = ROLE_REVIEW_LABELS[reviewerRoleId] ?? ROLE_LABELS[reviewerRoleId] ?? reviewerRoleId;
  const checklistText = checklist.map((q, i) => `${i + 1}. ${q}`).join("\n");
  const roomSection = collaborationContext ? `${collaborationContext}\n\n` : "";

  return `${roomSection}你是${roleLabel}，请从专业视角审阅以下内容。

## 审阅 Checklist（必须逐项作答）
${checklistText}

## 原任务
${primaryTask.instruction}

## 执行结果摘要
${primaryOutput.summary}

## 交付物
${primaryOutput.deliverable.slice(0, 1500)}

请输出：
- **总体评价**（一句话）
- **Checklist 逐项结论**（逐条回答）
- **需要修订的问题**（如有，最多3条，每条须具体可操作；如无则写"无需修订"）
- **风险点**（如有）`;
}

// ── Collaboration Room ────────────────────────────────────────────────────────

/**
 * Ensure a shared AgentCollaboration record exists for this task.
 * Returns the collaborationId (creates one if it doesn't exist yet).
 */
function ensureCollaborationRoom(task: TaskRecord, reviewerRoleId: RoleId): string {
  if (typeof task.metadata?.collaborationId === "string") {
    return task.metadata.collaborationId;
  }
  const collabService = new AgentCollaborationService(store);
  const createInput: Parameters<typeof collabService.createCollaboration>[0] = {
    parentTaskId: task.id,
    participants: [task.roleId, reviewerRoleId],
    facilitator: task.roleId,
    config: {
      maxRounds: 4,
      discussionTimeoutMs: 20 * 60 * 1000,
      requireConsensus: false,
      pushIntermediateResults: false,
      autoAggregateOnComplete: false,
      aggregateTimeoutMs: 30 * 60 * 1000
    }
  };
  if (task.sessionId !== undefined) createInput.sessionId = task.sessionId;
  if (task.chatId !== undefined) createInput.chatId = task.chatId;
  const collab = collabService.createCollaboration(createInput);
  store.patchTaskMetadata(task.id, { collaborationId: collab.id });
  return collab.id;
}

/**
 * Build a "collaboration room" context string from all AgentMessages in the room.
 * Injected into the instruction of review/iteration tasks so each agent sees
 * what others produced — like reading a group chat before joining the conversation.
 */
function buildCollaborationRoomContext(collaborationId: string): string {
  const collabService = new AgentCollaborationService(store);
  const messages = collabService.listMessages(collaborationId);
  if (messages.length === 0) return "";
  const lines: string[] = ["## 协作室（其他智能体已完成的工作）"];
  for (const msg of messages) {
    const label = ROLE_LABELS[msg.fromRoleId] ?? msg.fromRoleId;
    lines.push(`\n### ${label}：`);
    lines.push(msg.content.slice(0, 1500));
  }
  return lines.join("\n");
}

// ── Quality convergence ───────────────────────────────────────────────────────

const QUALITY_ASSESSMENT_TIMEOUT_MS = 60_000;

const QUALITY_SYSTEM_PROMPT = `You are a quality assessor for an AI team. Given a review and the original task instruction, assess the quality of the work and determine if it needs revision.

Output ONLY valid JSON:
{"score":8,"passesThreshold":true,"issues":[],"recommendation":"approve"}

Fields:
- score: 1-10 integer (1=terrible, 10=perfect)
- passesThreshold: true if score >= 7
- issues: array of specific, actionable issues (empty if none)
- recommendation: "approve" (score >= 7), "revise" (score 4-6), or "escalate" (score < 4 after multiple iterations)

Critical: be concrete about issues. Generic feedback like "could be better" is not actionable.`;

function qualityAssessmentFallback(reviewText: string): import("@vinko/shared").QualityAssessment {
  const needsRevision = /需要修订|建议修改|存在问题|有问题|不足|不够|缺少|缺乏|issue|risk|improve|修改建议|改进建议/i.test(reviewText) &&
    !/无需修订|不需要修订|无修改|完全正确|非常完善|质量很高/i.test(reviewText);
  return {
    score: needsRevision ? 5 : 8,
    passesThreshold: !needsRevision,
    issues: [],
    recommendation: needsRevision ? "revise" : "approve"
  };
}

async function assessReviewQuality(
  reviewOutput: string,
  originalInstruction: string,
  iterationCount: number,
  maxIterations: number
): Promise<import("@vinko/shared").QualityAssessment> {
  // Hard cap: if we've hit max iterations, force approve
  if (iterationCount >= maxIterations) {
    return { score: 7, passesThreshold: true, issues: [], recommendation: "approve" };
  }

  const text = `## Original Task\n${originalInstruction.slice(0, 500)}\n\n## Review Output\n${reviewOutput.slice(0, 1500)}\n\nIteration: ${iterationCount}/${maxIterations}`;

  try {
    const response = await fetch(`${resolveQualityLLMBaseUrl()}/chat/completions`, {
      method: "POST",
      headers: resolveQualityLLMHeaders(),
      body: JSON.stringify({
        model: resolveQualityLLMModel(),
        temperature: 0,
        thinking: { type: "enabled" },
        messages: [
          { role: "system", content: QUALITY_SYSTEM_PROMPT },
          { role: "user", content: text }
        ]
      }),
      signal: AbortSignal.timeout(QUALITY_ASSESSMENT_TIMEOUT_MS)
    });

    if (!response.ok) {
      return qualityAssessmentFallback(reviewOutput);
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: unknown; reasoning?: unknown } }>;
    };
    const msg = payload.choices?.[0]?.message;
    const raw =
      typeof msg?.content === "string" ? msg.content :
      typeof msg?.reasoning === "string" ? msg.reasoning : "";

    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return qualityAssessmentFallback(reviewOutput);

    const obj = JSON.parse(match[0]) as Record<string, unknown>;
    const score = typeof obj.score === "number" ? Math.round(obj.score) : 5;
    const issues = Array.isArray(obj.issues) ? (obj.issues as unknown[]).filter((i): i is string => typeof i === "string") : [];
    const recommendation = obj.recommendation === "approve" ? "approve"
      : obj.recommendation === "escalate" ? "escalate"
      : "revise";

    // Auto-escalate if score very low and already iterated
    const effectiveRecommendation: "approve" | "revise" | "escalate" =
      (score < 4 && iterationCount >= 2) ? "escalate" : recommendation;

    return {
      score,
      passesThreshold: score >= 7,
      issues,
      recommendation: effectiveRecommendation
    };
  } catch {
    return qualityAssessmentFallback(reviewOutput);
  }
}

function resolveQualityLLMBaseUrl(): string {
  const e = env;
  if (e.primaryBackend === "zhipu") return e.zhipuBaseUrl.replace(/\/$/, "");
  if (e.primaryBackend === "openai") return e.openaiBaseUrl.replace(/\/$/, "");
  if (e.primaryBackend === "sglang") return e.sglangBaseUrl.replace(/\/$/, "");
  return e.ollamaBaseUrl.replace(/\/$/, "");
}

function resolveQualityLLMModel(): string {
  const e = env;
  if (e.primaryBackend === "zhipu") return e.zhipuModel;
  if (e.primaryBackend === "openai") return e.openaiModel;
  if (e.primaryBackend === "sglang") return e.sglangModel;
  return e.ollamaModel;
}

function resolveQualityLLMHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const e = env;
  const apiKey = e.primaryBackend === "zhipu" ? e.zhipuApiKey
    : e.primaryBackend === "openai" ? e.openaiApiKey
    : undefined;
  if (apiKey) headers["authorization"] = `Bearer ${apiKey}`;
  return headers;
}

/** Derive max iteration count from CollaborationPlan complexity */
function resolveMaxIterations(task: TaskRecord): number {
  const plan = task.metadata?.collaborationPlan as { complexity?: string } | undefined;
  if (plan?.complexity === "trivial") return 1;
  if (plan?.complexity === "simple") return 2;
  if (plan?.complexity === "moderate") return 3;
  if (plan?.complexity === "complex") return 4;
  const config = store.getRuntimeConfig().collaboration.defaultConfig;
  return config.maxRounds;
}

/**
 * Apply a QualityAssessment to a parent task: create iteration task, send escalation card, or approve.
 * Used by both single-reviewer and aggregated parallel-review paths.
 */
async function applyQualityAssessment(opts: {
  assessment: import("@vinko/shared").QualityAssessment;
  parentTask: TaskRecord;
  parentTaskId: string;
  collaborationId: string | undefined;
  iterationCount: number;
  maxIterations: number;
  completed: TaskRecord;
}): Promise<void> {
  const { assessment, parentTask, parentTaskId, collaborationId, iterationCount, completed } = opts;

  if (assessment.recommendation === "escalate") {
    if (parentTask.source === "feishu" && parentTask.chatId) {
      const executorLabel = ROLE_LABELS[parentTask.roleId] ?? parentTask.roleId;
      const card = buildEscalationCard({
        title: parentTask.title,
        roleLabel: executorLabel,
        issues: assessment.issues,
        iterationCount,
      });
      await notifyFeishuCard(parentTask.chatId, card);
    }
  } else if (assessment.recommendation === "revise") {
    const roomContext = collaborationId ? buildCollaborationRoomContext(collaborationId) : "";
    const roomSection = roomContext ? `${roomContext}\n\n` : "";
    const reviewSummary = completed.result?.summary ?? "";
    const reviewDeliverable = completed.result?.deliverable?.slice(0, 1200) ?? "";
    const createInput: Parameters<typeof store.createTask>[0] = {
      source: parentTask.source,
      roleId: parentTask.roleId,
      title: `[修订] ${parentTask.title}`,
      instruction: `${roomSection}请根据审阅意见修订你的输出。\n\n## 原任务\n${parentTask.instruction}\n\n## 审阅意见\n${reviewDeliverable}\n\n请针对每条具体问题进行修订，输出修订后的完整交付物。`,
      priority: parentTask.priority,
      metadata: {
        lightCollaboration: true,
        isLightIteration: true,
        lightCollaborationParentId: parentTaskId,
        collaborationIterationCount: iterationCount + 1,
        collaborationMaxIterations: opts.maxIterations,
        collaborationId
      }
    };
    if (parentTask.sessionId !== undefined) createInput.sessionId = parentTask.sessionId;
    if (parentTask.requestedBy !== undefined) createInput.requestedBy = parentTask.requestedBy;
    if (parentTask.chatId !== undefined) createInput.chatId = parentTask.chatId;
    const iterTask = store.createTask(createInput);
    store.patchTaskMetadata(parentTaskId, { lightIterationTaskId: iterTask.id });
    store.patchTaskMetadata(completed.id, { lightIterationTaskId: iterTask.id });
    if (completed.sessionId) {
      store.appendSessionMessage({
        sessionId: completed.sessionId,
        actorType: "system",
        actorId: "task-runner",
        messageType: "event",
        content: `审阅发现改进点（质量评分 ${assessment.score}/10），已创建修订任务交回${ROLE_LABELS[parentTask.roleId] ?? parentTask.roleId}处理…`,
        metadata: {
          type: "light_iteration_queued",
          iterationTaskId: iterTask.id,
          reviewTaskId: completed.id,
          parentTaskId,
          qualityScore: assessment.score
        }
      });
    }
    if (iterationCount === 0 && parentTask.source === "feishu" && parentTask.chatId) {
      const executorLabel = ROLE_LABELS[parentTask.roleId] ?? parentTask.roleId;
      const card = buildLightIterationQueuedCard({
        parentTitle: parentTask.title,
        executorLabel,
        reviewSummary,
      });
      await notifyFeishuCard(parentTask.chatId, card);
    }
  }
  // else: "approve" — fall through, no action needed
}

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
const taskConcurrencyRaw = Number(process.env.RUNNER_TASK_CONCURRENCY ?? "2");
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
  "tmp",
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

const TEXT_DELIVERABLE_REQUEST_PATTERN =
  /(?:\bprd\b|roadmap|spec|report|brief|proposal|docx|pdf|markdown|\.md\b|文档|文件|报告|方案|简介|需求文档|产品需求|prd|路线图|纪要|总结)/i;

function slugifyArtifactBaseName(task: TaskRecord): string {
  const source = `${task.title} ${task.roleId}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return source || `task-${task.id.slice(0, 8)}`;
}

function requiresPersistedTextArtifact(task: TaskRecord): boolean {
  const sample = `${task.title}\n${task.instruction}`;
  return TEXT_DELIVERABLE_REQUEST_PATTERN.test(sample);
}

function injectDeliverableStructure(task: TaskRecord): string {
  const metadata = task.metadata as { deliverableSections?: unknown };
  const sections = Array.isArray(metadata.deliverableSections)
    ? metadata.deliverableSections
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean)
        .slice(0, 12)
    : [];
  if (sections.length === 0) {
    return task.instruction;
  }
  return [
    task.instruction,
    "",
    "交付结构要求：",
    ...sections.map((section, index) => `${index + 1}. ${section}`),
    "",
    "请按以上章节结构输出；如果某一节信息不足，也要写出最小可行内容和待确认项。"
  ].join("\n");
}

function buildRoleExecutionContract(task: TaskRecord): string {
  const lines: string[] = [];
  switch (task.roleId) {
    case "product":
      lines.push("岗位执行约束:");
      lines.push("- 输出必须先给结论，再给范围、风险、验收标准。");
      lines.push("- 如果信息不足，明确列出待确认项，不要假装需求已经完整。");
      break;
    case "research":
      lines.push("岗位执行约束:");
      lines.push("- 输出必须包含：核心结论、关键证据/依据、主要风险、建议动作。");
      lines.push("- 不要只罗列资料；先归纳判断，再给证据。");
      break;
    case "uiux":
      lines.push("岗位执行约束:");
      lines.push("- 输出必须包含：设计方向、关键界面/流程、体验风险、待确认项。");
      lines.push("- 优先说明信息架构和交互，不要只给泛泛视觉描述。");
      break;
    case "frontend":
    case "backend":
    case "developer":
    case "engineering":
      lines.push("岗位执行约束:");
      lines.push("- 输出必须包含：实际变更文件、实现说明、验证结果、剩余风险。");
      lines.push("- 如果没有改动文件，必须明确说明阻塞原因。");
      break;
    case "qa":
      lines.push("岗位执行约束:");
      lines.push("- 输出必须包含：测试范围、验证结论、发现的问题、回归建议。");
      lines.push("- 不能把“未测试”写成“已通过”。");
      break;
    default:
      break;
  }
  return lines.join("\n");
}

function buildSkillExecutionContract(task: TaskRecord, skillIds: string[]): string {
  const enabled = new Set(skillIds);
  const lines: string[] = [];
  const metadata = task.metadata as {
    requestedSkillId?: unknown;
    requestedSkillName?: unknown;
    requestedSkillSourceLabel?: unknown;
    requestedSkillSourceUrl?: unknown;
    requestedSkillVersion?: unknown;
    requestedSkillTargetRoleId?: unknown;
  };
  if (enabled.has("prd-writer") && task.roleId === "product") {
    lines.push("技能执行约束(PRD Writer):");
    lines.push("- 输出必须是结构化 PRD，而不是泛泛建议。");
    lines.push("- 必须覆盖：背景、目标用户、核心流程、需求范围、验收标准、风险、待确认项、下一步。");
    lines.push("- 如果信息不足，待确认项不能为空。");
  }
  if ((task.roleId === "engineering" || task.roleId === "developer") && typeof metadata.requestedSkillId === "string") {
    lines.push("技能接入执行约束(Skill Runtime Integration):");
    lines.push(`- 本次接入目标 skillId：${metadata.requestedSkillId}`);
    if (typeof metadata.requestedSkillName === "string" && metadata.requestedSkillName.trim()) {
      lines.push(`- 技能名称：${metadata.requestedSkillName.trim()}`);
    }
    if (typeof metadata.requestedSkillVersion === "string" && metadata.requestedSkillVersion.trim()) {
      lines.push(`- 目标版本：${metadata.requestedSkillVersion.trim()}`);
    }
    if (typeof metadata.requestedSkillSourceLabel === "string" && metadata.requestedSkillSourceLabel.trim()) {
      lines.push(`- 来源标识：${metadata.requestedSkillSourceLabel.trim()}`);
    }
    if (typeof metadata.requestedSkillSourceUrl === "string" && metadata.requestedSkillSourceUrl.trim()) {
      lines.push(`- 来源地址：${metadata.requestedSkillSourceUrl.trim()}`);
    }
    if (typeof metadata.requestedSkillTargetRoleId === "string" && metadata.requestedSkillTargetRoleId.trim()) {
      lines.push(`- 接入完成后应可安装到角色：${metadata.requestedSkillTargetRoleId.trim()}`);
    }
    lines.push("- 必须补齐本地 runtime skill definition、marketplace 元数据和安装可用性。");
    lines.push("- 必须补充或更新测试，至少覆盖 skill 被发现、可安装或 discover_only 状态。");
    lines.push("- 如果无法完整接入，也要明确缺失依赖、阻塞点和下一步。");
  }
  return lines.join("\n");
}

function buildVerifierOnlyContract(task: TaskRecord): string {
  const metadata = task.metadata as { verifierOnly?: unknown };
  if (metadata.verifierOnly !== true) {
    return "";
  }
  return [
    "验证者约束:",
    "- 你只负责验证、挑错、给出风险和回归建议。",
    "- 不要继续产出下一阶段主交付，也不要改写产品/实现方案。",
    "- 若缺信息，明确指出缺口并给出最小补充问题。"
  ].join("\n");
}

export function buildRoleAwareInstruction(task: TaskRecord, skillIds: string[] = []): string {
  const deliverableInstruction = injectDeliverableStructure(task).trim();
  const roleContract = buildRoleExecutionContract(task).trim();
  const skillContract = buildSkillExecutionContract(task, skillIds).trim();
  const verifierContract = buildVerifierOnlyContract(task).trim();
  const contracts = [roleContract, skillContract, verifierContract].filter(Boolean);
  if (contracts.length === 0) {
    return deliverableInstruction;
  }
  return [deliverableInstruction, "", ...contracts].join("\n");
}

async function ensureTextDeliverableArtifact(
  task: TaskRecord,
  result: TaskResult,
  existingArtifactFiles: string[]
): Promise<{ artifactFiles: string[]; result: TaskResult }> {
  const deliverableMode = resolveDeliverableMode(task);
  if (deliverableMode === "answer_only") {
    return { artifactFiles: existingArtifactFiles, result };
  }
  if (!requiresPersistedTextArtifact(task)) {
    return { artifactFiles: existingArtifactFiles, result };
  }
  if (existingArtifactFiles.length > 0) {
    return { artifactFiles: existingArtifactFiles, result };
  }

  const deliverableText = result.deliverable.trim();
  if (!deliverableText) {
    return { artifactFiles: existingArtifactFiles, result };
  }

  const workDir = buildWorkDir(env.workspaceRoot, task.id);
  await mkdir(workDir, { recursive: true });

  const baseName = slugifyArtifactBaseName(task);
  const fileName = `${baseName}.md`;
  const absolutePath = path.join(workDir, fileName);
  await writeFile(absolutePath, deliverableText.endsWith("\n") ? deliverableText : `${deliverableText}\n`, "utf8");

  const relPath = path.relative(env.workspaceRoot, absolutePath);
  const nextArtifactFiles = new Set([...existingArtifactFiles, relPath]);
  const companionArtifacts = buildCompanionArtifacts({
    relativePath: relPath,
    content: deliverableText,
    title: task.title
  });
  for (const artifact of companionArtifacts) {
    const artifactAbsolutePath = path.join(env.workspaceRoot, artifact.relativePath);
    await mkdir(path.dirname(artifactAbsolutePath), { recursive: true });
    await writeFile(
      artifactAbsolutePath,
      artifact.content.endsWith("\n") ? artifact.content : `${artifact.content}\n`,
      "utf8"
    );
    nextArtifactFiles.add(artifact.relativePath);
  }
  const sortedArtifactFiles = Array.from(nextArtifactFiles).sort((a, b) => a.localeCompare(b));
  const fileNotice = `\n\n已落地产物文件：\n- ${relPath}`;
  const nextResult: TaskResult = {
    ...result,
    deliverable: result.deliverable.includes(relPath) ? result.deliverable : `${result.deliverable}${fileNotice}`
  };

  return {
    artifactFiles: sortedArtifactFiles,
    result: nextResult
  };
}

async function failDeliverableContract(task: TaskRecord, mode: string, errorText: string): Promise<void> {
  const failed = store.failTask(task.id, errorText) ?? task;
  store.patchTaskMetadata(task.id, {
    deliverableMode: mode,
    deliverableContractViolated: true
  });
  if (failed.sessionId) {
    store.appendSessionMessage({
      sessionId: failed.sessionId,
      actorType: "system",
      actorId: "task-runner",
      messageType: "event",
      content: `交付失败：${failed.title} 未满足产物契约`,
      metadata: {
        taskId: failed.id,
        type: "deliverable_contract_failed",
        deliverableMode: mode,
        errorText
      }
    });
  }
  if (failed.source === "feishu" && failed.chatId) {
    const card = buildTaskFailedCard({
      title: failed.title,
      roleLabel: ROLE_LABELS[failed.roleId] ?? failed.roleId,
      reason: errorText
    });
    await notifyFeishuCard(failed.chatId, card);
  }
  syncFounderWorkflowFailure(failed);
}

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
  };
}

/**
 * Build an interactive feedback card sent to users after a light_collaboration
 * final delivery. Allows the user to rate the result 👍 or 👎.
 */
function buildTaskFeedbackCard(task: TaskRecord, summary: string): Record<string, unknown> {
  const feedbackValue = { kind: "task_feedback", taskId: task.id, chatId: task.chatId };
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: "任务完成 ✓" },
      template: "green"
    },
    elements: [
      {
        tag: "markdown",
        content: `**${task.title}**\n\n${summary.slice(0, 300)}`
      },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: "👍 满意" },
            type: "primary",
            value: { ...feedbackValue, rating: "good" }
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "👎 需改进" },
            type: "danger",
            value: { ...feedbackValue, rating: "poor" }
          }
        ]
      }
    ]
  };
}

/**
 * Send an interactive card to a Feishu chat (group or direct message).
 */
async function notifyFeishuCard(chatId: string, card: Record<string, unknown>): Promise<void> {
  if (!isLikelyFeishuChatId(chatId)) return;
  const client = createFeishuClient();
  if (!client) return;
  try {
    await client.sendCardToChat(chatId, card);
  } catch (error) {
    store.appendAuditEvent({
      category: "feishu",
      entityType: "chat",
      entityId: chatId,
      message: "Failed to send Feishu feedback card",
      payload: { error: error instanceof Error ? error.message : String(error) }
    });
  }
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

  const founderWorkflowMetadata = task.metadata as {
    founderWorkflowKind?: unknown;
    founderWorkflowStage?: unknown;
  };
  const isFounderPrdTask =
    founderWorkflowMetadata.founderWorkflowKind === "founder_delivery" &&
    founderWorkflowMetadata.founderWorkflowStage === "prd";

  // Fetch more messages but be generous with content — this goes into real message turns
  const recentMessages = store
    .listSessionMessages(task.sessionId, 120)
    .slice(isFounderPrdTask ? -8 : -30);

  const turns: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const message of recentMessages) {
    const isUser = message.actorType === "user";
    const isAssistant = message.actorType === "role";
    if (!isUser && !isAssistant) continue;
    // Founder PRD tasks should stay lean; later stages can consume richer context.
    const content = message.content.slice(0, isFounderPrdTask ? 240 : 800);
    if (!content.trim()) continue;
    turns.push({ role: isUser ? "user" : "assistant", content });
  }

  return turns;
}

function buildSessionContextSnippets(task: TaskRecord): TaskContextSnippet[] {
  if (!task.sessionId) {
    return [];
  }

  const founderWorkflowMetadata = task.metadata as {
    founderWorkflowKind?: unknown;
    founderWorkflowStage?: unknown;
  };
  const isFounderPrdTask =
    founderWorkflowMetadata.founderWorkflowKind === "founder_delivery" &&
    founderWorkflowMetadata.founderWorkflowStage === "prd";

  const session = store.getSession(task.sessionId);
  const sessionMetadata = (session?.metadata ?? {}) as {
    projectMemory?: {
      currentGoal?: unknown;
      currentStage?: unknown;
      latestUserRequest?: unknown;
      latestSummary?: unknown;
      keyDecisions?: unknown;
      unresolvedQuestions?: unknown;
      nextActions?: unknown;
      latestArtifacts?: unknown;
      updatedAt?: unknown;
      updatedBy?: unknown;
    };
  };
  const projectMemory = sessionMetadata.projectMemory;

  const relatedTasks = store
    .listTasks(500)
    .filter((item) => item.sessionId === task.sessionId && item.id !== task.id)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

  const activeTasks = relatedTasks
    .filter((item) => item.status === "queued" || item.status === "running" || item.status === "waiting_approval")
    .slice(0, isFounderPrdTask ? 3 : 8)
    .map((item) => ({
      id: item.id.slice(0, 8),
      roleId: item.roleId,
      status: item.status,
      title: item.title,
      updatedAt: item.updatedAt
    }));

  const recentCompleted = relatedTasks
    .filter((item) => item.status === "completed")
    .slice(0, isFounderPrdTask ? 2 : 6)
    .map((item) => ({
      id: item.id.slice(0, 8),
      roleId: item.roleId,
      title: item.title,
      summary: (item.result?.summary ?? "").slice(0, isFounderPrdTask ? 120 : 240),
      updatedAt: item.updatedAt
    }));

  const activeCollaborations = store
    .listActiveAgentCollaborations()
    .filter((item) => item.sessionId === task.sessionId)
    .slice(0, isFounderPrdTask ? 1 : 4)
    .map((item) => ({
      id: item.id.slice(0, 8),
      facilitator: item.facilitator,
      phase: item.currentPhase,
      participants: item.participants
    }));

  const normalizeMemoryString = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
  const normalizeMemoryStringList = (value: unknown, limit = 6): string[] =>
    Array.isArray(value)
      ? value
          .filter((entry): entry is string => typeof entry === "string")
          .map((entry) => entry.trim())
          .filter(Boolean)
          .slice(0, limit)
      : [];
  const currentGoal = normalizeMemoryString(projectMemory?.currentGoal);
  const currentStage = normalizeMemoryString(projectMemory?.currentStage);
  const latestSummary = normalizeMemoryString(projectMemory?.latestSummary);
  const latestRequest = normalizeMemoryString(projectMemory?.latestUserRequest);
  const unresolvedQuestions = normalizeMemoryStringList(projectMemory?.unresolvedQuestions);
  const nextActions = normalizeMemoryStringList(projectMemory?.nextActions);
  const latestArtifacts = normalizeMemoryStringList(projectMemory?.latestArtifacts, 8);
  const keyDecisions = normalizeMemoryStringList(projectMemory?.keyDecisions);

  const buildRoleProjectBrief = (): string => {
    if (!projectMemory) {
      return "";
    }
    const base: string[] = [];
    if (currentGoal) {
      base.push(`当前目标: ${currentGoal}`);
    }
    if (currentStage) {
      base.push(`当前阶段: ${currentStage}`);
    }
    if (latestRequest) {
      base.push(`最近用户要求: ${latestRequest}`);
    }
    if (latestSummary) {
      base.push(`最近团队结论: ${latestSummary}`);
    }

    switch (task.roleId) {
      case "product":
      case "research":
        if (keyDecisions.length > 0) {
          base.push(`关键决策:\n- ${keyDecisions.join("\n- ")}`);
        }
        if (unresolvedQuestions.length > 0) {
          base.push(`待澄清问题:\n- ${unresolvedQuestions.join("\n- ")}`);
        }
        if (nextActions.length > 0) {
          base.push(`优先推进动作:\n- ${nextActions.join("\n- ")}`);
        }
        break;
      case "frontend":
      case "backend":
      case "developer":
      case "engineering":
        if (latestArtifacts.length > 0) {
          base.push(`已产出文件/产物:\n- ${latestArtifacts.join("\n- ")}`);
        }
        if (nextActions.length > 0) {
          base.push(`待实现动作:\n- ${nextActions.join("\n- ")}`);
        }
        if (unresolvedQuestions.length > 0) {
          base.push(`实现前待确认:\n- ${unresolvedQuestions.join("\n- ")}`);
        }
        break;
      case "qa":
        if (latestArtifacts.length > 0) {
          base.push(`待验证产物:\n- ${latestArtifacts.join("\n- ")}`);
        }
        if (unresolvedQuestions.length > 0) {
          base.push(`测试前缺口:\n- ${unresolvedQuestions.join("\n- ")}`);
        }
        if (nextActions.length > 0) {
          base.push(`建议验证动作:\n- ${nextActions.join("\n- ")}`);
        }
        break;
      case "uiux":
        if (keyDecisions.length > 0) {
          base.push(`设计约束/方向:\n- ${keyDecisions.join("\n- ")}`);
        }
        if (unresolvedQuestions.length > 0) {
          base.push(`体验待确认:\n- ${unresolvedQuestions.join("\n- ")}`);
        }
        if (nextActions.length > 0) {
          base.push(`设计下一步:\n- ${nextActions.join("\n- ")}`);
        }
        break;
      default:
        if (nextActions.length > 0) {
          base.push(`下一步:\n- ${nextActions.join("\n- ")}`);
        }
        if (unresolvedQuestions.length > 0) {
          base.push(`待确认:\n- ${unresolvedQuestions.join("\n- ")}`);
        }
        break;
    }

    return capText(base.join("\n\n").trim(), isFounderPrdTask ? 900 : 1800);
  };

  const roleProjectBrief = buildRoleProjectBrief();

  return [
    ...(projectMemory
      ? [
          ...(!isFounderPrdTask
            ? [
                {
                  path: "runtime://session/project-memory",
                  excerpt: capJsonText(
                    {
                      currentGoal: typeof projectMemory.currentGoal === "string" ? projectMemory.currentGoal : "",
                      currentStage: typeof projectMemory.currentStage === "string" ? projectMemory.currentStage : "",
                      latestUserRequest:
                        typeof projectMemory.latestUserRequest === "string" ? projectMemory.latestUserRequest : "",
                      latestSummary: typeof projectMemory.latestSummary === "string" ? projectMemory.latestSummary : "",
                      keyDecisions: Array.isArray(projectMemory.keyDecisions) ? projectMemory.keyDecisions : [],
                      unresolvedQuestions: Array.isArray(projectMemory.unresolvedQuestions)
                        ? projectMemory.unresolvedQuestions
                        : [],
                      nextActions: Array.isArray(projectMemory.nextActions) ? projectMemory.nextActions : [],
                      latestArtifacts: Array.isArray(projectMemory.latestArtifacts) ? projectMemory.latestArtifacts : [],
                      updatedAt: typeof projectMemory.updatedAt === "string" ? projectMemory.updatedAt : "",
                      updatedBy: typeof projectMemory.updatedBy === "string" ? projectMemory.updatedBy : ""
                    },
                    2600
                  )
                } satisfies TaskContextSnippet
              ]
            : []),
          ...(roleProjectBrief
            ? [
                {
                  path: `runtime://session/project-memory-${task.roleId}`,
                  excerpt: roleProjectBrief
                } satisfies TaskContextSnippet
              ]
            : [])
        ]
      : []),
    {
      path: "runtime://session/workflow-state",
      excerpt: capJsonText(
        {
          activeTasks,
          recentCompleted,
          activeCollaborations
        },
        isFounderPrdTask ? 900 : 2400
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
    toolRun.riskLevel === "high" ? ["cto"] : ["cto"]
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
  const deliverableMode = resolveDeliverableMode(task);
  const deliverableValidation = validateDeliverableArtifacts({
    task,
    artifactFiles: normalizedChangedFiles
  });
  if (!deliverableValidation.ok) {
    await failDeliverableContract(task, deliverableMode, deliverableValidation.error);
    return;
  }
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
      toolChangedFiles: normalizedChangedFiles,
      deliverableMode,
      deliverableContractViolated: false
    });
    updateSessionProjectMemoryFromTask(completed, {
      currentStage: "artifact_delivered"
    });
    syncSkillIntegrationOutcome(completed);
    syncInstalledSkillVerification(completed);
    syncFounderWorkflowProgress(completed);
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
    const card = buildTaskCompletedCard({
      title: completed.title,
      roleLabel: ROLE_LABELS[completed.roleId] ?? completed.roleId,
      summary: `${completion.result.summary}\n\n${completion.result.deliverable.slice(0, 800)}`,
      workflowSummary: buildWorkflowStatusSummary(completed, { includeGoal: true, includeArtifacts: true })
    });
    await notifyFeishuCard(completed.chatId, card);
  }
}

async function processCodeExecutionTask(
  task: TaskRecord,
  skillIds: string[],
  skills: SkillBindingRecord[]
): Promise<boolean> {
  const effectiveTask: TaskRecord = {
    ...task,
    instruction: buildRoleAwareInstruction(task, skillIds)
  };
  persistTaskRuntimeSkillSnapshot(effectiveTask, skills);
  const config = store.getRuntimeConfig();
  const runtimeSecrets = store.getRuntimeSecrets();
  const queuedRun = store.getQueuedExecutableToolRunForTask(effectiveTask.id);
  if (queuedRun) {
    const executed = await executeApprovedToolRun(effectiveTask, queuedRun);
    if (executed.ok) {
      await completeToolTask(effectiveTask, queuedRun.providerId, executed.outputText, executed.changedFiles);
      return true;
    }

    if (queuedRun.riskLevel === "high") {
      const failed = store.failTask(effectiveTask.id, executed.errorText ?? "Approved high-risk tool run failed.");
      if (failed) {
        syncFounderWorkflowFailure(failed);
      }
      return true;
    }
  }

  const statuses = listToolProviderStatuses(env, config.tools, runtimeSecrets);
  const providers = selectAvailableProviders(config.tools, statuses);
  if (providers.length === 0) {
    const failed = store.failTask(task.id, "No tool provider is available. Install opencode/codex/claude binary first.");
    if (failed) {
      syncFounderWorkflowFailure(failed);
    }
    return true;
  }

  const riskLevel = detectToolRiskLevel(effectiveTask.instruction, config.tools);
  let lastError = "";

  for (const provider of providers) {
    const instructions = [buildWorkspaceConstrainedInstruction(effectiveTask)];
    if (provider.providerId === "opencode") {
      instructions.push(buildWorkspaceStrictRetryInstruction(effectiveTask));
    }
    for (let attemptIndex = 0; attemptIndex < instructions.length; attemptIndex += 1) {
      const instruction = instructions[attemptIndex] ?? effectiveTask.instruction;
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
        taskId: effectiveTask.id,
        roleId: effectiveTask.roleId,
        providerId: provider.providerId,
        title: attemptIndex === 0 ? effectiveTask.title : `${effectiveTask.title} (retry-${attemptIndex})`,
        instruction,
        command: commandSpec.command,
        args: commandSpec.args,
        riskLevel,
        requestedBy: effectiveTask.requestedBy,
        status: "queued",
        approvalStatus: "not_required"
      });

      const approval = await ensureToolRunApproval(effectiveTask, toolRun);
      if (approval.state === "pending") {
        return true;
      }

      const executableRun = approval.approvedRun ?? store.getToolRun(toolRun.id) ?? toolRun;
      const executed = await executeApprovedToolRun(effectiveTask, executableRun);
      if (executed.ok) {
        await completeToolTask(effectiveTask, provider.providerId, executed.outputText, executed.changedFiles);
        return true;
      }

      lastError = executed.errorText ?? "unknown tool execution error";
      if (!isWorkspaceBoundaryErrorText(lastError)) {
        break;
      }
    }
  }

  const failed = store.failTask(effectiveTask.id, lastError || "All available tool providers failed.");
  if (failed) {
    syncFounderWorkflowFailure(failed);
  }
  return true;
}

async function processNormalTask(
  task: TaskRecord,
  skillIds: string[],
  skills: SkillBindingRecord[]
): Promise<boolean> {
  const effectiveTask: TaskRecord = {
    ...task,
    instruction: buildRoleAwareInstruction(task, skillIds)
  };
  persistTaskRuntimeSkillSnapshot(effectiveTask, skills);
  const config = store.getRuntimeConfig();
  const runtimeSecrets = store.getRuntimeSecrets();
  const memoryBackend = config.memory.roleBackends[task.roleId] ?? config.memory.defaultBackend;
  const preferSemanticRetrieval = memoryBackend === "vector-db";
  const snippets = await knowledgeBase.retrieve(effectiveTask.instruction, 5, {
    keywordWeight: preferSemanticRetrieval ? 0.45 : 0.7,
    semanticWeight: preferSemanticRetrieval ? 0.55 : 0.3,
    minSemanticScore: preferSemanticRetrieval ? 0.05 : 0.1
  });
  // Pre-fetch web search only when tool calling is NOT available (local-only mode without zhipu)
  const hasToolCallingBackend = env.primaryBackend === "zhipu" || env.primaryBackend === "sglang";
  const webSearchSnippets =
    !hasToolCallingBackend && skillIds.includes("web-search")
      ? await retrieveWebSearchSnippets(effectiveTask, skillIds)
      : [];
  const runtimeSnippets = buildRuntimeContextSnippets(effectiveTask);
  const sessionSnippets = buildSessionContextSnippets(effectiveTask);
  const conversationHistory = buildConversationHistory(effectiveTask);
  const runtimeTask =
    effectiveTask.source === "feishu"
      ? {
          ...effectiveTask,
          instruction: buildFeishuExecutionInstruction(effectiveTask.instruction)
        }
      : {
          ...effectiveTask,
          instruction: effectiveTask.instruction
        };

  // Build tool context so the agent can call tools autonomously
  const searchProvider = resolveSearchProviderId(store.getRuntimeSettings()["SEARCH_PROVIDER"]) ?? "";
  const toolContext = {
    workDir: buildWorkDir(env.workspaceRoot, effectiveTask.id),
    secrets: runtimeSecrets,
    searchProvider
  };

  const runtimeExecuteInput: RuntimeExecutionInput = {
    task: runtimeTask,
    config,
    skills,
    snippets: [...runtimeSnippets, ...sessionSnippets, ...webSearchSnippets, ...snippets],
    toolContext,
    conversationHistory,
    preExecutePlan: !task.pendingInput && !shouldFounderWorkflowBypassNeedsInput(task),
    telemetry: initGlobalTelemetry(telemetryDb),
    knowledgeBase
  };

  // Inject workspace context from session metadata for cross-session continuity
  if (task.sessionId) {
    const session = store.getSession(task.sessionId);
    const ctx = session?.metadata?.workspaceContext as
      | {
          preferredTechStack?: string[];
          communicationStyle?: "concise" | "detailed" | "default";
          activeProjects?: Array<{ name: string; stage: string; lastUpdate: string }>;
          keyDecisions?: Array<{ decision: string; rationale: string; timestamp: string }>;
        }
      | undefined;
    if (ctx) {
      const workspaceContext: NonNullable<RuntimeExecutionInput["workspaceContext"]> = {};
      if (ctx.preferredTechStack) workspaceContext.preferredTechStack = ctx.preferredTechStack;
      if (ctx.communicationStyle) workspaceContext.communicationStyle = ctx.communicationStyle;
      if (ctx.activeProjects) workspaceContext.activeProjects = ctx.activeProjects;
      if (ctx.keyDecisions) workspaceContext.keyDecisions = ctx.keyDecisions;
      if (Object.keys(workspaceContext).length > 0) {
        runtimeExecuteInput.workspaceContext = workspaceContext;
      }
    }
  }

  const output = await runtime.execute(runtimeExecuteInput);

  // Detect __NEEDS_INPUT__ marker in LLM output for task-level user interaction
  const needsInputMarker = output.result.deliverable.match(/__NEEDS_INPUT__\s*(?:\{[^}]*\})?/);
  if (needsInputMarker) {
    // Try to parse structured data from the marker
    let question = output.result.deliverable;
    let context: string | undefined = undefined;
    const jsonMatch = needsInputMarker[0].match(/\{([^}]*)\}/);
    if (jsonMatch) {
      try {
        const data = JSON.parse(`{${jsonMatch[1]}}`);
        if (data.question && typeof data.question === "string") {
          question = data.question;
        }
        if (data.context && typeof data.context === "string") {
          context = data.context;
        }
      } catch {
        // If JSON parse fails, extract question from text before the marker
        question = output.result.deliverable.split("__NEEDS_INPUT__")[0]?.trim() || "请提供更多信息以帮助完成任务";
      }
    } else {
      // No JSON, extract question from text before the marker
      question = output.result.deliverable.split("__NEEDS_INPUT__")[0]?.trim() || "请提供更多信息以帮助完成任务";
    }

    // Pause the task
    const paused = store.pauseTask(effectiveTask.id, { question, context });
    if (paused && paused.sessionId) {
      // Notify user via session message
      store.appendSessionMessage({
        sessionId: paused.sessionId,
        actorType: "system",
        actorId: "task-runner",
        roleId: paused.roleId,
        messageType: "text",
        content: `任务需要你补充信息：${question}`,
        metadata: {
          taskId: paused.id,
          pausedAt: paused.pendingInput?.pausedAt
        }
      });
    }
    if (paused?.source === "feishu" && paused.chatId) {
      const card = buildTaskPausedCard({
        title: paused.title,
        roleLabel: ROLE_LABELS[paused.roleId] ?? paused.roleId,
        question,
        workflowSummary: buildWorkflowStatusSummary(paused, { includeGoal: true })
      });
      await notifyFeishuCard(paused.chatId, card);
    }
    // Do not complete the task - leave it in paused_input state
    return true;
  }

  const persisted = await ensureTextDeliverableArtifact(effectiveTask, output.result, output.artifactFiles);
  output.result = persisted.result;
  output.artifactFiles = persisted.artifactFiles;
  const deliverableMode = resolveDeliverableMode(effectiveTask);
  const deliverableValidation = validateDeliverableArtifacts({
    task: effectiveTask,
    artifactFiles: output.artifactFiles
  });
  if (!deliverableValidation.ok) {
    await failDeliverableContract(effectiveTask, deliverableMode, deliverableValidation.error);
    return true;
  }

  const rawMessage = `${output.result.summary}\n\n${output.result.deliverable.slice(0, 1200)}`;
  const userFacingMessage =
    effectiveTask.source === "feishu"
      ? condenseFeishuReplyIfNeeded({
          instruction: effectiveTask.instruction,
          message: sanitizeFeishuReplyText(rawMessage)
        })
      : rawMessage;
  // Persist any files created by tool calls (run_code / write_file) to task metadata
  if (output.artifactFiles.length > 0) {
    store.patchTaskMetadata(effectiveTask.id, {
      toolChangedFiles: output.artifactFiles,
      runtimeBackendUsed: output.backendUsed,
      runtimeModelUsed: output.modelUsed,
      runtimeToolLoopEnabled: true,
      runtimeToolRegistry: "default",
      runtimeRulesEngine: "default",
      deliverableMode,
      deliverableContractViolated: false
    });
  } else {
    store.patchTaskMetadata(effectiveTask.id, {
      runtimeBackendUsed: output.backendUsed,
      runtimeModelUsed: output.modelUsed,
      runtimeToolLoopEnabled: true,
      runtimeToolRegistry: "default",
      runtimeRulesEngine: "default",
      deliverableMode,
      deliverableContractViolated: false
    });
  }
  const completed = store.completeTask(effectiveTask.id, output.result, output.reflection);
  if (completed) {
    updateSessionProjectMemoryFromTask(completed, {
      currentStage: "artifact_delivered"
    });
    syncSkillIntegrationOutcome(completed);
    syncInstalledSkillVerification(completed);
    syncFounderWorkflowProgress(completed);

    // Workspace memory: extract tech decisions and project context from completed task
    syncWorkspaceMemoryFromTask(completed, output.result);

    // Light collaboration: create a quick review task after primary task completes
    if (completed.metadata?.lightCollaboration === true && !completed.metadata?.lightReviewTaskId && !completed.metadata?.isLightReview) {
      // Phase 4: Determine reviewers from collaborationPlan, fallback to LIGHT_REVIEWER_MAP
      const plan = completed.metadata?.collaborationPlan as { level?: string; suggestedReviewers?: string[] } | undefined;
      const planReviewers: RoleId[] = (plan?.suggestedReviewers ?? []).filter((r): r is RoleId => ROLE_IDS.includes(r as RoleId));
      const singleReviewerFallback = resolveLightCollaborationReviewer(completed.roleId);
      const reviewers: RoleId[] = planReviewers.length > 0 ? planReviewers : [singleReviewerFallback];
      const primaryReviewerRoleId = reviewers[0]!;

      // Phase 2: Create collaboration room and record primary output
      const collaborationId = ensureCollaborationRoom(completed, primaryReviewerRoleId);
      const collabService = new AgentCollaborationService(store);
      collabService.sendMessage({
        collaborationId,
        taskId: completed.id,
        fromRoleId: completed.roleId,
        toRoleIds: reviewers,
        messageType: "summary",
        content: `${output.result.summary}\n\n${output.result.deliverable.slice(0, 2000)}`
      });

      // Phase 4: Create parallel review tasks if multiple reviewers
      const parallelReviewGroupId = reviewers.length > 1 ? crypto.randomUUID() : undefined;
      const reviewTaskIds: string[] = [];
      for (const reviewerRoleId of reviewers) {
        const roomContext = buildCollaborationRoomContext(collaborationId);
        const reviewInstruction = buildReviewInstruction(completed, output.result, reviewerRoleId, roomContext);
        const reviewTaskMeta: Record<string, unknown> = {
          lightCollaboration: true,
          isLightReview: true,
          verifierOnly: true,
          lightCollaborationParentId: completed.id,
          collaborationId
        };
        if (parallelReviewGroupId !== undefined) {
          reviewTaskMeta.parallelReviewGroupId = parallelReviewGroupId;
          reviewTaskMeta.parallelReviewTotal = reviewers.length;
        }
        const createReviewInput: Parameters<typeof store.createTask>[0] = {
          source: completed.source,
          roleId: reviewerRoleId,
          title: `[轻量审阅] ${completed.title}`,
          instruction: reviewInstruction,
          priority: 5,
          metadata: reviewTaskMeta
        };
        if (completed.sessionId !== undefined) createReviewInput.sessionId = completed.sessionId;
        if (completed.requestedBy !== undefined) createReviewInput.requestedBy = completed.requestedBy;
        if (completed.chatId !== undefined) createReviewInput.chatId = completed.chatId;
        const reviewTask = store.createTask(createReviewInput);
        reviewTaskIds.push(reviewTask.id);
      }

      store.patchTaskMetadata(completed.id, {
        lightReviewTaskId: reviewTaskIds[0],
        lightReviewTaskIds: reviewTaskIds
      });
      if (completed.sessionId) {
        const reviewerLabels = reviewers.map((r) => ROLE_LABELS[r] ?? r).join("、");
        store.appendSessionMessage({
          sessionId: completed.sessionId,
          actorType: "system",
          actorId: "task-runner",
          messageType: "event",
          content: `已创建${reviewers.length > 1 ? `${reviewers.length}个` : ""}轻量审阅任务，${reviewerLabels}正在快速检查…`,
          metadata: {
            type: "light_review_queued",
            reviewTaskIds,
            parentTaskId: completed.id
          }
        });
      }
      if (completed.source === "feishu" && completed.chatId) {
        const reviewerLabel = reviewers.map((r) => ROLE_LABELS[r] ?? r).join(" + ");
        const card = buildLightReviewQueuedCard({
          parentTitle: completed.title,
          reviewerLabel,
        });
        await notifyFeishuCard(completed.chatId, card);
      }
    }

    // Light collaboration: if this IS a review task, check whether revision is needed
    if (
      completed.metadata?.isLightReview === true &&
      !completed.metadata?.lightIterationTaskId
    ) {
      const parentTaskId = completed.metadata?.lightCollaborationParentId as string | undefined;
      const parentTask = parentTaskId ? store.getTask(parentTaskId) : undefined;
      if (parentTask && !parentTask.metadata?.lightIterationTaskId) {

        // Phase 2: Record review output into the collaboration room
        const collaborationId = typeof completed.metadata?.collaborationId === "string"
          ? completed.metadata.collaborationId
          : typeof parentTask.metadata?.collaborationId === "string"
            ? parentTask.metadata.collaborationId
            : undefined;
        if (collaborationId) {
          const collabService = new AgentCollaborationService(store);
          collabService.sendMessage({
            collaborationId,
            taskId: completed.id,
            fromRoleId: completed.roleId,
            toRoleIds: [parentTask.roleId],
            messageType: "review_result",
            content: `${output.result.summary}\n\n${output.result.deliverable.slice(0, 2000)}`
          });
        }

        const reviewText = output.result.deliverable + " " + output.result.summary;
        const iterationCount = typeof parentTask.metadata?.collaborationIterationCount === "number"
          ? parentTask.metadata.collaborationIterationCount : 0;
        const maxIterations = resolveMaxIterations(parentTask);

        // Phase 4: If this is part of a parallel review group, wait until all are done
        const parallelGroupId = completed.metadata?.parallelReviewGroupId as string | undefined;
        if (parallelGroupId) {
          const allReviewTaskIds = (parentTask.metadata?.lightReviewTaskIds as string[] | undefined) ?? [];
          const allDone = allReviewTaskIds.every((tid) => {
            const t = store.getTask(tid);
            return t && (t.status === "completed" || t.status === "failed");
          });
          if (!allDone) {
            // Other reviewers are still running — skip aggregation for now, they will trigger it
            return true;
          }

          // Phase 4: Aggregate all parallel review outputs
          const completedReviews = allReviewTaskIds
            .map((tid) => store.getTask(tid))
            .filter((t): t is NonNullable<typeof t> => t?.status === "completed");
          const aggregatedText = completedReviews
            .map((t) => `[${ROLE_LABELS[t.roleId] ?? t.roleId}的审阅]\n${t.result?.deliverable?.slice(0, 1000) ?? ""}`)
            .join("\n\n");
          const assessment = await assessReviewQuality(aggregatedText, parentTask.instruction, iterationCount, maxIterations);
          await applyQualityAssessment({ assessment, parentTask, parentTaskId: parentTaskId!, collaborationId, iterationCount, maxIterations, completed });
          return true;
        }

        // Phase 3 + 4: LLM-based quality assessment (falls back to regex if LLM fails)
        const assessment = await assessReviewQuality(reviewText, parentTask.instruction, iterationCount, maxIterations);
        await applyQualityAssessment({ assessment, parentTask, parentTaskId: parentTaskId!, collaborationId, iterationCount, maxIterations, completed });
      }
    }
  }
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

  // Phase 2: Record iteration output into collaboration room
  if (completed?.metadata?.isLightIteration === true && typeof completed.metadata?.collaborationId === "string") {
    const collabId = completed.metadata.collaborationId;
    const collabService = new AgentCollaborationService(store);
    const parentTaskId = completed.metadata?.lightCollaborationParentId as string | undefined;
    const parentTask = parentTaskId ? store.getTask(parentTaskId) : undefined;
    const reviewerRoleId = parentTask ? resolveLightCollaborationReviewer(parentTask.roleId) : completed.roleId;
    collabService.sendMessage({
      collaborationId: collabId,
      taskId: completed.id,
      fromRoleId: completed.roleId,
      toRoleIds: [reviewerRoleId],
      messageType: "summary",
      content: `[修订版本]\n${output.result.summary}\n\n${output.result.deliverable.slice(0, 2000)}`
    });
  }

  if (completed?.source === "feishu" && completed.chatId) {
    // light_collaboration final deliverable → send interactive feedback card
    const isFinalLightDeliverable =
      completed.metadata?.lightCollaboration === true &&
      completed.metadata?.isLightReview !== true &&
      (completed.metadata?.isLightIteration === true || !completed.metadata?.lightReviewTaskId);
    if (isFinalLightDeliverable) {
      const card = buildTaskFeedbackCard(completed, output.result.summary);
      await notifyFeishuCard(completed.chatId, card);
    } else {
      const card = buildTaskCompletedCard({
        title: completed.title,
        roleLabel: ROLE_LABELS[completed.roleId] ?? completed.roleId,
        summary: userFacingMessage.slice(0, 800),
        workflowSummary: buildWorkflowStatusSummary(completed, { includeGoal: true, includeArtifacts: true })
      });
      await notifyFeishuCard(completed.chatId, card);
    }
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
    /^[a-z][\w-]{0,31}\s*[:：]\s*/i
  ];
  for (const pattern of stripPatterns) {
    const next = normalized.replace(pattern, "").trim();
    if (next && next !== normalized) {
      normalized = next;
    }
  }
  return normalized;
}

function isMiniGameLikeInstruction(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) {
    return false;
  }
  return /(?:小游戏|game|canvas|网页游戏|web\s*game|h5\s*game)/i.test(normalized);
}

function resolveMiniGameTargetDir(task: TaskRecord): string {
  const match = task.instruction.match(/\/home\/xsuper\/workspace\/playground\/[^\s"'`)]*/i)?.[0];
  if (match) {
    const cleaned = match.replace(/[),.;]+$/g, "");
    const asDir = /\.[a-z0-9]{1,8}$/i.test(cleaned) ? path.dirname(cleaned) : cleaned;
    return path.normalize(asDir);
  }
  return path.join(env.workspaceRoot, "playground", `game-${task.id.slice(0, 8)}`);
}

function buildMiniGameExecutionConstraints(task: TaskRecord): string[] {
  const targetDir = resolveMiniGameTargetDir(task);
  const relativeDir = path.relative(env.workspaceRoot, targetDir).replaceAll(path.sep, "/");
  const safeRelativeDir = relativeDir.startsWith("..") ? "playground" : relativeDir || "playground";
  return [
    "",
    "小游戏专项约束:",
    `- 目标目录固定为 ${targetDir}（相对 workspace: ${safeRelativeDir}）。`,
    "- 仅允许在该目录内创建/修改文件，禁止在其他目录写入。",
    "- 默认文件白名单：index.html、style.css、game.js、README.md。",
    "- 如需新增额外文件，最多 2 个，且必须在结论中说明新增理由。",
    `- 完成后必须给出可访问地址：http://127.0.0.1:${env.port}/playground/${safeRelativeDir}/index.html`
  ];
}

function buildWorkspaceConstrainedInstruction(task: TaskRecord): string {
  const lines = [
    buildRoleAwareInstruction(task),
    "",
    "执行约束:",
    "- 输出结构必须包含：结论、关键依据、下一步行动（不超过 3 条）。",
    `- 仅可在工作目录 ${env.workspaceRoot} 内读写文件。`,
    "- 严禁访问或操作任何目录外路径。",
    "- 完成后必须输出实际变更文件路径（相对工作目录）。"
  ];
  if (isMiniGameLikeInstruction(task.instruction)) {
    lines.push(...buildMiniGameExecutionConstraints(task));
  }
  return lines.join("\n");
}

function buildWorkspaceStrictRetryInstruction(task: TaskRecord): string {
  const lines = [
    buildRoleAwareInstruction(task),
    "",
    "重试约束(严格):",
    "- 输出结构必须包含：结论、关键依据、下一步行动（不超过 3 条）。",
    `- 只允许使用当前目录 ${env.workspaceRoot}。`,
    "- 禁止请求 external_directory 权限。",
    "- 如果无法完成，直接说明阻塞原因并停止。"
  ];
  if (isMiniGameLikeInstruction(task.instruction)) {
    lines.push(...buildMiniGameExecutionConstraints(task));
  }
  return lines.join("\n");
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
  if (candidate.startsWith("-")) {
    return undefined;
  }
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
  const [topLevelDir] = normalized.split("/", 1);
  if (topLevelDir && ARTIFACT_SCAN_IGNORED_DIRS.has(topLevelDir)) {
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

function normalizeGoalRunHandoffNextActions(values: string[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
    if (normalized.length >= 6) {
      break;
    }
  }
  return normalized;
}

export function extractArtifactFilesFromText(text: string): string[] {
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

function toProjectMemorySummary(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }
  return normalized.length <= 240 ? normalized : `${normalized.slice(0, 239)}…`;
}

function extractProjectMemoryDecisions(task: TaskRecord): string[] {
  const result = task.result;
  if (!result) {
    return [];
  }
  const candidates = [
    result.summary,
    ...result.followUps.map((item) => `后续动作：${item}`)
  ];
  return dedupeSortedStrings(candidates.map((item) => toProjectMemorySummary(item)).filter(Boolean)).slice(0, 6);
}

function updateSessionProjectMemoryFromTask(task: TaskRecord, patch?: {
  currentStage?: string | undefined;
  unresolvedQuestions?: string[] | undefined;
  nextActions?: string[] | undefined;
  latestSummary?: string | undefined;
}): void {
  if (!task.sessionId) {
    return;
  }
  const artifacts = collectTaskArtifactFiles(task).slice(0, 12);
  const result = task.result;
  const stage =
    patch?.currentStage ??
    (task.status === "completed" ? "delivered" : task.status === "failed" || task.status === "cancelled" ? "blocked" : "executing");
  const latestSummary =
    patch?.latestSummary ??
    (task.status === "completed"
      ? toProjectMemorySummary(result?.summary ?? result?.deliverable ?? "")
      : toProjectMemorySummary(task.errorText ?? ""));
  const nextActions =
    patch?.nextActions ??
    (task.status === "completed" ? (result?.followUps ?? []).slice(0, 6) : []);
  const unresolvedQuestions =
    patch?.unresolvedQuestions ??
    (task.status === "failed" || task.status === "cancelled" ? [task.errorText ?? "任务受阻"] : []);

  store.updateSessionProjectMemory(
    task.sessionId,
    {
      currentGoal: task.title,
      currentStage: stage,
      latestSummary,
      keyDecisions: extractProjectMemoryDecisions(task),
      unresolvedQuestions,
      nextActions,
      latestArtifacts: artifacts,
      lastTaskId: task.id,
      updatedBy: task.roleId
    },
    {
      lastTaskId: task.id,
      lastTaskStatus: task.status,
      lastTaskRoleId: task.roleId
    }
  );
}

export function resolveSkillIntegrationCompletion(task: TaskRecord): {
  requestedSkillId: string;
  skillName: string;
  installedRole: string;
  runtimeAvailable: boolean;
  installState: "local_installable" | "discover_only";
} | null {
  const metadata = task.metadata as {
    requestedSkillId?: unknown;
    requestedSkillName?: unknown;
    requestedSkillTargetRoleId?: unknown;
  };
  const requestedSkillId =
    typeof metadata.requestedSkillId === "string" ? metadata.requestedSkillId.trim() : "";
  if (!requestedSkillId || task.status !== "completed") {
    return null;
  }

  const definition = getSkillDefinition(requestedSkillId);
  const runtimeAvailable = Boolean(definition);
  const installState = runtimeAvailable ? "local_installable" : "discover_only";
  const installedRole =
    typeof metadata.requestedSkillTargetRoleId === "string" ? metadata.requestedSkillTargetRoleId.trim() : "";
  const skillName =
    typeof metadata.requestedSkillName === "string" && metadata.requestedSkillName.trim()
      ? metadata.requestedSkillName.trim()
      : requestedSkillId;
  return {
    requestedSkillId,
    skillName,
    installedRole,
    runtimeAvailable,
    installState
  };
}


/**
 * Extract tech stack decisions and project context from a completed task
 * and persist them to workspace memory for cross-session continuity.
 */
function syncWorkspaceMemoryFromTask(task: TaskRecord, result: TaskResult): void {
  try {
    // Detect tech stack mentions in instruction + deliverable
    const fullText = `${task.instruction} ${result.summary} ${result.deliverable.slice(0, 500)}`;
    const techPatterns: Record<string, RegExp> = {
      "React": /\bReact\b/i,
      "Vue": /\bVue\.?js\b/i,
      "Next.js": /\bNext\.js\b/i,
      "TypeScript": /\bTypeScript\b/i,
      "Node.js": /\bNode\.js\b/i,
      "Python": /\bPython\b/i,
      "FastAPI": /\bFastAPI\b/i,
      "PostgreSQL": /\bPostgreSQL\b/i,
      "MySQL": /\bMySQL\b/i,
      "MongoDB": /\bMongoDB\b/i,
      "Redis": /\bRedis\b/i,
      "Docker": /\bDocker\b/i,
      "Firebase": /\bFirebase\b/i,
      "Tailwind": /\bTailwind\b/i
    };

    const detectedStack: string[] = [];
    for (const [name, pattern] of Object.entries(techPatterns)) {
      if (pattern.test(fullText)) {
        detectedStack.push(name);
      }
    }

    if (detectedStack.length > 0) {
      const current = store.getWorkspaceMemory();
      const existingStack = new Set(current.userPreferences.preferredTechStack);
      const newEntries = detectedStack.filter((t) => !existingStack.has(t));
      if (newEntries.length > 0) {
        store.setWorkspacePreferences({
          preferredTechStack: [...current.userPreferences.preferredTechStack, ...newEntries].slice(0, 10)
        });
      }
    }

    // Update active project context if instruction mentions a project name
    const projectMatch = task.instruction.match(/(?:项目|project|系统|platform|app|应用)\s*[：:「"']?\s*([^\s，,。.「"']{2,20})/i);
    if (projectMatch && projectMatch[1]) {
      const projectName = projectMatch[1].trim();
      if (projectName.length >= 2 && projectName.length <= 20) {
        store.updateWorkspaceProject(projectName, "active");
      }
    }
  } catch {
    // Workspace memory sync is best-effort — never block task completion
  }
}

function syncSkillIntegrationOutcome(task: TaskRecord): void {
  const outcome = resolveSkillIntegrationCompletion(task);
  if (!outcome) {
    return;
  }

  store.patchTaskMetadata(task.id, {
    requestedSkillInstallState: outcome.installState,
    requestedSkillRuntimeAvailable: outcome.runtimeAvailable,
    requestedSkillRuntimeCheckedAt: new Date().toISOString()
  });

  if (task.sessionId) {
    store.appendSessionMessage({
      sessionId: task.sessionId,
      actorType: "system",
      actorId: "task-runner",
      messageType: "event",
      content: outcome.runtimeAvailable
        ? `Skill 已接入本地 runtime：${outcome.skillName}`
        : `Skill 接入任务已完成，但本地 runtime 仍未识别：${outcome.skillName}`,
      metadata: {
        type: outcome.runtimeAvailable ? "skill_runtime_ready" : "skill_runtime_pending",
        taskId: task.id,
        skillId: outcome.requestedSkillId,
        targetRoleId: outcome.installedRole,
        installState: outcome.installState
      }
    });
  }

  updateSessionProjectMemoryFromTask(task, {
    currentStage: outcome.runtimeAvailable ? "skill_runtime_ready" : "skill_runtime_pending",
    latestSummary: outcome.runtimeAvailable
      ? `Skill ${outcome.requestedSkillId} 已接入本地 runtime，可继续安装到 ${outcome.installedRole || "目标角色"}。`
      : `Skill ${outcome.requestedSkillId} 接入任务已完成，但本地 runtime 尚未识别该 skill。`,
    nextActions: outcome.runtimeAvailable
      ? [
          `给 ${outcome.installedRole || "目标角色"} 安装 ${outcome.requestedSkillId} skill`,
          "验证安装后角色是否按 skill 正常工作"
        ]
      : ["检查 skill definition 是否正确加载", "确认 runtime/catalog 是否包含该 skill"]
  });
}

function syncInstalledSkillVerification(task: TaskRecord): void {
  const metadata = task.metadata as {
    verifyInstalledSkillId?: unknown;
    verifyInstalledSkillName?: unknown;
  };
  const skillId = typeof metadata.verifyInstalledSkillId === "string" ? metadata.verifyInstalledSkillId.trim() : "";
  if (!skillId) {
    return;
  }
  const verificationStatus =
    task.status === "completed" ? "verified" : task.status === "failed" || task.status === "cancelled" ? "failed" : undefined;
  if (!verificationStatus) {
    return;
  }
  const binding = store.updateSkillBindingVerification({
    scopeId: task.roleId,
    skillId,
    verificationStatus,
    verifiedAt: new Date().toISOString(),
    lastVerifiedTaskId: task.id
  });
  if (!binding) {
    return;
  }
  const skillName =
    typeof metadata.verifyInstalledSkillName === "string" && metadata.verifyInstalledSkillName.trim()
      ? metadata.verifyInstalledSkillName.trim()
      : skillId;
  if (task.sessionId) {
    store.appendSessionMessage({
      sessionId: task.sessionId,
      actorType: "system",
      actorId: "task-runner",
      messageType: "event",
      content:
        verificationStatus === "verified"
          ? `Skill 已验证可用：${skillName}`
          : `Skill 验证失败：${skillName}`,
      metadata: {
        type: verificationStatus === "verified" ? "skill_verified" : "skill_verify_failed",
        taskId: task.id,
        skillId,
        roleId: task.roleId,
        verificationStatus
      }
    });
  }
  updateSessionProjectMemoryFromTask(task, {
    currentStage: verificationStatus === "verified" ? "skill_verified" : "skill_verification_failed",
    latestSummary:
      verificationStatus === "verified"
        ? `Skill ${skillId} 已在 ${task.roleId} 上验证可用。`
        : `Skill ${skillId} 在 ${task.roleId} 上的验证失败。`,
    nextActions:
      verificationStatus === "verified"
        ? [`现在可以让 ${task.roleId} 正式按 ${skillId} 执行真实任务`]
        : [`检查 ${task.roleId} 的验证输出和 skill 约束`, `修复 ${skillId} 后重新验证`]
  });
}

type FounderWorkflowStage = "prd" | "implementation" | "qa" | "recap";

function normalizeFounderWorkflowStage(value: unknown): FounderWorkflowStage | undefined {
  return value === "prd" || value === "implementation" || value === "qa" || value === "recap" ? value : undefined;
}

function mapFounderWorkflowStageToOrchestrationStage(stage: FounderWorkflowStage | undefined): string {
  switch (stage) {
    case "prd":
      return "spec";
    case "implementation":
      return "implementation";
    case "qa":
      return "verify";
    case "recap":
      return "deliver";
    default:
      return "spec";
  }
}

function dedupeFounderStrings(values: string[], limit = 20): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).slice(0, limit);
}

function buildFounderDecisionEntries(task: TaskRecord): string[] {
  const result = task.result;
  return dedupeFounderStrings([
    typeof result?.summary === "string" ? result.summary : "",
    ...(Array.isArray(result?.followUps) ? result.followUps : []),
    ...(task.errorText ? [task.errorText] : [])
  ]);
}

function mergeFounderArtifactItems(existing: OrchestrationArtifactItem[], incoming: OrchestrationArtifactItem[]): OrchestrationArtifactItem[] {
  const merged = new Map<string, OrchestrationArtifactItem>();
  for (const item of [...existing, ...incoming]) {
    if (!item.path) {
      continue;
    }
    merged.set(item.path, item);
  }
  return Array.from(merged.values()).sort((left, right) => left.path.localeCompare(right.path));
}

function buildFounderArtifactItems(task: TaskRecord, stage: string, status: OrchestrationArtifactItem["status"]): OrchestrationArtifactItem[] {
  return collectTaskArtifactFiles(task).map((filePath) => ({
    path: filePath,
    title: path.basename(filePath),
    stage,
    status
  }));
}

function ensureTaskOrchestrationState(task: TaskRecord, fallbackStage: string): OrchestrationStateRecord {
  const metadata = task.metadata as Record<string, unknown>;
  const existing = normalizeOrchestrationState(metadata.orchestrationState);
  if (existing) {
    return existing;
  }
  const goal =
    typeof metadata.founderWorkflowOriginalInstruction === "string" && metadata.founderWorkflowOriginalInstruction.trim()
      ? metadata.founderWorkflowOriginalInstruction.trim()
      : task.instruction;
  return createOrchestrationState({
    ownerRoleId: task.roleId,
    goal,
    stage: fallbackStage,
    updatedBy: task.roleId,
    nextActions: []
  });
}

function patchTaskOrchestrationState(task: TaskRecord, patch: OrchestrationStatePatch, fallbackStage: string): OrchestrationStateRecord {
  const baseState = ensureTaskOrchestrationState(task, fallbackStage);
  const nextState = mergeOrchestrationState(baseState, patch) ?? baseState;
  store.patchTaskMetadata(task.id, {
    orchestrationMode: "main_agent",
    orchestrationState: nextState
  });
  return nextState;
}

function resolveFounderWorkflowRootTask(task: TaskRecord): TaskRecord | undefined {
  const metadata = task.metadata as Record<string, unknown>;
  const rootTaskId = typeof metadata.founderWorkflowRootTaskId === "string" && metadata.founderWorkflowRootTaskId.trim()
    ? metadata.founderWorkflowRootTaskId.trim()
    : task.id;
  return store.getTask(rootTaskId) ?? (rootTaskId === task.id ? task : undefined);
}

function syncFounderOrchestrationState(task: TaskRecord, patch: OrchestrationStatePatch, fallbackStage: string): void {
  const rootTask = resolveFounderWorkflowRootTask(task) ?? task;
  const nextState = patchTaskOrchestrationState(rootTask, patch, fallbackStage);
  if (task.id !== rootTask.id) {
    store.patchTaskMetadata(task.id, {
      orchestrationMode: "main_agent",
      orchestrationState: nextState,
      founderWorkflowRootTaskId: rootTask.id
    });
  }
}

function shortenFounderText(value: string, maxLength = 72): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function capFounderBlock(value: string, maxLength = 1200): string {
  const normalized = value.trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function resolveFounderBuildRole(text: string): RoleId {
  const normalized = text.toLowerCase();
  if (/(?:api|接口|数据库|服务端|后端|auth|鉴权|schema)/i.test(normalized)) {
    return "backend";
  }
  if (/(?:页面|官网|landing|首页|ui|ux|前端|login|表单|dashboard)/i.test(normalized)) {
    return "frontend";
  }
  return "engineering";
}

function shouldFounderWorkflowBypassNeedsInput(task: TaskRecord): boolean {
  const metadata = task.metadata as Record<string, unknown>;
  if (metadata.founderWorkflowKind !== "founder_delivery") {
    return false;
  }
  const stage = normalizeFounderWorkflowStage(metadata.founderWorkflowStage);
  return stage === "implementation" || stage === "qa" || stage === "recap";
}

export function resolveFounderWorkflowNextSpec(task: TaskRecord): {
  nextStage: FounderWorkflowStage;
  roleId: RoleId;
  title: string;
  instruction: string;
  deliverableMode: "artifact_required";
  deliverableSections: string[];
  verifierOnly: boolean;
  stepIndex: number;
} | undefined {
  const metadata = task.metadata as Record<string, unknown>;
  if (metadata.founderWorkflowKind !== "founder_delivery" || task.status !== "completed") {
    return undefined;
  }
  const stage = normalizeFounderWorkflowStage(metadata.founderWorkflowStage);
  if (!stage) {
    return undefined;
  }
  const originalInstruction =
    typeof metadata.founderWorkflowOriginalInstruction === "string" && metadata.founderWorkflowOriginalInstruction.trim()
      ? metadata.founderWorkflowOriginalInstruction.trim()
      : task.instruction;
  const summary = task.result?.summary?.trim() || "";
  const deliverable = capFounderBlock(task.result?.deliverable?.trim() || "", 1200);
  const artifacts = collectTaskArtifactFiles(task).slice(0, 4);
  const artifactSection = artifacts.length > 0 ? `\n相关产物：\n- ${artifacts.join("\n- ")}` : "";
  const titleSource = shortenFounderText(originalInstruction, 48) || shortenFounderText(task.title, 48);

  if (stage === "prd") {
    const roleId = resolveFounderBuildRole(originalInstruction);
    return {
      nextStage: "implementation",
      roleId,
      title: `Founder Delivery / Build: ${titleSource}`,
      instruction: [
        "你正在执行 Founder Delivery Loop 的实现阶段。",
        "请基于以下原始目标和上一阶段产物，直接在 workspace 中完成最小可用实现，并产出真实变更文件。",
        "如果缺少技术细节，请使用合理默认假设继续推进，不要因为技术栈、认证方案、UI 组件库未明确而暂停等待用户输入。",
        "默认假设优先级：React + TypeScript + Vite；认证先用本地 mock / 假登录流程占位，并在交付中明确记录这些假设与后续替换点。",
        "",
        `原始目标：${originalInstruction}`,
        summary ? `PRD 摘要：${summary}` : "",
        deliverable ? `PRD 交付：\n${deliverable}` : "",
        artifactSection
      ]
        .filter(Boolean)
        .join("\n"),
      deliverableMode: "artifact_required",
      deliverableSections: ["变更文件", "实现说明", "启动命令", "验证结果", "剩余风险"],
      verifierOnly: false,
      stepIndex: 2
    };
  }

  if (stage === "implementation") {
    return {
      nextStage: "qa",
      roleId: "qa",
      title: `Founder Delivery / QA: ${titleSource}`,
      instruction: [
        "你正在执行 Founder Delivery Loop 的验证阶段。",
        "请基于以下原始目标与实现交付，输出测试步骤、通过标准、失败场景和最终验证结论。",
        "",
        `原始目标：${originalInstruction}`,
        summary ? `实现摘要：${summary}` : "",
        deliverable ? `实现交付：\n${deliverable}` : "",
        artifactSection
      ]
        .filter(Boolean)
        .join("\n"),
      deliverableMode: "artifact_required",
      deliverableSections: ["测试步骤", "通过标准", "失败场景", "验证结论", "待修复项"],
      verifierOnly: true,
      stepIndex: 3
    };
  }

  if (stage === "qa") {
    return {
      nextStage: "recap",
      roleId: "operations",
      title: `Founder Delivery / Recap: ${titleSource}`,
      instruction: [
        "你正在执行 Founder Delivery Loop 的 recap 阶段。",
        "请把本次交付过程沉淀成创始人可直接阅读的 recap，说明完成事项、关键进展、阻塞、下一步和待决策项。",
        "",
        `原始目标：${originalInstruction}`,
        summary ? `验证摘要：${summary}` : "",
        deliverable ? `验证交付：\n${deliverable}` : "",
        artifactSection
      ]
        .filter(Boolean)
        .join("\n"),
      deliverableMode: "artifact_required",
      deliverableSections: ["阶段结论", "已完成事项", "关键进展", "阻塞问题", "下一步", "待决策项"],
      verifierOnly: false,
      stepIndex: 4
    };
  }

  return undefined;
}

function syncFounderWorkflowFailure(task: TaskRecord): void {
  const metadata = task.metadata as Record<string, unknown>;
  if (metadata.founderWorkflowKind !== "founder_delivery") {
    return;
  }
  const stage = normalizeFounderWorkflowStage(metadata.founderWorkflowStage) ?? "prd";
  const orchestrationStage = mapFounderWorkflowStageToOrchestrationStage(stage);
  syncFounderOrchestrationState(
    task,
    {
      progress: {
        stage: orchestrationStage,
        status: "blocked",
        blocked: dedupeFounderStrings([task.title, task.errorText ?? ""]),
        nextActions: task.errorText ? [`修复 ${stage} 阶段阻塞：${task.errorText}`] : [`修复 ${stage} 阶段阻塞`]
      },
      decision: {
        summary: task.errorText ?? `Founder workflow blocked at ${stage}`,
        entries: buildFounderDecisionEntries(task)
      },
      artifactIndex: {
        items: mergeFounderArtifactItems(
          ensureTaskOrchestrationState(resolveFounderWorkflowRootTask(task) ?? task, orchestrationStage).artifactIndex.items,
          buildFounderArtifactItems(task, orchestrationStage, "failed")
        )
      },
      verificationStatus: stage === "qa" ? "failed" : undefined,
      updatedBy: task.roleId
    },
    orchestrationStage
  );
  if (task.sessionId) {
    store.appendSessionMessage({
      sessionId: task.sessionId,
      actorType: "system",
      actorId: "task-runner",
      messageType: "event",
      content: `Founder Delivery Loop 在 ${stage} 阶段受阻：${task.title}`,
      metadata: {
        type: "founder_workflow_blocked",
        taskId: task.id,
        stage,
        errorText: task.errorText ?? ""
      }
    });
  }
  updateSessionProjectMemoryFromTask(task, {
    currentStage: `founder_delivery_${stage}_blocked`,
    unresolvedQuestions: task.errorText ? [task.errorText] : undefined
  });
}

function syncFounderWorkflowProgress(task: TaskRecord): void {
  const metadata = task.metadata as Record<string, unknown>;
  if (metadata.founderWorkflowKind !== "founder_delivery" || task.status !== "completed") {
    return;
  }
  const stage = normalizeFounderWorkflowStage(metadata.founderWorkflowStage);
  if (!stage) {
    return;
  }

  const orchestrationStage = mapFounderWorkflowStageToOrchestrationStage(stage);
  const nextSpec = resolveFounderWorkflowNextSpec(task);
  const rootTask = resolveFounderWorkflowRootTask(task) ?? task;
  const rootState = ensureTaskOrchestrationState(rootTask, orchestrationStage);
  const completedStages = dedupeFounderStrings([...rootState.progress.completed, orchestrationStage]);
  const nextOrchestrationStage = nextSpec ? mapFounderWorkflowStageToOrchestrationStage(nextSpec.nextStage) : "deliver";
  const nextProgressStatus = nextSpec ? "active" : "completed";
  const nextVerificationStatus = stage === "qa" ? "verified" : rootState.verificationStatus;
  const nextArtifacts = mergeFounderArtifactItems(
    rootState.artifactIndex.items,
    buildFounderArtifactItems(task, orchestrationStage, stage === "qa" ? "verified" : "produced")
  );
  syncFounderOrchestrationState(
    task,
    {
      progress: {
        stage: nextSpec ? nextOrchestrationStage : "deliver",
        status: nextProgressStatus,
        completed: completedStages,
        inFlight: nextSpec ? [nextOrchestrationStage] : [],
        blocked: [],
        awaitingInput: [],
        nextActions: nextSpec ? [`dispatch ${nextSpec.nextStage} stage`] : ["delivery loop completed"]
      },
      decision: {
        summary: task.result?.summary ?? rootState.decision.summary,
        entries: dedupeFounderStrings([...rootState.decision.entries, ...buildFounderDecisionEntries(task)], 30)
      },
      artifactIndex: {
        items: nextArtifacts
      },
      verificationStatus: nextVerificationStatus,
      mergeReason: nextSpec ? `stage_completed:${stage}` : "workflow_completed",
      updatedBy: task.roleId
    },
    orchestrationStage
  );

  if (!nextSpec) {
    if (task.sessionId) {
      store.appendSessionMessage({
        sessionId: task.sessionId,
        actorType: "system",
        actorId: "task-runner",
        messageType: "event",
        content: `Founder Delivery Loop 已完成：${task.title}`,
        metadata: {
          type: "founder_workflow_completed",
          taskId: task.id,
          stage
        }
      });
    }
    updateSessionProjectMemoryFromTask(task, {
      currentStage: "founder_delivery_completed",
      nextActions: ["复用本次产物推进下一轮需求或发布动作"]
    });
    return;
  }

  if (store.listTaskChildren(task.id).length > 0) {
    return;
  }

  const workflowId =
    typeof metadata.founderWorkflowId === "string" && metadata.founderWorkflowId.trim() ? metadata.founderWorkflowId.trim() : task.id;
  const originalInstruction =
    typeof metadata.founderWorkflowOriginalInstruction === "string" && metadata.founderWorkflowOriginalInstruction.trim()
      ? metadata.founderWorkflowOriginalInstruction.trim()
      : task.instruction;
  const childState = mergeOrchestrationState(ensureTaskOrchestrationState(rootTask, orchestrationStage), {
    progress: {
      stage: nextOrchestrationStage,
      status: "active",
      completed: completedStages,
      inFlight: [nextOrchestrationStage],
      blocked: [],
      awaitingInput: [],
      nextActions: [`complete ${nextSpec.nextStage} stage and report back to main agent`]
    },
    branchReason: nextSpec.roleId !== rootTask.roleId ? `specialist_${nextSpec.roleId}` : undefined,
    updatedBy: task.roleId
  }) ?? ensureTaskOrchestrationState(rootTask, orchestrationStage);
  const child = store.createTask({
    sessionId: task.sessionId,
    source: task.source,
    roleId: nextSpec.roleId,
    title: nextSpec.title,
    instruction: nextSpec.instruction,
    priority: Math.max(80, task.priority - 1),
    requestedBy: task.requestedBy,
    chatId: task.chatId,
    metadata: {
      founderWorkflowKind: "founder_delivery",
      founderWorkflowId: workflowId,
      founderWorkflowRootTaskId: rootTask.id,
      founderWorkflowStage: nextSpec.nextStage,
      founderWorkflowStepIndex: nextSpec.stepIndex,
      founderWorkflowStepTotal: 4,
      founderWorkflowOriginalInstruction: originalInstruction,
      founderWorkflowPreviousTaskId: task.id,
      routeTemplateId: "tpl-founder-delivery-loop",
      routeTemplateName: "Founder Delivery Loop",
      deliverableMode: nextSpec.deliverableMode,
      deliverableSections: nextSpec.deliverableSections,
      verifierOnly: nextSpec.verifierOnly,
      originalInstruction,
      orchestrationMode: "main_agent",
      orchestrationState: childState
    }
  });
  store.createTaskRelation({
    parentTaskId: task.id,
    childTaskId: child.id,
    relationType: "split"
  });
  if (task.sessionId) {
    store.appendSessionMessage({
      sessionId: task.sessionId,
      actorType: "system",
      actorId: "task-runner",
      messageType: "event",
      content: `Founder Delivery Loop 已推进到 ${nextSpec.nextStage} 阶段：${child.title}`,
      metadata: {
        type: "founder_workflow_advanced",
        taskId: task.id,
        nextTaskId: child.id,
        currentStage: stage,
        nextStage: nextSpec.nextStage
      }
    });
  }
  updateSessionProjectMemoryFromTask(task, {
    currentStage: `founder_delivery_${nextSpec.nextStage}`,
    nextActions: [`等待 ${nextSpec.roleId} 完成 ${nextSpec.nextStage} 阶段交付`]
  });
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

function summarizeGoalRunInputs(run: GoalRunRecord): string {
  const inputMap = store.getGoalRunInputMap(run.id);
  const entries = Object.entries(inputMap)
    .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
    .slice(0, 8);
  if (entries.length === 0) {
    return run.objective.slice(0, 400);
  }
  return `${run.objective}\n${entries.join("\n")}`.slice(0, 1200);
}

export function resolveGoalRunHandoffNextActions(input: {
  task?: Pick<TaskRecord, "result"> | undefined;
  runContext: Record<string, unknown>;
  nextActions?: string[] | undefined;
}): string[] {
  if (input.nextActions !== undefined) {
    return normalizeGoalRunHandoffNextActions(input.nextActions);
  }
  const taskFollowUps = input.task?.result?.followUps;
  if (Array.isArray(taskFollowUps) && taskFollowUps.length > 0) {
    return normalizeGoalRunHandoffNextActions(taskFollowUps);
  }
  return normalizeGoalRunHandoffNextActions(contextStringArray(input.runContext, "next_actions"));
}

function buildGoalRunHandoffArtifact(input: {
  run: GoalRunRecord;
  stage: GoalRunRecord["currentStage"];
  task?: TaskRecord | undefined;
  taskTraceId?: string | undefined;
  summary: string;
  artifactFiles?: string[] | undefined;
  completedRoles?: RoleId[] | undefined;
  failedRoles?: RoleId[] | undefined;
  approvalNeeds?: string[] | undefined;
  nextActions?: string[] | undefined;
}): { id: string; artifact: import("@vinko/shared").StageHandoffArtifact } {
  const decisions = dedupeSortedStrings([
    ...(input.completedRoles ?? []).map((roleId) => `completed:${roleId}`),
    ...(input.failedRoles ?? []).map((roleId) => `failed:${roleId}`)
  ]);
  const unresolvedQuestions =
    input.run.status === "awaiting_input"
      ? input.run.awaitingInputFields.map((field) => field.trim()).filter(Boolean)
      : [];
  const nextActions = resolveGoalRunHandoffNextActions({
    task: input.task,
    runContext: input.run.context,
    nextActions: input.nextActions
  });
  return store.appendGoalRunHandoffArtifact({
    goalRunId: input.run.id,
    stage: input.stage,
    taskId: input.task?.id,
    taskTraceId: input.taskTraceId,
    summary: input.summary,
    artifacts: dedupeSortedStrings(input.artifactFiles ?? []),
    decisions,
    unresolvedQuestions,
    nextActions,
    approvalNeeds: dedupeSortedStrings(input.approvalNeeds ?? [])
  });
}

function appendGoalRunTrace(input: {
  run: GoalRunRecord;
  stage: GoalRunRecord["currentStage"];
  status: import("@vinko/shared").GoalRunTraceRecord["status"];
  task?: TaskRecord | undefined;
  outputSummary?: string | undefined;
  artifactFiles?: string[] | undefined;
  completedRoles?: RoleId[] | undefined;
  failedRoles?: RoleId[] | undefined;
  approvalGateHits?: number | undefined;
  failureCategory?: string | undefined;
  handoffArtifactId?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}): void {
  store.appendGoalRunTrace({
    goalRunId: input.run.id,
    stage: input.stage,
    status: input.status,
    taskId: input.task?.id,
    taskTraceId: input.task?.id,
    inputSummary: summarizeGoalRunInputs(input.run),
    outputSummary: input.outputSummary ?? "",
    artifactFiles: input.artifactFiles ?? [],
    completedRoles: input.completedRoles ?? [],
    failedRoles: input.failedRoles ?? [],
    approvalGateHits: input.approvalGateHits ?? 0,
    failureCategory: input.failureCategory,
    handoffArtifactId: input.handoffArtifactId,
    metadata: input.metadata
  });
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
        appendGoalRunTrace({
          run,
          stage: "discover",
          status: "awaiting_input",
          outputSummary: prompt,
          failureCategory: "input_required",
          metadata: {
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
      appendGoalRunTrace({
        run,
        stage: "discover",
        status: "completed",
        outputSummary: "Discover completed",
        metadata: {}
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
      appendGoalRunTrace({
        run: planned,
        stage: "plan",
        status: "completed",
        outputSummary: JSON.stringify(plan).slice(0, 1200),
        metadata: {
          planGenerated: true
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
          roleId: "cto",
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
        appendGoalRunTrace({
          run,
          stage: "execute",
          status: "started",
          task,
          outputSummary: "Execution task created",
          metadata: {
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
            appendGoalRunTrace({
              run: failed,
              stage: "execute",
              status: "failed",
              task,
              outputSummary: "Collaboration execution timeout",
              failureCategory: "execution_timeout",
              metadata: {
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
            appendGoalRunTrace({
              run: failed,
              stage: "execute",
              status: "failed",
              task,
              outputSummary: "Execution hard-timeout before artifact delivery",
              failureCategory: "execution_timeout",
              metadata: {
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
          appendGoalRunTrace({
            run,
            stage: "execute",
            status: "completed",
            task,
            outputSummary: fallbackSummary,
            metadata: {
              fallback: "timeout_fallback"
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
        const handoff = buildGoalRunHandoffArtifact({
          run,
          stage: "execute",
          task,
          taskTraceId: task.id,
          summary: task.result?.summary ?? "Execution task completed",
          artifactFiles,
          completedRoles: evidence.completedRoles,
          failedRoles: evidence.failedRoles
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
        appendGoalRunTrace({
          run,
          stage: "execute",
          status: "completed",
          task,
          outputSummary: task.result?.summary ?? "",
          artifactFiles,
          completedRoles: evidence.completedRoles,
          failedRoles: evidence.failedRoles,
          handoffArtifactId: handoff.id,
          metadata: {
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
          appendGoalRunTrace({
            run: failed,
            stage: "execute",
            status: "failed",
            task,
            outputSummary: task.errorText ?? "",
            completedRoles: evidence.completedRoles,
            failedRoles: evidence.failedRoles,
            failureCategory: "runtime",
            metadata: {}
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
        appendGoalRunTrace({
          run: failed,
          stage: "execute",
          status: "failed",
          task,
          outputSummary: task.errorText ?? "",
          failureCategory: "runtime",
          metadata: {}
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
          appendGoalRunTrace({
            run: failed,
            stage: "verify",
            status: "failed",
            outputSummary: "verify failed: concrete artifact task not completed",
            failureCategory: "validation",
            metadata: {
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
          appendGoalRunTrace({
            run: failed,
            stage: "verify",
            status: "failed",
            outputSummary: "verify failed: no filesystem artifacts generated",
            failureCategory: "validation",
            metadata: {}
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
            appendGoalRunTrace({
              run: failed,
              stage: "verify",
              status: "failed",
              outputSummary: "verify failed: required collaboration roles missing/failed",
              artifactFiles,
              completedRoles,
              failedRoles,
              failureCategory: "validation",
              metadata: {
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
        appendGoalRunTrace({
          run: failed,
          stage: "verify",
          status: "failed",
          outputSummary: "verify failed: last task not completed",
          failureCategory: "validation",
          metadata: {
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
      appendGoalRunTrace({
        run,
        stage: "verify",
        status: "completed",
        outputSummary: "Verify completed",
        artifactFiles: contextStringArray(run.context, "last_artifact_files"),
        completedRoles: contextStringArray(run.context, "last_completed_roles")
          .map((role) => normalizeRoleId(role))
          .filter((role): role is RoleId => role !== undefined),
        failedRoles: contextStringArray(run.context, "last_failed_roles")
          .map((role) => normalizeRoleId(role))
          .filter((role): role is RoleId => role !== undefined),
        metadata: {}
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
        appendGoalRunTrace({
          run,
          stage: "deploy",
          status: "awaiting_input",
          outputSummary: prompt,
          failureCategory: "input_required",
          metadata: {
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
          appendGoalRunTrace({
            run,
            stage: "deploy",
            status: "awaiting_input",
            outputSummary: prompt,
            failureCategory: "configuration",
            metadata: {
              fields: missingKeys,
              target
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
        appendGoalRunTrace({
          run,
          stage: "deploy",
          status: "awaiting_authorization",
          outputSummary: "Deployment authorization required",
          approvalGateHits: 1,
          failureCategory: "authorization_required",
          metadata: {
            scope,
            target
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
      const deployHandoff = buildGoalRunHandoffArtifact({
        run,
        stage: "deploy",
        summary: `Deployment preflight passed for ${target}`,
        artifactFiles: contextStringArray(run.context, "last_artifact_files")
      });
      appendGoalRunTrace({
        run,
        stage: "deploy",
        status: "completed",
        outputSummary: `Deployment preflight passed for ${target}`,
        artifactFiles: contextStringArray(run.context, "last_artifact_files"),
        approvalGateHits: contextString(run.context, "deploy_authorized_at") ? 1 : 0,
        handoffArtifactId: deployHandoff.id,
        metadata: {
          target
        }
      });
      store.queueGoalRun(run.id, "accept");
      return true;
    }

    if (run.currentStage === "accept") {
      const result = buildGoalRunResult(run);
      const completed = store.completeGoalRun(run.id, result) ?? run;
      const acceptHandoff = buildGoalRunHandoffArtifact({
        run: completed,
        stage: "accept",
        summary: result.summary,
        artifactFiles: contextStringArray(completed.context, "last_artifact_files"),
        nextActions: result.nextActions
      });
      store.appendGoalRunTimelineEvent({
        goalRunId: run.id,
        stage: "accept",
        eventType: "run_completed",
        message: "Goal run completed",
        payload: {
          summary: result.summary
        }
      });
      appendGoalRunTrace({
        run: completed,
        stage: "accept",
        status: "completed",
        outputSummary: result.summary,
        artifactFiles: contextStringArray(completed.context, "last_artifact_files"),
        handoffArtifactId: acceptHandoff.id,
        metadata: {
          nextActions: result.nextActions
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
    updateSessionProjectMemoryFromTask(completed, {
      currentStage: "direct_reply_delivered"
    });
    syncSkillIntegrationOutcome(completed);
    syncInstalledSkillVerification(completed);
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
    collaborationResumeRequested?: boolean;
  };

  await safeEmitTaskLifecycleEvent({
    phase: "before_task",
    taskId: task.id,
    roleId: task.roleId,
    source: task.source,
    status: task.status
  });

  try {
    if (metadata.collaborationId && metadata.collaborationResumeRequested) {
      const feishuClient = createFeishuClient();
      const manager = new CollaborationManager(feishuClient ? { store, feishuClient } : { store });
      const resumed = await manager.resumeAwaitingCollaboration(task);
      updateSessionProjectMemoryFromTask(store.getTask(task.id) ?? task, {
        currentStage: resumed ? "resuming_collaboration" : "awaiting_input",
        unresolvedQuestions: resumed ? [] : undefined,
        nextActions: resumed ? ["等待团队重新汇总并继续交付"] : undefined
      });
      const current = store.getTask(task.id) ?? task;
      await safeEmitTaskLifecycleEvent({
        phase: "after_task",
        taskId: task.id,
        roleId: task.roleId,
        source: task.source,
        status: current.status,
        summary: resumed ? "Collaboration resumed from user input" : "Collaboration resume skipped"
      });
      return resumed;
    }

    // 检查是否需要启动协作流程
    if (metadata.collaborationMode && !metadata.collaborationId) {
      const feishuClient = createFeishuClient();
      const manager = new CollaborationManager(feishuClient ? { store, feishuClient } : { store });
      const collaborationId = await manager.startCollaboration(task);
      const current = store.patchTaskMetadata(task.id, {
        collaborationId,
        collaborationStatus: "active"
      }) ?? task;
      updateSessionProjectMemoryFromTask(current, {
        currentStage: "collaboration_active",
        nextActions: ["等待多角色执行、收敛并交付结果"]
      });
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
      handled = await processCodeExecutionTask(task, skillIds, skills);
    } else {
      handled = await processNormalTask(task, skillIds, skills);
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
    if (failed) {
      updateSessionProjectMemoryFromTask(failed, {
        currentStage: "blocked"
      });
      syncInstalledSkillVerification(failed);
      syncFounderWorkflowFailure(failed);
    }
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
      const card = buildTaskFailedCard({
        title: failed.title,
        roleLabel: ROLE_LABELS[failed.roleId] ?? failed.roleId,
        reason: failed.errorText ?? "未知错误",
      });
      await notifyFeishuCard(failed.chatId, card);
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

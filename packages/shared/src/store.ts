import { mkdirSync } from "node:fs";
import path from "node:path";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  AgentCollaboration,
  AgentInstance,
  AgentMessage,
  CollaborationTimelineEvent,
  ApprovalDecisionInput,
  ApprovalEventRecord,
  ApprovalRecord,
  ApprovalWorkflowRecord,
  ApprovalWorkflowStepRecord,
  AuditEventRecord,
  AuthSessionRecord,
  CreateApprovalInput,
  CreateAuthSessionInput,
  CreateCrmCadenceInput,
  CreateCrmContactInput,
  CreateCrmLeadInput,
  CreateAgentInstanceInput,
  CreateCredentialInput,
  CreateGoalRunInput,
  CreateOperatorActionInput,
  CreateRoutingTemplateInput,
  CreateRunAuthTokenInput,
  CreateSessionInput,
  CreateSessionMessageInput,
  CreateTaskInput,
  CreateTaskRelationInput,
  CreateToolRunInput,
  CreateUserInput,
  DashboardSnapshot,
  GoalRunInputRecord,
  GoalRunRecord,
  GoalRunTraceRecord,
  GoalRunResult,
  GoalRunStage,
  GoalRunStatus,
  GoalRunHarnessGradeRecord,
  GoalRunTimelineEventRecord,
  OperatorActionRecord,
  QueueMetricItem,
  QueueMetrics,
  QueueSlaPolicy,
  ReflectionNote,
  RoutingTemplate,
  RoutingTaskTemplate,
  RuntimeConfig,
  RunAuthTokenRecord,
  SessionMessageRecord,
  SessionRecord,
  StageHandoffArtifact,
  SkillBindingRecord,
  TaskRelationRecord,
  TaskMetadata,
  TaskRecord,
  TaskResult,
  ToolRunRecord,
  CredentialRecord,
  CrmCadenceRecord,
  CrmCadenceStatus,
  CrmContactRecord,
  CrmLeadRecord,
  CrmLeadStage,
  CrmLeadStatus,
  UpdateRoutingTemplateInput,
  UpdateCrmLeadInput,
  UpdateCrmCadenceInput,
  UpdateAgentInstanceInput,
  UpdateUserInput,
  UserRecord,
  AuthMetrics
} from "./types.js";
import { loadEnv, resolveDataPath, type RuntimeEnv } from "./env.js";
import { getSkillDefinition, roleCanUseSkill } from "./skills.js";
import { listRoles } from "./roles.js";
import { type RoleId } from "./types.js";
import { DEFAULT_TOOL_EXEC_POLICY, normalizeToolExecPolicy } from "./tool-exec.js";
import { mergeProjectMemory, normalizeProjectMemory } from "./project-memory.js";
import { WorkspaceMemoryManager, type WorkspaceMemoryFactRecord, type WorkspaceMemoryRecord } from "./workspace-memory.js";
import type { ProjectMemoryUpdate } from "./types.js";
import { listWorkflowBlueprints, workflowBlueprintToRoutingTemplate } from "./workflow-blueprints.js";

const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {
  memory: {
    defaultBackend: "sqlite",
    roleBackends: {}
  },
  routing: {
    primaryBackend: "openai",
    fallbackBackend: "zhipu"
  },
  channels: {
    feishuEnabled: true,
    emailEnabled: false
  },
  approvals: {
    requireForConfigMutation: true,
    requireForEmailSend: true
  },
  queue: {
    sla: {
      warningWaitMs: 5 * 60 * 1000,
      criticalWaitMs: 15 * 60 * 1000
    }
  },
  tools: DEFAULT_TOOL_EXEC_POLICY,
  collaboration: {
    enabled: true,
    triggerKeywords: ["团队协作执行", "全流程交付", "协作分析"],
    defaultParticipants: ["product", "uiux", "frontend", "backend", "qa", "cto"],
    defaultConfig: {
      maxRounds: 3,
      discussionTimeoutMs: 30 * 60 * 1000,
      requireConsensus: false,
      pushIntermediateResults: true,
      autoAggregateOnComplete: true,
      aggregateTimeoutMs: 60 * 60 * 1000
    }
  },
  evolution: {
    router: {
      confidenceThreshold: 0.75,
      preferValidatedFallbacks: false,
      templateHints: []
    },
    intake: {
      preferClarificationForShortVagueRequests: false,
      shortVagueRequestMaxLength: 24,
      directConversationMaxLength: 24,
      ambiguousConversationMaxLength: 32,
      collaborationMinLength: 40,
      requireExplicitTeamSignal: true
    },
    collaboration: {
      partialDeliveryMinCompletedRoles: 1,
      timeoutNoProgressMode: "await_user",
      terminalFailureNoProgressMode: "blocked",
      manualResumeAggregationMode: "deliver"
    },
    skills: {
      recommendations: []
    }
  }
};

const ROUTING_TEMPLATES_KEY = "routing-templates";
const RUNTIME_SECRETS_KEY = "runtime-secrets";
const RUNTIME_SETTINGS_KEY = "runtime-settings";
const CREDENTIAL_MASTER_KEY = "CREDENTIAL_MASTER_KEY";
const CREDENTIAL_CRYPTO_ENV = "VINKO_CREDENTIAL_MASTER_KEY";
const CREDENTIAL_CRYPTO_ALGORITHM = "aes-256-gcm";
const CREDENTIAL_CRYPTO_VERSION = "v1";
const SQLITE_BUSY_TIMEOUT_MS = (() => {
  const raw = Number(process.env.VINKO_SQLITE_BUSY_TIMEOUT_MS ?? "10000");
  if (!Number.isFinite(raw)) {
    return 10_000;
  }
  return Math.max(1_000, Math.round(raw));
})();

type JsonRow = Record<string, unknown>;

function now(): string {
  return new Date().toISOString();
}

function jsonStringify(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function jsonParse<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || value === "") {
    return fallback;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function maybeString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function normalizeCredentialIdPart(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, "_");
}

function maskCredentialValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "****";
  }
  if (trimmed.length <= 6) {
    return `${trimmed[0] ?? "*"}***${trimmed[trimmed.length - 1] ?? "*"}`;
  }
  return `${trimmed.slice(0, 2)}***${trimmed.slice(-2)}`;
}

function normalizeGoalRunStage(value: string | undefined): GoalRunStage {
  switch (value) {
    case "discover":
    case "plan":
    case "execute":
    case "verify":
    case "deploy":
    case "accept":
      return value;
    default:
      return "discover";
  }
}

function normalizeGoalRunStatus(value: string | undefined): GoalRunStatus {
  switch (value) {
    case "queued":
    case "running":
    case "awaiting_input":
    case "awaiting_authorization":
    case "completed":
    case "failed":
    case "cancelled":
      return value;
    default:
      return "queued";
  }
}

function normalizeSlaPolicy(input: Partial<QueueSlaPolicy> | undefined): QueueSlaPolicy {
  const fallback = DEFAULT_RUNTIME_CONFIG.queue.sla;
  const warningCandidate = Number(input?.warningWaitMs ?? fallback.warningWaitMs);
  const criticalCandidate = Number(input?.criticalWaitMs ?? fallback.criticalWaitMs);
  const warningWaitMs = Number.isFinite(warningCandidate) ? Math.max(0, Math.round(warningCandidate)) : fallback.warningWaitMs;
  const minCritical = warningWaitMs + 1000;
  const criticalWaitMs = Number.isFinite(criticalCandidate)
    ? Math.max(minCritical, Math.round(criticalCandidate))
    : Math.max(minCritical, fallback.criticalWaitMs);

  return {
    warningWaitMs,
    criticalWaitMs
  };
}

function normalizeRuntimeConfig(input: Partial<RuntimeConfig> | undefined): RuntimeConfig {
  const base = DEFAULT_RUNTIME_CONFIG;
  const confidenceCandidate = Number(input?.evolution?.router?.confidenceThreshold ?? base.evolution.router.confidenceThreshold);
  const confidenceThreshold = Number.isFinite(confidenceCandidate)
    ? Math.max(0.3, Math.min(0.98, confidenceCandidate))
    : base.evolution.router.confidenceThreshold;
  const intakePolicy = normalizeEvolutionIntakePolicy(input?.evolution?.intake);
  const collaborationPolicy = normalizeEvolutionCollaborationPolicy(input?.evolution?.collaboration);
  const templateHints = Array.isArray(input?.evolution?.router?.templateHints)
    ? input!.evolution!.router!.templateHints
        .filter((entry): entry is RuntimeConfig["evolution"]["router"]["templateHints"][number] => Boolean(entry && typeof entry === "object"))
        .map((entry) => ({
          templateId: String(entry.templateId ?? "").trim(),
          phrases: Array.isArray(entry.phrases)
            ? Array.from(
                new Set(
                  entry.phrases
                    .filter((item): item is string => typeof item === "string")
                    .map((item) => item.trim().toLowerCase())
                    .filter(Boolean)
                )
              ).slice(0, 12)
            : [],
          source: typeof entry.source === "string" ? entry.source.trim() : "evolution",
          updatedAt: typeof entry.updatedAt === "string" && entry.updatedAt.trim() ? entry.updatedAt : now()
        }))
        .filter((entry) => entry.templateId && entry.phrases.length > 0)
    : base.evolution.router.templateHints;
  const skillRecommendations = Array.isArray(input?.evolution?.skills?.recommendations)
    ? input!.evolution!.skills!.recommendations
        .filter((entry): entry is RuntimeConfig["evolution"]["skills"]["recommendations"][number] => Boolean(entry && typeof entry === "object"))
        .map((entry) => ({
          roleId: entry.roleId,
          skillId: String(entry.skillId ?? "").trim(),
          reason: typeof entry.reason === "string" ? entry.reason.trim() : "",
          scoreBoost: Number.isFinite(Number(entry.scoreBoost)) ? Math.max(1, Math.min(200, Math.round(Number(entry.scoreBoost)))) : 30,
          updatedAt: typeof entry.updatedAt === "string" && entry.updatedAt.trim() ? entry.updatedAt : now()
        }))
        .filter((entry) => typeof entry.roleId === "string" && entry.skillId)
    : base.evolution.skills.recommendations;
  return {
    memory: {
      defaultBackend: input?.memory?.defaultBackend ?? base.memory.defaultBackend,
      roleBackends: input?.memory?.roleBackends ?? {}
    },
    routing: {
      primaryBackend: input?.routing?.primaryBackend ?? base.routing.primaryBackend,
      fallbackBackend: input?.routing?.fallbackBackend ?? base.routing.fallbackBackend
    },
    channels: {
      feishuEnabled: input?.channels?.feishuEnabled ?? base.channels.feishuEnabled,
      emailEnabled: input?.channels?.emailEnabled ?? base.channels.emailEnabled
    },
    approvals: {
      requireForConfigMutation:
        input?.approvals?.requireForConfigMutation ?? base.approvals.requireForConfigMutation,
      requireForEmailSend: input?.approvals?.requireForEmailSend ?? base.approvals.requireForEmailSend
    },
    queue: {
      sla: normalizeSlaPolicy(input?.queue?.sla)
    },
    tools: normalizeToolExecPolicy(input?.tools),
    collaboration: {
      enabled: input?.collaboration?.enabled ?? base.collaboration.enabled,
      triggerKeywords: input?.collaboration?.triggerKeywords ?? base.collaboration.triggerKeywords,
      defaultParticipants: input?.collaboration?.defaultParticipants ?? base.collaboration.defaultParticipants,
      defaultConfig: {
        maxRounds: input?.collaboration?.defaultConfig?.maxRounds ?? base.collaboration.defaultConfig.maxRounds,
        discussionTimeoutMs:
          input?.collaboration?.defaultConfig?.discussionTimeoutMs ?? base.collaboration.defaultConfig.discussionTimeoutMs,
        requireConsensus:
          input?.collaboration?.defaultConfig?.requireConsensus ?? base.collaboration.defaultConfig.requireConsensus,
        pushIntermediateResults:
          input?.collaboration?.defaultConfig?.pushIntermediateResults ?? base.collaboration.defaultConfig.pushIntermediateResults,
        autoAggregateOnComplete:
          input?.collaboration?.defaultConfig?.autoAggregateOnComplete ?? base.collaboration.defaultConfig.autoAggregateOnComplete,
        aggregateTimeoutMs:
          input?.collaboration?.defaultConfig?.aggregateTimeoutMs ?? base.collaboration.defaultConfig.aggregateTimeoutMs
      }
    },
    evolution: {
      router: {
        confidenceThreshold,
        preferValidatedFallbacks:
          input?.evolution?.router?.preferValidatedFallbacks ?? base.evolution.router.preferValidatedFallbacks,
        templateHints
      },
      intake: intakePolicy,
      collaboration: collaborationPolicy,
      skills: {
        recommendations: skillRecommendations
      }
    }
  };
}

function normalizeEvolutionIntakePolicy(input: Partial<RuntimeConfig["evolution"]["intake"]> | undefined): RuntimeConfig["evolution"]["intake"] {
  const fallback = DEFAULT_RUNTIME_CONFIG.evolution.intake;
  const shortVagueCandidate = Number(input?.shortVagueRequestMaxLength ?? fallback.shortVagueRequestMaxLength);
  const directCandidate = Number(input?.directConversationMaxLength ?? fallback.directConversationMaxLength);
  const ambiguousCandidate = Number(input?.ambiguousConversationMaxLength ?? fallback.ambiguousConversationMaxLength);
  const collaborationCandidate = Number(input?.collaborationMinLength ?? fallback.collaborationMinLength);
  const shortVagueRequestMaxLength = Number.isFinite(shortVagueCandidate)
    ? Math.max(4, Math.min(120, Math.round(shortVagueCandidate)))
    : fallback.shortVagueRequestMaxLength;
  const directConversationMaxLength = Number.isFinite(directCandidate)
    ? Math.max(8, Math.min(120, Math.round(directCandidate)))
    : fallback.directConversationMaxLength;
  const ambiguousConversationMaxLength = Number.isFinite(ambiguousCandidate)
    ? Math.max(directConversationMaxLength, Math.min(160, Math.round(ambiguousCandidate)))
    : Math.max(directConversationMaxLength, fallback.ambiguousConversationMaxLength);
  const collaborationMinLength = Number.isFinite(collaborationCandidate)
    ? Math.max(12, Math.min(240, Math.round(collaborationCandidate)))
    : fallback.collaborationMinLength;

  return {
    preferClarificationForShortVagueRequests:
      input?.preferClarificationForShortVagueRequests ?? fallback.preferClarificationForShortVagueRequests,
    shortVagueRequestMaxLength,
    directConversationMaxLength,
    ambiguousConversationMaxLength,
    collaborationMinLength,
    requireExplicitTeamSignal: input?.requireExplicitTeamSignal ?? fallback.requireExplicitTeamSignal
  };
}

function normalizeEvolutionCollaborationPolicy(
  input: Partial<RuntimeConfig["evolution"]["collaboration"]> | undefined
): RuntimeConfig["evolution"]["collaboration"] {
  const fallback = DEFAULT_RUNTIME_CONFIG.evolution.collaboration;
  const partialCandidate = Number(input?.partialDeliveryMinCompletedRoles ?? fallback.partialDeliveryMinCompletedRoles);
  return {
    partialDeliveryMinCompletedRoles: Number.isFinite(partialCandidate)
      ? Math.max(1, Math.min(8, Math.round(partialCandidate)))
      : fallback.partialDeliveryMinCompletedRoles,
    timeoutNoProgressMode:
      input?.timeoutNoProgressMode === "blocked" || input?.timeoutNoProgressMode === "await_user"
        ? input.timeoutNoProgressMode
        : fallback.timeoutNoProgressMode,
    terminalFailureNoProgressMode:
      input?.terminalFailureNoProgressMode === "blocked" || input?.terminalFailureNoProgressMode === "await_user"
        ? input.terminalFailureNoProgressMode
        : fallback.terminalFailureNoProgressMode,
    manualResumeAggregationMode:
      input?.manualResumeAggregationMode === "partial" || input?.manualResumeAggregationMode === "deliver"
        ? input.manualResumeAggregationMode
        : fallback.manualResumeAggregationMode
  };
}

function createDbFile(env: RuntimeEnv): string {
  mkdirSync(env.dataDir, { recursive: true });
  return resolveDataPath(env, "vinkoclaw.sqlite");
}

function ensureDefaultConfig(store: VinkoStore): void {
  if (!store.getConfigEntry("runtime-config")) {
    store.setConfigEntry("runtime-config", DEFAULT_RUNTIME_CONFIG);
  }
}

function normalizeKeywords(values: string[]): string[] {
  return values
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

function normalizeRoutingTasks(tasks: RoutingTaskTemplate[]): RoutingTaskTemplate[] {
  return tasks
    .filter((task) => task && typeof task.roleId === "string")
    .map((task) => ({
      roleId: task.roleId,
      titleTemplate: String(task.titleTemplate ?? "").trim(),
      instructionTemplate: String(task.instructionTemplate ?? "").trim(),
      ...(typeof task.deliverableMode === "string" ? { deliverableMode: task.deliverableMode } : {}),
      ...(Array.isArray(task.deliverableSections)
        ? {
            deliverableSections: task.deliverableSections
              .filter((entry): entry is string => typeof entry === "string")
              .map((entry) => entry.trim())
              .filter(Boolean)
          }
        : {}),
      ...(Array.isArray(task.successCriteria)
        ? {
            successCriteria: task.successCriteria
              .filter((entry): entry is string => typeof entry === "string")
              .map((entry) => entry.trim())
              .filter(Boolean)
          }
        : {}),
      ...(typeof task.completionSignal === "string" && task.completionSignal.trim()
        ? { completionSignal: task.completionSignal.trim() }
        : {}),
      ...(typeof task.workflowLabel === "string" && task.workflowLabel.trim()
        ? { workflowLabel: task.workflowLabel.trim() }
        : {}),
      ...(typeof task.priority === "number" ? { priority: task.priority } : {})
    }))
    .filter((task) => task.titleTemplate && task.instructionTemplate);
}

function defaultRoutingTemplates(): RoutingTemplate[] {
  const timestamp = now();
  return listWorkflowBlueprints().map((blueprint) => workflowBlueprintToRoutingTemplate(blueprint, timestamp));
}

function toRoutingTemplate(raw: Partial<RoutingTemplate>, fallbackId?: string): RoutingTemplate {
  const timestamp = now();
  const tasks = normalizeRoutingTasks(raw.tasks ?? []);

  return {
    id: String(raw.id ?? fallbackId ?? randomUUID()),
    name: String(raw.name ?? "Untitled template").trim() || "Untitled template",
    description: String(raw.description ?? "").trim(),
    triggerKeywords: normalizeKeywords(raw.triggerKeywords ?? []),
    matchMode: raw.matchMode === "all" ? "all" : "any",
    enabled: raw.enabled ?? true,
    tasks,
    createdAt: raw.createdAt ?? timestamp,
    updatedAt: raw.updatedAt ?? timestamp
  };
}

function ensureDefaultRoutingTemplates(store: VinkoStore): void {
  const existing = store.getConfigEntry<RoutingTemplate[]>(ROUTING_TEMPLATES_KEY) ?? [];
  const defaults = defaultRoutingTemplates();
  const mergedById = new Map<string, RoutingTemplate>();

  for (const template of defaults) {
    mergedById.set(template.id, toRoutingTemplate(template, template.id));
  }

  for (const template of existing) {
    const normalized = toRoutingTemplate(template, template.id);
    mergedById.set(normalized.id, normalized);
  }

  store.setConfigEntry(ROUTING_TEMPLATES_KEY, Array.from(mergedById.values()));
}

function parseTimestampMs(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function createEmptyMetricItem(id: string, label: string): QueueMetricItem {
  return {
    id,
    label,
    queued: 0,
    running: 0,
    avgWaitMs: 0,
    avgRunMs: 0
  };
}

function finalizeMetricItems(
  byId: Map<string, QueueMetricItem & { waitSamples: number[]; runSamples: number[] }>
): QueueMetricItem[] {
  return Array.from(byId.values())
    .map((entry) => ({
      id: entry.id,
      label: entry.label,
      queued: entry.queued,
      running: entry.running,
      avgWaitMs:
        entry.waitSamples.length === 0
          ? 0
          : Math.round(entry.waitSamples.reduce((total, value) => total + value, 0) / entry.waitSamples.length),
      avgRunMs:
        entry.runSamples.length === 0
          ? 0
          : Math.round(entry.runSamples.reduce((total, value) => total + value, 0) / entry.runSamples.length)
    }))
    .sort((left, right) => {
      if (right.queued !== left.queued) {
        return right.queued - left.queued;
      }
      if (right.running !== left.running) {
        return right.running - left.running;
      }
      return left.label.localeCompare(right.label);
    });
}

function toTaskRecord(row: JsonRow): TaskRecord {
  return {
    id: String(row.id),
    sessionId: maybeString(row.session_id),
    source: row.source as TaskRecord["source"],
    roleId: row.role_id as RoleId,
    title: String(row.title),
    instruction: String(row.instruction),
    status: row.status as TaskRecord["status"],
    priority: Number(row.priority),
    chatId: maybeString(row.chat_id),
    requestedBy: maybeString(row.requested_by),
    metadata: jsonParse<TaskMetadata>(row.metadata_json, {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    startedAt: maybeString(row.started_at),
    completedAt: maybeString(row.completed_at),
    result: jsonParse<TaskResult | undefined>(row.result_json, undefined),
    reflection: jsonParse<ReflectionNote | undefined>(row.reflection_json, undefined),
    errorText: maybeString(row.error_text),
    pendingInput: jsonParse<TaskRecord["pendingInput"]>(row.pending_input_json, undefined)
  };
}

function toSessionRecord(row: JsonRow): SessionRecord {
  return {
    id: String(row.id),
    source: row.source as SessionRecord["source"],
    sourceKey: String(row.source_key),
    title: String(row.title),
    status: row.status as SessionRecord["status"],
    metadata: jsonParse<Record<string, unknown>>(row.metadata_json, {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    lastMessageAt: String(row.last_message_at)
  };
}

function toSessionMessageRecord(row: JsonRow): SessionMessageRecord {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    actorType: row.actor_type as SessionMessageRecord["actorType"],
    actorId: String(row.actor_id),
    roleId: maybeString(row.role_id) as RoleId | undefined,
    messageType: row.message_type as SessionMessageRecord["messageType"],
    content: String(row.content),
    metadata: jsonParse<Record<string, unknown>>(row.metadata_json, {}),
    createdAt: String(row.created_at)
  };
}

function toTaskRelationRecord(row: JsonRow): TaskRelationRecord {
  return {
    id: String(row.id),
    parentTaskId: String(row.parent_task_id),
    childTaskId: String(row.child_task_id),
    relationType: row.relation_type as TaskRelationRecord["relationType"],
    createdAt: String(row.created_at)
  };
}

function toApprovalRecord(row: JsonRow): ApprovalRecord {
  return {
    id: String(row.id),
    kind: row.kind as ApprovalRecord["kind"],
    taskId: maybeString(row.task_id),
    operatorActionId: maybeString(row.operator_action_id),
    summary: String(row.summary),
    payload: jsonParse<Record<string, unknown>>(row.payload_json, {}),
    status: row.status as ApprovalRecord["status"],
    requestedBy: maybeString(row.requested_by),
    decidedBy: maybeString(row.decided_by),
    decisionNote: maybeString(row.decision_note),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    decidedAt: maybeString(row.decided_at)
  };
}

function toApprovalEventRecord(row: JsonRow): ApprovalEventRecord {
  return {
    id: String(row.id),
    approvalId: String(row.approval_id),
    eventType: row.event_type as ApprovalEventRecord["eventType"],
    actor: maybeString(row.actor),
    note: maybeString(row.note),
    payload: jsonParse<Record<string, unknown>>(row.payload_json, {}),
    createdAt: String(row.created_at)
  };
}

function toApprovalWorkflowRecord(row: JsonRow): ApprovalWorkflowRecord {
  return {
    id: String(row.id),
    approvalId: String(row.approval_id),
    status: row.status as ApprovalWorkflowRecord["status"],
    currentStepIndex: Number(row.current_step_index),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function toApprovalWorkflowStepRecord(row: JsonRow): ApprovalWorkflowStepRecord {
  return {
    id: String(row.id),
    workflowId: String(row.workflow_id),
    stepIndex: Number(row.step_index),
    roleId: row.role_id as RoleId,
    status: row.status as ApprovalWorkflowStepRecord["status"],
    decidedBy: maybeString(row.decided_by),
    decisionNote: maybeString(row.decision_note),
    decidedAt: maybeString(row.decided_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function toOperatorActionRecord(row: JsonRow): OperatorActionRecord {
  return {
    id: String(row.id),
    kind: row.kind as OperatorActionRecord["kind"],
    status: row.status as OperatorActionRecord["status"],
    summary: String(row.summary),
    payload: jsonParse<Record<string, unknown>>(row.payload_json, {}),
    targetRoleId: maybeString(row.target_role_id) as RoleId | undefined,
    skillId: maybeString(row.skill_id),
    approvalId: maybeString(row.approval_id),
    createdBy: maybeString(row.created_by),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    executedAt: maybeString(row.executed_at)
  };
}

function toSkillBindingRecord(row: JsonRow): SkillBindingRecord {
  return {
    id: String(row.id),
    scope: row.scope as SkillBindingRecord["scope"],
    scopeId: String(row.scope_id),
    skillId: String(row.skill_id),
    status: row.status as SkillBindingRecord["status"],
    verificationStatus:
      typeof row.verification_status === "string" ? (row.verification_status as SkillBindingRecord["verificationStatus"]) : undefined,
    config: jsonParse<Record<string, unknown>>(row.config_json, {}),
    installedBy: maybeString(row.installed_by),
    installedAt: maybeString(row.installed_at),
    verifiedAt: maybeString(row.verified_at),
    lastVerifiedTaskId: maybeString(row.last_verified_task_id),
    source: maybeString(row.source),
    sourceLabel: maybeString(row.source_label),
    sourceUrl: maybeString(row.source_url),
    version: maybeString(row.version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function toAuditEventRecord(row: JsonRow): AuditEventRecord {
  return {
    id: String(row.id),
    category: String(row.category),
    entityType: String(row.entity_type),
    entityId: String(row.entity_id),
    message: String(row.message),
    payload: jsonParse<Record<string, unknown>>(row.payload_json, {}),
    createdAt: String(row.created_at)
  };
}

function toUserRecord(row: JsonRow): UserRecord {
  return {
    id: String(row.id),
    username: String(row.username),
    email: maybeString(row.email),
    passwordHash: String(row.password_hash),
    role: row.role as UserRecord["role"],
    displayName: String(row.display_name),
    isActive: Boolean(row.is_active),
    lastLoginAt: maybeString(row.last_login_at),
    loginCount: Number(row.login_count),
    metadata: jsonParse<Record<string, unknown>>(row.metadata_json, {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function toAuthSessionRecord(row: JsonRow): AuthSessionRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    token: String(row.token),
    userAgent: maybeString(row.user_agent),
    ipAddress: maybeString(row.ip_address),
    expiresAt: String(row.expires_at),
    createdAt: String(row.created_at),
    lastAccessedAt: String(row.last_accessed_at)
  };
}

function normalizeCrmLeadStage(value: unknown): CrmLeadStage {
  switch (value) {
    case "new":
    case "contacted":
    case "qualified":
    case "proposal":
    case "won":
    case "lost":
      return value;
    default:
      return "new";
  }
}

function normalizeCrmLeadStatus(value: unknown): CrmLeadStatus {
  switch (value) {
    case "active":
    case "archived":
      return value;
    default:
      return "active";
  }
}

function toCrmLeadRecord(row: JsonRow): CrmLeadRecord {
  return {
    id: String(row.id),
    name: String(row.name ?? ""),
    company: maybeString(row.company),
    title: maybeString(row.title),
    email: maybeString(row.email),
    source: String(row.source ?? "manual"),
    stage: normalizeCrmLeadStage(row.stage),
    status: normalizeCrmLeadStatus(row.status),
    tags: jsonParse<string[]>(row.tags_json, []),
    latestSummary: String(row.latest_summary ?? ""),
    nextAction: maybeString(row.next_action),
    ownerRoleId: maybeString(row.owner_role_id) as RoleId | undefined,
    linkedProjectId: maybeString(row.linked_project_id),
    lastContactAt: maybeString(row.last_contact_at),
    archivedAt: maybeString(row.archived_at),
    metadata: jsonParse<Record<string, unknown>>(row.metadata_json, {}),
    createdAt: String(row.created_at ?? now()),
    updatedAt: String(row.updated_at ?? now())
  };
}

function normalizeCrmCadenceStatus(value: unknown): CrmCadenceStatus {
  switch (value) {
    case "active":
    case "paused":
    case "completed":
    case "archived":
      return value;
    default:
      return "active";
  }
}

function toCrmCadenceRecord(row: JsonRow): CrmCadenceRecord {
  return {
    id: String(row.id),
    leadId: String(row.lead_id ?? ""),
    label: String(row.label ?? ""),
    channel: (maybeString(row.channel) as CrmCadenceRecord["channel"] | undefined) ?? "manual",
    intervalDays: Number(row.interval_days ?? 0),
    status: normalizeCrmCadenceStatus(row.status),
    objective: String(row.objective ?? ""),
    nextRunAt: String(row.next_run_at ?? now()),
    lastRunAt: maybeString(row.last_run_at),
    ownerRoleId: maybeString(row.owner_role_id) as RoleId | undefined,
    metadata: jsonParse<Record<string, unknown>>(row.metadata_json, {}),
    createdAt: String(row.created_at ?? now()),
    updatedAt: String(row.updated_at ?? now())
  };
}

function toCrmContactRecord(row: JsonRow): CrmContactRecord {
  return {
    id: String(row.id),
    leadId: String(row.lead_id ?? ""),
    cadenceId: maybeString(row.cadence_id),
    channel: (maybeString(row.channel) as CrmContactRecord["channel"] | undefined) ?? "manual",
    outcome: (maybeString(row.outcome) as CrmContactRecord["outcome"] | undefined) ?? "note",
    summary: String(row.summary ?? ""),
    nextAction: maybeString(row.next_action),
    happenedAt: String(row.happened_at ?? row.created_at ?? now()),
    createdAt: String(row.created_at ?? now())
  };
}

const CRM_LEAD_STAGE_ORDER = ["new", "contacted", "qualified", "proposal", "won", "lost"] as const;

function resolveLeadStageFromContactOutcome(
  currentStage: CrmLeadStage,
  outcome: CrmContactRecord["outcome"] | undefined
): CrmLeadStage {
  if (outcome === "won") {
    return "won";
  }
  if (outcome === "lost") {
    return "lost";
  }
  const desiredStage: CrmLeadStage | undefined =
    outcome === "meeting_booked" ? "proposal" : outcome === "replied" ? "qualified" : outcome === "sent" ? "contacted" : undefined;
  if (!desiredStage) {
    return currentStage;
  }
  const currentIndex = CRM_LEAD_STAGE_ORDER.indexOf(currentStage);
  const desiredIndex = CRM_LEAD_STAGE_ORDER.indexOf(desiredStage);
  if (currentIndex === -1 || desiredIndex === -1) {
    return currentStage;
  }
  return desiredIndex > currentIndex ? desiredStage : currentStage;
}

function toAgentCollaboration(row: JsonRow): AgentCollaboration {
  const result: AgentCollaboration = {
    id: String(row.id),
    parentTaskId: String(row.parent_task_id),
    status: row.status as AgentCollaboration["status"],
    participants: jsonParse<RoleId[]>(row.participants_json, []),
    facilitator: String(row.facilitator) as RoleId,
    currentPhase: row.current_phase as AgentCollaboration["currentPhase"],
    phaseResults: jsonParse<AgentCollaboration["phaseResults"]>(row.phase_results_json, []),
    config: jsonParse<AgentCollaboration["config"]>(row.config_json, {
      maxRounds: 3,
      discussionTimeoutMs: 30 * 60 * 1000,
      requireConsensus: false,
      pushIntermediateResults: true,
      autoAggregateOnComplete: true,
      aggregateTimeoutMs: 60 * 60 * 1000
    }),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };

  const sessionId = maybeString(row.session_id);
  if (sessionId !== undefined) {
    result.sessionId = sessionId;
  }

  const chatId = maybeString(row.chat_id);
  if (chatId !== undefined) {
    result.chatId = chatId;
  }

  const completedAt = maybeString(row.completed_at);
  if (completedAt !== undefined) {
    result.completedAt = completedAt;
  }

  return result;
}

function toAgentMessage(row: JsonRow): AgentMessage {
  return {
    id: String(row.id),
    collaborationId: String(row.collaboration_id),
    taskId: String(row.task_id),
    fromRoleId: String(row.from_role_id) as RoleId,
    toRoleIds: jsonParse<RoleId[]>(row.to_role_ids_json, []),
    messageType: row.message_type as AgentMessage["messageType"],
    content: String(row.content),
    metadata: jsonParse<AgentMessage["metadata"]>(row.metadata_json, {}),
    createdAt: String(row.created_at)
  };
}

function toAgentInstance(row: JsonRow): AgentInstance {
  const record: AgentInstance = {
    id: String(row.id),
    roleId: String(row.role_id) as RoleId,
    name: String(row.name),
    tonePolicy: String(row.tone_policy ?? ""),
    status: String(row.status) as AgentInstance["status"],
    metadata: jsonParse<Record<string, unknown>>(row.metadata_json, {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };

  const createdBy = maybeString(row.created_by);
  if (createdBy !== undefined) {
    record.createdBy = createdBy;
  }
  const deactivatedAt = maybeString(row.deactivated_at);
  if (deactivatedAt !== undefined) {
    record.deactivatedAt = deactivatedAt;
  }
  return record;
}

function toCollaborationTimelineEvent(row: JsonRow): CollaborationTimelineEvent {
  const record: CollaborationTimelineEvent = {
    id: String(row.id),
    collaborationId: String(row.collaboration_id),
    eventType: String(row.event_type) as CollaborationTimelineEvent["eventType"],
    message: String(row.message),
    metadata: jsonParse<Record<string, unknown>>(row.metadata_json, {}),
    createdAt: String(row.created_at)
  };

  const roleId = maybeString(row.role_id);
  if (roleId !== undefined) {
    record.roleId = roleId as RoleId;
  }
  const taskId = maybeString(row.task_id);
  if (taskId !== undefined) {
    record.taskId = taskId;
  }
  const agentInstanceId = maybeString(row.agent_instance_id);
  if (agentInstanceId !== undefined) {
    record.agentInstanceId = agentInstanceId;
  }

  return record;
}

function toToolRunRecord(row: JsonRow): ToolRunRecord {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    roleId: row.role_id as RoleId,
    providerId: row.provider_id as ToolRunRecord["providerId"],
    title: String(row.title),
    instruction: String(row.instruction),
    command: String(row.command),
    args: jsonParse<string[]>(row.args_json, []),
    riskLevel: row.risk_level as ToolRunRecord["riskLevel"],
    status: row.status as ToolRunRecord["status"],
    approvalStatus: row.approval_status as ToolRunRecord["approvalStatus"],
    requestedBy: maybeString(row.requested_by),
    approvedBy: maybeString(row.approved_by),
    approvalId: maybeString(row.approval_id),
    outputText: maybeString(row.output_text),
    errorText: maybeString(row.error_text),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    startedAt: maybeString(row.started_at),
    completedAt: maybeString(row.completed_at)
  };
}

function toGoalRunRecord(row: JsonRow): GoalRunRecord {
  return {
    id: String(row.id),
    source: String(row.source) as GoalRunRecord["source"],
    objective: String(row.objective),
    status: String(row.status) as GoalRunStatus,
    currentStage: String(row.current_stage) as GoalRunStage,
    requestedBy: maybeString(row.requested_by),
    chatId: maybeString(row.chat_id),
    sessionId: maybeString(row.session_id),
    language: String(row.language ?? "zh-CN"),
    metadata: jsonParse<Record<string, unknown>>(row.metadata_json, {}),
    context: jsonParse<Record<string, unknown>>(row.context_json, {}),
    plan: jsonParse<Record<string, unknown> | undefined>(row.plan_json, undefined),
    result: jsonParse<GoalRunResult | undefined>(row.result_json, undefined),
    currentTaskId: maybeString(row.current_task_id),
    retryCount: Number(row.retry_count ?? 0),
    maxRetries: Number(row.max_retries ?? 2),
    awaitingInputFields: jsonParse<string[]>(row.awaiting_input_fields_json, []),
    awaitingInputPrompt: maybeString(row.awaiting_input_prompt),
    errorText: maybeString(row.error_text),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    startedAt: maybeString(row.started_at),
    completedAt: maybeString(row.completed_at)
  };
}

function toGoalRunTimelineEventRecord(row: JsonRow): GoalRunTimelineEventRecord {
  return {
    id: String(row.id),
    goalRunId: String(row.goal_run_id),
    stage: String(row.stage) as GoalRunStage,
    eventType: String(row.event_type) as GoalRunTimelineEventRecord["eventType"],
    message: String(row.message),
    payload: jsonParse<Record<string, unknown>>(row.payload_json, {}),
    createdAt: String(row.created_at)
  };
}

function toStageHandoffArtifact(row: JsonRow): StageHandoffArtifact {
  return {
    stage: String(row.stage) as GoalRunStage,
    taskId: maybeString(row.task_id),
    taskTraceId: maybeString(row.task_trace_id),
    summary: String(row.summary ?? ""),
    artifacts: jsonParse<string[]>(row.artifacts_json, []),
    decisions: jsonParse<string[]>(row.decisions_json, []),
    unresolvedQuestions: jsonParse<string[]>(row.unresolved_questions_json, []),
    nextActions: jsonParse<string[]>(row.next_actions_json, []),
    approvalNeeds: jsonParse<string[]>(row.approval_needs_json, []),
    createdAt: String(row.created_at)
  };
}

function toGoalRunTraceRecord(row: JsonRow): GoalRunTraceRecord {
  return {
    id: String(row.id),
    goalRunId: String(row.goal_run_id),
    stage: String(row.stage) as GoalRunStage,
    status: String(row.status) as GoalRunTraceRecord["status"],
    taskId: maybeString(row.task_id),
    taskTraceId: maybeString(row.task_trace_id),
    inputSummary: String(row.input_summary ?? ""),
    outputSummary: String(row.output_summary ?? ""),
    artifactFiles: jsonParse<string[]>(row.artifact_files_json, []),
    completedRoles: jsonParse<RoleId[]>(row.completed_roles_json, []),
    failedRoles: jsonParse<RoleId[]>(row.failed_roles_json, []),
    approvalGateHits: Number(row.approval_gate_hits ?? 0),
    failureCategory: maybeString(row.failure_category),
    handoffArtifactId: maybeString(row.handoff_artifact_id),
    metadata: jsonParse<Record<string, unknown>>(row.metadata_json, {}),
    createdAt: String(row.created_at)
  };
}

function toGoalRunInputRecord(row: JsonRow): GoalRunInputRecord {
  return {
    id: String(row.id),
    goalRunId: String(row.goal_run_id),
    inputKey: String(row.input_key),
    value: jsonParse<unknown>(row.value_json, null),
    createdBy: maybeString(row.created_by),
    createdAt: String(row.created_at)
  };
}

function toRunAuthTokenRecord(row: JsonRow): RunAuthTokenRecord {
  return {
    id: String(row.id),
    goalRunId: String(row.goal_run_id),
    token: String(row.token),
    scope: String(row.scope),
    status: String(row.status) as RunAuthTokenRecord["status"],
    reason: maybeString(row.reason),
    expiresAt: String(row.expires_at),
    usedBy: maybeString(row.used_by),
    usedAt: maybeString(row.used_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

type CredentialSecretRecord = CredentialRecord & {
  encryptedValue: string;
  encryptionVersion: string;
};

function toCredentialSecretRecord(row: JsonRow): CredentialSecretRecord {
  const record: CredentialSecretRecord = {
    id: String(row.id),
    providerId: String(row.provider_id),
    credentialKey: String(row.credential_key),
    valueMasked: String(row.value_masked ?? "****"),
    metadata: jsonParse<Record<string, unknown>>(row.metadata_json, {}),
    createdBy: maybeString(row.created_by),
    lastUsedAt: maybeString(row.last_used_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    encryptedValue: String(row.encrypted_value),
    encryptionVersion: String(row.encryption_version ?? CREDENTIAL_CRYPTO_VERSION)
  };
  const displayName = maybeString(row.display_name);
  if (displayName !== undefined) {
    record.displayName = displayName;
  }
  return record;
}

function stripCredentialSecret(record: CredentialSecretRecord): CredentialRecord {
  const result: CredentialRecord = {
    id: record.id,
    providerId: record.providerId,
    credentialKey: record.credentialKey,
    valueMasked: record.valueMasked,
    metadata: record.metadata,
    createdBy: record.createdBy,
    lastUsedAt: record.lastUsedAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
  if (record.displayName !== undefined) {
    result.displayName = record.displayName;
  }
  return result;
}

export class VinkoStore {
  readonly db: DatabaseSync;
  private readonly workspaceMemoryManager: WorkspaceMemoryManager;

  constructor(dbFile: string) {
    mkdirSync(path.dirname(dbFile), { recursive: true });
    this.db = new DatabaseSync(dbFile, {
      timeout: SQLITE_BUSY_TIMEOUT_MS
    });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};`);
    this.initialize();
    this.workspaceMemoryManager = new WorkspaceMemoryManager(this.db);
    ensureDefaultConfig(this);
    ensureDefaultRoutingTemplates(this);
    this.seedDefaultSkills();
    this.seedDefaultAgentInstances();
  }

  static fromEnv(env: RuntimeEnv = loadEnv()): VinkoStore {
    return new VinkoStore(createDbFile(env));
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        source TEXT NOT NULL,
        role_id TEXT NOT NULL,
        title TEXT NOT NULL,
        instruction TEXT NOT NULL,
        status TEXT NOT NULL,
        priority INTEGER NOT NULL,
        chat_id TEXT,
        requested_by TEXT,
        metadata_json TEXT NOT NULL,
        result_json TEXT,
        reflection_json TEXT,
        error_text TEXT,
        pending_input_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        source_key TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_message_at TEXT NOT NULL,
        UNIQUE(source, source_key)
      );

      CREATE TABLE IF NOT EXISTS session_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        actor_type TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        role_id TEXT,
        message_type TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS task_relations (
        id TEXT PRIMARY KEY,
        parent_task_id TEXT NOT NULL,
        child_task_id TEXT NOT NULL,
        relation_type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(parent_task_id, child_task_id, relation_type)
      );

      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        task_id TEXT,
        operator_action_id TEXT,
        summary TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        requested_by TEXT,
        decided_by TEXT,
        decision_note TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        decided_at TEXT
      );

      CREATE TABLE IF NOT EXISTS approval_events (
        id TEXT PRIMARY KEY,
        approval_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        actor TEXT,
        note TEXT,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS approval_workflows (
        id TEXT PRIMARY KEY,
        approval_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        current_step_index INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS approval_workflow_steps (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        step_index INTEGER NOT NULL,
        role_id TEXT NOT NULL,
        status TEXT NOT NULL,
        decided_by TEXT,
        decision_note TEXT,
        decided_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(workflow_id, step_index)
      );

      CREATE TABLE IF NOT EXISTS operator_actions (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        target_role_id TEXT,
        skill_id TEXT,
        summary TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        approval_id TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        executed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS skill_bindings (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        skill_id TEXT NOT NULL,
        status TEXT NOT NULL,
        verification_status TEXT,
        config_json TEXT NOT NULL,
        installed_by TEXT,
        installed_at TEXT,
        verified_at TEXT,
        last_verified_task_id TEXT,
        source TEXT,
        source_label TEXT,
        source_url TEXT,
        version TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(scope, scope_id, skill_id)
      );

      CREATE TABLE IF NOT EXISTS config_entries (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        message TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tool_runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        role_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        title TEXT NOT NULL,
        instruction TEXT NOT NULL,
        command TEXT NOT NULL,
        args_json TEXT NOT NULL,
        risk_level TEXT NOT NULL,
        status TEXT NOT NULL,
        approval_status TEXT NOT NULL,
        requested_by TEXT,
        approved_by TEXT,
        approval_id TEXT,
        output_text TEXT,
        error_text TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_tool_runs_task_id ON tool_runs(task_id);
      CREATE INDEX IF NOT EXISTS idx_tool_runs_status ON tool_runs(status);
      CREATE INDEX IF NOT EXISTS idx_tool_runs_approval_id ON tool_runs(approval_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_source_source_key ON sessions(source, source_key);
      CREATE INDEX IF NOT EXISTS idx_session_messages_session_id ON session_messages(session_id);
      CREATE INDEX IF NOT EXISTS idx_session_messages_created_at ON session_messages(created_at);
      CREATE INDEX IF NOT EXISTS idx_task_relations_parent ON task_relations(parent_task_id);
      CREATE INDEX IF NOT EXISTS idx_task_relations_child ON task_relations(child_task_id);
      CREATE INDEX IF NOT EXISTS idx_approval_events_approval_id ON approval_events(approval_id);
      CREATE INDEX IF NOT EXISTS idx_approval_workflows_approval_id ON approval_workflows(approval_id);
      CREATE INDEX IF NOT EXISTS idx_approval_workflow_steps_workflow_id ON approval_workflow_steps(workflow_id);

      CREATE TABLE IF NOT EXISTS plugin_states (
        id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 1,
        config_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        email TEXT,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL,
        display_name TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        last_login_at TEXT,
        login_count INTEGER NOT NULL DEFAULT 0,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS auth_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        token TEXT NOT NULL UNIQUE,
        user_agent TEXT,
        ip_address TEXT,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_accessed_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
      CREATE INDEX IF NOT EXISTS idx_auth_sessions_token ON auth_sessions(token);
      CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_id ON auth_sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires_at ON auth_sessions(expires_at);

      CREATE TABLE IF NOT EXISTS crm_leads (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        company TEXT,
        title TEXT,
        email TEXT,
        source TEXT NOT NULL,
        stage TEXT NOT NULL,
        status TEXT NOT NULL,
        tags_json TEXT NOT NULL DEFAULT '[]',
        latest_summary TEXT NOT NULL DEFAULT '',
        next_action TEXT,
        owner_role_id TEXT,
        linked_project_id TEXT,
        last_contact_at TEXT,
        archived_at TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_crm_leads_status ON crm_leads(status);
      CREATE INDEX IF NOT EXISTS idx_crm_leads_stage ON crm_leads(stage);
      CREATE INDEX IF NOT EXISTS idx_crm_leads_project ON crm_leads(linked_project_id);

      CREATE TABLE IF NOT EXISTS crm_cadences (
        id TEXT PRIMARY KEY,
        lead_id TEXT NOT NULL,
        label TEXT NOT NULL,
        channel TEXT NOT NULL,
        interval_days INTEGER NOT NULL,
        status TEXT NOT NULL,
        objective TEXT NOT NULL,
        next_run_at TEXT NOT NULL,
        last_run_at TEXT,
        owner_role_id TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_crm_cadences_lead_id ON crm_cadences(lead_id);
      CREATE INDEX IF NOT EXISTS idx_crm_cadences_status ON crm_cadences(status);
      CREATE INDEX IF NOT EXISTS idx_crm_cadences_next_run_at ON crm_cadences(next_run_at);

      CREATE TABLE IF NOT EXISTS crm_contacts (
        id TEXT PRIMARY KEY,
        lead_id TEXT NOT NULL,
        cadence_id TEXT,
        channel TEXT NOT NULL,
        outcome TEXT NOT NULL,
        summary TEXT NOT NULL,
        next_action TEXT,
        happened_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (lead_id) REFERENCES crm_leads(id),
        FOREIGN KEY (cadence_id) REFERENCES crm_cadences(id)
      );

      CREATE INDEX IF NOT EXISTS idx_crm_contacts_lead_id ON crm_contacts(lead_id);
      CREATE INDEX IF NOT EXISTS idx_crm_contacts_happened_at ON crm_contacts(happened_at DESC);

      CREATE TABLE IF NOT EXISTS agent_collaborations (
        id TEXT PRIMARY KEY,
        parent_task_id TEXT NOT NULL,
        session_id TEXT,
        chat_id TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        participants_json TEXT NOT NULL DEFAULT '[]',
        facilitator TEXT NOT NULL DEFAULT 'ceo',
        current_phase TEXT NOT NULL DEFAULT 'assignment',
        phase_results_json TEXT NOT NULL DEFAULT '[]',
        config_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        FOREIGN KEY (parent_task_id) REFERENCES tasks(id)
      );

      CREATE INDEX IF NOT EXISTS idx_agent_collaborations_parent_task ON agent_collaborations(parent_task_id);
      CREATE INDEX IF NOT EXISTS idx_agent_collaborations_status ON agent_collaborations(status);

      CREATE TABLE IF NOT EXISTS agent_messages (
        id TEXT PRIMARY KEY,
        collaboration_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        from_role_id TEXT NOT NULL,
        to_role_ids_json TEXT NOT NULL DEFAULT '[]',
        message_type TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        FOREIGN KEY (collaboration_id) REFERENCES agent_collaborations(id),
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      );

      CREATE INDEX IF NOT EXISTS idx_agent_messages_collaboration ON agent_messages(collaboration_id);
      CREATE INDEX IF NOT EXISTS idx_agent_messages_task ON agent_messages(task_id);
      CREATE INDEX IF NOT EXISTS idx_agent_messages_from_role ON agent_messages(from_role_id);

      CREATE TABLE IF NOT EXISTS collaboration_timeline_events (
        id TEXT PRIMARY KEY,
        collaboration_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        message TEXT NOT NULL,
        role_id TEXT,
        task_id TEXT,
        agent_instance_id TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        FOREIGN KEY (collaboration_id) REFERENCES agent_collaborations(id),
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      );

      CREATE INDEX IF NOT EXISTS idx_collab_timeline_collaboration ON collaboration_timeline_events(collaboration_id);
      CREATE INDEX IF NOT EXISTS idx_collab_timeline_created_at ON collaboration_timeline_events(created_at);

      CREATE TABLE IF NOT EXISTS agent_instances (
        id TEXT PRIMARY KEY,
        role_id TEXT NOT NULL,
        name TEXT NOT NULL,
        tone_policy TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deactivated_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_agent_instances_role ON agent_instances(role_id);
      CREATE INDEX IF NOT EXISTS idx_agent_instances_status ON agent_instances(status);

      CREATE TABLE IF NOT EXISTS goal_runs (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        objective TEXT NOT NULL,
        status TEXT NOT NULL,
        current_stage TEXT NOT NULL,
        requested_by TEXT,
        chat_id TEXT,
        session_id TEXT,
        language TEXT NOT NULL DEFAULT 'zh-CN',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        context_json TEXT NOT NULL DEFAULT '{}',
        plan_json TEXT,
        result_json TEXT,
        current_task_id TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        max_retries INTEGER NOT NULL DEFAULT 2,
        awaiting_input_fields_json TEXT NOT NULL DEFAULT '[]',
        awaiting_input_prompt TEXT,
        error_text TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_goal_runs_status ON goal_runs(status);
      CREATE INDEX IF NOT EXISTS idx_goal_runs_stage ON goal_runs(current_stage);
      CREATE INDEX IF NOT EXISTS idx_goal_runs_updated_at ON goal_runs(updated_at);
      CREATE INDEX IF NOT EXISTS idx_goal_runs_source ON goal_runs(source);

      CREATE TABLE IF NOT EXISTS goal_run_timeline_events (
        id TEXT PRIMARY KEY,
        goal_run_id TEXT NOT NULL,
        stage TEXT NOT NULL,
        event_type TEXT NOT NULL,
        message TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        FOREIGN KEY (goal_run_id) REFERENCES goal_runs(id)
      );

      CREATE INDEX IF NOT EXISTS idx_goal_run_timeline_goal_run ON goal_run_timeline_events(goal_run_id);
      CREATE INDEX IF NOT EXISTS idx_goal_run_timeline_created_at ON goal_run_timeline_events(created_at);

      CREATE TABLE IF NOT EXISTS goal_run_handoff_artifacts (
        id TEXT PRIMARY KEY,
        goal_run_id TEXT NOT NULL,
        stage TEXT NOT NULL,
        task_id TEXT,
        task_trace_id TEXT,
        summary TEXT NOT NULL DEFAULT '',
        artifacts_json TEXT NOT NULL DEFAULT '[]',
        decisions_json TEXT NOT NULL DEFAULT '[]',
        unresolved_questions_json TEXT NOT NULL DEFAULT '[]',
        next_actions_json TEXT NOT NULL DEFAULT '[]',
        approval_needs_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        FOREIGN KEY (goal_run_id) REFERENCES goal_runs(id)
      );

      CREATE INDEX IF NOT EXISTS idx_goal_run_handoff_goal_run ON goal_run_handoff_artifacts(goal_run_id);
      CREATE INDEX IF NOT EXISTS idx_goal_run_handoff_stage ON goal_run_handoff_artifacts(goal_run_id, stage, created_at);

      CREATE TABLE IF NOT EXISTS goal_run_traces (
        id TEXT PRIMARY KEY,
        goal_run_id TEXT NOT NULL,
        stage TEXT NOT NULL,
        status TEXT NOT NULL,
        task_id TEXT,
        task_trace_id TEXT,
        input_summary TEXT NOT NULL DEFAULT '',
        output_summary TEXT NOT NULL DEFAULT '',
        artifact_files_json TEXT NOT NULL DEFAULT '[]',
        completed_roles_json TEXT NOT NULL DEFAULT '[]',
        failed_roles_json TEXT NOT NULL DEFAULT '[]',
        approval_gate_hits INTEGER NOT NULL DEFAULT 0,
        failure_category TEXT,
        handoff_artifact_id TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        FOREIGN KEY (goal_run_id) REFERENCES goal_runs(id),
        FOREIGN KEY (handoff_artifact_id) REFERENCES goal_run_handoff_artifacts(id)
      );

      CREATE INDEX IF NOT EXISTS idx_goal_run_traces_goal_run ON goal_run_traces(goal_run_id);
      CREATE INDEX IF NOT EXISTS idx_goal_run_traces_stage ON goal_run_traces(goal_run_id, stage, created_at);

      CREATE TABLE IF NOT EXISTS goal_run_inputs (
        id TEXT PRIMARY KEY,
        goal_run_id TEXT NOT NULL,
        input_key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        created_by TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(goal_run_id, input_key),
        FOREIGN KEY (goal_run_id) REFERENCES goal_runs(id)
      );

      CREATE INDEX IF NOT EXISTS idx_goal_run_inputs_goal_run ON goal_run_inputs(goal_run_id);

      CREATE TABLE IF NOT EXISTS run_auth_tokens (
        id TEXT PRIMARY KEY,
        goal_run_id TEXT NOT NULL,
        token TEXT NOT NULL UNIQUE,
        scope TEXT NOT NULL,
        status TEXT NOT NULL,
        reason TEXT,
        expires_at TEXT NOT NULL,
        used_by TEXT,
        used_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (goal_run_id) REFERENCES goal_runs(id)
      );

      CREATE INDEX IF NOT EXISTS idx_run_auth_tokens_goal_run ON run_auth_tokens(goal_run_id);
      CREATE INDEX IF NOT EXISTS idx_run_auth_tokens_status ON run_auth_tokens(status);
      CREATE INDEX IF NOT EXISTS idx_run_auth_tokens_expires_at ON run_auth_tokens(expires_at);

      CREATE TABLE IF NOT EXISTS credentials (
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL,
        credential_key TEXT NOT NULL,
        display_name TEXT,
        value_masked TEXT NOT NULL,
        encrypted_value TEXT NOT NULL,
        encryption_version TEXT NOT NULL DEFAULT 'v1',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_by TEXT,
        last_used_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(provider_id, credential_key)
      );

      CREATE INDEX IF NOT EXISTS idx_credentials_provider ON credentials(provider_id);
      CREATE INDEX IF NOT EXISTS idx_credentials_updated_at ON credentials(updated_at);
    `);

    const sessionIdColumn = this.db
      .prepare("SELECT 1 AS found FROM pragma_table_info('tasks') WHERE name = 'session_id'")
      .get() as JsonRow | undefined;
    if (!sessionIdColumn) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN session_id TEXT;");
    }
    const pendingInputJsonColumn = this.db
      .prepare("SELECT 1 AS found FROM pragma_table_info('tasks') WHERE name = 'pending_input_json'")
      .get() as JsonRow | undefined;
    if (!pendingInputJsonColumn) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN pending_input_json TEXT;");
    }
    const skillBindingInstalledAtColumn = this.db
      .prepare("SELECT 1 AS found FROM pragma_table_info('skill_bindings') WHERE name = 'installed_at'")
      .get() as JsonRow | undefined;
    if (!skillBindingInstalledAtColumn) {
      this.db.exec("ALTER TABLE skill_bindings ADD COLUMN installed_at TEXT;");
    }
    const skillBindingSourceColumn = this.db
      .prepare("SELECT 1 AS found FROM pragma_table_info('skill_bindings') WHERE name = 'source'")
      .get() as JsonRow | undefined;
    if (!skillBindingSourceColumn) {
      this.db.exec("ALTER TABLE skill_bindings ADD COLUMN source TEXT;");
    }
    const skillBindingSourceLabelColumn = this.db
      .prepare("SELECT 1 AS found FROM pragma_table_info('skill_bindings') WHERE name = 'source_label'")
      .get() as JsonRow | undefined;
    if (!skillBindingSourceLabelColumn) {
      this.db.exec("ALTER TABLE skill_bindings ADD COLUMN source_label TEXT;");
    }
    const skillBindingSourceUrlColumn = this.db
      .prepare("SELECT 1 AS found FROM pragma_table_info('skill_bindings') WHERE name = 'source_url'")
      .get() as JsonRow | undefined;
    if (!skillBindingSourceUrlColumn) {
      this.db.exec("ALTER TABLE skill_bindings ADD COLUMN source_url TEXT;");
    }
    const skillBindingVersionColumn = this.db
      .prepare("SELECT 1 AS found FROM pragma_table_info('skill_bindings') WHERE name = 'version'")
      .get() as JsonRow | undefined;
    if (!skillBindingVersionColumn) {
      this.db.exec("ALTER TABLE skill_bindings ADD COLUMN version TEXT;");
    }
    const skillBindingVerificationStatusColumn = this.db
      .prepare("SELECT 1 AS found FROM pragma_table_info('skill_bindings') WHERE name = 'verification_status'")
      .get() as JsonRow | undefined;
    if (!skillBindingVerificationStatusColumn) {
      this.db.exec("ALTER TABLE skill_bindings ADD COLUMN verification_status TEXT;");
    }
    const skillBindingVerifiedAtColumn = this.db
      .prepare("SELECT 1 AS found FROM pragma_table_info('skill_bindings') WHERE name = 'verified_at'")
      .get() as JsonRow | undefined;
    if (!skillBindingVerifiedAtColumn) {
      this.db.exec("ALTER TABLE skill_bindings ADD COLUMN verified_at TEXT;");
    }
    const skillBindingLastVerifiedTaskIdColumn = this.db
      .prepare("SELECT 1 AS found FROM pragma_table_info('skill_bindings') WHERE name = 'last_verified_task_id'")
      .get() as JsonRow | undefined;
    if (!skillBindingLastVerifiedTaskIdColumn) {
      this.db.exec("ALTER TABLE skill_bindings ADD COLUMN last_verified_task_id TEXT;");
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_session_id ON tasks(session_id);");
  }

  private seedDefaultSkills(): void {
    const timestamp = now();
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO skill_bindings (
        id, scope, scope_id, skill_id, status, verification_status, config_json, installed_by, installed_at, verified_at, last_verified_task_id, source, source_label, source_url, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const role of listRoles()) {
      for (const skillId of role.defaultSkills) {
        insert.run(
          randomUUID(),
          "role",
          role.id,
          skillId,
          "enabled",
          "verified",
          jsonStringify(getSkillDefinition(skillId)?.defaultConfig ?? {}),
          "system",
          timestamp,
          timestamp,
          null,
          "catalog",
          "catalog",
          null,
          null,
          timestamp,
          timestamp
        );
      }
    }
  }

  private seedDefaultAgentInstances(): void {
    const timestamp = now();
    const countRow = this.db
      .prepare("SELECT COUNT(*) as count FROM agent_instances")
      .get() as JsonRow | undefined;
    const count = Number(countRow?.count ?? 0);
    if (count > 0) {
      return;
    }

    const insert = this.db.prepare(`
      INSERT INTO agent_instances (
        id, role_id, name, tone_policy, status, metadata_json, created_by, created_at, updated_at, deactivated_at
      ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, NULL)
    `);

    for (const role of listRoles()) {
      insert.run(
        randomUUID(),
        role.id,
        role.name,
        "",
        jsonStringify({
          systemDefault: true
        }),
        "system",
        timestamp,
        timestamp
      );
    }
  }

  private resolveCredentialMasterKeyRaw(): string {
    const runtimeSecrets = this.getRuntimeSecrets();
    const runtimeSettings = this.getRuntimeSettings();
    const fromStore = runtimeSecrets[CREDENTIAL_MASTER_KEY] ?? runtimeSettings[CREDENTIAL_MASTER_KEY];
    const fromEnv = process.env[CREDENTIAL_CRYPTO_ENV];
    return (fromStore ?? fromEnv ?? "vinkoclaw-default-credential-key").trim();
  }

  private getCredentialCipherKey(): Buffer {
    return createHash("sha256").update(this.resolveCredentialMasterKeyRaw()).digest();
  }

  private encryptCredentialValue(value: string): { encryptedValue: string; encryptionVersion: string } {
    const iv = randomBytes(12);
    const cipher = createCipheriv(CREDENTIAL_CRYPTO_ALGORITHM, this.getCredentialCipherKey(), iv);
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return {
      encryptedValue: `${CREDENTIAL_CRYPTO_VERSION}.${iv.toString("base64")}.${authTag.toString("base64")}.${encrypted.toString("base64")}`,
      encryptionVersion: CREDENTIAL_CRYPTO_VERSION
    };
  }

  private decryptCredentialValue(encryptedValue: string): string | undefined {
    const parts = encryptedValue.split(".");
    if (parts.length !== 4 || parts[0] !== CREDENTIAL_CRYPTO_VERSION) {
      return undefined;
    }
    const iv = Buffer.from(parts[1] ?? "", "base64");
    const authTag = Buffer.from(parts[2] ?? "", "base64");
    const payload = Buffer.from(parts[3] ?? "", "base64");
    try {
      const decipher = createDecipheriv(CREDENTIAL_CRYPTO_ALGORITHM, this.getCredentialCipherKey(), iv);
      decipher.setAuthTag(authTag);
      const plain = Buffer.concat([decipher.update(payload), decipher.final()]);
      return plain.toString("utf8");
    } catch {
      return undefined;
    }
  }

  getConfigEntry<T>(key: string): T | undefined {
    const row = this.db
      .prepare("SELECT value_json FROM config_entries WHERE key = ?")
      .get(key) as JsonRow | undefined;
    if (!row) {
      return undefined;
    }

    return jsonParse<T | undefined>(row.value_json, undefined);
  }

  setConfigEntry(key: string, value: unknown): void {
    const timestamp = now();
    this.db
      .prepare(`
        INSERT INTO config_entries (key, value_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
      `)
      .run(key, jsonStringify(value), timestamp);
  }

  getRuntimeSecrets(): Record<string, string> {
    const raw = this.getConfigEntry<Record<string, string>>(RUNTIME_SECRETS_KEY) ?? {};
    const normalized: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (!/^[A-Z0-9_]+$/.test(key)) {
        continue;
      }
      if (typeof value !== "string") {
        continue;
      }
      const trimmed = value.trim();
      if (!trimmed) {
        continue;
      }
      normalized[key] = trimmed;
    }
    return normalized;
  }

  getRuntimeSettings(): Record<string, string> {
    const raw = this.getConfigEntry<Record<string, string>>(RUNTIME_SETTINGS_KEY) ?? {};
    const normalized: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (!/^[A-Z0-9_]+$/.test(key)) {
        continue;
      }
      if (typeof value !== "string") {
        continue;
      }
      const trimmed = value.trim();
      if (!trimmed) {
        continue;
      }
      normalized[key] = trimmed;
    }
    return normalized;
  }

  setRuntimeSetting(key: string, value: string): void {
    if (!/^[A-Z0-9_]+$/.test(key)) {
      throw new Error(`Invalid runtime setting key: ${key}`);
    }
    const normalizedValue = value.trim();
    if (!normalizedValue) {
      throw new Error(`Runtime setting ${key} cannot be empty`);
    }
    const next = this.getRuntimeSettings();
    next[key] = normalizedValue;
    this.setConfigEntry(RUNTIME_SETTINGS_KEY, next);
  }

  hasRuntimeSecret(key: string): boolean {
    return Boolean(this.getRuntimeSecrets()[key]?.trim());
  }

  setRuntimeSecret(key: string, value: string): void {
    if (!/^[A-Z0-9_]+$/.test(key)) {
      throw new Error(`Invalid secret key: ${key}`);
    }
    const normalizedValue = value.trim();
    if (!normalizedValue) {
      throw new Error(`Secret ${key} cannot be empty`);
    }
    const next = this.getRuntimeSecrets();
    next[key] = normalizedValue;
    this.setConfigEntry(RUNTIME_SECRETS_KEY, next);
  }

  upsertCredential(input: CreateCredentialInput): CredentialRecord {
    const providerId = normalizeCredentialIdPart(input.providerId);
    const credentialKey = normalizeCredentialIdPart(input.credentialKey);
    const value = input.value.trim();
    if (!providerId) {
      throw new Error("credential providerId is required");
    }
    if (!credentialKey) {
      throw new Error("credential key is required");
    }
    if (!value) {
      throw new Error("credential value is required");
    }

    const timestamp = now();
    const encrypted = this.encryptCredentialValue(value);
    const masked = maskCredentialValue(value);
    const displayName = input.displayName?.trim();
    const createdBy = input.createdBy?.trim() || null;
    const metadata = input.metadata ?? {};
    const existing = this.db
      .prepare("SELECT id FROM credentials WHERE provider_id = ? AND credential_key = ?")
      .get(providerId, credentialKey) as JsonRow | undefined;
    const id = existing ? String(existing.id) : randomUUID();
    this.db
      .prepare(`
        INSERT INTO credentials (
          id, provider_id, credential_key, display_name, value_masked, encrypted_value,
          encryption_version, metadata_json, created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(provider_id, credential_key) DO UPDATE SET
          display_name = excluded.display_name,
          value_masked = excluded.value_masked,
          encrypted_value = excluded.encrypted_value,
          encryption_version = excluded.encryption_version,
          metadata_json = excluded.metadata_json,
          created_by = excluded.created_by,
          updated_at = excluded.updated_at
      `)
      .run(
        id,
        providerId,
        credentialKey,
        displayName ?? null,
        masked,
        encrypted.encryptedValue,
        encrypted.encryptionVersion,
        jsonStringify(metadata),
        createdBy,
        timestamp,
        timestamp
      );

    this.appendAuditEvent({
      category: "credential",
      entityType: "credential",
      entityId: `${providerId}:${credentialKey}`,
      message: existing ? "Updated credential" : "Created credential",
      payload: {
        providerId,
        credentialKey
      }
    });

    const record = this.getCredential(providerId, credentialKey);
    if (!record) {
      throw new Error(`Credential ${providerId}:${credentialKey} was upserted but could not be loaded`);
    }
    return record;
  }

  getCredential(providerId: string, credentialKey: string): CredentialRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM credentials WHERE provider_id = ? AND credential_key = ?")
      .get(normalizeCredentialIdPart(providerId), normalizeCredentialIdPart(credentialKey)) as JsonRow | undefined;
    if (!row) {
      return undefined;
    }
    return stripCredentialSecret(toCredentialSecretRecord(row));
  }

  listCredentials(input?: { providerId?: string | undefined; limit?: number | undefined }): CredentialRecord[] {
    const limitCandidate = Number(input?.limit ?? 200);
    const limit = Number.isFinite(limitCandidate) ? Math.max(1, Math.min(1000, Math.round(limitCandidate))) : 200;
    const providerId = input?.providerId ? normalizeCredentialIdPart(input.providerId) : "";
    const rows = providerId
      ? (this.db
          .prepare("SELECT * FROM credentials WHERE provider_id = ? ORDER BY updated_at DESC LIMIT ?")
          .all(providerId, limit) as JsonRow[])
      : (this.db
          .prepare("SELECT * FROM credentials ORDER BY updated_at DESC LIMIT ?")
          .all(limit) as JsonRow[]);
    return rows.map((row) => stripCredentialSecret(toCredentialSecretRecord(row)));
  }

  resolveCredentialSecret(providerId: string, credentialKey: string): string | undefined {
    const row = this.db
      .prepare("SELECT * FROM credentials WHERE provider_id = ? AND credential_key = ?")
      .get(normalizeCredentialIdPart(providerId), normalizeCredentialIdPart(credentialKey)) as JsonRow | undefined;
    if (!row) {
      return undefined;
    }
    const record = toCredentialSecretRecord(row);
    return this.decryptCredentialValue(record.encryptedValue);
  }

  touchCredentialUsage(providerId: string, credentialKey: string): void {
    this.db
      .prepare("UPDATE credentials SET last_used_at = ?, updated_at = ? WHERE provider_id = ? AND credential_key = ?")
      .run(now(), now(), normalizeCredentialIdPart(providerId), normalizeCredentialIdPart(credentialKey));
  }

  deleteCredential(providerId: string, credentialKey: string): boolean {
    const normalizedProvider = normalizeCredentialIdPart(providerId);
    const normalizedKey = normalizeCredentialIdPart(credentialKey);
    const result = this.db
      .prepare("DELETE FROM credentials WHERE provider_id = ? AND credential_key = ?")
      .run(normalizedProvider, normalizedKey);
    if (result.changes > 0) {
      this.appendAuditEvent({
        category: "credential",
        entityType: "credential",
        entityId: `${normalizedProvider}:${normalizedKey}`,
        message: "Deleted credential",
        payload: {}
      });
      return true;
    }
    return false;
  }

  getRuntimeConfig(): RuntimeConfig {
    const config = this.getConfigEntry<Partial<RuntimeConfig>>("runtime-config");
    return normalizeRuntimeConfig(config);
  }

  patchRuntimeConfig(mutator: (config: RuntimeConfig) => RuntimeConfig): RuntimeConfig {
    const nextConfig = normalizeRuntimeConfig(mutator(structuredClone(this.getRuntimeConfig())));
    this.setConfigEntry("runtime-config", nextConfig);
    return nextConfig;
  }

  listRoutingTemplates(): RoutingTemplate[] {
    const templates = this.getConfigEntry<RoutingTemplate[]>(ROUTING_TEMPLATES_KEY) ?? [];
    return templates.map((template) => toRoutingTemplate(template, template.id));
  }

  getRoutingTemplate(templateId: string): RoutingTemplate | undefined {
    return this.listRoutingTemplates().find((template) => template.id === templateId);
  }

  createRoutingTemplate(input: CreateRoutingTemplateInput): RoutingTemplate {
    const normalized = toRoutingTemplate({
      id: randomUUID(),
      name: input.name,
      description: input.description ?? "",
      triggerKeywords: input.triggerKeywords,
      matchMode: input.matchMode ?? "any",
      enabled: input.enabled ?? true,
      tasks: input.tasks
    });

    if (normalized.triggerKeywords.length === 0) {
      throw new Error("Routing template requires at least one trigger keyword");
    }
    if (normalized.tasks.length === 0) {
      throw new Error("Routing template requires at least one task");
    }

    const templates = this.listRoutingTemplates();
    templates.push(normalized);
    this.setConfigEntry(ROUTING_TEMPLATES_KEY, templates);

    this.appendAuditEvent({
      category: "routing-template",
      entityType: "routing_template",
      entityId: normalized.id,
      message: `Created routing template ${normalized.name}`,
      payload: {
        triggerKeywords: normalized.triggerKeywords
      }
    });

    return normalized;
  }

  updateRoutingTemplate(templateId: string, patch: UpdateRoutingTemplateInput): RoutingTemplate | undefined {
    const templates = this.listRoutingTemplates();
    const index = templates.findIndex((template) => template.id === templateId);
    if (index < 0) {
      return undefined;
    }

    const current = templates[index];
    if (!current) {
      return undefined;
    }

    const updated = toRoutingTemplate(
      {
        id: current.id,
        name: patch.name ?? current.name,
        description: patch.description ?? current.description,
        triggerKeywords: patch.triggerKeywords ?? current.triggerKeywords,
        matchMode: patch.matchMode ?? current.matchMode,
        enabled: patch.enabled ?? current.enabled,
        createdAt: current.createdAt,
        tasks: patch.tasks ?? current.tasks,
        updatedAt: now()
      },
      templateId
    );

    if (updated.triggerKeywords.length === 0) {
      throw new Error("Routing template requires at least one trigger keyword");
    }
    if (updated.tasks.length === 0) {
      throw new Error("Routing template requires at least one task");
    }

    templates[index] = updated;
    this.setConfigEntry(ROUTING_TEMPLATES_KEY, templates);

    this.appendAuditEvent({
      category: "routing-template",
      entityType: "routing_template",
      entityId: updated.id,
      message: `Updated routing template ${updated.name}`,
      payload: {
        triggerKeywords: updated.triggerKeywords
      }
    });

    return updated;
  }

  deleteRoutingTemplate(templateId: string): boolean {
    const templates = this.listRoutingTemplates();
    const nextTemplates = templates.filter((template) => template.id !== templateId);
    if (nextTemplates.length === templates.length) {
      return false;
    }

    this.setConfigEntry(ROUTING_TEMPLATES_KEY, nextTemplates);
    this.appendAuditEvent({
      category: "routing-template",
      entityType: "routing_template",
      entityId: templateId,
      message: "Deleted routing template",
      payload: {}
    });
    return true;
  }

  importRoutingTemplates(
    templates: RoutingTemplate[],
    mode: "merge" | "replace" = "merge"
  ): RoutingTemplate[] {
    const normalizedIncoming = templates.map((template) => toRoutingTemplate(template, template.id));
    for (const template of normalizedIncoming) {
      if (template.triggerKeywords.length === 0) {
        throw new Error(`Routing template ${template.id} requires at least one trigger keyword`);
      }
      if (template.tasks.length === 0) {
        throw new Error(`Routing template ${template.id} requires at least one task`);
      }
    }

    let nextTemplates: RoutingTemplate[];
    if (mode === "replace") {
      nextTemplates = normalizedIncoming;
    } else {
      const merged = new Map<string, RoutingTemplate>();
      for (const existing of this.listRoutingTemplates()) {
        merged.set(existing.id, existing);
      }
      for (const template of normalizedIncoming) {
        merged.set(template.id, {
          ...template,
          updatedAt: now()
        });
      }
      nextTemplates = Array.from(merged.values());
    }

    this.setConfigEntry(ROUTING_TEMPLATES_KEY, nextTemplates);
    this.appendAuditEvent({
      category: "routing-template",
      entityType: "routing_template",
      entityId: "bulk-import",
      message: `Imported ${normalizedIncoming.length} routing templates`,
      payload: {
        mode,
        count: normalizedIncoming.length
      }
    });
    return this.listRoutingTemplates();
  }

  getQueueMetrics(): QueueMetrics {
    const nowMs = Date.now();
    const cutoffMs = nowMs - 24 * 60 * 60 * 1000;
    const { warningWaitMs, criticalWaitMs } = this.getRuntimeConfig().queue.sla;
    const rows = this.db
      .prepare(
        "SELECT role_id, status, metadata_json, created_at, started_at, completed_at FROM tasks ORDER BY created_at DESC"
      )
      .all() as JsonRow[];

    const roleMetrics = new Map<string, QueueMetricItem & { waitSamples: number[]; runSamples: number[] }>();
    const templateMetrics = new Map<string, QueueMetricItem & { waitSamples: number[]; runSamples: number[] }>();
    let queuedCount = 0;
    let runningCount = 0;
    let completedCountLast24h = 0;
    let oldestQueuedWaitMs = 0;
    const waitSamplesLast24h: number[] = [];
    const runSamplesLast24h: number[] = [];

    for (const row of rows) {
      const roleId = String(row.role_id ?? "unknown");
      const status = String(row.status ?? "");
      const metadata = jsonParse<Record<string, unknown>>(row.metadata_json, {});
      const templateId =
        typeof metadata.routeTemplateId === "string" && metadata.routeTemplateId
          ? metadata.routeTemplateId
          : undefined;
      const templateName =
        typeof metadata.routeTemplateName === "string" && metadata.routeTemplateName
          ? metadata.routeTemplateName
          : templateId;
      const createdAtMs = parseTimestampMs(maybeString(row.created_at));
      const startedAtMs = parseTimestampMs(maybeString(row.started_at));
      const completedAtMs = parseTimestampMs(maybeString(row.completed_at));

      const roleEntry = roleMetrics.get(roleId) ?? {
        ...createEmptyMetricItem(roleId, roleId),
        waitSamples: [],
        runSamples: []
      };
      roleMetrics.set(roleId, roleEntry);

      const templateEntry =
        templateId !== undefined
          ? templateMetrics.get(templateId) ?? {
              ...createEmptyMetricItem(templateId, String(templateName ?? templateId)),
              waitSamples: [],
              runSamples: []
            }
          : undefined;

      if (templateId && templateEntry) {
        templateMetrics.set(templateId, templateEntry);
      }

      if (status === "queued") {
        queuedCount += 1;
        roleEntry.queued += 1;
        if (templateEntry) {
          templateEntry.queued += 1;
        }
        if (createdAtMs !== undefined && nowMs >= createdAtMs) {
          oldestQueuedWaitMs = Math.max(oldestQueuedWaitMs, nowMs - createdAtMs);
        }
      }

      if (status === "running") {
        runningCount += 1;
        roleEntry.running += 1;
        if (templateEntry) {
          templateEntry.running += 1;
        }
      }

      if (createdAtMs !== undefined && startedAtMs !== undefined && startedAtMs >= createdAtMs) {
        const waitMs = startedAtMs - createdAtMs;
        roleEntry.waitSamples.push(waitMs);
        if (templateEntry) {
          templateEntry.waitSamples.push(waitMs);
        }
        if (startedAtMs >= cutoffMs || createdAtMs >= cutoffMs) {
          waitSamplesLast24h.push(waitMs);
        }
      }

      if (startedAtMs !== undefined && completedAtMs !== undefined && completedAtMs >= startedAtMs) {
        const runMs = completedAtMs - startedAtMs;
        roleEntry.runSamples.push(runMs);
        if (templateEntry) {
          templateEntry.runSamples.push(runMs);
        }
        if (completedAtMs >= cutoffMs) {
          runSamplesLast24h.push(runMs);
        }
      }

      if (status === "completed" && completedAtMs !== undefined && completedAtMs >= cutoffMs) {
        completedCountLast24h += 1;
      }
    }

    const avgWaitMsLast24h =
      waitSamplesLast24h.length === 0
        ? 0
        : Math.round(waitSamplesLast24h.reduce((total, value) => total + value, 0) / waitSamplesLast24h.length);
    const avgRunMsLast24h =
      runSamplesLast24h.length === 0
        ? 0
        : Math.round(runSamplesLast24h.reduce((total, value) => total + value, 0) / runSamplesLast24h.length);

    let alertLevel: QueueMetrics["alertLevel"] = "ok";
    const alerts: QueueMetrics["alerts"] = [];
    if (queuedCount > 0 && oldestQueuedWaitMs >= criticalWaitMs) {
      alertLevel = "critical";
      alerts.push({
        level: "critical",
        message: `Oldest queued task wait exceeded critical threshold (${oldestQueuedWaitMs}ms >= ${criticalWaitMs}ms)`,
        queuedCount,
        oldestQueuedWaitMs,
        warningWaitMs,
        criticalWaitMs
      });
    } else if (queuedCount > 0 && oldestQueuedWaitMs >= warningWaitMs) {
      alertLevel = "warning";
      alerts.push({
        level: "warning",
        message: `Oldest queued task wait exceeded warning threshold (${oldestQueuedWaitMs}ms >= ${warningWaitMs}ms)`,
        queuedCount,
        oldestQueuedWaitMs,
        warningWaitMs,
        criticalWaitMs
      });
    }

    return {
      queuedCount,
      runningCount,
      completedCountLast24h,
      avgWaitMsLast24h,
      avgRunMsLast24h,
      oldestQueuedWaitMs,
      alertLevel,
      alerts,
      byRole: finalizeMetricItems(roleMetrics),
      byTemplate: finalizeMetricItems(templateMetrics),
      updatedAt: now()
    };
  }

  getSession(sessionId: string): SessionRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .get(sessionId) as JsonRow | undefined;
    return row ? toSessionRecord(row) : undefined;
  }

  getSessionBySourceKey(source: SessionRecord["source"], sourceKey: string): SessionRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM sessions WHERE source = ? AND source_key = ?")
      .get(source, sourceKey) as JsonRow | undefined;
    return row ? toSessionRecord(row) : undefined;
  }

  ensureSession(input: CreateSessionInput): SessionRecord {
    const sourceKey = input.sourceKey.trim();
    if (!sourceKey) {
      throw new Error("sourceKey is required to create session");
    }
    const title = (input.title ?? sourceKey).trim() || sourceKey;
    const timestamp = now();
    const existing = this.getSessionBySourceKey(input.source, sourceKey);
    if (existing) {
      const workspaceMemory = this.getWorkspaceMemory();
      const existingMetadata =
        typeof existing.metadata === "object" && existing.metadata !== null ? existing.metadata : {};
      const refreshedMetadata = {
        ...existingMetadata,
        ...(input.metadata ?? {}),
        workspaceContext: {
          preferredLanguage: workspaceMemory.userPreferences.preferredLanguage,
          preferredTechStack: workspaceMemory.userPreferences.preferredTechStack,
          communicationStyle: workspaceMemory.userPreferences.communicationStyle,
          activeProjects: workspaceMemory.projectContext.activeProjects,
          keyDecisions: workspaceMemory.keyDecisions.slice(-5),
          founderProfile: workspaceMemory.founderProfile
        }
      };
      this.db
        .prepare(`
          UPDATE sessions
          SET title = ?, metadata_json = ?, updated_at = ?, last_message_at = ?
          WHERE id = ?
        `)
        .run(title, jsonStringify(refreshedMetadata), timestamp, timestamp, existing.id);
      return this.getSession(existing.id) ?? existing;
    }

    const sessionId = randomUUID();
    // Inject workspace memory context into new session metadata
    const workspaceMemory = this.getWorkspaceMemory();
    const baseMetadata = input.metadata ?? {};
    const enrichedMetadata: Record<string, unknown> = {
      ...baseMetadata,
      workspaceContext: {
        preferredLanguage: workspaceMemory.userPreferences.preferredLanguage,
        preferredTechStack: workspaceMemory.userPreferences.preferredTechStack,
        communicationStyle: workspaceMemory.userPreferences.communicationStyle,
        activeProjects: workspaceMemory.projectContext.activeProjects,
        keyDecisions: workspaceMemory.keyDecisions.slice(-5), // Last 5 decisions for context
        founderProfile: workspaceMemory.founderProfile
      }
    };

    this.db
      .prepare(`
        INSERT INTO sessions (
          id, source, source_key, title, status, metadata_json, created_at, updated_at, last_message_at
        ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)
      `)
      .run(
        sessionId,
        input.source,
        sourceKey,
        title,
        jsonStringify(enrichedMetadata),
        timestamp,
        timestamp,
        timestamp
      );

    this.appendAuditEvent({
      category: "session",
      entityType: "session",
      entityId: sessionId,
      message: "Created session",
      payload: {
        source: input.source,
        sourceKey
      }
    });

    const session = this.getSession(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} was created but could not be loaded`);
    }
    return session;
  }

  touchSession(sessionId: string, when: string = now()): void {
    this.db
      .prepare(`
        UPDATE sessions
        SET last_message_at = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(when, when, sessionId);
  }

  patchSessionMetadata(sessionId: string, patch: Record<string, unknown>): SessionRecord | undefined {
    const session = this.getSession(sessionId);
    if (!session) {
      return undefined;
    }
    const merged = {
      ...(session.metadata ?? {}),
      ...patch
    };
    const timestamp = now();
    this.db
      .prepare(`
        UPDATE sessions
        SET metadata_json = ?, updated_at = ?, last_message_at = ?
        WHERE id = ?
      `)
      .run(jsonStringify(merged), timestamp, timestamp, sessionId);
    return this.getSession(sessionId);
  }

  updateSessionProjectMemory(
    sessionId: string,
    patch: ProjectMemoryUpdate,
    metadataPatch?: Record<string, unknown>
  ): SessionRecord | undefined {
    const session = this.getSession(sessionId);
    if (!session) {
      return undefined;
    }
    const nextProjectMemory = mergeProjectMemory(session.metadata?.projectMemory, patch);
    return this.patchSessionMetadata(sessionId, {
      ...(metadataPatch ?? {}),
      projectMemory: normalizeProjectMemory(nextProjectMemory)
    });
  }

  listSessions(limit = 100): SessionRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?")
      .all(limit) as JsonRow[];
    return rows.map(toSessionRecord);
  }

  appendSessionMessage(input: CreateSessionMessageInput): SessionMessageRecord {
    const messageId = randomUUID();
    const timestamp = now();
    this.db
      .prepare(`
        INSERT INTO session_messages (
          id, session_id, actor_type, actor_id, role_id, message_type, content, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        messageId,
        input.sessionId,
        input.actorType,
        input.actorId,
        input.roleId ?? null,
        input.messageType ?? "text",
        input.content,
        jsonStringify(input.metadata ?? {}),
        timestamp
      );

    this.touchSession(input.sessionId, timestamp);

    const row = this.db
      .prepare("SELECT * FROM session_messages WHERE id = ?")
      .get(messageId) as JsonRow | undefined;
    if (!row) {
      throw new Error(`Session message ${messageId} was created but could not be loaded`);
    }
    return toSessionMessageRecord(row);
  }

  listSessionMessages(sessionId: string, limit = 200): SessionMessageRecord[] {
    const rows = this.db
      .prepare(`
        SELECT * FROM session_messages
        WHERE session_id = ?
        ORDER BY created_at ASC, rowid ASC
        LIMIT ?
      `)
      .all(sessionId, limit) as JsonRow[];
    return rows.map(toSessionMessageRecord);
  }

  createTaskRelation(input: CreateTaskRelationInput): TaskRelationRecord {
    const relationId = randomUUID();
    const timestamp = now();
    this.db
      .prepare(`
        INSERT OR IGNORE INTO task_relations (
          id, parent_task_id, child_task_id, relation_type, created_at
        ) VALUES (?, ?, ?, ?, ?)
      `)
      .run(relationId, input.parentTaskId, input.childTaskId, input.relationType, timestamp);

    const row = this.db
      .prepare(`
        SELECT * FROM task_relations
        WHERE parent_task_id = ? AND child_task_id = ? AND relation_type = ?
        ORDER BY created_at DESC
        LIMIT 1
      `)
      .get(input.parentTaskId, input.childTaskId, input.relationType) as JsonRow | undefined;
    if (!row) {
      throw new Error(
        `Task relation (${input.parentTaskId} -> ${input.childTaskId}, ${input.relationType}) could not be loaded`
      );
    }
    return toTaskRelationRecord(row);
  }

  listTaskChildren(parentTaskId: string): TaskRecord[] {
    const rows = this.db
      .prepare(`
        SELECT t.*
        FROM task_relations rel
        JOIN tasks t ON t.id = rel.child_task_id
        WHERE rel.parent_task_id = ?
        ORDER BY t.created_at ASC
      `)
      .all(parentTaskId) as JsonRow[];
    return rows.map(toTaskRecord);
  }

  listTaskParents(childTaskId: string): TaskRecord[] {
    const rows = this.db
      .prepare(`
        SELECT t.*
        FROM task_relations rel
        JOIN tasks t ON t.id = rel.parent_task_id
        WHERE rel.child_task_id = ?
        ORDER BY t.created_at ASC
      `)
      .all(childTaskId) as JsonRow[];
    return rows.map(toTaskRecord);
  }

  listTaskRelationsByParent(parentTaskId: string): TaskRelationRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM task_relations WHERE parent_task_id = ? ORDER BY created_at ASC")
      .all(parentTaskId) as JsonRow[];
    return rows.map(toTaskRelationRecord);
  }

  createTask(input: CreateTaskInput): TaskRecord {
    const taskId = randomUUID();
    const timestamp = now();
    if (input.sessionId) {
      this.touchSession(input.sessionId, timestamp);
    }
    this.db
      .prepare(`
        INSERT INTO tasks (
          id, session_id, source, role_id, title, instruction, status, priority, chat_id, requested_by,
          metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        taskId,
        input.sessionId ?? null,
        input.source,
        input.roleId,
        input.title,
        input.instruction,
        input.status ?? "queued",
        input.priority ?? 50,
        input.chatId ?? null,
        input.requestedBy ?? null,
        jsonStringify(input.metadata ?? {}),
        timestamp,
        timestamp
      );

    this.appendAuditEvent({
      category: "task",
      entityType: "task",
      entityId: taskId,
      message: `Created task ${input.title}`,
      payload: {
        roleId: input.roleId,
        source: input.source,
        sessionId: input.sessionId ?? ""
      }
    });

    const task = this.getTask(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} was created but could not be loaded`);
    }

    return task;
  }

  getTask(taskId: string): TaskRecord | undefined {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as JsonRow | undefined;
    return row ? toTaskRecord(row) : undefined;
  }

  listTasks(limit = 50): TaskRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM tasks ORDER BY updated_at DESC LIMIT ?")
      .all(limit) as JsonRow[];
    return rows.map(toTaskRecord);
  }

  createGoalRun(input: CreateGoalRunInput): GoalRunRecord {
    const id = randomUUID();
    const timestamp = now();
    const objective = input.objective.trim();
    if (!objective) {
      throw new Error("goal run objective is required");
    }
    const language = input.language?.trim() || "zh-CN";
    const maxRetriesCandidate = Number(input.maxRetries ?? 2);
    const maxRetries = Number.isFinite(maxRetriesCandidate)
      ? Math.max(0, Math.min(10, Math.round(maxRetriesCandidate)))
      : 2;

    this.db
      .prepare(`
        INSERT INTO goal_runs (
          id, source, objective, status, current_stage, requested_by, chat_id, session_id, language,
          metadata_json, context_json, retry_count, max_retries, awaiting_input_fields_json,
          created_at, updated_at
        ) VALUES (?, ?, ?, 'queued', 'discover', ?, ?, ?, ?, ?, ?, 0, ?, '[]', ?, ?)
      `)
      .run(
        id,
        input.source,
        objective,
        input.requestedBy ?? null,
        input.chatId ?? null,
        input.sessionId ?? null,
        language,
        jsonStringify(input.metadata ?? {}),
        jsonStringify(input.context ?? {}),
        maxRetries,
        timestamp,
        timestamp
      );

    const created = this.getGoalRun(id);
    if (!created) {
      throw new Error(`Goal run ${id} was created but could not be loaded`);
    }

    this.appendGoalRunTimelineEvent({
      goalRunId: created.id,
      stage: created.currentStage,
      eventType: "run_created",
      message: "Goal run created and queued",
      payload: {
        source: created.source
      }
    });

    this.appendAuditEvent({
      category: "goal-run",
      entityType: "goal_run",
      entityId: created.id,
      message: "Created goal run",
      payload: {
        source: created.source,
        objective: created.objective.slice(0, 120)
      }
    });

    return created;
  }

  getGoalRun(goalRunId: string): GoalRunRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM goal_runs WHERE id = ?")
      .get(goalRunId) as JsonRow | undefined;
    return row ? toGoalRunRecord(row) : undefined;
  }

  listGoalRuns(input?: { limit?: number | undefined; status?: GoalRunStatus | undefined }): GoalRunRecord[] {
    const limitCandidate = Number(input?.limit ?? 50);
    const limit = Number.isFinite(limitCandidate) ? Math.max(1, Math.min(500, Math.round(limitCandidate))) : 50;
    const status = input?.status;
    const rows = status
      ? (this.db
          .prepare("SELECT * FROM goal_runs WHERE status = ? ORDER BY updated_at DESC LIMIT ?")
          .all(status, limit) as JsonRow[])
      : (this.db
          .prepare("SELECT * FROM goal_runs ORDER BY updated_at DESC LIMIT ?")
          .all(limit) as JsonRow[]);
    return rows.map(toGoalRunRecord);
  }

  private updateGoalRunFields(
    goalRunId: string,
    patch: Partial<{
      status: GoalRunStatus;
      currentStage: GoalRunStage;
      metadata: Record<string, unknown>;
      context: Record<string, unknown>;
      plan: Record<string, unknown> | null;
      result: GoalRunResult | null;
      currentTaskId: string | null;
      retryCount: number;
      maxRetries: number;
      awaitingInputFields: string[];
      awaitingInputPrompt: string | null;
      errorText: string | null;
      startedAt: string | null;
      completedAt: string | null;
    }>
  ): GoalRunRecord | undefined {
    const updates: string[] = [];
    const values: Array<string | number | null> = [];

    if (patch.status !== undefined) {
      updates.push("status = ?");
      values.push(patch.status);
    }
    if (patch.currentStage !== undefined) {
      updates.push("current_stage = ?");
      values.push(patch.currentStage);
    }
    if (patch.metadata !== undefined) {
      updates.push("metadata_json = ?");
      values.push(jsonStringify(patch.metadata));
    }
    if (patch.context !== undefined) {
      updates.push("context_json = ?");
      values.push(jsonStringify(patch.context));
    }
    if (patch.plan !== undefined) {
      updates.push("plan_json = ?");
      values.push(patch.plan === null ? null : jsonStringify(patch.plan));
    }
    if (patch.result !== undefined) {
      updates.push("result_json = ?");
      values.push(patch.result === null ? null : jsonStringify(patch.result));
    }
    if (patch.currentTaskId !== undefined) {
      updates.push("current_task_id = ?");
      values.push(patch.currentTaskId);
    }
    if (patch.retryCount !== undefined) {
      updates.push("retry_count = ?");
      values.push(Math.max(0, Math.round(patch.retryCount)));
    }
    if (patch.maxRetries !== undefined) {
      updates.push("max_retries = ?");
      values.push(Math.max(0, Math.round(patch.maxRetries)));
    }
    if (patch.awaitingInputFields !== undefined) {
      updates.push("awaiting_input_fields_json = ?");
      values.push(jsonStringify(patch.awaitingInputFields));
    }
    if (patch.awaitingInputPrompt !== undefined) {
      updates.push("awaiting_input_prompt = ?");
      values.push(patch.awaitingInputPrompt);
    }
    if (patch.errorText !== undefined) {
      updates.push("error_text = ?");
      values.push(patch.errorText);
    }
    if (patch.startedAt !== undefined) {
      updates.push("started_at = ?");
      values.push(patch.startedAt);
    }
    if (patch.completedAt !== undefined) {
      updates.push("completed_at = ?");
      values.push(patch.completedAt);
    }

    if (updates.length === 0) {
      return this.getGoalRun(goalRunId);
    }

    updates.push("updated_at = ?");
    values.push(now());
    values.push(goalRunId);
    this.db
      .prepare(`UPDATE goal_runs SET ${updates.join(", ")} WHERE id = ?`)
      .run(...values);
    return this.getGoalRun(goalRunId);
  }

  claimNextQueuedGoalRun(): GoalRunRecord | undefined {
    const row = this.db
      .prepare(`
        SELECT id
        FROM goal_runs
        WHERE status = 'queued'
        ORDER BY created_at ASC
        LIMIT 1
      `)
      .get() as JsonRow | undefined;
    if (!row) {
      return undefined;
    }
    const goalRunId = String(row.id);
    const timestamp = now();
    const result = this.db
      .prepare(`
        UPDATE goal_runs
        SET status = 'running',
            started_at = COALESCE(started_at, ?),
            updated_at = ?
        WHERE id = ? AND status = 'queued'
      `)
      .run(timestamp, timestamp, goalRunId);
    if (result.changes === 0) {
      return undefined;
    }
    return this.getGoalRun(goalRunId);
  }

  queueGoalRun(goalRunId: string, stage?: GoalRunStage): GoalRunRecord | undefined {
    const run = this.getGoalRun(goalRunId);
    if (!run) {
      return undefined;
    }
    return this.updateGoalRunFields(goalRunId, {
      status: "queued",
      currentStage: stage ?? run.currentStage,
      awaitingInputFields: [],
      awaitingInputPrompt: null,
      errorText: null
    });
  }

  markGoalRunRunning(goalRunId: string, stage?: GoalRunStage): GoalRunRecord | undefined {
    const run = this.getGoalRun(goalRunId);
    if (!run) {
      return undefined;
    }
    return this.updateGoalRunFields(goalRunId, {
      status: "running",
      currentStage: stage ?? run.currentStage,
      awaitingInputFields: [],
      awaitingInputPrompt: null
    });
  }

  markGoalRunAwaitingInput(input: {
    goalRunId: string;
    stage?: GoalRunStage | undefined;
    prompt: string;
    fields: string[];
  }): GoalRunRecord | undefined {
    const run = this.getGoalRun(input.goalRunId);
    if (!run) {
      return undefined;
    }
    return this.updateGoalRunFields(input.goalRunId, {
      status: "awaiting_input",
      currentStage: input.stage ?? run.currentStage,
      awaitingInputPrompt: input.prompt,
      awaitingInputFields: input.fields,
      errorText: null
    });
  }

  markGoalRunAwaitingAuthorization(input: {
    goalRunId: string;
    stage?: GoalRunStage | undefined;
    reason?: string | undefined;
  }): GoalRunRecord | undefined {
    const run = this.getGoalRun(input.goalRunId);
    if (!run) {
      return undefined;
    }
    return this.updateGoalRunFields(input.goalRunId, {
      status: "awaiting_authorization",
      currentStage: input.stage ?? run.currentStage,
      errorText: input.reason ?? null
    });
  }

  updateGoalRunContext(goalRunId: string, patch: Record<string, unknown>): GoalRunRecord | undefined {
    const run = this.getGoalRun(goalRunId);
    if (!run) {
      return undefined;
    }
    return this.updateGoalRunFields(goalRunId, {
      context: {
        ...run.context,
        ...patch
      }
    });
  }

  setGoalRunPlan(goalRunId: string, plan: Record<string, unknown>): GoalRunRecord | undefined {
    return this.updateGoalRunFields(goalRunId, {
      plan
    });
  }

  setGoalRunCurrentTask(goalRunId: string, taskId?: string | undefined): GoalRunRecord | undefined {
    return this.updateGoalRunFields(goalRunId, {
      currentTaskId: taskId ?? null
    });
  }

  incrementGoalRunRetry(goalRunId: string): GoalRunRecord | undefined {
    const run = this.getGoalRun(goalRunId);
    if (!run) {
      return undefined;
    }
    return this.updateGoalRunFields(goalRunId, {
      retryCount: run.retryCount + 1
    });
  }

  completeGoalRun(goalRunId: string, result: GoalRunResult): GoalRunRecord | undefined {
    const timestamp = now();
    return this.updateGoalRunFields(goalRunId, {
      status: "completed",
      currentStage: "accept",
      result,
      awaitingInputFields: [],
      awaitingInputPrompt: null,
      errorText: null,
      completedAt: timestamp
    });
  }

  failGoalRun(goalRunId: string, errorText: string): GoalRunRecord | undefined {
    const timestamp = now();
    return this.updateGoalRunFields(goalRunId, {
      status: "failed",
      errorText: errorText.trim() || "goal run failed",
      completedAt: timestamp
    });
  }

  cancelGoalRun(goalRunId: string, reason?: string): GoalRunRecord | undefined {
    const run = this.getGoalRun(goalRunId);
    if (!run) {
      return undefined;
    }

    const taskIdsToCancel = new Set<string>();
    const queue: string[] = [];
    if (run.currentTaskId) {
      queue.push(run.currentTaskId);
    }

    for (const task of this.listTasks(5000)) {
      const metadata = task.metadata as { goalRunId?: string };
      if (metadata.goalRunId === goalRunId) {
        queue.push(task.id);
      }
    }

    while (queue.length > 0) {
      const currentTaskId = queue.shift();
      if (!currentTaskId || taskIdsToCancel.has(currentTaskId)) {
        continue;
      }
      taskIdsToCancel.add(currentTaskId);
      for (const child of this.listTaskChildren(currentTaskId)) {
        queue.push(child.id);
      }
    }

    const normalizedReason = reason?.trim();
    const cancelReason = normalizedReason || `goal run ${goalRunId} cancelled`;
    for (const taskId of taskIdsToCancel) {
      this.cancelTask(taskId, cancelReason);
    }
    this.revokeRunAuthTokens(goalRunId, cancelReason);

    const timestamp = now();
    return this.updateGoalRunFields(goalRunId, {
      status: "cancelled",
      currentTaskId: null,
      awaitingInputFields: [],
      awaitingInputPrompt: null,
      errorText: normalizedReason ?? null,
      completedAt: timestamp
    });
  }

  appendGoalRunTimelineEvent(input: {
    goalRunId: string;
    stage: GoalRunStage;
    eventType: GoalRunTimelineEventRecord["eventType"];
    message: string;
    payload?: Record<string, unknown> | undefined;
  }): GoalRunTimelineEventRecord {
    const id = randomUUID();
    const timestamp = now();
    this.db
      .prepare(`
        INSERT INTO goal_run_timeline_events (
          id, goal_run_id, stage, event_type, message, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(id, input.goalRunId, input.stage, input.eventType, input.message, jsonStringify(input.payload ?? {}), timestamp);
    const row = this.db
      .prepare("SELECT * FROM goal_run_timeline_events WHERE id = ?")
      .get(id) as JsonRow | undefined;
    if (!row) {
      throw new Error(`Goal run timeline event ${id} was created but could not be loaded`);
    }
    return toGoalRunTimelineEventRecord(row);
  }

  listGoalRunTimelineEvents(goalRunId: string, limit = 500): GoalRunTimelineEventRecord[] {
    const rows = this.db
      .prepare(`
        SELECT * FROM goal_run_timeline_events
        WHERE goal_run_id = ?
        ORDER BY created_at ASC
        LIMIT ?
      `)
      .all(goalRunId, Math.max(1, Math.min(2000, Math.round(limit)))) as JsonRow[];
    return rows.map(toGoalRunTimelineEventRecord);
  }

  appendGoalRunHandoffArtifact(input: {
    goalRunId: string;
    stage: GoalRunStage;
    taskId?: string | undefined;
    taskTraceId?: string | undefined;
    summary: string;
    artifacts?: string[] | undefined;
    decisions?: string[] | undefined;
    unresolvedQuestions?: string[] | undefined;
    nextActions?: string[] | undefined;
    approvalNeeds?: string[] | undefined;
  }): { id: string; artifact: StageHandoffArtifact } {
    const id = randomUUID();
    const timestamp = now();
    this.db
      .prepare(`
        INSERT INTO goal_run_handoff_artifacts (
          id, goal_run_id, stage, task_id, task_trace_id, summary, artifacts_json,
          decisions_json, unresolved_questions_json, next_actions_json, approval_needs_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        input.goalRunId,
        input.stage,
        input.taskId ?? null,
        input.taskTraceId ?? null,
        input.summary.trim(),
        jsonStringify(input.artifacts ?? []),
        jsonStringify(input.decisions ?? []),
        jsonStringify(input.unresolvedQuestions ?? []),
        jsonStringify(input.nextActions ?? []),
        jsonStringify(input.approvalNeeds ?? []),
        timestamp
      );
    const row = this.db
      .prepare("SELECT * FROM goal_run_handoff_artifacts WHERE id = ?")
      .get(id) as JsonRow | undefined;
    if (!row) {
      throw new Error(`Goal run handoff artifact ${id} was created but could not be loaded`);
    }
    return {
      id,
      artifact: toStageHandoffArtifact(row)
    };
  }

  listGoalRunHandoffArtifacts(
    goalRunId: string,
    limit = 100,
    stage?: GoalRunStage | undefined
  ): Array<{ id: string; artifact: StageHandoffArtifact }> {
    const statement = stage
      ? this.db.prepare(`
          SELECT * FROM goal_run_handoff_artifacts
          WHERE goal_run_id = ? AND stage = ?
          ORDER BY created_at ASC
          LIMIT ?
        `)
      : this.db.prepare(`
          SELECT * FROM goal_run_handoff_artifacts
          WHERE goal_run_id = ?
          ORDER BY created_at ASC
          LIMIT ?
        `);
    const rows = (
      stage
        ? statement.all(goalRunId, stage, Math.max(1, Math.min(500, Math.round(limit))))
        : statement.all(goalRunId, Math.max(1, Math.min(500, Math.round(limit))))
    ) as JsonRow[];
    return rows.map((row) => ({
      id: String(row.id),
      artifact: toStageHandoffArtifact(row)
    }));
  }

  getLatestGoalRunHandoff(goalRunId: string, stage?: GoalRunStage | undefined): { id: string; artifact: StageHandoffArtifact } | undefined {
    const row = stage
      ? (this.db
          .prepare(`
            SELECT * FROM goal_run_handoff_artifacts
            WHERE goal_run_id = ? AND stage = ?
            ORDER BY created_at DESC
            LIMIT 1
          `)
          .get(goalRunId, stage) as JsonRow | undefined)
      : (this.db
          .prepare(`
            SELECT * FROM goal_run_handoff_artifacts
            WHERE goal_run_id = ?
            ORDER BY created_at DESC
            LIMIT 1
          `)
          .get(goalRunId) as JsonRow | undefined);
    if (!row) {
      return undefined;
    }
    return {
      id: String(row.id),
      artifact: toStageHandoffArtifact(row)
    };
  }

  appendGoalRunTrace(input: {
    goalRunId: string;
    stage: GoalRunStage;
    status: GoalRunTraceRecord["status"];
    taskId?: string | undefined;
    taskTraceId?: string | undefined;
    inputSummary?: string | undefined;
    outputSummary?: string | undefined;
    artifactFiles?: string[] | undefined;
    completedRoles?: RoleId[] | undefined;
    failedRoles?: RoleId[] | undefined;
    approvalGateHits?: number | undefined;
    failureCategory?: string | undefined;
    handoffArtifactId?: string | undefined;
    metadata?: Record<string, unknown> | undefined;
  }): GoalRunTraceRecord {
    const id = randomUUID();
    const timestamp = now();
    this.db
      .prepare(`
        INSERT INTO goal_run_traces (
          id, goal_run_id, stage, status, task_id, task_trace_id, input_summary, output_summary,
          artifact_files_json, completed_roles_json, failed_roles_json, approval_gate_hits,
          failure_category, handoff_artifact_id, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        input.goalRunId,
        input.stage,
        input.status,
        input.taskId ?? null,
        input.taskTraceId ?? null,
        input.inputSummary ?? "",
        input.outputSummary ?? "",
        jsonStringify(input.artifactFiles ?? []),
        jsonStringify(input.completedRoles ?? []),
        jsonStringify(input.failedRoles ?? []),
        Math.max(0, Math.round(input.approvalGateHits ?? 0)),
        input.failureCategory ?? null,
        input.handoffArtifactId ?? null,
        jsonStringify(input.metadata ?? {}),
        timestamp
      );
    const row = this.db
      .prepare("SELECT * FROM goal_run_traces WHERE id = ?")
      .get(id) as JsonRow | undefined;
    if (!row) {
      throw new Error(`Goal run trace ${id} was created but could not be loaded`);
    }
    return toGoalRunTraceRecord(row);
  }

  listGoalRunTraces(goalRunId: string, limit = 200): GoalRunTraceRecord[] {
    const rows = this.db
      .prepare(`
        SELECT * FROM goal_run_traces
        WHERE goal_run_id = ?
        ORDER BY created_at ASC
        LIMIT ?
      `)
      .all(goalRunId, Math.max(1, Math.min(1000, Math.round(limit)))) as JsonRow[];
    return rows.map(toGoalRunTraceRecord);
  }

  upsertGoalRunInput(input: {
    goalRunId: string;
    inputKey: string;
    value: unknown;
    createdBy?: string | undefined;
  }): GoalRunInputRecord {
    const key = input.inputKey.trim();
    if (!key) {
      throw new Error("goal run input key is required");
    }
    const existing = this.db
      .prepare("SELECT id FROM goal_run_inputs WHERE goal_run_id = ? AND input_key = ?")
      .get(input.goalRunId, key) as JsonRow | undefined;
    const timestamp = now();
    const id = existing ? String(existing.id) : randomUUID();
    this.db
      .prepare(`
        INSERT INTO goal_run_inputs (
          id, goal_run_id, input_key, value_json, created_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(goal_run_id, input_key)
        DO UPDATE SET value_json = excluded.value_json, created_by = excluded.created_by, created_at = excluded.created_at
      `)
      .run(id, input.goalRunId, key, jsonStringify(input.value), input.createdBy ?? null, timestamp);
    const row = this.db
      .prepare("SELECT * FROM goal_run_inputs WHERE id = ?")
      .get(id) as JsonRow | undefined;
    if (!row) {
      throw new Error(`Goal run input ${id} was upserted but could not be loaded`);
    }
    return toGoalRunInputRecord(row);
  }

  listGoalRunInputs(goalRunId: string): GoalRunInputRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM goal_run_inputs WHERE goal_run_id = ? ORDER BY created_at ASC")
      .all(goalRunId) as JsonRow[];
    return rows.map(toGoalRunInputRecord);
  }

  getGoalRunInputMap(goalRunId: string): Record<string, unknown> {
    const map: Record<string, unknown> = {};
    for (const item of this.listGoalRunInputs(goalRunId)) {
      map[item.inputKey] = item.value;
    }
    return map;
  }

  createRunAuthToken(input: CreateRunAuthTokenInput): RunAuthTokenRecord {
    const id = randomUUID();
    const token = randomUUID().replace(/-/g, "");
    const ttlCandidate = Number(input.ttlMs ?? 15 * 60 * 1000);
    const ttlMs = Number.isFinite(ttlCandidate) ? Math.max(30_000, Math.min(24 * 60 * 60 * 1000, Math.round(ttlCandidate))) : 15 * 60 * 1000;
    const timestamp = now();
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    this.db
      .prepare(`
        INSERT INTO run_auth_tokens (
          id, goal_run_id, token, scope, status, reason, expires_at, used_by, used_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'active', ?, ?, NULL, NULL, ?, ?)
      `)
      .run(id, input.goalRunId, token, input.scope.trim() || "general", input.reason ?? null, expiresAt, timestamp, timestamp);
    const row = this.db
      .prepare("SELECT * FROM run_auth_tokens WHERE id = ?")
      .get(id) as JsonRow | undefined;
    if (!row) {
      throw new Error(`Run auth token ${id} was created but could not be loaded`);
    }
    return toRunAuthTokenRecord(row);
  }

  getRunAuthTokenByToken(token: string): RunAuthTokenRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM run_auth_tokens WHERE token = ?")
      .get(token) as JsonRow | undefined;
    return row ? toRunAuthTokenRecord(row) : undefined;
  }

  listRunAuthTokens(goalRunId: string, limit = 20): RunAuthTokenRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM run_auth_tokens WHERE goal_run_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(goalRunId, Math.max(1, Math.min(200, Math.round(limit)))) as JsonRow[];
    return rows.map(toRunAuthTokenRecord);
  }

  consumeRunAuthToken(input: {
    token: string;
    goalRunId?: string | undefined;
    scope?: string | undefined;
    usedBy?: string | undefined;
  }): RunAuthTokenRecord | undefined {
    const record = this.getRunAuthTokenByToken(input.token);
    if (!record) {
      return undefined;
    }
    const nowMs = Date.now();
    const expiresAtMs = Date.parse(record.expiresAt);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) {
      this.db
        .prepare("UPDATE run_auth_tokens SET status = 'expired', updated_at = ? WHERE id = ?")
        .run(now(), record.id);
      return undefined;
    }
    if (record.status !== "active") {
      return undefined;
    }
    if (input.goalRunId && record.goalRunId !== input.goalRunId) {
      return undefined;
    }
    if (input.scope && record.scope !== input.scope) {
      return undefined;
    }
    const timestamp = now();
    this.db
      .prepare(`
        UPDATE run_auth_tokens
        SET status = 'used', used_by = ?, used_at = ?, updated_at = ?
        WHERE id = ? AND status = 'active'
      `)
      .run(input.usedBy ?? null, timestamp, timestamp, record.id);
    return this.getRunAuthTokenByToken(input.token);
  }

  revokeRunAuthTokens(goalRunId: string, reason?: string): number {
    const timestamp = now();
    const result = this.db
      .prepare(`
        UPDATE run_auth_tokens
        SET status = 'revoked', reason = COALESCE(?, reason), updated_at = ?
        WHERE goal_run_id = ? AND status = 'active'
      `)
      .run(reason ?? null, timestamp, goalRunId);
    return Number(result.changes);
  }

  claimNextQueuedTask(): TaskRecord | undefined {
    const row = this.db
      .prepare(`
        SELECT id
        FROM tasks
        WHERE status = 'queued'
        ORDER BY
          (
            priority
            + CAST(
                ((julianday('now') - julianday(created_at)) * 24 * 60) / 10
                AS INTEGER
              )
          ) DESC,
          priority DESC,
          created_at ASC
        LIMIT 1
      `)
      .get() as JsonRow | undefined;

    if (!row) {
      return undefined;
    }

    const timestamp = now();
    const result = this.db
      .prepare(`
        UPDATE tasks
        SET status = 'running', started_at = ?, updated_at = ?
        WHERE id = ? AND status = 'queued'
      `)
      .run(timestamp, timestamp, String(row.id));

    if (result.changes === 0) {
      return undefined;
    }

    const task = this.getTask(String(row.id));
    if (!task) {
      return undefined;
    }

    this.appendAuditEvent({
      category: "task",
      entityType: "task",
      entityId: task.id,
      message: `Claimed task ${task.title}`,
      payload: {
        status: "running"
      }
    });

    return task;
  }

  completeTask(taskId: string, result: TaskResult, reflection: ReflectionNote): TaskRecord | undefined {
    const timestamp = now();
    this.db
      .prepare(`
        UPDATE tasks
        SET status = 'completed',
            result_json = ?,
            reflection_json = ?,
            completed_at = ?,
            updated_at = ?
        WHERE id = ?
      `)
      .run(jsonStringify(result), jsonStringify(reflection), timestamp, timestamp, taskId);

    this.appendAuditEvent({
      category: "task",
      entityType: "task",
      entityId: taskId,
      message: "Completed task",
      payload: {
        summary: result.summary,
        score: reflection.score
      }
    });

    return this.getTask(taskId);
  }

  failTask(taskId: string, errorText: string): TaskRecord | undefined {
    const timestamp = now();
    this.db
      .prepare(`
        UPDATE tasks
        SET status = 'failed',
            error_text = ?,
            completed_at = ?,
            updated_at = ?
        WHERE id = ?
      `)
      .run(errorText, timestamp, timestamp, taskId);

    this.appendAuditEvent({
      category: "task",
      entityType: "task",
      entityId: taskId,
      message: "Failed task",
      payload: {
        errorText
      }
    });

    return this.getTask(taskId);
  }

  pauseTask(taskId: string, input: { question: string; context?: string | undefined }): TaskRecord | undefined {
    const timestamp = now();
    const task = this.getTask(taskId);
    if (!task || !task.pendingInput) {
      this.db
        .prepare(`
          UPDATE tasks
          SET status = 'paused_input',
              pending_input_json = ?,
              updated_at = ?
          WHERE id = ? AND status IN ('running')
        `)
        .run(jsonStringify({ question: input.question, pausedAt: timestamp, context: input.context ?? null }), timestamp, taskId);
    }

    this.appendAuditEvent({
      category: "task",
      entityType: "task",
      entityId: taskId,
      message: "Paused task awaiting user input",
      payload: {
        question: input.question
      }
    });

    return this.getTask(taskId);
  }

  resumeTask(taskId: string, updatedInstruction?: string): TaskRecord | undefined {
    const timestamp = now();
    this.db
      .prepare(`
        UPDATE tasks
        SET status = 'running',
            instruction = COALESCE(?, instruction),
            pending_input_json = NULL,
            updated_at = ?
        WHERE id = ? AND status = 'paused_input'
      `)
      .run(updatedInstruction ?? null, timestamp, taskId);

    this.appendAuditEvent({
      category: "task",
      entityType: "task",
      entityId: taskId,
      message: "Resumed task from paused_input",
      payload: {
        instructionUpdated: Boolean(updatedInstruction)
      }
    });

    return this.getTask(taskId);
  }

  getPausedTask(source: TaskRecord["source"], requestedBy?: string | undefined, chatId?: string | undefined): TaskRecord | undefined {
    const task = this.db
      .prepare(`
        SELECT * FROM tasks
        WHERE status = 'paused_input'
          AND source = ?
          ${requestedBy ? "AND requested_by = ?" : ""}
        ORDER BY updated_at DESC
        LIMIT 1
      `)
      .get(source, ...(requestedBy ? [requestedBy] : [])) as JsonRow | undefined;

    if (!task) {
      return undefined;
    }

    const record = toTaskRecord(task);
    if (chatId && record.chatId !== chatId) {
      return undefined;
    }

    return record;
  }

  cancelTask(taskId: string, reasonText?: string): TaskRecord | undefined {
    const timestamp = now();
    const result = this.db
      .prepare(`
        UPDATE tasks
        SET status = 'cancelled',
            error_text = COALESCE(?, error_text),
            pending_input_json = NULL,
            completed_at = COALESCE(completed_at, ?),
            updated_at = ?
        WHERE id = ? AND status IN ('queued', 'running', 'waiting_approval', 'paused_input')
      `)
      .run(reasonText ?? null, timestamp, timestamp, taskId);

    if (result.changes === 0) {
      return undefined;
    }

    this.appendAuditEvent({
      category: "task",
      entityType: "task",
      entityId: taskId,
      message: "Cancelled task",
      payload: {
        reasonText: reasonText ?? ""
      }
    });

    return this.getTask(taskId);
  }

  markTaskWaitingApproval(taskId: string, reasonText?: string): TaskRecord | undefined {
    const timestamp = now();
    this.db
      .prepare(`
        UPDATE tasks
        SET status = 'waiting_approval',
            started_at = NULL,
            error_text = COALESCE(?, error_text),
            updated_at = ?
        WHERE id = ?
      `)
      .run(reasonText ?? null, timestamp, taskId);

    this.appendAuditEvent({
      category: "task",
      entityType: "task",
      entityId: taskId,
      message: "Task is waiting for approval",
      payload: {
        reasonText: reasonText ?? ""
      }
    });

    return this.getTask(taskId);
  }

  requeueTask(taskId: string): TaskRecord | undefined {
    const timestamp = now();
    this.db
      .prepare(`
        UPDATE tasks
        SET status = 'queued',
            started_at = NULL,
            completed_at = NULL,
            error_text = NULL,
            updated_at = ?
        WHERE id = ?
      `)
      .run(timestamp, taskId);

    this.appendAuditEvent({
      category: "task",
      entityType: "task",
      entityId: taskId,
      message: "Requeued task",
      payload: {}
    });

    return this.getTask(taskId);
  }

  patchTaskMetadata(taskId: string, patch: Record<string, unknown>): TaskRecord | undefined {
    const task = this.getTask(taskId);
    if (!task) {
      return undefined;
    }
    const merged = {
      ...(task.metadata ?? {}),
      ...patch
    };
    const timestamp = now();
    this.db
      .prepare(`
        UPDATE tasks
        SET metadata_json = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(jsonStringify(merged), timestamp, taskId);
    return this.getTask(taskId);
  }

  patchTaskRole(taskId: string, roleId: string): TaskRecord | undefined {
    try {
      const result = this.db
        .prepare(`UPDATE tasks SET role_id = ?, updated_at = ? WHERE id = ?`)
        .run(roleId, now(), taskId);
      if (result.changes > 0) {
        return this.getTask(taskId);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
      if (!message.includes("database is locked")) {
        throw error;
      }
    }
    return undefined;
  }

  touchRunningTask(taskId: string, when: string = now()): TaskRecord | undefined {
    try {
      this.db
        .prepare(`
          UPDATE tasks
          SET updated_at = ?
          WHERE id = ? AND status = 'running'
        `)
        .run(when, taskId);
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
      if (message.includes("database is locked")) {
        return this.getTask(taskId);
      }
      throw error;
    }
    return this.getTask(taskId);
  }

  recoverStaleRunningTasks(input?: {
    staleAfterMs?: number | undefined;
    mode?: "requeue" | "fail" | undefined;
    failReason?: string | undefined;
  }): {
    scanned: number;
    recovered: number;
    mode: "requeue" | "fail";
    staleAfterMs: number;
    taskIds: string[];
  } {
    const staleAfterMsCandidate = Number(input?.staleAfterMs ?? 20 * 60 * 1000);
    const staleAfterMs = Number.isFinite(staleAfterMsCandidate)
      ? Math.max(1_000, Math.round(staleAfterMsCandidate))
      : 20 * 60 * 1000;
    const mode = input?.mode === "fail" ? "fail" : "requeue";
    const failReason = (input?.failReason ?? "Recovered stale running task").trim();

    const rows = this.db
      .prepare(`
        SELECT id, updated_at
        FROM tasks
        WHERE status = 'running'
        ORDER BY updated_at ASC
      `)
      .all() as JsonRow[];
    const nowMs = Date.now();
    const staleIds: string[] = [];
    for (const row of rows) {
      const id = String(row.id ?? "").trim();
      const updatedAt = String(row.updated_at ?? "").trim();
      if (!id || !updatedAt) {
        continue;
      }
      const updatedMs = new Date(updatedAt).getTime();
      if (!Number.isFinite(updatedMs)) {
        continue;
      }
      if (nowMs - updatedMs >= staleAfterMs) {
        staleIds.push(id);
      }
    }

    for (const taskId of staleIds) {
      if (mode === "fail") {
        this.failTask(taskId, failReason);
      } else {
        this.requeueTask(taskId);
      }
    }

    if (staleIds.length > 0) {
      this.appendAuditEvent({
        category: "task",
        entityType: "queue_recovery",
        entityId: "stale_running_recovery",
        message: "Recovered stale running tasks",
        payload: {
          recovered: staleIds.length,
          mode,
          staleAfterMs
        }
      });
    }

    return {
      scanned: rows.length,
      recovered: staleIds.length,
      mode,
      staleAfterMs,
      taskIds: staleIds
    };
  }

  createToolRun(input: CreateToolRunInput): ToolRunRecord {
    const toolRunId = randomUUID();
    const timestamp = now();

    this.db
      .prepare(`
        INSERT INTO tool_runs (
          id, task_id, role_id, provider_id, title, instruction, command, args_json,
          risk_level, status, approval_status, requested_by, approved_by, approval_id,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
      `)
      .run(
        toolRunId,
        input.taskId,
        input.roleId,
        input.providerId,
        input.title,
        input.instruction,
        input.command,
        jsonStringify(input.args),
        input.riskLevel,
        input.status ?? "queued",
        input.approvalStatus ?? "not_required",
        input.requestedBy ?? null,
        input.approvalId ?? null,
        timestamp,
        timestamp
      );

    this.appendAuditEvent({
      category: "tool-run",
      entityType: "tool_run",
      entityId: toolRunId,
      message: `Created tool run ${input.providerId}`,
      payload: {
        taskId: input.taskId,
        riskLevel: input.riskLevel,
        status: input.status ?? "queued"
      }
    });

    const record = this.getToolRun(toolRunId);
    if (!record) {
      throw new Error(`Tool run ${toolRunId} was created but could not be loaded`);
    }

    return record;
  }

  getToolRun(toolRunId: string): ToolRunRecord | undefined {
    const row = this.db.prepare("SELECT * FROM tool_runs WHERE id = ?").get(toolRunId) as JsonRow | undefined;
    return row ? toToolRunRecord(row) : undefined;
  }

  listToolRuns(limit = 100): ToolRunRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM tool_runs ORDER BY updated_at DESC LIMIT ?")
      .all(limit) as JsonRow[];
    return rows.map(toToolRunRecord);
  }

  listToolRunsByTask(taskId: string): ToolRunRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM tool_runs WHERE task_id = ? ORDER BY created_at DESC")
      .all(taskId) as JsonRow[];
    return rows.map(toToolRunRecord);
  }

  getQueuedExecutableToolRunForTask(taskId: string): ToolRunRecord | undefined {
    const row = this.db
      .prepare(`
        SELECT *
        FROM tool_runs
        WHERE task_id = ?
          AND status = 'queued'
          AND approval_status IN ('approved', 'auto_approved', 'not_required')
        ORDER BY updated_at DESC
        LIMIT 1
      `)
      .get(taskId) as JsonRow | undefined;
    return row ? toToolRunRecord(row) : undefined;
  }

  markToolRunApprovalPending(toolRunId: string, approvalId: string): ToolRunRecord | undefined {
    const timestamp = now();
    this.db
      .prepare(`
        UPDATE tool_runs
        SET status = 'approval_pending',
            approval_status = 'pending',
            approval_id = ?,
            updated_at = ?
        WHERE id = ?
      `)
      .run(approvalId, timestamp, toolRunId);

    return this.getToolRun(toolRunId);
  }

  markToolRunAutoApproved(toolRunId: string, approvedBy: string): ToolRunRecord | undefined {
    const timestamp = now();
    this.db
      .prepare(`
        UPDATE tool_runs
        SET approval_status = 'auto_approved',
            approved_by = ?,
            status = 'queued',
            updated_at = ?
        WHERE id = ?
      `)
      .run(approvedBy, timestamp, toolRunId);
    return this.getToolRun(toolRunId);
  }

  approveToolRunByApproval(approvalId: string, approvedBy: string): ToolRunRecord | undefined {
    const timestamp = now();
    this.db
      .prepare(`
        UPDATE tool_runs
        SET approval_status = 'approved',
            approved_by = ?,
            status = 'queued',
            updated_at = ?
        WHERE approval_id = ?
      `)
      .run(approvedBy, timestamp, approvalId);

    const row = this.db
      .prepare("SELECT * FROM tool_runs WHERE approval_id = ? ORDER BY updated_at DESC LIMIT 1")
      .get(approvalId) as JsonRow | undefined;
    return row ? toToolRunRecord(row) : undefined;
  }

  rejectToolRunByApproval(approvalId: string, decidedBy: string, note?: string): ToolRunRecord | undefined {
    const timestamp = now();
    this.db
      .prepare(`
        UPDATE tool_runs
        SET approval_status = 'rejected',
            approved_by = ?,
            status = 'blocked',
            error_text = COALESCE(?, error_text),
            completed_at = ?,
            updated_at = ?
        WHERE approval_id = ?
      `)
      .run(decidedBy, note ?? null, timestamp, timestamp, approvalId);

    const row = this.db
      .prepare("SELECT * FROM tool_runs WHERE approval_id = ? ORDER BY updated_at DESC LIMIT 1")
      .get(approvalId) as JsonRow | undefined;
    return row ? toToolRunRecord(row) : undefined;
  }

  startToolRun(toolRunId: string): ToolRunRecord | undefined {
    const timestamp = now();
    this.db
      .prepare(`
        UPDATE tool_runs
        SET status = 'running',
            started_at = ?,
            updated_at = ?
        WHERE id = ?
      `)
      .run(timestamp, timestamp, toolRunId);
    return this.getToolRun(toolRunId);
  }

  completeToolRun(toolRunId: string, outputText: string): ToolRunRecord | undefined {
    const timestamp = now();
    this.db
      .prepare(`
        UPDATE tool_runs
        SET status = 'completed',
            output_text = ?,
            error_text = NULL,
            completed_at = ?,
            updated_at = ?
        WHERE id = ?
      `)
      .run(outputText, timestamp, timestamp, toolRunId);

    return this.getToolRun(toolRunId);
  }

  failToolRun(toolRunId: string, errorText: string): ToolRunRecord | undefined {
    const timestamp = now();
    this.db
      .prepare(`
        UPDATE tool_runs
        SET status = 'failed',
            error_text = ?,
            completed_at = ?,
            updated_at = ?
        WHERE id = ?
      `)
      .run(errorText, timestamp, timestamp, toolRunId);

    return this.getToolRun(toolRunId);
  }

  appendApprovalEvent(input: {
    approvalId: string;
    eventType: ApprovalEventRecord["eventType"];
    actor?: string | undefined;
    note?: string | undefined;
    payload?: Record<string, unknown> | undefined;
  }): ApprovalEventRecord {
    const eventId = randomUUID();
    const timestamp = now();
    this.db
      .prepare(`
        INSERT INTO approval_events (
          id, approval_id, event_type, actor, note, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        eventId,
        input.approvalId,
        input.eventType,
        input.actor ?? null,
        input.note ?? null,
        jsonStringify(input.payload ?? {}),
        timestamp
      );

    return {
      id: eventId,
      approvalId: input.approvalId,
      eventType: input.eventType,
      actor: input.actor,
      note: input.note,
      payload: input.payload ?? {},
      createdAt: timestamp
    };
  }

  listApprovalEvents(approvalId: string): ApprovalEventRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM approval_events WHERE approval_id = ? ORDER BY created_at ASC")
      .all(approvalId) as JsonRow[];
    return rows.map(toApprovalEventRecord);
  }

  getApprovalWorkflowByApprovalId(approvalId: string): ApprovalWorkflowRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM approval_workflows WHERE approval_id = ?")
      .get(approvalId) as JsonRow | undefined;
    return row ? toApprovalWorkflowRecord(row) : undefined;
  }

  getApprovalWorkflow(workflowId: string): ApprovalWorkflowRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM approval_workflows WHERE id = ?")
      .get(workflowId) as JsonRow | undefined;
    return row ? toApprovalWorkflowRecord(row) : undefined;
  }

  listApprovalWorkflowSteps(workflowId: string): ApprovalWorkflowStepRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM approval_workflow_steps WHERE workflow_id = ? ORDER BY step_index ASC")
      .all(workflowId) as JsonRow[];
    return rows.map(toApprovalWorkflowStepRecord);
  }

  ensureApprovalWorkflow(
    approvalId: string,
    levels: RoleId[] = ["ceo"]
  ): { workflow: ApprovalWorkflowRecord; steps: ApprovalWorkflowStepRecord[] } {
    const existing = this.getApprovalWorkflowByApprovalId(approvalId);
    if (existing) {
      return {
        workflow: existing,
        steps: this.listApprovalWorkflowSteps(existing.id)
      };
    }

    const normalizedLevels = levels.length > 0 ? levels : ["ceo"];
    const workflowId = randomUUID();
    const timestamp = now();
    this.db
      .prepare(`
        INSERT INTO approval_workflows (
          id, approval_id, status, current_step_index, created_at, updated_at
        ) VALUES (?, ?, 'in_review', 0, ?, ?)
      `)
      .run(workflowId, approvalId, timestamp, timestamp);

    const insertStep = this.db.prepare(`
      INSERT INTO approval_workflow_steps (
        id, workflow_id, step_index, role_id, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'pending', ?, ?)
    `);
    normalizedLevels.forEach((roleId, index) => {
      insertStep.run(randomUUID(), workflowId, index, roleId, timestamp, timestamp);
    });

    const workflow = this.getApprovalWorkflow(workflowId);
    if (!workflow) {
      throw new Error(`Approval workflow for ${approvalId} was created but could not be loaded`);
    }
    return {
      workflow,
      steps: this.listApprovalWorkflowSteps(workflow.id)
    };
  }

  getPendingApprovalWorkflowStep(
    approvalId: string
  ): { workflow: ApprovalWorkflowRecord; step: ApprovalWorkflowStepRecord } | undefined {
    const workflow = this.getApprovalWorkflowByApprovalId(approvalId);
    if (!workflow) {
      return undefined;
    }
    const row = this.db
      .prepare(`
        SELECT * FROM approval_workflow_steps
        WHERE workflow_id = ? AND status = 'pending'
        ORDER BY step_index ASC
        LIMIT 1
      `)
      .get(workflow.id) as JsonRow | undefined;
    if (!row) {
      return undefined;
    }
    return {
      workflow,
      step: toApprovalWorkflowStepRecord(row)
    };
  }

  decideApprovalWorkflowStep(input: {
    approvalId: string;
    stepId: string;
    status: "approved" | "rejected";
    decidedBy: string;
    decisionNote?: string | undefined;
  }): {
    workflow: ApprovalWorkflowRecord;
    step: ApprovalWorkflowStepRecord;
    approval: ApprovalRecord | undefined;
  } {
    const workflow = this.getApprovalWorkflowByApprovalId(input.approvalId);
    if (!workflow) {
      throw new Error(`Approval workflow not found for ${input.approvalId}`);
    }

    const currentStepRow = this.db
      .prepare("SELECT * FROM approval_workflow_steps WHERE id = ? AND workflow_id = ?")
      .get(input.stepId, workflow.id) as JsonRow | undefined;
    if (!currentStepRow) {
      throw new Error(`Approval workflow step ${input.stepId} not found`);
    }
    const currentStep = toApprovalWorkflowStepRecord(currentStepRow);
    if (currentStep.status !== "pending") {
      throw new Error(`Approval workflow step ${input.stepId} is not pending`);
    }

    const timestamp = now();
    this.db
      .prepare(`
        UPDATE approval_workflow_steps
        SET status = ?, decided_by = ?, decision_note = ?, decided_at = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(input.status, input.decidedBy, input.decisionNote ?? null, timestamp, timestamp, input.stepId);

    let nextWorkflowStatus: ApprovalWorkflowRecord["status"] = workflow.status;
    let nextStepIndex = workflow.currentStepIndex;

    if (input.status === "rejected") {
      nextWorkflowStatus = "rejected";
      nextStepIndex = currentStep.stepIndex;
      this.decideApproval(input.approvalId, {
        status: "rejected",
        decidedBy: input.decidedBy,
        decisionNote: input.decisionNote
      });
    } else {
      const nextPending = this.db
        .prepare(`
          SELECT * FROM approval_workflow_steps
          WHERE workflow_id = ? AND status = 'pending' AND step_index > ?
          ORDER BY step_index ASC
          LIMIT 1
        `)
        .get(workflow.id, currentStep.stepIndex) as JsonRow | undefined;
      if (nextPending) {
        nextWorkflowStatus = "in_review";
        nextStepIndex = Number(nextPending.step_index);
      } else {
        nextWorkflowStatus = "approved";
        nextStepIndex = currentStep.stepIndex;
        this.decideApproval(input.approvalId, {
          status: "approved",
          decidedBy: input.decidedBy,
          decisionNote: input.decisionNote
        });
      }
    }

    this.db
      .prepare(`
        UPDATE approval_workflows
        SET status = ?, current_step_index = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(nextWorkflowStatus, nextStepIndex, timestamp, workflow.id);

    const nextWorkflow = this.getApprovalWorkflow(workflow.id);
    const nextStep = this.db
      .prepare("SELECT * FROM approval_workflow_steps WHERE id = ?")
      .get(input.stepId) as JsonRow | undefined;
    if (!nextWorkflow || !nextStep) {
      throw new Error(`Approval workflow decision result could not be loaded`);
    }
    return {
      workflow: nextWorkflow,
      step: toApprovalWorkflowStepRecord(nextStep),
      approval: this.getApproval(input.approvalId)
    };
  }

  escalateApprovalWorkflow(input: {
    approvalId: string;
    roleId: RoleId;
    requestedBy?: string | undefined;
    note?: string | undefined;
  }): { workflow: ApprovalWorkflowRecord; step: ApprovalWorkflowStepRecord } {
    const ensured = this.ensureApprovalWorkflow(input.approvalId, [input.roleId]);
    const workflow = ensured.workflow;
    const lastIndex = ensured.steps.length === 0 ? -1 : ensured.steps[ensured.steps.length - 1]!.stepIndex;
    const nextIndex = lastIndex + 1;
    const stepId = randomUUID();
    const timestamp = now();
    this.db
      .prepare(`
        INSERT INTO approval_workflow_steps (
          id, workflow_id, step_index, role_id, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'pending', ?, ?)
      `)
      .run(stepId, workflow.id, nextIndex, input.roleId, timestamp, timestamp);

    this.db
      .prepare(`
        UPDATE approval_workflows
        SET status = 'escalated', current_step_index = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(nextIndex, timestamp, workflow.id);

    this.appendApprovalEvent({
      approvalId: input.approvalId,
      eventType: "created",
      actor: input.requestedBy,
      note: input.note ?? `Escalated to ${input.roleId}`,
      payload: {
        escalationRoleId: input.roleId
      }
    });

    const nextWorkflow = this.getApprovalWorkflow(workflow.id);
    const nextStep = this.db
      .prepare("SELECT * FROM approval_workflow_steps WHERE id = ?")
      .get(stepId) as JsonRow | undefined;
    if (!nextWorkflow || !nextStep) {
      throw new Error(`Escalated approval workflow could not be loaded`);
    }
    return {
      workflow: nextWorkflow,
      step: toApprovalWorkflowStepRecord(nextStep)
    };
  }

  createApproval(input: CreateApprovalInput): ApprovalRecord {
    const approvalId = randomUUID();
    const timestamp = now();
    this.db
      .prepare(`
        INSERT INTO approvals (
          id, kind, task_id, operator_action_id, summary, payload_json, status,
          requested_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
      `)
      .run(
        approvalId,
        input.kind,
        input.taskId ?? null,
        input.operatorActionId ?? null,
        input.summary,
        jsonStringify(input.payload),
        input.requestedBy ?? null,
        timestamp,
        timestamp
      );

    this.appendApprovalEvent({
      approvalId,
      eventType: "created",
      actor: input.requestedBy,
      note: input.summary,
      payload: input.payload
    });

    this.appendAuditEvent({
      category: "approval",
      entityType: "approval",
      entityId: approvalId,
      message: `Created approval for ${input.kind}`,
      payload: {
        summary: input.summary
      }
    });

    const approval = this.getApproval(approvalId);
    if (!approval) {
      throw new Error(`Approval ${approvalId} was created but could not be loaded`);
    }

    return approval;
  }

  getApproval(approvalId: string): ApprovalRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM approvals WHERE id = ?")
      .get(approvalId) as JsonRow | undefined;
    return row ? toApprovalRecord(row) : undefined;
  }

  listApprovals(limit = 50): ApprovalRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM approvals ORDER BY updated_at DESC LIMIT ?")
      .all(limit) as JsonRow[];
    return rows.map(toApprovalRecord);
  }

  decideApproval(approvalId: string, input: ApprovalDecisionInput): ApprovalRecord | undefined {
    const timestamp = now();
    this.db
      .prepare(`
        UPDATE approvals
        SET status = ?, decided_by = ?, decision_note = ?, decided_at = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(input.status, input.decidedBy, input.decisionNote ?? null, timestamp, timestamp, approvalId);

    this.appendApprovalEvent({
      approvalId,
      eventType: input.status,
      actor: input.decidedBy,
      note: input.decisionNote,
      payload: {}
    });

    this.appendAuditEvent({
      category: "approval",
      entityType: "approval",
      entityId: approvalId,
      message: `Approval ${input.status}`,
      payload: {
        decidedBy: input.decidedBy,
        decisionNote: input.decisionNote ?? ""
      }
    });

    return this.getApproval(approvalId);
  }

  createOperatorAction(input: CreateOperatorActionInput): OperatorActionRecord {
    const actionId = randomUUID();
    const timestamp = now();
    this.db
      .prepare(`
        INSERT INTO operator_actions (
          id, kind, target_role_id, skill_id, summary, payload_json, status, created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
      `)
      .run(
        actionId,
        input.kind,
        input.targetRoleId ?? null,
        input.skillId ?? null,
        input.summary,
        jsonStringify(input.payload),
        input.createdBy ?? null,
        timestamp,
        timestamp
      );

    this.appendAuditEvent({
      category: "operator-action",
      entityType: "operator_action",
      entityId: actionId,
      message: `Created operator action ${input.kind}`,
      payload: {
        summary: input.summary
      }
    });

    const action = this.getOperatorAction(actionId);
    if (!action) {
      throw new Error(`Operator action ${actionId} was created but could not be loaded`);
    }

    return action;
  }

  getOperatorAction(actionId: string): OperatorActionRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM operator_actions WHERE id = ?")
      .get(actionId) as JsonRow | undefined;
    return row ? toOperatorActionRecord(row) : undefined;
  }

  listOperatorActions(limit = 50): OperatorActionRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM operator_actions ORDER BY updated_at DESC LIMIT ?")
      .all(limit) as JsonRow[];
    return rows.map(toOperatorActionRecord);
  }

  attachApprovalToOperatorAction(actionId: string, approvalId: string): void {
    const timestamp = now();
    this.db
      .prepare(`
        UPDATE operator_actions
        SET approval_id = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(approvalId, timestamp, actionId);
  }

  markOperatorActionStatus(
    actionId: string,
    status: OperatorActionRecord["status"],
    executedAt?: string
  ): OperatorActionRecord | undefined {
    const timestamp = now();
    this.db
      .prepare(`
        UPDATE operator_actions
        SET status = ?, updated_at = ?, executed_at = COALESCE(?, executed_at)
        WHERE id = ?
      `)
      .run(status, timestamp, executedAt ?? null, actionId);
    return this.getOperatorAction(actionId);
  }

  listSkillBindings(scopeId?: string): SkillBindingRecord[] {
    const rows = scopeId
      ? (this.db
          .prepare(`
            SELECT * FROM skill_bindings
            WHERE scope_id = ?
            ORDER BY scope ASC, scope_id ASC, skill_id ASC
          `)
          .all(scopeId) as JsonRow[])
      : (this.db
          .prepare(`
            SELECT * FROM skill_bindings
            ORDER BY scope ASC, scope_id ASC, skill_id ASC
          `)
          .all() as JsonRow[]);
    return rows.map(toSkillBindingRecord);
  }

  resolveSkillsForRole(roleId: RoleId): SkillBindingRecord[] {
    const rows = this.db
      .prepare(`
        SELECT * FROM skill_bindings
        WHERE status = 'enabled'
          AND (
            (scope = 'role' AND scope_id = ?)
            OR (scope = 'team' AND scope_id = 'team')
          )
        ORDER BY scope ASC, skill_id ASC
      `)
      .all(roleId) as JsonRow[];
    return rows.map(toSkillBindingRecord);
  }

  setSkillBinding(input: {
    scope: SkillBindingRecord["scope"];
    scopeId: string;
    skillId: string;
    status: SkillBindingRecord["status"];
    verificationStatus?: SkillBindingRecord["verificationStatus"];
    config?: Record<string, unknown> | undefined;
    installedBy?: string | undefined;
    installedAt?: string | undefined;
    verifiedAt?: string | undefined;
    lastVerifiedTaskId?: string | undefined;
    source?: string | undefined;
    sourceLabel?: string | undefined;
    sourceUrl?: string | undefined;
    version?: string | undefined;
  }): SkillBindingRecord {
    const timestamp = now();
    const installedAt = input.installedAt ?? timestamp;
    const verificationStatus = input.verificationStatus ?? "unverified";
    const existing = this.db
      .prepare("SELECT id FROM skill_bindings WHERE scope = ? AND scope_id = ? AND skill_id = ?")
      .get(input.scope, input.scopeId, input.skillId) as JsonRow | undefined;

    if (existing) {
      this.db
        .prepare(`
          UPDATE skill_bindings
          SET status = ?, verification_status = ?, config_json = ?, installed_by = ?, installed_at = ?, verified_at = ?, last_verified_task_id = ?, source = ?, source_label = ?, source_url = ?, version = ?, updated_at = ?
          WHERE id = ?
        `)
        .run(
          input.status,
          verificationStatus ?? null,
          jsonStringify(input.config ?? getSkillDefinition(input.skillId)?.defaultConfig ?? {}),
          input.installedBy ?? null,
          installedAt,
          input.verifiedAt ?? null,
          input.lastVerifiedTaskId ?? null,
          input.source ?? null,
          input.sourceLabel ?? null,
          input.sourceUrl ?? null,
          input.version ?? null,
          timestamp,
          String(existing.id)
        );
    } else {
      this.db
        .prepare(`
          INSERT INTO skill_bindings (
            id, scope, scope_id, skill_id, status, verification_status, config_json, installed_by, installed_at, verified_at, last_verified_task_id, source, source_label, source_url, version, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          randomUUID(),
          input.scope,
          input.scopeId,
          input.skillId,
          input.status,
          verificationStatus ?? null,
          jsonStringify(input.config ?? getSkillDefinition(input.skillId)?.defaultConfig ?? {}),
          input.installedBy ?? null,
          installedAt,
          input.verifiedAt ?? null,
          input.lastVerifiedTaskId ?? null,
          input.source ?? null,
          input.sourceLabel ?? null,
          input.sourceUrl ?? null,
          input.version ?? null,
          timestamp,
          timestamp
        );
    }

    this.appendAuditEvent({
      category: "skill",
      entityType: "skill_binding",
      entityId: `${input.scope}:${input.scopeId}:${input.skillId}`,
      message: `${input.status === "enabled" ? "Enabled" : "Disabled"} skill ${input.skillId}`,
      payload: {
        scope: input.scope,
        scopeId: input.scopeId,
        installedBy: input.installedBy ?? "",
        installedAt,
        verificationStatus: verificationStatus ?? "",
        verifiedAt: input.verifiedAt ?? "",
        lastVerifiedTaskId: input.lastVerifiedTaskId ?? "",
        source: input.source ?? "",
        sourceLabel: input.sourceLabel ?? "",
        sourceUrl: input.sourceUrl ?? "",
        version: input.version ?? ""
      }
    });

    const record = this.listSkillBindings(input.scopeId).find(
      (entry) =>
        entry.scope === input.scope &&
        entry.scopeId === input.scopeId &&
        entry.skillId === input.skillId
    );
    if (!record) {
      throw new Error(`Skill binding ${input.skillId} for ${input.scopeId} could not be loaded`);
    }

    return record;
  }

  updateSkillBindingVerification(input: {
    scopeId: string;
    skillId: string;
    verificationStatus: NonNullable<SkillBindingRecord["verificationStatus"]>;
    verifiedAt?: string | undefined;
    lastVerifiedTaskId?: string | undefined;
  }): SkillBindingRecord | undefined {
    const binding = this.listSkillBindings(input.scopeId).find(
      (entry) => entry.scope === "role" && entry.scopeId === input.scopeId && entry.skillId === input.skillId
    );
    if (!binding) {
      return undefined;
    }
    return this.setSkillBinding({
      scope: binding.scope,
      scopeId: binding.scopeId,
      skillId: binding.skillId,
      status: binding.status,
      verificationStatus: input.verificationStatus,
      config: binding.config,
      installedBy: binding.installedBy,
      installedAt: binding.installedAt,
      verifiedAt: input.verifiedAt,
      lastVerifiedTaskId: input.lastVerifiedTaskId,
      source: binding.source,
      sourceLabel: binding.sourceLabel,
      sourceUrl: binding.sourceUrl,
      version: binding.version
    });
  }

  applyOperatorAction(actionId: string, decidedBy: string): OperatorActionRecord | undefined {
    const action = this.getOperatorAction(actionId);
    if (!action) {
      throw new Error(`Operator action ${actionId} not found`);
    }

    switch (action.kind) {
      case "set_memory_backend": {
        const backend = action.payload.backend as RuntimeConfig["memory"]["defaultBackend"] | undefined;
        if (!backend || !action.targetRoleId) {
          throw new Error("Invalid set_memory_backend payload");
        }

        this.patchRuntimeConfig((config) => {
          config.memory.roleBackends[action.targetRoleId as RoleId] = backend;
          return config;
        });
        break;
      }
      case "install_skill": {
        if (!action.targetRoleId || !action.skillId) {
          throw new Error("Invalid install_skill payload");
        }

        if (!roleCanUseSkill(action.targetRoleId, action.skillId)) {
          throw new Error(`Role ${action.targetRoleId} cannot use skill ${action.skillId}`);
        }

        this.setSkillBinding({
          scope: "role",
          scopeId: action.targetRoleId,
          skillId: action.skillId,
          status: "enabled",
          verificationStatus: "unverified",
          config: action.payload.config as Record<string, unknown> | undefined,
          installedBy: decidedBy,
          source: typeof action.payload.source === "string" ? action.payload.source : "catalog",
          sourceLabel: typeof action.payload.sourceLabel === "string" ? action.payload.sourceLabel : "catalog",
          sourceUrl: typeof action.payload.sourceUrl === "string" ? action.payload.sourceUrl : undefined,
          version: typeof action.payload.version === "string" ? action.payload.version : undefined
        });
        break;
      }
      case "disable_skill": {
        if (!action.targetRoleId || !action.skillId) {
          throw new Error("Invalid disable_skill payload");
        }

        this.setSkillBinding({
          scope: "role",
          scopeId: action.targetRoleId,
          skillId: action.skillId,
          status: "disabled",
          verificationStatus: "unverified",
          config: action.payload.config as Record<string, unknown> | undefined,
          installedBy: decidedBy,
          source: typeof action.payload.source === "string" ? action.payload.source : undefined,
          sourceLabel: typeof action.payload.sourceLabel === "string" ? action.payload.sourceLabel : undefined,
          sourceUrl: typeof action.payload.sourceUrl === "string" ? action.payload.sourceUrl : undefined,
          version: typeof action.payload.version === "string" ? action.payload.version : undefined
        });
        break;
      }
      case "send_email":
        break;
      case "set_channel_enabled": {
        const channelRaw = String(action.payload.channel ?? "").trim().toLowerCase();
        const enabled = Boolean(action.payload.enabled);
        if (channelRaw !== "email" && channelRaw !== "feishu") {
          throw new Error("set_channel_enabled requires channel=email|feishu");
        }

        this.patchRuntimeConfig((config) => {
          if (channelRaw === "email") {
            config.channels.emailEnabled = enabled;
          } else {
            config.channels.feishuEnabled = enabled;
          }
          return config;
        });
        break;
      }
      case "set_tool_provider_config": {
        const providerIdRaw = String(action.payload.providerId ?? "opencode").trim().toLowerCase();
        const providerId =
          providerIdRaw === "opencode" || providerIdRaw === "codex" || providerIdRaw === "claude"
            ? providerIdRaw
            : undefined;
        if (!providerId) {
          throw new Error("Invalid tool provider id");
        }

        const modelId =
          typeof action.payload.modelId === "string" && action.payload.modelId.trim()
            ? action.payload.modelId.trim()
            : undefined;
        const baseUrl =
          typeof action.payload.baseUrl === "string" && action.payload.baseUrl.trim()
            ? action.payload.baseUrl.trim()
            : undefined;
        const apiKey =
          typeof action.payload.apiKey === "string" && action.payload.apiKey.trim()
            ? action.payload.apiKey.trim()
            : undefined;
        const apiKeyEnv =
          typeof action.payload.apiKeyEnv === "string" && action.payload.apiKeyEnv.trim()
            ? action.payload.apiKeyEnv.trim().toUpperCase()
            : providerId === "codex"
              ? "OPENAI_API_KEY"
              : providerId === "claude"
                ? "ANTHROPIC_API_KEY"
                : "OPENCODE_API_KEY";

        if (!modelId && !baseUrl && !apiKey) {
          throw new Error("set_tool_provider_config requires modelId/baseUrl/apiKey");
        }

        this.patchRuntimeConfig((config) => {
          if (modelId) {
            config.tools.providerModels[providerId] = modelId;
          }
          if (baseUrl) {
            config.tools.providerBaseUrls[providerId] = baseUrl;
          }
          return config;
        });

        if (apiKey) {
          this.setRuntimeSecret(apiKeyEnv, apiKey);
        }
        break;
      }
      case "set_runtime_setting": {
        const key =
          typeof action.payload.key === "string" && action.payload.key.trim()
            ? action.payload.key.trim().toUpperCase()
            : "";
        const value =
          typeof action.payload.value === "string" && action.payload.value.trim()
            ? action.payload.value.trim()
            : "";
        const isSecret = Boolean(action.payload.isSecret);
        if (!key || !value) {
          throw new Error("set_runtime_setting requires key/value");
        }

        if (isSecret) {
          this.setRuntimeSecret(key, value);
        } else {
          this.setRuntimeSetting(key, value);
        }

        const searchProviderFromKey =
          key === "TAVILY_API_KEY" ? "tavily" : key === "SERPAPI_API_KEY" ? "serpapi" : "";
        if (searchProviderFromKey) {
          const runtimeSettings = this.getRuntimeSettings();
          if (!runtimeSettings.SEARCH_PROVIDER) {
            this.setRuntimeSetting("SEARCH_PROVIDER", searchProviderFromKey);
          }
        }
        break;
      }
      case "add_agent_instance": {
        const roleId =
          (action.targetRoleId as RoleId | undefined) ||
          (typeof action.payload.roleId === "string" ? (action.payload.roleId as RoleId) : undefined);
        if (!roleId) {
          throw new Error("add_agent_instance requires roleId");
        }
        const name = typeof action.payload.name === "string" ? action.payload.name : undefined;
        const tonePolicy =
          typeof action.payload.tonePolicy === "string" ? action.payload.tonePolicy : undefined;
        this.createAgentInstance({
          roleId,
          name,
          tonePolicy,
          metadata: {
            createdFromActionId: action.id
          },
          createdBy: decidedBy
        });
        break;
      }
      case "remove_agent_instance": {
        const instanceId =
          typeof action.payload.instanceId === "string" ? action.payload.instanceId.trim() : "";
        if (instanceId) {
          const updated = this.deactivateAgentInstance(instanceId);
          if (!updated) {
            throw new Error(`Agent instance ${instanceId} not found`);
          }
          break;
        }

        const roleId =
          (action.targetRoleId as RoleId | undefined) ||
          (typeof action.payload.roleId === "string" ? (action.payload.roleId as RoleId) : undefined);
        if (!roleId) {
          throw new Error("remove_agent_instance requires roleId or instanceId");
        }
        const active = this.listActiveAgentInstances(roleId);
        if (active.length === 0) {
          throw new Error(`No active agent instance for role ${roleId}`);
        }
        const preferredName =
          typeof action.payload.name === "string" ? action.payload.name.trim().toLowerCase() : "";
        const target =
          (preferredName
            ? active.find((item) => item.name.trim().toLowerCase() === preferredName)
            : undefined) ?? active[active.length - 1];
        if (!target) {
          throw new Error(`No removable agent instance for role ${roleId}`);
        }
        this.deactivateAgentInstance(target.id);
        break;
      }
      case "set_agent_tone_policy": {
        const tonePolicy =
          typeof action.payload.tonePolicy === "string" ? action.payload.tonePolicy.trim() : "";
        if (!tonePolicy) {
          throw new Error("set_agent_tone_policy requires tonePolicy");
        }

        const instanceId =
          typeof action.payload.instanceId === "string" ? action.payload.instanceId.trim() : "";
        if (instanceId) {
          const updated = this.updateAgentInstance(instanceId, { tonePolicy });
          if (!updated) {
            throw new Error(`Agent instance ${instanceId} not found`);
          }
          break;
        }

        const roleId =
          (action.targetRoleId as RoleId | undefined) ||
          (typeof action.payload.roleId === "string" ? (action.payload.roleId as RoleId) : undefined);
        if (!roleId) {
          throw new Error("set_agent_tone_policy requires roleId or instanceId");
        }
        const active = this.listActiveAgentInstances(roleId);
        if (active.length === 0) {
          throw new Error(`No active agent instance for role ${roleId}`);
        }
        const preferredName =
          typeof action.payload.name === "string" ? action.payload.name.trim().toLowerCase() : "";
        const target =
          (preferredName
            ? active.find((item) => item.name.trim().toLowerCase() === preferredName)
            : undefined) ?? active[active.length - 1];
        if (!target) {
          throw new Error(`No active agent instance for role ${roleId}`);
        }
        this.updateAgentInstance(target.id, { tonePolicy });
        break;
      }
      default:
        throw new Error(`Unsupported operator action kind: ${action.kind}`);
    }

    this.markOperatorActionStatus(actionId, "applied", now());
    this.appendAuditEvent({
      category: "operator-action",
      entityType: "operator_action",
      entityId: actionId,
      message: `Applied operator action ${action.kind}`,
      payload: {
        decidedBy
      }
    });

    return this.getOperatorAction(actionId);
  }

  appendAuditEvent(input: {
    category: string;
    entityType: string;
    entityId: string;
    message: string;
    payload?: Record<string, unknown>;
  }): AuditEventRecord {
    const eventId = randomUUID();
    const timestamp = now();
    this.db
      .prepare(`
        INSERT INTO audit_events (id, category, entity_type, entity_id, message, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        eventId,
        input.category,
        input.entityType,
        input.entityId,
        input.message,
        jsonStringify(input.payload ?? {}),
        timestamp
      );

    return {
      id: eventId,
      category: input.category,
      entityType: input.entityType,
      entityId: input.entityId,
      message: input.message,
      payload: input.payload ?? {},
      createdAt: timestamp
    };
  }

  listAuditEvents(limit = 50): AuditEventRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM audit_events ORDER BY created_at DESC LIMIT ?")
      .all(limit) as JsonRow[];
    return rows.map(toAuditEventRecord);
  }

  getDashboardSnapshot(): DashboardSnapshot {
    return {
      config: this.getRuntimeConfig(),
      routingTemplates: this.listRoutingTemplates(),
      queueMetrics: this.getQueueMetrics(),
      toolRuns: this.listToolRuns(25),
      tasks: this.listTasks(25),
      approvals: this.listApprovals(25),
      operatorActions: this.listOperatorActions(25),
      skillBindings: this.listSkillBindings(),
      auditEvents: this.listAuditEvents(25)
    };
  }

  getStatusCounts(): {
    tasks: Record<string, number>;
    goalRuns: Record<string, number>;
    approvals: Record<string, number>;
    operatorActions: Record<string, number>;
    toolRuns: Record<string, number>;
  } {
    const countByStatus = (tableName: string): Record<string, number> => {
      const rows = this.db
        .prepare(`SELECT status, COUNT(*) AS count FROM ${tableName} GROUP BY status`)
        .all() as JsonRow[];
      const result: Record<string, number> = {};
      for (const row of rows) {
        const status = String(row.status ?? "").trim();
        if (!status) {
          continue;
        }
        result[status] = Number(row.count ?? 0);
      }
      return result;
    };
    return {
      tasks: countByStatus("tasks"),
      goalRuns: countByStatus("goal_runs"),
      approvals: countByStatus("approvals"),
      operatorActions: countByStatus("operator_actions"),
      toolRuns: countByStatus("tool_runs")
    };
  }

  getDailyOutcomeMetrics(input?: {
    days?: number | undefined;
  }): {
    windowDays: number;
    since: string;
    tasks: Array<{ date: string; completed: number; failed: number }>;
    goalRuns: Array<{ date: string; completed: number; failed: number }>;
  } {
    const daysCandidate = Number(input?.days ?? 7);
    const windowDays = Number.isFinite(daysCandidate)
      ? Math.max(1, Math.min(90, Math.round(daysCandidate)))
      : 7;
    const nowDate = new Date();
    const startDate = new Date(
      Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), nowDate.getUTCDate() - (windowDays - 1))
    );
    const since = startDate.toISOString();

    const dateSeries = Array.from({ length: windowDays }, (_, index) => {
      const day = new Date(startDate.getTime() + index * 24 * 60 * 60 * 1000);
      return day.toISOString().slice(0, 10);
    });

    const readByDay = (tableName: "tasks" | "goal_runs"): Record<string, { completed: number; failed: number }> => {
      const rows = this.db
        .prepare(`
          SELECT
            substr(completed_at, 1, 10) AS day,
            SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_count,
            SUM(CASE WHEN status IN ('failed', 'cancelled') THEN 1 ELSE 0 END) AS failed_count
          FROM ${tableName}
          WHERE completed_at IS NOT NULL
            AND completed_at >= ?
          GROUP BY substr(completed_at, 1, 10)
          ORDER BY day ASC
        `)
        .all(since) as JsonRow[];
      const map: Record<string, { completed: number; failed: number }> = {};
      for (const row of rows) {
        const day = String(row.day ?? "").trim();
        if (!day) {
          continue;
        }
        map[day] = {
          completed: Number(row.completed_count ?? 0),
          failed: Number(row.failed_count ?? 0)
        };
      }
      return map;
    };

    const taskMap = readByDay("tasks");
    const goalRunMap = readByDay("goal_runs");
    return {
      windowDays,
      since,
      tasks: dateSeries.map((date) => ({
        date,
        completed: taskMap[date]?.completed ?? 0,
        failed: taskMap[date]?.failed ?? 0
      })),
      goalRuns: dateSeries.map((date) => ({
        date,
        completed: goalRunMap[date]?.completed ?? 0,
        failed: goalRunMap[date]?.failed ?? 0
      }))
    };
  }

  // Plugin State Management

  getPluginState(id: string): { id: string; enabled: boolean; config: Record<string, unknown> } | undefined {
    const row = this.db
      .prepare("SELECT * FROM plugin_states WHERE id = ?")
      .get(id) as JsonRow | undefined;
    if (!row) {
      return undefined;
    }
    return {
      id: String(row.id),
      enabled: Boolean(row.enabled),
      config: jsonParse<Record<string, unknown>>(row.config_json, {})
    };
  }

  listPluginStates(): Array<{ id: string; enabled: boolean; config: Record<string, unknown> }> {
    const rows = this.db
      .prepare("SELECT * FROM plugin_states ORDER BY id")
      .all() as JsonRow[];
    return rows.map((row) => ({
      id: String(row.id),
      enabled: Boolean(row.enabled),
      config: jsonParse<Record<string, unknown>>(row.config_json, {})
    }));
  }

  setPluginState(id: string, enabled: boolean, config: Record<string, unknown>): void {
    const timestamp = now();
    this.db
      .prepare(`
        INSERT INTO plugin_states (id, enabled, config_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, config_json = excluded.config_json, updated_at = excluded.updated_at
      `)
      .run(id, enabled ? 1 : 0, jsonStringify(config), timestamp, timestamp);
  }

  deletePluginState(id: string): void {
    this.db.prepare("DELETE FROM plugin_states WHERE id = ?").run(id);
  }

  // User Management

  createUser(input: CreateUserInput): UserRecord {
    const userId = randomUUID();
    const timestamp = now();
    const role = input.role ?? "viewer";
    const displayName = input.displayName ?? input.username;

    this.db
      .prepare(`
        INSERT INTO users (id, username, email, password_hash, role, display_name, is_active, metadata_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, '{}', ?, ?)
      `)
      .run(userId, input.username, input.email ?? null, input.password, role, displayName, timestamp, timestamp);

    return this.getUser(userId)!;
  }

  getUser(id: string): UserRecord | undefined {
    const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as JsonRow | undefined;
    return row ? toUserRecord(row) : undefined;
  }

  getUserByUsername(username: string): UserRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM users WHERE username = ?")
      .get(username) as JsonRow | undefined;
    return row ? toUserRecord(row) : undefined;
  }

  getUserByEmail(email: string): UserRecord | undefined {
    const row = this.db.prepare("SELECT * FROM users WHERE email = ?").get(email) as JsonRow | undefined;
    return row ? toUserRecord(row) : undefined;
  }

  listUsers(limit = 100): UserRecord[] {
    const rows = this.db.prepare("SELECT * FROM users ORDER BY created_at DESC LIMIT ?").all(limit) as JsonRow[];
    return rows.map(toUserRecord);
  }

  updateUser(id: string, input: UpdateUserInput): UserRecord | undefined {
    const user = this.getUser(id);
    if (!user) {
      return undefined;
    }

    const timestamp = now();
    const updates: string[] = [];
    const values: (string | number | null)[] = [];

    if (input.email !== undefined) {
      updates.push("email = ?");
      values.push(input.email ?? null);
    }
    if (input.displayName !== undefined) {
      updates.push("display_name = ?");
      values.push(input.displayName);
    }
    if (input.isActive !== undefined) {
      updates.push("is_active = ?");
      values.push(input.isActive ? 1 : 0);
    }

    if (updates.length === 0) {
      return user;
    }

    updates.push("updated_at = ?");
    values.push(timestamp);
    values.push(id);

    this.db
      .prepare(`UPDATE users SET ${updates.join(", ")} WHERE id = ?`)
      .run(...values);

    return this.getUser(id);
  }

  updateUserPassword(id: string, passwordHash: string): void {
    const timestamp = now();
    this.db
      .prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?")
      .run(passwordHash, timestamp, id);
  }

  updateUserLastLogin(id: string): void {
    const timestamp = now();
    this.db
      .prepare(`
        UPDATE users 
        SET last_login_at = ?, login_count = login_count + 1, updated_at = ? 
        WHERE id = ?
      `)
      .run(timestamp, timestamp, id);
  }

  deleteUser(id: string): boolean {
    const result = this.db.prepare("DELETE FROM users WHERE id = ?").run(id);
    return result.changes > 0;
  }

  // Auth Session Management

  createAuthSession(input: CreateAuthSessionInput): AuthSessionRecord {
    const sessionId = randomUUID();
    const token = randomUUID();
    const timestamp = now();
    const expiresAt = new Date(
      Date.now() + (input.rememberMe ? 7 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000)
    ).toISOString();

    this.db
      .prepare(`
        INSERT INTO auth_sessions (id, user_id, token, user_agent, ip_address, expires_at, created_at, last_accessed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        sessionId,
        input.userId,
        token,
        input.userAgent ?? null,
        input.ipAddress ?? null,
        expiresAt,
        timestamp,
        timestamp
      );

    return this.getAuthSessionByToken(token)!;
  }

  getAuthSession(id: string): AuthSessionRecord | undefined {
    const row = this.db.prepare("SELECT * FROM auth_sessions WHERE id = ?").get(id) as JsonRow | undefined;
    return row ? toAuthSessionRecord(row) : undefined;
  }

  getAuthSessionByToken(token: string): AuthSessionRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM auth_sessions WHERE token = ?")
      .get(token) as JsonRow | undefined;
    return row ? toAuthSessionRecord(row) : undefined;
  }

  listAuthSessionsByUser(userId: string, limit = 10): AuthSessionRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM auth_sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(userId, limit) as JsonRow[];
    return rows.map(toAuthSessionRecord);
  }

  updateAuthSessionLastAccessed(id: string): void {
    const timestamp = now();
    this.db
      .prepare("UPDATE auth_sessions SET last_accessed_at = ? WHERE id = ?")
      .run(timestamp, id);
  }

  deleteAuthSession(id: string): boolean {
    const result = this.db.prepare("DELETE FROM auth_sessions WHERE id = ?").run(id);
    return result.changes > 0;
  }

  deleteAuthSessionByToken(token: string): boolean {
    const result = this.db.prepare("DELETE FROM auth_sessions WHERE token = ?").run(token);
    return result.changes > 0;
  }

  deleteExpiredAuthSessions(): number {
    const timestamp = now();
    const result = this.db
      .prepare("DELETE FROM auth_sessions WHERE expires_at < ?")
      .run(timestamp);
    return Number(result.changes);
  }

  deleteAllAuthSessionsByUser(userId: string): number {
    const result = this.db.prepare("DELETE FROM auth_sessions WHERE user_id = ?").run(userId);
    return Number(result.changes);
  }

  // Auth Metrics

  getAuthMetrics(): AuthMetrics {
    const totalUsers = this.db
      .prepare("SELECT COUNT(*) as count FROM users")
      .get() as JsonRow;
    const activeUsers = this.db
      .prepare("SELECT COUNT(*) as count FROM users WHERE is_active = 1")
      .get() as JsonRow;
    const activeSessions = this.db
      .prepare("SELECT COUNT(*) as count FROM auth_sessions WHERE expires_at > ?")
      .get(now()) as JsonRow;
    const loginAttempts24h = this.db
      .prepare(
        "SELECT COUNT(*) as count FROM audit_events WHERE category = 'auth' AND message = 'login_attempt' AND created_at > ?"
      )
      .get(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()) as JsonRow;
    const failedLogins24h = this.db
      .prepare(
        "SELECT COUNT(*) as count FROM audit_events WHERE category = 'auth' AND message = 'login_failed' AND created_at > ?"
      )
      .get(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()) as JsonRow;

    return {
      totalUsers: Number(totalUsers.count),
      activeUsers: Number(activeUsers.count),
      activeSessions: Number(activeSessions.count),
      loginAttempts24h: Number(loginAttempts24h.count),
      failedLogins24h: Number(failedLogins24h.count)
    };
  }

  // CRM Leads

  createCrmLead(input: CreateCrmLeadInput): CrmLeadRecord {
    const id = randomUUID();
    const timestamp = now();
    this.db
      .prepare(`
        INSERT INTO crm_leads (
          id, name, company, title, email, source, stage, status, tags_json, latest_summary,
          next_action, owner_role_id, linked_project_id, last_contact_at, archived_at, metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
      `)
      .run(
        id,
        input.name.trim(),
        input.company ?? null,
        input.title ?? null,
        input.email ?? null,
        input.source.trim() || "manual",
        input.stage ?? "new",
        jsonStringify(input.tags ?? []),
        input.latestSummary ?? "",
        input.nextAction ?? null,
        input.ownerRoleId ?? null,
        input.linkedProjectId ?? null,
        input.lastContactAt ?? null,
        jsonStringify(input.metadata ?? {}),
        timestamp,
        timestamp
      );
    return this.getCrmLead(id)!;
  }

  getCrmLead(id: string): CrmLeadRecord | undefined {
    const row = this.db.prepare("SELECT * FROM crm_leads WHERE id = ?").get(id) as JsonRow | undefined;
    return row ? toCrmLeadRecord(row) : undefined;
  }

  listCrmLeads(input?: {
    status?: CrmLeadStatus | undefined;
    stage?: CrmLeadStage | undefined;
    linkedProjectId?: string | undefined;
    limit?: number | undefined;
  }): CrmLeadRecord[] {
    const where: string[] = [];
    const values: Array<string | number> = [];
    if (input?.status) {
      where.push("status = ?");
      values.push(input.status);
    }
    if (input?.stage) {
      where.push("stage = ?");
      values.push(input.stage);
    }
    if (input?.linkedProjectId) {
      where.push("linked_project_id = ?");
      values.push(input.linkedProjectId);
    }
    const limit = Math.max(1, Math.min(500, Math.round(input?.limit ?? 100)));
    values.push(limit);
    const query = `
      SELECT *
      FROM crm_leads
      ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY updated_at DESC
      LIMIT ?
    `;
    const rows = this.db.prepare(query).all(...values) as JsonRow[];
    return rows.map(toCrmLeadRecord);
  }

  updateCrmLead(id: string, patch: UpdateCrmLeadInput): CrmLeadRecord | undefined {
    const existing = this.getCrmLead(id);
    if (!existing) {
      return undefined;
    }
    const updates: string[] = [];
    const values: Array<string | null> = [];
    if (patch.name !== undefined) {
      updates.push("name = ?");
      values.push(patch.name.trim());
    }
    if (patch.company !== undefined) {
      updates.push("company = ?");
      values.push(patch.company ?? null);
    }
    if (patch.title !== undefined) {
      updates.push("title = ?");
      values.push(patch.title ?? null);
    }
    if (patch.email !== undefined) {
      updates.push("email = ?");
      values.push(patch.email ?? null);
    }
    if (patch.source !== undefined) {
      updates.push("source = ?");
      values.push(patch.source);
    }
    if (patch.stage !== undefined) {
      updates.push("stage = ?");
      values.push(patch.stage);
    }
    if (patch.status !== undefined) {
      updates.push("status = ?");
      values.push(patch.status);
    }
    if (patch.tags !== undefined) {
      updates.push("tags_json = ?");
      values.push(jsonStringify(patch.tags));
    }
    if (patch.latestSummary !== undefined) {
      updates.push("latest_summary = ?");
      values.push(patch.latestSummary);
    }
    if (patch.nextAction !== undefined) {
      updates.push("next_action = ?");
      values.push(patch.nextAction ?? null);
    }
    if (patch.ownerRoleId !== undefined) {
      updates.push("owner_role_id = ?");
      values.push(patch.ownerRoleId ?? null);
    }
    if (patch.linkedProjectId !== undefined) {
      updates.push("linked_project_id = ?");
      values.push(patch.linkedProjectId ?? null);
    }
    if (patch.lastContactAt !== undefined) {
      updates.push("last_contact_at = ?");
      values.push(patch.lastContactAt ?? null);
    }
    if (patch.archivedAt !== undefined) {
      updates.push("archived_at = ?");
      values.push(patch.archivedAt ?? null);
    }
    if (patch.metadata !== undefined) {
      updates.push("metadata_json = ?");
      values.push(jsonStringify(patch.metadata));
    }
    if (updates.length === 0) {
      return existing;
    }
    updates.push("updated_at = ?");
    values.push(now());
    values.push(id);
    this.db.prepare(`UPDATE crm_leads SET ${updates.join(", ")} WHERE id = ?`).run(...values);
    return this.getCrmLead(id);
  }

  archiveCrmLead(id: string): CrmLeadRecord | undefined {
    return this.updateCrmLead(id, {
      status: "archived",
      archivedAt: now()
    });
  }

  createCrmCadence(input: CreateCrmCadenceInput): CrmCadenceRecord {
    const id = randomUUID();
    const timestamp = now();
    this.db
      .prepare(`
        INSERT INTO crm_cadences (
          id, lead_id, label, channel, interval_days, status, objective,
          next_run_at, last_run_at, owner_role_id, metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, NULL, ?, ?, ?, ?)
      `)
      .run(
        id,
        input.leadId,
        input.label.trim(),
        input.channel ?? "manual",
        Math.max(1, Math.round(input.intervalDays)),
        input.objective.trim(),
        input.nextRunAt,
        input.ownerRoleId ?? null,
        jsonStringify(input.metadata ?? {}),
        timestamp,
        timestamp
      );
    return this.getCrmCadence(id)!;
  }

  getCrmCadence(id: string): CrmCadenceRecord | undefined {
    const row = this.db.prepare("SELECT * FROM crm_cadences WHERE id = ?").get(id) as JsonRow | undefined;
    return row ? toCrmCadenceRecord(row) : undefined;
  }

  listCrmCadences(input?: {
    leadId?: string | undefined;
    status?: CrmCadenceStatus | undefined;
    dueBefore?: string | undefined;
    limit?: number | undefined;
  }): CrmCadenceRecord[] {
    const where: string[] = [];
    const values: Array<string | number> = [];
    if (input?.leadId) {
      where.push("lead_id = ?");
      values.push(input.leadId);
    }
    if (input?.status) {
      where.push("status = ?");
      values.push(input.status);
    }
    if (input?.dueBefore) {
      where.push("next_run_at <= ?");
      values.push(input.dueBefore);
    }
    const limit = Math.max(1, Math.min(500, Math.round(input?.limit ?? 100)));
    values.push(limit);
    const query = `
      SELECT *
      FROM crm_cadences
      ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY next_run_at ASC, updated_at DESC
      LIMIT ?
    `;
    const rows = this.db.prepare(query).all(...values) as JsonRow[];
    return rows.map(toCrmCadenceRecord);
  }

  updateCrmCadence(id: string, patch: UpdateCrmCadenceInput): CrmCadenceRecord | undefined {
    const existing = this.getCrmCadence(id);
    if (!existing) {
      return undefined;
    }
    const updates: string[] = [];
    const values: Array<string | number | null> = [];
    if (patch.label !== undefined) {
      updates.push("label = ?");
      values.push(patch.label.trim());
    }
    if (patch.channel !== undefined) {
      updates.push("channel = ?");
      values.push(patch.channel);
    }
    if (patch.intervalDays !== undefined) {
      updates.push("interval_days = ?");
      values.push(Math.max(1, Math.round(patch.intervalDays)));
    }
    if (patch.status !== undefined) {
      updates.push("status = ?");
      values.push(patch.status);
    }
    if (patch.objective !== undefined) {
      updates.push("objective = ?");
      values.push(patch.objective.trim());
    }
    if (patch.nextRunAt !== undefined) {
      updates.push("next_run_at = ?");
      values.push(patch.nextRunAt);
    }
    if (patch.lastRunAt !== undefined) {
      updates.push("last_run_at = ?");
      values.push(patch.lastRunAt ?? null);
    }
    if (patch.ownerRoleId !== undefined) {
      updates.push("owner_role_id = ?");
      values.push(patch.ownerRoleId ?? null);
    }
    if (patch.metadata !== undefined) {
      updates.push("metadata_json = ?");
      values.push(jsonStringify(patch.metadata));
    }
    if (updates.length === 0) {
      return existing;
    }
    updates.push("updated_at = ?");
    values.push(now());
    values.push(id);
    this.db.prepare(`UPDATE crm_cadences SET ${updates.join(", ")} WHERE id = ?`).run(...values);
    return this.getCrmCadence(id);
  }

  archiveCrmCadence(id: string): CrmCadenceRecord | undefined {
    return this.updateCrmCadence(id, {
      status: "archived"
    });
  }

  createCrmContact(input: CreateCrmContactInput): CrmContactRecord {
    const id = randomUUID();
    const timestamp = now();
    const happenedAt = input.happenedAt ?? timestamp;
    this.db
      .prepare(`
        INSERT INTO crm_contacts (
          id, lead_id, cadence_id, channel, outcome, summary, next_action, happened_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        input.leadId,
        input.cadenceId ?? null,
        input.channel ?? "manual",
        input.outcome ?? "note",
        input.summary.trim(),
        input.nextAction?.trim() ?? null,
        happenedAt,
        timestamp
      );
    const lead = this.getCrmLead(input.leadId);
    if (lead) {
      this.updateCrmLead(input.leadId, {
        stage: resolveLeadStageFromContactOutcome(lead.stage, input.outcome),
        latestSummary: input.summary.trim(),
        nextAction: input.nextAction?.trim() || lead.nextAction,
        lastContactAt: happenedAt
      });
    }
    const cadence = input.cadenceId ? this.getCrmCadence(input.cadenceId) : undefined;
    if (cadence) {
      const terminalOutcome = input.outcome === "meeting_booked" || input.outcome === "won" || input.outcome === "lost";
      const nextRunAt = new Date(Date.parse(happenedAt) + cadence.intervalDays * 24 * 60 * 60 * 1000).toISOString();
      this.updateCrmCadence(cadence.id, {
        lastRunAt: happenedAt,
        nextRunAt: terminalOutcome ? cadence.nextRunAt : nextRunAt,
        status: terminalOutcome ? "completed" : cadence.status === "archived" ? "archived" : "active"
      });
    }
    return this.getCrmContact(id)!;
  }

  getCrmContact(id: string): CrmContactRecord | undefined {
    const row = this.db.prepare("SELECT * FROM crm_contacts WHERE id = ?").get(id) as JsonRow | undefined;
    return row ? toCrmContactRecord(row) : undefined;
  }

  listCrmContacts(input?: { leadId?: string | undefined; limit?: number | undefined }): CrmContactRecord[] {
    const where: string[] = [];
    const values: Array<string | number> = [];
    if (input?.leadId) {
      where.push("lead_id = ?");
      values.push(input.leadId);
    }
    const limit = Math.max(1, Math.min(500, Math.round(input?.limit ?? 100)));
    values.push(limit);
    const query = `
      SELECT *
      FROM crm_contacts
      ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY happened_at DESC, created_at DESC
      LIMIT ?
    `;
    const rows = this.db.prepare(query).all(...values) as JsonRow[];
    return rows.map(toCrmContactRecord);
  }

  // ============ Agent Collaboration Methods ============

  createAgentCollaboration(collaboration: AgentCollaboration): void {
    this.db
      .prepare(`
        INSERT INTO agent_collaborations (
          id, parent_task_id, session_id, chat_id, status, participants_json,
          facilitator, current_phase, phase_results_json, config_json, created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        collaboration.id,
        collaboration.parentTaskId,
        collaboration.sessionId ?? null,
        collaboration.chatId ?? null,
        collaboration.status,
        jsonStringify(collaboration.participants),
        collaboration.facilitator,
        collaboration.currentPhase,
        jsonStringify(collaboration.phaseResults),
        jsonStringify(collaboration.config),
        collaboration.createdAt,
        collaboration.updatedAt,
        collaboration.completedAt ?? null
      );
  }

  getAgentCollaboration(id: string): AgentCollaboration | undefined {
    const row = this.db
      .prepare("SELECT * FROM agent_collaborations WHERE id = ?")
      .get(id) as JsonRow | undefined;
    return row ? toAgentCollaboration(row) : undefined;
  }

  updateAgentCollaboration(
    id: string,
    patch: Partial<
      Omit<Pick<AgentCollaboration, "status" | "currentPhase" | "phaseResults" | "updatedAt">, never>
    > & {
      completedAt?: string | null;
    }
  ): void {
    const updates: string[] = [];
    const values: (string | number | null)[] = [];

    if (patch.status !== undefined) {
      updates.push("status = ?");
      values.push(patch.status);
    }
    if (patch.currentPhase !== undefined) {
      updates.push("current_phase = ?");
      values.push(patch.currentPhase);
    }
    if (patch.phaseResults !== undefined) {
      updates.push("phase_results_json = ?");
      values.push(jsonStringify(patch.phaseResults));
    }
    if (patch.updatedAt !== undefined) {
      updates.push("updated_at = ?");
      values.push(patch.updatedAt);
    }
    if (patch.completedAt !== undefined) {
      updates.push("completed_at = ?");
      values.push(patch.completedAt ?? null);
    }

    if (updates.length === 0) {
      return;
    }

    values.push(id);
    this.db
      .prepare(`UPDATE agent_collaborations SET ${updates.join(", ")} WHERE id = ?`)
      .run(...values);
  }

  listAgentCollaborationsByParentTask(parentTaskId: string): AgentCollaboration[] {
    const rows = this.db
      .prepare("SELECT * FROM agent_collaborations WHERE parent_task_id = ? ORDER BY created_at DESC")
      .all(parentTaskId) as JsonRow[];
    return rows.map(toAgentCollaboration);
  }

  listActiveAgentCollaborations(): AgentCollaboration[] {
    const rows = this.db
      .prepare("SELECT * FROM agent_collaborations WHERE status = 'active' ORDER BY created_at DESC")
      .all() as JsonRow[];
    return rows.map(toAgentCollaboration);
  }

  createAgentMessage(message: AgentMessage): void {
    this.db
      .prepare(`
        INSERT INTO agent_messages (
          id, collaboration_id, task_id, from_role_id, to_role_ids_json,
          message_type, content, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        message.id,
        message.collaborationId,
        message.taskId,
        message.fromRoleId,
        jsonStringify(message.toRoleIds),
        message.messageType,
        message.content,
        jsonStringify(message.metadata),
        message.createdAt
      );
  }

  listAgentMessages(collaborationId: string): AgentMessage[] {
    const rows = this.db
      .prepare("SELECT * FROM agent_messages WHERE collaboration_id = ? ORDER BY created_at ASC")
      .all(collaborationId) as JsonRow[];
    return rows.map(toAgentMessage);
  }

  listAgentMessagesByTask(taskId: string): AgentMessage[] {
    const rows = this.db
      .prepare("SELECT * FROM agent_messages WHERE task_id = ? ORDER BY created_at ASC")
      .all(taskId) as JsonRow[];
    return rows.map(toAgentMessage);
  }

  createCollaborationTimelineEvent(
    input: Omit<CollaborationTimelineEvent, "id" | "createdAt"> &
      Partial<Pick<CollaborationTimelineEvent, "id" | "createdAt">>
  ): CollaborationTimelineEvent {
    const eventId = input.id ?? randomUUID();
    const timestamp = input.createdAt ?? now();
    this.db
      .prepare(`
        INSERT INTO collaboration_timeline_events (
          id, collaboration_id, event_type, message, role_id, task_id, agent_instance_id, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        eventId,
        input.collaborationId,
        input.eventType,
        input.message,
        input.roleId ?? null,
        input.taskId ?? null,
        input.agentInstanceId ?? null,
        jsonStringify(input.metadata ?? {}),
        timestamp
      );

    const row = this.db
      .prepare("SELECT * FROM collaboration_timeline_events WHERE id = ?")
      .get(eventId) as JsonRow | undefined;
    if (!row) {
      throw new Error(`Collaboration timeline event ${eventId} was created but could not be loaded`);
    }
    return toCollaborationTimelineEvent(row);
  }

  listCollaborationTimelineEvents(collaborationId: string): CollaborationTimelineEvent[] {
    const rows = this.db
      .prepare(`
        SELECT *
        FROM collaboration_timeline_events
        WHERE collaboration_id = ?
        ORDER BY created_at ASC
      `)
      .all(collaborationId) as JsonRow[];
    return rows.map(toCollaborationTimelineEvent);
  }

  createAgentInstance(input: CreateAgentInstanceInput): AgentInstance {
    const id = randomUUID();
    const timestamp = now();
    const normalizedName =
      typeof input.name === "string" && input.name.trim()
        ? input.name.trim()
        : `${input.roleId.toUpperCase()} Agent`;
    const tonePolicy = typeof input.tonePolicy === "string" ? input.tonePolicy.trim() : "";
    const status = input.status ?? "active";
    this.db
      .prepare(`
        INSERT INTO agent_instances (
          id, role_id, name, tone_policy, status, metadata_json, created_by, created_at, updated_at, deactivated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        input.roleId,
        normalizedName,
        tonePolicy,
        status,
        jsonStringify(input.metadata ?? {}),
        input.createdBy ?? null,
        timestamp,
        timestamp,
        status === "inactive" ? timestamp : null
      );

    const row = this.db.prepare("SELECT * FROM agent_instances WHERE id = ?").get(id) as JsonRow | undefined;
    if (!row) {
      throw new Error(`Agent instance ${id} was created but could not be loaded`);
    }
    return toAgentInstance(row);
  }

  getAgentInstance(id: string): AgentInstance | undefined {
    const row = this.db.prepare("SELECT * FROM agent_instances WHERE id = ?").get(id) as JsonRow | undefined;
    return row ? toAgentInstance(row) : undefined;
  }

  listAgentInstances(input?: {
    roleId?: RoleId | undefined;
    status?: AgentInstance["status"] | undefined;
  }): AgentInstance[] {
    const where: string[] = [];
    const values: Array<string> = [];
    if (input?.roleId) {
      where.push("role_id = ?");
      values.push(input.roleId);
    }
    if (input?.status) {
      where.push("status = ?");
      values.push(input.status);
    }

    const query = `
      SELECT *
      FROM agent_instances
      ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY role_id ASC, created_at ASC
    `;
    const rows = this.db.prepare(query).all(...values) as JsonRow[];
    return rows.map(toAgentInstance);
  }

  listActiveAgentInstances(roleId?: RoleId): AgentInstance[] {
    if (roleId) {
      return this.listAgentInstances({ roleId, status: "active" });
    }
    return this.listAgentInstances({ status: "active" });
  }

  updateAgentInstance(id: string, patch: UpdateAgentInstanceInput): AgentInstance | undefined {
    const updates: string[] = [];
    const values: Array<string | number | null> = [];

    if (patch.name !== undefined) {
      updates.push("name = ?");
      values.push(patch.name.trim());
    }
    if (patch.tonePolicy !== undefined) {
      updates.push("tone_policy = ?");
      values.push(patch.tonePolicy.trim());
    }
    if (patch.status !== undefined) {
      updates.push("status = ?");
      values.push(patch.status);
      updates.push("deactivated_at = ?");
      values.push(patch.status === "inactive" ? patch.deactivatedAt ?? now() : null);
    } else if (patch.deactivatedAt !== undefined) {
      updates.push("deactivated_at = ?");
      values.push(patch.deactivatedAt ?? null);
    }
    if (patch.metadata !== undefined) {
      updates.push("metadata_json = ?");
      values.push(jsonStringify(patch.metadata));
    }

    if (updates.length === 0) {
      return this.getAgentInstance(id);
    }

    updates.push("updated_at = ?");
    values.push(now());
    values.push(id);
    this.db
      .prepare(`UPDATE agent_instances SET ${updates.join(", ")} WHERE id = ?`)
      .run(...values);
    return this.getAgentInstance(id);
  }

  deactivateAgentInstance(id: string): AgentInstance | undefined {
    return this.updateAgentInstance(id, {
      status: "inactive",
      deactivatedAt: now()
    });
  }

  /**
   * Workspace Memory: Cross-session persistence for user preferences and key decisions.
   */
  getWorkspaceMemory(): WorkspaceMemoryRecord {
    return this.workspaceMemoryManager.get();
  }

  patchWorkspaceMemory(patch: Partial<WorkspaceMemoryRecord>): WorkspaceMemoryRecord {
    return this.workspaceMemoryManager.patch(patch);
  }

  recordWorkspaceMemoryFact(
    fact: Omit<WorkspaceMemoryFactRecord, "id" | "createdAt" | "updatedAt"> &
      Partial<Pick<WorkspaceMemoryFactRecord, "id" | "createdAt" | "updatedAt">>
  ): WorkspaceMemoryRecord {
    return this.workspaceMemoryManager.recordMemoryFact(fact);
  }

  deleteWorkspaceMemoryFact(id: string): WorkspaceMemoryRecord {
    return this.workspaceMemoryManager.deleteMemoryFact(id);
  }

  resetWorkspaceMemoryFacts(): WorkspaceMemoryRecord {
    return this.workspaceMemoryManager.resetMemoryFacts();
  }

  addWorkspaceDecision(decision: string, rationale: string, category?: string): void {
    this.workspaceMemoryManager.addDecision(decision, rationale, category);
  }

  setWorkspacePreferences(prefs: Partial<WorkspaceMemoryRecord["userPreferences"]>): void {
    this.workspaceMemoryManager.setPreferences(prefs);
  }

  updateWorkspaceProject(
    name: string,
    stage: string,
    patch?: Parameters<WorkspaceMemoryManager["updateProject"]>[2]
  ): void {
    this.workspaceMemoryManager.updateProject(name, stage, patch);
  }

  archiveWorkspaceProject(name: string, latestSummary?: string): void {
    this.workspaceMemoryManager.archiveProject(name, latestSummary);
  }
}

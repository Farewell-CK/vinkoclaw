import type {
  AuditEventRecord,
  GoalRunHarnessGradeRecord,
  ReflectionNote,
  RoleId,
  TaskRecord,
  VinkoStore
} from "./index.js";

export type EvolutionSignalKind =
  | "task_completed"
  | "task_failed"
  | "low_confidence_reflection"
  | "high_score_reflection"
  | "router_fallback"
  | "clarification_requested"
  | "collaboration_await_user"
  | "collaboration_resumed"
  | "collaboration_partial_delivery"
  | "harness_pass"
  | "harness_fail"
  | "skill_verified"
  | "skill_failed";

export interface EvolutionSignal {
  kind: EvolutionSignalKind;
  weight: number;
  source: "task" | "audit" | "harness" | "skill";
  sourceKey?: string | undefined;
  taskId?: string | undefined;
  sessionId?: string | undefined;
  roleId?: string | undefined;
  templateId?: string | undefined;
  skillId?: string | undefined;
  suite?: string | undefined;
  summary: string;
  createdAt: string;
  context?: Record<string, unknown> | undefined;
}

export type EvolutionProposalKind =
  | "workspace_preference"
  | "router_bias"
  | "template_trigger"
  | "role_prompt"
  | "skill_recommendation"
  | "intake_policy"
  | "collaboration_policy";

export interface EvolutionProposal {
  id: string;
  kind: EvolutionProposalKind;
  risk: "low" | "medium" | "high";
  summary: string;
  patch: Record<string, unknown>;
  sourceSignalKinds: EvolutionSignalKind[];
  status: "proposed" | "applied" | "rejected";
  createdAt: string;
  appliedAt?: string | undefined;
}

export interface EvolutionState {
  version: 1;
  signals: EvolutionSignal[];
  proposals: EvolutionProposal[];
  appliedChanges: Array<{
    id: string;
    proposalId: string;
    kind: EvolutionProposalKind;
    before: unknown;
    after: unknown;
    appliedAt: string;
  }>;
  updatedAt: string;
}

const EVOLUTION_STATE_KEY = "evolution-state";
const MAX_SIGNALS = 500;
const MAX_PROPOSALS = 100;

type EvolutionStore = Pick<
  VinkoStore,
  | "getConfigEntry"
  | "setConfigEntry"
  | "appendAuditEvent"
  | "getWorkspaceMemory"
  | "setWorkspacePreferences"
  | "getRuntimeConfig"
  | "patchRuntimeConfig"
>;

function now(): string {
  return new Date().toISOString();
}

function createEmptyState(): EvolutionState {
  return {
    version: 1,
    signals: [],
    proposals: [],
    appliedChanges: [],
    updatedAt: now()
  };
}

function normalizeState(raw: EvolutionState | undefined): EvolutionState {
  if (!raw || raw.version !== 1) {
    return createEmptyState();
  }
  return {
    version: 1,
    signals: Array.isArray(raw.signals) ? raw.signals.slice(-MAX_SIGNALS) : [],
    proposals: Array.isArray(raw.proposals) ? raw.proposals.slice(-MAX_PROPOSALS) : [],
    appliedChanges: Array.isArray(raw.appliedChanges) ? raw.appliedChanges.slice(-MAX_PROPOSALS) : [],
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : now()
  };
}

export function getEvolutionState(store: { getConfigEntry: <T>(key: string) => T | undefined }): EvolutionState {
  return normalizeState(store.getConfigEntry<EvolutionState>(EVOLUTION_STATE_KEY));
}

function saveEvolutionState(store: Pick<VinkoStore, "setConfigEntry">, state: EvolutionState): EvolutionState {
  const next = {
    ...state,
    signals: state.signals.slice(-MAX_SIGNALS),
    proposals: state.proposals.slice(-MAX_PROPOSALS),
    appliedChanges: state.appliedChanges.slice(-MAX_PROPOSALS),
    updatedAt: now()
  };
  store.setConfigEntry(EVOLUTION_STATE_KEY, next);
  return next;
}

function reflectionScore(reflection: ReflectionNote | undefined): number {
  return Number(reflection?.score ?? 0);
}

function excerptText(value: string | undefined, max = 120): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) {
    return "";
  }
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function firstOriginalInstruction(task: TaskRecord): string | undefined {
  const candidates = [
    typeof task.metadata?.originalInstruction === "string" ? task.metadata.originalInstruction : "",
    typeof task.metadata?.founderWorkflowOriginalInstruction === "string" ? task.metadata.founderWorkflowOriginalInstruction : "",
    typeof task.metadata?.inboundText === "string" ? task.metadata.inboundText : "",
    task.instruction
  ]
    .map((entry) => String(entry ?? "").trim())
    .filter(Boolean);
  return candidates[0];
}

function clampRouterThreshold(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 0.75;
  }
  return Math.max(0.3, Math.min(0.98, parsed));
}

function patchRuntimeConfigSafely(
  store: EvolutionStore,
  mutator: (config: NonNullable<ReturnType<NonNullable<EvolutionStore["getRuntimeConfig"]>>>) => void
): void {
  if (typeof store.patchRuntimeConfig === "function") {
    store.patchRuntimeConfig((config) => {
      mutator(config);
      return config;
    });
    return;
  }

  if (typeof store.getRuntimeConfig === "function") {
    const current = structuredClone(store.getRuntimeConfig());
    mutator(current);
    store.setConfigEntry("runtime-config", current);
  }
}

function getRouterConfigSnapshot(store: EvolutionStore): {
  confidenceThreshold: number;
  preferValidatedFallbacks: boolean;
  templateHints: Array<{
    templateId: string;
    phrases: string[];
    source: string;
    updatedAt: string;
  }>;
} {
  const runtimeConfig = typeof store.getRuntimeConfig === "function" ? store.getRuntimeConfig() : undefined;
  const router = runtimeConfig?.evolution?.router;
  return {
    confidenceThreshold: clampRouterThreshold(router?.confidenceThreshold ?? 0.75),
    preferValidatedFallbacks: router?.preferValidatedFallbacks === true,
    templateHints: Array.isArray(router?.templateHints) ? structuredClone(router.templateHints) : []
  };
}

function getSkillRecommendationSnapshot(store: EvolutionStore): Array<{
  roleId: RoleId;
  skillId: string;
  reason: string;
  scoreBoost: number;
  updatedAt: string;
}> {
  const runtimeConfig = typeof store.getRuntimeConfig === "function" ? store.getRuntimeConfig() : undefined;
  return Array.isArray(runtimeConfig?.evolution?.skills?.recommendations)
    ? structuredClone(runtimeConfig.evolution.skills.recommendations)
    : [];
}

function getIntakePolicySnapshot(store: EvolutionStore): {
  preferClarificationForShortVagueRequests: boolean;
  shortVagueRequestMaxLength: number;
  directConversationMaxLength: number;
  ambiguousConversationMaxLength: number;
  collaborationMinLength: number;
  requireExplicitTeamSignal: boolean;
} {
  const runtimeConfig = typeof store.getRuntimeConfig === "function" ? store.getRuntimeConfig() : undefined;
  const intake = runtimeConfig?.evolution?.intake;
  return {
    preferClarificationForShortVagueRequests: intake?.preferClarificationForShortVagueRequests === true,
    shortVagueRequestMaxLength: normalizeLengthValue(intake?.shortVagueRequestMaxLength, 24, 4, 120),
    directConversationMaxLength: normalizeLengthValue(intake?.directConversationMaxLength, 24, 8, 120),
    ambiguousConversationMaxLength: normalizeLengthValue(intake?.ambiguousConversationMaxLength, 32, 8, 160),
    collaborationMinLength: normalizeLengthValue(intake?.collaborationMinLength, 40, 12, 240),
    requireExplicitTeamSignal: intake?.requireExplicitTeamSignal !== false
  };
}

function getCollaborationPolicySnapshot(store: EvolutionStore): {
  partialDeliveryMinCompletedRoles: number;
  timeoutNoProgressMode: "await_user" | "blocked";
  terminalFailureNoProgressMode: "await_user" | "blocked";
  manualResumeAggregationMode: "deliver" | "partial";
} {
  const runtimeConfig = typeof store.getRuntimeConfig === "function" ? store.getRuntimeConfig() : undefined;
  const collaboration = runtimeConfig?.evolution?.collaboration;
  return {
    partialDeliveryMinCompletedRoles: normalizeLengthValue(collaboration?.partialDeliveryMinCompletedRoles, 1, 1, 8),
    timeoutNoProgressMode: collaboration?.timeoutNoProgressMode === "blocked" ? "blocked" : "await_user",
    terminalFailureNoProgressMode:
      collaboration?.terminalFailureNoProgressMode === "await_user" ? "await_user" : "blocked",
    manualResumeAggregationMode: collaboration?.manualResumeAggregationMode === "partial" ? "partial" : "deliver"
  };
}

function normalizeLengthValue(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

export function extractEvolutionSignalsFromTask(task: TaskRecord): EvolutionSignal[] {
  const signals: EvolutionSignal[] = [];
  const originalInstruction = firstOriginalInstruction(task);
  const base = {
    source: "task" as const,
    taskId: task.id,
    sessionId: task.sessionId,
    roleId: task.roleId,
    templateId:
      typeof task.metadata?.templateId === "string"
        ? task.metadata.templateId
        : typeof task.metadata?.routeTemplateId === "string"
          ? task.metadata.routeTemplateId
          : undefined,
    createdAt: now(),
    context: {
      ...(originalInstruction ? { originalInstruction: excerptText(originalInstruction, 220) } : {}),
      ...(typeof task.metadata?.routeTemplateName === "string" ? { templateName: task.metadata.routeTemplateName } : {})
    }
  };

  if (task.status === "completed") {
    signals.push({
      ...base,
      kind: "task_completed",
      weight: 1,
      sourceKey: `task:${task.id}:completed`,
      summary: task.result?.summary || `Task completed by ${task.roleId}`
    });
  }
  if (task.status === "failed") {
    signals.push({
      ...base,
      kind: "task_failed",
      weight: -2,
      sourceKey: `task:${task.id}:failed`,
      summary: task.errorText || `Task failed by ${task.roleId}`
    });
  }

  const score = reflectionScore(task.reflection);
  if (task.reflection?.confidence === "low" || (score > 0 && score < 5)) {
    signals.push({
      ...base,
      kind: "low_confidence_reflection",
      weight: -1,
      sourceKey: `task:${task.id}:low_confidence_reflection`,
      summary: task.reflection?.improvements?.[0] ?? "Reflection confidence is low"
    });
  }
  if (score >= 8 && task.reflection?.confidence === "high") {
    signals.push({
      ...base,
      kind: "high_score_reflection",
      weight: 1,
      sourceKey: `task:${task.id}:high_score_reflection`,
      summary: "Reflection score is high"
    });
  }

  return signals;
}

export function extractEvolutionSignalFromAudit(event: AuditEventRecord): EvolutionSignal | undefined {
  if (event.category === "intake" && event.payload?.reason === "clarification_requested") {
    return {
      kind: "clarification_requested",
      weight: 1,
      source: "audit",
      sourceKey: `audit:${event.id}:clarification_requested`,
      sessionId: event.entityType === "session" ? event.entityId : undefined,
      summary: String(event.message || "Clarification was requested before execution"),
      createdAt: event.createdAt,
      context: {
        ...(typeof event.payload.textPreview === "string" ? { textPreview: event.payload.textPreview } : {}),
        ...(Array.isArray(event.payload.questions) ? { questionCount: event.payload.questions.length } : {})
      }
    };
  }
  if (event.category === "collaboration") {
    const reason = typeof event.payload?.reason === "string" ? event.payload.reason : "";
    if (reason === "await_user") {
      return {
        kind: "collaboration_await_user",
        weight: -1,
        source: "audit",
        sourceKey: `audit:${event.id}:collaboration_await_user`,
        taskId: typeof event.payload.parentTaskId === "string" ? event.payload.parentTaskId : undefined,
        sessionId: event.entityType === "session" ? event.entityId : undefined,
        summary: String(event.message || "Collaboration paused for user input"),
        createdAt: event.createdAt,
        context: {
          ...(typeof event.payload.triggerReason === "string" ? { triggerReason: event.payload.triggerReason } : {}),
          ...(typeof event.payload.completedCount === "number" ? { completedCount: event.payload.completedCount } : {})
        }
      };
    }
    if (reason === "resumed") {
      return {
        kind: "collaboration_resumed",
        weight: 1,
        source: "audit",
        sourceKey: `audit:${event.id}:collaboration_resumed`,
        taskId: typeof event.payload.parentTaskId === "string" ? event.payload.parentTaskId : undefined,
        sessionId: event.entityType === "session" ? event.entityId : undefined,
        summary: String(event.message || "Collaboration resumed after user input"),
        createdAt: event.createdAt,
        context: {
          ...(typeof event.payload.supplementCount === "number" ? { supplementCount: event.payload.supplementCount } : {})
        }
      };
    }
    if (reason === "partial_delivery") {
      return {
        kind: "collaboration_partial_delivery",
        weight: 1,
        source: "audit",
        sourceKey: `audit:${event.id}:collaboration_partial_delivery`,
        taskId: typeof event.payload.parentTaskId === "string" ? event.payload.parentTaskId : undefined,
        sessionId: event.entityType === "session" ? event.entityId : undefined,
        summary: String(event.message || "Collaboration produced a usable partial delivery"),
        createdAt: event.createdAt,
        context: {
          ...(typeof event.payload.completedCount === "number" ? { completedCount: event.payload.completedCount } : {}),
          ...(typeof event.payload.failedCount === "number" ? { failedCount: event.payload.failedCount } : {})
        }
      };
    }
  }
  if (event.category !== "inbound-routing" && event.category !== "template-routing") {
    return undefined;
  }
  if (event.payload?.fallbackReason || event.payload?.decisionSource === "fallback") {
    return {
      kind: "router_fallback",
      weight: -1,
      source: "audit",
      sourceKey: `audit:${event.id}:router_fallback`,
      sessionId: event.entityType === "session" ? event.entityId : undefined,
      templateId: typeof event.payload.templateId === "string" ? event.payload.templateId : undefined,
      summary: String(event.payload.fallbackReason ?? event.message),
      createdAt: event.createdAt,
      context: {
        ...(typeof event.payload.textPreview === "string" ? { textPreview: event.payload.textPreview } : {}),
        ...(typeof event.payload.reason === "string" ? { reason: event.payload.reason } : {})
      }
    };
  }
  return undefined;
}

export function extractEvolutionSignalFromSkillVerification(input: {
  task: TaskRecord;
  skillId: string;
  verificationStatus: "verified" | "failed";
}): EvolutionSignal {
  const skillId = input.skillId.trim();
  return {
    kind: input.verificationStatus === "verified" ? "skill_verified" : "skill_failed",
    weight: input.verificationStatus === "verified" ? 1 : -1,
    source: "skill",
    sourceKey: `skill:${input.task.id}:${input.task.roleId}:${skillId}:${input.verificationStatus}`,
    taskId: input.task.id,
    sessionId: input.task.sessionId,
    roleId: input.task.roleId,
    skillId,
    summary:
      input.verificationStatus === "verified"
        ? `Skill ${skillId} verified on ${input.task.roleId}`
        : `Skill ${skillId} verification failed on ${input.task.roleId}`,
    createdAt: now(),
    context: {
      verificationStatus: input.verificationStatus
    }
  };
}

export function extractEvolutionSignalFromHarnessGrade(grade: GoalRunHarnessGradeRecord): EvolutionSignal | undefined {
  if (grade.grade !== "pass" && grade.grade !== "fail" && grade.grade !== "warn") {
    return undefined;
  }
  return {
    kind: grade.grade === "pass" ? "harness_pass" : "harness_fail",
    weight: grade.grade === "pass" ? 1 : -2,
    source: "harness",
    sourceKey: `harness:${grade.suite}:${grade.generatedAt}:${grade.grade}`,
    suite: grade.suite,
    summary: grade.failedInvariant || grade.traceSummary || `${grade.suite} ${grade.grade}`,
    createdAt: grade.generatedAt,
    context: {
      grade: grade.grade,
      handoffCoverage: grade.handoffCoverage,
      approvalCoverage: grade.approvalCoverage,
      resumeCoverage: grade.resumeCoverage,
      stateCompleteness: grade.stateCompleteness
    }
  };
}

function proposalId(kind: EvolutionProposalKind, summary: string): string {
  return `${kind}:${summary.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-").slice(0, 48)}`;
}

function stripPromptPrefix(text: string): string {
  return text
    .replace(/^(请你|请帮我|帮我|请|我想要|我想|需要你|需要|想让你)\s*/i, "")
    .trim();
}

function extractTemplateHintPhrases(text: string): string[] {
  const normalized = stripPromptPrefix(text)
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (!normalized) {
    return [];
  }
  const clauses = normalized
    .split(/[\n\r,，。！？!?:：;；]/g)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => stripPromptPrefix(entry))
    .filter(Boolean)
    .map((entry) => entry.slice(0, 24).trim())
    .filter((entry) => entry.length >= 2);
  const candidates = clauses.length > 0 ? clauses : [normalized.slice(0, 24)];
  return Array.from(new Set(candidates)).slice(0, 3);
}

function inferRecommendedSkill(signal: EvolutionSignal): { roleId: RoleId; skillId: string; reason: string } | undefined {
  const roleId = signal.roleId as RoleId | undefined;
  if (!roleId) {
    return undefined;
  }
  const templateId = signal.templateId ?? "";
  const originalInstruction = String(signal.context?.originalInstruction ?? "").toLowerCase();
  if ((roleId === "product" || roleId === "ceo") && /prd/.test(templateId)) {
    return { roleId, skillId: "prd-writer", reason: "Repeated PRD-style delivery succeeded." };
  }
  if (roleId === "research" || /research|调研|competitor/.test(templateId) || /调研|研究|竞品|市场/.test(originalInstruction)) {
    return { roleId, skillId: "web-search", reason: "Research-style work benefits from fresh external context." };
  }
  if (["frontend", "backend", "developer", "engineering", "algorithm"].includes(roleId)) {
    return { roleId, skillId: "code-executor", reason: "Technical delivery repeatedly requires executable code work." };
  }
  return undefined;
}

function mergeTemplateHints(
  current: Array<{
    templateId: string;
    phrases: string[];
    source: string;
    updatedAt: string;
  }>,
  incoming: Array<{
    templateId: string;
    phrases: string[];
    source: string;
    updatedAt: string;
  }>
): Array<{
  templateId: string;
  phrases: string[];
  source: string;
  updatedAt: string;
}> {
  const merged = new Map<string, { templateId: string; phrases: string[]; source: string; updatedAt: string }>();
  for (const entry of current) {
    merged.set(entry.templateId, {
      ...entry,
      phrases: Array.from(new Set(entry.phrases.map((phrase) => phrase.trim().toLowerCase()).filter(Boolean))).slice(0, 12)
    });
  }
  for (const entry of incoming) {
    const existing = merged.get(entry.templateId);
    const phrases = Array.from(
      new Set([...(existing?.phrases ?? []), ...entry.phrases.map((phrase) => phrase.trim().toLowerCase())].filter(Boolean))
    ).slice(0, 12);
    merged.set(entry.templateId, {
      templateId: entry.templateId,
      phrases,
      source: entry.source,
      updatedAt: entry.updatedAt
    });
  }
  return Array.from(merged.values()).sort((left, right) => left.templateId.localeCompare(right.templateId));
}

function mergeSkillRecommendations(
  current: Array<{
    roleId: RoleId;
    skillId: string;
    reason: string;
    scoreBoost: number;
    updatedAt: string;
  }>,
  incoming: Array<{
    roleId: RoleId;
    skillId: string;
    reason: string;
    scoreBoost: number;
    updatedAt: string;
  }>
): Array<{
  roleId: RoleId;
  skillId: string;
  reason: string;
  scoreBoost: number;
  updatedAt: string;
}> {
  const merged = new Map<string, { roleId: RoleId; skillId: string; reason: string; scoreBoost: number; updatedAt: string }>();
  for (const entry of current) {
    merged.set(`${entry.roleId}:${entry.skillId}`, entry);
  }
  for (const entry of incoming) {
    const key = `${entry.roleId}:${entry.skillId}`;
    const existing = merged.get(key);
    merged.set(key, {
      roleId: entry.roleId,
      skillId: entry.skillId,
      reason: entry.reason || existing?.reason || "",
      scoreBoost: Math.max(existing?.scoreBoost ?? 0, entry.scoreBoost),
      updatedAt: entry.updatedAt
    });
  }
  return Array.from(merged.values()).sort((left, right) =>
    `${left.roleId}:${left.skillId}`.localeCompare(`${right.roleId}:${right.skillId}`)
  );
}

export function generateEvolutionProposals(signals: EvolutionSignal[]): EvolutionProposal[] {
  const proposals: EvolutionProposal[] = [];
  const routerFallbacks = signals.filter((signal) => signal.kind === "router_fallback");
  if (routerFallbacks.length >= 3) {
    const summary = "Router V2 fallback rate is high; add route examples and bias toward validated legacy winners.";
    proposals.push({
      id: proposalId("router_bias", summary),
      kind: "router_bias",
      risk: "low",
      summary,
      patch: {
        runtimeConfig: {
          evolution: {
            router: {
              preferValidatedFallbacks: true,
              confidenceThreshold: 0.68,
              fallbackSignalCount: routerFallbacks.length
            }
          }
        }
      },
      sourceSignalKinds: ["router_fallback"],
      status: "proposed",
      createdAt: now()
    });
  }

  const lowConfidence = signals.filter((signal) => signal.kind === "low_confidence_reflection");
  if (lowConfidence.length >= 2) {
    const summary = "Recent tasks show low confidence; prefer concise clarification before execution.";
    proposals.push({
      id: proposalId("workspace_preference", summary),
      kind: "workspace_preference",
      risk: "low",
      summary,
      patch: {
        userPreferences: {
          communicationStyle: "concise"
        },
        intake: {
          preferClarificationForLowConfidencePatterns: true
        }
      },
      sourceSignalKinds: ["low_confidence_reflection"],
      status: "proposed",
      createdAt: now()
    });
  }

  const clarificationSignals = signals.filter((signal) => signal.kind === "clarification_requested");
  if (clarificationSignals.length >= 2) {
    const summary = "Recent intake often needs clarification first; strengthen clarification-first behavior for short vague requests.";
    proposals.push({
      id: proposalId("intake_policy", summary),
      kind: "intake_policy",
      risk: "low",
      summary,
      patch: {
        runtimeConfig: {
          evolution: {
            intake: {
              preferClarificationForShortVagueRequests: true,
              shortVagueRequestMaxLength: 36,
              directConversationMaxLength: 20,
              ambiguousConversationMaxLength: 40,
              requireExplicitTeamSignal: true
            }
          }
        }
      },
      sourceSignalKinds: ["clarification_requested"],
      status: "proposed",
      createdAt: now()
    });
  }

  if (routerFallbacks.length >= 2 && lowConfidence.length >= 2) {
    const summary = "Fallbacks and low-confidence tasks are clustering; increase collaboration conservatism and tighten conversation shortcuts.";
    proposals.push({
      id: proposalId("intake_policy", `${summary}:${routerFallbacks.length}:${lowConfidence.length}`),
      kind: "intake_policy",
      risk: "low",
      summary,
      patch: {
        runtimeConfig: {
          evolution: {
            intake: {
              collaborationMinLength: 56,
              directConversationMaxLength: 18,
              requireExplicitTeamSignal: true
            }
          }
        }
      },
      sourceSignalKinds: ["router_fallback", "low_confidence_reflection"],
      status: "proposed",
      createdAt: now()
    });
  }

  const collaborationAwaitUserSignals = signals.filter((signal) => signal.kind === "collaboration_await_user");
  const collaborationResumedSignals = signals.filter((signal) => signal.kind === "collaboration_resumed");
  const collaborationPartialSignals = signals.filter((signal) => signal.kind === "collaboration_partial_delivery");

  if (collaborationAwaitUserSignals.length >= 2) {
    const summary = "Collaborations often pause waiting for user input; prefer await_user instead of hard blocking when no branch completed.";
    proposals.push({
      id: proposalId("collaboration_policy", summary),
      kind: "collaboration_policy",
      risk: "low",
      summary,
      patch: {
        runtimeConfig: {
          evolution: {
            collaboration: {
              timeoutNoProgressMode: "await_user",
              terminalFailureNoProgressMode: "await_user"
            }
          }
        }
      },
      sourceSignalKinds: ["collaboration_await_user"],
      status: "proposed",
      createdAt: now()
    });
  }

  if (collaborationResumedSignals.length >= 2) {
    const summary = "Users often resume collaboration with enough context; prefer deliver mode after manual resume.";
    proposals.push({
      id: proposalId("collaboration_policy", summary),
      kind: "collaboration_policy",
      risk: "low",
      summary,
      patch: {
        runtimeConfig: {
          evolution: {
            collaboration: {
              manualResumeAggregationMode: "deliver"
            }
          }
        }
      },
      sourceSignalKinds: ["collaboration_resumed"],
      status: "proposed",
      createdAt: now()
    });
  }

  if (collaborationPartialSignals.length >= 2) {
    const summary = "Partial collaboration outputs are often usable; lower the completed-role threshold for partial delivery.";
    proposals.push({
      id: proposalId("collaboration_policy", summary),
      kind: "collaboration_policy",
      risk: "low",
      summary,
      patch: {
        runtimeConfig: {
          evolution: {
            collaboration: {
              partialDeliveryMinCompletedRoles: 1
            }
          }
        }
      },
      sourceSignalKinds: ["collaboration_partial_delivery"],
      status: "proposed",
      createdAt: now()
    });
  }

  const successfulTemplateSignals = signals.filter(
    (signal) =>
      (signal.kind === "task_completed" || signal.kind === "high_score_reflection") &&
      typeof signal.templateId === "string" &&
      typeof signal.context?.originalInstruction === "string"
  );
  const templatePhraseBuckets = new Map<string, Map<string, number>>();
  for (const signal of successfulTemplateSignals) {
    const templateId = signal.templateId!;
    const originalInstruction = String(signal.context?.originalInstruction ?? "").trim();
    if (!originalInstruction) {
      continue;
    }
    const bucket = templatePhraseBuckets.get(templateId) ?? new Map<string, number>();
    for (const phrase of extractTemplateHintPhrases(originalInstruction)) {
      bucket.set(phrase, (bucket.get(phrase) ?? 0) + 1);
    }
    templatePhraseBuckets.set(templateId, bucket);
  }
  for (const [templateId, bucket] of templatePhraseBuckets.entries()) {
    const phrases = Array.from(bucket.entries())
      .filter(([, count]) => count >= 2)
      .sort((left, right) => right[1] - left[1] || right[0].length - left[0].length)
      .slice(0, 3)
      .map(([phrase]) => phrase);
    if (phrases.length === 0) {
      continue;
    }
    proposals.push({
      id: proposalId("template_trigger", `${templateId}:${phrases.join("|")}`),
      kind: "template_trigger",
      risk: "low",
      summary: `Learned reusable route hints for ${templateId}: ${phrases.join(", ")}`,
      patch: {
        runtimeConfig: {
          evolution: {
            router: {
              templateHints: [
                {
                  templateId,
                  phrases,
                  source: "evolution_template_success",
                  updatedAt: now()
                }
              ]
            }
          }
        }
      },
      sourceSignalKinds: ["task_completed", "high_score_reflection"],
      status: "proposed",
      createdAt: now()
    });
  }

  const skillBuckets = new Map<string, { roleId: RoleId; skillId: string; reason: string; count: number }>();
  for (const signal of signals) {
    if (signal.kind !== "task_completed" && signal.kind !== "high_score_reflection") {
      continue;
    }
    const recommendation = inferRecommendedSkill(signal);
    if (!recommendation) {
      continue;
    }
    const key = `${recommendation.roleId}:${recommendation.skillId}`;
    const existing = skillBuckets.get(key);
    skillBuckets.set(key, {
      ...recommendation,
      count: (existing?.count ?? 0) + 1
    });
  }
  for (const entry of skillBuckets.values()) {
    if (entry.count < 2) {
      continue;
    }
    proposals.push({
      id: proposalId("skill_recommendation", `${entry.roleId}:${entry.skillId}`),
      kind: "skill_recommendation",
      risk: "low",
      summary: `Recommend ${entry.skillId} for ${entry.roleId} based on repeated successful work.`,
      patch: {
        runtimeConfig: {
          evolution: {
            skills: {
              recommendations: [
                {
                  roleId: entry.roleId,
                  skillId: entry.skillId,
                  reason: entry.reason,
                  scoreBoost: 40,
                  updatedAt: now()
                }
              ]
            }
          }
        }
      },
      sourceSignalKinds: ["task_completed", "high_score_reflection"],
      status: "proposed",
      createdAt: now()
    });
  }

  return proposals;
}

export function recordEvolutionSignals(
  store: EvolutionStore,
  signals: EvolutionSignal[]
): EvolutionState {
  const state = getEvolutionState(store);
  if (signals.length === 0) {
    return state;
  }

  const existingKeys = new Set(
    state.signals
      .map((signal) => (typeof signal.sourceKey === "string" ? signal.sourceKey : ""))
      .filter(Boolean)
  );
  const seenIncomingKeys = new Set<string>();
  const uniqueSignals = signals.filter((signal) => {
    const key = typeof signal.sourceKey === "string" ? signal.sourceKey : "";
    if (!key) {
      return true;
    }
    if (existingKeys.has(key) || seenIncomingKeys.has(key)) {
      return false;
    }
    seenIncomingKeys.add(key);
    return true;
  });
  if (uniqueSignals.length === 0) {
    return state;
  }

  const nextSignals = [...state.signals, ...uniqueSignals];
  const existingProposalIds = new Set(state.proposals.map((proposal) => proposal.id));
  const proposals = generateEvolutionProposals(nextSignals).filter((proposal) => !existingProposalIds.has(proposal.id));
  const next = saveEvolutionState(store, {
    ...state,
    signals: nextSignals,
    proposals: [...state.proposals, ...proposals]
  });
  store.appendAuditEvent({
    category: "evolution",
    entityType: "evolution",
    entityId: "state",
    message: `Recorded ${uniqueSignals.length} evolution signal(s)`,
    payload: {
      eventType: "evolution_signals_recorded",
      signalKinds: uniqueSignals.map((signal) => signal.kind),
      proposalIds: proposals.map((proposal) => proposal.id)
    }
  });
  return next;
}

export function applyLowRiskEvolutionProposals(store: EvolutionStore): EvolutionState {
  const state = getEvolutionState(store);
  let nextState = state;
  for (const proposal of state.proposals) {
    if (proposal.status !== "proposed" || proposal.risk !== "low") {
      continue;
    }

    let before: unknown = undefined;
    if (proposal.kind === "workspace_preference") {
      before = {
        userPreferences: structuredClone(store.getWorkspaceMemory().userPreferences)
      };
      const prefs = (proposal.patch.userPreferences ?? {}) as Record<string, unknown>;
      store.setWorkspacePreferences({
        ...(prefs.communicationStyle === "concise" || prefs.communicationStyle === "detailed" || prefs.communicationStyle === "default"
          ? { communicationStyle: prefs.communicationStyle }
          : {}),
        ...(prefs.preferredLanguage === "zh" || prefs.preferredLanguage === "en" || prefs.preferredLanguage === "default"
          ? { preferredLanguage: prefs.preferredLanguage }
          : {})
      });
    } else if (proposal.kind === "router_bias") {
      before = {
        runtimeConfig: {
          evolution: {
            router: getRouterConfigSnapshot(store)
          }
        }
      };
      const runtimePatch = (proposal.patch.runtimeConfig ?? {}) as Record<string, unknown>;
      const evolutionPatch = (runtimePatch.evolution ?? {}) as Record<string, unknown>;
      const routerPatch = (evolutionPatch.router ?? {}) as Record<string, unknown>;
      patchRuntimeConfigSafely(store, (config) => {
        config.evolution.router.preferValidatedFallbacks =
          routerPatch.preferValidatedFallbacks === true || config.evolution.router.preferValidatedFallbacks;
        if (routerPatch.confidenceThreshold !== undefined) {
          config.evolution.router.confidenceThreshold = clampRouterThreshold(routerPatch.confidenceThreshold);
        }
      });
    } else if (proposal.kind === "template_trigger") {
      before = {
        runtimeConfig: {
          evolution: {
            router: {
              templateHints: getRouterConfigSnapshot(store).templateHints
            }
          }
        }
      };
      const runtimePatch = (proposal.patch.runtimeConfig ?? {}) as Record<string, unknown>;
      const evolutionPatch = (runtimePatch.evolution ?? {}) as Record<string, unknown>;
      const routerPatch = (evolutionPatch.router ?? {}) as Record<string, unknown>;
      const incomingHints = Array.isArray(routerPatch.templateHints)
        ? routerPatch.templateHints
            .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object"))
            .map((entry) => ({
              templateId: String(entry.templateId ?? "").trim(),
              phrases: Array.isArray(entry.phrases)
                ? entry.phrases
                    .filter((item): item is string => typeof item === "string")
                    .map((item) => item.trim().toLowerCase())
                    .filter(Boolean)
                : [],
              source: typeof entry.source === "string" ? entry.source.trim() : "evolution",
              updatedAt: typeof entry.updatedAt === "string" && entry.updatedAt.trim() ? entry.updatedAt : now()
            }))
            .filter((entry) => entry.templateId && entry.phrases.length > 0)
        : [];
      if (incomingHints.length > 0) {
        patchRuntimeConfigSafely(store, (config) => {
          config.evolution.router.templateHints = mergeTemplateHints(config.evolution.router.templateHints, incomingHints);
        });
      }
    } else if (proposal.kind === "skill_recommendation") {
      before = {
        runtimeConfig: {
          evolution: {
            skills: {
              recommendations: getSkillRecommendationSnapshot(store)
            }
          }
        }
      };
      const runtimePatch = (proposal.patch.runtimeConfig ?? {}) as Record<string, unknown>;
      const evolutionPatch = (runtimePatch.evolution ?? {}) as Record<string, unknown>;
      const skillsPatch = (evolutionPatch.skills ?? {}) as Record<string, unknown>;
      const incomingRecommendations = Array.isArray(skillsPatch.recommendations)
        ? skillsPatch.recommendations
            .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object"))
            .map((entry) => ({
              roleId: entry.roleId as RoleId,
              skillId: String(entry.skillId ?? "").trim(),
              reason: typeof entry.reason === "string" ? entry.reason.trim() : "",
              scoreBoost: Number.isFinite(Number(entry.scoreBoost)) ? Math.max(1, Math.min(200, Math.round(Number(entry.scoreBoost)))) : 30,
              updatedAt: typeof entry.updatedAt === "string" && entry.updatedAt.trim() ? entry.updatedAt : now()
            }))
            .filter((entry) => typeof entry.roleId === "string" && entry.skillId)
        : [];
      if (incomingRecommendations.length > 0) {
        patchRuntimeConfigSafely(store, (config) => {
          config.evolution.skills.recommendations = mergeSkillRecommendations(
            config.evolution.skills.recommendations,
            incomingRecommendations
          );
        });
      }
    } else if (proposal.kind === "intake_policy") {
      before = {
        runtimeConfig: {
          evolution: {
            intake: getIntakePolicySnapshot(store)
          }
        }
      };
      const runtimePatch = (proposal.patch.runtimeConfig ?? {}) as Record<string, unknown>;
      const evolutionPatch = (runtimePatch.evolution ?? {}) as Record<string, unknown>;
      const intakePatch = (evolutionPatch.intake ?? {}) as Record<string, unknown>;
      patchRuntimeConfigSafely(store, (config) => {
        if (intakePatch.preferClarificationForShortVagueRequests !== undefined) {
          config.evolution.intake.preferClarificationForShortVagueRequests =
            intakePatch.preferClarificationForShortVagueRequests === true;
        }
        if (intakePatch.shortVagueRequestMaxLength !== undefined) {
          config.evolution.intake.shortVagueRequestMaxLength = normalizeLengthValue(
            intakePatch.shortVagueRequestMaxLength,
            config.evolution.intake.shortVagueRequestMaxLength,
            4,
            120
          );
        }
        if (intakePatch.directConversationMaxLength !== undefined) {
          config.evolution.intake.directConversationMaxLength = normalizeLengthValue(
            intakePatch.directConversationMaxLength,
            config.evolution.intake.directConversationMaxLength,
            8,
            120
          );
        }
        if (intakePatch.ambiguousConversationMaxLength !== undefined) {
          config.evolution.intake.ambiguousConversationMaxLength = normalizeLengthValue(
            intakePatch.ambiguousConversationMaxLength,
            config.evolution.intake.ambiguousConversationMaxLength,
            config.evolution.intake.directConversationMaxLength,
            160
          );
        }
        if (intakePatch.collaborationMinLength !== undefined) {
          config.evolution.intake.collaborationMinLength = normalizeLengthValue(
            intakePatch.collaborationMinLength,
            config.evolution.intake.collaborationMinLength,
            12,
            240
          );
        }
        if (intakePatch.requireExplicitTeamSignal !== undefined) {
          config.evolution.intake.requireExplicitTeamSignal = intakePatch.requireExplicitTeamSignal !== false;
        }
      });
    } else if (proposal.kind === "collaboration_policy") {
      before = {
        runtimeConfig: {
          evolution: {
            collaboration: getCollaborationPolicySnapshot(store)
          }
        }
      };
      const runtimePatch = (proposal.patch.runtimeConfig ?? {}) as Record<string, unknown>;
      const evolutionPatch = (runtimePatch.evolution ?? {}) as Record<string, unknown>;
      const collaborationPatch = (evolutionPatch.collaboration ?? {}) as Record<string, unknown>;
      patchRuntimeConfigSafely(store, (config) => {
        if (collaborationPatch.partialDeliveryMinCompletedRoles !== undefined) {
          config.evolution.collaboration.partialDeliveryMinCompletedRoles = normalizeLengthValue(
            collaborationPatch.partialDeliveryMinCompletedRoles,
            config.evolution.collaboration.partialDeliveryMinCompletedRoles,
            1,
            8
          );
        }
        if (collaborationPatch.timeoutNoProgressMode === "await_user" || collaborationPatch.timeoutNoProgressMode === "blocked") {
          config.evolution.collaboration.timeoutNoProgressMode = collaborationPatch.timeoutNoProgressMode;
        }
        if (
          collaborationPatch.terminalFailureNoProgressMode === "await_user" ||
          collaborationPatch.terminalFailureNoProgressMode === "blocked"
        ) {
          config.evolution.collaboration.terminalFailureNoProgressMode =
            collaborationPatch.terminalFailureNoProgressMode;
        }
        if (collaborationPatch.manualResumeAggregationMode === "deliver" || collaborationPatch.manualResumeAggregationMode === "partial") {
          config.evolution.collaboration.manualResumeAggregationMode = collaborationPatch.manualResumeAggregationMode;
        }
      });
    }

    const after =
      proposal.kind === "workspace_preference"
        ? {
            userPreferences: structuredClone(store.getWorkspaceMemory().userPreferences)
          }
        : proposal.kind === "router_bias"
          ? {
              runtimeConfig: {
                evolution: {
                  router: getRouterConfigSnapshot(store)
                }
              }
            }
          : proposal.kind === "template_trigger"
            ? {
                runtimeConfig: {
                  evolution: {
                    router: {
                      templateHints: getRouterConfigSnapshot(store).templateHints
                    }
                  }
                }
              }
            : proposal.kind === "skill_recommendation"
              ? {
                  runtimeConfig: {
                    evolution: {
                      skills: {
                        recommendations: getSkillRecommendationSnapshot(store)
                      }
                    }
                  }
                }
              : proposal.kind === "intake_policy"
                ? {
                    runtimeConfig: {
                      evolution: {
                        intake: getIntakePolicySnapshot(store)
                      }
                    }
                  }
                : proposal.kind === "collaboration_policy"
                  ? {
                      runtimeConfig: {
                        evolution: {
                          collaboration: getCollaborationPolicySnapshot(store)
                        }
                      }
                    }
              : undefined;

    const appliedAt = now();
    const changeId = `evo-change:${proposal.id}:${appliedAt}`;
    nextState = {
      ...nextState,
      proposals: nextState.proposals.map((entry) =>
        entry.id === proposal.id ? { ...entry, status: "applied", appliedAt } : entry
      ),
      appliedChanges: [
        ...nextState.appliedChanges,
        {
          id: changeId,
          proposalId: proposal.id,
          kind: proposal.kind,
          before,
          after,
          appliedAt
        }
      ]
    };
    store.appendAuditEvent({
      category: "evolution",
      entityType: "evolution_change",
      entityId: changeId,
      message: `Applied evolution proposal ${proposal.id}`,
      payload: {
        eventType: "evolution_change_applied",
        proposalId: proposal.id,
        kind: proposal.kind,
        risk: proposal.risk
      }
    });
  }
  return saveEvolutionState(store, nextState);
}

export function rollbackLatestEvolutionChange(store: EvolutionStore): EvolutionState {
  const state = getEvolutionState(store);
  const latest = state.appliedChanges[state.appliedChanges.length - 1];
  if (!latest) {
    return state;
  }

  if (latest.kind === "workspace_preference") {
    const before = latest.before as { userPreferences?: unknown };
    const prefs = before.userPreferences as Record<string, unknown> | undefined;
    if (prefs) {
      store.setWorkspacePreferences({
        ...(prefs.communicationStyle === "concise" || prefs.communicationStyle === "detailed" || prefs.communicationStyle === "default"
          ? { communicationStyle: prefs.communicationStyle }
          : {}),
        ...(prefs.preferredLanguage === "zh" || prefs.preferredLanguage === "en" || prefs.preferredLanguage === "default"
          ? { preferredLanguage: prefs.preferredLanguage }
          : {}),
        ...(Array.isArray(prefs.preferredTechStack)
          ? { preferredTechStack: prefs.preferredTechStack.filter((item): item is string => typeof item === "string") }
          : {})
      });
    }
  } else if (latest.kind === "router_bias") {
    const before = latest.before as {
      runtimeConfig?: {
        evolution?: {
          router?: {
            confidenceThreshold?: unknown;
            preferValidatedFallbacks?: unknown;
          };
        };
      };
    };
    const router = before.runtimeConfig?.evolution?.router;
    if (router) {
      patchRuntimeConfigSafely(store, (config) => {
        config.evolution.router.confidenceThreshold = clampRouterThreshold(router.confidenceThreshold);
        config.evolution.router.preferValidatedFallbacks = router.preferValidatedFallbacks === true;
      });
    }
  } else if (latest.kind === "template_trigger") {
    const before = latest.before as {
      runtimeConfig?: {
        evolution?: {
          router?: {
            templateHints?: unknown;
          };
        };
      };
    };
    const templateHints = before.runtimeConfig?.evolution?.router?.templateHints;
    if (Array.isArray(templateHints)) {
      patchRuntimeConfigSafely(store, (config) => {
        config.evolution.router.templateHints = structuredClone(templateHints) as typeof config.evolution.router.templateHints;
      });
    }
  } else if (latest.kind === "skill_recommendation") {
    const before = latest.before as {
      runtimeConfig?: {
        evolution?: {
          skills?: {
            recommendations?: unknown;
          };
        };
      };
    };
    const recommendations = before.runtimeConfig?.evolution?.skills?.recommendations;
    if (Array.isArray(recommendations)) {
      patchRuntimeConfigSafely(store, (config) => {
        config.evolution.skills.recommendations = structuredClone(recommendations) as typeof config.evolution.skills.recommendations;
      });
    }
  } else if (latest.kind === "intake_policy") {
    const before = latest.before as {
      runtimeConfig?: {
        evolution?: {
          intake?: unknown;
        };
      };
    };
    const intake = before.runtimeConfig?.evolution?.intake;
    if (intake && typeof intake === "object") {
      patchRuntimeConfigSafely(store, (config) => {
        config.evolution.intake = structuredClone(intake) as typeof config.evolution.intake;
      });
    }
  } else if (latest.kind === "collaboration_policy") {
    const before = latest.before as {
      runtimeConfig?: {
        evolution?: {
          collaboration?: unknown;
        };
      };
    };
    const collaboration = before.runtimeConfig?.evolution?.collaboration;
    if (collaboration && typeof collaboration === "object") {
      patchRuntimeConfigSafely(store, (config) => {
        config.evolution.collaboration = structuredClone(collaboration) as typeof config.evolution.collaboration;
      });
    }
  }

  const next = saveEvolutionState(store, {
    ...state,
    appliedChanges: state.appliedChanges.slice(0, -1),
    proposals: state.proposals.map((proposal) =>
      proposal.id === latest.proposalId ? { ...proposal, status: "proposed", appliedAt: undefined } : proposal
    )
  });
  store.appendAuditEvent({
    category: "evolution",
    entityType: "evolution_change",
    entityId: latest.id,
    message: `Rolled back evolution change ${latest.id}`,
    payload: {
      eventType: "evolution_change_rolled_back",
      proposalId: latest.proposalId,
      kind: latest.kind
    }
  });
  return next;
}

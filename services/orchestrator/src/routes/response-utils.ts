import {
  buildGoalRunWorkflowSummary,
  getSkillDefinition,
  normalizeOrchestrationState,
  summarizeGoalRun,
  type GoalRunRecord,
  type GoalRunStage,
  type TaskRecord,
  type VinkoStore
} from "@vinko/shared";
import { globalTelemetry } from "@vinko/agent-runtime";

type FailureCategory =
  | "none"
  | "input_required"
  | "authorization_required"
  | "approval"
  | "configuration"
  | "validation"
  | "execution_timeout"
  | "tool_provider"
  | "cancelled"
  | "runtime";

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === "string")
      .flatMap((entry) =>
        entry
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean)
      );
  }
  if (typeof value === "string" && value.trim()) {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return [];
}

function toBoolean(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1" || normalized === "yes") {
      return true;
    }
  }
  return false;
}

function parseIsoMs(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function percentile(sorted: number[], ratio: number): number | null {
  if (sorted.length === 0) {
    return null;
  }
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return Math.round(sorted[index] ?? 0);
}

function extractArtifactFilesFromText(text: string): string[] {
  if (!text.trim()) {
    return [];
  }
  const matched: string[] = [];
  const changedFilesPattern = /CHANGED_FILES\s*:\s*([^\n]+)/gi;
  for (const match of text.matchAll(changedFilesPattern)) {
    const group = (match[1] ?? "").trim();
    if (!group) {
      continue;
    }
    for (const item of group.split(/[,\s]+/)) {
      const normalized = item.trim().replace(/^\.?\//, "");
      if (!normalized) {
        continue;
      }
      if (/\.[a-z0-9]{1,8}$/i.test(normalized)) {
        matched.push(normalized);
      }
    }
  }
  const genericPattern = /(?:^|[\s`"'(:：])((?:\.{0,2}\/)?(?:[\w.-]+\/)*[\w.-]+\.([a-zA-Z][a-zA-Z0-9]{0,7}))(?=$|[\s`"'),:;])/g;
  for (const match of text.matchAll(genericPattern)) {
    const normalized = (match[1] ?? "").trim().replace(/^\.?\//, "");
    const ext = match[2] ?? "";
    // Skip version numbers / Markdown section numbers (e.g. "2.1", "3.2.0")
    if (/^\d+$/.test(ext)) {
      continue;
    }
    if (normalized) {
      matched.push(normalized);
    }
  }
  return Array.from(new Set(matched)).sort((a, b) => a.localeCompare(b));
}

function normalizeSkillBindingSnapshot(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item) => ({
      skillId: typeof item.skillId === "string" ? item.skillId : "",
      verificationStatus:
        typeof item.verificationStatus === "string" && item.verificationStatus.trim()
          ? item.verificationStatus
          : "unverified",
      source: typeof item.source === "string" ? item.source : "",
      sourceLabel: typeof item.sourceLabel === "string" ? item.sourceLabel : "",
      version: typeof item.version === "string" ? item.version : "",
      installedAt: typeof item.installedAt === "string" ? item.installedAt : "",
      verifiedAt: typeof item.verifiedAt === "string" ? item.verifiedAt : "",
      runtimeAvailable:
        typeof item.runtimeAvailable === "boolean"
          ? item.runtimeAvailable
          : Boolean(typeof item.skillId === "string" && getSkillDefinition(item.skillId))
    }))
    .filter((item) => item.skillId);
}

function buildResolvedSkillEvidence(input: {
  roleId: string;
  store: VinkoStore;
  metadata?: Record<string, unknown> | undefined;
}): Record<string, unknown> {
  const metadataSnapshot = normalizeSkillBindingSnapshot(input.metadata?.runtimeSkillBindings);
  const resolvedBindings =
    metadataSnapshot.length > 0
      ? metadataSnapshot
      : input.roleId && typeof input.store.resolveSkillsForRole === "function"
        ? input.store.resolveSkillsForRole(input.roleId as Parameters<VinkoStore["resolveSkillsForRole"]>[0]).map((binding) => ({
            skillId: binding.skillId,
            verificationStatus: binding.verificationStatus ?? "unverified",
            source: binding.source ?? "",
            sourceLabel: binding.sourceLabel ?? "",
            version: binding.version ?? "",
            installedAt: binding.installedAt ?? "",
            verifiedAt: binding.verifiedAt ?? "",
            runtimeAvailable: Boolean(getSkillDefinition(binding.skillId))
          }))
        : [];
  return {
    roleId: input.roleId,
    total: resolvedBindings.length,
    verified: resolvedBindings.filter((item) => item.verificationStatus === "verified").length,
    unverified: resolvedBindings.filter((item) => item.verificationStatus === "unverified").length,
    failed: resolvedBindings.filter((item) => item.verificationStatus === "failed").length,
    runtimeAvailable: resolvedBindings.filter((item) => item.runtimeAvailable === true).length,
    bindings: resolvedBindings
  };
}

function addUnique(items: string[], value: string): void {
  if (value && !items.includes(value)) {
    items.push(value);
  }
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function gradeHarnessScore(score: number): "A" | "B" | "C" | "D" | "F" {
  if (score >= 85) {
    return "A";
  }
  if (score >= 70) {
    return "B";
  }
  if (score >= 55) {
    return "C";
  }
  if (score >= 40) {
    return "D";
  }
  return "F";
}

function buildHarnessAssessment(input: {
  kind: "task" | "goal_run";
  lifecycleStatus: string;
  stageFailureCategory: string;
  hasDeliverable: boolean;
  deliverableContractViolated: boolean;
  handoffArtifactPresent: boolean;
  context: Record<string, unknown>;
  runtime: Record<string, unknown>;
  skills: Record<string, unknown>;
  tools: Record<string, unknown>;
  rules: Record<string, unknown>;
  telemetry: Record<string, unknown>;
}): Record<string, unknown> {
  const strengths: string[] = [];
  const gaps: string[] = [];
  const dimensions = {
    context: 0,
    runtime: 0,
    skills: 0,
    governance: 0,
    observability: 0,
    delivery: 0
  };
  const sessionAttached = input.context.sessionAttached === true;
  const projectMemoryPresent = input.context.projectMemoryPresent === true;
  const sessionMessageCount = Number(input.context.sessionMessageCount ?? 0);
  const runtimeIdentified = Boolean(input.runtime.backendUsed) && Boolean(input.runtime.modelUsed);
  const toolLoopEnabled = input.runtime.toolLoopEnabled === true;
  const toolRegistryPresent = Boolean(input.runtime.toolRegistry);
  const rulesEnginePresent = Boolean(input.runtime.rulesEngine);
  const totalSkills = Number(input.skills.total ?? 0);
  const verifiedSkills = Number(input.skills.verified ?? 0);
  const failedSkills = Number(input.skills.failed ?? 0);
  const runtimeAvailableSkills = Number(input.skills.runtimeAvailable ?? 0);
  const totalToolCalls = Number(input.tools.totalCalls ?? 0);
  const failedToolCalls = Number(input.tools.failed ?? 0);
  const changedFilesCount = Array.isArray(input.tools.changedFiles) ? input.tools.changedFiles.length : 0;
  const blockedToolCalls = Number(input.rules.blockedToolCalls ?? 0);
  const sanitizedToolCalls = Number(input.rules.sanitizedToolCalls ?? 0);
  const approvalGateHits = Number(input.rules.approvalGateHits ?? 0);
  const tracePresent = input.telemetry.tracePresent === true;
  const traceTurns = Number(input.telemetry.turns ?? 0);
  const telemetryDurationMs = Number(input.telemetry.durationMs ?? 0);
  const telemetryErrors = Number(input.telemetry.errors ?? 0);
  const traceToolCalls = Number(input.telemetry.totalToolCalls ?? 0);
  const lifecycleStatus = String(input.lifecycleStatus || "").toLowerCase();
  const failureCategory = String(input.stageFailureCategory || "").toLowerCase();

  if (sessionAttached) {
    dimensions.context += 8;
    addUnique(strengths, "session_attached");
  } else {
    addUnique(gaps, "session_missing");
  }
  if (projectMemoryPresent) {
    dimensions.context += 8;
    addUnique(strengths, "project_memory_present");
  } else {
    addUnique(gaps, "project_memory_missing");
  }
  if (sessionMessageCount > 0) {
    dimensions.context += 4;
    addUnique(strengths, "session_history_recorded");
  } else if (sessionAttached) {
    addUnique(gaps, "session_history_missing");
  }

  if (runtimeIdentified) {
    dimensions.runtime += 12;
    addUnique(strengths, "runtime_identified");
  } else {
    addUnique(gaps, "runtime_identity_missing");
  }
  if (toolLoopEnabled || totalToolCalls > 0 || traceToolCalls > 0) {
    dimensions.runtime += 6;
    addUnique(strengths, "tool_loop_available");
  } else {
    addUnique(gaps, "tool_loop_not_evidenced");
  }
  if (toolRegistryPresent) {
    dimensions.runtime += 4;
    addUnique(strengths, "tool_registry_recorded");
  } else {
    addUnique(gaps, "tool_registry_missing");
  }
  if (rulesEnginePresent) {
    dimensions.runtime += 4;
    addUnique(strengths, "rules_engine_recorded");
  } else {
    addUnique(gaps, "rules_engine_missing");
  }

  if (totalSkills > 0) {
    dimensions.skills += 8;
    addUnique(strengths, "skills_bound");
  } else {
    addUnique(gaps, "skills_not_bound");
  }
  if (verifiedSkills > 0) {
    dimensions.skills += 6;
    addUnique(strengths, "verified_skills_available");
  } else if (totalSkills > 0) {
    addUnique(gaps, "verified_skills_missing");
  }
  if (runtimeAvailableSkills > 0) {
    dimensions.skills += 4;
    addUnique(strengths, "runtime_skills_available");
  }
  if (failedSkills > 0) {
    dimensions.skills -= Math.min(6, failedSkills * 2);
    addUnique(gaps, "failed_skills_present");
  }

  if (toolRegistryPresent || rulesEnginePresent || approvalGateHits > 0) {
    dimensions.governance += 8;
    addUnique(strengths, "governed_tooling");
  }
  if (approvalGateHits > 0) {
    dimensions.governance += 4;
    addUnique(strengths, "approval_gates_observed");
  }
  if (sanitizedToolCalls > 0) {
    dimensions.governance += 2;
    addUnique(strengths, "sanitization_observed");
  }
  if (blockedToolCalls > 0) {
    dimensions.governance -= Math.min(6, blockedToolCalls * 2);
    addUnique(gaps, "blocked_tool_calls_present");
  }

  if (tracePresent) {
    dimensions.observability += 12;
    addUnique(strengths, "trace_recorded");
  } else {
    addUnique(gaps, "trace_missing");
  }
  if (traceTurns > 0) {
    dimensions.observability += 4;
  }
  if (telemetryDurationMs > 0) {
    dimensions.observability += 2;
  }
  if (telemetryErrors > 0 || failedToolCalls > 0) {
    dimensions.observability -= Math.min(6, telemetryErrors + failedToolCalls);
    addUnique(gaps, "execution_errors_present");
  }

  if (input.hasDeliverable || changedFilesCount > 0 || input.handoffArtifactPresent) {
    dimensions.delivery += 12;
    addUnique(strengths, input.kind === "goal_run" ? "handoff_or_artifact_recorded" : "deliverable_recorded");
  } else if (failureCategory === "none" || lifecycleStatus === "completed") {
    addUnique(gaps, "deliverable_missing");
  }
  if (input.deliverableContractViolated) {
    dimensions.delivery -= 12;
    addUnique(gaps, "deliverable_contract_violated");
  }
  if (failureCategory !== "none") {
    if (failureCategory === "input_required") {
      addUnique(gaps, "awaiting_user_input");
    } else if (failureCategory === "authorization_required" || failureCategory === "approval") {
      addUnique(gaps, "awaiting_authorization");
    } else {
      dimensions.delivery -= 6;
      addUnique(gaps, "failed_stage_detected");
    }
  }

  const score = clampScore(
    dimensions.context +
      dimensions.runtime +
      dimensions.skills +
      dimensions.governance +
      dimensions.observability +
      dimensions.delivery
  );
  const grade = gradeHarnessScore(score);
  const status =
    grade === "A" ? "strong" : grade === "B" ? "good" : grade === "C" ? "partial" : grade === "D" ? "weak" : "critical";
  return {
    grade,
    score,
    status,
    strengths,
    gaps,
    dimensions,
    summary:
      status === "strong"
        ? "well-instrumented"
        : status === "good"
          ? "mostly-covered"
          : status === "partial"
            ? "partially-covered"
            : status === "weak"
              ? "coverage-fragile"
              : "coverage-insufficient"
  };
}

function classifyFailureCategory(input: {
  status: string;
  errorText?: string | undefined;
  stage?: string | undefined;
}): FailureCategory {
  const status = input.status.trim().toLowerCase();
  const text = (input.errorText ?? "").toLowerCase();
  const stage = (input.stage ?? "").toLowerCase();
  if (status === "completed") {
    return "none";
  }
  if (status === "queued" || status === "running" || status === "waiting_approval") {
    return "none";
  }
  if (status === "cancelled") {
    return "cancelled";
  }
  if (status === "awaiting_input" || text.includes("awaiting input") || /缺少|请输入|请提供/.test(text)) {
    return "input_required";
  }
  if (status === "awaiting_authorization" || text.includes("authorization") || text.includes("授权")) {
    return "authorization_required";
  }
  if (text.includes("approval") || text.includes("审批")) {
    return "approval";
  }
  if (text.includes("verify failed") || text.includes("校验失败") || text.includes("validation")) {
    return "validation";
  }
  if (
    text.includes("api key") ||
    text.includes("credential") ||
    text.includes("未配置") ||
    text.includes("missing") ||
    text.includes("smtp") ||
    text.includes("search provider")
  ) {
    return "configuration";
  }
  if (text.includes("timed out") || text.includes("timeout") || text.includes("超时")) {
    return "execution_timeout";
  }
  if (text.includes("tool provider") || text.includes("opencode") || text.includes("claude") || text.includes("codex")) {
    return "tool_provider";
  }
  if (stage === "verify") {
    return "validation";
  }
  return "runtime";
}

export function enrichTaskRecord(store: VinkoStore, task: TaskRecord): Record<string, unknown> {
  const metadata = task.metadata as {
    toolChangedFiles?: unknown;
    deliverableMode?: unknown;
    deliverableContractViolated?: unknown;
    runtimeBackendUsed?: unknown;
    runtimeModelUsed?: unknown;
    runtimeToolLoopEnabled?: unknown;
    runtimeToolRegistry?: unknown;
    runtimeRulesEngine?: unknown;
    runtimeSkillBindings?: unknown;
    collaborationMode?: boolean;
    collaborationId?: string;
    isAggregation?: boolean;
    collaborationPhase?: unknown;
    collaborationConvergenceMode?: unknown;
    collaborationTriggerReason?: unknown;
    collaborationStatus?: unknown;
    collaborationPendingQuestions?: unknown;
    collaborationResumeRequested?: unknown;
    collaborationResumedAt?: unknown;
    requestedSkillId?: unknown;
    requestedSkillName?: unknown;
    requestedSkillTargetRoleId?: unknown;
    requestedSkillInstallState?: unknown;
    requestedSkillRuntimeAvailable?: unknown;
    requestedSkillRuntimeCheckedAt?: unknown;
    orchestrationMode?: unknown;
    orchestrationState?: unknown;
  };
  const metadataFiles = toStringArray(metadata.toolChangedFiles);
  const deliverableMode =
    typeof metadata.deliverableMode === "string" ? metadata.deliverableMode.trim().toLowerCase() : "";
  const deliverableContractViolated = toBoolean(metadata.deliverableContractViolated);
  const resultText = `${task.result?.summary ?? ""}\n${task.result?.deliverable ?? ""}`;
  const resultFiles = extractArtifactFilesFromText(resultText);
  const toolRuns = store.listToolRunsByTask(task.id);
  const toolRunFiles = toolRuns.flatMap((item) =>
    extractArtifactFilesFromText(`${item.outputText ?? ""}\n${item.errorText ?? ""}`)
  );
  const artifactFiles = Array.from(new Set([...metadataFiles, ...resultFiles, ...toolRunFiles])).sort((a, b) =>
    a.localeCompare(b)
  );
  const session = task.sessionId && typeof store.getSession === "function" ? store.getSession(task.sessionId) : undefined;
  const sessionMetadata =
    typeof session?.metadata === "object" && session.metadata !== null ? (session.metadata as Record<string, unknown>) : {};
  const projectMemory =
    typeof sessionMetadata.projectMemory === "object" && sessionMetadata.projectMemory !== null
      ? (sessionMetadata.projectMemory as Record<string, unknown>)
      : undefined;
  const runtimeTrace = globalTelemetry.getTrace(task.id);
  const blockedToolCalls = runtimeTrace?.turns.reduce(
    (count: number, turn) =>
      count + turn.toolCalls.filter((call) => typeof call.blocked === "string" && call.blocked.trim()).length,
    0
  ) ?? 0;
  const sanitizedToolCalls = runtimeTrace?.turns.reduce(
    (count: number, turn) =>
      count +
      turn.toolCalls.filter((call) => {
        const output = call.output ?? "";
        return /\[REDACTED_/i.test(output);
      }).length,
    0
  ) ?? 0;

  let collaborationEvidence: Record<string, unknown> | undefined;
  let skillIntegrationEvidence: Record<string, unknown> | undefined;
  const collaborationStatus =
    typeof metadata.collaborationStatus === "string" ? metadata.collaborationStatus.trim().toLowerCase() : "";
  const collaborationResumeRequested = toBoolean(metadata.collaborationResumeRequested);
  const collaborationEnabled = Boolean(metadata.collaborationMode || metadata.collaborationId);
  if (collaborationEnabled) {
    const children = store.listTaskChildren(task.id).filter((child) => {
      const childMetadata = child.metadata as {
        collaborationId?: string;
        isAggregation?: boolean;
      };
      if (childMetadata.isAggregation) {
        return false;
      }
      if (typeof metadata.collaborationId === "string" && metadata.collaborationId.trim()) {
        return childMetadata.collaborationId === metadata.collaborationId;
      }
      return true;
    });
    const completedRoles = Array.from(
      new Set(children.filter((child) => child.status === "completed").map((child) => child.roleId))
    ).sort((a, b) => a.localeCompare(b));
    const failedRoles = Array.from(
      new Set(children.filter((child) => child.status === "failed" || child.status === "cancelled").map((child) => child.roleId))
    ).sort((a, b) => a.localeCompare(b));
    collaborationEvidence = {
      enabled: true,
      phase: typeof metadata.collaborationPhase === "string" ? metadata.collaborationPhase : "",
      convergenceMode:
        typeof metadata.collaborationConvergenceMode === "string" ? metadata.collaborationConvergenceMode : "",
      triggerReason:
        typeof metadata.collaborationTriggerReason === "string" ? metadata.collaborationTriggerReason : "",
      status: collaborationStatus,
      resumeRequested: collaborationResumeRequested,
      resumedAt: typeof metadata.collaborationResumedAt === "string" ? metadata.collaborationResumedAt : "",
      pendingQuestions: toStringArray(metadata.collaborationPendingQuestions),
      childTotal: children.length,
      childCompleted: children.filter((child) => child.status === "completed").length,
      childFailed: children.filter((child) => child.status === "failed" || child.status === "cancelled").length,
      childPending: children.filter((child) => child.status === "queued" || child.status === "waiting_approval").length,
      childRunning: children.filter((child) => child.status === "running").length,
      completedRoles,
      failedRoles
    };
  }

  const orchestrationState = normalizeOrchestrationState(metadata.orchestrationState);
  const requestedSkillId =
    typeof metadata.requestedSkillId === "string" ? metadata.requestedSkillId.trim() : "";
  if (requestedSkillId) {
    const targetRoleId =
      typeof metadata.requestedSkillTargetRoleId === "string" ? metadata.requestedSkillTargetRoleId : "";
    const installState =
      typeof metadata.requestedSkillInstallState === "string" ? metadata.requestedSkillInstallState : "";
    const runtimeAvailable = toBoolean(metadata.requestedSkillRuntimeAvailable);
    skillIntegrationEvidence = {
      skillId: requestedSkillId,
      skillName: typeof metadata.requestedSkillName === "string" ? metadata.requestedSkillName : "",
      targetRoleId,
      installState,
      runtimeAvailable,
      checkedAt: typeof metadata.requestedSkillRuntimeCheckedAt === "string" ? metadata.requestedSkillRuntimeCheckedAt : "",
      suggestedAction:
        runtimeAvailable && installState === "local_installable" && targetRoleId
          ? {
              kind: "install_skill",
              skillId: requestedSkillId,
              targetRoleId,
              label: `Install ${requestedSkillId} to ${targetRoleId}`
            }
          : undefined
    };
  }

  const startedMs = parseIsoMs(task.startedAt);
  const completedMs = parseIsoMs(task.completedAt);
  const executionMs =
    startedMs !== undefined && completedMs !== undefined && completedMs >= startedMs
      ? completedMs - startedMs
      : undefined;
  const contextEvidence: Record<string, unknown> = {
    sessionAttached: Boolean(task.sessionId),
    sessionMessageCount:
      task.sessionId && typeof store.listSessionMessages === "function" ? store.listSessionMessages(task.sessionId, 120).length : 0,
    projectMemoryPresent: Boolean(projectMemory),
    latestUserRequest: typeof projectMemory?.latestUserRequest === "string" ? projectMemory.latestUserRequest : "",
    currentGoal: typeof projectMemory?.currentGoal === "string" ? projectMemory.currentGoal : "",
    currentStage: typeof projectMemory?.currentStage === "string" ? projectMemory.currentStage : "",
    nextActions: toStringArray(projectMemory?.nextActions),
    unresolvedQuestions: toStringArray(projectMemory?.unresolvedQuestions),
    latestArtifacts: toStringArray(projectMemory?.latestArtifacts)
  };
  const runtimeEvidence: Record<string, unknown> = {
    backendUsed: typeof metadata.runtimeBackendUsed === "string" ? metadata.runtimeBackendUsed : "",
    modelUsed: typeof metadata.runtimeModelUsed === "string" ? metadata.runtimeModelUsed : "",
    toolLoopEnabled: toBoolean(metadata.runtimeToolLoopEnabled),
    toolRegistry: typeof metadata.runtimeToolRegistry === "string" ? metadata.runtimeToolRegistry : "",
    rulesEngine: typeof metadata.runtimeRulesEngine === "string" ? metadata.runtimeRulesEngine : ""
  };
  const toolsEvidence: Record<string, unknown> = {
    totalCalls: toolRuns.length,
    approvalRequired: toolRuns.filter((item) => item.approvalStatus !== "not_required").length,
    pendingApproval: toolRuns.filter((item) => item.approvalStatus === "pending").length,
    completed: toolRuns.filter((item) => item.status === "completed").length,
    failed: toolRuns.filter((item) => item.status === "failed").length,
    changedFiles: artifactFiles
  };
  const rulesEvidence: Record<string, unknown> = {
    blockedToolCalls,
    sanitizedToolCalls,
    approvalGateHits: toolRuns.filter((item) => item.approvalStatus !== "not_required").length
  };
  const telemetryEvidence: Record<string, unknown> = {
    tracePresent: Boolean(runtimeTrace),
    traceId: runtimeTrace?.taskId ?? task.id,
    turns: runtimeTrace?.turns.length ?? 0,
    totalToolCalls: runtimeTrace?.metrics.toolCalls ?? toolRuns.length,
    errors: runtimeTrace?.metrics.errors ?? toolRuns.filter((item) => item.status === "failed").length,
    blockedRounds: runtimeTrace?.metrics.roundsBlocked ?? blockedToolCalls,
    durationMs: runtimeTrace?.metrics.durationMs ?? executionMs ?? 0
  };
  const skillsEvidence = buildResolvedSkillEvidence({
    roleId: task.roleId,
    store,
    metadata: metadata as Record<string, unknown>
  });
  const displayStatus =
    collaborationStatus === "await_user"
      ? "await_user"
      : collaborationResumeRequested && ["queued", "running"].includes(task.status)
        ? "resuming"
      : collaborationStatus === "partial"
        ? "partial"
        : task.status;
  const failureCategory =
    collaborationStatus === "await_user"
      ? "input_required"
      : classifyFailureCategory({
          status: task.status,
          errorText: task.errorText
        });
  const harnessEvidence = buildHarnessAssessment({
    kind: "task",
    lifecycleStatus: task.status,
    stageFailureCategory: failureCategory,
    hasDeliverable: Boolean(task.result?.deliverable?.trim()),
    deliverableContractViolated,
    handoffArtifactPresent: false,
    context: contextEvidence,
    runtime: runtimeEvidence,
    skills: skillsEvidence,
    tools: toolsEvidence,
    rules: rulesEvidence,
    telemetry: telemetryEvidence
  });

  return {
    ...task,
    displayStatus,
    failureCategory,
    completionEvidence: {
      traceId: runtimeTrace?.taskId ?? task.id,
      hasDeliverable: Boolean(task.result?.deliverable?.trim()),
      deliverableMode,
      deliverableContractViolated,
      handoffArtifactPresent: false,
      approvalGateHits: toolRuns.filter((item) => item.approvalStatus !== "not_required").length,
      resumeFromStageSupported: task.status === "paused_input" || task.status === "waiting_approval",
      stageFailureCategory: failureCategory,
      artifactFiles,
      context: contextEvidence,
      runtime: runtimeEvidence,
      skills: skillsEvidence,
      tools: toolsEvidence,
      rules: rulesEvidence,
      telemetry: telemetryEvidence,
      harness: harnessEvidence,
      toolRunSummary: {
        total: toolRuns.length,
        completed: toolRuns.filter((item) => item.status === "completed").length,
        failed: toolRuns.filter((item) => item.status === "failed").length
      },
      ...(skillIntegrationEvidence ? { skillIntegration: skillIntegrationEvidence } : {}),
      ...(collaborationEvidence ? { collaboration: collaborationEvidence } : {}),
      ...(orchestrationState
        ? {
            orchestration: {
              mode: typeof metadata.orchestrationMode === "string" ? metadata.orchestrationMode : orchestrationState.mode,
              ownerRoleId: orchestrationState.ownerRoleId,
              spec: orchestrationState.spec,
              progress: orchestrationState.progress,
              decision: orchestrationState.decision,
              artifactIndex: orchestrationState.artifactIndex,
              branchReason: orchestrationState.branchReason ?? "",
              mergeReason: orchestrationState.mergeReason ?? "",
              verificationStatus: orchestrationState.verificationStatus ?? "pending",
              updatedAt: orchestrationState.updatedAt,
              updatedBy: orchestrationState.updatedBy
            }
          }
        : {}),
      ...(executionMs !== undefined ? { executionMs } : {})
    }
  };
}

export function enrichGoalRunRecord(run: GoalRunRecord): Record<string, unknown> {
  const context = run.context ?? {};
  const completedRoles = toStringArray(context.last_completed_roles);
  const failedRoles = toStringArray(context.last_failed_roles);
  const artifactFiles = toStringArray(context.last_artifact_files);
  const collaborationEnabled = toBoolean(context.last_collaboration_enabled);
  const approvalGateHits =
    (typeof context.deploy_authorized_at === "string" && context.deploy_authorized_at.trim() ? 1 : 0) +
    ((run.status === "awaiting_authorization" ? 1 : 0));
  const retryPolicyApplied = {
    retryCount: run.retryCount,
    maxRetries: run.maxRetries,
    exhausted: run.retryCount >= run.maxRetries,
    policy:
      run.retryCount === 0
        ? "none"
        : run.status === "failed" && /without auto retry|不自动重试/i.test(run.errorText ?? "")
          ? "no_retry_after_collaboration_failure"
          : "retry_on_failure"
  };
  return {
    ...run,
    failureCategory: classifyFailureCategory({
      status: run.status,
      errorText: run.errorText,
      stage: run.currentStage
    }),
    retryPolicyApplied,
    completionEvidence: {
      lastTaskStatus: typeof context.last_task_status === "string" ? context.last_task_status : "",
      artifactFiles,
      collaborationEnabled,
      completedRoles,
      failedRoles,
      handoffArtifactPresent: false,
      approvalGateHits,
      resumeFromStageSupported: ["awaiting_input", "awaiting_authorization"].includes(run.status),
      stageFailureCategory: classifyFailureCategory({
        status: run.status,
        errorText: run.errorText,
        stage: run.currentStage
      })
    }
  };
}

export function enrichGoalRunRecordWithHarnessEvidence(
  store: VinkoStore,
  run: GoalRunRecord,
  options?: {
    traceCount?: number | undefined;
    handoffStage?: GoalRunStage | undefined;
  }
): Record<string, unknown> {
  const enriched = enrichGoalRunRecord(run) as Record<string, unknown>;
  const session = run.sessionId && typeof store.getSession === "function" ? store.getSession(run.sessionId) : undefined;
  const sessionMetadata =
    typeof session?.metadata === "object" && session.metadata !== null ? (session.metadata as Record<string, unknown>) : {};
  const projectMemory =
    typeof sessionMetadata.projectMemory === "object" && sessionMetadata.projectMemory !== null
      ? (sessionMetadata.projectMemory as Record<string, unknown>)
      : undefined;
  const lastTaskId = typeof run.context.last_task_id === "string" ? run.context.last_task_id : "";
  const lastTask =
    lastTaskId && typeof store.getTask === "function" ? store.getTask(lastTaskId) : run.currentTaskId && typeof store.getTask === "function"
      ? store.getTask(run.currentTaskId)
      : undefined;
  const runtimeTrace =
    lastTask?.id ? globalTelemetry.getTrace(lastTask.id) : undefined;
  const lastTaskToolRuns =
    lastTask?.id && typeof store.listToolRunsByTask === "function" ? store.listToolRunsByTask(lastTask.id) : [];
  const completionEvidence =
    typeof enriched.completionEvidence === "object" && enriched.completionEvidence !== null
      ? { ...(enriched.completionEvidence as Record<string, unknown>) }
      : {};
  const goalRunArtifactFiles =
    Array.isArray(completionEvidence.artifactFiles)
      ? (completionEvidence.artifactFiles as unknown[]).filter((item): item is string => typeof item === "string")
      : [];
  const latestHandoff = store.getLatestGoalRunHandoff(run.id, options?.handoffStage);
  const skillEvidence = buildResolvedSkillEvidence({
    roleId: lastTask?.roleId ?? "",
    store,
    metadata:
      typeof lastTask?.metadata === "object" && lastTask.metadata !== null
        ? (lastTask.metadata as Record<string, unknown>)
        : undefined
  });
  completionEvidence.context = {
    sessionAttached: Boolean(run.sessionId),
    sessionMessageCount:
      run.sessionId && typeof store.listSessionMessages === "function" ? store.listSessionMessages(run.sessionId, 120).length : 0,
    projectMemoryPresent: Boolean(projectMemory),
    currentGoal: typeof projectMemory?.currentGoal === "string" ? projectMemory.currentGoal : "",
    currentStage: typeof projectMemory?.currentStage === "string" ? projectMemory.currentStage : "",
    latestUserRequest: typeof projectMemory?.latestUserRequest === "string" ? projectMemory.latestUserRequest : "",
    nextActions: toStringArray(projectMemory?.nextActions),
    unresolvedQuestions: toStringArray(projectMemory?.unresolvedQuestions),
    latestArtifacts: toStringArray(projectMemory?.latestArtifacts)
  };
  completionEvidence.runtime = {
    backendUsed:
      typeof lastTask?.metadata?.runtimeBackendUsed === "string" ? lastTask.metadata.runtimeBackendUsed : "",
    modelUsed:
      typeof lastTask?.metadata?.runtimeModelUsed === "string" ? lastTask.metadata.runtimeModelUsed : "",
    toolLoopEnabled: toBoolean(lastTask?.metadata?.runtimeToolLoopEnabled),
    toolRegistry:
      typeof lastTask?.metadata?.runtimeToolRegistry === "string" ? lastTask.metadata.runtimeToolRegistry : "",
    rulesEngine:
      typeof lastTask?.metadata?.runtimeRulesEngine === "string" ? lastTask.metadata.runtimeRulesEngine : "",
    lastTaskId: lastTask?.id ?? ""
  };
  completionEvidence.skills = skillEvidence;
  completionEvidence.tools = {
    totalCalls: lastTaskToolRuns.length,
    approvalRequired: lastTaskToolRuns.filter((item) => item.approvalStatus !== "not_required").length,
    pendingApproval: lastTaskToolRuns.filter((item) => item.approvalStatus === "pending").length,
    completed: lastTaskToolRuns.filter((item) => item.status === "completed").length,
    failed: lastTaskToolRuns.filter((item) => item.status === "failed").length,
    changedFiles: goalRunArtifactFiles
  };
  completionEvidence.rules = {
    blockedToolCalls:
      runtimeTrace?.turns.reduce(
        (count: number, turn) =>
          count + turn.toolCalls.filter((call) => typeof call.blocked === "string" && call.blocked.trim()).length,
        0
      ) ?? 0,
    sanitizedToolCalls:
      runtimeTrace?.turns.reduce(
        (count: number, turn) =>
          count +
          turn.toolCalls.filter((call) => {
            const output = call.output ?? "";
            return /\[REDACTED_/i.test(output);
          }).length,
        0
      ) ?? 0,
    approvalGateHits:
      typeof completionEvidence.approvalGateHits === "number" ? completionEvidence.approvalGateHits : 0
  };
  completionEvidence.telemetry = {
    tracePresent: Boolean(runtimeTrace),
    traceId: runtimeTrace?.taskId ?? lastTask?.id ?? "",
    turns: runtimeTrace?.turns.length ?? 0,
    totalToolCalls: runtimeTrace?.metrics.toolCalls ?? lastTaskToolRuns.length,
    errors: runtimeTrace?.metrics.errors ?? lastTaskToolRuns.filter((item) => item.status === "failed").length,
    blockedRounds: runtimeTrace?.metrics.roundsBlocked ?? 0,
    durationMs: runtimeTrace?.metrics.durationMs ?? 0
  };
  completionEvidence.handoffArtifactPresent = Boolean(latestHandoff);
  const workflowState = summarizeGoalRun(run, {
    latestHandoff,
    currentTask: lastTask,
    projectMemory
  });
  completionEvidence.harness = buildHarnessAssessment({
    kind: "goal_run",
    lifecycleStatus: run.status,
    stageFailureCategory:
      typeof completionEvidence.stageFailureCategory === "string" ? completionEvidence.stageFailureCategory : "none",
    hasDeliverable:
      (Array.isArray(completionEvidence.artifactFiles) && completionEvidence.artifactFiles.length > 0) ||
      Boolean(latestHandoff),
    deliverableContractViolated: false,
    handoffArtifactPresent: Boolean(latestHandoff),
    context:
      typeof completionEvidence.context === "object" && completionEvidence.context !== null
        ? (completionEvidence.context as Record<string, unknown>)
        : {},
    runtime:
      typeof completionEvidence.runtime === "object" && completionEvidence.runtime !== null
        ? (completionEvidence.runtime as Record<string, unknown>)
        : {},
    skills:
      typeof completionEvidence.skills === "object" && completionEvidence.skills !== null
        ? (completionEvidence.skills as Record<string, unknown>)
        : {},
    tools:
      typeof completionEvidence.tools === "object" && completionEvidence.tools !== null
        ? (completionEvidence.tools as Record<string, unknown>)
        : {},
    rules:
      typeof completionEvidence.rules === "object" && completionEvidence.rules !== null
        ? (completionEvidence.rules as Record<string, unknown>)
        : {},
    telemetry:
      typeof completionEvidence.telemetry === "object" && completionEvidence.telemetry !== null
        ? (completionEvidence.telemetry as Record<string, unknown>)
        : {}
  });
  if (options?.traceCount !== undefined) {
    completionEvidence.traceCount = options.traceCount;
  }
  enriched.completionEvidence = completionEvidence;
  enriched.workflowState = workflowState;
  enriched.workflowSummary = buildGoalRunWorkflowSummary(run, {
    latestHandoff,
    currentTask: lastTask,
    projectMemory
  });
  return enriched;
}

export function summarizeLatencyMetrics(input: {
  tasks: TaskRecord[];
  goalRuns: GoalRunRecord[];
  sinceMs: number;
}): {
  taskP50Ms: number | null;
  taskP95Ms: number | null;
  goalRunP50Ms: number | null;
  goalRunP95Ms: number | null;
} {
  const taskDurations = input.tasks
    .filter((task) => task.status === "completed" || task.status === "failed" || task.status === "cancelled")
    .filter((task) => {
      const completedMs = parseIsoMs(task.completedAt);
      return completedMs !== undefined && completedMs >= input.sinceMs;
    })
    .map((task) => {
      const startedMs = parseIsoMs(task.startedAt) ?? parseIsoMs(task.createdAt);
      const completedMs = parseIsoMs(task.completedAt);
      if (startedMs === undefined || completedMs === undefined || completedMs < startedMs) {
        return undefined;
      }
      return completedMs - startedMs;
    })
    .filter((value): value is number => value !== undefined)
    .sort((a, b) => a - b);

  const goalRunDurations = input.goalRuns
    .filter((run) => run.status === "completed" || run.status === "failed" || run.status === "cancelled")
    .filter((run) => {
      const completedMs = parseIsoMs(run.completedAt);
      return completedMs !== undefined && completedMs >= input.sinceMs;
    })
    .map((run) => {
      const startedMs = parseIsoMs(run.startedAt) ?? parseIsoMs(run.createdAt);
      const completedMs = parseIsoMs(run.completedAt);
      if (startedMs === undefined || completedMs === undefined || completedMs < startedMs) {
        return undefined;
      }
      return completedMs - startedMs;
    })
    .filter((value): value is number => value !== undefined)
    .sort((a, b) => a - b);

  return {
    taskP50Ms: percentile(taskDurations, 0.5),
    taskP95Ms: percentile(taskDurations, 0.95),
    goalRunP50Ms: percentile(goalRunDurations, 0.5),
    goalRunP95Ms: percentile(goalRunDurations, 0.95)
  };
}

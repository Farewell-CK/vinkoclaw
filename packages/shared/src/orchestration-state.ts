import type { RoleId } from "./types.js";

export type OrchestrationMode = "main_agent";
export type OrchestrationLifecycleStatus = "active" | "await_user" | "blocked" | "completed" | "partial";
export type OrchestrationVerificationStatus = "pending" | "verified" | "failed";

export interface OrchestrationSpecRecord {
  goal: string;
  successCriteria: string[];
  constraints: string[];
  scope: string[];
}

export interface OrchestrationProgressRecord {
  stage: string;
  status: OrchestrationLifecycleStatus;
  completed: string[];
  inFlight: string[];
  blocked: string[];
  awaitingInput: string[];
  nextActions: string[];
}

export interface OrchestrationDecisionLog {
  summary: string;
  entries: string[];
}

export interface OrchestrationArtifactItem {
  path: string;
  title: string;
  stage: string;
  status: "produced" | "verified" | "failed";
}

export interface OrchestrationArtifactIndex {
  items: OrchestrationArtifactItem[];
}

export interface OrchestrationStateRecord {
  version: 1;
  mode: OrchestrationMode;
  ownerRoleId: RoleId;
  spec: OrchestrationSpecRecord;
  progress: OrchestrationProgressRecord;
  decision: OrchestrationDecisionLog;
  artifactIndex: OrchestrationArtifactIndex;
  branchReason?: string | undefined;
  mergeReason?: string | undefined;
  verificationStatus?: OrchestrationVerificationStatus | undefined;
  updatedAt: string;
  updatedBy: string;
}

export interface OrchestrationStatePatch {
  ownerRoleId?: RoleId | undefined;
  spec?: Partial<OrchestrationSpecRecord> | undefined;
  progress?: Partial<OrchestrationProgressRecord> | undefined;
  decision?: Partial<OrchestrationDecisionLog> | undefined;
  artifactIndex?: Partial<OrchestrationArtifactIndex> | undefined;
  branchReason?: string | undefined;
  mergeReason?: string | undefined;
  verificationStatus?: OrchestrationVerificationStatus | undefined;
  updatedAt?: string | undefined;
  updatedBy?: string | undefined;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function cleanStringList(value: unknown, limit = 12): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return Array.from(
    new Set(
      value
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean)
    )
  ).slice(0, limit);
}

function normalizeLifecycleStatus(value: unknown): OrchestrationLifecycleStatus {
  switch (cleanString(value).toLowerCase()) {
    case "await_user":
      return "await_user";
    case "blocked":
      return "blocked";
    case "completed":
      return "completed";
    case "partial":
      return "partial";
    default:
      return "active";
  }
}

function normalizeVerificationStatus(value: unknown): OrchestrationVerificationStatus | undefined {
  switch (cleanString(value).toLowerCase()) {
    case "verified":
      return "verified";
    case "failed":
      return "failed";
    case "pending":
      return "pending";
    default:
      return undefined;
  }
}

function normalizeArtifactItems(value: unknown): OrchestrationArtifactItem[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
    .map((entry) => {
      const statusRaw = cleanString(entry.status).toLowerCase();
      const status: OrchestrationArtifactItem["status"] =
        statusRaw === "verified" ? "verified" : statusRaw === "failed" ? "failed" : "produced";
      return {
        path: cleanString(entry.path),
        title: cleanString(entry.title) || cleanString(entry.path),
        stage: cleanString(entry.stage),
        status
      };
    })
    .filter((entry) => entry.path);
}

export function createOrchestrationState(input: {
  ownerRoleId: RoleId;
  goal: string;
  stage: string;
  successCriteria?: string[] | undefined;
  constraints?: string[] | undefined;
  scope?: string[] | undefined;
  nextActions?: string[] | undefined;
  updatedBy: string;
}): OrchestrationStateRecord {
  return {
    version: 1,
    mode: "main_agent",
    ownerRoleId: input.ownerRoleId,
    spec: {
      goal: cleanString(input.goal),
      successCriteria: cleanStringList(input.successCriteria),
      constraints: cleanStringList(input.constraints),
      scope: cleanStringList(input.scope)
    },
    progress: {
      stage: cleanString(input.stage),
      status: "active",
      completed: [],
      inFlight: [],
      blocked: [],
      awaitingInput: [],
      nextActions: cleanStringList(input.nextActions)
    },
    decision: {
      summary: "",
      entries: []
    },
    artifactIndex: {
      items: []
    },
    verificationStatus: "pending",
    updatedAt: new Date().toISOString(),
    updatedBy: cleanString(input.updatedBy) || String(input.ownerRoleId)
  };
}

export function normalizeOrchestrationState(value: unknown): OrchestrationStateRecord | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  const goal = cleanString((candidate.spec as Record<string, unknown> | undefined)?.goal);
  const ownerRoleId = cleanString(candidate.ownerRoleId) as RoleId;
  if (!goal || !ownerRoleId) {
    return undefined;
  }
  return {
    version: 1,
    mode: "main_agent",
    ownerRoleId,
    spec: {
      goal,
      successCriteria: cleanStringList((candidate.spec as Record<string, unknown> | undefined)?.successCriteria),
      constraints: cleanStringList((candidate.spec as Record<string, unknown> | undefined)?.constraints),
      scope: cleanStringList((candidate.spec as Record<string, unknown> | undefined)?.scope)
    },
    progress: {
      stage: cleanString((candidate.progress as Record<string, unknown> | undefined)?.stage),
      status: normalizeLifecycleStatus((candidate.progress as Record<string, unknown> | undefined)?.status),
      completed: cleanStringList((candidate.progress as Record<string, unknown> | undefined)?.completed),
      inFlight: cleanStringList((candidate.progress as Record<string, unknown> | undefined)?.inFlight),
      blocked: cleanStringList((candidate.progress as Record<string, unknown> | undefined)?.blocked),
      awaitingInput: cleanStringList((candidate.progress as Record<string, unknown> | undefined)?.awaitingInput),
      nextActions: cleanStringList((candidate.progress as Record<string, unknown> | undefined)?.nextActions)
    },
    decision: {
      summary: cleanString((candidate.decision as Record<string, unknown> | undefined)?.summary),
      entries: cleanStringList((candidate.decision as Record<string, unknown> | undefined)?.entries, 20)
    },
    artifactIndex: {
      items: normalizeArtifactItems((candidate.artifactIndex as Record<string, unknown> | undefined)?.items)
    },
    branchReason: cleanString(candidate.branchReason) || undefined,
    mergeReason: cleanString(candidate.mergeReason) || undefined,
    verificationStatus: normalizeVerificationStatus(candidate.verificationStatus),
    updatedAt: cleanString(candidate.updatedAt) || new Date().toISOString(),
    updatedBy: cleanString(candidate.updatedBy) || ownerRoleId
  };
}

export function mergeOrchestrationState(
  current: OrchestrationStateRecord | undefined,
  patch: OrchestrationStatePatch
): OrchestrationStateRecord | undefined {
  if (!current) {
    return undefined;
  }
  const next: OrchestrationStateRecord = {
    ...current,
    ownerRoleId: patch.ownerRoleId ?? current.ownerRoleId,
    spec: {
      goal: cleanString(patch.spec?.goal) || current.spec.goal,
      successCriteria: patch.spec?.successCriteria ? cleanStringList(patch.spec.successCriteria) : current.spec.successCriteria,
      constraints: patch.spec?.constraints ? cleanStringList(patch.spec.constraints) : current.spec.constraints,
      scope: patch.spec?.scope ? cleanStringList(patch.spec.scope) : current.spec.scope
    },
    progress: {
      stage: cleanString(patch.progress?.stage) || current.progress.stage,
      status: patch.progress?.status ? normalizeLifecycleStatus(patch.progress.status) : current.progress.status,
      completed: patch.progress?.completed ? cleanStringList(patch.progress.completed, 20) : current.progress.completed,
      inFlight: patch.progress?.inFlight ? cleanStringList(patch.progress.inFlight, 20) : current.progress.inFlight,
      blocked: patch.progress?.blocked ? cleanStringList(patch.progress.blocked, 20) : current.progress.blocked,
      awaitingInput: patch.progress?.awaitingInput ? cleanStringList(patch.progress.awaitingInput, 10) : current.progress.awaitingInput,
      nextActions: patch.progress?.nextActions ? cleanStringList(patch.progress.nextActions, 20) : current.progress.nextActions
    },
    decision: {
      summary: cleanString(patch.decision?.summary) || current.decision.summary,
      entries: patch.decision?.entries ? cleanStringList(patch.decision.entries, 30) : current.decision.entries
    },
    artifactIndex: {
      items: patch.artifactIndex?.items ? normalizeArtifactItems(patch.artifactIndex.items) : current.artifactIndex.items
    },
    branchReason: patch.branchReason !== undefined ? cleanString(patch.branchReason) || undefined : current.branchReason,
    mergeReason: patch.mergeReason !== undefined ? cleanString(patch.mergeReason) || undefined : current.mergeReason,
    verificationStatus: patch.verificationStatus ?? current.verificationStatus,
    updatedAt: patch.updatedAt ?? new Date().toISOString(),
    updatedBy: cleanString(patch.updatedBy) || current.updatedBy
  };
  return next;
}

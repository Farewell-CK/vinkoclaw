import path from "node:path";
import {
  ROLE_IDS,
  type ProjectMemoryRecord,
  type ProjectMemoryUpdate,
  type RoleId,
  type TaskRecord,
  type ToolRunRecord
} from "./types.js";

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
  ".sql",
  ".py",
  ".pdf",
  ".docx",
  ".ppt",
  ".pptx",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".csv",
  ".xlsx",
  ".zip"
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

export interface ProjectMemoryArtifactOptions {
  workspaceRoot?: string | undefined;
}

export interface ProjectMemoryTaskPatch {
  currentStage?: string | undefined;
  unresolvedQuestions?: string[] | undefined;
  nextActions?: string[] | undefined;
  latestSummary?: string | undefined;
  latestArtifacts?: string[] | undefined;
  orchestrationMode?: "main_agent" | undefined;
  orchestrationOwnerRoleId?: RoleId | undefined;
  orchestrationVerificationStatus?: "pending" | "verified" | "failed" | undefined;
}

export interface ProjectMemoryTaskSyncStore {
  updateSessionProjectMemory(
    sessionId: string,
    patch: ProjectMemoryUpdate,
    metadataPatch?: Record<string, unknown>
  ): unknown;
  listToolRunsByTask?(taskId: string): ToolRunRecord[];
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeStringArray(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const normalized = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return Array.from(new Set(normalized)).slice(0, limit);
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

function normalizeArtifactPath(input: string, options: ProjectMemoryArtifactOptions = {}): string | undefined {
  let candidate = input.trim();
  if (!candidate) {
    return undefined;
  }
  candidate = candidate.replace(/^[`"'()[\]{}<]+|[`"',;()[\]{}>]+$/g, "").trim();
  if (!candidate || candidate.startsWith("-")) {
    return undefined;
  }
  if (/^(?:https?:\/\/|data:|mailto:|tel:)/i.test(candidate)) {
    return undefined;
  }
  candidate = candidate.replaceAll("\\", "/");
  if (path.isAbsolute(candidate)) {
    const workspaceRoot = normalizeString(options.workspaceRoot);
    if (!workspaceRoot) {
      return undefined;
    }
    const normalizedAbsolute = path.normalize(candidate);
    const normalizedRoot = path.normalize(workspaceRoot);
    if (!normalizedAbsolute.startsWith(normalizedRoot)) {
      return undefined;
    }
    candidate = path.relative(normalizedRoot, normalizedAbsolute);
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

export function extractArtifactFilesFromText(text: string, options: ProjectMemoryArtifactOptions = {}): string[] {
  if (!text.trim()) {
    return [];
  }
  const found: string[] = [];
  const changedFilesPattern = /CHANGED_FILES\s*:\s*([^\n]+)/gi;
  for (const match of text.matchAll(changedFilesPattern)) {
    const group = match[1] ?? "";
    const pieces = group.split(/[,\s]+/);
    for (const piece of pieces) {
      const normalized = normalizeArtifactPath(piece, options);
      if (normalized) {
        found.push(normalized);
      }
    }
  }
  const genericPathPattern = /(?:^|[\s`"'(])((?:\.{0,2}\/)?(?:[\w.-]+\/)*[\w.-]+\.[a-zA-Z0-9]{1,8})(?=$|[\s`"'),:;])/g;
  for (const match of text.matchAll(genericPathPattern)) {
    const normalized = normalizeArtifactPath(match[1] ?? "", options);
    if (normalized) {
      found.push(normalized);
    }
  }
  return dedupeSortedStrings(found);
}

export function collectProjectMemoryArtifactsFromTask(
  task: TaskRecord,
  toolRuns: ToolRunRecord[] = [],
  options: ProjectMemoryArtifactOptions = {}
): string[] {
  const metadata = task.metadata as {
    toolChangedFiles?: unknown;
  };
  const metadataFilesRaw = metadata.toolChangedFiles;
  const metadataFiles = Array.isArray(metadataFilesRaw)
    ? metadataFilesRaw
        .filter((item): item is string => typeof item === "string")
        .flatMap((item) => extractArtifactFilesFromText(item, options))
    : typeof metadataFilesRaw === "string"
      ? extractArtifactFilesFromText(metadataFilesRaw, options)
      : [];
  const resultFiles = extractArtifactFilesFromText(
    [task.result?.summary ?? "", task.result?.deliverable ?? ""].filter(Boolean).join("\n"),
    options
  );
  const toolRunFiles = toolRuns.flatMap((toolRun) =>
    extractArtifactFilesFromText([toolRun.outputText ?? "", toolRun.errorText ?? ""].join("\n"), options)
  );
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

function now(): string {
  return new Date().toISOString();
}

function normalizeOrchestrationMode(value: unknown): ProjectMemoryRecord["orchestrationMode"] {
  return value === "main_agent" ? "main_agent" : undefined;
}

function normalizeRoleId(value: unknown): RoleId | undefined {
  return typeof value === "string" && (ROLE_IDS as readonly string[]).includes(value) ? (value as RoleId) : undefined;
}

function normalizeVerificationStatus(
  value: unknown
): ProjectMemoryRecord["orchestrationVerificationStatus"] {
  return value === "pending" || value === "verified" || value === "failed" ? value : undefined;
}

export function normalizeProjectMemory(value: unknown): ProjectMemoryRecord {
  const source = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  return {
    version: 1,
    currentGoal: normalizeString(source.currentGoal),
    currentStage: normalizeString(source.currentStage),
    latestUserRequest: normalizeString(source.latestUserRequest),
    latestSummary: normalizeString(source.latestSummary),
    keyDecisions: normalizeStringArray(source.keyDecisions, 8),
    unresolvedQuestions: normalizeStringArray(source.unresolvedQuestions, 8),
    nextActions: normalizeStringArray(source.nextActions, 8),
    latestArtifacts: normalizeStringArray(source.latestArtifacts, 12),
    updatedAt: normalizeString(source.updatedAt) || now(),
    updatedBy: normalizeString(source.updatedBy),
    lastTaskId: normalizeString(source.lastTaskId) || undefined,
    orchestrationMode: normalizeOrchestrationMode(source.orchestrationMode),
    orchestrationOwnerRoleId: normalizeRoleId(source.orchestrationOwnerRoleId),
    orchestrationVerificationStatus: normalizeVerificationStatus(source.orchestrationVerificationStatus)
  };
}

export function mergeProjectMemory(current: unknown, patch: ProjectMemoryUpdate): ProjectMemoryRecord {
  const base = normalizeProjectMemory(current);
  const updatedAt = normalizeString(patch.updatedAt) || now();
  const updatedBy = normalizeString(patch.updatedBy) || base.updatedBy;
  const direct = (value: string | undefined, fallback: string): string => {
    const normalized = normalizeString(value);
    return normalized || fallback;
  };

  return {
    version: 1,
    currentGoal: direct(patch.currentGoal, base.currentGoal),
    currentStage: direct(patch.currentStage, base.currentStage),
    latestUserRequest: direct(patch.latestUserRequest, base.latestUserRequest),
    latestSummary: direct(patch.latestSummary, base.latestSummary),
    keyDecisions:
      patch.keyDecisions !== undefined ? normalizeStringArray(patch.keyDecisions, 8) : normalizeStringArray(base.keyDecisions, 8),
    unresolvedQuestions:
      patch.unresolvedQuestions !== undefined
        ? normalizeStringArray(patch.unresolvedQuestions, 8)
        : normalizeStringArray(base.unresolvedQuestions, 8),
    nextActions:
      patch.nextActions !== undefined ? normalizeStringArray(patch.nextActions, 8) : normalizeStringArray(base.nextActions, 8),
    latestArtifacts:
      patch.latestArtifacts !== undefined
        ? normalizeStringArray(patch.latestArtifacts, 12)
        : normalizeStringArray(base.latestArtifacts, 12),
    updatedAt,
    updatedBy,
    lastTaskId: direct(patch.lastTaskId, base.lastTaskId ?? "") || undefined,
    orchestrationMode:
      patch.orchestrationMode !== undefined ? normalizeOrchestrationMode(patch.orchestrationMode) : base.orchestrationMode,
    orchestrationOwnerRoleId:
      patch.orchestrationOwnerRoleId !== undefined
        ? normalizeRoleId(patch.orchestrationOwnerRoleId)
        : base.orchestrationOwnerRoleId,
    orchestrationVerificationStatus:
      patch.orchestrationVerificationStatus !== undefined
        ? normalizeVerificationStatus(patch.orchestrationVerificationStatus)
        : base.orchestrationVerificationStatus
  };
}

export function buildProjectMemoryUpdateFromTask(
  task: TaskRecord,
  patch: ProjectMemoryTaskPatch = {},
  toolRuns: ToolRunRecord[] = [],
  options: ProjectMemoryArtifactOptions = {}
): ProjectMemoryUpdate {
  const artifacts = (patch.latestArtifacts ?? collectProjectMemoryArtifactsFromTask(task, toolRuns, options)).slice(0, 12);
  const result = task.result;
  const stage =
    patch.currentStage ??
    (task.status === "completed" ? "delivered" : task.status === "failed" || task.status === "cancelled" ? "blocked" : "executing");
  const latestSummary =
    patch.latestSummary ??
    (task.status === "completed"
      ? toProjectMemorySummary(result?.summary ?? result?.deliverable ?? "")
      : toProjectMemorySummary(task.errorText ?? ""));
  const nextActions =
    patch.nextActions ??
    (task.status === "completed" ? (result?.followUps ?? []).slice(0, 6) : []);
  const unresolvedQuestions =
    patch.unresolvedQuestions ??
    (task.status === "failed" || task.status === "cancelled" ? [task.errorText ?? "任务受阻"] : []);

  return {
    currentGoal: task.title,
    currentStage: stage,
    latestSummary,
    keyDecisions: extractProjectMemoryDecisions(task),
    unresolvedQuestions,
    nextActions,
    latestArtifacts: artifacts,
    lastTaskId: task.id,
    updatedBy: task.roleId,
    orchestrationMode: patch.orchestrationMode,
    orchestrationOwnerRoleId: patch.orchestrationOwnerRoleId,
    orchestrationVerificationStatus: patch.orchestrationVerificationStatus
  };
}

export function syncSessionProjectMemoryFromTask(
  store: ProjectMemoryTaskSyncStore,
  task: TaskRecord,
  patch: ProjectMemoryTaskPatch = {},
  options: ProjectMemoryArtifactOptions = {}
): void {
  if (!task.sessionId) {
    return;
  }
  const toolRuns = store.listToolRunsByTask?.(task.id) ?? [];
  store.updateSessionProjectMemory(
    task.sessionId,
    buildProjectMemoryUpdateFromTask(task, patch, toolRuns, options),
    {
      lastTaskId: task.id,
      lastTaskStatus: task.status,
      lastTaskRoleId: task.roleId
    }
  );
}

import type { GoalRunRecord, TaskRecord, VinkoStore } from "@vinko/shared";

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
    collaborationMode?: boolean;
    collaborationId?: string;
    isAggregation?: boolean;
  };
  const metadataFiles = toStringArray(metadata.toolChangedFiles);
  const resultText = `${task.result?.summary ?? ""}\n${task.result?.deliverable ?? ""}`;
  const resultFiles = extractArtifactFilesFromText(resultText);
  const toolRuns = store.listToolRunsByTask(task.id);
  const toolRunFiles = toolRuns.flatMap((item) =>
    extractArtifactFilesFromText(`${item.outputText ?? ""}\n${item.errorText ?? ""}`)
  );
  const artifactFiles = Array.from(new Set([...metadataFiles, ...resultFiles, ...toolRunFiles])).sort((a, b) =>
    a.localeCompare(b)
  );

  let collaborationEvidence: Record<string, unknown> | undefined;
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
      childTotal: children.length,
      childCompleted: children.filter((child) => child.status === "completed").length,
      childFailed: children.filter((child) => child.status === "failed" || child.status === "cancelled").length,
      completedRoles,
      failedRoles
    };
  }

  const startedMs = parseIsoMs(task.startedAt);
  const completedMs = parseIsoMs(task.completedAt);
  const executionMs =
    startedMs !== undefined && completedMs !== undefined && completedMs >= startedMs
      ? completedMs - startedMs
      : undefined;

  return {
    ...task,
    failureCategory: classifyFailureCategory({
      status: task.status,
      errorText: task.errorText
    }),
    completionEvidence: {
      hasDeliverable: Boolean(task.result?.deliverable?.trim()),
      artifactFiles,
      toolRunSummary: {
        total: toolRuns.length,
        completed: toolRuns.filter((item) => item.status === "completed").length,
        failed: toolRuns.filter((item) => item.status === "failed").length
      },
      ...(collaborationEvidence ? { collaboration: collaborationEvidence } : {}),
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
      failedRoles
    }
  };
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

import type { TaskRecord } from "./types.js";
import { normalizeOrchestrationState } from "./orchestration-state.js";

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function uniqueLines(lines: Array<string | undefined | null>, limit = 5): string[] {
  return Array.from(
    new Set(
      lines
        .filter((line): line is string => typeof line === "string")
        .map((line) => line.trim())
        .filter(Boolean)
    )
  ).slice(0, limit);
}

function toStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function inferExportFormats(paths: string[]): string[] {
  const formats = new Map<string, string>();
  for (const filePath of paths) {
    const normalized = filePath.trim().toLowerCase();
    if (normalized.endsWith(".md")) {
      formats.set("md", "Markdown");
    } else if (normalized.endsWith(".html")) {
      formats.set("html", "HTML");
    } else if (normalized.endsWith(".csv")) {
      formats.set("csv", "CSV");
    } else if (normalized.endsWith(".pdf")) {
      formats.set("pdf", "PDF");
    } else if (normalized.endsWith(".doc") || normalized.endsWith(".docx")) {
      formats.set("doc", "DOCX");
    } else if (normalized.endsWith(".xls") || normalized.endsWith(".xlsx")) {
      formats.set("xls", "Excel");
    }
  }
  return Array.from(formats.values());
}

function firstNonEmpty(...values: unknown[]): string {
  for (const value of values) {
    const normalized = clean(value);
    if (normalized) {
      return normalized;
    }
  }
  return "";
}

export function buildWorkflowStatusSummary(
  task: Pick<TaskRecord, "title" | "status" | "metadata">,
  options: {
    includeGoal?: boolean;
    includeArtifacts?: boolean;
  } = {}
): string {
  const orchestration = normalizeOrchestrationState(task.metadata?.orchestrationState);
  const progress = orchestration?.progress;
  const spec = orchestration?.spec;
  const artifactIndex = orchestration?.artifactIndex;
  const workflowLabel = firstNonEmpty(task.metadata?.workflowLabel, task.metadata?.routeTemplateName);
  const workflowSuccessCriteria = uniqueLines(
    Array.isArray(task.metadata?.workflowSuccessCriteria)
      ? (task.metadata.workflowSuccessCriteria as string[])
      : spec?.successCriteria ?? [],
    3
  );
  const workflowCompletionSignal = firstNonEmpty(task.metadata?.workflowCompletionSignal);

  const lines: string[] = [];

  if (workflowLabel) {
    lines.push(`**工作流**：${workflowLabel}`);
  }

  if (options.includeGoal !== false) {
    const goal = spec?.goal || clean(task.title);
    if (goal) {
      lines.push(`**目标**：${goal}`);
    }
  }

  const stage = clean(progress?.stage);
  const status = clean(progress?.status) || clean(task.status);
  if (stage || status) {
    lines.push(`**当前阶段**：${stage || "-"} · ${status || "-"}`);
  }

  const nextActions = uniqueLines(progress?.nextActions ?? [], 2);
  if (nextActions.length > 0) {
    lines.push(`**下一步**：${nextActions.join("；")}`);
  }

  const awaitingInput = uniqueLines(progress?.awaitingInput ?? [], 2);
  if (awaitingInput.length > 0) {
    lines.push(`**待补充**：${awaitingInput.join("；")}`);
  }

  const blocked = uniqueLines(progress?.blocked ?? [], 2);
  if (blocked.length > 0) {
    lines.push(`**阻塞**：${blocked.join("；")}`);
  }

  if (workflowSuccessCriteria.length > 0) {
    lines.push(`**成功标准**：${workflowSuccessCriteria.join("；")}`);
  }

  if (workflowCompletionSignal) {
    lines.push(`**完成信号**：${workflowCompletionSignal}`);
  }

  if (options.includeArtifacts === true) {
    const artifacts = uniqueLines(
      (artifactIndex?.items ?? []).map((item) => item.title || item.path),
      2
    );
    if (artifacts.length > 0) {
      lines.push(`**产物**：${artifacts.join("；")}`);
    }

    const exportFormats = inferExportFormats([
      ...(artifactIndex?.items ?? []).map((item) => item.path),
      ...toStringList(task.metadata?.toolChangedFiles)
    ]);
    if (exportFormats.length > 0) {
      lines.push(`**导出**：${exportFormats.join(" / ")}`);
    }
  }

  return lines.join("\n");
}

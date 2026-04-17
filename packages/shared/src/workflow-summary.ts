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

  const lines: string[] = [];

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

  if (options.includeArtifacts === true) {
    const artifacts = uniqueLines(
      (artifactIndex?.items ?? []).map((item) => item.title || item.path),
      2
    );
    if (artifacts.length > 0) {
      lines.push(`**产物**：${artifacts.join("；")}`);
    }
  }

  return lines.join("\n");
}

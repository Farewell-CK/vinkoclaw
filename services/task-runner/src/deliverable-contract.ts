import { DELIVERABLE_MODES, type DeliverableMode, type TaskRecord } from "@vinko/shared";

const VALID_DELIVERABLE_MODES = new Set<DeliverableMode>(DELIVERABLE_MODES);
const ARTIFACT_PREFERRED_PATTERN =
  /(?:\bprd\b|roadmap|spec|report|brief|proposal|docx|pdf|markdown|\.md\b|文档|文件|报告|方案|简介|需求文档|产品需求|路线图|纪要|总结)/i;

export function resolveDeliverableMode(task: TaskRecord): DeliverableMode {
  const metadata = task.metadata as { deliverableMode?: unknown };
  if (typeof metadata.deliverableMode === "string") {
    const normalized = metadata.deliverableMode.trim().toLowerCase();
    if (VALID_DELIVERABLE_MODES.has(normalized as DeliverableMode)) {
      return normalized as DeliverableMode;
    }
  }
  const sample = `${task.title}\n${task.instruction}`;
  return ARTIFACT_PREFERRED_PATTERN.test(sample) ? "artifact_preferred" : "answer_only";
}

export function validateDeliverableArtifacts(input: {
  task: TaskRecord;
  artifactFiles: string[];
}): { ok: true; mode: DeliverableMode } | { ok: false; mode: DeliverableMode; error: string } {
  const mode = resolveDeliverableMode(input.task);
  if (mode !== "artifact_required") {
    return { ok: true, mode };
  }
  if (input.artifactFiles.length > 0) {
    return { ok: true, mode };
  }
  return {
    ok: false,
    mode,
    error: "Deliverable contract violated: task requires a persisted artifact, but none was produced."
  };
}

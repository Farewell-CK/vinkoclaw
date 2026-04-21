import { describe, expect, it } from "vitest";
import type { TaskRecord } from "@vinko/shared";
import { resolveDeliverableMode, validateDeliverableArtifacts } from "./deliverable-contract.js";

function buildTask(patch: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task_1",
    source: "control-center",
    roleId: "ceo",
    title: "task",
    instruction: "do work",
    status: "queued",
    priority: 80,
    metadata: {},
    createdAt: "2026-04-12T00:00:00.000Z",
    updatedAt: "2026-04-12T00:00:00.000Z",
    ...patch
  };
}

describe("deliverable-contract", () => {
  it("honors explicit deliverable mode from metadata", () => {
    const task = buildTask({
      metadata: {
        deliverableMode: "artifact_required"
      }
    });
    expect(resolveDeliverableMode(task)).toBe("artifact_required");
  });

  it("infers artifact_preferred for document-like tasks", () => {
    const task = buildTask({
      title: "Write PRD",
      instruction: "请输出产品需求文档"
    });
    expect(resolveDeliverableMode(task)).toBe("artifact_preferred");
  });

  it("fails validation when artifact_required task has no artifact", () => {
    const result = validateDeliverableArtifacts({
      task: buildTask({
        metadata: {
          deliverableMode: "artifact_required"
        }
      }),
      artifactFiles: []
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.mode).toBe("artifact_required");
    }
  });
});

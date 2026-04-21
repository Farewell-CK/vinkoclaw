import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VinkoStore, type TaskRecord } from "@vinko/shared";
import {
  formatAwaitingCollaborationMessage,
  resolveAwaitingCollaborationTaskForInbound,
  resumeAwaitingCollaborationTask
} from "./inbound-collaboration.js";

const tempDirs: string[] = [];

function createTestStore(): VinkoStore {
  const dir = mkdtempSync(path.join(tmpdir(), "vinkoclaw-inbound-collab-"));
  tempDirs.push(dir);
  return new VinkoStore(path.join(dir, "test.sqlite"));
}

function buildTask(patch: Partial<TaskRecord>): TaskRecord {
  return {
    id: "task_1",
    source: "feishu",
    roleId: "ceo",
    title: "task",
    instruction: "do task",
    status: "completed",
    priority: 80,
    requestedBy: "ou_owner",
    chatId: "oc_1234567890abcdefghijklmn",
    metadata: {},
    createdAt: "2026-04-12T00:00:00.000Z",
    updatedAt: "2026-04-12T00:00:00.000Z",
    ...patch
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("inbound-collaboration", () => {
  it("selects the latest await_user collaboration task for inbound resume", () => {
    const older = buildTask({
      id: "task_old",
      updatedAt: "2026-04-12T00:00:00.000Z",
      metadata: {
        collaborationId: "collab_1",
        collaborationStatus: "await_user"
      }
    });
    const latest = buildTask({
      id: "task_latest",
      updatedAt: "2026-04-12T01:00:00.000Z",
      metadata: {
        collaborationId: "collab_2",
        collaborationStatus: "await_user"
      }
    });
    const unrelated = buildTask({
      id: "task_other",
      requestedBy: "ou_other",
      metadata: {
        collaborationId: "collab_3",
        collaborationStatus: "await_user"
      }
    });

    const resolved = resolveAwaitingCollaborationTaskForInbound({
      source: "feishu",
      requestedBy: "ou_owner",
      chatId: "oc_1234567890abcdefghijklmn"
    }, [older, latest, unrelated]);

    expect(resolved?.id).toBe("task_latest");
  });

  it("formats pending questions for awaiting collaboration", () => {
    const message = formatAwaitingCollaborationMessage(
      buildTask({
        id: "task_waiting",
        metadata: {
          collaborationPendingQuestions: ["请确认目标用户", "请确认输出格式"]
        }
      })
    );

    expect(message).toContain("task_wai");
    expect(message).toContain("请确认目标用户");
    expect(message).toContain("不会重新开一条任务");
  });

  it("stores user supplements and requeues the parent task", () => {
    const store = createTestStore();
    const parent = store.createTask({
      source: "feishu",
      roleId: "ceo",
      title: "协作父任务",
      instruction: "继续推进",
      requestedBy: "ou_owner",
      chatId: "oc_1234567890abcdefghijklmn",
      metadata: {
        collaborationId: "collab_1",
        collaborationStatus: "await_user",
        collaborationPendingQuestions: ["请确认用户画像"],
        collaborationUserSupplements: [
          {
            text: "之前补充：行业是 AI 工具",
            at: "2026-04-12T00:00:00.000Z"
          }
        ]
      }
    });

    const resumed = resumeAwaitingCollaborationTask(store, {
      task: parent,
      text: "目标用户是独立开发者",
      requesterName: "owner"
    });

    expect(resumed.status).toBe("queued");
    const updated = store.getTask(parent.id);
    expect(updated?.metadata.collaborationResumeRequested).toBe(true);
    expect(updated?.metadata.collaborationStatus).toBe("active");
    expect(updated?.metadata.collaborationPhase).toBe("converge");
    expect(updated?.metadata.collaborationPendingQuestions).toEqual([]);
    const supplements = updated?.metadata.collaborationUserSupplements as Array<Record<string, unknown>>;
    expect(supplements).toHaveLength(2);
    expect(supplements[1]?.text).toBe("目标用户是独立开发者");
    expect(supplements[1]?.requesterName).toBe("owner");
  });
});

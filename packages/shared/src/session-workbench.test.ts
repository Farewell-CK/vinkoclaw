import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach } from "vitest";
import { describe, expect, it } from "vitest";
import { buildSessionWorkbenchSnapshot, buildSessionWorkbenchSnapshotFromStore } from "./session-workbench.js";
import { VinkoStore } from "./store.js";
import type {
  ApprovalRecord,
  GoalRunRecord,
  SessionRecord,
  SkillBindingRecord,
  TaskRecord
} from "./types.js";

const tempDirs: string[] = [];

function createStore(): VinkoStore {
  const dir = mkdtempSync(path.join(tmpdir(), "vinkoclaw-session-workbench-"));
  tempDirs.push(dir);
  return new VinkoStore(path.join(dir, "test.sqlite"));
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function buildSession(patch: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "session_1",
    source: "feishu",
    sourceKey: "chat:oc_1234567890abcdefghijklmn",
    title: "Feishu oc_xxx",
    status: "active",
    metadata: {
      projectMemory: {
        currentGoal: "交付创业项目首版",
        currentStage: "execute",
        latestSummary: "已经进入实现阶段",
        nextActions: ["继续完成首页和注册流程"],
        latestArtifacts: ["docs/spec.md"],
        unresolvedQuestions: ["是否需要支持双语"],
        keyDecisions: [],
        latestUserRequest: "继续推进",
        updatedAt: "2026-04-23T00:00:00.000Z",
        updatedBy: "product"
      }
    },
    createdAt: "2026-04-23T00:00:00.000Z",
    updatedAt: "2026-04-23T00:00:00.000Z",
    lastMessageAt: "2026-04-23T00:00:00.000Z",
    ...patch
  };
}

function buildTask(patch: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task_1",
    sessionId: "session_1",
    source: "feishu",
    roleId: "frontend",
    title: "实现首页和注册流程",
    instruction: "完成 landing page 和注册",
    status: "running",
    priority: 80,
    metadata: {},
    createdAt: "2026-04-23T00:00:00.000Z",
    updatedAt: "2026-04-23T00:05:00.000Z",
    ...patch
  };
}

function buildGoalRun(patch: Partial<GoalRunRecord> = {}): GoalRunRecord {
  return {
    id: "goal_1",
    source: "feishu",
    objective: "完成创业项目首版交付",
    status: "running",
    currentStage: "execute",
    language: "zh",
    metadata: {},
    context: {},
    retryCount: 0,
    maxRetries: 2,
    awaitingInputFields: [],
    createdAt: "2026-04-23T00:00:00.000Z",
    updatedAt: "2026-04-23T00:10:00.000Z",
    sessionId: "session_1",
    ...patch
  };
}

function buildApproval(patch: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return {
    id: "approval_1",
    kind: "set_runtime_setting",
    status: "pending",
    summary: "需要确认部署授权",
    payload: {},
    requestedBy: "ou_owner",
    createdAt: "2026-04-23T00:00:00.000Z",
    updatedAt: "2026-04-23T00:10:00.000Z",
    taskId: "task_1",
    ...patch
  };
}

describe("session-workbench", () => {
  it("builds a session-focused workbench snapshot", () => {
    const snapshot = buildSessionWorkbenchSnapshot({
      session: buildSession(),
      sessions: [buildSession()],
      tasks: [buildTask()],
      approvals: [buildApproval()],
      goalRuns: [buildGoalRun()],
      roleBindingsByRole: {} as Partial<Record<string, SkillBindingRecord[]>>,
      workspaceMemory: undefined,
      crmLeads: [],
      crmCadences: [],
      crmContacts: [],
      goalRunHandoffs: [],
      goalRunTraces: []
    });

    expect(snapshot.sessionId).toBe("session_1");
    expect(snapshot.currentGoal).toContain("创业项目首版");
    expect(snapshot.activeTask?.title).toContain("首页");
    expect(snapshot.activeGoalRun?.status).toBe("running");
    expect(snapshot.pendingApproval?.summary).toContain("部署授权");
    expect(snapshot.nextActions[0]).toContain("继续完成首页");
  });

  it("builds a session workbench snapshot from VinkoStore", () => {
    const store = createStore();
    const session = store.ensureSession({
      source: "feishu",
      sourceKey: "chat:oc_1234567890abcdefghijklmn",
      title: "Feishu workbench session"
    });
    store.updateSessionProjectMemory(session.id, {
      currentGoal: "交付通用智能体",
      currentStage: "execute",
      latestSummary: "正在完成工作台状态回报",
      nextActions: ["继续接入 milestone 推送"],
      latestArtifacts: ["docs/workbench.md"],
      updatedBy: "cto"
    });
    const task = store.createTask({
      sessionId: session.id,
      source: "feishu",
      roleId: "engineering",
      title: "接入工作台推送",
      instruction: "完成 milestone workbench notifier",
      chatId: "oc_1234567890abcdefghijklmn",
      metadata: {}
    });
    store.createGoalRun({
      source: "feishu",
      objective: "稳定交付通用智能体",
      sessionId: session.id,
      chatId: "oc_1234567890abcdefghijklmn"
    });
    store.createApproval({
      kind: "set_runtime_setting",
      summary: "确认是否启用工作台自动推送",
      payload: {},
      requestedBy: "ou_owner",
      taskId: task.id
    });

    const snapshot = buildSessionWorkbenchSnapshotFromStore({ store, sessionId: session.id });

    expect(snapshot?.sessionId).toBe(session.id);
    expect(snapshot?.currentGoal).toContain("通用智能体");
    expect(snapshot?.activeTask?.title).toBe("接入工作台推送");
    expect(snapshot?.activeGoalRun?.objective).toContain("稳定交付");
    expect(snapshot?.pendingApproval?.summary).toContain("工作台自动推送");
  });
});

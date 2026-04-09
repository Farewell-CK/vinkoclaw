import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VinkoStore } from "./store.js";

const tempDirs: string[] = [];

function createTestStore(): VinkoStore {
  const dir = mkdtempSync(path.join(tmpdir(), "vinkoclaw-store-"));
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

describe("VinkoStore operator actions", () => {
  it("applies role memory backend changes after approval", () => {
    const store = createTestStore();
    const action = store.createOperatorAction({
      kind: "set_memory_backend",
      targetRoleId: "research",
      summary: "Set research memory backend to vector-db",
      payload: {
        backend: "vector-db"
      },
      createdBy: "owner"
    });

    store.applyOperatorAction(action.id, "owner");

    const config = store.getRuntimeConfig();
    expect(config.memory.roleBackends.research).toBe("vector-db");
  });

  it("enables a skill on the requested role", () => {
    const store = createTestStore();
    const action = store.createOperatorAction({
      kind: "install_skill",
      targetRoleId: "operations",
      skillId: "email-ops",
      summary: "Install email-ops for operations",
      payload: {},
      createdBy: "owner"
    });

    store.applyOperatorAction(action.id, "owner");

    const operationsSkills = store.resolveSkillsForRole("operations");
    expect(operationsSkills.some((entry) => entry.skillId === "email-ops")).toBe(true);
  });

  it("seeds default active agent instances", () => {
    const store = createTestStore();
    const instances = store.listActiveAgentInstances();
    expect(instances.length).toBeGreaterThan(0);
    expect(instances.some((entry) => entry.roleId === "qa")).toBe(true);
  });

  it("applies add/remove/tone agent instance actions", () => {
    const store = createTestStore();

    const addAction = store.createOperatorAction({
      kind: "add_agent_instance",
      targetRoleId: "qa",
      summary: "Add qa agent instance",
      payload: {
        roleId: "qa",
        name: "QA Shadow",
        tonePolicy: "严谨、客观"
      },
      createdBy: "owner"
    });
    store.applyOperatorAction(addAction.id, "owner");
    const qaInstances = store.listActiveAgentInstances("qa");
    const added = qaInstances.find((entry) => entry.name === "QA Shadow");
    expect(added).toBeTruthy();
    expect(added?.tonePolicy).toContain("严谨");

    const toneAction = store.createOperatorAction({
      kind: "set_agent_tone_policy",
      targetRoleId: "qa",
      summary: "Set qa tone policy",
      payload: {
        roleId: "qa",
        name: "QA Shadow",
        tonePolicy: "简洁、直接"
      },
      createdBy: "owner"
    });
    store.applyOperatorAction(toneAction.id, "owner");
    const updated = store.getAgentInstance(added!.id);
    expect(updated?.tonePolicy).toContain("简洁");

    const removeAction = store.createOperatorAction({
      kind: "remove_agent_instance",
      targetRoleId: "qa",
      summary: "Remove qa agent instance",
      payload: {
        roleId: "qa",
        name: "QA Shadow"
      },
      createdBy: "owner"
    });
    store.applyOperatorAction(removeAction.id, "owner");
    const removed = store.getAgentInstance(added!.id);
    expect(removed?.status).toBe("inactive");
  });

  it("stores and lists collaboration timeline events", () => {
    const store = createTestStore();
    const parent = store.createTask({
      source: "system",
      roleId: "ceo",
      title: "collab parent",
      instruction: "collab"
    });
    const collaborationId = "collab-test-1";
    const timestamp = new Date().toISOString();
    store.createAgentCollaboration({
      id: collaborationId,
      parentTaskId: parent.id,
      status: "active",
      participants: ["product", "backend", "qa"],
      facilitator: "ceo",
      currentPhase: "assignment",
      phaseResults: [],
      config: {
        maxRounds: 3,
        discussionTimeoutMs: 10_000,
        requireConsensus: false,
        pushIntermediateResults: true,
        autoAggregateOnComplete: true,
        aggregateTimeoutMs: 20_000
      },
      createdAt: timestamp,
      updatedAt: timestamp
    });
    store.createCollaborationTimelineEvent({
      collaborationId,
      eventType: "collaboration_started",
      message: "started",
      roleId: "ceo",
      taskId: parent.id,
      metadata: {
        source: "test"
      }
    });
    const timeline = store.listCollaborationTimelineEvents(collaborationId);
    expect(timeline.length).toBe(1);
    expect(timeline[0]?.eventType).toBe("collaboration_started");
  });

  it("supports goal run lifecycle with staged state, input and auth token", () => {
    const store = createTestStore();
    const run = store.createGoalRun({
      source: "system",
      objective: "帮我搭建公司网站并部署",
      requestedBy: "owner"
    });
    expect(run.status).toBe("queued");
    expect(run.currentStage).toBe("discover");

    const claimed = store.claimNextQueuedGoalRun();
    expect(claimed?.id).toBe(run.id);
    expect(claimed?.status).toBe("running");

    const waiting = store.markGoalRunAwaitingInput({
      goalRunId: run.id,
      stage: "discover",
      prompt: "请补充 company_name",
      fields: ["company_name"]
    });
    expect(waiting?.status).toBe("awaiting_input");
    expect(waiting?.awaitingInputFields).toContain("company_name");

    store.upsertGoalRunInput({
      goalRunId: run.id,
      inputKey: "company_name",
      value: "Vinko"
    });
    const inputMap = store.getGoalRunInputMap(run.id);
    expect(inputMap.company_name).toBe("Vinko");

    const resumed = store.queueGoalRun(run.id, "plan");
    expect(resumed?.status).toBe("queued");
    expect(resumed?.currentStage).toBe("plan");

    const token = store.createRunAuthToken({
      goalRunId: run.id,
      scope: "deploy:aliyun"
    });
    expect(token.status).toBe("active");
    const consumed = store.consumeRunAuthToken({
      token: token.token,
      goalRunId: run.id,
      scope: "deploy:aliyun",
      usedBy: "owner"
    });
    expect(consumed?.status).toBe("used");
    expect(consumed?.usedBy).toBe("owner");

    const completed = store.completeGoalRun(run.id, {
      summary: "done",
      deliverable: "deliverable",
      nextActions: []
    });
    expect(completed?.status).toBe("completed");
  });

  it("cancels in-flight goal-run tasks and descendants when goal run is cancelled", () => {
    const store = createTestStore();
    const run = store.createGoalRun({
      source: "system",
      objective: "搭建公司网站",
      requestedBy: "owner"
    });

    const parent = store.createTask({
      source: "system",
      roleId: "ceo",
      title: "GoalRun执行主任务",
      instruction: "执行目标任务",
      metadata: {
        goalRunId: run.id
      }
    });
    const child = store.createTask({
      source: "system",
      roleId: "frontend",
      title: "子任务",
      instruction: "实现页面"
    });
    store.createTaskRelation({
      parentTaskId: parent.id,
      childTaskId: child.id,
      relationType: "split"
    });

    store.setGoalRunCurrentTask(run.id, parent.id);
    expect(store.claimNextQueuedTask()?.id).toBe(parent.id);
    expect(store.claimNextQueuedTask()?.id).toBe(child.id);

    const cancelled = store.cancelGoalRun(run.id, "manual stop");
    expect(cancelled?.status).toBe("cancelled");
    expect(cancelled?.currentTaskId).toBeUndefined();
    expect(cancelled?.awaitingInputFields).toEqual([]);
    expect(store.getTask(parent.id)?.status).toBe("cancelled");
    expect(store.getTask(child.id)?.status).toBe("cancelled");
  });

  it("stores credentials encrypted and resolves secret", () => {
    const store = createTestStore();
    const created = store.upsertCredential({
      providerId: "deploy.aliyun",
      credentialKey: "access_key_id",
      value: "ak_test_value",
      createdBy: "owner"
    });
    expect(created.providerId).toBe("deploy.aliyun");
    expect(created.credentialKey).toBe("access_key_id");
    expect(created.valueMasked).not.toContain("ak_test_value");

    const listed = store.listCredentials({ providerId: "deploy.aliyun" });
    expect(listed.length).toBe(1);
    expect(listed[0]?.valueMasked).toBeTruthy();

    const secret = store.resolveCredentialSecret("deploy.aliyun", "access_key_id");
    expect(secret).toBe("ak_test_value");

    const deleted = store.deleteCredential("deploy.aliyun", "access_key_id");
    expect(deleted).toBe(true);
    expect(store.resolveCredentialSecret("deploy.aliyun", "access_key_id")).toBeUndefined();
  });

  it("includes default routing templates and supports CRUD", () => {
    const store = createTestStore();

    const defaults = store.listRoutingTemplates();
    expect(defaults.length).toBeGreaterThan(0);
    expect(defaults.some((template) => template.id === "tpl-opc-internet-launch")).toBe(true);

    const created = store.createRoutingTemplate({
      name: "QA smoke template",
      triggerKeywords: ["smoke", "回归冒烟"],
      tasks: [
        {
          roleId: "qa",
          titleTemplate: "QA smoke: {{input_short}}",
          instructionTemplate: "执行冒烟测试：{{input}}"
        }
      ]
    });
    expect(created.id).toBeTruthy();
    expect(store.getRoutingTemplate(created.id)?.name).toBe("QA smoke template");

    const updated = store.updateRoutingTemplate(created.id, {
      name: "QA smoke template v2",
      enabled: false
    });
    expect(updated?.name).toBe("QA smoke template v2");
    expect(updated?.enabled).toBe(false);

    const deleted = store.deleteRoutingTemplate(created.id);
    expect(deleted).toBe(true);
    expect(store.getRoutingTemplate(created.id)).toBeUndefined();
  });

  it("supports routing template import and queue metrics snapshot", () => {
    const store = createTestStore();

    const imported = store.importRoutingTemplates(
      [
        {
          id: "tpl-test-import",
          name: "Imported Template",
          description: "test import",
          triggerKeywords: ["import-test"],
          matchMode: "any",
          enabled: true,
          tasks: [
            {
              roleId: "frontend",
              titleTemplate: "FE {{input_short}}",
              instructionTemplate: "Do FE {{input}}",
              priority: 80
            }
          ],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      ],
      "merge"
    );
    expect(imported.some((template) => template.id === "tpl-test-import")).toBe(true);

    const queued = store.createTask({
      source: "system",
      roleId: "frontend",
      title: "queued task",
      instruction: "queued"
    });
    expect(queued.status).toBe("queued");

    const runningTask = store.createTask({
      source: "system",
      roleId: "backend",
      title: "running task",
      instruction: "running"
    });
    const claimed = store.claimNextQueuedTask();
    expect(claimed?.id).toBeTruthy();
    if (claimed) {
      store.completeTask(
        claimed.id,
        {
          summary: "done",
          deliverable: "ok",
          citations: [],
          followUps: []
        },
        {
          score: 8,
          confidence: "medium",
          assumptions: [],
          risks: [],
          improvements: []
        }
      );
    }

    const stillQueued = store.getTask(runningTask.id);
    expect(stillQueued?.status).toBe("queued");

    const metrics = store.getQueueMetrics();
    expect(metrics.queuedCount).toBeGreaterThanOrEqual(1);
    expect(metrics.alertLevel).toBeDefined();
    expect(Array.isArray(metrics.byRole)).toBe(true);
    expect(Array.isArray(metrics.byTemplate)).toBe(true);

    const snapshot = store.getDashboardSnapshot();
    expect(snapshot.queueMetrics.queuedCount).toBeGreaterThanOrEqual(1);
  });

  it("normalizes legacy runtime config and keeps queue SLA defaults", () => {
    const store = createTestStore();

    store.setConfigEntry("runtime-config", {
      memory: { defaultBackend: "sqlite", roleBackends: {} },
      routing: { primaryBackend: "sglang", fallbackBackend: "ollama" },
      channels: { feishuEnabled: true, emailEnabled: false },
      approvals: { requireForConfigMutation: true, requireForEmailSend: true }
    });

    const config = store.getRuntimeConfig();
    expect(config.queue.sla.warningWaitMs).toBeGreaterThan(0);
    expect(config.queue.sla.criticalWaitMs).toBeGreaterThan(config.queue.sla.warningWaitMs);
    expect(config.tools.providerOrder.length).toBeGreaterThan(0);
    expect(config.tools.timeoutMs).toBeGreaterThan(0);
  });

  it("raises queue SLA alerts when oldest queued wait exceeds threshold", () => {
    const store = createTestStore();
    store.patchRuntimeConfig((config) => {
      config.queue.sla.warningWaitMs = 1_000;
      config.queue.sla.criticalWaitMs = 2_000;
      return config;
    });

    const queued = store.createTask({
      source: "system",
      roleId: "qa",
      title: "stale queued task",
      instruction: "stale"
    });
    const createdAt = new Date(Date.now() - 5_000).toISOString();
    store.db
      .prepare("UPDATE tasks SET created_at = ?, updated_at = ? WHERE id = ?")
      .run(createdAt, createdAt, queued.id);

    const metrics = store.getQueueMetrics();
    expect(metrics.queuedCount).toBeGreaterThanOrEqual(1);
    expect(metrics.oldestQueuedWaitMs).toBeGreaterThanOrEqual(4_000);
    expect(metrics.alertLevel).toBe("critical");
    expect(metrics.alerts.length).toBeGreaterThan(0);
  });

  it("applies queue aging so old queued tasks can preempt newer high-priority tasks", () => {
    const store = createTestStore();
    const oldLow = store.createTask({
      source: "system",
      roleId: "backend",
      title: "old-low-priority",
      instruction: "old low",
      priority: 30
    });
    const recentHigh = store.createTask({
      source: "system",
      roleId: "frontend",
      title: "recent-high-priority",
      instruction: "recent high",
      priority: 80
    });

    // Aging formula: +1 effective priority per 10 minutes in queue.
    // Make oldLow older by 10 hours => +60 effective bonus => 90 total, which should beat 80.
    const oldCreatedAt = new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString();
    store.db
      .prepare("UPDATE tasks SET created_at = ?, updated_at = ? WHERE id = ?")
      .run(oldCreatedAt, oldCreatedAt, oldLow.id);

    const claimed = store.claimNextQueuedTask();
    expect(claimed?.id).toBe(oldLow.id);
    expect(claimed?.id).not.toBe(recentHigh.id);
  });

  it("supports tool run lifecycle and task execution approval transitions", () => {
    const store = createTestStore();
    const task = store.createTask({
      source: "system",
      roleId: "developer",
      title: "Implement feature",
      instruction: "请开发并测试新功能"
    });

    const run = store.createToolRun({
      taskId: task.id,
      roleId: task.roleId,
      providerId: "codex",
      title: task.title,
      instruction: task.instruction,
      command: "codex",
      args: ["exec", task.instruction],
      riskLevel: "high",
      status: "queued",
      approvalStatus: "not_required"
    });
    expect(run.status).toBe("queued");

    const approval = store.createApproval({
      kind: "task_execution",
      taskId: task.id,
      summary: "Tool execution approval required",
      payload: {
        toolRunId: run.id
      }
    });

    const pending = store.markToolRunApprovalPending(run.id, approval.id);
    expect(pending?.status).toBe("approval_pending");
    expect(pending?.approvalStatus).toBe("pending");
    store.markTaskWaitingApproval(task.id, "waiting approval");
    expect(store.getTask(task.id)?.status).toBe("waiting_approval");

    const approved = store.approveToolRunByApproval(approval.id, "owner");
    expect(approved?.status).toBe("queued");
    expect(approved?.approvalStatus).toBe("approved");
    store.requeueTask(task.id);
    expect(store.getTask(task.id)?.status).toBe("queued");

    const started = store.startToolRun(run.id);
    expect(started?.status).toBe("running");
    const completed = store.completeToolRun(run.id, "done");
    expect(completed?.status).toBe("completed");
    expect(completed?.outputText).toBe("done");
  });

  it("applies tool provider config action and stores runtime secret", () => {
    const store = createTestStore();
    const action = store.createOperatorAction({
      kind: "set_tool_provider_config",
      summary: "Switch opencode model to glm-5",
      payload: {
        providerId: "opencode",
        modelId: "zhipuai/glm-5",
        baseUrl: "https://open.bigmodel.cn/api/paas/v4",
        apiKeyEnv: "ZHIPUAI_API_KEY",
        apiKey: "zhipu_test_key"
      },
      createdBy: "owner"
    });

    store.applyOperatorAction(action.id, "owner");

    const config = store.getRuntimeConfig();
    expect(config.tools.providerModels.opencode).toBe("zhipuai/glm-5");
    expect(config.tools.providerBaseUrls.opencode).toBe("https://open.bigmodel.cn/api/paas/v4");
    const secrets = store.getRuntimeSecrets();
    expect(secrets.ZHIPUAI_API_KEY).toBe("zhipu_test_key");
  });

  it("applies runtime setting action", () => {
    const store = createTestStore();
    const action = store.createOperatorAction({
      kind: "set_runtime_setting",
      summary: "Set SMTP_URL",
      payload: {
        key: "SMTP_URL",
        value: "smtps://example%40qq.com:auth@smtp.qq.com:465"
      },
      createdBy: "owner"
    });

    store.applyOperatorAction(action.id, "owner");
    const settings = store.getRuntimeSettings();
    expect(settings.SMTP_URL).toBe("smtps://example%40qq.com:auth@smtp.qq.com:465");
  });

  it("auto sets SEARCH_PROVIDER when search key is configured", () => {
    const store = createTestStore();
    const action = store.createOperatorAction({
      kind: "set_runtime_setting",
      summary: "Set TAVILY_API_KEY",
      payload: {
        key: "TAVILY_API_KEY",
        value: "tavily_test_key",
        isSecret: true
      },
      createdBy: "owner"
    });

    store.applyOperatorAction(action.id, "owner");
    const settings = store.getRuntimeSettings();
    const secrets = store.getRuntimeSecrets();
    expect(secrets.TAVILY_API_KEY).toBe("tavily_test_key");
    expect(settings.SEARCH_PROVIDER).toBe("tavily");
  });

  it("applies channel enable action", () => {
    const store = createTestStore();
    const action = store.createOperatorAction({
      kind: "set_channel_enabled",
      summary: "Enable email channel",
      payload: {
        channel: "email",
        enabled: true
      },
      createdBy: "owner"
    });

    store.applyOperatorAction(action.id, "owner");
    const config = store.getRuntimeConfig();
    expect(config.channels.emailEnabled).toBe(true);
  });

  it("creates sessions and binds tasks to session id", () => {
    const store = createTestStore();
    const session = store.ensureSession({
      source: "feishu",
      sourceKey: "chat:oc_123",
      title: "Feishu 聊天 oc_123"
    });
    const sameSession = store.ensureSession({
      source: "feishu",
      sourceKey: "chat:oc_123",
      title: "Feishu 聊天 oc_123"
    });
    expect(sameSession.id).toBe(session.id);

    const task = store.createTask({
      sessionId: session.id,
      source: "feishu",
      roleId: "ceo",
      title: "session test",
      instruction: "session test"
    });

    const loadedTask = store.getTask(task.id);
    expect(loadedTask?.sessionId).toBe(session.id);
    expect(store.listSessions(10).length).toBe(1);
  });

  it("records approval history events", () => {
    const store = createTestStore();
    const approval = store.createApproval({
      kind: "task_execution",
      summary: "Need approval",
      payload: { taskId: "task-1" },
      requestedBy: "alice"
    });
    store.decideApproval(approval.id, {
      status: "approved",
      decidedBy: "ceo",
      decisionNote: "looks good"
    });

    const events = store.listApprovalEvents(approval.id);
    expect(events.length).toBe(2);
    expect(events[0]?.eventType).toBe("created");
    expect(events[1]?.eventType).toBe("approved");
  });

  it("stores and lists session messages in order", () => {
    const store = createTestStore();
    const session = store.ensureSession({
      source: "control-center",
      sourceKey: "operator:tester",
      title: "tester session"
    });
    store.appendSessionMessage({
      sessionId: session.id,
      actorType: "user",
      actorId: "tester",
      content: "你好"
    });
    store.appendSessionMessage({
      sessionId: session.id,
      actorType: "system",
      actorId: "orchestrator",
      messageType: "event",
      content: "已创建任务"
    });
    const messages = store.listSessionMessages(session.id);
    expect(messages.length).toBe(2);
    expect(messages[0]?.content).toBe("你好");
    expect(messages[1]?.content).toBe("已创建任务");
  });

  it("stores task relations and returns children", () => {
    const store = createTestStore();
    const parent = store.createTask({
      source: "system",
      roleId: "ceo",
      title: "parent",
      instruction: "parent"
    });
    const child = store.createTask({
      source: "system",
      roleId: "backend",
      title: "child",
      instruction: "child"
    });
    store.createTaskRelation({
      parentTaskId: parent.id,
      childTaskId: child.id,
      relationType: "split"
    });
    const children = store.listTaskChildren(parent.id);
    expect(children.some((entry) => entry.id === child.id)).toBe(true);
  });

  it("recovers stale running tasks by requeue", () => {
    const store = createTestStore();
    const task = store.createTask({
      source: "system",
      roleId: "backend",
      title: "stale running task",
      instruction: "stale running task"
    });
    const claimed = store.claimNextQueuedTask();
    expect(claimed?.id).toBe(task.id);
    const oldTime = new Date(Date.now() - 3 * 60_000).toISOString();
    store.db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(oldTime, task.id);

    const recovered = store.recoverStaleRunningTasks({
      staleAfterMs: 60_000,
      mode: "requeue"
    });
    expect(recovered.recovered).toBe(1);
    expect(recovered.taskIds).toContain(task.id);
    expect(store.getTask(task.id)?.status).toBe("queued");
  });

  it("supports approval workflow steps with sequential decisions", () => {
    const store = createTestStore();
    const approval = store.createApproval({
      kind: "task_execution",
      summary: "Need workflow approval",
      payload: { riskLevel: "high" },
      requestedBy: "owner"
    });
    const workflow = store.ensureApprovalWorkflow(approval.id, ["cto", "ceo"]);
    expect(workflow.steps.length).toBe(2);

    const first = store.getPendingApprovalWorkflowStep(approval.id);
    expect(first?.step.roleId).toBe("cto");
    if (!first) {
      throw new Error("first step missing");
    }
    store.decideApprovalWorkflowStep({
      approvalId: approval.id,
      stepId: first.step.id,
      status: "approved",
      decidedBy: "cto"
    });

    const second = store.getPendingApprovalWorkflowStep(approval.id);
    expect(second?.step.roleId).toBe("ceo");
    if (!second) {
      throw new Error("second step missing");
    }
    const result = store.decideApprovalWorkflowStep({
      approvalId: approval.id,
      stepId: second.step.id,
      status: "approved",
      decidedBy: "ceo"
    });
    expect(result.approval?.status).toBe("approved");
  });
});

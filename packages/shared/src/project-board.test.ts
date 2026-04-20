import { describe, expect, it } from "vitest";
import { buildProjectBoardSnapshot, findProjectBoardProject, listProjectBoardProjects } from "./project-board.js";
import type { CrmCadenceRecord, CrmContactRecord, CrmLeadRecord, SessionRecord, TaskRecord } from "./types.js";

function buildSession(patch: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "session_1",
    source: "control-center",
    sourceKey: "session_1",
    title: "Founder Session",
    status: "active",
    metadata: {},
    createdAt: "2026-04-19T00:00:00.000Z",
    updatedAt: "2026-04-19T00:00:00.000Z",
    lastMessageAt: "2026-04-19T00:00:00.000Z",
    ...patch
  };
}

function buildTask(patch: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task_1",
    sessionId: "session_1",
    source: "control-center",
    roleId: "product",
    title: "推进 founder workflow",
    instruction: "continue",
    status: "queued",
    priority: 80,
    metadata: {},
    createdAt: "2026-04-19T00:00:00.000Z",
    updatedAt: "2026-04-19T00:00:00.000Z",
    ...patch
  };
}

function buildLead(patch: Partial<CrmLeadRecord> = {}): CrmLeadRecord {
  return {
    id: "lead_1",
    name: "Annie Case",
    source: "manual",
    stage: "qualified",
    status: "active",
    tags: [],
    latestSummary: "",
    metadata: {},
    linkedProjectId: "project:opc-增长引擎",
    createdAt: "2026-04-19T00:00:00.000Z",
    updatedAt: "2026-04-19T00:00:00.000Z",
    ...patch
  };
}

function buildCadence(patch: Partial<CrmCadenceRecord> = {}): CrmCadenceRecord {
  return {
    id: "cadence_1",
    leadId: "lead_1",
    label: "weekly follow-up",
    channel: "email",
    intervalDays: 7,
    objective: "安排演示",
    nextRunAt: "2026-04-18T09:00:00.000Z",
    status: "active",
    metadata: {},
    createdAt: "2026-04-19T00:00:00.000Z",
    updatedAt: "2026-04-19T00:00:00.000Z",
    ...patch
  };
}

function buildContact(patch: Partial<CrmContactRecord> = {}): CrmContactRecord {
  return {
    id: "contact_1",
    leadId: "lead_1",
    channel: "email",
    outcome: "replied",
    summary: "对方回复愿意进一步沟通",
    nextAction: "安排演示",
    happenedAt: "2026-04-19T06:00:00.000Z",
    createdAt: "2026-04-19T06:00:00.000Z",
    ...patch
  };
}

describe("project-board", () => {
  it("counts paused_input tasks as awaiting input", () => {
    const snapshot = buildProjectBoardSnapshot({
      sessions: [
        buildSession({
          metadata: {
            projectMemory: {
              currentGoal: "交付 founder 闭环",
              currentStage: "delivery",
              latestSummary: "waiting on clarification",
              updatedAt: "2026-04-19T01:00:00.000Z",
              updatedBy: "product"
            }
          }
        })
      ],
      tasks: [
        buildTask({
          id: "task_paused",
          status: "paused_input",
          title: "确认技术选型",
          pendingInput: {
            question: "请确认是做 Web 还是小程序",
            pausedAt: "2026-04-19T01:10:00.000Z"
          }
        })
      ],
      roleBindingsByRole: {}
    });

    expect(snapshot.summary.awaitingInputTasks).toBe(1);
    expect(snapshot.blockers).toContain("确认技术选型");
  });

  it("falls back to project memory orchestration metadata when orchestration task is absent", () => {
    const snapshot = buildProjectBoardSnapshot({
      sessions: [
        buildSession({
          metadata: {
            projectMemory: {
              currentGoal: "完成主 Agent 交付",
              currentStage: "implementation",
              latestSummary: "主 Agent 正在推进实现",
              updatedAt: "2026-04-19T01:00:00.000Z",
              updatedBy: "product",
              orchestrationMode: "main_agent",
              orchestrationOwnerRoleId: "product",
              orchestrationVerificationStatus: "pending"
            }
          }
        })
      ],
      tasks: [],
      roleBindingsByRole: {}
    });

    expect(snapshot.primary?.orchestrationMode).toBe("main_agent");
    expect(snapshot.primary?.orchestrationOwnerRoleId).toBe("product");
    expect(snapshot.primary?.orchestrationVerificationStatus).toBe("pending");
  });

  it("builds grouped projects and history from workspace memory and sessions", () => {
    const snapshot = buildProjectBoardSnapshot({
      sessions: [
        buildSession({
          id: "session_a",
          title: "OPC 增长引擎",
          updatedAt: "2026-04-19T03:00:00.000Z",
          metadata: {
            projectMemory: {
              currentGoal: "OPC 增长引擎",
              currentStage: "research",
              latestSummary: "完成第一轮增长调研",
              latestArtifacts: ["reports/growth-research.md"],
              updatedAt: "2026-04-19T03:00:00.000Z",
              updatedBy: "research"
            }
          }
        }),
        buildSession({
          id: "session_b",
          title: "OPC 增长引擎 - 实现",
          updatedAt: "2026-04-19T04:00:00.000Z",
          metadata: {
            projectMemory: {
              currentGoal: "OPC 增长引擎",
              currentStage: "implementation",
              latestSummary: "首页实验开始开发",
              latestArtifacts: ["apps/landing/index.html"],
              updatedAt: "2026-04-19T04:00:00.000Z",
              updatedBy: "frontend"
            }
          }
        }),
        buildSession({
          id: "session_archived",
          status: "archived",
          title: "旧项目归档",
          updatedAt: "2026-04-18T01:00:00.000Z",
          metadata: {
            projectMemory: {
              currentGoal: "旧项目归档",
              currentStage: "done",
              latestSummary: "项目已归档",
              updatedAt: "2026-04-18T01:00:00.000Z",
              updatedBy: "operations"
            }
          }
        })
      ],
      tasks: [],
      roleBindingsByRole: {},
      workspaceMemory: {
        userPreferences: {
          preferredLanguage: "zh",
          preferredTechStack: [],
          communicationStyle: "concise"
        },
        keyDecisions: [],
        projectContext: {
          currentGoals: ["OPC 增长引擎"],
          activeProjects: [
            {
              id: "project:opc-增长引擎",
              name: "OPC 增长引擎",
              stage: "implementation",
              status: "active",
              lastUpdate: "2026-04-19T05:00:00.000Z"
            }
          ]
        },
        updatedAt: "2026-04-19T05:00:00.000Z"
      },
      crmLeads: [buildLead()],
      crmCadences: [buildCadence()],
      crmContacts: [buildContact()]
    });

    expect(snapshot.summary.activeProjects).toBe(1);
    expect(snapshot.summary.archivedProjects).toBe(1);
    expect(snapshot.projects).toHaveLength(1);
    expect(snapshot.projects[0]?.name).toBe("OPC 增长引擎");
    expect(snapshot.projects[0]?.history).toHaveLength(6);
    expect(snapshot.projects[0]?.history[0]?.updatedAt).toBe("2026-04-19T06:00:00.000Z");
    expect(snapshot.projects[0]?.history.map((entry) => entry.kind)).toEqual(
      expect.arrayContaining(["workspace", "session", "crm_lead", "crm_cadence", "crm_contact"])
    );
    expect(snapshot.projects[0]?.latestArtifacts).toEqual(
      expect.arrayContaining(["reports/growth-research.md", "apps/landing/index.html"])
    );
    expect(snapshot.summary.activeLeads).toBe(1);
    expect(snapshot.summary.activeCadences).toBe(1);
    expect(snapshot.summary.overdueCadences).toBe(1);
    expect(snapshot.projects[0]?.health).toBe("watch");
    expect(snapshot.projects[0]?.priority).toBe("high");
    expect(snapshot.projects[0]?.crmLeadCount).toBe(1);
    expect(snapshot.projects[0]?.crmActiveCadences).toBe(1);
    expect(snapshot.projects[0]?.crmOverdueCadences).toBe(1);
    expect(snapshot.archivedProjects[0]?.name).toBe("旧项目归档");
    expect(listProjectBoardProjects(snapshot, { includeArchived: true })).toHaveLength(2);
    expect(findProjectBoardProject(snapshot, snapshot.projects[0]!.id)?.name).toBe("OPC 增长引擎");
  });

  it("includes orchestration decision, verification, and artifact events in project history", () => {
    const snapshot = buildProjectBoardSnapshot({
      sessions: [
        buildSession({
          id: "session_orchestrated",
          title: "增长项目",
          metadata: {
            projectMemory: {
              currentGoal: "增长项目",
              currentStage: "implementation",
              latestSummary: "主 Agent 已汇总实现结果",
              updatedAt: "2026-04-20T03:00:00.000Z",
              updatedBy: "product"
            }
          }
        })
      ],
      tasks: [
        buildTask({
          id: "task_orchestrated",
          sessionId: "session_orchestrated",
          updatedAt: "2026-04-20T03:00:00.000Z",
          metadata: {
            orchestrationState: {
              version: 1,
              mode: "main_agent",
              ownerRoleId: "product",
              spec: {
                goal: "增长项目",
                successCriteria: [],
                constraints: [],
                scope: []
              },
              progress: {
                stage: "implementation",
                status: "completed",
                completed: ["landing page delivered"],
                inFlight: [],
                blocked: [],
                awaitingInput: [],
                nextActions: ["prepare release recap"]
              },
              decision: {
                summary: "确定先交付 landing page MVP",
                entries: ["保留后续 AB 实验到下一迭代"]
              },
              artifactIndex: {
                items: [
                  {
                    path: "apps/site/index.html",
                    title: "Landing Page",
                    stage: "implementation",
                    status: "verified"
                  }
                ]
              },
              verificationStatus: "verified",
              updatedAt: "2026-04-20T03:00:00.000Z",
              updatedBy: "product"
            }
          }
        })
      ],
      roleBindingsByRole: {}
    });

    const project = snapshot.projects[0];
    expect(project?.history.map((entry) => entry.kind)).toEqual(
      expect.arrayContaining(["session", "orchestration_decision", "orchestration_verification", "orchestration_artifact"])
    );
    expect(project?.history.map((entry) => entry.stage)).toEqual(
      expect.arrayContaining(["decision:implementation", "verification:verified", "artifact:implementation"])
    );
  });

  it("includes goal-run progress in project history", () => {
    const snapshot = buildProjectBoardSnapshot({
      sessions: [
        buildSession({
          id: "session_goal_run",
          title: "增长项目",
          metadata: {
            projectMemory: {
              currentGoal: "增长项目",
              currentStage: "deploy",
              latestSummary: "目标流程推进中",
              updatedAt: "2026-04-20T04:00:00.000Z",
              updatedBy: "operations"
            }
          }
        })
      ],
      tasks: [],
      roleBindingsByRole: {},
      goalRuns: [
        {
          id: "goal_1",
          source: "control-center",
          objective: "完成增长项目从实现到部署",
          status: "running",
          currentStage: "deploy",
          sessionId: "session_goal_run",
          language: "zh-CN",
          metadata: {},
          context: {},
          retryCount: 0,
          maxRetries: 2,
          awaitingInputFields: [],
          result: {
            summary: "部署前检查已完成",
            deliverable: "等待最终部署",
            nextActions: ["执行部署"]
          },
          createdAt: "2026-04-20T03:30:00.000Z",
          updatedAt: "2026-04-20T04:05:00.000Z"
        }
      ],
      goalRunHandoffs: [
        {
          id: "handoff_1",
          goalRunId: "goal_1",
          artifact: {
            stage: "deploy",
            summary: "交接部署产物",
            artifacts: ["dist/site.zip"],
            decisions: [],
            unresolvedQuestions: [],
            nextActions: ["执行部署"],
            approvalNeeds: [],
            createdAt: "2026-04-20T04:06:00.000Z"
          }
        }
      ],
      goalRunTraces: [
        {
          id: "trace_1",
          goalRunId: "goal_1",
          stage: "deploy",
          status: "completed",
          inputSummary: "准备部署",
          outputSummary: "部署脚本执行完成",
          artifactFiles: ["dist/site.zip"],
          completedRoles: ["operations"],
          failedRoles: [],
          approvalGateHits: 0,
          metadata: {},
          createdAt: "2026-04-20T04:07:00.000Z"
        }
      ]
    });

    const project = snapshot.projects[0];
    expect(project?.history.map((entry) => entry.kind)).toEqual(
      expect.arrayContaining(["session", "goal_run", "goal_run_handoff", "goal_run_trace"])
    );
    expect(project?.history.map((entry) => entry.stage)).toContain("goal_run:deploy:running");
    expect(project?.history.map((entry) => entry.stage)).toEqual(
      expect.arrayContaining(["goal_run_handoff:deploy", "goal_run_trace:deploy:completed"])
    );
  });
});

import { describe, expect, it } from "vitest";
import { renderPrometheusMetrics } from "./observability.js";
import type { DashboardSnapshot } from "./types.js";

function createSnapshot(): DashboardSnapshot {
  return {
    config: {
      memory: { defaultBackend: "sqlite", roleBackends: {} },
      routing: { primaryBackend: "sglang", fallbackBackend: "ollama" },
      channels: { feishuEnabled: true, emailEnabled: false },
      approvals: { requireForConfigMutation: true, requireForEmailSend: true },
      queue: {
        sla: {
          warningWaitMs: 1000,
          criticalWaitMs: 2000
        }
      },
      tools: {
        providerOrder: ["opencode"],
        workspaceOnly: true,
        timeoutMs: 10_000,
        approvalMode: "cto_auto_owner_fallback",
        ctoRoleId: "cto",
        ownerRoleId: "ceo",
        highRiskKeywords: [],
        providerModels: {},
        providerBaseUrls: {}
      },
      collaboration: {
        enabled: true,
        triggerKeywords: ["团队协作执行"],
        defaultParticipants: ["product", "frontend", "backend"],
        defaultConfig: {
          maxRounds: 3,
          discussionTimeoutMs: 30 * 60 * 1000,
          requireConsensus: false,
          pushIntermediateResults: true,
          autoAggregateOnComplete: true,
          aggregateTimeoutMs: 60 * 60 * 1000
        }
      }
    },
    routingTemplates: [],
    queueMetrics: {
      queuedCount: 2,
      runningCount: 1,
      completedCountLast24h: 8,
      avgWaitMsLast24h: 100,
      avgRunMsLast24h: 200,
      oldestQueuedWaitMs: 500,
      alertLevel: "warning",
      alerts: [],
      byRole: [
        {
          id: "backend",
          label: "backend",
          queued: 1,
          running: 1,
          avgWaitMs: 123,
          avgRunMs: 456
        }
      ],
      byTemplate: [],
      updatedAt: new Date().toISOString()
    },
    toolRuns: [
      {
        id: "run-1",
        taskId: "task-1",
        roleId: "backend",
        providerId: "opencode",
        title: "t",
        instruction: "i",
        command: "opencode",
        args: [],
        riskLevel: "low",
        status: "approval_pending",
        approvalStatus: "pending",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    ],
    tasks: [],
    approvals: [
      {
        id: "approval-1",
        kind: "task_execution",
        summary: "s",
        payload: {},
        status: "pending",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    ],
    operatorActions: [],
    skillBindings: [],
    auditEvents: []
  };
}

describe("renderPrometheusMetrics", () => {
  it("renders queue and approval gauges", () => {
    const text = renderPrometheusMetrics(createSnapshot());
    expect(text).toContain("vinko_tasks_queued 2");
    expect(text).toContain("vinko_queue_alert_level 1");
    expect(text).toContain("vinko_approvals_pending_total 1");
    expect(text).toContain('vinko_queue_by_role_queued{role="backend"} 1');
  });
});

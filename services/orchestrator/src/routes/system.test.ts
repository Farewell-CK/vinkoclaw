import express from "express";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeConfig, VinkoStore } from "@vinko/shared";
import { globalTelemetry } from "@vinko/agent-runtime";
import { registerSystemRoutes } from "./system.js";

function createRuntimeConfig(): RuntimeConfig {
  return {
    memory: { defaultBackend: "sqlite", roleBackends: {} },
    routing: { primaryBackend: "openai", fallbackBackend: "zhipu" },
    channels: { feishuEnabled: true, emailEnabled: false },
    approvals: { requireForConfigMutation: true, requireForEmailSend: true },
    queue: { sla: { warningWaitMs: 300000, criticalWaitMs: 900000 } },
    tools: {
      providerOrder: ["opencode", "codex", "claude"],
      workspaceOnly: true,
      timeoutMs: 1200000,
      approvalMode: "cto_auto_owner_fallback",
      ctoRoleId: "cto",
      ownerRoleId: "ceo",
      highRiskKeywords: [],
      providerModels: {},
      providerBaseUrls: {}
    },
    collaboration: {
      enabled: true,
      triggerKeywords: [],
      defaultParticipants: ["product", "backend", "qa"],
      defaultConfig: {
        maxRounds: 3,
        discussionTimeoutMs: 1800000,
        requireConsensus: false,
        pushIntermediateResults: true,
        autoAggregateOnComplete: true,
        aggregateTimeoutMs: 3600000
      }
    },
    evolution: {
      router: {
        confidenceThreshold: 0.75,
        preferValidatedFallbacks: false,
        templateHints: []
      },
      intake: {
        preferClarificationForShortVagueRequests: false,
        shortVagueRequestMaxLength: 24,
        directConversationMaxLength: 24,
        ambiguousConversationMaxLength: 32,
        collaborationMinLength: 40,
        requireExplicitTeamSignal: true
      },
      collaboration: {
        partialDeliveryMinCompletedRoles: 1,
        timeoutNoProgressMode: "await_user",
        terminalFailureNoProgressMode: "blocked",
        manualResumeAggregationMode: "deliver"
      },
      skills: {
        recommendations: []
      }
    }
  };
}

function createSystemRoutesApp(store: VinkoStore): express.Express {
  const app = express();
  registerSystemRoutes(app, {
    store,
    buildSystemMetricsSnapshot: () => ({ ok: true }),
    buildSystemHealthReport: () => ({ ok: true }),
    buildSystemDailyKpi: () => ({ days: 14 }),
    sanitizeApprovalRecord: (approval) => approval,
    sanitizeOperatorActionRecord: (action) => action
  });
  return app;
}

async function withServer(app: express.Express, fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("listening", () => resolve());
      server.once("error", reject);
    });
    const address = server.address() as AddressInfo | null;
    if (!address) {
      throw new Error("server_address_unavailable");
    }
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function readChunks(stream: ReadableStream<Uint8Array>, count: number): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  try {
    for (let index = 0; index < count; index += 1) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      output += decoder.decode(result.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  return output;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("system routes", () => {
  it("returns a unified activity feed ordered by recency", async () => {
    vi.spyOn(globalTelemetry, "listTraces").mockReturnValue([
      {
        taskId: "task-trace-1",
        sessionId: "sess-1",
        roleId: "frontend",
        instruction: "Build a task board",
        turns: [
          {
            round: 1,
            modelInputSummary: "input",
            modelOutputSummary: "output",
            toolCalls: [],
            backendUsed: "openai",
            modelUsed: "gpt-test",
            durationMs: 120,
            usage: {
              promptTokens: 100,
              completionTokens: 40,
              totalTokens: 140
            }
          }
        ],
        metrics: {
          totalTokens: 140,
          totalPromptTokens: 100,
          totalCompletionTokens: 40,
          toolCalls: 0,
          errors: 0,
          roundsBlocked: 0,
          durationMs: 120
        },
        startedAt: "2026-04-21T10:01:00.000Z"
      }
    ]);

    const store = {
      getRuntimeConfig: vi.fn(() => createRuntimeConfig()),
      getDashboardSnapshot: vi.fn(() => ({
        approvals: [],
        operatorActions: []
      })),
      resolveSkillsForRole: vi.fn(() => []),
      listAuditEvents: vi.fn(() => [
        {
          id: "audit-1",
          category: "goal-run",
          entityType: "goal_run",
          entityId: "goal-1",
          message: "Created goal run",
          payload: {},
          createdAt: "2026-04-21T10:00:00.000Z"
        }
      ]),
      listTasks: vi.fn(() => [
        {
          id: "task-1",
          source: "control-center",
          roleId: "backend",
          title: "Build API",
          instruction: "Ship a generic API",
          status: "running",
          priority: 90,
          metadata: {},
          createdAt: "2026-04-21T09:58:00.000Z",
          updatedAt: "2026-04-21T10:03:00.000Z"
        }
      ]),
      listGoalRuns: vi.fn(() => [
        {
          id: "goal-1",
          source: "control-center",
          objective: "Build a general agent workspace",
          status: "running",
          currentStage: "execute",
          language: "zh-CN",
          metadata: {},
          context: {},
          retryCount: 0,
          maxRetries: 2,
          awaitingInputFields: [],
          createdAt: "2026-04-21T09:57:00.000Z",
          updatedAt: "2026-04-21T10:02:30.000Z"
        }
      ]),
      listApprovals: vi.fn(() => [
        {
          id: "approval-1",
          kind: "task_execution",
          summary: "Approve external API call",
          payload: {},
          status: "pending",
          createdAt: "2026-04-21T10:02:00.000Z",
          updatedAt: "2026-04-21T10:02:00.000Z"
        }
      ])
    } as unknown as VinkoStore;
    const app = createSystemRoutesApp(store);

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/system/activity-feed?limit=4`);
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        generatedAt: string;
        total: number;
        events: Array<{
          kind: string;
          eventType?: string;
          title: string;
          summary: string;
          entityType: string;
          entityId: string;
          status?: string;
          metrics?: {
            totalTokens?: number;
          };
        }>;
      };

      expect(payload.total).toBe(5);
      expect(payload.events).toHaveLength(4);
      expect(payload.events.map((event) => event.kind)).toEqual(["task", "goal_run", "approval", "trace"]);
      expect(payload.events[0]?.entityId).toBe("task-1");
      expect(payload.events[0]?.eventType).toBe("task_running");
      expect(payload.events[1]?.entityId).toBe("goal-1");
      expect(payload.events[1]?.eventType).toBe("goal_run_running");
      expect(payload.events[2]?.entityId).toBe("approval-1");
      expect(payload.events[2]?.eventType).toBe("approval_pending");
      expect(payload.events[3]?.entityId).toBe("task-trace-1");
      expect(payload.events[3]?.metrics?.totalTokens).toBe(140);
    });
  });

  it("surfaces inbound routing audit evidence in activity feed", async () => {
    vi.spyOn(globalTelemetry, "listTraces").mockReturnValue([]);

    const store = {
      getRuntimeConfig: vi.fn(() => createRuntimeConfig()),
      getDashboardSnapshot: vi.fn(() => ({
        approvals: [],
        operatorActions: []
      })),
      resolveSkillsForRole: vi.fn(() => []),
      listAuditEvents: vi.fn(() => [
        {
          id: "audit-route-1",
          category: "inbound-routing",
          entityType: "session",
          entityId: "sess-123",
          message: "Inbound intent classified as operator_config",
          payload: {
            stage: "initial",
            intent: "operator_config",
            reason: "operator_config_pattern",
            matchedRules: ["operator_config_pattern"],
            confidence: "medium",
            textPreview: "给团队开启联网搜索能力"
          },
          createdAt: "2026-04-21T10:05:00.000Z"
        }
      ]),
      listTasks: vi.fn(() => []),
      listGoalRuns: vi.fn(() => []),
      listApprovals: vi.fn(() => [])
    } as unknown as VinkoStore;
    const app = createSystemRoutesApp(store);

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/system/activity-feed?limit=5`);
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        total: number;
        events: Array<{
          kind: string;
          entityId: string;
          audit?: {
            category: string;
            stage?: string;
            intent?: string;
            reason?: string;
            matchedRules?: string[];
            confidence?: string;
            textPreview?: string;
          };
        }>;
      };

      expect(payload.total).toBe(1);
      expect(payload.events).toHaveLength(1);
      expect(payload.events[0]?.kind).toBe("audit");
      expect(payload.events[0]?.entityId).toBe("sess-123");
      expect(payload.events[0]?.audit).toEqual({
        category: "inbound-routing",
        stage: "initial",
        intent: "operator_config",
        reason: "operator_config_pattern",
        matchedRules: ["operator_config_pattern"],
        confidence: "medium",
        textPreview: "给团队开启联网搜索能力"
      });
    });
  });

  it("surfaces semantic collaboration and evolution event types in activity feed", async () => {
    vi.spyOn(globalTelemetry, "listTraces").mockReturnValue([]);

    const store = {
      getRuntimeConfig: vi.fn(() => createRuntimeConfig()),
      getDashboardSnapshot: vi.fn(() => ({
        approvals: [],
        operatorActions: []
      })),
      resolveSkillsForRole: vi.fn(() => []),
      listAuditEvents: vi.fn(() => [
        {
          id: "audit-evo-1",
          category: "evolution",
          entityType: "evolution_change",
          entityId: "change-1",
          message: "Applied evolution proposal p-router",
          payload: {
            eventType: "evolution_change_applied",
            proposalId: "p-router",
            kind: "router_bias",
            risk: "low"
          },
          createdAt: "2026-04-23T10:06:00.000Z"
        },
        {
          id: "audit-collab-1",
          category: "collaboration",
          entityType: "task",
          entityId: "task-parent-1",
          message: "Collaboration paused for user input",
          payload: {
            eventType: "collaboration_await_user",
            reason: "await_user",
            parentTaskId: "task-parent-1",
            triggerReason: "all_tasks_terminal_with_failures"
          },
          createdAt: "2026-04-23T10:05:00.000Z"
        }
      ]),
      listTasks: vi.fn(() => []),
      listGoalRuns: vi.fn(() => []),
      listApprovals: vi.fn(() => [])
    } as unknown as VinkoStore;
    const app = createSystemRoutesApp(store);

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/system/activity-feed?limit=5`);
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        total: number;
        events: Array<{
          eventType?: string;
          audit?: {
            category?: string;
            eventType?: string;
          };
        }>;
      };

      expect(payload.total).toBe(2);
      expect(payload.events[0]?.eventType).toBe("evolution_change_applied");
      expect(payload.events[0]?.audit?.eventType).toBe("evolution_change_applied");
      expect(payload.events[1]?.eventType).toBe("collaboration_await_user");
      expect(payload.events[1]?.audit?.eventType).toBe("collaboration_await_user");
    });
  });

  it("surfaces structured session action evidence in activity feed", async () => {
    vi.spyOn(globalTelemetry, "listTraces").mockReturnValue([]);

    const store = {
      getRuntimeConfig: vi.fn(() => createRuntimeConfig()),
      getDashboardSnapshot: vi.fn(() => ({
        approvals: [],
        operatorActions: []
      })),
      resolveSkillsForRole: vi.fn(() => []),
      listAuditEvents: vi.fn(() => [
        {
          id: "audit-session-action-1",
          category: "session-action",
          entityType: "session",
          entityId: "session-1",
          message: "Session action completed: continue",
          payload: {
            eventType: "session_action_completed",
            sessionId: "session-1",
            action: "continue",
            actionId: "session_action_continue_fixed",
            clientActionId: "session_action_continue_fixed",
            resultType: "task_queued",
            taskId: "task-1",
            textPreview: "请继续推进当前会话"
          },
          createdAt: "2026-04-23T10:07:00.000Z"
        }
      ]),
      listTasks: vi.fn(() => []),
      listGoalRuns: vi.fn(() => []),
      listApprovals: vi.fn(() => [])
    } as unknown as VinkoStore;
    const app = createSystemRoutesApp(store);

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/system/activity-feed?limit=5`);
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        total: number;
        events: Array<{
          eventType?: string;
          entityId?: string;
          audit?: {
            category?: string;
            eventType?: string;
            sessionId?: string;
            action?: string;
            actionId?: string;
            clientActionId?: string;
            resultType?: string;
            taskId?: string;
            textPreview?: string;
          };
        }>;
      };

      expect(payload.total).toBe(1);
      expect(payload.events[0]?.eventType).toBe("session_action_completed");
      expect(payload.events[0]?.entityId).toBe("session-1");
      expect(payload.events[0]?.audit).toEqual({
        category: "session-action",
        eventType: "session_action_completed",
        sessionId: "session-1",
        action: "continue",
        actionId: "session_action_continue_fixed",
        clientActionId: "session_action_continue_fixed",
        resultType: "task_queued",
        taskId: "task-1",
        textPreview: "请继续推进当前会话"
      });
    });
  });

  it("surfaces template routing audit evidence in activity feed", async () => {
    vi.spyOn(globalTelemetry, "listTraces").mockReturnValue([]);

    const store = {
      getRuntimeConfig: vi.fn(() => createRuntimeConfig()),
      getDashboardSnapshot: vi.fn(() => ({
        approvals: [],
        operatorActions: []
      })),
      resolveSkillsForRole: vi.fn(() => []),
      listAuditEvents: vi.fn(() => [
        {
          id: "audit-template-1",
          category: "template-routing",
          entityType: "session",
          entityId: "sess-456",
          message: "Inbound template routed to tpl-product-prd",
          payload: {
            templateId: "tpl-product-prd",
            templateName: "PRD Workflow",
            reason: "template_match_partial_keyword_coverage",
            matchedRules: ["template_match_partial_keyword_coverage"],
            matchedKeywords: ["prd"],
            confidence: "low",
            textPreview: "请帮我写一个产品需求文档 PRD"
          },
          createdAt: "2026-04-21T10:06:00.000Z"
        }
      ]),
      listTasks: vi.fn(() => []),
      listGoalRuns: vi.fn(() => []),
      listApprovals: vi.fn(() => [])
    } as unknown as VinkoStore;
    const app = createSystemRoutesApp(store);

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/system/activity-feed?limit=5`);
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        total: number;
        events: Array<{
          kind: string;
          entityId: string;
          audit?: {
            category: string;
            templateId?: string;
            templateName?: string;
            reason?: string;
            matchedRules?: string[];
            matchedKeywords?: string[];
            confidence?: string;
            textPreview?: string;
          };
        }>;
      };

      expect(payload.total).toBe(1);
      expect(payload.events).toHaveLength(1);
      expect(payload.events[0]?.kind).toBe("audit");
      expect(payload.events[0]?.entityId).toBe("sess-456");
      expect(payload.events[0]?.audit).toEqual({
        category: "template-routing",
        templateId: "tpl-product-prd",
        templateName: "PRD Workflow",
        reason: "template_match_partial_keyword_coverage",
        matchedRules: ["template_match_partial_keyword_coverage"],
        matchedKeywords: ["prd"],
        confidence: "low",
        textPreview: "请帮我写一个产品需求文档 PRD"
      });
    });
  });

  it("streams live activity snapshots over SSE", async () => {
    vi.spyOn(globalTelemetry, "listTraces").mockReturnValue([
      {
        taskId: "task-trace-live-1",
        sessionId: "sess-live-1",
        roleId: "backend",
        instruction: "Ship live event stream",
        turns: [],
        metrics: {
          totalTokens: 0,
          totalPromptTokens: 0,
          totalCompletionTokens: 0,
          toolCalls: 0,
          errors: 0,
          roundsBlocked: 0,
          durationMs: 0
        },
        startedAt: "2026-04-23T10:01:00.000Z"
      }
    ]);

    const store = {
      getRuntimeConfig: vi.fn(() => createRuntimeConfig()),
      getDashboardSnapshot: vi.fn(() => ({
        approvals: [],
        operatorActions: []
      })),
      resolveSkillsForRole: vi.fn(() => []),
      listAuditEvents: vi.fn(() => [
        {
          id: "audit-live-1",
          category: "runtime",
          entityType: "task",
          entityId: "task-live-1",
          message: "Task entered running state",
          payload: {
            status: "running"
          },
          createdAt: "2026-04-23T10:00:00.000Z"
        }
      ]),
      listTasks: vi.fn(() => [
        {
          id: "task-live-1",
          source: "control-center",
          roleId: "backend",
          title: "Live task",
          instruction: "keep streaming",
          status: "running",
          priority: 90,
          metadata: {},
          createdAt: "2026-04-23T10:00:00.000Z",
          updatedAt: "2026-04-23T10:00:02.000Z"
        }
      ]),
      listGoalRuns: vi.fn(() => []),
      listApprovals: vi.fn(() => [])
    } as unknown as VinkoStore;
    const app = createSystemRoutesApp(store);

    const server = app.listen(0, "127.0.0.1");
    try {
      await once(server, "listening");
      const address = server.address() as AddressInfo | null;
      if (!address) {
        throw new Error("server_address_unavailable");
      }
      const response = await fetch(
        `http://127.0.0.1:${address.port}/api/system/activity-feed/stream?limit=5&pollMs=1000`
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      expect(response.body).toBeTruthy();

      const body = await readChunks(response.body!, 3);
      expect(body).toContain("event: ready");
      expect(body).toContain("event: snapshot");
      expect(body).toContain("\"entityId\":\"task-live-1\"");
      expect(body).toContain("\"taskId\":\"task-trace-live-1\"");

      response.body?.cancel().catch(() => undefined);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("returns runtime harness snapshot", async () => {
    const store = {
      getRuntimeConfig: vi.fn(() => createRuntimeConfig()),
      getDashboardSnapshot: vi.fn(() => ({
        approvals: [],
        operatorActions: []
      })),
      resolveSkillsForRole: vi.fn(() => []),
      getConfigEntry: vi.fn((key: string) =>
        key === "evolution-state"
          ? {
              version: 1,
              signals: [{ kind: "router_fallback" }],
              proposals: [{ id: "p1", status: "proposed", summary: "Improve router bias" }],
              appliedChanges: [],
              updatedAt: "2026-04-22T00:00:00.000Z"
            }
          : undefined
      )
    } as unknown as VinkoStore;
    const app = createSystemRoutesApp(store);

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/system/runtime-harness`);
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        toolRegistry: {
          mode: string;
          total: number;
          tools: Array<Record<string, unknown>>;
        };
        rulesEngine: {
          mode: string;
          total: number;
          rules: Array<Record<string, unknown>>;
        };
        skills: {
          mode: string;
          catalogTotal: number;
          catalog: Array<Record<string, unknown>>;
          roles: Array<Record<string, unknown>>;
        };
        evolution: {
          signals: number;
          proposals: number;
          proposed: number;
          routerConfig?: {
            confidenceThreshold: number;
            preferValidatedFallbacks: boolean;
            templateHintCount: number;
          };
          collaborationConfig?: {
            partialDeliveryMinCompletedRoles: number;
            timeoutNoProgressMode: string;
            terminalFailureNoProgressMode: string;
            manualResumeAggregationMode: string;
          };
          skillRecommendationCount?: number;
          latestSignals?: Array<Record<string, unknown>>;
        };
      };
      expect(payload.toolRegistry.mode).toBe("default");
      expect(payload.toolRegistry.total).toBeGreaterThanOrEqual(3);
      expect(payload.toolRegistry.tools.some((tool) => tool.name === "run_code")).toBe(true);
      expect(payload.rulesEngine.mode).toBe("default");
      expect(payload.rulesEngine.total).toBeGreaterThan(0);
      expect(payload.rulesEngine.rules.some((rule) => rule.id === "block-dangerous-commands")).toBe(true);
      expect(payload.skills.mode).toBe("role_bound");
      expect(payload.skills.catalogTotal).toBeGreaterThan(0);
      expect(payload.skills.catalog.some((skill) => skill.skillId === "prd-writer")).toBe(true);
      expect(Array.isArray(payload.skills.roles)).toBe(true);
      expect(payload.skills.roles.some((role) => role.roleId === "product")).toBe(true);
      expect(payload.evolution.signals).toBe(1);
      expect(payload.evolution.proposals).toBe(1);
      expect(payload.evolution.proposed).toBe(1);
      expect(payload.evolution.routerConfig?.confidenceThreshold).toBe(0.75);
      expect(payload.evolution.routerConfig?.preferValidatedFallbacks).toBe(false);
      expect(payload.evolution.routerConfig?.templateHintCount).toBe(0);
      expect(payload.evolution.collaborationConfig?.partialDeliveryMinCompletedRoles).toBe(1);
      expect(payload.evolution.collaborationConfig?.timeoutNoProgressMode).toBe("await_user");
      expect(payload.evolution.collaborationConfig?.terminalFailureNoProgressMode).toBe("blocked");
      expect(payload.evolution.collaborationConfig?.manualResumeAggregationMode).toBe("deliver");
      expect(payload.evolution.skillRecommendationCount).toBe(0);
      expect(Array.isArray(payload.evolution.latestSignals)).toBe(true);
    });
  });

  it("returns evolution snapshot", async () => {
    const store = {
      getRuntimeConfig: vi.fn(() => createRuntimeConfig()),
      getDashboardSnapshot: vi.fn(() => ({
        approvals: [],
        operatorActions: []
      })),
      resolveSkillsForRole: vi.fn(() => []),
      getConfigEntry: vi.fn((key: string) =>
        key === "evolution-state"
          ? {
              version: 1,
              signals: [{ kind: "task_completed", summary: "done", createdAt: "2026-04-22T00:00:00.000Z" }],
              proposals: [{ id: "p1", status: "applied", summary: "Prefer concise style", createdAt: "2026-04-22T00:00:01.000Z" }],
              appliedChanges: [{ id: "c1", proposalId: "p1", kind: "workspace_preference", appliedAt: "2026-04-22T00:00:02.000Z" }],
              updatedAt: "2026-04-22T00:00:03.000Z"
            }
          : undefined
      )
    } as unknown as VinkoStore;
    const app = createSystemRoutesApp(store);

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/system/evolution`);
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        version: number;
        signalCount: number;
        proposalCount: number;
        appliedChangeCount: number;
        runtimeConfig?: {
          router: {
            confidenceThreshold: number;
            preferValidatedFallbacks: boolean;
            templateHints: unknown[];
          };
          skills: {
            recommendations: unknown[];
          };
        };
        signals: Array<Record<string, unknown>>;
        proposals: Array<Record<string, unknown>>;
        appliedChanges: Array<Record<string, unknown>>;
      };
      expect(payload.version).toBe(1);
      expect(payload.signalCount).toBe(1);
      expect(payload.proposalCount).toBe(1);
      expect(payload.appliedChangeCount).toBe(1);
      expect(payload.runtimeConfig?.router.confidenceThreshold).toBe(0.75);
      expect(payload.runtimeConfig?.skills.recommendations).toEqual([]);
      expect(payload.signals[0]?.kind).toBe("task_completed");
      expect(payload.proposals[0]?.id).toBe("p1");
      expect(payload.appliedChanges[0]?.proposalId).toBe("p1");
    });
  });

  it("rolls back latest evolution change through system route", async () => {
    const runtimeConfig = createRuntimeConfig();
    runtimeConfig.evolution.router.preferValidatedFallbacks = true;
    const setConfigEntry = vi.fn();
    const patchRuntimeConfig = vi.fn((mutator: (config: RuntimeConfig) => RuntimeConfig) => {
      const next = mutator(structuredClone(runtimeConfig));
      runtimeConfig.evolution = next.evolution;
      return next;
    });
    const appendAuditEvent = vi.fn();
    const store = {
      getRuntimeConfig: vi.fn(() => runtimeConfig),
      patchRuntimeConfig,
      setConfigEntry,
      appendAuditEvent,
      getWorkspaceMemory: vi.fn(() => ({
        userPreferences: {
          preferredLanguage: "default",
          preferredTechStack: [],
          communicationStyle: "default"
        }
      })),
      setWorkspacePreferences: vi.fn(),
      getDashboardSnapshot: vi.fn(() => ({
        approvals: [],
        operatorActions: []
      })),
      resolveSkillsForRole: vi.fn(() => []),
      getConfigEntry: vi.fn((key: string) =>
        key === "evolution-state"
          ? {
              version: 1,
              signals: [],
              proposals: [
                {
                  id: "p-router",
                  kind: "router_bias",
                  risk: "low",
                  summary: "bias",
                  patch: {},
                  sourceSignalKinds: ["router_fallback"],
                  status: "applied",
                  createdAt: "2026-04-22T00:00:01.000Z",
                  appliedAt: "2026-04-22T00:00:02.000Z"
                }
              ],
              appliedChanges: [
                {
                  id: "c-router",
                  proposalId: "p-router",
                  kind: "router_bias",
                  before: {
                    runtimeConfig: {
                      evolution: {
                        router: {
                          confidenceThreshold: 0.75,
                          preferValidatedFallbacks: false
                        }
                      }
                    }
                  },
                  after: {
                    runtimeConfig: {
                      evolution: {
                        router: {
                          confidenceThreshold: 0.68,
                          preferValidatedFallbacks: true
                        }
                      }
                    }
                  },
                  appliedAt: "2026-04-22T00:00:02.000Z"
                }
              ],
              updatedAt: "2026-04-22T00:00:03.000Z"
            }
          : undefined
      )
    } as unknown as VinkoStore;
    const app = createSystemRoutesApp(store);

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/system/evolution/rollback-latest`, {
        method: "POST"
      });
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        ok: boolean;
        rolledBack?: {
          proposalId?: string;
        } | null;
        appliedChangeCount: number;
        runtimeConfig?: {
          router: {
            preferValidatedFallbacks: boolean;
            confidenceThreshold: number;
          };
        };
      };
      expect(payload.ok).toBe(true);
      expect(payload.rolledBack?.proposalId).toBe("p-router");
      expect(payload.appliedChangeCount).toBe(0);
      expect(payload.runtimeConfig?.router.preferValidatedFallbacks).toBe(false);
      expect(payload.runtimeConfig?.router.confidenceThreshold).toBe(0.75);
    });
  });

  it("returns health report payload as provided by server", async () => {
    const healthReport = {
      ok: false,
      summary: {
        critical: 1,
        warning: 2
      },
      queue: {
        queuedTasks: 3,
        runningTasks: 0,
        waitingApprovalTasks: 0,
        pausedInputTasks: 1,
        queuedGoalRuns: 1,
        runningGoalRuns: 0,
        queueBacklogWithoutRunningWorkers: true
      },
      recovery: {
        recommendedResetMode: "factory-reset",
        actions: ["执行 `npm run reset:runtime:factory-reset`"]
      },
      alerts: [
        {
          level: "critical",
          code: "queued_without_runner_progress",
          message: "存在排队任务，但当前没有 running task/goal run，疑似 task-runner 不消费队列"
        }
      ]
    };
    const store = {
      getRuntimeConfig: vi.fn(() => createRuntimeConfig()),
      getDashboardSnapshot: vi.fn(() => ({
        approvals: [],
        operatorActions: []
      })),
      resolveSkillsForRole: vi.fn(() => [])
    } as unknown as VinkoStore;
    const app = express();
    registerSystemRoutes(app, {
      store,
      buildSystemMetricsSnapshot: () => ({ ok: true }),
      buildSystemHealthReport: () => healthReport,
      buildSystemDailyKpi: () => ({ days: 14 }),
      sanitizeApprovalRecord: (approval) => approval,
      sanitizeOperatorActionRecord: (action) => action
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/system/health-report`);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual(healthReport);
    });
  });
});

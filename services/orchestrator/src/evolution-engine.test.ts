import { describe, expect, it, vi } from "vitest";
import type { AuditEventRecord, GoalRunHarnessGradeRecord, RuntimeConfig, TaskRecord } from "@vinko/shared";
import {
  applyLowRiskEvolutionProposals,
  extractEvolutionSignalFromAudit,
  extractEvolutionSignalFromHarnessGrade,
  extractEvolutionSignalFromSkillVerification,
  extractEvolutionSignalsFromTask,
  getEvolutionState,
  recordEvolutionSignals,
  rollbackLatestEvolutionChange
} from "@vinko/shared";

function buildTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task-1",
    sessionId: "sess-1",
    source: "control-center",
    roleId: "product",
    title: "PRD",
    instruction: "请帮我写一个产品需求文档",
    status: "completed",
    priority: 90,
    metadata: {
      templateId: "tpl-founder-prd",
      originalInstruction: "请帮我写一个产品需求文档"
    },
    result: {
      summary: "done",
      deliverable: "artifact",
      citations: [],
      followUps: []
    },
    reflection: {
      score: 9,
      confidence: "high",
      assumptions: [],
      risks: [],
      improvements: []
    },
    errorText: "",
    pendingInput: undefined,
    requestedBy: "owner",
    chatId: "",
    createdAt: "2026-04-22T00:00:00.000Z",
    updatedAt: "2026-04-22T00:00:00.000Z",
    startedAt: "2026-04-22T00:00:00.000Z",
    completedAt: "2026-04-22T00:01:00.000Z",
    ...overrides
  };
}

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

function createStoreDouble() {
  const config = new Map<string, unknown>();
  let runtimeConfig = createRuntimeConfig();
  let workspace = {
    userPreferences: {
      preferredLanguage: "default" as const,
      preferredTechStack: [] as string[],
      communicationStyle: "default" as const
    },
    founderProfile: {
      businessDomains: [] as string[],
      targetUsers: [] as string[],
      deliverablePreferences: [] as string[],
      decisionStyle: "balanced" as const,
      feedbackSignals: [] as Array<{
        signal: "positive" | "negative" | "revision_requested";
        note: string;
        taskId?: string | undefined;
        createdAt: string;
      }>
    },
    keyDecisions: [] as Array<{ decision: string; rationale: string; timestamp: string; category?: string }>,
    projectContext: {
      currentGoals: [] as string[],
      activeProjects: [] as Array<{
        id: string;
        name: string;
        stage: string;
        status: "active" | "archived";
        lastUpdate: string;
        latestSummary?: string | undefined;
        lastTaskId?: string | undefined;
      }>
    },
    updatedAt: "2026-04-22T00:00:00.000Z"
  };

  const getConfigEntry = <T,>(key: string): T | undefined => {
    if (key === "runtime-config") {
      return runtimeConfig as T;
    }
    return config.get(key) as T | undefined;
  };

  const store: {
    getConfigEntry: <T>(key: string) => T | undefined;
    setConfigEntry: (key: string, value: unknown) => void;
    patchRuntimeConfig: (mutator: (config: RuntimeConfig) => RuntimeConfig) => RuntimeConfig;
    getRuntimeConfig: () => RuntimeConfig;
    appendAuditEvent: (input: Omit<AuditEventRecord, "id" | "createdAt"> & { payload?: Record<string, unknown> }) => AuditEventRecord;
    getWorkspaceMemory: () => typeof workspace;
    setWorkspacePreferences: (prefs: Record<string, unknown>) => void;
  } = {
    getConfigEntry,
    setConfigEntry: vi.fn((key: string, value: unknown) => {
      if (key === "runtime-config") {
        runtimeConfig = value as RuntimeConfig;
        return;
      }
      config.set(key, value);
    }),
    patchRuntimeConfig: vi.fn((mutator: (config: RuntimeConfig) => RuntimeConfig) => {
      runtimeConfig = mutator(structuredClone(runtimeConfig));
      return runtimeConfig;
    }),
    getRuntimeConfig: vi.fn(() => structuredClone(runtimeConfig)),
    appendAuditEvent: vi.fn((input: Omit<AuditEventRecord, "id" | "createdAt"> & { payload?: Record<string, unknown> }) => ({
      id: "audit-1",
      createdAt: "2026-04-22T00:00:00.000Z",
      ...input,
      payload: input.payload ?? {}
    })),
    getWorkspaceMemory: vi.fn(() => workspace),
    setWorkspacePreferences: vi.fn((prefs: Record<string, unknown>) => {
      workspace = {
        ...workspace,
        userPreferences: {
          ...workspace.userPreferences,
          ...prefs
        }
      };
    })
  };
  return store;
}

describe("evolution-engine", () => {
  it("extracts positive signals from completed high-confidence tasks", () => {
    const signals = extractEvolutionSignalsFromTask(buildTask());
    expect(signals.map((signal) => signal.kind)).toEqual(["task_completed", "high_score_reflection"]);
  });

  it("extracts router fallback signal from audit", () => {
    const signal = extractEvolutionSignalFromAudit({
      id: "audit-1",
      category: "inbound-routing",
      entityType: "session",
      entityId: "sess-1",
      message: "fallback",
      payload: { decisionSource: "fallback", fallbackReason: "llm_confidence_below_threshold" },
      createdAt: "2026-04-22T00:00:00.000Z"
    });
    expect(signal?.kind).toBe("router_fallback");
  });

  it("extracts clarification-requested signal from intake audit", () => {
    const signal = extractEvolutionSignalFromAudit({
      id: "audit-clarify-1",
      category: "intake",
      entityType: "session",
      entityId: "sess-1",
      message: "Clarification requested before task creation",
      payload: {
        reason: "clarification_requested",
        questions: ["目标用户是谁？"]
      },
      createdAt: "2026-04-22T00:00:00.000Z"
    });
    expect(signal?.kind).toBe("clarification_requested");
  });

  it("extracts collaboration evolution signals from collaboration audits", () => {
    const awaitUser = extractEvolutionSignalFromAudit({
      id: "audit-collab-await-1",
      category: "collaboration",
      entityType: "task",
      entityId: "task-parent-1",
      message: "Collaboration paused for user input",
      payload: {
        reason: "await_user",
        parentTaskId: "task-parent-1"
      },
      createdAt: "2026-04-22T00:00:00.000Z"
    });
    const resumed = extractEvolutionSignalFromAudit({
      id: "audit-collab-resume-1",
      category: "collaboration",
      entityType: "task",
      entityId: "task-parent-1",
      message: "Collaboration resumed after user input",
      payload: {
        reason: "resumed",
        parentTaskId: "task-parent-1"
      },
      createdAt: "2026-04-22T00:00:01.000Z"
    });
    expect(awaitUser?.kind).toBe("collaboration_await_user");
    expect(resumed?.kind).toBe("collaboration_resumed");
  });

  it("dedupes signals by sourceKey", () => {
    const store = createStoreDouble();
    recordEvolutionSignals(store, [
      {
        kind: "router_fallback",
        weight: -1,
        source: "audit",
        sourceKey: "audit:1",
        summary: "fallback-1",
        createdAt: "2026-04-22T00:00:00.000Z"
      },
      {
        kind: "router_fallback",
        weight: -1,
        source: "audit",
        sourceKey: "audit:1",
        summary: "fallback-duplicate",
        createdAt: "2026-04-22T00:00:01.000Z"
      }
    ]);
    const state = getEvolutionState(store);
    expect(state.signals).toHaveLength(1);
  });

  it("creates router_bias proposal and applies it to runtime config", () => {
    const store = createStoreDouble();
    recordEvolutionSignals(store, [
      {
        kind: "router_fallback",
        weight: -1,
        source: "audit",
        sourceKey: "audit:fallback-1",
        summary: "fallback-1",
        createdAt: "2026-04-22T00:00:00.000Z"
      },
      {
        kind: "router_fallback",
        weight: -1,
        source: "audit",
        sourceKey: "audit:fallback-2",
        summary: "fallback-2",
        createdAt: "2026-04-22T00:00:01.000Z"
      },
      {
        kind: "router_fallback",
        weight: -1,
        source: "audit",
        sourceKey: "audit:fallback-3",
        summary: "fallback-3",
        createdAt: "2026-04-22T00:00:02.000Z"
      }
    ]);

    const applied = applyLowRiskEvolutionProposals(store);
    expect(applied.proposals.some((proposal) => proposal.kind === "router_bias")).toBe(true);
    expect(store.getRuntimeConfig().evolution.router.preferValidatedFallbacks).toBe(true);
    expect(store.getRuntimeConfig().evolution.router.confidenceThreshold).toBe(0.68);

    const rolledBack = rollbackLatestEvolutionChange(store);
    expect(rolledBack.appliedChanges).toHaveLength(0);
    expect(store.getRuntimeConfig().evolution.router.preferValidatedFallbacks).toBe(false);
    expect(store.getRuntimeConfig().evolution.router.confidenceThreshold).toBe(0.75);
  });

  it("generates and applies template trigger proposals into runtime hints", () => {
    const store = createStoreDouble();
    const task1 = buildTask({
      id: "task-1",
      metadata: {
        templateId: "tpl-founder-prd",
        originalInstruction: "请帮我写一个需求澄清文档"
      }
    });
    const task2 = buildTask({
      id: "task-2",
      metadata: {
        templateId: "tpl-founder-prd",
        originalInstruction: "请帮我写一个需求澄清文档"
      }
    });

    recordEvolutionSignals(store, [...extractEvolutionSignalsFromTask(task1), ...extractEvolutionSignalsFromTask(task2)]);
    const applied = applyLowRiskEvolutionProposals(store);

    expect(applied.proposals.some((proposal) => proposal.kind === "template_trigger")).toBe(true);
    expect(store.getRuntimeConfig().evolution.router.templateHints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          templateId: "tpl-founder-prd",
          phrases: expect.arrayContaining(["写一个需求澄清文档"])
        })
      ])
    );
  });

  it("generates and applies skill recommendation proposals into runtime config", () => {
    const store = createStoreDouble();
    const task1 = buildTask({ id: "task-1", roleId: "product" });
    const task2 = buildTask({ id: "task-2", roleId: "product" });

    recordEvolutionSignals(store, [...extractEvolutionSignalsFromTask(task1), ...extractEvolutionSignalsFromTask(task2)]);
    const applied = applyLowRiskEvolutionProposals(store);

    expect(applied.proposals.some((proposal) => proposal.kind === "skill_recommendation")).toBe(true);
    expect(store.getRuntimeConfig().evolution.skills.recommendations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          roleId: "product",
          skillId: "prd-writer"
        })
      ])
    );
  });

  it("extracts signal from skill verification", () => {
    const signal = extractEvolutionSignalFromSkillVerification({
      task: buildTask({ roleId: "research" }),
      skillId: "web-search",
      verificationStatus: "verified"
    });
    expect(signal.kind).toBe("skill_verified");
    expect(signal.skillId).toBe("web-search");
  });

  it("extracts signal from harness grade", () => {
    const grade: GoalRunHarnessGradeRecord = {
      suite: "harness:founder",
      grade: "fail",
      generatedAt: "2026-04-22T00:00:00.000Z",
      handoffCoverage: 0.5,
      approvalCoverage: 0.5,
      resumeCoverage: 0.5,
      stateCompleteness: false,
      failedInvariant: "resume path missing",
      traceSummary: "founder flow unstable"
    };
    const signal = extractEvolutionSignalFromHarnessGrade(grade);
    expect(signal?.kind).toBe("harness_fail");
    expect(signal?.suite).toBe("harness:founder");
  });

  it("applies and rolls back low-risk workspace preference proposal", () => {
    const store = createStoreDouble();
    recordEvolutionSignals(store, [
      {
        kind: "low_confidence_reflection",
        weight: -1,
        source: "task",
        sourceKey: "task:low-1",
        summary: "low-1",
        createdAt: "2026-04-22T00:00:00.000Z"
      },
      {
        kind: "low_confidence_reflection",
        weight: -1,
        source: "task",
        sourceKey: "task:low-2",
        summary: "low-2",
        createdAt: "2026-04-22T00:00:01.000Z"
      }
    ]);
    const applied = applyLowRiskEvolutionProposals(store);
    expect(applied.appliedChanges).toHaveLength(1);
    expect(store.setWorkspacePreferences).toHaveBeenCalled();

    const rolledBack = rollbackLatestEvolutionChange(store);
    expect(rolledBack.appliedChanges).toHaveLength(0);
    expect(store.setWorkspacePreferences).toHaveBeenCalledTimes(2);
  });

  it("generates and rolls back intake policy proposal from repeated clarification signals", () => {
    const store = createStoreDouble();
    recordEvolutionSignals(store, [
      {
        kind: "clarification_requested",
        weight: 1,
        source: "audit",
        sourceKey: "audit:clarification-1",
        summary: "clarification-1",
        createdAt: "2026-04-22T00:00:00.000Z"
      },
      {
        kind: "clarification_requested",
        weight: 1,
        source: "audit",
        sourceKey: "audit:clarification-2",
        summary: "clarification-2",
        createdAt: "2026-04-22T00:00:01.000Z"
      }
    ]);

    const applied = applyLowRiskEvolutionProposals(store);
    expect(applied.proposals.some((proposal) => proposal.kind === "intake_policy")).toBe(true);
    expect(store.getRuntimeConfig().evolution.intake.preferClarificationForShortVagueRequests).toBe(true);
    expect(store.getRuntimeConfig().evolution.intake.shortVagueRequestMaxLength).toBe(36);

    const rolledBack = rollbackLatestEvolutionChange(store);
    expect(rolledBack.appliedChanges).toHaveLength(0);
    expect(store.getRuntimeConfig().evolution.intake.preferClarificationForShortVagueRequests).toBe(false);
    expect(store.getRuntimeConfig().evolution.intake.shortVagueRequestMaxLength).toBe(24);
  });

  it("generates and rolls back collaboration policy proposal", () => {
    const store = createStoreDouble();
    recordEvolutionSignals(store, [
      {
        kind: "collaboration_await_user",
        weight: -1,
        source: "audit",
        sourceKey: "audit:collab-await-1",
        summary: "await-1",
        createdAt: "2026-04-22T00:00:00.000Z"
      },
      {
        kind: "collaboration_await_user",
        weight: -1,
        source: "audit",
        sourceKey: "audit:collab-await-2",
        summary: "await-2",
        createdAt: "2026-04-22T00:00:01.000Z"
      }
    ]);

    const applied = applyLowRiskEvolutionProposals(store);
    expect(applied.proposals.some((proposal) => proposal.kind === "collaboration_policy")).toBe(true);
    expect(store.getRuntimeConfig().evolution.collaboration.timeoutNoProgressMode).toBe("await_user");
    expect(store.getRuntimeConfig().evolution.collaboration.terminalFailureNoProgressMode).toBe("await_user");

    const rolledBack = rollbackLatestEvolutionChange(store);
    expect(rolledBack.appliedChanges).toHaveLength(0);
    expect(store.getRuntimeConfig().evolution.collaboration.terminalFailureNoProgressMode).toBe("blocked");
  });
});

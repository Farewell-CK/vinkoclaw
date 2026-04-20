import { normalizeOrchestrationState, type OrchestrationStateRecord } from "./orchestration-state.js";
import { normalizeProjectMemory } from "./project-memory.js";
import { listRoles } from "./roles.js";
import type { WorkspaceMemoryRecord } from "./workspace-memory.js";
import type {
  CrmCadenceRecord,
  CrmLeadRecord,
  GoalRunRecord,
  GoalRunTraceRecord,
  ProjectBoardProject,
  ProjectBoardProjectHistoryEntry,
  ProjectBoardPrimaryView,
  ProjectBoardRoleReadiness,
  ProjectBoardSnapshot,
  ProjectBoardWorkstream,
  SessionRecord,
  SkillBindingRecord,
  StageHandoffArtifact,
  TaskRecord
} from "./types.js";

function dedupeStrings(values: string[], limit: number): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).slice(0, limit);
}

function parseTimestamp(value: string | undefined): number {
  if (!value) {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeProjectKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "") || "project";
}

function matchesProjectLink(input: {
  linkedProjectId?: string | undefined;
  projectId: string;
  projectName: string;
}): boolean {
  const linked = (input.linkedProjectId ?? "").trim().toLowerCase();
  if (!linked) {
    return false;
  }
  const projectId = input.projectId.trim().toLowerCase();
  const projectNameKey = normalizeProjectKey(input.projectName);
  return linked === projectId || linked === projectNameKey || linked.endsWith(`:${projectNameKey}`);
}

function mergeArtifacts(memoryArtifacts: string[], orchestration: OrchestrationStateRecord | undefined): string[] {
  if (!orchestration) {
    return memoryArtifacts;
  }
  return dedupeStrings([...orchestration.artifactIndex.items.map((item) => item.path), ...memoryArtifacts], 16);
}

function resolveProjectName(input: {
  session: SessionRecord;
  orchestration: OrchestrationStateRecord | undefined;
  workspaceMemory: WorkspaceMemoryRecord | undefined;
}): string {
  const memory = normalizeProjectMemory(input.session.metadata?.projectMemory);
  const candidates = [
    input.orchestration?.spec.goal,
    memory.currentGoal,
    input.session.title
  ]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  const workspaceProjects = input.workspaceMemory?.projectContext.activeProjects ?? [];
  for (const candidate of candidates) {
    const normalizedCandidate = candidate.toLowerCase();
    const matched = workspaceProjects.find((project: WorkspaceMemoryRecord["projectContext"]["activeProjects"][number]) => {
      const normalizedProject = project.name.trim().toLowerCase();
      return (
        normalizedCandidate === normalizedProject ||
        normalizedCandidate.includes(normalizedProject) ||
        normalizedProject.includes(normalizedCandidate)
      );
    });
    if (matched) {
      return matched.name;
    }
  }
  return candidates[0] ?? input.session.id;
}

function buildOrchestrationUnresolved(orchestration: OrchestrationStateRecord | undefined): string[] {
  if (!orchestration) {
    return [];
  }
  return dedupeStrings([...orchestration.progress.awaitingInput, ...orchestration.progress.blocked], 12);
}

function buildPrimaryView(
  session: SessionRecord,
  orchestrationTask:
    | {
        task: TaskRecord;
        orchestration: OrchestrationStateRecord;
      }
    | undefined
): ProjectBoardPrimaryView {
  const memory = normalizeProjectMemory(session.metadata?.projectMemory);
  const orchestration = orchestrationTask?.orchestration;
  const unresolvedQuestions = dedupeStrings([...buildOrchestrationUnresolved(orchestration), ...memory.unresolvedQuestions], 12);
  const nextActions = dedupeStrings([...(orchestration?.progress.nextActions ?? []), ...memory.nextActions], 12);
  const keyDecisions = dedupeStrings([...(orchestration?.decision.entries ?? []), ...memory.keyDecisions], 12);
  const latestArtifacts = mergeArtifacts(memory.latestArtifacts, orchestration);

  return {
    sessionId: session.id,
    sessionTitle: session.title,
    source: session.source,
    updatedAt: orchestration?.updatedAt || memory.updatedAt || orchestrationTask?.task.updatedAt || session.updatedAt,
    currentGoal: orchestration?.spec.goal || memory.currentGoal,
    currentStage: orchestration?.progress.stage || memory.currentStage,
    latestUserRequest: memory.latestUserRequest,
    latestSummary: orchestration?.decision.summary || memory.latestSummary,
    keyDecisions,
    unresolvedQuestions,
    nextActions,
    latestArtifacts,
    lastTaskId: orchestrationTask?.task.id ?? memory.lastTaskId,
    orchestrationMode: orchestration?.mode ?? memory.orchestrationMode,
    orchestrationOwnerRoleId: orchestration?.ownerRoleId ?? memory.orchestrationOwnerRoleId,
    orchestrationVerificationStatus: orchestration?.verificationStatus ?? memory.orchestrationVerificationStatus
  };
}

function buildWorkstreamView(
  session: SessionRecord,
  orchestrationTask:
    | {
        task: TaskRecord;
        orchestration: OrchestrationStateRecord;
      }
    | undefined
): ProjectBoardWorkstream {
  const memory = normalizeProjectMemory(session.metadata?.projectMemory);
  const orchestration = orchestrationTask?.orchestration;
  return {
    sessionId: session.id,
    sessionTitle: session.title,
    source: session.source,
    updatedAt: orchestration?.updatedAt || memory.updatedAt || orchestrationTask?.task.updatedAt || session.updatedAt,
    currentGoal: orchestration?.spec.goal || memory.currentGoal || session.title,
    currentStage: orchestration?.progress.stage || memory.currentStage,
    latestSummary: orchestration?.decision.summary || memory.latestSummary,
    unresolvedQuestions: dedupeStrings([...buildOrchestrationUnresolved(orchestration), ...memory.unresolvedQuestions], 12),
    nextActions: dedupeStrings([...(orchestration?.progress.nextActions ?? []), ...memory.nextActions], 12),
    latestArtifacts: mergeArtifacts(memory.latestArtifacts, orchestration),
    orchestrationMode: orchestration?.mode ?? memory.orchestrationMode,
    orchestrationOwnerRoleId: orchestration?.ownerRoleId ?? memory.orchestrationOwnerRoleId,
    orchestrationVerificationStatus: orchestration?.verificationStatus ?? memory.orchestrationVerificationStatus
  };
}

function buildProjectHistoryEntry(
  session: SessionRecord,
  orchestrationTask:
    | {
        task: TaskRecord;
        orchestration: OrchestrationStateRecord;
      }
    | undefined
): ProjectBoardProjectHistoryEntry {
  const memory = normalizeProjectMemory(session.metadata?.projectMemory);
  const orchestration = orchestrationTask?.orchestration;
  return {
    kind: "session",
    sessionId: session.id,
    sessionTitle: session.title,
    source: session.source,
    updatedAt: orchestration?.updatedAt || memory.updatedAt || orchestrationTask?.task.updatedAt || session.updatedAt,
    stage: orchestration?.progress.stage || memory.currentStage || "unknown",
    summary: orchestration?.decision.summary || memory.latestSummary || session.title,
    artifacts: mergeArtifacts(memory.latestArtifacts, orchestration).slice(0, 6)
  };
}

function buildOrchestrationDecisionHistoryEntry(
  session: SessionRecord,
  orchestrationTask: {
    task: TaskRecord;
    orchestration: OrchestrationStateRecord;
  }
): ProjectBoardProjectHistoryEntry | undefined {
  const orchestration = orchestrationTask.orchestration;
  const decisionSummary = orchestration.decision.summary.trim();
  const decisionItems = dedupeStrings(orchestration.decision.entries, 4);
  if (!decisionSummary && decisionItems.length === 0) {
    return undefined;
  }
  return {
    kind: "orchestration_decision",
    sessionId: session.id,
    sessionTitle: session.title,
    source: session.source,
    updatedAt: orchestration.updatedAt || orchestrationTask.task.updatedAt,
    stage: `decision:${orchestration.progress.stage || "unknown"}`,
    summary: decisionSummary || decisionItems.join("；"),
    artifacts: []
  };
}

function buildOrchestrationVerificationHistoryEntry(
  session: SessionRecord,
  orchestrationTask: {
    task: TaskRecord;
    orchestration: OrchestrationStateRecord;
  }
): ProjectBoardProjectHistoryEntry | undefined {
  const orchestration = orchestrationTask.orchestration;
  const verificationStatus = orchestration.verificationStatus?.trim();
  if (!verificationStatus) {
    return undefined;
  }
  const verificationSummary =
    verificationStatus === "verified"
      ? "main agent verification passed"
      : verificationStatus === "failed"
        ? "main agent verification failed"
        : "main agent verification pending";
  return {
    kind: "orchestration_verification",
    sessionId: session.id,
    sessionTitle: session.title,
    source: session.source,
    updatedAt: orchestration.updatedAt || orchestrationTask.task.updatedAt,
    stage: `verification:${verificationStatus}`,
    summary: verificationSummary,
    artifacts: orchestration.artifactIndex.items
      .filter((item) => item.status === "verified" || item.status === "failed")
      .map((item) => item.path)
      .slice(0, 6)
  };
}

function buildOrchestrationArtifactHistoryEntry(
  session: SessionRecord,
  orchestrationTask: {
    task: TaskRecord;
    orchestration: OrchestrationStateRecord;
  }
): ProjectBoardProjectHistoryEntry | undefined {
  const orchestration = orchestrationTask.orchestration;
  const artifactItems = orchestration.artifactIndex.items.filter((item) => item.path.trim());
  if (artifactItems.length === 0) {
    return undefined;
  }
  return {
    kind: "orchestration_artifact",
    sessionId: session.id,
    sessionTitle: session.title,
    source: session.source,
    updatedAt: orchestration.updatedAt || orchestrationTask.task.updatedAt,
    stage: `artifact:${orchestration.progress.stage || "unknown"}`,
    summary: dedupeStrings(artifactItems.map((item) => item.title || item.path), 3).join(" · "),
    artifacts: artifactItems.map((item) => item.path).slice(0, 6)
  };
}

function buildWorkspaceHistoryEntry(project: { name: string; stage: string; lastUpdate: string }): ProjectBoardProjectHistoryEntry {
  return {
    kind: "workspace",
    sessionTitle: project.name,
    source: "system",
    updatedAt: project.lastUpdate,
    stage: project.stage,
    summary: project.stage,
    artifacts: []
  };
}

function buildCrmLeadHistoryEntry(lead: CrmLeadRecord): ProjectBoardProjectHistoryEntry {
  return {
    kind: "crm_lead",
    sessionTitle: lead.company?.trim() ? `${lead.name} @ ${lead.company}` : lead.name,
    source: "system",
    updatedAt: lead.updatedAt || lead.createdAt,
    stage: `lead:${lead.stage}`,
    summary: lead.latestSummary?.trim() || lead.nextAction?.trim() || lead.source,
    artifacts: []
  };
}

function buildCrmCadenceHistoryEntry(input: {
  cadence: CrmCadenceRecord;
  lead?: CrmLeadRecord | undefined;
}): ProjectBoardProjectHistoryEntry {
  const leadLabel = input.lead?.company?.trim()
    ? `${input.lead.name} @ ${input.lead.company}`
    : input.lead?.name || input.cadence.leadId;
  const cadenceSummaryParts = [
    input.cadence.label.trim(),
    input.cadence.objective.trim(),
    input.cadence.channel
  ].filter(Boolean);
  return {
    kind: "crm_cadence",
    sessionTitle: leadLabel,
    source: "system",
    updatedAt: input.cadence.updatedAt || input.cadence.createdAt,
    stage: `cadence:${input.cadence.status}`,
    summary: cadenceSummaryParts.join(" · "),
    artifacts: []
  };
}

function buildGoalRunHistoryEntry(input: {
  run: GoalRunRecord;
  sessionTitle: string;
  sessionSource: SessionRecord["source"];
}): ProjectBoardProjectHistoryEntry {
  const runSummary =
    input.run.result?.summary?.trim() ||
    input.run.errorText?.trim() ||
    input.run.awaitingInputPrompt?.trim() ||
    input.run.objective.trim();
  return {
    kind: "goal_run",
    sessionId: input.run.sessionId,
    sessionTitle: input.sessionTitle,
    source: input.sessionSource,
    updatedAt: input.run.updatedAt || input.run.createdAt,
    stage: `goal_run:${input.run.currentStage}:${input.run.status}`,
    summary: runSummary,
    artifacts: []
  };
}

function buildGoalRunHandoffHistoryEntry(input: {
  goalRunId: string;
  artifact: StageHandoffArtifact;
  sessionTitle: string;
  sessionSource: SessionRecord["source"];
  updatedAt: string;
}): ProjectBoardProjectHistoryEntry {
  return {
    kind: "goal_run_handoff",
    sessionTitle: input.sessionTitle,
    source: input.sessionSource,
    updatedAt: input.updatedAt,
    stage: `goal_run_handoff:${input.artifact.stage}`,
    summary: input.artifact.summary.trim() || input.artifact.stage,
    artifacts: input.artifact.artifacts.slice(0, 6)
  };
}

function buildGoalRunTraceHistoryEntry(input: {
  trace: GoalRunTraceRecord;
  sessionTitle: string;
  sessionSource: SessionRecord["source"];
}): ProjectBoardProjectHistoryEntry {
  return {
    kind: "goal_run_trace",
    sessionTitle: input.sessionTitle,
    source: input.sessionSource,
    updatedAt: input.trace.createdAt,
    stage: `goal_run_trace:${input.trace.stage}:${input.trace.status}`,
    summary: input.trace.outputSummary.trim() || input.trace.inputSummary.trim() || input.trace.stage,
    artifacts: input.trace.artifactFiles.slice(0, 6)
  };
}

function buildProjectCollection(input: {
  sessions: SessionRecord[];
  orchestrationBySession: Map<
    string,
    {
      task: TaskRecord;
      orchestration: OrchestrationStateRecord;
      updatedAt: string;
    }
  >;
  workspaceMemory?: WorkspaceMemoryRecord | undefined;
  archived?: boolean;
  crmLeads?: CrmLeadRecord[] | undefined;
  crmCadences?: CrmCadenceRecord[] | undefined;
  goalRuns?: GoalRunRecord[] | undefined;
  goalRunHandoffs?: Array<{ id: string; goalRunId: string; artifact: StageHandoffArtifact }> | undefined;
  goalRunTraces?: GoalRunTraceRecord[] | undefined;
}): ProjectBoardProject[] {
  const grouped = new Map<
    string,
    {
      name: string;
      sessions: SessionRecord[];
      history: ProjectBoardProjectHistoryEntry[];
      workstreams: ProjectBoardWorkstream[];
      updatedAt: string;
    }
  >();

  const targetSessions = input.sessions.filter((session) => (input.archived ? session.status === "archived" : session.status !== "archived"));
  for (const session of targetSessions) {
    const orchestrationTask = input.orchestrationBySession.get(session.id);
    const orchestration = orchestrationTask?.orchestration;
    const projectName = resolveProjectName({
      session,
      orchestration,
      workspaceMemory: input.workspaceMemory
    });
    const key = normalizeProjectKey(projectName);
    const historyEntry = buildProjectHistoryEntry(session, orchestrationTask);
    const workstream = buildWorkstreamView(session, orchestrationTask);
    const existing = grouped.get(key);
    if (existing) {
      existing.sessions.push(session);
      existing.history.push(historyEntry);
      if (orchestrationTask) {
        const extraEntries = [
          buildOrchestrationDecisionHistoryEntry(session, orchestrationTask),
          buildOrchestrationVerificationHistoryEntry(session, orchestrationTask),
          buildOrchestrationArtifactHistoryEntry(session, orchestrationTask)
        ].filter((entry): entry is ProjectBoardProjectHistoryEntry => Boolean(entry));
        existing.history.push(...extraEntries);
      }
      existing.workstreams.push(workstream);
      if (parseTimestamp(historyEntry.updatedAt) > parseTimestamp(existing.updatedAt)) {
        existing.updatedAt = historyEntry.updatedAt;
      }
      continue;
    }
    grouped.set(key, {
      name: projectName,
      sessions: [session],
      history: [
        historyEntry,
        ...(
          orchestrationTask
            ? [
                buildOrchestrationDecisionHistoryEntry(session, orchestrationTask),
                buildOrchestrationVerificationHistoryEntry(session, orchestrationTask),
                buildOrchestrationArtifactHistoryEntry(session, orchestrationTask)
              ].filter((entry): entry is ProjectBoardProjectHistoryEntry => Boolean(entry))
            : []
        )
      ],
      workstreams: [workstream],
      updatedAt: historyEntry.updatedAt
    });
  }

  for (const project of input.workspaceMemory?.projectContext.activeProjects ?? []) {
    const projectArchived = project.status === "archived";
    if (Boolean(input.archived) !== projectArchived) {
      continue;
    }
    if (!input.archived && projectArchived) {
      continue;
    }
    {
      const key = normalizeProjectKey(project.name);
      const existing = grouped.get(key);
      if (existing) {
        existing.history.push(buildWorkspaceHistoryEntry(project));
        if (parseTimestamp(project.lastUpdate) > parseTimestamp(existing.updatedAt)) {
          existing.updatedAt = project.lastUpdate;
        }
        continue;
      }
      grouped.set(key, {
        name: project.name,
        sessions: [],
        history: [buildWorkspaceHistoryEntry(project)],
        workstreams: [],
        updatedAt: project.lastUpdate
      });
    }
  }

  for (const lead of input.crmLeads ?? []) {
    for (const [projectId, value] of grouped.entries()) {
      if (
        !matchesProjectLink({
          linkedProjectId: lead.linkedProjectId,
          projectId,
          projectName: value.name
        })
      ) {
        continue;
      }
      const historyEntry = buildCrmLeadHistoryEntry(lead);
      value.history.push(historyEntry);
      if (parseTimestamp(historyEntry.updatedAt) > parseTimestamp(value.updatedAt)) {
        value.updatedAt = historyEntry.updatedAt;
      }
    }
  }

  for (const cadence of input.crmCadences ?? []) {
    const linkedLead = (input.crmLeads ?? []).find((lead) => lead.id === cadence.leadId);
    for (const [projectId, value] of grouped.entries()) {
      if (
        !matchesProjectLink({
          linkedProjectId: linkedLead?.linkedProjectId,
          projectId,
          projectName: value.name
        })
      ) {
        continue;
      }
      const historyEntry = buildCrmCadenceHistoryEntry({ cadence, lead: linkedLead });
      value.history.push(historyEntry);
      if (parseTimestamp(historyEntry.updatedAt) > parseTimestamp(value.updatedAt)) {
        value.updatedAt = historyEntry.updatedAt;
      }
    }
  }

  for (const run of input.goalRuns ?? []) {
    const sessionId = run.sessionId?.trim();
    if (!sessionId) {
      continue;
    }
    const session = targetSessions.find((item) => item.id === sessionId);
    if (!session) {
      continue;
    }
    const orchestrationTask = input.orchestrationBySession.get(session.id);
    const projectName = resolveProjectName({
      session,
      orchestration: orchestrationTask?.orchestration,
      workspaceMemory: input.workspaceMemory
    });
    const key = normalizeProjectKey(projectName);
    const existing = grouped.get(key);
    if (!existing) {
      continue;
    }
    const historyEntry = buildGoalRunHistoryEntry({
      run,
      sessionTitle: session.title,
      sessionSource: session.source
    });
    existing.history.push(historyEntry);
    if (parseTimestamp(historyEntry.updatedAt) > parseTimestamp(existing.updatedAt)) {
      existing.updatedAt = historyEntry.updatedAt;
    }

    const handoffEntries = (input.goalRunHandoffs ?? [])
      .filter((entry) => entry.goalRunId === run.id)
      .map((entry) =>
        buildGoalRunHandoffHistoryEntry({
          goalRunId: run.id,
          artifact: entry.artifact,
          sessionTitle: session.title,
          sessionSource: session.source,
          updatedAt: entry.artifact.createdAt || run.updatedAt
        })
      );
    existing.history.push(...handoffEntries);

    const traceEntries = (input.goalRunTraces ?? [])
      .filter((trace) => trace.goalRunId === run.id)
      .map((trace) =>
        buildGoalRunTraceHistoryEntry({
          trace,
          sessionTitle: session.title,
          sessionSource: session.source
        })
      );
    existing.history.push(...traceEntries);

    const latestRunUpdate = Math.max(
      parseTimestamp(historyEntry.updatedAt),
      ...handoffEntries.map((entry) => parseTimestamp(entry.updatedAt)),
      ...traceEntries.map((entry) => parseTimestamp(entry.updatedAt))
    );
    if (latestRunUpdate > parseTimestamp(existing.updatedAt)) {
      existing.updatedAt = new Date(latestRunUpdate).toISOString();
    }
  }

  return Array.from(grouped.entries())
    .map(([id, value]) => {
      const sortedHistory = value.history.sort((left, right) => parseTimestamp(right.updatedAt) - parseTimestamp(left.updatedAt));
      const primaryHistory = sortedHistory[0];
      const blockers = dedupeStrings(value.workstreams.flatMap((stream) => stream.unresolvedQuestions), 8);
      const nextActions = dedupeStrings(value.workstreams.flatMap((stream) => stream.nextActions), 8);
      const latestArtifacts = dedupeStrings(value.workstreams.flatMap((stream) => stream.latestArtifacts), 10);
      const stage = primaryHistory?.stage || value.workstreams[0]?.currentStage || "unknown";
      const latestSummary = primaryHistory?.summary || value.workstreams[0]?.latestSummary || value.name;
      const currentGoal =
        value.workstreams.find((stream) => stream.currentGoal.trim())?.currentGoal ||
        value.sessions[0]?.title ||
        value.name;
      return {
        id,
        name: value.name,
        stage,
        currentGoal,
        latestSummary,
        updatedAt: value.updatedAt,
        sourceSessionIds: dedupeStrings(value.sessions.map((session) => session.id), 24),
        blockers,
        nextActions,
        latestArtifacts,
        crmLeadCount: (input.crmLeads ?? []).filter((lead) =>
          matchesProjectLink({
            linkedProjectId: lead.linkedProjectId,
            projectId: id,
            projectName: value.name
          })
        ).length,
        crmActiveCadences: (input.crmCadences ?? []).filter((cadence) => {
          const linkedLead = (input.crmLeads ?? []).find((lead) => lead.id === cadence.leadId);
          return (
            cadence.status === "active" &&
            matchesProjectLink({
              linkedProjectId: linkedLead?.linkedProjectId,
              projectId: id,
              projectName: value.name
            })
          );
        }).length,
        crmOverdueCadences: (input.crmCadences ?? []).filter((cadence) => {
          const linkedLead = (input.crmLeads ?? []).find((lead) => lead.id === cadence.leadId);
          return (
            cadence.status === "active" &&
            parseTimestamp(cadence.nextRunAt) <= Date.now() &&
            matchesProjectLink({
              linkedProjectId: linkedLead?.linkedProjectId,
              projectId: id,
              projectName: value.name
            })
          );
        }).length,
        history: sortedHistory.slice(0, 8)
      };
    })
    .sort((left, right) => parseTimestamp(right.updatedAt) - parseTimestamp(left.updatedAt));
}

function pickLatestOrchestrationTask(
  tasks: TaskRecord[],
  sessionId: string
):
  | {
      task: TaskRecord;
      orchestration: OrchestrationStateRecord;
      updatedAt: string;
    }
  | undefined {
  const candidates = tasks
    .filter((task) => task.sessionId === sessionId)
    .map((task) => {
      const orchestration = normalizeOrchestrationState(task.metadata?.orchestrationState);
      if (!orchestration) {
        return undefined;
      }
      return {
        task,
        orchestration,
        updatedAt: orchestration.updatedAt || task.updatedAt
      };
    })
    .filter((entry): entry is { task: TaskRecord; orchestration: OrchestrationStateRecord; updatedAt: string } => Boolean(entry))
    .sort((left, right) => parseTimestamp(right.updatedAt) - parseTimestamp(left.updatedAt));
  return candidates[0];
}

function buildRoleReadiness(
  roleBindingsByRole: Partial<Record<ProjectBoardRoleReadiness["roleId"], SkillBindingRecord[]>>
): ProjectBoardRoleReadiness[] {
  return listRoles()
    .map((role) => {
      const bindings = roleBindingsByRole[role.id] ?? [];
      const verified = bindings.filter((binding) => binding.verificationStatus === "verified");
      const failed = bindings.filter((binding) => binding.verificationStatus === "failed");
      const unverified = bindings.filter(
        (binding) => (binding.verificationStatus ?? "unverified") === "unverified"
      );
      const highlightedSkills = failed.length > 0 ? failed : unverified.length > 0 ? unverified : verified;
      return {
        roleId: role.id,
        roleName: role.name,
        responsibility: role.responsibility,
        totalSkills: bindings.length,
        verifiedSkills: verified.length,
        unverifiedSkills: unverified.length,
        failedSkills: failed.length,
        ready: bindings.length > 0 && failed.length === 0 && unverified.length === 0,
        highlightedSkills: highlightedSkills.map((binding) => binding.skillId).slice(0, 4)
      };
    })
    .sort((left, right) => {
      if (left.ready !== right.ready) {
        return left.ready ? 1 : -1;
      }
      const leftDebt = left.failedSkills * 10 + left.unverifiedSkills;
      const rightDebt = right.failedSkills * 10 + right.unverifiedSkills;
      return rightDebt - leftDebt || left.roleName.localeCompare(right.roleName);
    });
}

export function buildProjectBoardSnapshot(input: {
  sessions: SessionRecord[];
  tasks: TaskRecord[];
  roleBindingsByRole: Partial<Record<ProjectBoardRoleReadiness["roleId"], SkillBindingRecord[]>>;
  workspaceMemory?: WorkspaceMemoryRecord | undefined;
  crmLeads?: CrmLeadRecord[] | undefined;
  crmCadences?: CrmCadenceRecord[] | undefined;
  goalRuns?: GoalRunRecord[] | undefined;
  goalRunHandoffs?: Array<{ id: string; goalRunId: string; artifact: StageHandoffArtifact }> | undefined;
  goalRunTraces?: GoalRunTraceRecord[] | undefined;
}): ProjectBoardSnapshot {
  const orchestrationBySession = new Map<
    string,
    {
      task: TaskRecord;
      orchestration: OrchestrationStateRecord;
      updatedAt: string;
    }
  >();
  for (const session of input.sessions) {
    const latest = pickLatestOrchestrationTask(input.tasks, session.id);
    if (latest) {
      orchestrationBySession.set(session.id, latest);
    }
  }

  const sessionsWithState = input.sessions
    .filter((session) => session?.metadata?.projectMemory || orchestrationBySession.has(session.id))
    .sort((left, right) => {
      const leftMemory = normalizeProjectMemory(left.metadata?.projectMemory);
      const rightMemory = normalizeProjectMemory(right.metadata?.projectMemory);
      const leftOrchestration = orchestrationBySession.get(left.id);
      const rightOrchestration = orchestrationBySession.get(right.id);
      const leftUpdatedAt = leftOrchestration?.updatedAt || leftMemory.updatedAt || left.updatedAt;
      const rightUpdatedAt = rightOrchestration?.updatedAt || rightMemory.updatedAt || right.updatedAt;
      return parseTimestamp(rightUpdatedAt) - parseTimestamp(leftUpdatedAt);
    });

  const primarySession = sessionsWithState[0];
  const primary = primarySession ? buildPrimaryView(primarySession, orchestrationBySession.get(primarySession.id)) : null;
  const projects = buildProjectCollection({
    sessions: input.sessions,
    orchestrationBySession,
    workspaceMemory: input.workspaceMemory,
    crmLeads: input.crmLeads,
    crmCadences: input.crmCadences,
    goalRuns: input.goalRuns,
    goalRunHandoffs: input.goalRunHandoffs,
    goalRunTraces: input.goalRunTraces
  });
  const archivedProjects = buildProjectCollection({
    sessions: input.sessions,
    orchestrationBySession,
    workspaceMemory: input.workspaceMemory,
    archived: true,
    crmLeads: input.crmLeads,
    crmCadences: input.crmCadences,
    goalRuns: input.goalRuns,
    goalRunHandoffs: input.goalRunHandoffs,
    goalRunTraces: input.goalRunTraces
  });
  const workstreams = sessionsWithState
    .slice(0, 6)
    .map((session) => buildWorkstreamView(session, orchestrationBySession.get(session.id)));
  const blockedTasks = input.tasks.filter((task) => task.status === "failed");
  const awaitingInputTasks = input.tasks.filter((task) => {
    const metadata = task.metadata ?? {};
    return (
      task.status === "paused_input" ||
      Boolean(task.pendingInput?.question) ||
      metadata.collaborationStatus === "await_user" ||
      metadata.collaborationConvergenceMode === "await_user" ||
      (Array.isArray(metadata.collaborationPendingQuestions) && metadata.collaborationPendingQuestions.length > 0)
    );
  });
  const blockers = dedupeStrings(
    [
      ...(primary?.unresolvedQuestions ?? []),
      ...blockedTasks.map((task) => `${task.title}: ${task.errorText || task.status}`),
      ...awaitingInputTasks.map((task) => task.title)
    ],
    8
  );
  const pendingDecisions = dedupeStrings(
    [
      ...(primary?.keyDecisions ?? []),
      ...(primary?.unresolvedQuestions ?? []),
      ...workstreams.flatMap((stream) => stream.unresolvedQuestions)
    ],
    8
  );
  const nextActions = dedupeStrings([...(primary?.nextActions ?? []), ...workstreams.flatMap((stream) => stream.nextActions)], 8);
  const latestArtifacts = dedupeStrings(
    [...(primary?.latestArtifacts ?? []), ...workstreams.flatMap((stream) => stream.latestArtifacts)],
    10
  );
  const teamReadiness = buildRoleReadiness(input.roleBindingsByRole);
  const crmLeads = input.crmLeads ?? [];
  const crmCadences = input.crmCadences ?? [];
  const overdueCadences = crmCadences.filter((cadence) => cadence.status === "active" && parseTimestamp(cadence.nextRunAt) <= Date.now());

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      activeProjects: projects.length,
      archivedProjects: archivedProjects.length,
      blockedTasks: blockedTasks.length,
      awaitingInputTasks: awaitingInputTasks.length,
      recentArtifacts: latestArtifacts.length,
      readyRoles: teamReadiness.filter((role) => role.ready).length,
      verificationDebtRoles: teamReadiness.filter((role) => role.unverifiedSkills > 0).length,
      failedSkills: teamReadiness.reduce((total, role) => total + role.failedSkills, 0),
      activeLeads: crmLeads.filter((lead) => lead.status === "active").length,
      activeCadences: crmCadences.filter((cadence) => cadence.status === "active").length,
      overdueCadences: overdueCadences.length,
      linkedProjectLeads: crmLeads.filter((lead) => Boolean(lead.linkedProjectId)).length
    },
    primary,
    blockers,
    pendingDecisions,
    nextActions,
    latestArtifacts,
    teamReadiness,
    workstreams,
    projects,
    archivedProjects
  };
}

export function listProjectBoardProjects(
  snapshot: ProjectBoardSnapshot,
  options?: { includeArchived?: boolean | undefined }
): ProjectBoardProject[] {
  const active = Array.isArray(snapshot.projects) ? snapshot.projects : [];
  const archived = Array.isArray(snapshot.archivedProjects) ? snapshot.archivedProjects : [];
  return options?.includeArchived ? [...active, ...archived] : active;
}

export function findProjectBoardProject(
  snapshot: ProjectBoardSnapshot,
  projectId: string
): ProjectBoardProject | undefined {
  const normalizedId = projectId.trim();
  if (!normalizedId) {
    return undefined;
  }
  return listProjectBoardProjects(snapshot, { includeArchived: true }).find((project) => project.id === normalizedId);
}

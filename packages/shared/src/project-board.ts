import { normalizeOrchestrationState, type OrchestrationStateRecord } from "./orchestration-state.js";
import { normalizeProjectMemory } from "./project-memory.js";
import { listRoles } from "./roles.js";
import type {
  ProjectBoardPrimaryView,
  ProjectBoardRoleReadiness,
  ProjectBoardSnapshot,
  ProjectBoardWorkstream,
  SessionRecord,
  SkillBindingRecord,
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

function mergeArtifacts(memoryArtifacts: string[], orchestration: OrchestrationStateRecord | undefined): string[] {
  if (!orchestration) {
    return memoryArtifacts;
  }
  return dedupeStrings([...orchestration.artifactIndex.items.map((item) => item.path), ...memoryArtifacts], 16);
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

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      activeProjects: workstreams.length,
      blockedTasks: blockedTasks.length,
      awaitingInputTasks: awaitingInputTasks.length,
      recentArtifacts: latestArtifacts.length,
      readyRoles: teamReadiness.filter((role) => role.ready).length,
      verificationDebtRoles: teamReadiness.filter((role) => role.unverifiedSkills > 0).length,
      failedSkills: teamReadiness.reduce((total, role) => total + role.failedSkills, 0)
    },
    primary,
    blockers,
    pendingDecisions,
    nextActions,
    latestArtifacts,
    teamReadiness,
    workstreams
  };
}

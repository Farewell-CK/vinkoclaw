import { buildProjectBoardSnapshot } from "./project-board.js";
import { buildWorkflowStatusSummary } from "./workflow-summary.js";
import { ROLE_IDS } from "./types.js";
import type {
  ApprovalRecord,
  GoalRunRecord,
  ProjectBoardSnapshot,
  RoleId,
  SessionRecord,
  SkillBindingRecord,
  TaskRecord
} from "./types.js";
import type { VinkoStore } from "./store.js";
import type { WorkspaceMemoryRecord } from "./workspace-memory.js";

export interface SessionWorkbenchSnapshot {
  sessionId: string;
  sessionTitle: string;
  source: SessionRecord["source"];
  generatedAt: string;
  currentGoal: string;
  currentStage: string;
  latestSummary: string;
  blockers: string[];
  pendingDecisions: string[];
  nextActions: string[];
  latestArtifacts: string[];
  activeTask?: {
    id: string;
    title: string;
    status: string;
    roleId: string;
    workflowSummary: string;
  } | undefined;
  activeGoalRun?: {
    id: string;
    stage: string;
    status: string;
    objective: string;
  } | undefined;
  pendingApproval?: {
    id: string;
    summary: string;
    status: string;
  } | undefined;
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function dedupe(values: string[], limit = 6): string[] {
  return Array.from(new Set(values.map((item) => item.trim()).filter(Boolean))).slice(0, limit);
}

export function buildSessionWorkbenchSnapshot(input: {
  session: SessionRecord;
  sessions: SessionRecord[];
  tasks: TaskRecord[];
  approvals: ApprovalRecord[];
  goalRuns: GoalRunRecord[];
  roleBindingsByRole: Partial<Record<string, SkillBindingRecord[]>>;
  workspaceMemory?: WorkspaceMemoryRecord | undefined;
  crmLeads?: unknown[] | undefined;
  crmCadences?: unknown[] | undefined;
  crmContacts?: unknown[] | undefined;
  goalRunHandoffs?: Array<{ id: string; goalRunId: string; artifact: { artifacts: string[] } }> | undefined;
  goalRunTraces?: Array<{ goalRunId: string; artifactFiles: string[] }> | undefined;
}): SessionWorkbenchSnapshot {
  const board = buildProjectBoardSnapshot({
    sessions: input.sessions,
    tasks: input.tasks,
    roleBindingsByRole: input.roleBindingsByRole,
    workspaceMemory: input.workspaceMemory,
    crmLeads: input.crmLeads as never,
    crmCadences: input.crmCadences as never,
    crmContacts: input.crmContacts as never,
    goalRuns: input.goalRuns,
    goalRunHandoffs: input.goalRunHandoffs as never,
    goalRunTraces: input.goalRunTraces as never
  });
  return buildSessionWorkbenchSnapshotFromBoard({
    session: input.session,
    board,
    tasks: input.tasks,
    approvals: input.approvals,
    goalRuns: input.goalRuns
  });
}

export function buildSessionWorkbenchSnapshotFromStore(input: {
  store: VinkoStore;
  sessionId: string;
  sessionLimit?: number | undefined;
  taskLimit?: number | undefined;
  approvalLimit?: number | undefined;
  goalRunLimit?: number | undefined;
}): SessionWorkbenchSnapshot | undefined {
  const session = input.store.getSession(input.sessionId);
  if (!session) {
    return undefined;
  }
  const sessions = input.store.listSessions(input.sessionLimit ?? 100);
  const tasks = input.store.listTasks(input.taskLimit ?? 500);
  const approvals = input.store.listApprovals(input.approvalLimit ?? 500);
  const goalRuns = input.store.listGoalRuns({ limit: input.goalRunLimit ?? 500 });
  const roleBindingsByRole = ROLE_IDS.reduce<Partial<Record<RoleId, SkillBindingRecord[]>>>((acc, roleId) => {
    acc[roleId] = input.store.resolveSkillsForRole(roleId);
    return acc;
  }, {});

  return buildSessionWorkbenchSnapshot({
    session,
    sessions,
    tasks,
    approvals,
    goalRuns,
    roleBindingsByRole,
    workspaceMemory: input.store.getWorkspaceMemory(),
    crmLeads: input.store.listCrmLeads({ limit: 500 }),
    crmCadences: input.store.listCrmCadences({ limit: 500 }),
    crmContacts: input.store.listCrmContacts({ limit: 500 }),
    goalRunHandoffs: goalRuns.flatMap((run) =>
      input.store.listGoalRunHandoffArtifacts(run.id, 20).map((entry) => ({
        id: entry.id,
        goalRunId: run.id,
        artifact: entry.artifact
      }))
    ),
    goalRunTraces: goalRuns.flatMap((run) => input.store.listGoalRunTraces(run.id, 20))
  });
}

export function buildSessionWorkbenchSnapshotFromBoard(input: {
  session: SessionRecord;
  board: ProjectBoardSnapshot;
  tasks: TaskRecord[];
  approvals: ApprovalRecord[];
  goalRuns: GoalRunRecord[];
}): SessionWorkbenchSnapshot {
  const memory = (input.session.metadata?.projectMemory ?? {}) as Record<string, unknown>;
  const activeTask = input.tasks
    .filter((task) => task.sessionId === input.session.id && ["queued", "running", "paused_input", "waiting_approval"].includes(task.status))
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
  const activeGoalRun = input.goalRuns
    .filter((run) => run.sessionId === input.session.id && ["queued", "running", "awaiting_input", "awaiting_authorization"].includes(run.status))
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
  const taskIdsInSession = new Set(input.tasks.filter((task) => task.sessionId === input.session.id).map((task) => task.id));
  const pendingApproval = input.approvals
    .filter((approval) =>
      approval.status === "pending" &&
      (
        Boolean(approval.taskId && taskIdsInSession.has(approval.taskId)) ||
        activeTask?.status === "waiting_approval" ||
        /授权|审批|approval/i.test(approval.summary)
      )
    )
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];

  const primary = input.board.primary?.sessionId === input.session.id
    ? input.board.primary
    : input.board.workstreams.find((item) => item.sessionId === input.session.id);

  const currentGoal = clean(primary?.currentGoal) || clean(memory.currentGoal) || clean(input.session.title);
  const currentStage = clean(primary?.currentStage) || clean(memory.currentStage) || "unknown";
  const latestSummary = clean(primary?.latestSummary) || clean(memory.latestSummary) || (activeTask?.result?.summary ?? "");
  const blockers = dedupe([
    ...(primary?.unresolvedQuestions ?? []),
    ...input.tasks
      .filter((task) => task.sessionId === input.session.id && task.status === "failed")
      .map((task) => `${task.title}: ${clean(task.errorText) || task.status}`),
    ...(pendingApproval ? [`待审批：${pendingApproval.summary}`] : [])
  ]);
  const pendingDecisions = dedupe([
    ...(input.board.pendingDecisions ?? []),
    ...(primary?.unresolvedQuestions ?? [])
  ]);
  const nextActions = dedupe([
    ...(primary?.nextActions ?? []),
    ...(activeGoalRun?.result?.nextActions ?? []),
    ...(typeof memory.nextActions === "object" && Array.isArray(memory.nextActions) ? memory.nextActions.filter((item): item is string => typeof item === "string") : [])
  ]);
  const latestArtifacts = dedupe([
    ...(primary?.latestArtifacts ?? []),
    ...(typeof memory.latestArtifacts === "object" && Array.isArray(memory.latestArtifacts) ? memory.latestArtifacts.filter((item): item is string => typeof item === "string") : [])
  ], 8);

  return {
    sessionId: input.session.id,
    sessionTitle: input.session.title,
    source: input.session.source,
    generatedAt: input.board.generatedAt,
    currentGoal,
    currentStage,
    latestSummary,
    blockers,
    pendingDecisions,
    nextActions,
    latestArtifacts,
    ...(activeTask
      ? {
          activeTask: {
            id: activeTask.id,
            title: activeTask.title,
            status: activeTask.status,
            roleId: activeTask.roleId,
            workflowSummary: buildWorkflowStatusSummary(activeTask, {
              includeGoal: true,
              includeArtifacts: true
            })
          }
        }
      : {}),
    ...(activeGoalRun
      ? {
          activeGoalRun: {
            id: activeGoalRun.id,
            stage: activeGoalRun.currentStage,
            status: activeGoalRun.status,
            objective: activeGoalRun.objective
          }
        }
      : {}),
    ...(pendingApproval
      ? {
          pendingApproval: {
            id: pendingApproval.id,
            summary: pendingApproval.summary,
            status: pendingApproval.status
          }
        }
      : {})
  };
}

import type { GoalRunRecord, GoalRunResult, GoalRunStage, GoalRunStatus, TaskRecord } from "./types.js";

type GoalRunSummaryArtifacts = {
  latestHandoff?: {
    id: string;
    artifact?: {
      summary?: string | undefined;
      nextActions?: string[] | undefined;
      unresolvedQuestions?: string[] | undefined;
      approvalNeeds?: string[] | undefined;
      artifacts?: string[] | undefined;
    } | undefined;
  } | undefined;
  currentTask?: Pick<TaskRecord, "id" | "status" | "metadata"> | undefined;
  projectMemory?: Record<string, unknown> | undefined;
};

export type GoalRunSummaryRecord = {
  workflowLabel: string;
  goal: string;
  stage: string;
  status: GoalRunStatus;
  statusLabel: string;
  nextStep: string;
  pendingItems: string[];
  blockedItems: string[];
  recentArtifacts: string[];
  handoffSummary?: string | undefined;
  successCriteria: string[];
  completionSignal?: string | undefined;
};

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function uniqueLines(values: unknown[], limit = 5): string[] {
  return Array.from(
    new Set(
      values
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean)
    )
  ).slice(0, limit);
}

function toStringList(value: unknown, limit = 5): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return uniqueLines(value, limit);
}

function firstNonEmpty(...values: unknown[]): string {
  for (const value of values) {
    const normalized = clean(value);
    if (normalized) {
      return normalized;
    }
  }
  return "";
}

function mapGoalRunStageLabel(stage: GoalRunStage, language: string): string {
  const zh = language.toLowerCase().startsWith("zh");
  switch (stage) {
    case "discover":
      return zh ? "信息澄清" : "Discover";
    case "plan":
      return zh ? "计划拆解" : "Plan";
    case "execute":
      return zh ? "执行交付" : "Execute";
    case "verify":
      return zh ? "验证校验" : "Verify";
    case "deploy":
      return zh ? "部署准备" : "Deploy";
    case "accept":
      return zh ? "验收交付" : "Accept";
    default:
      return stage;
  }
}

function mapGoalRunStatusLabel(status: GoalRunStatus, language: string): string {
  const zh = language.toLowerCase().startsWith("zh");
  switch (status) {
    case "queued":
      return zh ? "排队中" : "Queued";
    case "running":
      return zh ? "进行中" : "Running";
    case "awaiting_input":
      return zh ? "待补充" : "Awaiting input";
    case "awaiting_authorization":
      return zh ? "待授权" : "Awaiting authorization";
    case "completed":
      return zh ? "已完成" : "Completed";
    case "failed":
      return zh ? "失败" : "Failed";
    case "cancelled":
      return zh ? "已取消" : "Cancelled";
    default:
      return status;
  }
}

function inferWorkflowLabel(run: GoalRunRecord, artifacts?: GoalRunSummaryArtifacts): string {
  return firstNonEmpty(
    run.metadata?.workflowLabel,
    run.metadata?.routeTemplateName,
    artifacts?.currentTask?.metadata?.workflowLabel,
    run.metadata?.templateLabel,
    /founder/i.test(clean(run.objective)) ? "Founder Goal Run" : "",
    "Goal Run"
  );
}

function inferSuccessCriteria(run: GoalRunRecord, artifacts?: GoalRunSummaryArtifacts): string[] {
  const fromMetadata = Array.isArray(run.metadata?.workflowSuccessCriteria) ? run.metadata.workflowSuccessCriteria : [];
  const fromPlanAcceptance = Array.isArray(run.plan?.acceptance) ? run.plan.acceptance : [];
  const fromPlanSuccess = Array.isArray(run.plan?.successCriteria) ? run.plan.successCriteria : [];
  const fromProjectMemory = Array.isArray(artifacts?.projectMemory?.successCriteria) ? artifacts?.projectMemory?.successCriteria : [];
  return uniqueLines(
    [...fromMetadata, ...fromPlanAcceptance, ...fromPlanSuccess, ...fromProjectMemory],
    4
  );
}

function inferCompletionSignal(run: GoalRunRecord, artifacts?: GoalRunSummaryArtifacts): string {
  return firstNonEmpty(
    run.metadata?.workflowCompletionSignal,
    run.plan?.completionSignal,
    artifacts?.currentTask?.metadata?.workflowCompletionSignal
  );
}

function inferNextStep(run: GoalRunRecord, artifacts?: GoalRunSummaryArtifacts): string {
  const fromResult = toStringList(run.result?.nextActions, 2);
  if (fromResult.length > 0) {
    return fromResult.join("；");
  }

  const fromHandoff = toStringList(artifacts?.latestHandoff?.artifact?.nextActions, 2);
  if (fromHandoff.length > 0) {
    return fromHandoff.join("；");
  }

  const fromProjectMemory = toStringList(artifacts?.projectMemory?.nextActions, 2);
  if (fromProjectMemory.length > 0) {
    return fromProjectMemory.join("；");
  }

  if (run.status === "awaiting_input") {
    return clean(run.awaitingInputPrompt) || "等待补充信息";
  }
  if (run.status === "awaiting_authorization") {
    return "等待授权后继续部署";
  }
  if (run.status === "completed") {
    return toStringList(run.result?.nextActions, 1)[0] ?? "可进入下一轮目标";
  }
  if (run.status === "failed") {
    return clean(run.errorText) || "需要重新规划或拆分";
  }

  const zh = run.language.toLowerCase().startsWith("zh");
  switch (run.currentStage) {
    case "discover":
      return zh ? "补齐关键输入后进入计划拆解" : "Provide inputs and move to planning";
    case "plan":
      return zh ? "生成执行计划并创建工作包" : "Generate plan and work packages";
    case "execute":
      return zh ? "推进主执行任务并沉淀产物" : "Advance execution and produce artifacts";
    case "verify":
      return zh ? "校验产物、角色覆盖与可发布性" : "Verify artifacts and release readiness";
    case "deploy":
      return zh ? "完成部署前检查与授权" : "Complete deploy preflight and authorization";
    case "accept":
      return zh ? "整理交付总结与下一步" : "Finalize handoff and next steps";
    default:
      return "";
  }
}

function inferPendingItems(run: GoalRunRecord, artifacts?: GoalRunSummaryArtifacts): string[] {
  return uniqueLines(
    [
      ...run.awaitingInputFields,
      ...toStringList(artifacts?.latestHandoff?.artifact?.unresolvedQuestions, 3),
      ...(run.status === "awaiting_authorization"
        ? toStringList(artifacts?.latestHandoff?.artifact?.approvalNeeds, 2)
        : [])
    ],
    4
  );
}

function inferBlockedItems(run: GoalRunRecord): string[] {
  if (run.status === "failed") {
    return uniqueLines([run.errorText], 2);
  }
  if (run.status === "awaiting_authorization") {
    return ["尚未提交部署授权"];
  }
  return [];
}

function inferRecentArtifacts(run: GoalRunRecord, artifacts?: GoalRunSummaryArtifacts): string[] {
  return uniqueLines(
    [
      ...toStringList(run.context?.last_artifact_files, 4),
      ...toStringList(artifacts?.latestHandoff?.artifact?.artifacts, 4),
      ...toStringList(artifacts?.projectMemory?.latestArtifacts, 4)
    ],
    4
  );
}

function resolveGoal(run: GoalRunRecord, artifacts?: GoalRunSummaryArtifacts): string {
  return firstNonEmpty(
    run.objective,
    artifacts?.projectMemory?.currentGoal
  );
}

export function summarizeGoalRun(
  run: GoalRunRecord,
  artifacts: GoalRunSummaryArtifacts = {}
): GoalRunSummaryRecord {
  const successCriteria = inferSuccessCriteria(run, artifacts);
  const completionSignal = inferCompletionSignal(run, artifacts) || undefined;
  return {
    workflowLabel: inferWorkflowLabel(run, artifacts),
    goal: resolveGoal(run, artifacts),
    stage: mapGoalRunStageLabel(run.currentStage, run.language),
    status: run.status,
    statusLabel: mapGoalRunStatusLabel(run.status, run.language),
    nextStep: inferNextStep(run, artifacts),
    pendingItems: inferPendingItems(run, artifacts),
    blockedItems: inferBlockedItems(run),
    recentArtifacts: inferRecentArtifacts(run, artifacts),
    handoffSummary: clean(artifacts.latestHandoff?.artifact?.summary) || undefined,
    successCriteria,
    completionSignal
  };
}

export function buildGoalRunWorkflowSummary(
  run: GoalRunRecord,
  artifacts: GoalRunSummaryArtifacts = {}
): string {
  const summary = summarizeGoalRun(run, artifacts);
  const lines: string[] = [];

  if (summary.workflowLabel) {
    lines.push(`**工作流**：${summary.workflowLabel}`);
  }
  if (summary.goal) {
    lines.push(`**目标**：${summary.goal}`);
  }
  lines.push(`**当前阶段**：${summary.stage} · ${summary.statusLabel}`);
  if (summary.nextStep) {
    lines.push(`**下一步**：${summary.nextStep}`);
  }
  if (summary.pendingItems.length > 0) {
    lines.push(`**待补充**：${summary.pendingItems.join("；")}`);
  }
  if (summary.blockedItems.length > 0) {
    lines.push(`**阻塞**：${summary.blockedItems.join("；")}`);
  }
  if (summary.successCriteria.length > 0) {
    lines.push(`**成功标准**：${summary.successCriteria.join("；")}`);
  }
  if (summary.completionSignal) {
    lines.push(`**完成信号**：${summary.completionSignal}`);
  }
  if (summary.recentArtifacts.length > 0) {
    lines.push(`**最近产物**：${summary.recentArtifacts.join("；")}`);
  }
  if (summary.handoffSummary) {
    lines.push(`**最近交接**：${summary.handoffSummary}`);
  }

  return lines.join("\n");
}

export function buildGoalRunStatusMessage(
  run: GoalRunRecord,
  artifacts: GoalRunSummaryArtifacts = {}
): string {
  const summary = summarizeGoalRun(run, artifacts);
  const runId = run.id.slice(0, 8);
  if (run.status === "completed") {
    return `目标 ${runId} 已完成。\n\n${buildGoalRunWorkflowSummary(run, artifacts)}`;
  }
  if (run.status === "awaiting_input") {
    return `目标 ${runId} 正在等待补充信息。\n\n${buildGoalRunWorkflowSummary(run, artifacts)}`;
  }
  if (run.status === "awaiting_authorization") {
    return `目标 ${runId} 正在等待授权。\n\n${buildGoalRunWorkflowSummary(run, artifacts)}`;
  }
  if (run.status === "failed") {
    return `目标 ${runId} 执行失败。\n\n${buildGoalRunWorkflowSummary(run, artifacts)}`;
  }
  return `目标 ${runId} 正在推进中。\n\n${buildGoalRunWorkflowSummary(run, artifacts)}`;
}

export function buildGoalRunProgressMessage(
  run: GoalRunRecord,
  updateMessage: string,
  artifacts: GoalRunSummaryArtifacts = {}
): string {
  const head = clean(updateMessage);
  const summary = buildGoalRunWorkflowSummary(run, artifacts);
  return head ? [head, summary].filter(Boolean).join("\n\n") : summary;
}

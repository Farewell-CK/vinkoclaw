import type { DashboardSnapshot } from "./types.js";

function toAlertLevelValue(level: DashboardSnapshot["queueMetrics"]["alertLevel"]): number {
  if (level === "critical") {
    return 2;
  }
  if (level === "warning") {
    return 1;
  }
  return 0;
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function line(name: string, value: number, labels?: Record<string, string>): string {
  if (!labels || Object.keys(labels).length === 0) {
    return `${name} ${Number.isFinite(value) ? value : 0}`;
  }
  const renderedLabels = Object.entries(labels)
    .map(([key, labelValue]) => `${key}="${escapeLabelValue(labelValue)}"`)
    .join(",");
  return `${name}{${renderedLabels}} ${Number.isFinite(value) ? value : 0}`;
}

export function renderPrometheusMetrics(snapshot: DashboardSnapshot): string {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const pendingApprovals = snapshot.approvals.filter((approval) => approval.status === "pending").length;
  const pendingToolApprovals = snapshot.toolRuns.filter((run) => run.approvalStatus === "pending").length;
  const lines: string[] = [
    "# HELP vinko_tasks_queued Number of queued tasks",
    "# TYPE vinko_tasks_queued gauge",
    line("vinko_tasks_queued", snapshot.queueMetrics.queuedCount),
    "# HELP vinko_tasks_running Number of running tasks",
    "# TYPE vinko_tasks_running gauge",
    line("vinko_tasks_running", snapshot.queueMetrics.runningCount),
    "# HELP vinko_tasks_completed_24h Number of tasks completed in the last 24 hours",
    "# TYPE vinko_tasks_completed_24h gauge",
    line("vinko_tasks_completed_24h", snapshot.queueMetrics.completedCountLast24h),
    "# HELP vinko_queue_oldest_wait_ms Oldest queued task wait time in milliseconds",
    "# TYPE vinko_queue_oldest_wait_ms gauge",
    line("vinko_queue_oldest_wait_ms", snapshot.queueMetrics.oldestQueuedWaitMs),
    "# HELP vinko_queue_alert_level Queue alert level (0=ok, 1=warning, 2=critical)",
    "# TYPE vinko_queue_alert_level gauge",
    line("vinko_queue_alert_level", toAlertLevelValue(snapshot.queueMetrics.alertLevel)),
    "# HELP vinko_approvals_pending_total Number of pending approvals",
    "# TYPE vinko_approvals_pending_total gauge",
    line("vinko_approvals_pending_total", pendingApprovals),
    "# HELP vinko_tool_runs_approval_pending_total Number of tool runs waiting approval",
    "# TYPE vinko_tool_runs_approval_pending_total gauge",
    line("vinko_tool_runs_approval_pending_total", pendingToolApprovals),
    "# HELP vinko_queue_by_role_queued Queued tasks by role",
    "# TYPE vinko_queue_by_role_queued gauge"
  ];

  for (const roleEntry of snapshot.queueMetrics.byRole) {
    lines.push(line("vinko_queue_by_role_queued", roleEntry.queued, { role: roleEntry.id }));
  }

  lines.push("# HELP vinko_metrics_generated_unix_seconds Metrics generation timestamp");
  lines.push("# TYPE vinko_metrics_generated_unix_seconds gauge");
  lines.push(line("vinko_metrics_generated_unix_seconds", nowSeconds));

  return `${lines.join("\n")}\n`;
}

import { describe, expect, it } from "vitest";
import {
  buildHarnessGradeRecord,
  buildHarnessReportRecord,
  deriveHarnessGrade,
  getHarnessSuiteCommandString,
  normalizeHarnessSuiteName,
  summarizeHarnessQueueDepth
} from "./harness.js";

describe("harness", () => {
  it("normalizes suite names with a shared validator", () => {
    expect(normalizeHarnessSuiteName(" founder-delivery ")).toBe("founder-delivery");
    expect(normalizeHarnessSuiteName("../invalid")).toBeUndefined();
  });

  it("builds report records from shared suite defaults", () => {
    const record = buildHarnessReportRecord({
      suite: "product",
      ok: true,
      exitCode: 0,
      startedAt: "2026-04-19T00:00:00.000Z",
      finishedAt: "2026-04-19T00:03:10.000Z",
      durationMs: 190_000
    });

    expect(record.label).toBe("Product Self Check");
    expect(record.command).toBe("npm run self-check:product");
    expect(record.budgetMs).toBe(300_000);
    expect(record.exceededBudget).toBe(false);
    expect(record.overBudgetMs).toBe(0);
  });

  it("derives warn grade from over-budget runs", () => {
    expect(
      deriveHarnessGrade({
        ok: true,
        timedOut: false,
        exceededBudget: true,
        stateCompleteness: true
      })
    ).toBe("warn");
  });

  it("summarizes queue depth with stable integer coercion", () => {
    expect(
      summarizeHarnessQueueDepth({
        queuedTasks: "2",
        runningTasks: 1.4,
        waitingApprovalTasks: undefined,
        queuedGoalRuns: -5,
        runningGoalRuns: "3"
      })
    ).toEqual({
      queuedTasks: 2,
      runningTasks: 1,
      waitingApprovalTasks: 0,
      queuedGoalRuns: 0,
      runningGoalRuns: 3
    });
  });

  it("builds grade records from latest report snapshots", () => {
    const record = buildHarnessGradeRecord("founder-delivery", {
      suite: "founder-delivery",
      label: "Founder Delivery Loop",
      ok: true,
      exitCode: 0,
      startedAt: "2026-04-19T00:00:00.000Z",
      finishedAt: "2026-04-19T00:04:00.000Z",
      durationMs: 240_000,
      command: getHarnessSuiteCommandString("founder-delivery") ?? "unknown",
      grade: "pass",
      traceSummary: "4/4 stages completed",
      stateCompleteness: true
    });

    expect(record).toEqual({
      suite: "founder-delivery",
      grade: "pass",
      failedInvariant: undefined,
      traceSummary: "4/4 stages completed",
      handoffCoverage: undefined,
      approvalCoverage: undefined,
      resumeCoverage: undefined,
      stateCompleteness: true,
      generatedAt: "2026-04-19T00:04:00.000Z"
    });
  });

  it("exposes command strings for crm cadence suite", () => {
    expect(getHarnessSuiteCommandString("crm-cadence")).toBe("npm run self-check:crm-cadence");
  });
});

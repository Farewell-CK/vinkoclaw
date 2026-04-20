import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { GoalRunHarnessGradeRecord } from "./types.js";

export type HarnessSuiteDefinition = {
  id: string;
  label: string;
  command: string[];
  budgetMs: number;
};

export type HarnessStageSummaryEntry = {
  regressionCategory?: string | undefined;
  status?: string | undefined;
  deliverableMode?: string | undefined;
  artifactCount?: number | undefined;
  deliverableContractViolated?: boolean | undefined;
  statePresent?: boolean | undefined;
  stateStage?: string | undefined;
  stateStatus?: string | undefined;
  executionMs?: number | undefined;
  startedAt?: string | undefined;
  completedAt?: string | undefined;
};

export type HarnessReportRecord = {
  suite: string;
  label: string;
  ok: boolean;
  exitCode: number;
  timedOut?: boolean | undefined;
  timeoutMs?: number | undefined;
  budgetMs?: number | undefined;
  exceededBudget?: boolean | undefined;
  overBudgetMs?: number | undefined;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  command: string;
  orchBase?: string | undefined;
  healthOk?: boolean | undefined;
  projectBoardSummary?: Record<string, unknown> | null | undefined;
  regressionCategory?: string | undefined;
  failedStage?: string | undefined;
  failedStageBudgetMs?: number | undefined;
  failedStageExecutionMs?: number | undefined;
  failedStageOverBudgetMs?: number | undefined;
  detail?: string | undefined;
  completedStages?: string[] | undefined;
  stageSummary?: Record<string, HarnessStageSummaryEntry> | undefined;
  stateCompleteness?: boolean | undefined;
  observeError?: string | undefined;
  stdoutTail?: string | undefined;
  stderrTail?: string | undefined;
  grade?: "pass" | "warn" | "fail" | "unknown" | undefined;
  failedInvariant?: string | undefined;
  traceSummary?: string | undefined;
  handoffCoverage?: number | undefined;
  approvalCoverage?: number | undefined;
  resumeCoverage?: number | undefined;
  queueDepth?: Record<string, number> | undefined;
};

export type BuildHarnessReportRecordInput = Omit<
  Partial<HarnessReportRecord>,
  "suite" | "label" | "ok" | "exitCode" | "budgetMs" | "exceededBudget" | "overBudgetMs" | "startedAt" | "finishedAt" | "durationMs" | "command"
> & {
  suite: string;
  label?: string | undefined;
  ok: boolean;
  exitCode: number;
  budgetMs?: number | undefined;
  exceededBudget?: boolean | undefined;
  overBudgetMs?: number | undefined;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  command?: string | string[] | undefined;
};

export type HarnessGradeInput = Pick<
  HarnessReportRecord,
  "ok" | "timedOut" | "exceededBudget" | "stateCompleteness"
>;

export type HarnessQueueDepthSummary = {
  queuedTasks: number;
  runningTasks: number;
  waitingApprovalTasks: number;
  queuedGoalRuns: number;
  runningGoalRuns: number;
};

export type HarnessFs = {
  existsSync: (targetPath: string) => boolean;
  readFileSync: (targetPath: string, encoding: "utf8") => string;
  readdirSync: (targetPath: string) => Array<{ name: string; isDirectory: () => boolean }>;
};

export const HARNESS_SUITES: HarnessSuiteDefinition[] = [
  { id: "product", label: "Product Self Check", command: ["npm", "run", "self-check:product"], budgetMs: 5 * 60_000 },
  { id: "founder-delivery", label: "Founder Delivery Loop", command: ["npm", "run", "self-check:founder-delivery"], budgetMs: 8 * 60_000 },
  { id: "founder-ops", label: "Founder Ops Follow-up", command: ["npm", "run", "self-check:founder-ops"], budgetMs: 5 * 60_000 },
  { id: "founder-ops-recurring", label: "Founder Ops Recurring", command: ["npm", "run", "self-check:founder-ops-recurring"], budgetMs: 5 * 60_000 },
  { id: "founder-research", label: "Founder Research Report", command: ["npm", "run", "self-check:founder-research"], budgetMs: 5 * 60_000 },
  { id: "founder-research-recurring", label: "Founder Research Recurring", command: ["npm", "run", "self-check:founder-research-recurring"], budgetMs: 5 * 60_000 },
  { id: "founder-recap", label: "Founder Weekly Recap", command: ["npm", "run", "self-check:founder-recap"], budgetMs: 5 * 60_000 },
  { id: "founder-recap-recurring", label: "Founder Recap Recurring", command: ["npm", "run", "self-check:founder-recap-recurring"], budgetMs: 5 * 60_000 },
  { id: "founder-implementation", label: "Founder Implementation Task", command: ["npm", "run", "self-check:founder-implementation"], budgetMs: 5 * 60_000 },
  { id: "founder-bugfix", label: "Founder Bugfix Follow-up", command: ["npm", "run", "self-check:founder-bugfix"], budgetMs: 5 * 60_000 },
  { id: "artifact-export", label: "Artifact Export Self Check", command: ["npm", "run", "self-check:artifact-export"], budgetMs: 6 * 60_000 },
  { id: "persona", label: "Persona Test", command: ["npm", "run", "persona-test"], budgetMs: 5 * 60_000 },
  { id: "collaboration", label: "Collaboration Self Check", command: ["npm", "run", "self-check:collaboration"], budgetMs: 6 * 60_000 },
  { id: "skill-lifecycle", label: "Skill Lifecycle Self Check", command: ["npm", "run", "self-check:skill-lifecycle"], budgetMs: 6 * 60_000 },
  { id: "crm-cadence", label: "CRM Cadence Self Check", command: ["npm", "run", "self-check:crm-cadence"], budgetMs: 4 * 60_000 }
];

function createDefaultFs(): HarnessFs {
  return {
    existsSync,
    readFileSync: (targetPath, encoding) => readFileSync(targetPath, encoding),
    readdirSync: (targetPath) => readdirSync(targetPath, { withFileTypes: true })
  };
}

export function normalizeHarnessSuiteName(value: string | undefined): string | undefined {
  const suite = typeof value === "string" ? value.trim() : "";
  if (!suite || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(suite)) {
    return undefined;
  }
  return suite;
}

export function getHarnessSuiteCommandString(
  suiteOrDefinition: string | HarnessSuiteDefinition | undefined
): string | undefined {
  const definition =
    typeof suiteOrDefinition === "string" ? getHarnessSuiteDefinition(suiteOrDefinition) : suiteOrDefinition;
  return Array.isArray(definition?.command) ? definition.command.join(" ") : undefined;
}

function normalizeFiniteNumber(value: unknown): number | undefined {
  const normalized = Number(value);
  if (!Number.isFinite(normalized)) {
    return undefined;
  }
  return normalized;
}

function normalizeNonNegativeInteger(value: unknown): number {
  const normalized = normalizeFiniteNumber(value);
  if (typeof normalized !== "number") {
    return 0;
  }
  return Math.max(0, Math.round(normalized));
}

function readJsonFile<T>(filePath: string, fs: HarnessFs): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

export function getHarnessSuiteDefinition(suiteId: string): HarnessSuiteDefinition | undefined {
  return HARNESS_SUITES.find((suite) => suite.id === suiteId);
}

export function listHarnessSuites(): HarnessSuiteDefinition[] {
  return [...HARNESS_SUITES];
}

export function deriveHarnessGrade(input: HarnessGradeInput): "pass" | "warn" | "fail" {
  if (input.stateCompleteness === false) {
    return "fail";
  }
  if (input.ok === true && !input.timedOut && !input.exceededBudget) {
    return "pass";
  }
  if (input.ok === true && input.exceededBudget) {
    return "warn";
  }
  return "fail";
}

export function summarizeHarnessQueueDepth(queueDepth: unknown): HarnessQueueDepthSummary | undefined {
  if (!queueDepth || typeof queueDepth !== "object") {
    return undefined;
  }
  const source = queueDepth as Record<string, unknown>;
  return {
    queuedTasks: normalizeNonNegativeInteger(source.queuedTasks),
    runningTasks: normalizeNonNegativeInteger(source.runningTasks),
    waitingApprovalTasks: normalizeNonNegativeInteger(source.waitingApprovalTasks),
    queuedGoalRuns: normalizeNonNegativeInteger(source.queuedGoalRuns),
    runningGoalRuns: normalizeNonNegativeInteger(source.runningGoalRuns)
  };
}

export function buildHarnessReportRecord(input: BuildHarnessReportRecordInput): HarnessReportRecord {
  const suiteDefinition = getHarnessSuiteDefinition(input.suite);
  const label = input.label ?? suiteDefinition?.label ?? input.suite;
  const command =
    Array.isArray(input.command)
      ? input.command.join(" ")
      : input.command ?? getHarnessSuiteCommandString(suiteDefinition) ?? input.suite;
  const resolvedBudgetMs = normalizeFiniteNumber(input.budgetMs ?? suiteDefinition?.budgetMs);
  const budgetMs =
    typeof resolvedBudgetMs === "number" ? Math.max(0, Math.round(resolvedBudgetMs)) : undefined;
  const computedOverBudgetMs =
    typeof budgetMs === "number" ? Math.max(0, Math.round(input.durationMs - budgetMs)) : undefined;
  const overBudgetMs =
    typeof normalizeFiniteNumber(input.overBudgetMs) === "number"
      ? Math.max(0, Math.round(Number(input.overBudgetMs)))
      : computedOverBudgetMs;
  const exceededBudget =
    typeof input.exceededBudget === "boolean"
      ? input.exceededBudget
      : typeof overBudgetMs === "number"
        ? overBudgetMs > 0
        : undefined;

  const {
    suite: _suite,
    label: _label,
    ok: _ok,
    exitCode: _exitCode,
    budgetMs: _budgetMs,
    exceededBudget: _exceededBudget,
    overBudgetMs: _inputOverBudgetMs,
    startedAt: _startedAt,
    finishedAt: _finishedAt,
    durationMs: _durationMs,
    command: _command,
    ...rest
  } = input;

  const record: HarnessReportRecord = {
    ...rest,
    suite: input.suite,
    label,
    ok: input.ok,
    exitCode: input.exitCode,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    durationMs: input.durationMs,
    command
  };

  if (typeof budgetMs === "number") {
    record.budgetMs = budgetMs;
  }
  if (typeof exceededBudget === "boolean") {
    record.exceededBudget = exceededBudget;
  }
  if (typeof overBudgetMs === "number") {
    record.overBudgetMs = overBudgetMs;
  }

  return record;
}

export function buildHarnessGradeRecord(
  suite: string,
  latest: HarnessReportRecord | undefined
): GoalRunHarnessGradeRecord {
  if (!latest) {
    return {
      suite,
      grade: "unknown",
      generatedAt: new Date(0).toISOString()
    };
  }

  return {
    suite,
    grade: latest.grade ?? "unknown",
    failedInvariant: latest.failedInvariant,
    traceSummary: latest.traceSummary,
    handoffCoverage: latest.handoffCoverage,
    approvalCoverage: latest.approvalCoverage,
    resumeCoverage: latest.resumeCoverage,
    stateCompleteness: latest.stateCompleteness,
    generatedAt: latest.finishedAt || latest.startedAt || new Date(0).toISOString()
  };
}

export function parseHarnessHistoryFile(historyFile: string, limit: number, fs: HarnessFs = createDefaultFs()): {
  count: number;
  rows: unknown[];
} {
  const raw = fs.readFileSync(historyFile, "utf8");
  const rows = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-limit)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { parseError: true, raw: line };
      }
    });
  return {
    count: rows.length,
    rows
  };
}

export function listHarnessSuiteSnapshots(
  harnessRootDir: string,
  fs: HarnessFs = createDefaultFs()
): Array<{ suite: string; latest: unknown }> {
  if (!fs.existsSync(harnessRootDir)) {
    return [];
  }
  return fs
    .readdirSync(harnessRootDir)
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const suiteName = entry.name;
      const latestFile = path.join(harnessRootDir, suiteName, "latest.json");
      let latest: unknown = undefined;
      if (fs.existsSync(latestFile)) {
        try {
          latest = readJsonFile(latestFile, fs);
        } catch {
          latest = { parseError: true };
        }
      }
      return {
        suite: suiteName,
        latest
      };
    })
    .sort((left, right) => left.suite.localeCompare(right.suite));
}

export function readHarnessSuiteLatest(
  harnessRootDir: string,
  suiteName: string,
  fs: HarnessFs = createDefaultFs()
): HarnessReportRecord | undefined {
  const suite = normalizeHarnessSuiteName(suiteName);
  if (!suite) {
    return undefined;
  }
  const latestFile = path.join(harnessRootDir, suite, "latest.json");
  if (!fs.existsSync(latestFile)) {
    return undefined;
  }
  return readJsonFile<HarnessReportRecord>(latestFile, fs);
}

export function listHarnessGrades(
  harnessRootDir: string,
  fs: HarnessFs = createDefaultFs()
): GoalRunHarnessGradeRecord[] {
  if (!fs.existsSync(harnessRootDir)) {
    return [];
  }
  return fs
    .readdirSync(harnessRootDir)
    .filter((entry) => entry.isDirectory())
    .map((entry) => buildHarnessGradeRecord(entry.name, readHarnessSuiteLatest(harnessRootDir, entry.name, fs)))
    .sort((left, right) => left.suite.localeCompare(right.suite));
}

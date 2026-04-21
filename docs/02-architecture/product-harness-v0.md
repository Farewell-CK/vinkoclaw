# Product Harness v0

## Goal

Make VinkoClaw testable as an AI execution team, not just as isolated APIs or prompts.

The harness layer should answer:

- which workflow was tested
- what environment and command were used
- whether the workflow passed
- what artifacts and project state were produced
- where regressions appeared

## Current Scope

v0 introduces a unified harness runner and standardized persisted reports.

Default runtime policy:

- suites are observed against a budget
- exceeding budget is recorded in the report
- suites are not killed by default
- hard-kill mode is opt-in for explicit fail-fast debugging only

Covered suites:

- `product`: core product behavior self-check
- `founder-delivery`: end-to-end founder workflow (`PRD -> implementation -> QA -> recap`)
- `persona`: human-style conversation and routing scenarios

## Report Contract

Each harness suite writes to:

- `.run/harness/<suite>/latest.json`
- `.run/harness/<suite>/history.jsonl`

Current record fields:

- `suite`
- `label`
- `ok`
- `exitCode`
- `timedOut`
- `timeoutMs`
- `budgetMs`
- `exceededBudget`
- `overBudgetMs`
- `startedAt`
- `finishedAt`
- `durationMs`
- `command`
- `orchBase`
- `healthOk`
- `projectBoardSummary`
- `regressionCategory`
- `failedStage`
- `failedStageBudgetMs`
- `failedStageExecutionMs`
- `failedStageOverBudgetMs`
- `detail`
- `completedStages`
- `stageSummary`
- `observeError`
- `stdoutTail`
- `stderrTail`

This keeps the runner generic while still exposing enough signal for triage.

For suites that emit `HARNESS_META`, the runner also captures workflow-aware failure signals such as:

- `regressionCategory`: `routing`, `delivery`, `backend`, `memory`, `operations`, `interaction`, `timeout`, `over_budget`, `queue_delay`, `running_timeout`
- `failedStage`: workflow stage or check name such as `prd`, `qa`, `project-board`, `simple-routing`
- `detail`: the suite-provided failure message
- `stageSummary`: per-stage/check snapshot, including artifact count and deliverable contract hints when the suite provides them
- `failedStageBudgetMs / failedStageExecutionMs / failedStageOverBudgetMs`: stage-level SLO hints for long-running founder workflows

## Runtime Model

The harness does not duplicate workflow logic. It executes existing product paths:

- Feishu / control-center style inbound messages
- orchestrator routing
- task-runner execution
- workflow progression
- project board updates

That means harness failures reflect real product regressions, not synthetic mock-only failures.

## API Exposure

The orchestrator exposes harness results through:

- `GET /api/system/harness`
- `GET /api/system/harness/:suite/latest`
- `GET /api/system/harness/:suite/history?limit=50`

This lets the control-center and future CI jobs consume one shared source of truth. The control-center workbench now renders the latest suite cards directly from this API.

## Why It Matters

For VinkoClaw, harness quality is product quality.

If the harness cannot deterministically tell whether:

- a founder workflow really finished
- a multi-agent loop converged correctly
- a skill lifecycle remained usable

then the team cannot improve the product safely.

## Next Step

v1 should add:

- trace-level grading instead of process-level pass/fail only
- artifact validation summaries per workflow stage
- regression labeling (`routing`, `delivery`, `collaboration`, `skill`, `memory`)
- suite-trigger actions and CI upload hooks

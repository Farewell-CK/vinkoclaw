# GoalRun V1 Architecture

## Scope

GoalRun V1 adds a staged autonomous pipeline to VinkoClaw:

- `discover -> plan -> execute -> verify -> deploy -> accept`
- user input gate (`awaiting_input`)
- one-time authorization gate (`awaiting_authorization`)
- credential vault (encrypted at rest)
- timeline trace for each stage transition

This is an incremental layer on top of existing task orchestration.

## Data Model (shared/store)

New tables:

- `goal_runs`
- `goal_run_timeline_events`
- `goal_run_inputs`
- `run_auth_tokens`
- `credentials`

Key records:

- `GoalRunRecord`
- `GoalRunTimelineEventRecord`
- `GoalRunInputRecord`
- `RunAuthTokenRecord`
- `CredentialRecord`

## API Endpoints (orchestrator)

GoalRun:

- `POST /api/goal-runs`
- `GET /api/goal-runs`
- `GET /api/goal-runs/:goalRunId`
- `GET /api/goal-runs/:goalRunId/timeline`
- `POST /api/goal-runs/:goalRunId/input`
- `POST /api/goal-runs/:goalRunId/authorize`
- `POST /api/goal-runs/:goalRunId/cancel`

Credential Vault:

- `POST /api/credentials`
- `GET /api/credentials`
- `DELETE /api/credentials/:providerId/:credentialKey`

## Runner Behavior

`task-runner` now processes GoalRun stages in loop.

Execution mode:

- default: synthesized fast-path (non-blocking)
- optional real task execution: set `GOAL_RUN_EXECUTE_WITH_TASKS=1`

Soft timeout:

- `GOAL_RUN_EXEC_SOFT_TIMEOUT_MS` (default `45000`)
- when real task execution mode is enabled and execution task stalls, runner falls back to synthesized output.

## Security

Credential encryption:

- algorithm: `aes-256-gcm`
- key source priority:
  1. runtime secret `CREDENTIAL_MASTER_KEY`
  2. runtime setting `CREDENTIAL_MASTER_KEY`
  3. env `VINKO_CREDENTIAL_MASTER_KEY`
  4. development fallback key (for local/dev only)

One-time authorization:

- deploy stage can require token-based authorization
- token state tracked via `run_auth_tokens`
- token can be issued and consumed via `/authorize`

## Current Limitations

- deploy stage in V1 performs preflight checks and authorization flow; it does not execute cloud deployment commands directly.
- full deployment execution should be connected to plugin/tool providers in next iteration.
- synthesized execute mode is enabled by default for responsiveness and stability.

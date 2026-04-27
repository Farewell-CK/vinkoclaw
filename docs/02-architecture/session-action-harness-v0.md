# Session Action Harness v0

Session Action Harness is the operator-facing entrypoint for telling VinkoClaw to continue work inside an existing session while preserving harness evidence.

It exists to avoid treating the agent as a stateless chat endpoint. A session action is a structured command with:

- selected session context
- an action kind
- generated orchestration instruction
- audit events
- action-scoped timeline
- optional live SSE stream

## API Contract

### POST `/api/sessions/:sessionId/actions`

Request:

```json
{
  "action": "continue",
  "source": "control-center",
  "requestedBy": "owner"
}
```

Supported actions:

- `continue`: continue the current session goal from the latest workbench state.
- `supplement`: add user-provided information and continue the original work.
- `rerun-goalrun`: start a new GoalRun for the current session goal without repeating completed work.

Optional fields:

- `actionId`: client-provided idempotency or tracking id.
- `text`: supplemental text. Required by UI for `supplement`; optional for other actions.
- `chatId`, `attachments`: forwarded to inbound handling.

Response:

```json
{
  "actionId": "session_action_continue_session__abc123",
  "action": "continue",
  "result": {
    "type": "task_queued",
    "message": "queued",
    "taskId": "task_123"
  },
  "workbench": {},
  "timeline": {
    "sessionId": "session_123",
    "actionId": "session_action_continue_session__abc123",
    "events": []
  }
}
```

The orchestrator generates the actual inbound instruction server-side from the session workbench:

- current goal
- blockers
- next actions
- latest artifacts
- recent timeline evidence

This keeps routing and continuation policy inside the harness instead of the browser.

## Evidence Model

Each session action writes audit events with category `session-action`:

- `session_action_requested`
- `session_action_completed`
- `session_action_failed`

Audit payload includes:

- `sessionId`
- `action`
- `actionId`
- `clientActionId`
- `source`
- `requestedBy`
- `resultType`
- `taskId`
- `goalRunId`
- `approvalId`
- `operatorActionId`
- `generatedInstructionPreview`

## Timeline Contract

### GET `/api/sessions/:sessionId/timeline`

Query:

- `limit`: default `30`, max `200`
- `actionId`: optional action-scoped evidence filter

Without `actionId`, the timeline aggregates:

- session messages
- tasks
- GoalRuns
- approvals
- audit events

With `actionId`, the timeline returns the action evidence chain:

- request audit
- generated user/system messages with matching `clientActionId`
- completion or failure audit
- triggered task, GoalRun, approval, and operator action evidence when linked by audit payload

### GET `/api/sessions/:sessionId/timeline/stream`

SSE stream for the same timeline shape.

Query:

- `limit`
- `pollMs`
- `actionId`

Events:

- `ready`
- `snapshot`
- `heartbeat`

## Control Center Behavior

The session workbench exposes three buttons:

- Continue
- Supplement
- Rerun GoalRun

After submitting an action, Control Center switches the session timeline into the returned `actionId` filter. The operator can click an `action:<id>` pill to inspect one action evidence chain, or clear the filter to return to the full session timeline.

Global Activity Feed and Milestone Stream also surface `session-action` audit events, so an operator can see session actions outside the session detail panel.

## Design Rule

Do not call `/api/messages` directly for session continuation from product UI. Use `POST /api/sessions/:sessionId/actions`.

`/api/messages` remains the generic inbound channel. Session Action Harness is the structured, observable, resumable product entrypoint.

# Dynamic Project Memory v0

## Goal

Keep a session-level project memory that updates as the CEO gives new input, the team delivers artifacts, or collaboration pauses for more information.

## Memory Record

Each session now maintains `metadata.projectMemory` with:

- `currentGoal`
- `currentStage`
- `latestUserRequest`
- `latestSummary`
- `keyDecisions`
- `unresolvedQuestions`
- `nextActions`
- `latestArtifacts`
- `updatedAt`
- `updatedBy`
- `lastTaskId`

## Update Sources

The memory is updated from three points in the execution loop:

1. Inbound message intake
   The latest user request and current goal are refreshed when a new task, collaboration, or goal run is created.

2. Task completion / failure
   Direct replies, artifact tasks, and blocked tasks update the session memory with the latest summary, artifacts, and next actions.

3. Collaboration convergence
   When a collaboration reaches `deliver`, `partial`, `await_user`, or `blocked`, the parent task writes the new phase and pending questions back into session memory.

## Current Behavior

- Short greetings are not promoted into `currentGoal`.
- `await_user` clears stale next-stage assumptions and stores the pending questions.
- Resume messages move the memory stage to `resuming_collaboration`.
- Artifact-heavy tasks store the latest file list so the UI can show what the team has already produced.

## UI Exposure

The control center task detail view now shows the current session memory:

- current goal
- latest request
- latest summary
- unresolved questions
- next actions
- latest artifacts

The workbench also exposes a lightweight CEO project-memory board built from recent sessions so the operator can scan active goals without opening each task individually.

## Prompt Reuse

Task execution now injects the session `projectMemory` back into runtime snippets. This means PRD, research, and build tasks can reuse:

- the current goal
- the latest user request
- the latest summary
- open questions
- next actions
- recent artifacts

On top of the shared memory record, the task runner now derives a role-specific project brief. The same project state is rewritten differently for:

- `product / ceo / research`: decisions, open questions, priority actions
- `frontend / backend / developer / engineering`: implementation actions, existing artifacts, unresolved blockers
- `qa`: verification targets, testing gaps, next validation actions
- `uiux`: design direction, experience questions, next design actions

## Next Step

The next iteration should evolve this from session memory into project memory with:

- multiple projects per requester
- decision timeline
- stage-specific memory views
- automatic reuse in prompts for PRD, research, and build workflows

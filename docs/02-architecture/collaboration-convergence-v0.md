# Collaboration Convergence v0

## Goal

Make multi-agent collaboration stop at the right time and produce a structured merge result instead of endless parallel output.

## Current Rule Set

The collaboration manager now resolves an aggregation decision before final merge:

- `deliver`: all child tasks completed and collaboration can move to final delivery
- `partial`: some child tasks completed, but failures or time limits require a best-effort merge
- `await_user`: the team cannot safely continue without more user input
- `blocked`: no meaningful progress was produced and the collaboration is effectively blocked

It also tracks a broader collaboration phase set compatible with the existing system:

- `classify`
- `assignment`
- `execution`
- `discussion`
- `converge`
- `aggregation`
- `verify`
- `await_user`
- `completed`

## Trigger Reasons

The current implementation recognizes these stop reasons:

- `all_tasks_completed`
- `all_tasks_terminal_with_failures`
- `discussion_timeout`
- `aggregate_timeout`
- `max_rounds_reached`
- `manual_trigger`

## Merge Contract

When aggregation starts, the facilitator receives extra control context:

- aggregation mode
- trigger reason
- completed roles
- failed roles
- progress summary

The final aggregation prompt requires the result to include:

- outcome classification: `deliver / partial / await_user / blocked`
- key decisions
- risks
- unresolved questions
- actual deliverables from each role
- next actions in `owner / role / action` form
- explicit user input requirements when the system cannot continue automatically

## Why This Is v0

This version does not yet introduce a full collaboration state machine in persistence. It improves convergence with minimal changes by:

- reusing existing execution and aggregation phases
- adding explicit stop logic
- making final merge mode-aware
- syncing phase / convergence metadata back to the parent task so APIs and UI can inspect the collaboration state
- making parent-task handling mode-aware:
  - `deliver`: complete the parent task normally
  - `partial`: complete the parent task with partial output and explicit remaining gaps
  - `await_user`: stop automatic progress, extract up to 3 pending questions, and mark the parent task as waiting on user input
  - `blocked`: fail the parent task with a collaboration blockage reason

## Exposed Metadata

The parent task now carries collaboration metadata for downstream consumers:

- `collaborationPhase`
- `collaborationStatus`
- `collaborationConvergenceMode`
- `collaborationTriggerReason`
- `collaborationPendingQuestions`

## Next Step

The next iteration should promote this logic into a first-class state machine:

- `classify -> discuss -> converge -> execute -> verify -> deliver -> await_user`

That step should also persist convergence metadata, not only encode it in the aggregation prompt.

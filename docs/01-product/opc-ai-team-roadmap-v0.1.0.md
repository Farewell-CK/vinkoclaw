# VinkoClaw OPC AI Team Roadmap (0.0.1 -> 0.1.0)

## Product Positioning

VinkoClaw should be built as a personal entrepreneur's always-on AI execution team, not a multi-agent demo and not a PRD bot.

The target experience is:

- one person gives a goal in Feishu or the control center
- the system decides whether to answer, execute, split work, or ask for missing input
- the team produces real deliverables: plans, docs, code, reports, files, follow-ups
- the system keeps project context, tracks progress, and knows when to stop or escalate

## Capability Map

### 1. Assistant OS

- inbox triage, to-do capture, reminders, follow-ups, summaries
- meeting notes, daily/weekly recap, personal task tracking

### 2. Research OS

- search, compare, summarize, evaluate competitors and opportunities
- produce structured reports with conclusions and cited sources

### 3. Builder OS

- write PRDs, specs, code, tests, scripts, landing pages, internal tools
- run, verify, and revise outputs instead of stopping at suggestions

### 4. Delivery OS

- generate Markdown, DOCX/PDF, spreadsheets, slide outlines, runnable code, packaged artifacts
- store outputs in stable locations and return them as deliverables

### 5. Team OS

- route work to the right role set
- run multi-agent collaboration only when needed
- stop discussion when it stops adding value
- aggregate outcomes into decisions, tasks, or deliverables

## Current 0.0.1 Assessment

### What already exists

- orchestrator, task runner, session/task/approval/audit model
- Feishu and control-center entrypoints
- role-based prompts and task routing
- external model API support
- plugin and tool execution framework
- basic collaboration timeline and queueing

### What is not yet product-ready

- conversation quality is brittle; many short inputs fall into rigid fallback replies
- document and file delivery is unreliable; "produce a file" is not a stable path
- PRD/report quality is inconsistent and too dependent on one-shot prompting
- multi-agent collaboration lacks strong stop/merge/escalation rules
- project memory is weak; long-running startup context is not reliably preserved
- user perception of role differences is weak; the team often feels like one model with labels

## Version Goals

## 0.0.2 Conversation And Routing

Goal: stop feeling dumb in the first three turns.

- narrow mechanical smalltalk/direct-conversation fallbacks
- let short but meaningful questions produce differentiated answers
- improve "chat vs task vs config vs collaboration" routing
- make role voice and response intent more distinct

Acceptance:

- Feishu smoke tests no longer produce repeated generic replies for distinct short questions
- at least 10 common short-message cases route to expected behavior

## 0.0.3 Deliverable Output

Goal: reliably produce useful artifacts.

- add a first-class document output pipeline
- support stable Markdown delivery first, then DOCX/PDF export
- add explicit "deliverable contract" to tasks: text-only vs file-required
- persist generated artifacts and expose them in task/session history

Acceptance:

- PRD, report, and one-page brief tasks can generate Markdown files reliably
- file-producing tasks return saved artifact paths, not only prose

## 0.0.4 Collaboration Control

Goal: make multi-agent collaboration converge instead of rambling.

- add collaboration state machine: `classify -> discuss -> converge -> execute -> verify -> deliver -> await_user`
- add stop conditions: no new information, clear owner assignment, waiting on user input, max rounds reached
- add merge schema: conclusions, open questions, owners, next actions, confidence

Acceptance:

- collaboration runs stop with a structured merge result
- repeated low-value discussion is cut off automatically

## 0.0.5 Project Memory

Goal: remember the startup, not just the turn.

- introduce project-level context: product, user, market, constraints, current stage
- persist decisions, assumptions, unresolved questions, and active goals
- reuse this context in PRD, code, and research tasks

Acceptance:

- a second-round task inherits prior project context without the user re-explaining it
- project summaries remain consistent across multiple sessions

## 0.1.0 Personal Entrepreneur Usable

Goal: one founder can run meaningful weekly work through VinkoClaw.

- task intake, planning, delivery, progress, and follow-up form one coherent loop
- the user can get docs, code, summaries, and execution support from the same system
- Feishu feels like a real command surface, not a webhook demo

Acceptance:

- complete one founder workflow end to end: idea -> PRD -> build task -> deliverable -> recap
- complete one operations workflow end to end: research -> summary -> follow-up content -> reminder

## Priority Fixes

### P0

- stable Markdown deliverables
- explicit artifact generation pipeline
- better short-turn conversation handling
- collaboration stop/merge logic

### P1

- DOCX/PDF export
- project memory model
- stronger role differentiation
- recurring reminders and follow-up workflows

### P2

- richer operator dashboard for project health
- more structured business workflows: CRM, calendar, outbound

## Engineering Translation

- `services/orchestrator`: conversation routing, collaboration state transitions, deliverable contracts
- `services/task-runner`: collaboration convergence, verification, artifact-aware execution loop
- `packages/agent-runtime`: stronger output schemas, retry/repair for deliverable tasks, model-side role shaping
- `packages/shared`: project memory model, structured collaboration summaries, reminder/task metadata
- `apps/control-center`: artifact visibility, session/project context, collaboration state UI

## What We Should Not Do Yet

- do not add more roles before the current roles feel real
- do not add more channels before Feishu and control-center are stable
- do not over-invest in complex autonomy before deliverable quality is dependable

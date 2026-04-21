# VinkoClaw OPC AI Team Roadmap (0.1.x -> 0.2.0)

## Product Goal

Build VinkoClaw into a personal entrepreneur's AI execution team:

- the user acts as CEO
- the system takes goals, not just prompts
- the team routes, executes, delivers, verifies, and follows up
- project context and skill state remain usable across sessions

`0.2.0` is the first target where the product should feel like a dependable operating layer for a solo founder, not a capable demo.

## Current Baseline

By the end of `0.1.x`, VinkoClaw already has:

- Feishu and control-center as usable command surfaces
- task, approval, session, audit, and collaboration primitives
- dynamic project memory and role-aware memory injection
- artifact contracts for PRD/report/code-style outputs
- skill marketplace search, install, integration, verify, and verification status

What is still missing is workflow reliability at the product level.

## Shipped Toward 0.2.0

The following roadmap slices are already in place:

- CEO project board API and control-center overview
- dynamic project memory injected into role execution
- skill lifecycle loop: discover, integrate, install, verify
- verification-aware skill badges and role-aware marketplace state
- install suggestions from completed skill integration tasks
- collaboration `await_user -> resume -> deliver` visibility and recovery

## 0.1.x Completion Focus

Before calling `0.2.0`, finish 3 trust-critical loops:

### 1. Founder Delivery Loop

`idea -> PRD -> implementation split -> code delivery -> recap`

Acceptance:

- one task can pass through this chain without manual re-explaining
- each stage produces a visible artifact or structured result
- blocked or partial states are explicit

### 2. Skill Lifecycle Loop

`discover -> integrate -> install -> verify -> recommend`

Acceptance:

- skill cards show `discover_only / local_installable / installed_unverified / installed_verified / verify_failed`
- verified skills are preferred in recommendations
- failed skills are visible and not silently reused

### 3. Collaboration Loop

`classify -> execute -> converge -> await_user -> resume -> deliver`

Acceptance:

- waiting-for-input tasks are easy to resume
- convergence reasons and pending questions stay visible
- resumed collaboration continues the same task chain

## 0.2.0 Product Goals

### 1. CEO Project Board

Create a real CEO-facing project board, not just task lists.

Must show:

- current goal
- current stage
- key decisions
- blockers
- next actions
- team skill readiness

Acceptance:

- a founder can understand project state in one screen
- no need to inspect raw tasks to know what is stuck

### 2. Workflow Reliability

Promote the most common founder workflows to first-class product flows:

- PRD and spec generation
- research and competitor analysis
- implementation and verification
- weekly recap and follow-up planning

Acceptance:

- each workflow has a default template, deliverable contract, and success criteria
- each workflow can end in `deliver / partial / await_user / blocked`

### 3. Skill Recommendation Layer

Skills should become a usable capability layer, not just installable metadata.

Need:

- role-aware recommendation ranking
- verification-aware ranking
- install suggestions from completed integration tasks
- visible verification debt for unverified skills

Acceptance:

- verified skills rank above unverified ones
- failed verification lowers recommendation priority

### 4. Team Execution Quality

Strengthen role realism and result ownership.

Need:

- stronger role-specific output rules
- clearer owner and follow-up behavior
- better distinction between planning, execution, and verification roles

Acceptance:

- product, research, engineering, and QA outputs look materially different
- multi-role work feels coordinated, not relabeled single-model output

## P0 / P1 / P2

### P0

- CEO project board
- verified-skill-aware marketplace ranking
- end-to-end founder delivery loop smoke test
- collaboration resume quality pass

Current status:

- Done: CEO project board
- Done: verified-skill-aware marketplace ranking
- Done: collaboration resume quality pass
- Remaining: end-to-end founder delivery loop smoke test

### P1

- recurring founder operations flows: recap, reminders, follow-up
- richer artifact export beyond Markdown-first path
- skill verification history and retry actions

### P2

- multi-project board
- CRM / outreach / customer-loop workflows
- richer external plugin or remote skill package install

## Engineering Translation

- `apps/control-center`
  - CEO project board
  - marketplace ranking and verification UI
  - workflow entry shortcuts

- `services/orchestrator`
  - workflow-level routing
  - skill recommendation ranking
  - post-install verification orchestration

- `services/task-runner`
  - verification-aware task completion
  - stronger role execution contracts
  - workflow outcome normalization

- `packages/shared`
  - skill lifecycle state
  - project board data shape
  - workflow template metadata

## Exit Criteria For 0.2.0

VinkoClaw reaches `0.2.0` when all of the following are true:

- a founder can run one product workflow end to end in Feishu or control-center
- verified skills are clearly preferred and reusable
- project state is understandable without reading raw logs or task internals
- collaboration no longer feels like agents talking forever without closure

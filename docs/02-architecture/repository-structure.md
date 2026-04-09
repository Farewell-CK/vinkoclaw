# Repository Structure v0.1

## Top-Level Layout

```text
vinkoclaw/
├── README.md
├── docs/
│   ├── 01-product/
│   ├── 02-architecture/
│   ├── 03-research/
│   └── 04-delivery/
├── apps/
│   ├── feishu-gateway/
│   └── control-center/
├── services/
│   ├── orchestrator/
│   ├── task-runner/
│   └── email-inbound/
├── packages/
│   ├── agent-runtime/
│   ├── knowledge-base/
│   ├── protocol/
│   ├── plugin-sdk/
│   ├── plugins/
│   └── shared/
├── prompts/
│   └── roles/
├── config/
└── scripts/
```

## Why This Structure

### `docs/`

All product, architecture, research, and hackathon delivery documents live here.

### `apps/`

User-facing entrypoints:

- `feishu-gateway/`: Feishu bot ingress and outbound message formatting
- `control-center/`: Local owner-facing dashboard or web UI

### `services/`

Long-running processes:

- `orchestrator/`: role routing, task creation, approvals, status
- `task-runner/`: background execution, scheduling, long jobs
- `email-inbound/`: IMAP polling, sender/subject filtering, dedupe/rate-limit, email command ingestion

### `packages/`

Reusable shared code:

- `agent-runtime/`: role sessions, prompts, execution rules
- `knowledge-base/`: indexing, retrieval, and local document/code understanding
- `protocol/`: API schemas and shared protocol contracts
- `plugin-sdk/`: plugin lifecycle/event contracts
- `plugins/`: bundled runtime plugins
- `shared/`: common types, logging, utils, contracts
  - includes tool execution policy/runtime helpers (`tool-exec.ts`)
  - includes collaboration persistence, agent instances, operator action parsing/execution

### `prompts/roles/`

System prompts and role definitions for CEO/CTO/PM/UIUX/Frontend/Backend/Algorithm/QA/Developer plus legacy roles.

### `config/`

Configuration templates for development and deployment.

### `scripts/`

Developer tooling, startup scripts, and deployment helpers.

## Document Placement Rules

- Product definition goes into `docs/01-product/`
- System and repository design goes into `docs/02-architecture/`
- Reference learning notes go into `docs/03-research/`
- Submission assets and demo materials go into `docs/04-delivery/`

Do not put long-form planning notes in random source directories.

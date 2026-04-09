# Services

This folder contains long-running backend services.

- `orchestrator/`: role routing, approvals, and task graph control
- `task-runner/`: background execution and long-running jobs
- `email-inbound/`: IMAP inbound listener (email -> command -> orchestrator `/api/messages`)

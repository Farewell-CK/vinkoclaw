# Delivery TODO

## Completed (2026-03-31)

- [x] Re-run thinking-enabled inference verification against `http://127.0.0.1:8000/v1` after container `qwen35-fp8` is in `Up` status.
- [x] Validate two-stage runtime path:
  - Stage 1: thinking enabled (`chat_template_kwargs.enable_thinking=true`)
  - Stage 2: finalize to assistant `content` when first response has only reasoning.
- [x] Re-run e2e task test through `/api/tasks` and confirm no deterministic fallback marker in `result.deliverable`.
- [x] Add multimodal e2e tests (image + video attachments) through orchestrator and task-runner.
- [x] Append verification evidence (timestamps, request params, task id, output excerpt) to the latest test report.

## Next

- [ ] Add optional reasoning observability mode:
  - Persist thinking-stage metadata (length/hash/latency) without storing sensitive full chain-of-thought by default.
  - Expose a debug-only switch for local trusted demos.
- [ ] Harden runtime JSON schema validation for `citations` / `followUps` to avoid model drift affecting structure.
- [x] Add queue throughput metrics in dashboard:
  - queue depth, avg wait time, avg runtime by role/template
  - alert when long-running tasks block high-priority items.
- [x] Add template import/export capability for routing templates (JSON file level).

## Next (Updated)

- [x] Add queue alert thresholds (SLA policy):
  - configurable warning/critical thresholds for queued wait time.
- [x] Add one-click “pause template” action in Feishu command parsing.
- [x] Add developer tool execution pipeline:
  - `tool_runs` persistence
  - provider availability API
  - risk-based approval for `task_execution`
  - approval-to-requeue lifecycle
- [x] Improve opencode runnable detection/bootstrap:
  - executable is now resolved from PATH (`/home/xsuper/.npm-global/bin/opencode`)
  - provider readiness + key status exposed via `/api/tool-providers`
- [x] Add channel readiness visibility:
  - `/api/channels/status` returns missing env keys for Feishu / Email
  - control-center now renders `Channel Readiness` panel for demo

## Next Sprint (V3+)

- [ ] Add optional reasoning observability metadata (hash/latency/length, no raw CoT by default)
- [ ] Add strict runtime output schema guard + repair for `reflection` fields
- [ ] Add real Feishu webhook + SMTP E2E tests with production-like env
- [ ] Add stale approval/tool-run cleanup utility for demo reset

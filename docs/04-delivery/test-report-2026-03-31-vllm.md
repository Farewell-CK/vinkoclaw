# VinkoClaw Test Report (vLLM Integration)

## 1. Test Window

- Start: `2026-03-31 08:49:21 UTC`
- End: `2026-03-31 08:59:23 UTC`
- Operator: Codex CLI
- Scope: vLLM FP8 integration + VinkoClaw runtime regression

## 2. Environment

- Host: DGX Spark local machine
- vLLM endpoint: `http://127.0.0.1:8000/v1`
- Served model: `Qwen3.5-35B-A3B`
- VinkoClaw endpoint: `http://127.0.0.1:3280`
- Data directory: `/home/xsuper/workspace/vinkoclaw/.data`

## 3. Effective Config

Files used:

- `/home/xsuper/workspace/vinkoclaw/.env`
- `/home/xsuper/workspace/vinkoclaw/config/.env`

Key parameters:

- `PRIMARY_BACKEND=sglang` (compatibility label; actual endpoint points to vLLM)
- `SGLANG_BASE_URL=http://127.0.0.1:8000/v1`
- `SGLANG_MODEL=Qwen3.5-35B-A3B`
- `OLLAMA_BASE_URL=http://127.0.0.1:11434/v1`

## 4. Issues Found During Test

### Issue A: Runtime fallback despite vLLM online

- Symptom: task result showed `Model backend was unavailable, so this response is a deterministic fallback.`
- Root cause 1: env load priority let `config/.env` override root `.env`, model name resolved to `qwen3.5-coder-14b` (not served by current vLLM).
- Root cause 2: vLLM response for this model returned `reasoning` path unless request included chat template control; runtime only read `content`.

### Fix Applied

1. `packages/shared/src/env.ts`
- Changed merge priority to: `config/.env` < root `.env` < `process.env`.

2. `config/.env`
- Updated:
  - `PRIMARY_MODEL=Qwen3.5-35B-A3B`
  - `SGLANG_MODEL=Qwen3.5-35B-A3B`

3. `packages/agent-runtime/src/index.ts`
- Added request payload support:
  - `max_tokens: 1024`
  - `chat_template_kwargs: { enable_thinking: false }` for local vLLM `:8000` + `Qwen3.5-35B-A3B`
- Added response fallback parsing from `message.reasoning` when `message.content` is empty.

## 5. Test Cases And Results

### T1. vLLM model list

- Command: `curl http://127.0.0.1:8000/v1/models`
- Expected: model list contains `Qwen3.5-35B-A3B`
- Result: PASS

### T2. vLLM chat completion (thinking disabled)

- Command:
  - `curl http://127.0.0.1:8000/v1/chat/completions ... "chat_template_kwargs":{"enable_thinking":false}`
- Expected: assistant `content` present
- Result: PASS (`content: "VLLM_OK"`)

### T3. VinkoClaw health

- Command: `curl http://127.0.0.1:3280/health`
- Expected: `ok: true`
- Result: PASS

### T4. Agent runtime direct execution

- Method: `npx tsx` one-shot invoking `AgentRuntime.execute`
- Expected: backend uses primary endpoint and returns non-fallback content
- Result: PASS
- Observed:
  - `backend: "sglang"` (runtime backend label)
  - `model: "Qwen3.5-35B-A3B"`
  - deliverable: `VLLM_OK`

### T5. Full e2e task via orchestrator + runner

- Create task:
  - `POST /api/tasks`
  - task id: `b1ab338d-9455-4893-95ff-ab5aa079605d`
  - instruction: `请只返回四个字符：PASS`
- Expected:
  - task completes
  - result not marked as backend unavailable fallback
- Result: PASS
- Observed:
  - `status: completed`
  - `deliverable: PASS`
  - no `Model backend was unavailable` marker in result

### T6. Code regression

- Command: `npm run typecheck`
- Expected: no TS errors
- Result: PASS

- Command: `npm test`
- Expected: tests pass
- Result: PASS (`2 files`, `4 tests`)

## 6. Final Status

- vLLM FP8 model service is reachable and usable by VinkoClaw.
- VinkoClaw task chain now returns model outputs instead of deterministic fallback for tested cases.
- Integration and regression checks passed under current configuration.

## 7. Follow-up Note (2026-03-31)

- During later verification, `docker ps` showed no running containers and `qwen35-fp8` in `Created` state.
- Because vLLM endpoint `127.0.0.1:8000` was unavailable at that moment, thinking-enabled retest is deferred.
- Pending items were moved to `docs/04-delivery/todo.md` and will be executed after vLLM is started.

## 8. Retest After vLLM Recovery (Thinking + Multimodal)

### 8.1 Test Window

- Start: `2026-03-31 09:19:55 UTC`
- End: `2026-03-31 09:34:08 UTC`
- Operator: Codex CLI
- Scope:
  - Thinking-enabled content recovery (reasoning -> finalize -> content)
  - Image/video multimodal request path in vLLM
  - VinkoClaw e2e task execution with `attachments`

### 8.2 Runtime/Service Status

- `docker ps`:
  - `qwen35-fp8` -> `Up`
- `GET http://127.0.0.1:8000/v1/models`:
  - served model includes `Qwen3.5-35B-A3B`
- `GET http://127.0.0.1:3280/health`:
  - `ok: true`

### 8.3 Code Updates Validated In This Retest

1. `packages/agent-runtime/src/index.ts`
- `enable_thinking: true` first pass for vLLM `Qwen3.5-35B-A3B`
- if `content` is empty and `reasoning` exists, execute finalize pass with `enable_thinking: false`
- add multimodal user message blocks (`text`, `image_url`, `video_url`) from task metadata attachments

2. `services/orchestrator/src/server.ts`
- `/api/tasks` supports top-level `attachments` and merges into `metadata.attachments`
- `/api/messages` supports optional `attachments` passthrough

3. `apps/control-center/public/index.html` + `app.js`
- add image/video URL input fields
- submit attachments to `/api/tasks`
- render attachment count in task list

4. `packages/shared/src/types.ts`
- add `TaskAttachment` and `TaskMetadata` types

### 8.4 Retest Cases And Results

#### RT1. vLLM thinking response shape

- Request params:
  - `chat_template_kwargs.enable_thinking=true`
  - prompt: `请只回答两个字符：OK`
- Observed:
  - `message.content = null`
  - `message.reasoning` returned
- Result: PASS (expected shape for two-stage runtime handling)

#### RT2. vLLM image request (multimodal)

- Request params:
  - content blocks: `text + image_url`
  - image via data URI (1x1 png)
  - `chat_template_kwargs.enable_thinking=false`
- Observed response:
  - `content`: `这是一张纯白色的图片，没有任何内容。`
- Result: PASS

#### RT3. vLLM video request (multimodal)

- Request params:
  - content blocks: `text + video_url`
  - video: `Big_Buck_Bunny_720_10s_1MB.mp4`
  - `chat_template_kwargs.enable_thinking=false`
- Observed response:
  - `content`: forest scene summary
- Result: PASS

#### RT4. AgentRuntime direct thinking-to-content recovery

- Method: `npx tsx --eval` invoking `AgentRuntime.execute`
- Input: text-only task requiring `deliverable=OK`
- Observed:
  - `backend="sglang"`
  - `model="Qwen3.5-35B-A3B"`
  - parsed deliverable: `OK`
- Result: PASS

#### RT5. AgentRuntime direct multimodal image

- Method: `npx tsx --eval` with `task.metadata.attachments=[{kind:\"image\",url:data-uri}]`
- Observed:
  - `backend="sglang"`
  - `deliverable`: `A 1x1 pixel transparent PNG image.`
- Result: PASS

#### RT6. AgentRuntime direct multimodal video

- Method: `npx tsx --eval` with `task.metadata.attachments=[{kind:\"video\",url:...mp4}]`
- Observed:
  - `backend="sglang"`
  - `deliverable`: one-sentence video description
- Result: PASS

#### RT7. Orchestrator + task-runner e2e text task

- Task ID: `6f392693-f394-4da2-9383-651deca14694`
- Timeline:
  - created: `2026-03-31T09:31:58.804Z`
  - completed: `2026-03-31T09:32:23.951Z`
- Output:
  - `status: completed`
  - `result.deliverable: PASS`
- Result: PASS

#### RT8. Orchestrator + task-runner e2e image task (attachments)

- Task ID: `7c1f874e-8829-4491-a9cd-faa91ddc1c60`
- Timeline:
  - created: `2026-03-31T09:32:59.403Z`
  - completed: `2026-03-31T09:33:25.381Z`
- Output:
  - `metadata.attachments` persisted
  - `status: completed`
  - `deliverable`: `The image is a 1x1 pixel transparent placeholder.`
- Result: PASS

#### RT9. Orchestrator + task-runner e2e video task (attachments)

- Task ID: `256cdd11-5b88-4114-a29b-65eecac5d6b3`
- Timeline:
  - created: `2026-03-31T09:33:46.155Z`
  - completed: `2026-03-31T09:34:08.026Z`
- Output:
  - `metadata.attachments` persisted
  - `status: completed`
  - `deliverable`: one-sentence video summary
- Result: PASS

#### RT10. Regression checks

- `npm run typecheck`: PASS
- `npm test`: PASS (`2 files`, `4 tests`)

### 8.5 Notes / Known Limits

- Some public image URLs may timeout when fetched by backend runtime (`curl --max-time 45` timed out once); data URI/local-accessible URLs are stable for validation runs.
- Model occasionally emits non-schema fields in JSON (`citations` shape can drift). Runtime currently only guarantees core keys; stronger schema validation can be added next.

## 9. Retest (Role Refinement + Routing Template CRUD)

### 9.1 Test Window

- Start: `2026-03-31 10:03:35 UTC`
- End: `2026-03-31 10:13:49 UTC`
- Scope:
  - role refinement for internet-company team structure
  - routing template CRUD and template-based fan-out
  - runtime response normalization for non-string deliverable outputs

### 9.2 Build Validation

- `npm run typecheck`: PASS
- `npm test`: PASS (`3 files`, `6 tests`)
  - includes new role resolution tests
  - includes routing template CRUD tests

### 9.3 Runtime/API Validation

#### R1. Refined roles loaded

- `GET /api/roles` returns new role set:
  - `product`, `uiux`, `frontend`, `backend`, `algorithm`, `qa`
- Existing roles (`engineering`, `research`) remain for compatibility.
- Result: PASS

#### R2. Default routing template availability

- `GET /api/routing-templates` contains:
  - `tpl-opc-internet-launch`
  - 6 subtasks (PM/UIUX/Frontend/Backend/Algorithm/QA)
- Result: PASS

#### R3. Routing template CRUD

1. Create
- `POST /api/routing-templates`
- created id: `c7e01afe-f6be-4c0f-860a-df7567dd4065`
- Result: PASS

2. Update
- `PUT /api/routing-templates/c7e01afe-f6be-4c0f-860a-df7567dd4065`
- updated fields: `name`, `enabled=false`
- Result: PASS

3. Delete
- `DELETE /api/routing-templates/c7e01afe-f6be-4c0f-860a-df7567dd4065`
- response code: `204`
- Result: PASS

#### R4. Template-based fan-out execution

- Request:
  - `POST /api/messages`
  - text: `团队执行：做一个带登录和仪表盘的SaaS MVP`
- Response:
  - `type=template_tasks_queued`
  - `templateId=tpl-opc-internet-launch`
  - `taskIds` count = 6
- Result: PASS

#### R5. Deliverable normalization hardening

- Method: direct `AgentRuntime.execute` (`npx tsx --eval`)
- Prompt intentionally asks model to output object-style deliverable.
- Observed:
  - `typeof output.result.deliverable === "string"`
  - `citations` normalized to `{path, excerpt}` shape
- Result: PASS

### 9.4 Notes

- During this retest window, queue throughput can fluctuate when several long-running multimodal/template tasks accumulate.
- This does not block CRUD or routing fan-out correctness, but full queue-drain timing should be measured separately for validation SLA.

## 10. Retest (Template Import/Export + Queue Throughput Panel)

### 10.1 Test Window

- Start: `2026-03-31 12:15:54 UTC`
- End: `2026-03-31 12:17:20 UTC`
- Scope:
  - routing template import/export endpoint validation
  - dashboard queue throughput metrics validation
  - control-center integration readiness for new APIs

### 10.2 Build Validation

- `npm run typecheck`: PASS
- `npm test`: PASS (`3 files`, `7 tests`)
  - includes queue-metrics and template-import coverage in `store.test.ts`

### 10.3 API Validation

#### T10-1. Export templates

- Endpoint: `GET /api/routing-templates/export`
- Observed: response contains
  - `version: 1`
  - `exportedAt`
  - `templates[]`
- Result: PASS

#### T10-2. Import templates (merge mode)

- Endpoint: `POST /api/routing-templates/import`
- Payload mode: `merge`
- Import template id used for test: `tpl-import-smoke`
- Observed:
  - response `ok: true`
  - template count increased to 2
  - `GET /api/routing-templates` contains `tpl-import-smoke`
- Result: PASS

#### T10-3. Cleanup delete

- Endpoint: `DELETE /api/routing-templates/tpl-import-smoke`
- Observed: HTTP `204`
- Post-check: `GET /api/routing-templates` reverted to default template only
- Result: PASS

#### T10-4. Queue metrics in dashboard snapshot

- Endpoint: `GET /api/dashboard`
- Observed payload includes:
  - `queueMetrics.queuedCount`
  - `queueMetrics.runningCount`
  - `queueMetrics.completedCountLast24h`
  - `queueMetrics.avgWaitMsLast24h`
  - `queueMetrics.avgRunMsLast24h`
  - `queueMetrics.byRole[]`
  - `queueMetrics.byTemplate[]`
- Result: PASS

### 10.4 Runtime Hardening Validation

- Direct runtime check (`npx tsx --eval`) confirms:
  - object-type model `deliverable` is normalized to string
  - citations normalized to `{path, excerpt}`
- Result: PASS

## 11. Retest (Queue SLA Alerts + Template Pause/Enable Command)

### 11.1 Test Window

- Start: `2026-03-31 12:31:59 UTC`
- End: `2026-03-31 12:33:35 UTC`
- Scope:
  - queue SLA threshold configuration API
  - queue alert state computation in dashboard snapshot
  - one-click template pause/enable command parsing via `/api/messages`

### 11.2 Build Validation

- `npm run typecheck`: PASS
- `npm test`: PASS (`4 files`, `12 tests`)
  - includes `inbound-commands.test.ts` (template pause/enable parser)
  - includes queue SLA alert coverage in `store.test.ts`
- `node --check apps/control-center/public/app.js`: PASS

### 11.3 API Validation

#### T11-1. Template pause command

- Request:
  - `POST /api/messages`
  - body: `{"text":"暂停模板 tpl-opc-internet-launch","source":"control-center","requestedBy":"owner"}`
- Response:
  - `type: template_updated`
  - `enabled: false`
- Result: PASS

#### T11-2. Queue SLA update API

- Request:
  - `PUT /api/config/queue-sla`
  - body: `{"warningWaitMs":1000,"criticalWaitMs":2000}`
- Response:
  - `ok: true`
  - `queue.sla.warningWaitMs: 1000`
  - `queue.sla.criticalWaitMs: 2000`
- Result: PASS

#### T11-3. Queue alert triggered by backlog

- Setup:
  - queued 5 test tasks (`SLA backlog test 1..5`) via `POST /api/tasks`
- Verification (`GET /api/dashboard`):
  - `queueMetrics.queuedCount: 4`
  - `queueMetrics.oldestQueuedWaitMs: 25827`
  - `queueMetrics.alertLevel: "critical"`
  - `queueMetrics.alerts[0].criticalWaitMs: 2000`
- Result: PASS

#### T11-4. Template enable command

- Request:
  - `POST /api/messages`
  - body: `{"text":"启用模板 tpl-opc-internet-launch","source":"feishu","requestedBy":"ou_test_owner"}`
- Response:
  - `type: template_updated`
  - `enabled: true`
- Post-check:
  - `GET /api/routing-templates` for `tpl-opc-internet-launch` returns `enabled: true`
- Result: PASS

#### T11-5. Restore production-like defaults

- Request:
  - `PUT /api/config/queue-sla`
  - body: `{"warningWaitMs":300000,"criticalWaitMs":900000}`
- Response:
  - `ok: true`
  - default SLA thresholds restored
- Result: PASS

## 12. Retest (Developer Tool Execution + Approval Loop)

### 12.1 Test Window

- Start: `2026-03-31 13:47:20 UTC`
- End: `2026-03-31 13:59:40 UTC`
- Scope:
  - `tool_runs` state persistence
  - provider availability API
  - high-risk `task_execution` approval flow
  - low-risk CTO auto-approved developer execution path

### 12.2 Build Validation

- `npm run typecheck`: PASS
- `npm test`: PASS (`4 files`, `13 tests`)
  - added developer role resolution coverage
  - added tool run lifecycle + task execution approval coverage in `store.test.ts`

### 12.3 API Validation

#### T12-1. Provider discovery API

- Request: `GET /api/tool-providers`
- Observed:
  - `opencode.available=false` (source checkout exists but binary not installed in PATH)
  - `codex.available=true`
  - `claude.available=true`
  - returned active tool policy (`providerOrder`, `timeoutMs`, `approvalMode`)
- Result: PASS

#### T12-2. High-risk developer task enters approval gate

- Task:
  - `POST /api/tasks`
  - id: `e722a3a9-fa87-40ef-91db-8711d790280d`
  - role: `developer`
  - instruction includes `production` + `deploy`
- Observed:
  - task state -> `waiting_approval`
  - approval created:
    - id: `9049f8f8-713e-4770-b6ee-1f1c725fa17c`
    - kind: `task_execution`
  - tool run created:
    - id: `ff65db4c-17ce-4332-a9c4-1afe32315f96`
    - provider: `codex`
    - state: `approval_pending`
- Result: PASS

#### T12-3. Approval decision requeues tool run and task

- Request:
  - `POST /api/approvals/9049f8f8-713e-4770-b6ee-1f1c725fa17c/decision`
  - body: `{"status":"approved","decidedBy":"owner"}`
- Observed:
  - approval -> `approved`
  - related tool run -> `queued`, `approvalStatus=approved`
  - task -> `queued` then claimed by runner
- Result: PASS

#### T12-4. Low-risk developer task auto-approved by CTO

- Task:
  - id: `05e39634-3fe8-43e9-a485-65b26041dfaa`
  - instruction: read README and summarize in one sentence
- Observed:
  - tool run provider: `codex`
  - `approvalStatus=auto_approved`
  - `approvedBy=cto`
  - task completed with summarized deliverable text
- Result: PASS

### 12.4 Notes

- `tmp/opencode` source is now used as integration reference (CLI arguments, event format), but runtime execution is gated by actual binary availability in PATH.
- A legacy historical task (`503e58d4-...`) remains in pending approval state from earlier manual runs; this does not affect current pipeline correctness.

## 13. Retest (V3 Channel Readiness + Opencode GLM-5 + Email Failure Observability)

### 13.1 Test Window

- Start: `2026-03-31 16:35:43 UTC`
- End: `2026-03-31 16:41:39 UTC`
- Scope:
  - control-center channel/provider readiness panel integration
  - opencode `zhipuai/glm-5` execution path verification
  - send-email approval failure behavior (missing SMTP) and audit visibility

### 13.2 Build Validation

- `npm run typecheck`: PASS
- `npm test`: PASS (`5 files`, `17 tests`)
  - includes newly added send-email parser coverage in `operator-actions.test.ts`
- `node --check apps/control-center/public/app.js`: PASS

### 13.3 API / Runtime Validation

#### T13-1. vLLM availability and thinking behavior

- `GET http://127.0.0.1:8000/v1/models` includes `Qwen3.5-35B-A3B`
- `POST /v1/chat/completions` with `enable_thinking=true`:
  - observed `content=null`, `reasoning` present
- same prompt with `enable_thinking=false`:
  - observed `content="OK"`
- Result: PASS

#### T13-2. Tool provider readiness

- Endpoint: `GET /api/tool-providers`
- Observed:
  - `opencode.available=true`
  - `opencode.keyConfigured=true`
  - active policy includes `providerOrder=["opencode","codex","claude"]`
- Result: PASS

#### T13-3. Channel readiness status API

- Endpoint: `GET /api/channels/status`
- Observed:
  - Feishu missing: `FEISHU_APP_ID`, `FEISHU_APP_SECRET`, `FEISHU_VERIFICATION_TOKEN`
  - Email missing: `SMTP_URL`, `EMAIL_DEFAULT_FROM`
- Result: PASS

#### T13-4. Opencode + GLM-5 e2e task execution

- Create task:
  - `POST /api/tasks`
  - task id: `fbd99f2f-1b21-4cfe-9ac9-2bf040d731e6`
  - role: `developer`
  - instruction: verify README exists and return `OK`
- Observed:
  - task status: `completed`
  - result deliverable: `OK`
  - tool run id: `e237ec5d-2db6-42b0-86c3-21375d77adc6`
  - tool args include `--model zhipuai/glm-5`
  - tool run status: `completed`, `approvalStatus=auto_approved`, `approvedBy=cto`
- Result: PASS

#### T13-5. Email approval failure semantics (SMTP missing)

- Create action:
  - `POST /api/messages` with `发邮件给 qa@example.com 冒烟测试已完成`
  - approval id: `005a3c13-ceea-4f14-8536-656fbd6c705a`
- Approve action:
  - `POST /api/approvals/005a3c13-ceea-4f14-8536-656fbd6c705a/decision`
  - response code: `502`
  - body: `error="email_send_failed"`, `message="SMTP is not configured"`
- Post-check:
  - `/api/operator-actions` shows this action as `status="rejected"`
  - `/api/dashboard` audit includes `Approved email action failed to send`
- Result: PASS

### 13.4 Frontend Integration Check

- control-center added `Channel Readiness` panel:
  - channel status cards (Feishu/Email configured + missing env)
  - tool policy/provider cards (availability, key status, binary path)
- API fallback handling:
  - if `/api/channels/status` or `/api/tool-providers` unavailable, UI renders explicit “unavailable” hint
- Result: PASS

### 13.5 Conclusion

- V3 delivery objective for observability + execution stability is met:
  - local vLLM inference chain healthy
  - opencode `glm-5` route is executable and verifiable
  - Feishu/Email readiness is now visible and auditable

## 14. Retest (Generalized Intent Routing For Ops Commands)

### 14.1 Test Window

- Start: `2026-04-01 02:22:47 UTC`
- End: `2026-04-01 02:24:30 UTC`
- Scope:
  - natural-language model switch command handling
  - missing-key follow-up prompt flow
  - approval-applied provider config propagation to tool runs

### 14.2 Validation

#### T14-1. Missing key follow-up prompt

- Request:
  - `POST /api/messages`
  - text: `切换开发模型到 gpt-4o-mini`
- Observed response:
  - `type=config_input_required`
  - `missingField=OPENAI_API_KEY`
  - includes expected follow-up command hint
- Result: PASS

#### T14-2. Key config via natural language + approval

- Request:
  - `POST /api/messages`
  - text: `设置 openai api-key 为 sk-test-openai-check`
- Observed:
  - operator action created with `kind=set_tool_provider_config`
  - approval created and can be approved through `/api/approvals/:id/decision`
- Result: PASS

#### T14-3. Model switch via natural language + approval

- Request:
  - `POST /api/messages`
  - text: `切换开发模型到 glm-5`
- Observed:
  - approval created with payload:
    - `modelId=zhipuai/glm-5`
    - `baseUrl=https://open.bigmodel.cn/api/paas/v4`
    - `apiKeyEnv=ZHIPUAI_API_KEY`
  - after approval, `/api/config.tools.providerModels.opencode = zhipuai/glm-5`
- Result: PASS

#### T14-4. Task-runner consumes updated provider model

- Task:
  - id: `8e782b5e-c06b-41e0-8e75-82b66adb5b9c`
  - instruction: `请只返回 OK`
- Observed tool run:
  - id: `17417a80-089a-4522-9c71-e9af7bf043bb`
  - args include `--model zhipuai/glm-5`
  - status: `completed`
  - output: `OK`
- Result: PASS

### 14.3 Regression

- `npm run typecheck`: PASS
- `npm test`: PASS (`5 files`, `20 tests`)

## 15. Retest (Generalized Ops Loop: Channel / Tool / Role Policy)

### 15.1 Test Window

- Start: `2026-04-01 03:12:51 UTC`
- End: `2026-04-01 03:16:36 UTC`
- Runtime:
  - orchestrator: `tsx watch src/server.ts`
  - task-runner: `tsx watch src/worker.ts`
  - base URL: `http://127.0.0.1:3280`

### 15.2 Validation

#### T15-1. Channel config enters approval flow and is applied

- Pre-check:
  - `GET /api/channels/status`
  - `channels.emailEnabled=false`
- Request:
  - `POST /api/messages`
  - text: `请启用邮件通道`
- Observed:
  - response: `type=operator_action_pending`
  - approval id: `4064e86b-63b6-42cd-b92a-eabc0bfd30a5`
  - action kind: `set_channel_enabled`
- Approval:
  - `POST /api/approvals/4064e86b-63b6-42cd-b92a-eabc0bfd30a5/decision`
  - status: `approved`
- Post-check:
  - `GET /api/channels/status`
  - `channels.emailEnabled=true`
  - `/api/operator-actions` contains applied action `1d7f72a5-92e4-4021-812d-7264faa1ccf4`
- Result: PASS

#### T15-2. Missing-input follow-up (tool/model command)

- Request:
  - `POST /api/messages`
  - text: `切换开发模型`
- Observed:
  - response: `type=config_input_required`
  - `missingField=modelId`
  - `expectedCommand=切换开发模型到 glm-5`
- Result: PASS

#### T15-3. Missing-input follow-up (role policy command)

- Request:
  - `POST /api/messages`
  - text: `请配置记忆为向量数据库`
- Observed:
  - response: `type=config_input_required`
  - `missingField=targetRoleId`
  - `expectedCommand=请配置研究助理的记忆为向量数据库`
- Result: PASS

#### T15-4. Missing-input follow-up (channel setting + email intent)

- Request A:
  - text: `发邮件`
  - observed: `type=config_input_required`, `missingField=to`
- Request B:
  - text: `设置飞书app_secret为`
  - observed: `type=config_input_required`, `missingField=FEISHU_APP_SECRET`
- Result: PASS

#### T15-5. Role policy approval + apply + audit trace

- Request:
  - `POST /api/messages`
  - text: `请配置研究助理的记忆为向量数据库`
- Observed:
  - approval id: `a78b861a-433f-4479-90f5-e70af3d83718`
  - operator action id: `035d6867-652c-4e25-b834-135df8c9abf1`
  - action kind: `set_memory_backend`
- Approval:
  - approved via `/api/approvals/:id/decision`
- Post-check:
  - `GET /api/config`
  - `memory.roleBackends.research=vector-db`
  - `/api/dashboard.auditEvents` includes:
    - `Applied operator action set_memory_backend`
    - `Approval approved`
- Result: PASS

### 15.3 Regression

- `npm run typecheck`: PASS
- `npm test`: PASS (`5 files`, `28 tests`)

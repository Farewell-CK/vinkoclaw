# Test Report: Feishu Config + Email Inbound Triage (2026-04-01)

## 1. Test Scope

- Feishu channel configuration path (runtime setting + approval apply)
- Feishu API connectivity under `feishu.cn` domain
- Email inbound strategy upgrade:
  - ingest all incoming emails
  - command dispatch authorization by sender allowlist
  - high-value/normal-value triage routing to operations role
  - low-value record-only behavior
  - receipt-check auto-reply behavior
- Observability:
  - channel status visibility
  - inbound ledger API

## 2. Environment

- Time (UTC): 2026-04-01 09:24 - 09:31
- Host: `127.0.0.1:3280` (orchestrator)
- Runtime model service: vLLM OpenAI-compatible endpoint already running (`http://127.0.0.1:8000/v1`)
- Feishu domain target: mainland (`open.feishu.cn`)

## 3. Applied Runtime Config (via approval flow)

- `FEISHU_APP_ID=cli_a94670fc98b99ceb`
- `FEISHU_APP_SECRET=<masked>`
- `FEISHU_DOMAIN=feishu`

All three were created as operator actions via `/api/messages`, then approved via `/api/approvals/:id/decision`.

## 4. Verification Commands and Results

### 4.1 Code Quality

- `npm run typecheck` -> pass
- `npm test` -> pass (28 tests)

### 4.2 Feishu Connectivity

- Auth check:
  - POST `https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal`
  - Result: `code=0`, `msg=ok`, token returned
- Channel status:
  - GET `/api/channels/status`
  - Result:
    - `status.feishu.configured=true`
    - `status.feishu.missing=[]`
    - `status.feishu.domain=feishu`
    - `status.feishu.verificationTokenConfigured=false` (optional in current implementation, recommended to configure)

### 4.3 Email Inbound Triage

- New observability endpoint:
  - GET `/api/email-inbound/records?limit=5`
  - Result: returns inbound ledger records (count + latest records)
- Channel status now includes:
  - `status.email.inbound.ledgerCount`
  - `status.email.inbound.lastReceivedAt`

## 5. Functional Outcomes

- Feishu channel now follows OpenClaw-like domain strategy:
  - supports `FEISHU_DOMAIN=feishu|lark|https://...`
- Email inbound now supports full-ingest policy:
  - all inbound emails are recorded into ledger + audit trail
  - only authorized sender commands are executed
  - non-command emails are value-ranked and routed to operations when needed
  - receipt-check intent emails produce contextual auto-reply instead of generic fallback text

## 6. Known Follow-ups

- To harden webhook security, configure:
  - `FEISHU_VERIFICATION_TOKEN`
- Complete Feishu event callback setup in Open Platform and run end-to-end group message tests.
- Optional: push inbound ledger records to Feishu doc/bitable as a synchronized external table.

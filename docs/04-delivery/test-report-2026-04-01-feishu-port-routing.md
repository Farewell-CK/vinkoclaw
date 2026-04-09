# Test Report (2026-04-01): Feishu Port & Webhook Routing

## Objective

- Adapt VinkoClaw to environments where only `8098` / `9098` can be exposed externally.
- Ensure Feishu callback routing is compatible with multiple webhook paths.

## Configuration

- Runtime host: `VINKOCLAW_HOST=0.0.0.0`
- Runtime port: `VINKOCLAW_PORT=8098`
- Public URL (local reference): `VINKOCLAW_PUBLIC_URL=http://127.0.0.1:8098`
- Feishu webhook paths enabled:
  - `/api/feishu/events`
  - `/feishu/events`
  - `/api/channels/feishu/events`

## Verification Time

- Date: `2026-04-01`
- Time window (UTC): `10:47` - `10:49`

## Commands & Results

1. Service listen check

- Command: `ss -ltnp | rg "8098|9098|3280" -n -S`
- Result: `0.0.0.0:8098` is listening; `3280` is no longer used.

2. Channel status API

- Command: `curl -sS http://127.0.0.1:8098/api/channels/status`
- Result: API reachable and Feishu/Email channel status returned as expected.

3. Webhook path challenge tests

- Command: `curl -sS -X POST http://127.0.0.1:8098/feishu/events ...`
- Result: `{"challenge":"hello8098"}`

- Command: `curl -sS -X POST http://127.0.0.1:8098/api/feishu/events ...`
- Result: `{"challenge":"hello-api"}`

- Command: `curl -sS -X POST http://127.0.0.1:8098/api/channels/feishu/events ...`
- Result: `{"challenge":"hello-channels"}`

4. Audit validation

- Command: `curl -sS http://127.0.0.1:8098/api/dashboard`
- Result: `auditEvents` includes `Received Feishu URL verification challenge`.

## Conclusion

- The previous external access blocker (`127.0.0.1:3280`) is resolved.
- VinkoClaw now supports external exposure on `8098` (or external `9098` reverse-proxy/port-map to `8098`).
- Feishu webhook path compatibility is confirmed for three common callback routes.

# Config

Configuration templates, environment examples, and local deployment settings live here.

Use `config/.env.example` as baseline. Channel completeness is visible via `/api/channels/status` (Feishu/Email missing keys).

Feishu channel:

- Required: `FEISHU_APP_ID`, `FEISHU_APP_SECRET`
- Optional: `FEISHU_DOMAIN` (`feishu` default, or `lark`, or full base URL)
- Optional: `FEISHU_CONNECTION_MODE` (`websocket` default, `webhook` optional)
- Optional: `FEISHU_VERIFICATION_TOKEN` (used by webhook mode; token verification)
- Optional: `FEISHU_ENCRYPT_KEY` (used by webhook mode; encrypted payload + signature verification)
- Webhook callback path (webhook mode): `/api/feishu/events` (also supports `/feishu/events` and `/api/channels/feishu/events`)
- `websocket` mode does not require public webhook exposure; `webhook` mode requires internet-reachable callback (recommended bind: `VINKOCLAW_HOST=0.0.0.0`, expose `VINKOCLAW_PORT=8098` or reverse-proxy to 8098/9098).

Inbound email requires:

- `EMAIL_INBOUND_ENABLED=1`
- `EMAIL_INBOUND_IMAP_HOST`
- `EMAIL_INBOUND_USERNAME`
- `EMAIL_INBOUND_PASSWORD`

Optional guards:

- `EMAIL_INBOUND_ALLOWED_SENDERS` (comma-separated command allowlist)
- `EMAIL_INBOUND_SUBJECT_PREFIX` (e.g. `[VinkoTask]`, command prefix)

Inbound behavior:

- All emails are ingested and audited.
- Prefixed (or trusted natural-command) emails are dispatched to `/api/messages`.
- Non-command emails are value-ranked; high-value emails are auto-routed to operations tasks, low-value emails are logged.
- Receipt-check emails (e.g. “收到邮件了吗”) trigger contextual auto-reply.

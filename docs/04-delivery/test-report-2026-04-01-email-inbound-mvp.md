# VinkoClaw Test Report (Email Inbound MVP)

## 1. Test Window

- Start: `2026-04-01 06:55:00 UTC`
- End: `2026-04-01 07:13:50 UTC`
- Operator: Codex CLI
- Scope:
  - 新增 `email-inbound` 收件服务（IMAP -> `/api/messages`）
  - 渠道状态接口扩展（收件配置可观测）
  - 控制台渠道面板显示收件状态

## 2. Environment

- Project root: `/home/xsuper/workspace/vinkoclaw`
- API endpoint: `http://127.0.0.1:3280`
- Data dir: `/home/xsuper/workspace/vinkoclaw/.data`
- Model runtime: vLLM (`Qwen3.5-35B-A3B`, 已由同事启动)

## 3. Effective Changes

- New service:
  - `services/email-inbound/src/worker.ts`
  - 支持：
    - IMAP 未读轮询
    - 发件人白名单过滤
    - 主题前缀过滤
    - Message-ID 去重（持久化到 SQLite config entry）
    - 发件人每分钟限流
    - 投递到 orchestrator `/api/messages`（`source=email`）
    - 审计日志（accepted/ignored/failed/session）
- Runtime config:
  - `packages/shared/src/env.ts` 新增 `EMAIL_INBOUND_*` 环境变量加载
- Orchestrator:
  - `services/orchestrator/src/server.ts`
  - `/api/channels/status` 新增 `status.email.inbound` 结构
- Control Center:
  - `apps/control-center/public/app.js`
  - 渠道面板新增 “Email Inbound” 状态卡片（中英双语）
- Scripts / workspace:
  - 根 `package.json` 的 `npm run dev` 现包含 `email-inbound`

## 4. Test Cases

### T1. TypeScript typecheck

- Command: `npm -C /home/xsuper/workspace/vinkoclaw run typecheck`
- Expected: 全 workspace 无类型错误
- Result: PASS

### T2. Unit tests

- Command: `npm -C /home/xsuper/workspace/vinkoclaw run test`
- Expected: 现有测试全部通过
- Result: PASS (`5 files`, `28 tests`)

### T3. Channels status API (inbound fields)

- Command: `curl http://127.0.0.1:3280/api/channels/status`
- Expected:
  - 返回 `status.email.inbound` 字段
  - 包含 `enabled/configured/missing/mailbox/pollIntervalSeconds/rateLimitPerMinute`
- Result: PASS
- Observed sample:
  - `enabled=false`
  - `configured=true`
  - `mailbox=INBOX`
  - `pollIntervalSeconds=15`

### T4. Email inbound service bootstrap

- Command: `npm -C /home/xsuper/workspace/vinkoclaw run dev:email-inbound`
- Expected:
  - 进程可启动
  - 未配置时进入 disabled/waiting 状态，不崩溃
  - 记录审计事件
- Result: PASS
- Observed:
  - 审计中出现 `Email inbound worker started`
  - 审计中出现 `Email inbound worker is disabled`

## 5. Known Limits

- 本轮未执行真实 IMAP 端到端收件（缺少线上收件参数与白名单策略最终确认）。
- 当前收件链路为轮询模式（MVP），后续可升级为 IMAP IDLE + 重连策略优化。

## 6. Next Validation (When Credentials Ready)

1. 配置：
   - `EMAIL_INBOUND_ENABLED=1`
   - `EMAIL_INBOUND_IMAP_HOST=imap.qq.com`
   - `EMAIL_INBOUND_USERNAME=<qq邮箱>`
   - `EMAIL_INBOUND_PASSWORD=<授权码>`
2. 发送测试邮件（主题前缀 `[VinkoTask]`）到收件箱。
3. 校验链路：
   - 审计出现 `Accepted inbound email command`
   - `/api/tasks` 或 `/api/approvals` 出现对应新记录
   - 控制台 Channels 面板显示 inbound `configured=true`

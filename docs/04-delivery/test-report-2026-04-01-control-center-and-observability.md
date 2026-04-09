# VinkoClaw Test Report (Control Center UX + Observability)

## 1. Test Window

- Start: `2026-04-01 04:03:00 UTC`
- End: `2026-04-01 04:14:00 UTC`
- Operator: Codex CLI
- Scope:
  - Control Center 分屏导航 + 中英双语切换
  - 审批/运维接口敏感信息脱敏验证
  - 现网运行状态检查（dashboard/channels/providers）

## 2. Environment

- Project root: `/home/xsuper/workspace/vinkoclaw`
- Control Center: `http://127.0.0.1:3280`
- API base (same origin): `http://127.0.0.1:3280/api`
- Runtime model service: vLLM (`Qwen3.5-35B-A3B`, FP8, OpenAI-compatible API)

## 3. Code Changes Covered

- `apps/control-center/public/index.html`
  - 新增完整 `data-i18n` / `data-i18n-placeholder` 标注
  - 导航分区（workbench/routing/config/execution/audit）用于减少长滚动
- `apps/control-center/public/app.js`
  - 增加导航视图切换逻辑（按 `data-view` 显隐面板）
  - 增加中英双语字典与运行时切换（含动态渲染文案）
  - 本地存储用户偏好（`vinkoclaw.lang`, `vinkoclaw.view`）
  - 动态状态文案翻译（审批状态、渠道状态、队列文案、模板操作反馈）
- `apps/control-center/public/styles.css`
  - 已生效的 sticky topbar + active 状态样式（与导航切换配合）
- 已存在改动验证：
  - `services/orchestrator/src/server.ts`（敏感信息脱敏、Feishu 审计事件）
  - `packages/shared/src/operator-actions.ts`（`SMTP_URL` 作为 secret）
  - `packages/agent-runtime/src/index.ts`（结构化输出解析增强）

## 4. Test Cases And Results

### T1. TypeScript typecheck

- Command: `npm -C /home/xsuper/workspace/vinkoclaw run typecheck`
- Expected: 全 workspace 无类型错误
- Result: PASS

### T2. Unit tests

- Command: `npm -C /home/xsuper/workspace/vinkoclaw run test`
- Expected: 现有测试全部通过
- Result: PASS (`5 files`, `28 tests`)

### T3. Control Center reachable

- Command: `curl -sS -o /tmp/vinko_home.html -w '%{http_code}' http://127.0.0.1:3280/`
- Expected: HTTP 200
- Result: PASS (`200`)

### T4. Dashboard/Channel/Provider APIs

- Commands:
  - `curl http://127.0.0.1:3280/api/dashboard`
  - `curl http://127.0.0.1:3280/api/channels/status`
  - `curl http://127.0.0.1:3280/api/tool-providers`
- Expected:
  - API 正常返回 JSON
  - channels 显示 Feishu 缺失项、Email 就绪状态
  - providers 显示 provider readiness 与 policy
- Result: PASS

### T5. Secret redaction smoke check

- Commands:
  - `curl http://127.0.0.1:3280/api/approvals > /tmp/vinko_approvals.json`
  - `curl http://127.0.0.1:3280/api/operator-actions > /tmp/vinko_operator_actions.json`
  - `rg "SMTP_URL|smtp|token|password|api-key" ...`
- Expected:
  - 不暴露 SMTP 授权码或明文 key
  - `SMTP_URL` 中凭据区域已脱敏
- Observed:
  - `SMTP_URL` 显示为 `smtps://3345710651%40qq.com:***@smtp.qq.com:465`
  - `apiKey` 显示为 `***` / 缩略形式（如 `ZHI***EY`）
- Result: PASS

## 5. Functional Outcome

- 控制台已从“长页面滚动”转为“顶部导航分屏”，可快速切换模块。
- UI 支持中英切换，静态文案与动态渲染文案都可同步切换。
- 审批/运维相关 API 输出继续保留审计价值，同时避免敏感凭据明文泄露。

## 6. Inbound Email Feasibility (收件链路)

当前代码已实现的是 SMTP 发件链路；收件链路尚未接入。  
结论：**可行，且建议分两阶段实现**。

### Phase 1 (推荐，黑客松可交付)

- 新增 `services/email-inbound`：
  - 使用 IMAP IDLE（QQ 邮箱）监听收件箱
  - 仅处理白名单发件人 + 特定主题前缀（如 `[VinkoTask]`）
  - 解析邮件正文为自然语言指令，投递到 `/api/messages`
- 审计：
  - 记录 `email.received / email.parsed / email.ignored / email.failed`
- 风险控制：
  - 限速、防重（Message-ID 去重）、附件大小限制

### Phase 2 (增强版)

- 附件入库（文档/图片）并作为任务 `attachments`
- 自动回信（任务已接收、审批状态、执行结果摘要）
- 规则引擎（按发件人/主题自动路由到角色模板）

预计工作量（Phase 1）：`1~1.5` 天（含联调与回归）。

# V3 Plan And Execution (Auto)

## 1. V3 目标

围绕黑客松一等奖目标，V3 聚焦三件事：

1. 把“本地算力 + 多角色团队 + 可审计执行”链路打磨完整。
2. 把 opencode + `glm-5` 真正接入到 developer 执行路径。
3. 把飞书/邮件接入完整度做成可观测状态，而不是口头说明。

## 2. V3 规划

### P0（必须完成）

- 工具执行链稳定化：
  - provider 只选 `available && keyConfigured`
  - opencode JSON 错误事件（`type:error`）即失败，不再被误判为成功
- opencode 模型路由：
  - 指令默认带 `--model zhipuai/glm-5`
  - 支持 OpenAI-compatible base URL + API key 注入
- 渠道可观测：
  - 增加 `/api/channels/status`
  - 控制台展示 Feishu/Email 缺失项

### P1（演示增强）

- 控制台展示 tool provider readiness 与策略（order/approval/timeout）
- 邮件审批失败可视化（返回明确错误 + 审计事件）

### P2（下一版预留）

- thinking 元数据可观测（不存原始 CoT）
- 真实 Feishu/SMTP E2E 自动化回归

## 3. 已执行实现

- `packages/shared/src/tool-exec.ts`
  - provider 过滤、opencode `--model` 注入、JSON 错误事件检测
- `services/task-runner/src/worker.ts`
  - tool 子进程环境注入（Zhipu/OpenAI/Anthropic）
  - opencode 错误事件 fail-fast
- `services/orchestrator/src/server.ts`
  - `GET /api/channels/status`
  - 邮件审批发送失败返回 `502`，并写入审计
- `apps/control-center/public/index.html`
  - 新增 `Channel Readiness` 面板
- `apps/control-center/public/app.js`
  - 渲染渠道配置缺失项、provider 可用性和 tool policy
- `packages/shared/src/operator-actions.test.ts`
  - 新增中英文邮件命令解析测试

## 4. V3 验证结论

- vLLM 主链正常：`Qwen3.5-35B-A3B` 可用，thinking/非 thinking 均可返回。
- developer 工具执行主链正常：opencode 使用 `zhipuai/glm-5` 成功产出结果。
- 渠道可观测到位：Feishu/Email 缺失配置在 API 与控制台可见。
- 邮件失败行为可审计：审批通过但 SMTP 未配时，API 返回 `502` 且写审计日志。

## 5. 下一步（V3+）

1. 接入真实飞书群 + SMTP 账户，跑一次完整外部 E2E。
2. 增加工具执行结果结构化产物（改动文件、测试结果、耗时）。
3. 增加“演示重置”脚本，清理历史 approvals/tool-runs，降低现场噪声。

## 6. 泛化能力补充（2026-04-01）

为避免“单一命令硬编码”，已补充一层可扩展的运维意图处理：

- 支持自然语言配置开发模型（model/baseUrl/api-key）并统一走审批
- 当模型切换缺少必要密钥时，返回 `config_input_required` 并给出后续命令提示
- 审批通过后自动写入运行时配置，task-runner 执行时自动使用新模型参数

这套机制后续可扩展到更多“听懂话 -> 追问缺参 -> 审批执行 -> 审计留痕”的场景（渠道配置、外部工具配置、角色策略配置）。

## 7. 泛化能力落地（2026-04-01 二次补充）

本版本已把“扩展能力”从说明升级为可运行实现：

- 渠道配置：
  - 新增 `set_channel_enabled` 动作，支持“启用/禁用 邮件/飞书 通道”
  - 全链路走审批与审计，配置生效后可立即在 `/api/channels/status` 观察到
- 外部工具配置：
  - 支持模型/baseUrl/api-key 的自然语言配置（`set_tool_provider_config`）
  - 缺少参数时返回 `config_input_required`（如缺 modelId、缺 key 值）
- 角色策略配置：
  - 支持角色记忆策略配置（`set_memory_backend`）与技能装配（`install_skill` / `disable_skill`）
  - 当命令缺角色或缺后端/技能时，会返回追问提示，不再误入普通任务队列

当前闭环能力已满足：

`听懂话 -> 追问缺参 -> 审批执行 -> 审计留痕`

## 8. 控制台与可观测性优化（2026-04-01 三次补充）

- 控制台交互升级：
  - 顶部导航分屏（workbench/routing/config/execution/audit），解决长滚动体验问题
  - 中英双语切换（静态+动态文案）
- 运行时可观测增强：
  - `dashboard/approvals/operator-actions` 继续保持脱敏输出
  - Feishu webhook 关键事件落审计，便于排障
- 交付文档补充：
  - 新增测试报告 `test-report-2026-04-01-control-center-and-observability.md`

## 9. 邮件收件链路 MVP（2026-04-01 四次补充）

- 新增独立服务 `services/email-inbound`：
  - IMAP 收件轮询 -> 解析正文 -> 投递 `/api/messages`（`source=email`）
- 安全护栏：
  - Message-ID 去重（持久化）
  - 发件人白名单
  - 主题前缀过滤
  - 发件人每分钟限流
- 可观测性：
  - `/api/channels/status` 增加 `status.email.inbound`
  - 控制台 `Channel Readiness` 展示 inbound 状态（enabled/configured/missing/mailbox/rate）
- 交付补充：
  - 新增测试报告 `test-report-2026-04-01-email-inbound-mvp.md`

## 10. 协作与团队管理增强（2026-04-02）

本轮实现将“多角色协作”从仅有拆分逻辑升级为可追踪、可管理、可解释的执行链路：

- 协作生命周期收敛：
  - 协作启动后会记录父任务协作上下文
  - 子任务收敛后自动进入聚合阶段
  - 聚合完成回收父任务结果，失败路径也会回写失败状态
- 虚拟 Agent 实例：
  - 新增 `agent_instances` 持久化模型（角色、名称、语气策略、状态）
  - 协作分配按实例执行，支持同角色多实例
- 协作过程可观测：
  - 新增 timeline 事件落库（启动/分配/阶段切换/完成/失败）
  - 新增 API：
    - `GET /api/tasks/:taskId/collaboration`
    - `GET /api/collaborations/:collaborationId`
    - `GET /api/collaborations/:collaborationId/messages`
    - `GET /api/collaborations/:collaborationId/timeline`
    - `GET /api/agent-instances`
- 团队运维指令扩展（审批一致）：
  - `add_agent_instance`
  - `remove_agent_instance`
  - `set_agent_tone_policy`
- 交互文案优化：
  - 飞书队列/审批确认文案更自然，减少“机械模板感”。

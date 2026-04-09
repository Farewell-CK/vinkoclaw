# Runtime Flow

## 1. System Boundary

VinkoClaw 采用“单入口，多角色，统一状态库”的架构。

- `services/orchestrator`
  负责 HTTP API、飞书事件接入、审批落地、控制台静态资源服务
- `services/task-runner`
  负责轮询任务、调用本地模型、写回结果与反思
- `services/email-inbound`
  负责 IMAP 收件、白名单/主题过滤、去重与限流，并将邮件指令投递给 orchestrator
- `packages/shared`
  负责环境加载、角色与 skill 目录、SQLite 状态层、operator action 解析
- `packages/knowledge-base`
  负责本地文件扫描、文本 / Markdown / PDF 读取、简单检索
- `packages/agent-runtime`
  负责角色 prompt、模型调用、结果结构化、fallback 与 reflection
- `apps/feishu-gateway`
  负责飞书 webhook 解析与回发消息
- `apps/control-center`
  负责本地可操作控制台

## 2. Primary Flow

### 2.1 Normal Task

1. Owner 从飞书或控制台发来普通任务
2. Orchestrator 根据文本或显式角色做路由
3. 任务写入 SQLite，状态为 `queued`
4. Task Runner 领取任务，状态变为 `running`
5. Knowledge Base 对本地仓库做检索
6. Agent Runtime 拼接角色 prompt、激活 skill、注入上下文
7. 调用本地 OpenAI 兼容推理端（当前推荐 vLLM）
8. 如果主推理端不可用，则切到备用后端（如 SGLang / Ollama，取决于本机是否部署）
9. 如果仍不可用，进入 deterministic fallback
10. 输出 `result + reflection`
11. SQLite 中任务状态写回 `completed`

补充（2026-04-06）：

- `task-runner` 支持可配置并发任务消费（同进程多 worker loop）：
  - `RUNNER_TASK_CONCURRENCY`（默认 `1`，范围 `1..12`）
  - GoalRun 仍保持单线推进，避免阶段状态竞争
- 协作 GoalRun 支持失败后有条件自动重试（默认开启）：
  - `GOAL_RUN_COLLAB_RETRY_ENABLED`（执行阶段协作失败重试）
  - `GOAL_RUN_COLLAB_VERIFY_RETRY_ENABLED`（校验阶段关键角色缺失重试）
- 协作中间进展推送做了节流与短句化：
  - `COLLAB_FEISHU_INTERMEDIATE_MIN_INTERVAL_MS`（默认 `12000`）
  - 协作执行阶段增加心跳播报：
    - `GOAL_RUN_COLLAB_HEARTBEAT_MS`（默认 `45000`）
    - 会在飞书推送“已完成/进行中/待处理/受阻 + 角色动态摘要（文件/命令/结果）”
- 飞书通道对齐 OpenClaw 的 sender-profile 策略：
  - `FEISHU_RESOLVE_SENDER_NAMES`（默认 `true`）
  - 发送者名称按缓存解析，降低 profile 查询开销
  - 名称写入任务/目标 metadata，不再拼接进任务正文，减少模型误判
- GoalRun 进度通知采用“非阻断”策略：
  - 飞书发送失败仅写审计与错误日志，不中断 GoalRun 主流程
  - 避免 `invalid receive_id` 等通道异常把执行链路判定为失败
- 飞书闲聊响应加入极速通道：
  - `你好/在吗/谢谢` 等闲聊不建任务、不入队，直接文本回复
  - 闲聊回执可跳过 reaction 先发文本，降低首包延迟并避免“只看到表情”
- GoalRun 路由策略收敛：
  - 普通单步任务默认走轻量 `task`，不再因“帮我”自动升级为 GoalRun
  - 仅对“全流程/端到端/部署上线 + 复杂目标”触发 GoalRun
- 会话连续性增强：
  - 当存在进行中的 GoalRun，`继续/请继续/continue` 会返回当前阶段并确认持续推进
  - 避免重复创建任务带来的噪音
  - `进度/状态` 查询增加意图消歧：包含明显配置/安装/执行动作的句子，不再被误判为“仅查状态”
  - 协作任务状态回复会附带团队进度摘要（已完成/进行中/待处理/受阻角色）与成员动态快照（按角色展示最新状态）

### 2.2 Operator Action

1. Owner 发出运维类语句
2. 系统将文本解析为 `operator_action`
3. Operator Action 写库，同时创建 `approval`
4. Owner 审批通过后，系统执行配置变更
5. 配置、skill binding、审计日志统一更新

补充（2026-04-06）：

- 新增低风险免审分级策略：
  - 通过 `OPERATOR_LOW_RISK_AUTO_APPROVE_ENABLED` + `OPERATOR_LOW_RISK_AUTO_APPROVE_SCOPE` 控制
  - `scope` 支持 `owner | owner_or_control_center | all | none`
  - 低风险动作可直接执行并写入审计（保留可追踪）

补充（2026-04-02）：

- 新增团队管理动作：
  - `add_agent_instance`
  - `remove_agent_instance`
  - `set_agent_tone_policy`
- 以上动作与既有配置变更一样，统一走审批与审计。

### 2.3 Developer Tool Execution

1. Task Runner 识别 `code-executor` 任务（典型角色：Developer / Frontend / Backend / Algorithm / CTO）
2. 根据策略探测本地 provider 可用性并按顺序选择：`opencode -> codex -> claude`
3. 计算风险级别：
   - 命中高风险关键词（如 deploy / production / rm -rf）=> `high`
   - 安装/迁移类关键词 => `medium`
   - 其他 => `low`
4. 审批策略：
   - `low/medium` 默认由 CTO 自动批准
   - `high` 进入 owner 审批（`task_execution`）
5. 审批通过后任务重新排队，Runner 从已批准 tool run 继续执行
6. 执行轨迹持久化到 `tool_runs`，并写入 dashboard 与 audit
7. 执行成功：任务产出 `result + reflection`
8. 执行失败：写回失败原因，避免静默失败

### 2.4 Email Inbound Command

1. `email-inbound` 连接 IMAP 邮箱并扫描未读邮件
2. 对发件人白名单、主题前缀、去重（Message-ID）和限流做预处理
3. 合法邮件正文被转成自然语言指令，投递到 `POST /api/messages`（`source=email`）
4. 后续复用既有链路：意图解析 -> 追问缺参 -> 审批 -> 执行 -> 审计
5. 收件事件（accepted/ignored/failed）写入统一审计日志，控制台可见

### 2.5 Multi-Agent Collaboration (Virtual Team Instances)

1. 任务被识别为协作模式（`metadata.collaborationMode=true`）后，Runner 创建协作记录。
2. 系统按参与角色拆分子任务，并映射到“虚拟 Agent 实例”执行（每个角色可有多个实例）。
3. 子任务执行过程中，系统持续写入协作消息与 timeline 事件（分配、进展、阶段切换、失败/完成）。
4. 执行阶段收敛后触发聚合任务，生成最终汇总。
5. 聚合完成后，协作状态更新为 `completed`，父任务回收最终结果；若聚合失败则标记协作/父任务失败。

补充（2026-04-06）：

- GoalRun 取消时会级联终止其当前执行任务与后代子任务，防止残留 `running` 任务长期占用队列。

可观测接口：

- `GET /api/tasks/:taskId/collaboration`
- `GET /api/collaborations/:collaborationId`
- `GET /api/collaborations/:collaborationId/messages`
- `GET /api/collaborations/:collaborationId/timeline`
- `GET /api/agent-instances`
- `POST /api/tasks/:taskId/cancel`
- `POST /api/tasks/cancel-stale`
  - 支持 `dryRun=true` 预演将被清理的任务列表
- `POST /api/approvals/:approvalId/cancel`
- `POST /api/approvals/cancel-stale`
  - 支持 `dryRun=true` 预演将被清理的审批列表
- `POST /api/goal-runs/cancel-stale`
  - 支持 `dryRun=true`，可按 `statuses` 指定清理状态范围

产品自检巡检（脚本）：

- `npm run self-check:product`：执行一轮端到端产品自测
- `npm run self-check:product:once`：执行一轮并写入 `.run/product-selfcheck/`
- `npm run self-check:product:watch`：按间隔循环执行（`PRODUCT_SELFCHECK_INTERVAL_MINUTES`）
- `npm run self-check:product:watch:start|stop|status|restart`：守护进程管理（PID/日志）

系统级观测接口（2026-04-06）：

- `GET /api/system/metrics`
- `GET /api/system/health-report`
- `GET /api/system/kpi/daily?days=14`
- `GET /api/system/self-check/latest`
- `GET /api/system/self-check/history?limit=50`
- `GET /api/system/self-check/watcher`

返回数据中补充了任务与 GoalRun 的增强字段：

- `failureCategory`
- `completionEvidence`
- `retryPolicyApplied`（GoalRun）

说明：系统级 KPI 默认排除 `selfcheck/product-selfcheck` 自动巡检流量，避免压测/自测数据污染线上指标。

health-report 阈值支持运行时配置：

- `SYSTEM_HEALTH_TASK_STALE_MINUTES`
- `SYSTEM_HEALTH_GOALRUN_STALE_MINUTES`
- `SYSTEM_HEALTH_APPROVAL_STALE_MINUTES`
- `SYSTEM_HEALTH_STALE_TASK_CRITICAL_COUNT`
- `SYSTEM_HEALTH_STALE_GOALRUN_CRITICAL_COUNT`

## 3. Why SQLite First

MVP 阶段使用 Node 内置 `node:sqlite`，原因是：

- 无需引入独立数据库服务
- 状态模型足够清晰
- 任务、审批、审计、skill binding 都能统一管理
- 更适合桌面级 DGX Spark 单机演示

## 4. Skill Accuracy Model

这是 VinkoClaw 相比单 Agent 框架的核心差异。

系统维护 `skill_bindings` 表，而不是把 skill 装进一个全局 runtime：

- `scope = role`
- `scope_id = ceo | cto | product | uiux | frontend | backend | algorithm | qa | developer | engineering | research | operations`
- `skill_id = vector-memory | email-ops | workspace-retrieval ...`

因此，“给 CEO 安装向量记忆 skill”只会改变 CEO Assistant 的可见 skill 集，不会影响 Research 或 Engineering。

## 5. Reflection Model

反思能力不做成另一个松散日志，而是成为任务输出的一部分：

- `score`
- `confidence`
- `assumptions`
- `risks`
- `improvements`

这保证后续可以直接把 reflection 接到：

- 自动复盘
- 自动再规划
- Owner 审批前判断
- 任务质量追踪

## 6. Security Posture

MVP 的安全设计借鉴 NemoClaw / OpenShell 的思路，但做了更轻量的产品层实现：

- 风险动作默认审批
- 审计事件持久化
- skill 安装按角色精确落地
- 邮件发送必须显式批准
- 代码执行支持风险分级与审批后重入
- 后续可接入更细粒度命令白名单与执行沙箱

## 7. Process Visibility Policy

- 飞书与控制台展示“过程轨迹（trajectory）”，包括：
  - 任务分配给了哪些角色/实例
  - 哪些步骤已完成/失败
  - 何时进入汇总阶段
- 默认不暴露原始链式思考（raw CoT），只展示结构化过程事件与结果。

# VinkoClaw

VinkoClaw 是一个面向 DGX Spark 的本地优先 AI 团队操作系统。  
目标不是做聊天机器人，而是让一个 Owner 通过飞书/控制台指挥一支多角色 AI 团队，在本地机器上完成任务拆解、执行、协作、审批与交付。

## 为什么做这个

VinkoClaw 的核心竞争力是三点：

- 本地优先：核心编排与知识在本地运行，不依赖纯云端闭源流程。
- 多角色协作：不是单 agent 问答，而是可追踪的团队式执行链路。
- 可验证闭环：从指令到执行到结果与审计，形成稳定可复用流程。

## Agent Harness 架构

VinkoClaw 遵循"模型提供智能，Harness 决定可靠性"原则，在 LLM 之上构建了完整的 Harness 层：

- **工具注册中心**（`tool-registry.ts`）：可插拔工具系统，支持意图匹配、风险分级、类别过滤
- **规则引擎**（`rules-engine.ts`）：工具执行前后拦截，6 条预置安全规则（危险路径/命令/敏感信息脱敏）
- **实时遥测**（`telemetry.ts`）：SQLite 持久化的 LLM 决策轨迹，包含 token 用量、工具调用、规则拦截
- **知识注入**：执行前自动检索相关知识并注入 system prompt
- **预规划**：复杂任务先做一次轻量规划，判断是否缺少关键信息，支持 `__NEEDS_INPUT__` 协议

## 当前能力

### 编排与执行
- 任务编排：Orchestrator + 多 Runner 并行执行
- 多角色路由：CEO/CTO/产品经理/UIUX/前端/后端/算法/测试/研究/运营等角色分工
- 多后端支持：OpenAI / Zhipu / SGLang / Ollama，主后端不可用时自动降级
- 预执行规划：复杂任务自动判断是否缺少关键信息，支持中途请求用户补充

### Harness 与可靠性
- 工具注册中心：可插拔工具发现，意图匹配（支持中英文关键词）
- 规则引擎：执行前拦截危险操作，执行后脱敏敏感输出
- 遥测追踪：SQLite 持久化，跨进程共享，API 可查询完整决策轨迹
- 交付物合约：`artifact_preferred` / `answer_only` / `artifact_required` 三种交付模式

### 协作与质量
- 轻量协作：build + quick check 模式，角色特定审阅清单
- 质量评估：自动收敛迭代，直至审阅通过或达到最大轮数
- 多智能体协作：自动分级（简单/协作/多角色），协作室共享上下文
- Goal Runs：阶段驱动执行，含证据校验、交接、恢复状态与审批

### 记忆与知识
- CEO 项目记忆：会话级目标/阶段/未决问题自动更新
- 工作区记忆：技术栈/沟通风格/活跃项目/关键决策跨会话持久化
- 知识注入：执行前自动检索 Top-5 相关知识注入 system prompt
- 会话历史：真实 user/assistant 消息对注入，多轮连贯性

### 技能市场
- 技能搜索：远程注册表搜索、详情查看、推荐
- 技能安装：一键安装到指定角色，运行时验证与快照
- 技能执行：通过 Plugin SDK 注册自定义工具

### 通道与控制台
- 飞书事件入口 + 邮件通道
- 控制台：5 个视图（工作台/模板与队列/团队与渠道/审批与执行/遥测/审计）
- 产品 Harness：回归测试套件 + PASS/FAIL 报告
- 模板管理：路由模板 CRUD + 导入/导出 JSON
- 创始人工作流：从想法到交付 / 写 PRD / 调研报告 / 每周复盘

## 仓库结构

- `apps/`: 网关与前端入口（飞书网关、控制台 SPA）
- `services/`: orchestrator、task-runner 等长驻服务
- `packages/`: agent-runtime、shared、plugin-sdk、knowledge-base、feishu-gateway
- `prompts/`: 角色提示词与行为约束
- `scripts/`: 自检、拟人测试、Harness runner、Runner 管理脚本
- `config/`: 环境变量模板
- `docs/`: 产品、架构、研究与交付文档

## 5 分钟启动

1. 安装依赖

```bash
npm install
```

2. 准备环境变量（使用模板）

```bash
cp config/.env.example .env
```

3. 按需修改 `.env`（至少确认以下项）

- `VINKOCLAW_PORT`
- `PRIMARY_BACKEND` / `SGLANG_BASE_URL` / `SGLANG_MODEL`
- `OPENAI_API_KEY` 或 `ZHIPUAI_API_KEY`（如果使用外部模型服务）
- 飞书与邮件相关变量（如需启用对应通道）

4. 启动系统

```bash
npm run dev
```

5. 打开控制台

`http://127.0.0.1:8098`

## 常用运行命令

```bash
# 只启动 orchestrator
npm run dev:orchestrator

# 只启动单个 runner
npm run dev:task-runner

# 启动多 runner（默认 dev 为多 runner）
npm run dev:task-runner:multi

# 基础自检
npm run self-check

# 产品行为自检
npm run self-check:product

# 拟人化端到端测试
npm run persona-test

# Harness 回归测试
npm run harness
```

## 机器到期前导出

```bash
./scripts/export-handover.sh
```

导出后会在 `/home/xsuper/workspace/tmp` 生成源码压缩包与清单文件。  
详情见 `docs/04-delivery/handover.md`。

## 示例命令

可直接在飞书/控制台使用以下中文指令：

- `团队执行：做一个带登录和仪表盘的SaaS MVP`
- `请配置研究助理的记忆为向量数据库`
- `给 ceo 安装向量记忆 skill`
- `请帮我调研一下 DGX Spark 对个人超级计算机 OPC 的差异化价值`
- `帮我起草一封发给客户的邮件`

## 通道与回调

飞书回调路径：

- `/api/feishu/events`（主路径）
- `/feishu/events`（兼容）
- `/api/channels/feishu/events`（兼容）

如果在内网环境部署，需要把 `8098` 端口映射到可访问公网地址，并将回调 URL 指向以上任一路径。

## API 端点

- `GET /health` — 系统健康检查
- `GET /metrics` — Prometheus 指标
- `GET /api/dashboard` — 控制台快照
- `GET /api/tasks` — 任务列表
- `POST /api/tasks` — 创建任务
- `GET /api/tasks/:id/trace` — 任务遥测轨迹（LLM 决策时间线）
- `GET /api/system/telemetry` — 全局遥测（所有 trace）
- `GET /api/system/metrics` — 系统指标
- `GET /api/system/health-report` — 健康报告
- `GET /api/roles` — 角色与技能目录

## 已知限制

- 外部工具链（如第三方 CLI）在权限交互配置不当时可能卡住，使用前需确认权限模式。
- 若主模型后端不可用，系统会走本地降级路径，能保证流程可用，但推理质量会下降。
- 不同通道依赖不同环境变量，建议启用通道前先跑一次 `npm run self-check:product`。
- 沙箱隔离尚未实现（V1 通过工作目录隔离已满足单用户场景，多租户为 V2 需求）。

## 关键文档

- `docs/01-product/project-definition.md`
- `docs/01-product/prd-v1.md`
- `docs/02-architecture/runtime-flow.md`
- `docs/02-architecture/product-harness-v0.md` — Harness 架构设计
- `docs/02-architecture/collaboration-convergence-v0.md` — 多智能体协作收敛
- `docs/02-architecture/dynamic-project-memory-v0.md` — 动态项目记忆
- `docs/02-architecture/skills-marketplace-v0.md` — 技能市场
- `docs/03-research/openclaw-vs-nemoclaw.md`
- `docs/04-delivery/project-overview.md`

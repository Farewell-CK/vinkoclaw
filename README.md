# VinkoClaw

VinkoClaw 是一个面向 DGX Spark 的本地优先 AI 团队操作系统。  
目标不是做聊天机器人，而是让一个 Owner 通过飞书/控制台指挥一支多角色 AI 团队，在本地机器上完成任务拆解、执行、协作、审批与交付。

## 为什么做这个

VinkoClaw 的核心竞争力是三点：

- 本地优先：核心编排与知识在本地运行，不依赖纯云端闭源流程。
- 多角色协作：不是单 agent 问答，而是可追踪的团队式执行链路。
- 可验证闭环：从指令到执行到结果与审计，形成稳定可复用流程。

## 当前能力

- 任务编排：Orchestrator + 多 Runner 并行执行
- 多角色路由：CEO/CTO/Engineering/Backend/Frontend 等角色分工
- 工具执行：代码运行、文件写入、网页检索等工具链
- 协作可观测：任务/协作轨迹、审批与审计记录
- 通道接入：飞书事件入口 + 邮件通道
- 本地推理优先：主后端不可用时可降级到确定性本地输出，保证流程连续性

## 仓库结构

- `apps/`: 网关与前端入口
- `services/`: orchestrator、task-runner、email-inbound 等长驻服务
- `packages/`: 运行时、共享模块、插件 SDK
- `prompts/`: 角色提示词与行为约束
- `scripts/`: 自检、拟人测试、Runner 管理脚本
- `config/`: 环境变量模板
- `docs/`: 产品、架构、交付与测试文档

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
```

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

## 已知限制

- 外部工具链（如第三方 CLI）在权限交互配置不当时可能卡住，使用前需确认权限模式。
- 若主模型后端不可用，系统会走本地降级路径，能保证流程可用，但推理质量会下降。
- 不同通道依赖不同环境变量，建议启用通道前先跑一次 `npm run self-check:product`。

## 关键文档

- `docs/01-product/project-definition.md`
- `docs/01-product/prd-v1.md`
- `docs/02-architecture/runtime-flow.md`
- `docs/03-research/openclaw-vs-nemoclaw.md`
- `docs/04-delivery/project-overview.md`

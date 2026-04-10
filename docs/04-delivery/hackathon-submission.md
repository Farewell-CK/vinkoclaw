# VinkoClaw — NVIDIA Hackathon Submission

## 技术方案报告

---

### 一、项目概述

**VinkoClaw** 是一个运行在 NVIDIA DGX Spark 上的**本地优先 OPC AI 团队操作系统**。

它不是聊天机器人，不是单 Agent 对话框架。它的定位是：让一个创业者通过飞书（或 Web 控制台），远程指挥一支多角色 AI 团队，在本地 DGX Spark 机器上完成任务拆解、分工执行、安全审批与结果交付。

- **飞书群 = 指挥室** — Owner 的自然语言入口
- **DGX Spark = AI 总部** — 本地推理、知识库、编排与执行全部在单机闭环

核心假设：**一人公司不需要一个大模型，而是需要一个能被精确指挥的团队。**

---

### 二、技术架构

#### 2.1 系统组成

系统采用 TypeScript Monorepo 结构，分为以下模块：

```
vinkoclaw/
├── apps/
│   ├── control-center/    # Web 控制台（静态前端 + 认证）
│   └── feishu-gateway/    # 飞书消息解析与回发
├── services/
│   ├── orchestrator/      # 中央调度：HTTP API / 飞书事件 / 审批 / 路由
│   ├── task-runner/       # 任务消费：LLM 推理 / 工具调用 / 反思
│   └── email-inbound/     # IMAP 收件：白名单 / 去重 / 限流
├── packages/
│   ├── agent-runtime/     # 角色 prompt / 本地推理 / fallback / reflection
│   ├── knowledge-base/    # 仓库文档 / 代码 / PDF 扫描检索
│   ├── shared/            # SQLite 状态层 / operator action / 协作时间线
│   └── plugin-sdk/        # 插件系统：skill / memory backend
└── prompts/
    └── roles/             # 12 个角色系统提示词
```

#### 2.2 推理后端

| 层级 | 组件 | 说明 |
|------|------|------|
| 主推理 | vLLM (OpenAI 兼容 API) | Qwen 3.5-35B-A3B FP8 量化 |
| 兜底 | SGLang / Ollama | 主后端不可用时自动切换 |
| 降级 | Deterministic Fallback | 推理完全不可用时保证流程不中断 |
| 开发工具 | opencode + `zhipuai/glm-5` | Developer 角色代码执行链路 |

推理层设计为**可插拔**：通过 `PRIMARY_BACKEND` + `SGLANG_BASE_URL` 环境变量切换，不绑定单一厂商。

#### 2.3 数据持久化

MVP 阶段使用 Node.js 内置 `node:sqlite`（无需额外数据库）：

- `tasks` — 任务队列与状态
- `approvals` — 审批单
- `audit_events` — 所有操作审计
- `skill_bindings` — 角色级技能绑定
- `agent_instances` — 虚拟 Agent 实例
- `collaborations` — 多角色协作记录与时间线
- `users` — 认证用户
- `tool_runs` — 开发者工具执行记录

#### 2.4 核心流程

**普通任务（Normal Task）：**

```
Owner 指令 → 意图分类（LLM + 关键词兜底） → 路由到角色
→ 写入 SQLite (queued) → Task Runner 领取 (running)
→ Knowledge Base 检索上下文 → Agent Runtime 拼接 prompt
→ 本地推理 → 产出 result + reflection → 状态 (completed)
```

**运维操作（Operator Action）：**

```
Owner 指令 → 解析为 operator_action → 创建审批单 (pending)
→ Owner 审批 → 配置变更（skill binding / memory backend / 通道）
→ 写入审计日志
```

**多角色协作（Collaboration）：**

```
Owner 指令（含"团队执行"） → 创建协作记录
→ 拆分子任务 → 映射到虚拟 Agent 实例
→ 持续写入 timeline 事件 → 执行阶段收敛
→ 聚合任务生成汇总 → 父任务 completed
```

---

### 三、已实现功能

#### 3.1 多角色 AI 团队

系统内置 **12 个角色**，每个角色有独立系统提示词与技能边界：

| 角色 | 职责 |
|------|------|
| CEO | 业务优先级、资源决策、发布决策 |
| CTO | 技术架构、技术战略、风险评估 |
| Product (PM) | 需求拆解、PRD、验收标准 |
| UI/UX | 交互设计、视觉规范、原型 |
| Frontend | React/Vue 组件、页面、样式，直接写代码 |
| Backend | API 设计、数据模型、服务实现 |
| Engineering | 生产代码、脚本、bug 修复 |
| Developer | 通用脚本、工具、自动化、胶水代码 |
| QA | 测试用例、回归策略、发布质量信号 |
| Research | 市场调研、竞品分析、报告 |
| Algorithm | LLM 策略、本地模型优化 |
| Operations | 运营执行、邮件、内容创作 |

#### 3.2 智能路由系统

**三层路由机制：**

1. **模板路由** — 关键词匹配预定义工作流（如 "internet launch"）
2. **LLM 意图分类** — 使用 Qwen 3.5 模型判断意图：`task | collaboration | goalrun | operator_config`
3. **关键词兜底** — 意图分类超时或失败时，基于关键词规则路由

**角色选择算法：** 基于优先级关键词匹配（`frontend` > `backend` > `product` > ...），首个命中即路由，支持显式角色指定（"让产品经理来做"）。

#### 3.3 审批与安全治理

| 特性 | 说明 |
|------|------|
| 风险分级 | 代码执行按关键词自动分级（high/medium/low） |
| 自动审批 | 低风险操作（low/medium）CTO 自动批准 |
| 人工审批 | 高风险操作进入 Owner 审批 |
| 审批卡片 | 飞书交互式卡片，内联批准/拒绝按钮 |
| 免审策略 | 低风险操作可配置免审，但保留审计 |
| 审计追踪 | 所有审批决策写入审计日志 |

#### 3.4 角色级 Skill 绑定

传统单 Agent 系统中 skill 安装后全局生效，能力边界模糊。VinkoClaw 将 skill 精确绑定到具体角色：

- `skill_bindings` 表记录 `scope(role) + scope_id(角色名) + skill_id`
- "给 CEO 安装向量记忆 skill" → 仅 CEO 拥有向量记忆能力
- 技能变更走审批流程
- 审计日志记录每次技能变更

#### 3.5 反思机制

每个任务完成后自动生成 **reflection**，包含：

- `score` — 完成质量评分
- `confidence` — 置信度
- `assumptions` — 执行中的假设
- `risks` — 识别的风险
- `improvements` — 改进建议

这使系统天然具备复盘能力，Owner 可快速判断结果是否值得推进。

#### 3.6 多通道交互

| 通道 | 功能 |
|------|------|
| 飞书（主） | 群聊、webhook 事件、审批卡片、交互式按钮 |
| Web 控制台 | 任务下发、审批管理、队列监控、渠道就绪状态 |
| 邮件（可选） | IMAP 收件、白名单、去重、限流 |

#### 3.7 开发者工具执行链

Developer 角色可通过 **opencode** 调用本地模型（`zhipuai/glm-5`）执行代码型任务：

1. 风险分级检测（deploy / rm -rf 等关键词）
2. 低/中风险 CTO 自动批准，高风险 Owner 审批
3. 执行命令、输出、错误写入 `tool_runs`
4. 控制台实时显示工具执行轨迹

#### 3.8 可观测性与运营

| 接口 | 说明 |
|------|------|
| `/api/dashboard` | 仪表板聚合数据 |
| `/api/tasks` | 任务列表与状态 |
| `/api/approvals` | 审批管理 |
| `/api/audit` | 审计事件查询 |
| `/api/channels/status` | 通道就绪状态（飞书/邮件配置完整度） |
| `/api/tool-providers` | 工具提供方可用性 |
| `/api/collaborations/:id/timeline` | 协作时间线 |
| `/api/system/health-report` | 系统健康报告 |
| `/api/system/kpi/daily` | 每日 KPI |

#### 3.9 测试与质量保障

| 脚本 | 说明 |
|------|------|
| `npm run persona-test` | 12 场景端到端拟人测试 |
| `npm run self-check:product` | 产品行为自检 |
| `npm run self-check:product:watch` | 定时巡检守护进程 |
| `npm run self-check` | 基础系统自检 |

---

### 四、技术亮点

#### 4.1 DGX Spark 本地优先设计

- 推理、知识库、编排、执行全部在**单机闭环**
- 无需云端 API 即可运行（使用确定性降级）
- 支持 SGLang/vLLM/Ollama 多种推理后端
- 充分利用 DGX Spark 的本地算力与存储

#### 4.2 从单 Agent 到多 Agent 团队

| 维度 | 传统单 Agent | VinkoClaw |
|------|-------------|-----------|
| 角色 | 一个通用助手 | 12 个专业角色 |
| 执行 | 建议代码，用户复制 | 直接写文件、运行测试、交付产物 |
| 追溯 | 对话记录 | 任务记录、协作时间线、审批审计 |
| 隐私 | 数据到云端 | 模型、知识、执行全在本地 |
| 治理 | 无 | 审批、风险分级、审计日志 |

#### 4.3 思考模型兼容性

系统深度适配 Qwen 3.5-35B-A3B 的 CoT 推理模式：

- 分类路径：`enable_thinking: false`（延迟敏感）
- 工具调用路径：`enable_thinking: false`（避免思考消耗工具调用 token）
- 纯完成路径：thinking 开启 + finalize 二次调用
- 工具轮完成：reasoning→finalize 降级链

#### 4.4 高可用设计

- 推理层不可用 → SGLang/Ollama 兜底 → deterministic fallback
- GoalRun 取消时级联终止子任务，防止残留
- 飞书发送失败不中断主流程
- 协作中间进展推送带节流（防消息爆炸）

---

### 五、未来规划：超级 OPC 操作系统

> **OPC** = One-Person Company（一人公司）

#### 5.1 Phase 1：治理增强（当前进行中）

- 接入真实飞书群联调，多角色群内协同
- 控制台可视化全面优化（Apple 风格 UI）
- 命令安全策略：白名单 + workspace 边界校验
- provider 健康检查与冷启动探针
- tool-run 输出结构化（变更文件、测试结果、耗时）

#### 5.2 Phase 2：DGX Spark 差异化能力

- **更大上下文窗口** — 利用本地 GPU 内存支持更长推理上下文
- **多角色并行推理** — 利用 DGX Spark 多 GPU 同时执行多个角色推理
- **本地向量库** — 长时记忆与 RAG
- **混合知识底座** — 文档 / 代码 / 邮件 / 日历统一检索
- **长任务持续运行** — 小时级任务的稳定执行

#### 5.3 Phase 3：OPC 产品化

- **CRM 集成** — 客户线索管理
- **日历协同** — AI 自动排程
- **内容生产闭环** — 调研 → 写作 → 审核 → 发布
- **多项目工作台** — 同时管理多个产品线
- **插件市场** — 角色 skill 模板生态
- **可审计商业运营流** — 从线索到收入的完整审计链

#### 5.4 愿景

> "VinkoClaw 的终极目标，是让一个创业者在 DGX Spark 上拥有一支企业级 AI 团队——从市场调研到产品开发，从客户沟通到财务运营，全部由本地 AI 团队执行，Owner 只需做决策。"

---

### 六、快速开始

```bash
git clone git@github.com:Farewell-CK/vinkoclaw.git
cd vinkoclaw
npm install
cp config/.env.example .env
# 编辑 .env，设置模型后端
npm run dev
# 打开 http://127.0.0.1:8098
```

默认登录：`admin` / `vinkoclaw`

---

### 七、演示视频脚本

#### Part A：定位（10 秒）

> "这不是聊天机器人，这是运行在 DGX Spark 上的 AI 团队操作系统。"

**画面：** 控制台首页 + 角色卡片 + 任务队列

---

#### Part B：治理与安全（35 秒）

**指令：** `请配置研究助理的记忆为向量数据库`

**画面：**
1. 飞书群发送指令 → 审批单弹出
2. 飞书卡片内联"批准/拒绝"按钮
3. 点击批准 → 审批状态变为"已通过"
4. 控制台审计面板显示操作记录

> "关键配置必须审批，所有动作可追踪。低/中风险自动批准，高风险人工审批。"

---

#### Part C：角色级能力边界（30 秒）

**指令：** `给 ceo 安装向量记忆 skill`

**画面：**
1. 控制台 Team State 面板，CEO skill 列表中新增 vector-memory
2. 其他角色（如 Product）skill 列表不变

> "能力按角色精确分配，不做全员泛化。CEO 有向量记忆，不代表产品经理也有。"

---

#### Part D：多角色协作（60 秒）

**指令：** `团队执行：做一个活动落地页`

**画面：**
1. 任务进入协作模式，多角色接力执行
2. PM 输出需求 → Frontend 输出实现方案 → QA 输出测试矩阵
3. 协作时间线展示各角色进度
4. 最终产出 deliverable + reflection

> "不是一个 agent 在回答问题，而是一个团队在协同交付。每个角色有明确职责，最终自动汇总。"

---

#### Part E：智能路由（30 秒）

**画面：** 快速展示两条指令的路由结果

1. `帮我做一个登录页，用 React 写` → 路由到 **Frontend**
2. `帮我写一个后端 API，实现用户注册` → 路由到 **Backend**

> "系统根据指令内容自动分派到最合适角色，无需手动指定。"

---

#### Part F：反思与质量（25 秒）

**画面：** 展示已完成任务的 reflection 面板

- Score / Confidence
- Assumptions / Risks / Improvements

> "每个任务完成后都会自动生成反思报告。包含质量评分、置信度、假设、风险和改进建议。这让 Owner 可以快速判断结果是否值得推进。"

---

#### Part G：收尾（15 秒）

> "飞书群是指挥室，DGX Spark 是 AI 总部。VinkoClaw 让一人团队具备企业级协同能力。"

**画面：** 控制台全景 + GitHub 仓库链接

---

### 八、仓库地址

**GitHub:** https://github.com/Farewell-CK/vinkoclaw

**License:** MIT

---

*提交于 NVIDIA DGX Spark Hackathon 2026.04*

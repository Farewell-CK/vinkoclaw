# VinkoClaw PRD v1

## 1. Problem

现有单 Agent 产品更像“一个助手”，而不是“一个团队”。它们通常缺少以下能力：

- 没有明确的团队分工，所有任务都挤在一个上下文里。
- 没有稳定的审批层，涉及外发消息、配置变更、风险操作时不够安全。
- 没有精确的 skill 绑定能力，给某个 Agent 安装能力时容易污染全部角色。
- 没有围绕 DGX Spark 这类本地超级计算机设计，难以突出本地算力与离线部署优势。

VinkoClaw 的目标不是做另一个聊天框，而是做一个“OPC AI 团队操作系统”。

## 2. Product Goal

用一台 DGX Spark 作为本地 AI 总部，用一个飞书群或本地控制台作为指挥室，让一个人管理一个 AI 团队，完成调研、架构、开发、运营、外联等完整闭环。

## 3. Target Users

- 一人公司创始人
- 开发者创业者
- 本地部署偏好用户
- 希望保留数据主权的知识工作者

## 4. Core Proposition

- 单一入口：飞书群和控制台作为统一指挥入口
- 团队分工：CEO / CTO / PM / UIUX / Frontend / Backend / Algorithm / QA（并保留 Engineering / Research 兼容角色）
- 团队分工：CEO / CTO / PM / UIUX / Frontend / Backend / Algorithm / QA / Developer（并保留 Engineering / Research / Operations 兼容角色）
- 本地优先：推理、知识库、状态库全部优先在本地运行
- 审批安全：配置变更、外发邮件等风险动作先审批再执行
- 反思能力：每个任务执行后都输出 assumptions、risks、improvements
- 精确技能：skill 按角色安装和启用，不再是单 Agent 全局共享
- 开发执行：Developer/Code Executor 任务可走 `opencode -> codex -> claude` 工具链并全程审计

## 5. MVP Scope

### Must Have

- 单飞书 Bot 接入能力
- 本地控制台 UI
- SQLite 状态层
- 任务队列与 Worker 执行链路
- 角色级 skill 绑定
- 运维指令解析
- 审批流
- 工具执行流（tool runs + 风险分级 + 批准后重入）
- 本地知识检索
- 本地模型接口：vLLM（OpenAI 兼容）主路由，SGLang / Ollama 可选兜底
- 无模型时 deterministic fallback，保证可运行验证

### Should Have

- 邮件草稿生成与审批发送
- 飞书异步回执
- 向量记忆配置变更

### Not In v1

- 多飞书 Bot 编排
- 长时工作流 DAG
- 多机调度
- 真正的向量数据库后端实现
- 复杂商业 CRM / ERP 集成

## 6. Key User Stories

1. 作为 owner，我可以在飞书群里说“请配置研究助理的记忆为向量数据库”，系统会生成审批单，批准后配置精确写入 research 角色。
2. 作为 owner，我可以说“给 CEO 安装向量记忆 skill”，系统只给 CEO Assistant 启用该 skill，而不会影响其他角色。
3. 作为 owner，我可以从控制台下发任务给某个角色，并看到其执行结果、引用上下文、反思输出。
4. 作为 owner，我可以让运营助理起草邮件，但最终发送前必须审批。
5. 作为 owner，我可以远程知道这台 DGX Spark 正在做什么、谁在做、还需要什么批准。

## 7. Feature Design

### 7.1 Team Roles

- CEO Assistant：目标、优先级、外联批准
- CTO Assistant：架构、路线、技术取舍
- Product Manager Assistant：需求拆解、验收标准、优先级
- UI/UX Assistant：界面信息架构、交互与视觉规范
- Frontend Assistant：前端实现、组件与体验优化
- Backend Assistant：API、数据模型、服务稳定性
- Algorithm Assistant：模型策略、推理参数、RAG权衡
- QA Assistant：测试矩阵、验收与发布风险
- Developer Assistant：代码实现、工具执行、落地交付
- Engineering Assistant（兼容）：通用开发执行
- Research Assistant（兼容）：通用调研与知识汇总
- Operations Assistant：邮件、内容、客户跟进

### 7.2 Skill System

Skill 不是全局装在一个 Agent 身上，而是三层结构：

- Team scope：全队共享能力
- Role scope：某一角色独享能力
- Agent scope：后续扩展给具体实例

当前 MVP 先实现 role scope。飞书消息会被解析成 operator action，审批后落到 skill binding 表。

### 7.3 Reflection System

每个任务输出除了结果，还必须产出：

- score
- confidence
- assumptions
- risks
- improvements

这部分是产品差异化点，因为它不只是“能做”，而是“知道自己哪里不确定”。

### 7.4 Approval System

以下操作默认审批：

- memory backend 变更
- skill 安装 / 停用
- 外发邮件
- 高风险代码执行（CTO 自动批准 + Owner 回退审批）

### 7.5 Routing Template System

任务路由采用模板驱动，可按业务阶段拆分多角色任务：

- 模板字段：`name`、`triggerKeywords`、`matchMode(any/all)`、`enabled`、`tasks[]`
- 子任务字段：`roleId`、`titleTemplate`、`instructionTemplate`、`priority`
- 占位符：`{{input}}`、`{{input_short}}`
- 管理方式：支持模板增删改查（CRUD），可按需启停

## 8. Success Metrics

- 10 分钟内完成一套端到端流程验证
- 飞书或控制台都能下发任务
- 至少 2 条 operator action 成功走完审批并生效
- 至少 1 条普通任务成功执行并写回反思结果
- 全部服务可在本地 DGX Spark 运行

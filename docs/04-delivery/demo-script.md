# Demo Script

## Demo Goal

用最短时间证明三件事：

1. 这是一个 AI 团队系统，不是单 Agent 聊天框。
2. 它能在 DGX Spark 上本地运行。
3. 它具备审批、安全、反思和角色级 skill 精确安装能力。

## Suggested 3-Minute Flow

### Part 1: Opening

- 展示 DGX Spark 本机
- 打开 VinkoClaw 控制台
- 说明多角色团队（PM/UI/前后端/算法/QA 等）和单飞书 Bot 入口

### Part 2: Operator Action

- 输入：`请配置研究助理的记忆为向量数据库`
- 展示自动生成审批单
- 点击审批
- 展示配置已生效

### Part 3: Skill Precision

- 输入：`给 ceo 安装向量记忆 skill`
- 审批通过
- 展示 CEO 角色 skill 列表变化，其他角色不变

### Part 4: Template Routing (Team Orchestration)

- 输入：`团队执行：为 OPC 控制台增加消息搜索功能`
- 展示模板自动拆分多角色任务（PM/UI/Frontend/Backend/Algorithm/QA）
- 展示任务队列中出现多个子任务并独立执行

### Part 5: Closing

- 总结“飞书群是指挥室，DGX Spark 是 AI 总部”
- 强调本地优先、角色协同、安全审批、一人公司场景

# Development Roadmap

## Phase 0: Running MVP

目标：先做出可演示主链。

- 本地控制台
- Orchestrator API
- Task Runner
- SQLite 状态层
- 角色 / skill / 审批 / 反思
- Feishu webhook
- Qwen 3.5 本地推理接口

## Phase 1: Hackathon Demo Polish

目标：冲击一等奖所需的完成度和展示度。

- 接入真实飞书群演示
- 配置本地 Qwen 3.5 模型
- 演示一条普通任务
- 演示一条 memory 配置变更
- 演示一条 skill 安装变更
- 演示一条邮件草稿 + 审批发送
- 控制台可视化优化
- 录制 3 分钟视频

## Phase 2: DGX Spark Differentiation

目标：把“这是 DGX Spark 才能做得好的产品”讲清楚。

- 更大的本地上下文窗口
- 多角色并行推理
- 本地向量库和长时记忆
- 文档 / 代码 / 邮件混合知识底座
- 长任务持续运行

## Phase 3: OPC Productization

目标：从黑客松项目走向真正的 OPC 产品。

- CRM / 邮件 / 日历 / 飞书群协同
- 客户线索与内容生产闭环
- 多项目工作台
- 可审计的商业运营流
- 插件市场与角色 skill 模板

## This Week Execution Priority

1. 已完成：vLLM + Qwen 3.5 (FP8) 接入与多模态/thinking 验证
2. 已完成：Developer 工具执行链（tool_runs + 风险审批 + dashboard）
3. 已完成：opencode + `zhipuai/glm-5` 接入与错误事件 fail-fast 处理
4. 已完成：渠道可观测性（`/api/channels/status` + 控制台 readiness 面板）
5. 进行中：飞书真实群演示打磨（多角色群内协同）
6. 待完成：项目说明文档与演示视频定稿

## Next Sprint (Tooling)

1. 增加 provider 健康检查与冷启动探针，避免不可用 provider 进入执行链
2. 把 tool-run 输出结构化（变更文件、测试结果、耗时）并用于评分面板
3. 补充 owner 一键重试/切换 provider 的控制台操作
4. 接入更强命令安全策略（命令模板白名单 + workspace 边界校验）
5. 加入真实 Feishu + SMTP 的自动化冒烟测试

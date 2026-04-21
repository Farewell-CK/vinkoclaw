# Development Roadmap

当前文档保留“原型交付阶段”的开发记录。

如果要看从 `0.0.1` 走向“个人创业者随身携带的 AI 执行团队”的产品路线，请优先参考：

- `docs/01-product/opc-ai-team-roadmap-v0.1.0.md`
- `docs/01-product/opc-ai-team-roadmap-v0.2.0.md`

## Phase 0: Running MVP

目标：先做出可运行主链。

- 本地控制台
- Orchestrator API
- Task Runner
- SQLite 状态层
- 角色 / skill / 审批 / 反思
- Feishu webhook
- Qwen 3.5 本地推理接口

## Phase 1: Reliability And UX Polish

目标：提升完成度、稳定性和可操作性。

- 接入真实飞书群联调
- 配置本地 Qwen 3.5 模型
- 验证一条普通任务
- 验证一条 memory 配置变更
- 验证一条 skill 安装变更
- 验证一条邮件草稿 + 审批发送
- 控制台可视化优化
- 录制 3 分钟功能讲解视频

## Phase 2: DGX Spark Differentiation

目标：把“这是 DGX Spark 才能做得好的产品”讲清楚。

- 更大的本地上下文窗口
- 多角色并行推理
- 本地向量库和长时记忆
- 文档 / 代码 / 邮件混合知识底座
- 长任务持续运行

## Phase 3: OPC Productization

目标：从原型走向长期可维护的 OPC 产品。

- CRM / 邮件 / 日历 / 飞书群协同
- 客户线索与内容生产闭环
- 多项目工作台
- 可审计的商业运营流
- 插件市场与角色 skill 模板

## This Week Execution Priority

1. 已完成：CEO 项目面板（目标 / 阶段 / 阻塞 / 下一步 / 团队 skill 就绪度）
2. 已完成：skill marketplace 生命周期（搜索 / 接入 / 安装 / 验证 / 推荐）
3. 已完成：协作恢复闭环（`await_user -> resume -> deliver`）
4. 进行中：Founder delivery loop 端到端冒烟验证
5. 待完成：workflow 快捷入口与更强的结果验收

## Next Sprint (Tooling)

1. 增加 provider 健康检查与冷启动探针，避免不可用 provider 进入执行链
2. 把 tool-run 输出结构化（变更文件、测试结果、耗时）并用于评分面板
3. 补充 owner 一键重试/切换 provider 的控制台操作
4. 接入更强命令安全策略（命令模板白名单 + workspace 边界校验）
5. 加入真实 Feishu + SMTP 的自动化冒烟测试

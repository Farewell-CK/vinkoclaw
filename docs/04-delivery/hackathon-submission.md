# VinkoClaw 黑客松提交说明草稿

VinkoClaw 是一个面向 NVIDIA DGX Spark 的本地优先 OPC AI 团队操作系统。它的出发点并不是再做一个聊天机器人，也不是再做一个只能单线程对话的 Agent，而是围绕“一人公司”这一真实商业形态，构建一个可以长期运行、可以审批、可以分工、可以远程指挥的 AI 团队系统。

项目的核心设定非常明确：飞书群是指挥室，DGX Spark 是 AI 总部。Owner 不再直接和一个全能助手反复对话，而是通过一个统一入口，把任务交给内部不同角色的 AI 成员完成。当前版本采用互联网团队细分角色：CEO、CTO、PM、UI/UX、Frontend、Backend、Algorithm、QA、Operations，并保留 Engineering / Research 兼容角色，覆盖从需求到上线的完整链路。

与 OpenClaw 一类单 Agent 框架相比，VinkoClaw 的创新点不在于“又加了多少工具”，而在于它把 AI 从“一个助手”升级成“一个团队”，并且明确解决了多角色系统在真实使用中最容易失控的几个痛点。

第一，VinkoClaw 引入了角色级 Skill 绑定机制。传统单 Agent 体系中，skill 安装后往往默认对整个 Agent 生效，能力边界非常模糊。VinkoClaw 把 skill 做成了可审计、可审批、可精确落到角色身上的配置模型。比如在飞书群里输入“给 CEO 安装向量记忆 skill”，系统不会把向量记忆能力扩散给所有成员，而是只给 CEO Assistant 生效，并写入 SQLite 状态库和审计日志。这种设计直接服务于 OPC 场景，因为一个人公司里的 AI 团队虽然由一个 Owner 管理，但不同岗位成员不应该拥有完全相同的能力边界。

第二，VinkoClaw 强调审批与安全。很多 Agent Demo 只展示“能不能做”，但真正可落地的系统必须回答“谁批准了这件事、配置何时变更、外部消息何时发送”。因此本项目把 memory backend 变更、skill 安装停用、邮件发送等高风险动作统一建模为 operator action，并要求先审批再执行。这个能力受到 NemoClaw / OpenShell 强安全思路的启发，但 VinkoClaw 将其产品化、可视化，并放进了 Owner 真正可操作的控制台里。

第三，VinkoClaw 不只输出结果，还输出反思。每个任务在完成后都会写回 reflection，包含 score、confidence、assumptions、risks、improvements。这个机制让系统天然具有复盘能力，也使 Owner 能快速判断一个结果是否值得继续推进。相比传统“回答完就结束”的助手，这种设计更接近一个会汇报、会自检、会承认不确定性的团队成员。

第四，项目充分体现了 DGX Spark 的平台定位。我们并没有把 DGX Spark 当成单纯的模型推理盒子，而是把它作为本地 AI 总部使用。编排服务、任务 Worker、知识库、状态库、本地模型接口都围绕单机闭环设计。推理层采用 vLLM 作为主后端（OpenAI 兼容 API），对接 Qwen 3.5-35B-A3B 的 FP8 量化版本；同时保留 SGLang / Ollama 作为可选兜底链路，在主后端异常时仍能维持可演示状态。即使模型服务暂时不可用，系统也会进入 deterministic fallback，确保产品链路、审批链路和控制台链路不因单点故障失效。

第五，场景上它天然贴合一人公司。我们没有强行捆绑工业数据，而是选择了一个更适合 DGX Spark 个人超级计算机场景的方向：个人创业者如何独立运营一个 AI 团队。这个方向既真实，也具备明显推广潜力。开发者创业者、研究者、内容运营者、小型顾问团队，都能通过 VinkoClaw 在本地完成调研、开发、汇报、邮件外联和运营指挥。

技术实现方面，系统采用 Node.js + TypeScript Monorepo 结构。`shared` 包负责环境、状态模型、SQLite、operator action 解析、协作时间线与 Agent 实例持久化；`agent-runtime` 负责角色 prompt、本地模型调用和结果结构化；`knowledge-base` 负责仓库文档和代码检索；`orchestrator` 负责 API、审批、飞书事件接入和控制台服务；`task-runner` 负责队列执行与多角色协作收敛；`email-inbound` 负责 IMAP 收件投递；`feishu-gateway` 负责飞书消息解析与回发。整个系统可以在本地单机部署，控制台可直接下发任务、查看审批、查看任务结果与反思。

在最新版本中，我们进一步补齐了“可执行 + 可观测”闭环：developer 角色可通过 opencode 调用 `glm-5` 执行代码型任务，并将 tool run（命令、风险等级、审批状态、输出）写入审计链路；协作流程新增 timeline 可观测接口，可从单入口看到多角色分配、进度、聚合与收敛状态；同时新增渠道就绪状态 API 与控制台面板，直接展示飞书/邮件缺失配置项，避免演示时出现“功能有但配置未完成”的黑盒状态。邮件审批后若 SMTP 未配置，会明确返回失败原因并写入审计事件，而不是静默失败。

本项目的核心亮点在于：它不是一个“看起来很厉害”的 Agent 演示，而是一套围绕 DGX Spark、围绕本地算力、围绕 OPC 商业模式、围绕多角色协同与安全审批而设计的可运行产品原型。它展示的不是 AI 替代某一个岗位，而是 AI 如何在一台个人超级计算机上，形成一个真正可以被 Owner 指挥和管理的团队。

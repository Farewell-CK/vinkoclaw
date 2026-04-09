# Model And Compute Plan

## Positioning

VinkoClaw 必须体现 DGX Spark 的平台价值，而不是把大部分能力外包给云端 API。

因此模型与算力策略采用：

- 本地优先
- 单机闭环
- 可演示可降级
- 优先兼容 Qwen 3.5

## Recommended Inference Stack

### Primary

- Backend: `vLLM` (OpenAI-compatible server)
- Model family: `Qwen 3.5`
- Recommended default in MVP: `Qwen3.5-35B-A3B` (FP8 quantized)

原因：

- 在 DGX Spark / GB10 上稳定性更好（当前优先使用官方 FP8 量化版本）
- OpenAI 兼容接口简单，易于快速集成到 VinkoClaw
- 可直接支持 256K 上下文，适合 OPC 多文档、多任务场景

### Fallback

- Backend: `SGLang` (optional)
- Model family: `Qwen 3.x / Qwen 3.5` (choose a locally supported variant)

原因：

- 作为替代推理栈，便于对比性能/稳定性
- 在 vLLM 服务不可用时，可以保住 Demo 链路（若已部署）

### Final Safety Net

- Deterministic fallback

原因：

- 就算模型当场没起来，审批、skill、任务、反思、控制台这些产品能力仍可完整演示

## DGX Spark Value Mapping

### 1. Local Multi-Agent Headquarters

不是把 DGX Spark 当成单个聊天模型运行器，而是当成：

- 编排中心
- 知识中心
- 模型推理中心
- 长任务运行中心

### 2. Privacy And Ownership

OPC 场景下，个人公司的文档、邮件、客户资料、代码资产都很敏感。本地机部署天然适合这个叙事。

### 3. High-End Personal Compute Narrative

参赛表达上，重点不是“又一个 Agent”，而是：

“把桌面级个人 Grace Blackwell AI 超级计算机，真正变成一人公司的 AI 总部。”

## Suggested Runtime Layout

- Orchestrator: Node.js
- Worker: Node.js
- State: SQLite
- Model serving: vLLM (OpenAI compatible)
- Optional fallback: SGLang / Ollama
- Knowledge: local workspace scan + later vector DB
- Channels: Feishu + Email

## Developer Tooling Model Route

在 V3 中，代码型任务（developer / engineering）采用“本地编排 + 工具执行模型”双层路线：

- 编排与审批：本地 VinkoClaw（DGX Spark）
- 代码工具执行：`opencode run --model zhipuai/glm-5`
- provider API: OpenAI-compatible (`https://open.bigmodel.cn/api/paas/v4`)

这样可以把“多角色团队编排、审计、审批”保留在本地，同时让代码执行助手具备更强代码理解能力。

## Current Deployment Notes (DGX Spark / GB10)

- Primary endpoint: `http://127.0.0.1:8000/v1`
- Served model name: `Qwen3.5-35B-A3B`
- Max context: `262144` (256K)
- vLLM container commonly needs: `--privileged` + `--security-opt seccomp=unconfined` (CUDA graph compile permissions on GB10)
- NVFP4 caveat: current environment has a known FP4 kernel issue on GB10; prefer FP8 for now

## Memory Strategy

### v1

- SQLite config + role-level memory backend policy
- 通过 operator action 把某个角色切到 `vector-db`

### v2

- 接入真正的本地向量数据库
- 每个角色独立 namespace
- 长时记忆按角色与项目隔离

## Environment Notes

- Python 环境建议使用 `conda`
- 模型网络拉取遇到问题可用 `clashon` / `clashoff`
- 建议将实际部署参数写入仓库根 `.env`

Minimal `.env` for vLLM integration:

- `PRIMARY_BACKEND=sglang` (kept for compatibility; treat as "primary OpenAI-compatible backend")
- `SGLANG_BASE_URL=http://127.0.0.1:8000/v1`
- `SGLANG_MODEL=Qwen3.5-35B-A3B`

## Demo Recommendation

比赛演示时，最好准备三种状态：

1. 完整本地推理开启
2. 只用本地编排与审批链
3. 无模型 fallback 演示

这样可以避免现场因为网络或模型服务波动而失去展示稳定性。

# VinkoClaw

> A local-first AI team operating system for NVIDIA DGX Spark.

One owner. One Feishu message. An AI team that plans, builds, and delivers — on your own machine.

[![Node.js](https://img.shields.io/badge/Node.js-18+-green)]()
[![TypeScript](https://img.shields.io/badge/TypeScript-5-blue)]()
[![License](https://img.shields.io/badge/License-MIT-yellow)]()

---

## What is VinkoClaw

VinkoClaw is **not another chatbot**. It's a multi-agent orchestration engine that lets you manage an AI team through Feishu (or a web console) — while all execution runs locally on a DGX Spark / GB10 machine.

```
You → Feishu Group Chat → VinkoClaw Orchestrator
                              ↓
                Intent Classification (LLM + keywords)
                              ↓
                Route to the right role:
                Product / Backend / Frontend / CTO / Research / QA / ...
                              ↓
                Task Runner executes with native tools
                (read → write → verify → deliver)
```

## Why It Matters

| | Traditional LLM Chat | VinkoClaw |
|---|---|---|
| **Execution** | Suggests code, you copy-paste | Writes files, runs tests, delivers artifacts |
| **Roles** | One generalist assistant | Specialized roles (CEO, CTO, Frontend, Backend, QA, Research...) |
| **Traceability** | Ephemeral conversation | Task records, collaboration timelines, approval audit trail |
| **Privacy** | Data leaves your machine | Local-first — models, knowledge, and execution stay on your hardware |
| **Channels** | Web UI only | Feishu group chat + web console + email |

## Core Features

### Intent & Routing

- **LLM-based intent classifier** with keyword fallback — correctly routes to `task`, `goalrun`, `collaboration`, or `operator_config`
- **12 role types** with scoped prompts: CEO, CTO, Product, Frontend, Backend, Engineering, Developer, QA, Research, Algorithm, UI/UX, Operations
- **Routing templates** — predefined multi-task workflows (e.g., "internet launch")
- **Smalltalk detection** — greetings and chitchat don't create tasks

### Task Execution

- **Native tool pipeline** — `run_code`, `write_file`, `read_file` — no external CLI dependency
- **Read → Write → Verify → Deliver** workflow enforced in role prompts
- **Risk-graded tool execution** — CTO auto-approval + owner fallback for high-risk operations
- **Approval-gated operator actions** — config changes, model switches, agent management

### Multi-Agent Collaboration

- **Goal Run** — end-to-end autonomous pipeline for complex projects
- **Collaboration mode** — multi-role task execution with virtual teammates per role
- **Collaboration timeline** — persistent query API for process trajectory
- **Team management** — add/remove agent instances, adjust tone policy

### Channels & Integrations

- **Feishu** (primary) — group chat, webhooks, approval cards, interactive buttons
- **Web console** — dashboard at `http://127.0.0.1:8098` with queue metrics, SLA alerts, channel status
- **Email** (optional) — IMAP inbound with whitelist, prefix dedup, rate limiting

### Local-First Inference

- **SGLang / vLLM** — Qwen3.5-35B-A3B on local DGX Spark
- **Deterministic fallback** — system remains functional when model backend is unavailable
- **Thinking model support** — `enable_thinking: false` for latency-critical paths (classification, tool calling)
- **Multi-backend** — SGLang, Zhipu API, Ollama

## Quick Start

### Prerequisites

- Node.js 18+
- NVIDIA DGX Spark / GB10 (or any machine with model access)
- SGLang / vLLM serving Qwen3.5-35B-A3B (optional — system degrades gracefully)

### Setup

```bash
# 1. Clone
git clone git@github.com:Farewell-CK/vinkoclaw.git
cd vinkoclaw

# 2. Install
npm install

# 3. Configure
cp config/.env.example .env
# Edit .env — at minimum set your model backend URL

# 4. Run
npm run dev

# 5. Open console
# http://127.0.0.1:8098
```

### Feishu Integration

For Feishu webhook callbacks, configure your Feishu app with one of:

- `/api/feishu/events` (primary)
- `/feishu/events` (compatibility)
- `/api/channels/feishu/events` (compatibility)

Expose port `8098` to a public address if running in a constrained network.

## Example Commands

Try these in Feishu or the web console:

| Command | What Happens |
|---|---|
| `你好` | Instant greeting reply, no task created |
| `帮我写个用户登录功能的PRD` | Routes to **Product** role |
| `帮我做一个登录页，用React写` | Routes to **Frontend** role |
| `帮我写一个后端API，实现用户注册，用Node.js` | Routes to **Backend** role |
| `帮我分析一下具身智能的市场现状和发展趋势` | Routes to **Research** role |
| `我们系统的技术架构该如何设计` | Routes to **CTO** role |
| `团队执行：做一个带登录和仪表盘的SaaS MVP` | Triggers **multi-agent collaboration** mode |
| `请配置研究助理的记忆为向量数据库` | Operator config flow with approval |
| `暂停模板 tpl-opc-internet-launch` | Template management command |

## Architecture

```
apps/
  feishu-gateway/      Feishu webhook receiver
  control-center/      Web dashboard + console

services/
  orchestrator/        Central routing, intent classification, task queue
  task-runner/         Parallel task execution with native tools
  email-inbound/       IMAP email processing (optional)

packages/
  agent-runtime/       LLM inference, tool calling, thinking model support
  knowledge-base/      Workspace knowledge retrieval
  shared/              Auth, plugins, observability, operator actions
  plugin-sdk/          Plugin system for extensions

prompts/
  roles/               12 role-scoped system prompts
```

## Key Documents

- [Product Definition](docs/01-product/project-definition.md)
- [Runtime Flow](docs/02-architecture/runtime-flow.md)
- [OpenClaw vs NemoClaw](docs/03-research/openclaw-vs-nemoclaw.md)
- [Model Compute Plan](docs/04-delivery/model-compute-plan.md)
- [Development Roadmap](docs/04-delivery/development-roadmap.md)

## License

MIT

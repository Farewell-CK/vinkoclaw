# Agent Harness Research Report

**Date:** 2026-04-15

---

## Executive Summary

"Agent Harness" has emerged as a distinct engineering discipline in the AI industry, separate from both Agent Frameworks and Agent Runtimes. The term was popularized primarily by OpenAI (Codex harness engineering), Anthropic (effective harnesses for long-running agents), and LangChain (The Anatomy of an Agent Harness). The core insight is that **the model provides intelligence, but the harness determines production reliability**.

---

## 1. What is "Agent Harness"?

### Definition

An **Agent Harness** is the complete infrastructure that wraps around an LLM to make it a functional, production-ready agent. It provides the agent with **hands, eyes, memory, and safety boundaries**.

The canonical equation from the OpenHarness project:

```
Harness = Tools + Knowledge + Observation + Action Interfaces + Permissions
```

### Seminal Articles That Defined the Discipline

| Source | Article | Key Contribution |
|--------|---------|------------------|
| [OpenAI](https://openai.com/index/harness-engineering/) | Harness Engineering: Leveraging Codex in an Agent-First World | Coined "harness engineering" -- architectural constraints, repo-local prompts, browser validation, telemetry |
| [Anthropic](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) | Effective Harnesses for Long-Running Agents | Initializer agents, feature lists, self-verification, handoff artifacts |
| [Anthropic](https://www.anthropic.com/engineering/harness-design-long-running-apps) | Harness Design for Long-Running App Development | GAN-style generator/evaluator multi-agent loop |
| [Anthropic](https://www.anthropic.com/research/building-effective-agents) | Building Effective Agents | Workflows vs. agents distinction, composable patterns |
| [LangChain](https://blog.langchain.com/the-anatomy-of-an-agent-harness/) | The Anatomy of an Agent Harness | First-principles derivation: prompts, tools, middleware, orchestration, runtime |
| [LangChain](https://blog.langchain.com/agent-frameworks-runtimes-and-harnesses-oh-my/) | Agent Frameworks, Runtimes, and Harnesses, Oh My! | Explicit decomposition of framework vs. runtime vs. harness |
| [Thoughtworks/Martin Fowler](https://martinfowler.com/articles/exploring-gen-ai/harness-engineering.html) | Harness Engineering | Context engineering, architectural constraints, "garbage collection" |
| [Inngest](https://www.inngest.com/blog/your-agent-needs-a-harness-not-a-framework) | Your Agent Needs a Harness, Not a Framework | State, retries, traces, concurrency as first-class infrastructure |
| [HumanLayer](https://www.humanlayer.dev/blog/skill-issue-harness-engineering-for-coding-agents) | Skill Issue: Harness Engineering for Coding Agents | Weak results are harness problems, not model problems |

### The Evolution: Prompt -> Context -> Harness

The industry narrative describes three eras:
1. **Prompt Engineering** (2023-2024): Crafting individual prompts
2. **Context Engineering** (2024-2025): Managing what goes into the context window
3. **Harness Engineering** (2025-2026): Full infrastructure around agents for production reliability

---

## 2. How Major Frameworks Implement the "Harness" Pattern

### OpenAI Agents SDK (openai/openai-agents-python)
- **Stars:** Provider-agnostic, supports 100+ LLMs
- **Harness approach:** Lightweight SDK with agent-to-agent handoffs, tools (functions, MCP, hosted tools), guardrails, human-in-the-loop, session management, tracing
- **Key insight:** "Agents as tools" pattern -- delegation through handoffs, not graph wiring
- **Dependencies:** Pydantic, MCP Python SDK

### LangChain Deep Agents (langchain-ai/deepagents) -- 20,797 stars
- **Positioning:** "The batteries-included agent harness"
- **Harness components:** Planning (write_todos), Filesystem (read/write/edit/ls/glob/grep), Shell access, Sub-agents, Context auto-summarization
- **Architecture:** Returns a compiled LangGraph graph natively
- **Philosophy:** Working agent immediately; customize what you need

### LangGraph (langchain-ai/langgraph)
- **Harness approach:** State-machine based orchestration with checkpointers, streaming, persistence
- **Components:** Graph-based workflow, state management, human-in-the-loop, parallel execution
- **Deep Agents sits on top as the opinionated harness layer**

### CrewAI
- **Harness approach:** Role-based multi-agent teams with task assignment
- **Components:** Agent roles, task definitions, process orchestration (sequential, hierarchical, consensual)
- **Focus:** Team collaboration patterns over single-agent deep work

### Vercel AI SDK
- **Harness approach:** Provider-agnostic TypeScript SDK for building AI applications
- **Components:** Tool calling, streaming, UI integration, middleware
- **Note:** Not explicitly branded as a "harness" but implements harness patterns

### Google ADK (Agent Development Kit)
- **Website:** https://adk.dev/
- **Harness approach:** Tiered state architecture (Session, Memory, Artifacts)
- **Focus:** Context-aware multi-agent framework for production
- **Key:** Agent-to-Agent (A2A) protocol support

### AWS Bedrock AgentCore SDK (aws/bedrock-agentcore-sdk-python)
- **Stars:** 682
- **Harness approach:** Framework-agnostic primitives for runtime, memory, authentication, and tools
- **Services:** Runtime (compute), Memory (persistent), Gateway (MCP), Code Interpreter (sandbox), Browser (automation), Observability (OpenTelemetry), Identity (auth)
- **Protocols:** AG-UI protocol, A2A protocol
- **Philosophy:** "Keep your agent logic, zero infrastructure management"

---

## 3. Components of an Agent Harness

Based on analysis across all sources, an Agent Harness consists of:

### Core Components (Universal)
1. **Tool Layer** -- File I/O, shell execution, API calls, browser control, database queries, MCP servers
2. **Context/Memory Engine** -- Persistent memory, session state, context compression, working memory management
3. **Orchestration/Loop** -- The agent loop (LLM -> tool_use -> execute -> repeat), parallel execution, sub-agent spawning
4. **Permissions/Governance** — Sandboxing, approval workflows, trust boundaries, path/command rules, PreToolUse/PostToolUse hooks
5. **Observability** -- Tracing, logging, token counting, cost tracking, telemetry

### Production-Grade Additions
6. **Planning System** -- Task breakdown, todo tracking, progress monitoring
7. **Error Recovery** -- Retry with exponential backoff, self-healing, circuit breakers
8. **Human-in-the-Loop** -- Approval gates, interactive dialogs, HITL checkpoints
9. **Knowledge Base** -- Product docs, domain references, RAG, CLAUDE.md/AGENTS.md discovery
10. **State Persistence** -- Checkpointing, session resume, crash recovery
11. **Multi-Agent Coordination** -- Sub-agent isolation, team registry, async mailboxes, handoff artifacts

### Infrastructure Layer
12. **Sandboxing** -- Secure execution environments, filesystem isolation, git worktrees
13. **Deployment** -- Server/container management, scaling, load balancing
14. **Evaluation** -- Testing frameworks, benchmarks, quality gates

---

## 4. Agent Harness vs. Agent Framework vs. Agent Runtime

These three terms are distinct but overlapping:

| Dimension | Agent Framework | Agent Runtime | Agent Harness |
|-----------|----------------|---------------|---------------|
| **Purpose** | Build agents (APIs, abstractions) | Run agents (execution environment) | Wrap agents (production infrastructure) |
| **Examples** | LangChain, Langroid, OpenAI Agents SDK | LangGraph executor, Bedrock AgentCore Runtime | Deep Agents, Hive, OpenHarness, Water |
| **Focus** | Developer experience, composability | Execution, scaling, persistence | Reliability, safety, production-readiness |
| **Analogy** | Car engine | Car transmission | Car body + safety systems + dashboard |
| **Key concern** | How to define agents | How to execute agents | How to make agents trustworthy |

**The LangChain framing** (from "Agent Frameworks, Runtimes, and Harnesses, Oh My!"):
- **Framework:** Provides the building blocks (prompts, tools, chains, agents)
- **Runtime:** Provides the execution environment (state management, checkpointing, streaming)
- **Harness:** Provides the production wrapper (observability, guardrails, recovery, deployment)

**The OpenHarness framing:**
> "The model provides intelligence; the harness provides hands, eyes, memory, and safety boundaries."

**The learn-claude-code framing:**
> "Agency comes from the model. An agent product = Model + Harness."

---

## 5. Open Source "Agent Harness" Projects

### Explicitly Branded as "Harness"

| Project | Stars | Language | Description |
|---------|-------|----------|-------------|
| [langchain-ai/deepagents](https://github.com/langchain-ai/deepagents) | 20,797 | Python | "The batteries-included agent harness" -- planning, filesystem, shell, sub-agents, context management |
| [emcie-co/parlant](https://github.com/emcie-co/parlant) | 17,929 | Python | Agentic harness for customer-facing AI conversational control |
| [aden-hive/hive](https://github.com/aden-hive/hive) | 10,235 | Python | Multi-Agent Harness for Production AI -- state management, failure recovery, observability |
| [HKUDS/OpenHarness](https://github.com/HKUDS/OpenHarness) | 9,755 | Python | Open Agent Harness with built-in personal agent -- tool-use, skills, memory, multi-agent coordination |
| [mindfold-ai/Trellis](https://github.com/mindfold-ai/Trellis) | 5,407 | TypeScript | Multi-platform AI coding framework that rules -- supports 13 AI coding platforms |
| [lobehub/lobehub](https://github.com/lobehub/lobehub) | 75,203 | TypeScript | Agent teammates that grow with you -- multi-agent collaboration, MCP marketplace |
| [shareAI-lab/learn-claude-code](https://github.com/shareAI-lab/learn-claude-code) | 53,654 | TypeScript | Nano claude code-like "agent harness", built from 0 to 1 |
| [ModelEngine-Group/nexent](https://github.com/ModelEngine-Group/nexent) | 4,326 | Python | Zero-code platform using Harness Engineering principles |
| [langroid/langroid](https://github.com/langroid/langroid) | 3,969 | Python | "Harness LLMs with Multi-Agent Programming" -- Actor model, not LangChain-based |
| [affaan-m/everything-claude-code](https://github.com/affaan-m/everything-claude-code) | 156,797 | JavaScript | Agent harness performance optimization system |

### Infrastructure/Support (Harness-Adjacent)

| Project | Stars | Description |
|---------|-------|-------------|
| [MemoriLabs/Memori](https://github.com/MemoriLabs/Memori) | 13,293 | Agent-native memory infrastructure |
| [aws/bedrock-agentcore-sdk-python](https://github.com/aws/bedrock-agentcore-sdk-python) | 682 | Framework-agnostic primitives for runtime, memory, auth, tools |
| [manthanguptaa/water](https://github.com/manthanguptaa/water) | 277 | Production-ready agent harness framework for Python |
| [SethGammon/Citadel](https://github.com/SethGammon/Citadel) | 497 | Agent orchestration harness for Claude Code |
| [Jiaaqiliu/Awesome-Harness-Engineering](https://github.com/Jiaaqiliu/Awesome-Harness-Engineering) | 29 | Curated resource list for harness engineering |
| [dawei008/openbook](https://github.com/dawei008/openbook) | 6 | Open-source book on building production-grade Agent Harnesses (26 chapters) |

---

## 6. Key Industry Insights

### 6.1 "The Harness is the Differentiator"
As models converge in capability, the harness becomes the competitive moat. Multiple sources (Phil Schmid, Louis Bouchard, HumanLayer) argue that agent reliability depends more on harness quality than model choice.

### 6.2 CPU-OS Analogy
- **Model = CPU** (provides compute/intelligence)
- **Context Window = RAM** (working memory)
- **Harness = Operating System** (manages resources, provides interfaces)
- **Agent = Application** (the end-user-facing product)

(Source: [Parallel.ai](https://parallel.ai/articles/what-is-an-agent-harness), [Phil Schmid](https://www.philschmid.de/agent-harness-2026))

### 6.3 From DIY to Product
Agent harnesses are evolving from ad-hoc patterns (custom scripts, prompt chains) to productized platforms (Deep Agents, Hive, Nexent, Trellis). The trend is toward **batteries-included, opinionated, ready-to-run** harnesses.

### 6.4 Model-First Philosophy
The learn-claude-code repo articulates a strong position: "Agency comes from model training, not from external code orchestration." This contrasts with the "prompt plumbing" approach of workflow builders. The harness engineer's job is to **build the world the intelligence inhabits**, not to write the intelligence itself.

### 6.5 Universal Patterns
Across all harness projects, the same patterns emerge:
- Agent loop (LLM -> tool_use -> execute -> repeat)
- Tool abstraction (atomic, composable, well-described)
- Context management (on-demand loading, compression, isolation)
- Permission governance (sandboxing, approval, trust boundaries)
- Memory persistence (session state, cross-session continuity)
- Multi-agent coordination (sub-agents, handoffs, isolation)

### 6.6 AG-UI and A2A Protocols
Two emerging standard protocols:
- **AG-UI Protocol:** Standardized agent UI interaction (SSE + WebSocket)
- **A2A Protocol (Agent-to-Agent):** Standardized inter-agent communication (Google-led)

Both are supported by AWS Bedrock AgentCore and gaining adoption.

---

## 7. Recommended Reading List

1. [OpenAI: Harness Engineering](https://openai.com/index/harness-engineering/) -- The article that coined the term
2. [Anthropic: Effective Harnesses for Long-Running Agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) -- Practical patterns
3. [LangChain: The Anatomy of an Agent Harness](https://blog.langchain.com/the-anatomy-of-an-agent-harness/) -- First-principles breakdown
4. [LangChain: Agent Frameworks, Runtimes, and Harnesses, Oh My!](https://blog.langchain.com/agent-frameworks-runtimes-and-harnesses-oh-my/) -- Taxonomy
5. [Martin Fowler: Harness Engineering](https://martinfowler.com/articles/exploring-gen-ai/harness-engineering.html) -- Engineering discipline framing
6. [Inngest: Your Agent Needs a Harness, Not a Framework](https://www.inngest.com/blog/your-agent-needs-a-harness-not-a-framework) -- Infrastructure-first argument
7. [Awesome Harness Engineering](https://github.com/Jiaaqiliu/Awesome-Harness-Engineering) -- Comprehensive resource collection

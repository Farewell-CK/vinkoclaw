import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getRoleProfile,
  loadEnv,
  type Citation,
  type ReflectionNote,
  type RoleId,
  type RuntimeConfig,
  type SkillBindingRecord,
  type TaskAttachment,
  type TaskRecord,
  type TaskResult
} from "@vinko/shared";
import {
  buildToolDefinitions,
  buildWorkDir,
  collectArtifactFiles,
  executeTool,
  type ToolContext,
  type ToolDefinition
} from "./tool-executor.js";
import {
  buildRuntimeCapabilitySnapshot,
  createDefaultRegistry,
  createToolBackedRegistry,
  ToolRegistry
} from "./tool-registry.js";
import {
  createDefaultRulesEngine,
  RulesEngine
} from "./rules-engine.js";
export { buildRuntimeCapabilitySnapshot, createDefaultRegistry, createToolBackedRegistry, ToolRegistry } from "./tool-registry.js";
export { createDefaultRulesEngine, RulesEngine } from "./rules-engine.js";
import {
  TelemetryCollector,
  globalTelemetry,
  initGlobalTelemetry,
  summarizeModelInput,
  summarizeModelOutput,
  summarizeToolArguments,
  summarizeToolOutput
} from "./telemetry.js";
export { globalTelemetry, TelemetryCollector, initGlobalTelemetry } from "./telemetry.js";
import { WorkspaceKnowledgeBase, type KnowledgeSnippet } from "@vinko/knowledge-base";

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const PROMPTS_ROOT = path.join(PROJECT_ROOT, "prompts", "roles");

export interface TaskContextSnippet extends Citation {
  score?: number;
}

export interface RuntimeExecutionInput {
  task: TaskRecord;
  config: RuntimeConfig;
  skills: SkillBindingRecord[];
  snippets: TaskContextSnippet[];
  /** Optional tool context — enables function calling loop */
  toolContext?: ToolContext;
  /**
   * Optional tool registry for discovering and executing tools.
   * Falls back to built-in tools (web_search, run_code, write_file) if not provided.
   */
  toolRegistry?: ToolRegistry;
  /**
   * Optional rules engine for tool execution safety.
   * Falls back to built-in safety rules if not provided.
   */
  rulesEngine?: RulesEngine;
  /**
   * Optional telemetry collector for runtime observability.
   * If provided, every LLM turn and tool call is recorded to the trace.
   */
  telemetry?: TelemetryCollector;
  /**
   * Optional knowledge base for context injection.
   * If provided, relevant documents are retrieved and injected into the system prompt.
   */
  knowledgeBase?: WorkspaceKnowledgeBase;
  /**
   * Prior conversation turns from the same session, ordered oldest-first.
   * Injected as real user/assistant message pairs before the current task message,
   * giving the model genuine multi-turn coherence instead of JSON snippets.
   */
  conversationHistory?: Array<{ role: "user" | "assistant"; content: string }>;
  /**
   * If true, perform a lightweight planning step before execution.
   * The planning step analyzes what the task needs and identifies missing information.
   * If missing info is found, returns early with needsInput: true.
   */
  preExecutePlan?: boolean;
  /**
   * Workspace context from cross-session memory.
   * Injected into system prompt for continuity across conversations.
   */
  workspaceContext?: {
    preferredTechStack?: string[];
    communicationStyle?: "concise" | "detailed" | "default";
    activeProjects?: Array<{ name: string; stage: string; lastUpdate: string }>;
    keyDecisions?: Array<{ decision: string; rationale: string; timestamp: string }>;
    founderProfile?: {
      businessDomains?: string[];
      targetUsers?: string[];
      deliverablePreferences?: string[];
      decisionStyle?: "action_first" | "evidence_first" | "balanced";
      feedbackSignals?: Array<{ signal: string; note: string; taskId?: string; createdAt: string }>;
    };
  };
}

export interface RuntimeExecutionOutput {
  result: TaskResult;
  reflection: ReflectionNote;
  backendUsed: "sglang" | "ollama" | "zhipu" | "openai" | "dashscope" | "fallback";
  modelUsed: string;
  /** Files produced by tool execution during this task */
  artifactFiles: string[];
  /** Set when preExecutePlan found missing information */
  needsInput?: boolean;
  missingFields?: string[];
}

interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: ModelMessageContent | null;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}

interface ModelCompletion {
  text: string;
  backendUsed: "sglang" | "ollama" | "zhipu" | "openai" | "dashscope" | "fallback";
  modelUsed: string;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: unknown;
      reasoning?: unknown;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason?: string;
  }>;
}

interface ChatCompletionMessage {
  content?: unknown;
  reasoning?: unknown;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}

interface TextContentPart {
  type: "text";
  text: string;
}

interface ImageContentPart {
  type: "image_url";
  image_url: {
    url: string;
    detail?: "auto" | "low" | "high";
  };
}

interface VideoContentPart {
  type: "video_url";
  video_url: {
    url: string;
  };
}

type ModelMessageContentPart = TextContentPart | ImageContentPart | VideoContentPart;
type ModelMessageContent = string | ModelMessageContentPart[];

function parseModelContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((entry) => {
        if (typeof entry === "string") {
          return entry;
        }

        if (typeof entry === "object" && entry) {
          if ("text" in entry && typeof entry.text === "string") {
            return entry.text;
          }

          if ("type" in entry && entry.type === "output_text" && "text" in entry && typeof entry.text === "string") {
            return entry.text;
          }
        }

        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  return "";
}

function stringifyMessageContent(content: ModelMessageContent | null): string {
  if (!content) return "";
  if (typeof content === "string") {
    return content;
  }

  return content
    .map((part) => {
      if (part.type === "text") {
        return part.text;
      }

      if (part.type === "image_url") {
        return `[image] ${part.image_url.url}`;
      }

      return `[video] ${part.video_url.url}`;
    })
    .join("\n");
}

function parseAttachments(task: TaskRecord): TaskAttachment[] {
  const rawAttachments = task.metadata.attachments;
  if (!Array.isArray(rawAttachments)) {
    return [];
  }

  return rawAttachments
    .map((entry) => {
      if (typeof entry !== "object" || entry === null) {
        return undefined;
      }

      const kind = "kind" in entry ? entry.kind : undefined;
      const url = "url" in entry ? entry.url : undefined;
      const detail = "detail" in entry ? entry.detail : undefined;
      const name = "name" in entry ? entry.name : undefined;

      if ((kind !== "image" && kind !== "video") || typeof url !== "string" || !url.trim()) {
        return undefined;
      }

      const normalized: TaskAttachment = {
        kind,
        url: url.trim()
      };

      if ((detail === "auto" || detail === "low" || detail === "high") && kind === "image") {
        normalized.detail = detail;
      }

      if (typeof name === "string" && name.trim()) {
        normalized.name = name.trim();
      }

      return normalized;
    })
    .filter((entry): entry is TaskAttachment => Boolean(entry));
}

async function buildUserMessageContent(task: TaskRecord, contextBlock: string): Promise<ModelMessageContent> {
  const textBlock = [
    `Task title: ${task.title}`,
    `Task instruction:\n${task.instruction}`,
    "",
    "Relevant local context:",
    contextBlock,
    "",
    "Be concrete. Cite local files in citations when they influenced the answer."
  ].join("\n");

  const attachments = parseAttachments(task);
  if (attachments.length === 0) {
    return textBlock;
  }

  const content: ModelMessageContentPart[] = [
    {
      type: "text",
      text: [
        textBlock,
        "",
        "Attachments:",
        ...attachments.map((attachment, index) => {
          const label = attachment.name ? ` (${attachment.name})` : "";
          return `${index + 1}. ${attachment.kind}: ${attachment.url}${label}`;
        })
      ].join("\n")
    }
  ];

  for (const attachment of attachments) {
    if (attachment.kind === "image") {
      let finalUrl = attachment.url;
      if (finalUrl.startsWith("file://")) {
        try {
          const filePath = fileURLToPath(finalUrl);
          const buffer = await readFile(filePath);
          const ext = path.extname(filePath).toLowerCase().replace(".", "") || "png";
          const mimeType = ext === "jpg" ? "jpeg" : ext;
          finalUrl = `data:image/${mimeType};base64,${buffer.toString("base64")}`;
        } catch (e) {
          // ignore fallback
        }
      }
      content.push({
        type: "image_url",
        image_url: {
          url: finalUrl,
          ...(attachment.detail ? { detail: attachment.detail } : {})
        }
      });
      continue;
    }

    content.push({
      type: "video_url",
      video_url: {
        url: attachment.url
      }
    });
  }

  return content;
}

function stripCodeFence(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]+?)\s*```$/i);
  return match?.[1]?.trim() ?? trimmed;
}

function clampScore(value: unknown, fallback = 3): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(1, Math.min(10, Math.round(parsed)));
}

function extractFirstJsonObject(raw: string): string | undefined {
  const source = raw.trim();
  if (!source) {
    return undefined;
  }

  const firstBrace = source.indexOf("{");
  if (firstBrace < 0) {
    return undefined;
  }

  let depth = 0;
  let inString = false;
  let escaping = false;
  for (let index = firstBrace; index < source.length; index += 1) {
    const char = source[index];
    if (escaping) {
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(firstBrace, index + 1);
      }
    }
  }

  return undefined;
}

function toNonEmptyText(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (value && typeof value === "object") {
    try {
      return JSON.stringify(value, null, 2).trim();
    } catch {
      return "";
    }
  }

  return "";
}

function normalizeCitations(value: unknown): Citation[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => {
      if (typeof entry === "string") {
        return {
          path: "model-output",
          excerpt: entry
        };
      }

      if (typeof entry === "object" && entry) {
        const path = "path" in entry ? toNonEmptyText(entry.path) : "";
        const excerpt = "excerpt" in entry ? toNonEmptyText(entry.excerpt) : "";
        if (path || excerpt) {
          return {
            path: path || "model-output",
            excerpt: excerpt || path
          };
        }
      }

      return undefined;
    })
    .filter((entry): entry is Citation => Boolean(entry));
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((entry) => toNonEmptyText(entry)).filter(Boolean);
}

function safeParseTaskResponse(raw: string): { result: TaskResult; reflection: ReflectionNote } | undefined {
  const cleaned = stripCodeFence(raw);
  if (!cleaned) {
    return undefined;
  }

  const tryParseObject = (input: string): Record<string, unknown> | undefined => {
    try {
      const parsed = JSON.parse(input) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  };

  const parsed =
    tryParseObject(cleaned) ??
    (() => {
      const candidate = extractFirstJsonObject(cleaned);
      return candidate ? tryParseObject(candidate) : undefined;
    })();

  if (!parsed) {
    const normalizedRaw = cleaned.trim();
    if (!normalizedRaw) {
      return undefined;
    }
    return {
      result: {
        summary: "Model output required JSON normalization",
        deliverable: normalizedRaw,
        citations: [],
        followUps: []
      },
      reflection: {
        score: 3,
        confidence: "medium",
        assumptions: [],
        risks: ["The model output was not valid JSON and was preserved as plain text."],
        improvements: ["Prefer strict JSON-only output for this role prompt."]
      }
    };
  }

  const reflectionRaw =
    parsed.reflection && typeof parsed.reflection === "object" && !Array.isArray(parsed.reflection)
      ? (parsed.reflection as Record<string, unknown>)
      : {};
  const deliverableText = toNonEmptyText(parsed.deliverable);
  const summaryText =
    toNonEmptyText(parsed.summary) ||
    (deliverableText ? deliverableText.slice(0, 120) : "Model response normalized");

  const confidenceRaw = toNonEmptyText(reflectionRaw.confidence).toLowerCase();
  const confidence =
    confidenceRaw === "low" || confidenceRaw === "medium" || confidenceRaw === "high"
      ? confidenceRaw
      : "medium";

  const assumptions = normalizeStringList(reflectionRaw.assumptions);
  const risks = normalizeStringList(reflectionRaw.risks);
  const improvements = normalizeStringList(reflectionRaw.improvements);

  const safeDeliverable = deliverableText || cleaned;
  if (!safeDeliverable.trim()) {
    return undefined;
  }

  return {
    result: {
      summary: summaryText,
      deliverable: safeDeliverable,
      citations: normalizeCitations(parsed.citations),
      followUps: normalizeStringList(parsed.followUps)
    },
    reflection: {
      score: clampScore(reflectionRaw.score),
      confidence,
      assumptions,
      risks,
      improvements
    }
  };
}

async function loadRolePrompt(roleId: RoleId): Promise<string> {
  try {
    return await readFile(path.join(PROMPTS_ROOT, `${roleId}.md`), "utf8");
  } catch {
    const profile = getRoleProfile(roleId);
    return `${profile.name}\n\n${profile.responsibility}`;
  }
}

const SYSTEM_PROMPT_VERSION = "v2.1-layered-2026-04-02";

function resolvePreferredLanguage(task: TaskRecord): "zh-CN" | "en-US" {
  const sample = `${task.title}\n${task.instruction}`;
  return /[\u4e00-\u9fff]/.test(sample) ? "zh-CN" : "en-US";
}

function buildLayeredSystemPrompt(input: {
  rolePrompt: string;
  profileName: string;
  skillList: string;
  memoryBackend: string;
  preferredLanguage: "zh-CN" | "en-US";
  availableTools?: string[];
  workspaceContext?: {
    preferredTechStack?: string[];
    communicationStyle?: "concise" | "detailed" | "default";
    activeProjects?: Array<{ name: string; stage: string; lastUpdate: string }>;
    keyDecisions?: Array<{ decision: string; rationale: string; timestamp: string }>;
    founderProfile?: {
      businessDomains?: string[];
      targetUsers?: string[];
      deliverablePreferences?: string[];
      decisionStyle?: "action_first" | "evidence_first" | "balanced";
      feedbackSignals?: Array<{ signal: string; note: string; taskId?: string; createdAt: string }>;
    };
  };
  knowledgeBlock?: string;
}): string {
  const toolSection =
    input.availableTools && input.availableTools.length > 0
      ? [
          "",
          "## Available Tools",
          "You have function-calling tools you MUST use proactively instead of producing text-only answers:",
          ...input.availableTools.map((t) => `- ${t}`),
          "Guidelines:",
          "- Use `run_code` (python/bash) for ANY computation, file generation (PDF, Excel, CSV, images), data processing, or installing packages. Do NOT describe code — run it.",
          "- Use `web_search` whenever you need real-time information, current docs, prices, news, or anything beyond training data.",
          "- Use `write_file` to persist deliverable text artifacts. Default to Markdown (.md) for documents and reports; use JSON for data; use CSV for tabular data. Only use HTML/CSS/JS when the task explicitly requires a web page.",
          "- If the user asks for a document, report, PRD, brief, or file deliverable, you MUST save it with `write_file` instead of returning prose only.",
          "- Chain tools across multiple rounds: search → run code → write file.",
          "- If a tool does not exist for a task, write Python code that implements it via `run_code`.",
          "- After all tool work is complete, emit the final JSON output contract."
        ].join("\n")
      : "";

  const workspaceSection = input.workspaceContext
    ? [
        "",
        "## Workspace Context (Cross-Session Memory)",
        "The following context persists across conversations. Use it to maintain continuity.",
        ...(input.workspaceContext.preferredTechStack && input.workspaceContext.preferredTechStack.length > 0
          ? [`Preferred tech stack: ${input.workspaceContext.preferredTechStack.join(", ")}`]
          : []),
        ...(input.workspaceContext.communicationStyle && input.workspaceContext.communicationStyle !== "default"
          ? [`Communication style: ${input.workspaceContext.communicationStyle === "concise" ? "Be concise and direct" : "Provide detailed explanations"}`]
          : []),
        ...(input.workspaceContext.activeProjects && input.workspaceContext.activeProjects.length > 0
          ? [
              "Active projects:",
              ...input.workspaceContext.activeProjects.slice(0, 3).map((p) => `- ${p.name} (${p.stage})`)
            ]
          : []),
        ...(input.workspaceContext.keyDecisions && input.workspaceContext.keyDecisions.length > 0
          ? [
              "Recent key decisions:",
              ...input.workspaceContext.keyDecisions.slice(0, 3).map((d) => `- ${d.decision}: ${d.rationale}`)
            ]
          : []),
        ...(input.workspaceContext.founderProfile
          ? [
              "Founder memory:",
              ...(input.workspaceContext.founderProfile.businessDomains?.length
                ? [`- Business domains: ${input.workspaceContext.founderProfile.businessDomains.join(", ")}`]
                : []),
              ...(input.workspaceContext.founderProfile.targetUsers?.length
                ? [`- Target users: ${input.workspaceContext.founderProfile.targetUsers.join(", ")}`]
                : []),
              ...(input.workspaceContext.founderProfile.deliverablePreferences?.length
                ? [`- Preferred deliverables: ${input.workspaceContext.founderProfile.deliverablePreferences.join(", ")}`]
                : []),
              input.workspaceContext.founderProfile.decisionStyle
                ? `- Decision style: ${input.workspaceContext.founderProfile.decisionStyle}`
                : "",
              ...(input.workspaceContext.founderProfile.feedbackSignals?.length
                ? [
                    "Recent feedback:",
                    ...input.workspaceContext.founderProfile.feedbackSignals
                      .slice(-3)
                      .map((signal) => `- ${signal.signal}: ${signal.note}`)
                  ]
                : [])
            ].filter(Boolean)
          : [])
      ].join("\n")
    : "";

  return [
    `Prompt version: ${SYSTEM_PROMPT_VERSION}`,
    "",
    "## Global Rules",
    "You are an internal VinkoClaw execution agent running on a DGX Spark machine.",
    "Use only facts grounded in provided context and repository evidence.",
    "Never invent config keys, API fields, endpoints, or capabilities.",
    "When context is insufficient, explicitly say 'insufficient context' and list missing fields.",
    "Always respond in the same language as the user's instruction.",
    "If preferred language is zh-CN, write summary, deliverable, followUps, assumptions, risks, improvements in Simplified Chinese.",
    "For chat channels, keep wording natural and concise; avoid robotic template phrases.",
    "",
    "## Workspace Path Rules",
    "You MUST strictly follow these directory conventions when creating files. ALWAYS group ALL files by the current project name inside the `./projects/` directory (e.g., `coffee-shop`, `hotel-system`):",
    "1. **Projects/Code**: Any new software project, app, or system code you create MUST be placed in `./projects/<project-name>/code/`.",
    "2. **Documents/Reports**: Any generated documents, PRDs, analysis reports, or proposals MUST be saved to `./projects/<project-name>/docs/` or `./projects/<project-name>/reports/`.",
    "3. **Visual Assets**: Generated images, logos, or UI mockups MUST be saved to `./projects/<project-name>/assets/`.",
    "4. **Templates**: Use `./templates/` for reusable document templates.",
    "",
    "## Runtime Context",
    `Role: ${input.profileName}`,
    `Active skills: ${input.skillList}`,
    `Memory backend: ${input.memoryBackend}`,
    `Preferred language: ${input.preferredLanguage}`,
    workspaceSection,
    input.knowledgeBlock
      ? `\n## 相关知识\n${input.knowledgeBlock}`
      : "",
    toolSection,
    "",
    "## User Input Protocol",
    "If you realize mid-task that critical information is missing and you cannot make a reasonable assumption:",
    "1. Write the question in plain text before the marker.",
    "2. End your deliverable with exactly: __NEEDS_INPUT__{\"question\": \"<your question here>\"}",
    "Example: 请问您希望使用邮箱登录还是手机号登录？__NEEDS_INPUT__{\"question\": \"请问您希望使用邮箱登录还是手机号登录？\"}",
    "Rules for using __NEEDS_INPUT__:",
    "- Only use it when the missing info would completely change the output (e.g., auth method, target platform, audience).",
    "- Do NOT use it for minor details you can assume reasonably.",
    "- Do NOT use it for greetings, bug fixes, or clearly scoped tasks.",
    "- Ask at most ONE question per pause. Make it specific and actionable.",
    "",
    "## Role Prompt",
    input.rolePrompt.trim(),
    "",
    "## Output Contract",
    "Return strict JSON with keys: summary, deliverable, citations, followUps, reflection.",
    "reflection must contain: score, confidence, assumptions, risks, improvements.",
    "Do not include prose outside JSON.",
    "Exception: if you output __NEEDS_INPUT__, the entire response should be plain text (not JSON)."
  ]
    .filter((line) => line !== undefined && line !== "")
    .join("\n");
}

function buildFallbackOutput(input: RuntimeExecutionInput): RuntimeExecutionOutput {
  const profile = getRoleProfile(input.task.roleId);
  const citationLines = input.snippets.map((snippet) => `- ${snippet.path}: ${snippet.excerpt}`).join("\n");
  const skillList = input.skills.map((skill) => skill.skillId).join(", ") || "none";
  const memoryBackend =
    input.config.memory.roleBackends[input.task.roleId] ?? input.config.memory.defaultBackend;
  const preferredLanguage = resolvePreferredLanguage(input.task);
  const isZh = preferredLanguage === "zh-CN";

  return {
    backendUsed: "fallback",
    modelUsed: "deterministic-fallback",
    result: {
      summary: isZh
        ? `${profile.name} 已生成本地降级响应`
        : `${profile.name} produced a local fallback response`,
      deliverable: [
        isZh ? `角色：${profile.name}` : `Role: ${profile.name}`,
        isZh ? `任务指令：${input.task.instruction}` : `Instruction: ${input.task.instruction}`,
        isZh ? `已启用技能：${skillList}` : `Active skills: ${skillList}`,
        isZh ? `记忆后端：${memoryBackend}` : `Memory backend: ${memoryBackend}`,
        isZh
          ? "当前模型后端不可用，以下为确定性降级输出。"
          : "Model backend was unavailable, so this response is a deterministic fallback.",
        citationLines
          ? isZh
            ? `相关本地上下文：\n${citationLines}`
            : `Relevant local context:\n${citationLines}`
          : isZh
            ? "相关本地上下文：无"
            : "Relevant local context: none"
      ].join("\n\n"),
      citations: input.snippets.map((snippet) => ({
        path: snippet.path,
        excerpt: snippet.excerpt
      })),
      followUps: isZh
        ? [
            "检查主推理后端是否已正常加载当前配置的模型。",
            "若主后端不可用，确认兜底后端（Ollama / Zhipu）是否可用。",
            "模型服务恢复后重新执行该任务。"
          ]
        : [
            "Check whether the primary inference backend is serving the configured model.",
            "If the primary backend is down, verify the fallback backend (Ollama / Zhipu) is available.",
            "Retry the task after the model backend is healthy."
          ]
    },
    reflection: {
      score: 2,
      confidence: "low",
      assumptions: isZh
        ? [
            "目标能力可在无在线推理时做近似处理。",
            "当前任务可依赖本地仓库上下文先行推进。"
          ]
        : [
            "The requested capability can still be approximated without live inference.",
            "The current task can proceed with local repository context only."
          ],
      risks: isZh
        ? [
            "本次输出并非来自预期的 Qwen 3.5 后端。",
            "在模型服务恢复前，推理深度会受限。"
          ]
        : [
            "The response is not generated by the intended Qwen 3.5 backend.",
            "Reasoning depth is reduced until the local model server is online."
          ],
      improvements: isZh
        ? ["恢复主推理后端。", "模型恢复后按完整角色提示词重试任务。"]
        : [
            "Restore the primary inference backend.",
            "Retry with the full role prompt once the local model is available."
          ]
    },
    artifactFiles: []
  };
}

export class LocalModelClient {
  private readonly env = loadEnv();

  async finalizeReasoning(
    backend: "sglang" | "ollama" | "zhipu" | "openai" | "dashscope",
    messages: ModelMessage[],
    reasoningText: string
  ): Promise<string | undefined> {
    const baseUrl =
      backend === "zhipu"
        ? this.env.zhipuBaseUrl.replace(/\/$/, "")
        : backend === "openai"
          ? this.env.openaiBaseUrl.replace(/\/$/, "")
          : backend === "dashscope"
            ? this.env.dashscopeBaseUrl.replace(/\/$/, "")
          : backend === "sglang"
            ? this.env.sglangBaseUrl.replace(/\/$/, "")
            : this.env.ollamaBaseUrl.replace(/\/$/, "");
    const model =
      backend === "zhipu"
        ? this.env.zhipuModel
        : backend === "openai"
          ? this.env.openaiModel
          : backend === "dashscope"
            ? this.env.dashscopeModel
          : backend === "sglang"
            ? this.env.sglangModel
            : this.env.ollamaModel;
    return this.finalizeReasoningToContent(baseUrl, model, messages, reasoningText);
  }

  private isVllmQwen35A3B(baseUrl: string, model: string): boolean {
    return baseUrl.includes(":8000") && model.includes("Qwen3.5-35B-A3B");
  }

  private async requestChatCompletion(
    baseUrl: string,
    requestBody: Record<string, unknown>,
    apiKey?: string
  ): Promise<ChatCompletionMessage | undefined> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (apiKey) {
      headers["authorization"] = `Bearer ${apiKey}`;
    }
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(120_000)
    });

    if (!response.ok) {
      throw new Error(`backend responded with ${response.status}`);
    }

    const payload = (await response.json()) as ChatCompletionResponse;
    return payload.choices?.[0]?.message;
  }

  private async finalizeReasoningToContent(
    baseUrl: string,
    model: string,
    messages: ModelMessage[],
    reasoningText: string
  ): Promise<string | undefined> {
    const finalizePrompt = [
      "You are a response finalizer.",
      "Convert the draft reasoning into the final assistant answer.",
      "Output only the final answer text with no extra preface."
    ].join("\n");

    const originalContext = messages
      .map((message) => `${message.role.toUpperCase()}:\n${stringifyMessageContent(message.content)}`)
      .join("\n\n");

    const finalizeBody: Record<string, unknown> = {
      model,
      temperature: 0.1,
      max_tokens: 16384,
      chat_template_kwargs: {
        enable_thinking: false
      },
      messages: [
        {
          role: "system",
          content: finalizePrompt
        },
        {
          role: "user",
          content: [
            "Original conversation:",
            originalContext,
            "",
            "Reasoning draft:",
            reasoningText,
            "",
            "Now return the final answer."
          ].join("\n")
        }
      ]
    };

    const finalizedMessage = await this.requestChatCompletion(baseUrl, finalizeBody);
    const finalizedText = parseModelContent(finalizedMessage?.content);
    return finalizedText || undefined;
  }

  private async callOpenAiCompatible(
    backend: "zhipu" | "openai" | "dashscope",
    messages: ModelMessage[]
  ): Promise<ModelCompletion | undefined> {
    const apiKey =
      backend === "zhipu" ? this.env.zhipuApiKey : backend === "dashscope" ? this.env.dashscopeApiKey : this.env.openaiApiKey;
    if (!apiKey) {
      return undefined;
    }
    const baseUrl =
      backend === "zhipu"
        ? this.env.zhipuBaseUrl.replace(/\/$/, "")
        : backend === "dashscope"
          ? this.env.dashscopeBaseUrl.replace(/\/$/, "")
          : this.env.openaiBaseUrl.replace(/\/$/, "");
    const model = backend === "zhipu" ? this.env.zhipuModel : backend === "dashscope" ? this.env.dashscopeModel : this.env.openaiModel;

    const requestBody: Record<string, unknown> = {
      model,
      temperature: 0.2,
      max_tokens: 16384,
      messages
    };

    // GLM-5 supports thinking mode — enable it for richer reasoning.
    if (backend === "zhipu" && (model === "glm-5" || model === "glm-5-turbo")) {
      requestBody.thinking = { type: "enabled" };
    }

    const message = await this.requestChatCompletion(baseUrl, requestBody, apiKey);
    const contentText = parseModelContent(message?.content);
    const reasoningText = parseModelContent(message?.reasoning);
    const text = contentText || reasoningText;
    if (!text) {
      return undefined;
    }

    return {
      text,
      backendUsed: backend,
      modelUsed: model
    };
  }

  private async callBackend(
    backend: "sglang" | "ollama" | "zhipu" | "openai" | "dashscope",
    messages: ModelMessage[]
  ): Promise<ModelCompletion | undefined> {
    if (backend === "zhipu" || backend === "openai" || backend === "dashscope") {
      return this.callOpenAiCompatible(backend, messages);
    }

    const baseUrl =
      backend === "sglang" ? this.env.sglangBaseUrl.replace(/\/$/, "") : this.env.ollamaBaseUrl.replace(/\/$/, "");
    const model = backend === "sglang" ? this.env.sglangModel : this.env.ollamaModel;

    const useThinkingFirst = this.isVllmQwen35A3B(baseUrl, model);
    const requestBody: Record<string, unknown> = {
      model,
      temperature: 0.2,
      messages,
      max_tokens: 16384
    };

    if (useThinkingFirst) {
      requestBody.chat_template_kwargs = {
        enable_thinking: true
      };
    }

    const message = await this.requestChatCompletion(baseUrl, requestBody);
    const contentText = parseModelContent(message?.content);
    const reasoningText = parseModelContent(message?.reasoning);
    const text =
      contentText ||
      (useThinkingFirst && reasoningText
        ? await this.finalizeReasoningToContent(baseUrl, model, messages, reasoningText)
        : reasoningText);
    if (!text) {
      return undefined;
    }

    return {
      text,
      backendUsed: backend,
      modelUsed: model
    };
  }

  /** Call the model with tool definitions. Returns the raw message (may contain tool_calls). */
  async completeWithTools(
    messages: ModelMessage[],
    tools: ToolDefinition[]
  ): Promise<{ message: ChatCompletionMessage; backendUsed: "sglang" | "ollama" | "zhipu" | "openai" | "dashscope" | "fallback"; modelUsed: string }> {
    const env = this.env;
    const backends: Array<"openai" | "zhipu" | "dashscope" | "sglang" | "ollama"> =
      env.primaryBackend === "openai"
        ? ["openai", "dashscope", "zhipu", "sglang"]
        : env.primaryBackend === "zhipu"
          ? ["zhipu", "dashscope", "openai", "sglang"]
          : env.primaryBackend === "dashscope"
            ? ["dashscope", "openai", "zhipu", "sglang"]
            : ["sglang", "dashscope", "openai", "zhipu"];

    for (const backend of backends) {
      try {
        const baseUrl =
          backend === "zhipu"
            ? env.zhipuBaseUrl.replace(/\/$/, "")
            : backend === "openai"
              ? env.openaiBaseUrl.replace(/\/$/, "")
            : backend === "dashscope"
              ? env.dashscopeBaseUrl.replace(/\/$/, "")
            : backend === "sglang"
              ? env.sglangBaseUrl.replace(/\/$/, "")
              : env.ollamaBaseUrl.replace(/\/$/, "");
        const model =
          backend === "zhipu"
            ? env.zhipuModel
            : backend === "openai"
              ? env.openaiModel
            : backend === "dashscope"
              ? env.dashscopeModel
            : backend === "sglang"
              ? env.sglangModel
              : env.ollamaModel;
        const apiKey =
          backend === "zhipu"
            ? (env.zhipuApiKey || undefined)
            : backend === "openai"
              ? (env.openaiApiKey || undefined)
              : backend === "dashscope"
                ? (env.dashscopeApiKey || undefined)
              : undefined;

        const body: Record<string, unknown> = {
          model,
          temperature: 0.2,
          max_tokens: 16384,
          messages,
          tools,
          tool_choice: "auto"
        };

        // Disable thinking mode for tool-calling rounds — the model must emit
        // a tool_calls response, not spend tokens on CoT before acting.
        if (backend === "sglang" && this.isVllmQwen35A3B(baseUrl, model)) {
          body.chat_template_kwargs = { enable_thinking: false };
        }

        const msg = await this.requestChatCompletion(baseUrl, body, apiKey);
        if (msg) {
          return { message: msg, backendUsed: backend, modelUsed: model };
        }
      } catch {
        continue;
      }
    }

    return {
      message: {},
      backendUsed: "fallback",
      modelUsed: "deterministic-fallback"
    };
  }

  async complete(messages: ModelMessage[]): Promise<ModelCompletion> {
    const backends: Array<"sglang" | "ollama" | "zhipu" | "openai" | "dashscope"> =
      this.env.primaryBackend === "openai"
        ? ["openai", "dashscope", "zhipu", "sglang", "ollama"]
        : this.env.primaryBackend === "zhipu"
          ? ["zhipu", "dashscope", "openai", "sglang", "ollama"]
          : this.env.primaryBackend === "dashscope"
            ? ["dashscope", "openai", "zhipu", "sglang", "ollama"]
          : this.env.primaryBackend === "sglang"
            ? ["sglang", "dashscope", "openai", "ollama", "zhipu"]
            : ["ollama", "dashscope", "openai", "sglang", "zhipu"];

    for (const backend of backends) {
      try {
        const completion = await this.callBackend(backend, messages);
        if (completion) {
          return completion;
        }
      } catch {
        continue;
      }
    }

    return {
      text: "",
      backendUsed: "fallback",
      modelUsed: "deterministic-fallback"
    };
  }
}

/**
 * Heuristic: is the instruction complex enough to justify an extra planning LLM call?
 * Returns false for short, specific, or clearly-scoped requests to avoid extra latency.
 */
function isComplexEnoughForPlanning(instruction: string): boolean {
  const text = instruction.trim();

  // Founder-style execution tasks that explicitly allow assumptions should continue directly.
  if (/(?:合理默认假设继续推进|合理假设继续推进|不要因为.*暂停等待用户输入)/.test(text)) return false;

  // Very short → no planning needed
  if (text.length < 30) return false;

  // Bug fixes, status queries, greetings → no planning
  if (/(?:修复|fix|解决|resolve).*(?:bug|问题|错误|报错|issue)/i.test(text)) return false;
  if (/(?:进度|状态|status|progress|怎么样了)/i.test(text)) return false;

  // Resuming with user-provided clarification context → no re-planning
  if (/补充信息（用户确认）/.test(text)) return false;

  // Tasks with specific technology + action are scoped enough
  const hasSpecificTech = /(?:React|Vue|Angular|Next\.js|Node|Python|FastAPI|Django|PostgreSQL|MySQL|Redis|Docker|K8s|TypeScript)/i.test(text);
  const hasSpecificAction = /(?:写|创建|开发|实现|修改|重构|优化|部署|测试|write|create|implement|refactor|deploy)/i.test(text);
  if (hasSpecificTech && hasSpecificAction && text.length < 120) return false;

  // For everything else above 80 chars, run planning
  return text.length > 80;
}

export class AgentRuntime {
  private readonly client = new LocalModelClient();

  async execute(input: RuntimeExecutionInput): Promise<RuntimeExecutionOutput> {
    // ── Pre-execution planning (optional, skipped for simple tasks) ──────────
    if (input.preExecutePlan && isComplexEnoughForPlanning(input.task.instruction)) {
      const planResult = await this.runPreExecutePlan(input);
      if (planResult.needsInput) {
        const fallback = buildFallbackOutput(input);
        fallback.needsInput = true;
        fallback.missingFields = planResult.missingFields;
        fallback.result.deliverable = `__NEEDS_INPUT__{"question": "${planResult.question}", "context": "${planResult.missingFields?.join(", ") ?? ""}"}`;
        return fallback;
      }
    }

    const systemPrompt = await loadRolePrompt(input.task.roleId);
    const profile = getRoleProfile(input.task.roleId);
    const memoryBackend =
      input.config.memory.roleBackends[input.task.roleId] ?? input.config.memory.defaultBackend;
    const preferredLanguage = resolvePreferredLanguage(input.task);
    const skillList = input.skills.map((skill) => skill.skillId).join(", ") || "none";
    const contextBlock =
      input.snippets.length === 0
        ? "No local context retrieved."
        : input.snippets
            .map((snippet) => `- ${snippet.path}\n${snippet.excerpt}`)
            .join("\n\n");

    // ── Knowledge injection ────────────────────────────────────────────────
    let knowledgeBlock = "";
    if (input.knowledgeBase) {
      try {
        const snippets = await input.knowledgeBase.retrieve(input.task.instruction, 5);
        if (snippets.length > 0) {
          const lines = ["## 相关知识（来自知识库）"];
          for (const snippet of snippets) {
            lines.push(`\n### ${snippet.path} (相关度: ${(snippet.score * 100).toFixed(0)}%)`);
            lines.push(snippet.excerpt.slice(0, 500));
          }
          knowledgeBlock = lines.join("\n");
        }
      } catch {
        // Knowledge retrieval failure — don't block task execution
      }
    }

    // ── Tool calling loop ──────────────────────────────────────────────────
    const toolCtx = input.toolContext;
    const allArtifactPaths: string[] = [];

    // Initialize registry and rules engine (use provided or create defaults)
    const registry = input.toolRegistry ?? (toolCtx ? createToolBackedRegistry(toolCtx) : new ToolRegistry());
    const rules = input.rulesEngine ?? createDefaultRulesEngine();
    const telemetry = input.telemetry;
    let traceId: string | undefined;

    if (telemetry) {
      traceId = telemetry.startTrace(input.task);
    }

    const toolDefs = registry.serializeForLLM();
    const availableTools =
      toolDefs.length > 0 ? toolDefs.map((t) => `${t.function.name}: ${t.function.description.split(".")[0]}`) : undefined;

    const messages: ModelMessage[] = [
      {
        role: "system",
        content: buildLayeredSystemPrompt({
          rolePrompt: systemPrompt,
          profileName: profile.name,
          skillList,
          memoryBackend,
          preferredLanguage,
          ...(availableTools ? { availableTools } : {}),
          ...(input.workspaceContext ? { workspaceContext: input.workspaceContext } : {}),
          ...(knowledgeBlock ? { knowledgeBlock } : {})
        })
      },
      // Inject prior conversation turns as real message pairs for multi-turn coherence
      ...(input.conversationHistory ?? []).map((turn) => ({
        role: turn.role as "user" | "assistant",
        content: turn.content as ModelMessageContent
      })),
      {
        role: "user",
        content: await buildUserMessageContent(input.task, contextBlock)
      }
    ];

    if (toolCtx && toolDefs.length > 0) {
      const tools = toolDefs;
      const MAX_TOOL_ROUNDS = 8;
      let backendUsed: RuntimeExecutionOutput["backendUsed"] = "fallback";
      let modelUsed = "deterministic-fallback";

      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        // Record turn start for timing
        if (telemetry && traceId) {
          telemetry.recordTurnStart(traceId, round);
        }

        const { message, backendUsed: bu, modelUsed: mu } = await this.client.completeWithTools(messages, tools);
        backendUsed = bu;
        modelUsed = mu;

        if (bu === "fallback") break;

        const toolCalls = message.tool_calls ?? [];

        if (toolCalls.length === 0) {
          // Model finished — parse the final text response.
          // Thinking models (Qwen3) may return content=null with reasoning populated;
          // in that case finalize the reasoning into content first.
          const contentText = parseModelContent(message.content);
          const reasoningText = parseModelContent(message.reasoning);
          let text = contentText;
          if (!text && reasoningText && backendUsed !== "fallback") {
            text = (await this.client.finalizeReasoning(backendUsed, messages, reasoningText)) ?? reasoningText;
          }
          if (!text) break;

          const parsed = safeParseTaskResponse(text);
          if (!parsed) {
            // Not JSON yet — push the assistant response and ask for JSON output in next round
            messages.push({ role: "assistant", content: text });
            messages.push({
              role: "user",
              content:
                "Good. Now output the final result as strict JSON with keys: summary, deliverable, citations, followUps, reflection. reflection must contain: score, confidence, assumptions, risks, improvements. Do not include any prose outside JSON."
            });
            // Try one more round to get structured output
            const retry = await this.client.completeWithTools(messages, tools);
            const retryText = parseModelContent(retry.message.content);
            const retryParsed = retryText ? safeParseTaskResponse(retryText) : undefined;

            if (retryParsed) {
              if (telemetry && traceId) telemetry.completeTrace(traceId, retryParsed.result);
              return {
                result: retryParsed.result,
                reflection: retryParsed.reflection,
                backendUsed: retry.backendUsed,
                modelUsed: retry.modelUsed,
                artifactFiles: collectArtifactFiles(toolCtx.workDir, input.task.id)
              };
            }

            // Still not JSON — synthesize result from the plain text
            const fallback = buildFallbackOutput(input);
            fallback.backendUsed = backendUsed;
            fallback.modelUsed = modelUsed;
            fallback.result.summary = text.slice(0, 120);
            fallback.result.deliverable = text;
            fallback.reflection.score = 5;
            fallback.reflection.confidence = "medium";
            fallback.artifactFiles = collectArtifactFiles(toolCtx.workDir, input.task.id);
            if (telemetry && traceId) telemetry.completeTrace(traceId, fallback.result);
            return fallback;
          }

          if (telemetry && traceId) telemetry.completeTrace(traceId, parsed.result);
          return {
            result: parsed.result,
            reflection: parsed.reflection,
            backendUsed,
            modelUsed,
            artifactFiles: collectArtifactFiles(toolCtx.workDir, input.task.id)
          };
        }

        // Execute tool calls, inject results back into conversation
        const assistantMsg: ModelMessage = {
          role: "assistant",
          content: null,
          tool_calls: toolCalls
        };
        messages.push(assistantMsg);

        for (const tc of toolCalls) {
          // ── Pre-execution rules ────────────────────────────────────────
          const toolCall = {
            id: tc.id,
            name: tc.function.name,
            arguments: (() => {
              try { return JSON.parse(tc.function.arguments); } catch { return {}; }
            })()
          };
          const workspaceRoot = path.resolve(toolCtx.workDir, "..", "..", "..");
          const ruleCtx = { workDir: toolCtx.workDir, workspaceRoot };
          const preDecision = rules.evaluate(toolCall, ruleCtx, "pre");

          if (preDecision.action === "deny") {
            // Tool blocked by rules engine — inject error result without executing
            const toolMsg: ModelMessage = {
              role: "tool",
              tool_call_id: tc.id,
              content: `BLOCKED: ${preDecision.reason}`
            };
            messages.push(toolMsg);

            // Record blocked tool in telemetry
            if (telemetry && traceId) {
              telemetry.recordBlockedTool(traceId, round, tc.function.name, tc.id, preDecision.reason);
            }
            continue;
          }

          // ── Execute tool ───────────────────────────────────────────────
          const execStart = Date.now();
          const result = await executeTool(toolCtx, tc.id, tc.function.name, tc.function.arguments);
          const execDuration = Date.now() - execStart;
          allArtifactPaths.push(...result.artifactPaths);

          // ── Post-execution rules ───────────────────────────────────────
          let outputText = result.error ? `ERROR: ${result.error}` : result.output;
          const postDecision = rules.evaluateOutput(toolCall, outputText, ruleCtx);
          if (postDecision.action === "sanitize" && postDecision.sanitizedOutput !== undefined) {
            outputText = postDecision.sanitizedOutput;
          }

          const toolMsg: ModelMessage = {
            role: "tool",
            tool_call_id: tc.id,
            content: outputText
          };
          messages.push(toolMsg);
        }

        // Record the telemetry turn after tool executions
        if (telemetry && traceId) {
          telemetry.recordTurn(traceId, {
            round,
            modelInputSummary: summarizeModelInput(messages),
            modelOutputSummary: summarizeModelOutput(message),
            toolCalls: [],  // tool calls already recorded via recordBlockedTool
            backendUsed,
            modelUsed,
            durationMs: 0  // calculated by telemetry from turn start
          });
        }
      }

      // Fell through MAX_TOOL_ROUNDS or all backends failed — use fallback
      const fallback = buildFallbackOutput(input);
      fallback.artifactFiles = collectArtifactFiles(toolCtx.workDir, input.task.id);
      if (telemetry && traceId) telemetry.completeTrace(traceId, fallback.result);
      return fallback;
    }

    // ── Plain completion (no tools / tools not configured) ─────────────────
    const completion = await this.client.complete(messages);
    if (completion.backendUsed === "fallback" || !completion.text) {
      if (telemetry && traceId) {
        const fb = buildFallbackOutput(input);
        telemetry.completeTrace(traceId, fb.result);
      }
      return buildFallbackOutput(input);
    }

    const parsed = safeParseTaskResponse(completion.text);
    if (!parsed) {
      // Single JSON-repair retry: ask the model to reformat as strict JSON
      const retryMessages: ModelMessage[] = [
        ...messages,
        { role: "assistant", content: completion.text },
        {
          role: "user",
          content:
            "Your previous response was not valid JSON. Output ONLY a JSON object with keys: summary, deliverable, citations, followUps, reflection. No extra text or markdown fences. reflection must contain: score (1–10), confidence (low/medium/high), assumptions (string[]), risks (string[]), improvements (string[])."
        }
      ];
      const retryCompletion = await this.client.complete(retryMessages);
      const retryParsed = retryCompletion.text ? safeParseTaskResponse(retryCompletion.text) : undefined;
      if (retryParsed) {
        if (telemetry && traceId) telemetry.completeTrace(traceId, retryParsed.result);
        return {
          result: retryParsed.result,
          reflection: retryParsed.reflection,
          backendUsed: retryCompletion.backendUsed,
          modelUsed: retryCompletion.modelUsed,
          artifactFiles: []
        };
      }
      // Still no JSON — surface the plain-text deliverable with reduced confidence
      const fallback = buildFallbackOutput(input);
      fallback.backendUsed = completion.backendUsed;
      fallback.modelUsed = completion.modelUsed;
      fallback.result.summary = completion.text.slice(0, 180);
      fallback.result.deliverable = completion.text;
      fallback.reflection.score = 4;
      fallback.reflection.confidence = "medium";
      if (telemetry && traceId) telemetry.completeTrace(traceId, fallback.result);
      return fallback;
    }

    if (telemetry && traceId) telemetry.completeTrace(traceId, parsed.result);
    return {
      result: parsed.result,
      reflection: parsed.reflection,
      backendUsed: completion.backendUsed,
      modelUsed: completion.modelUsed,
      artifactFiles: []
    };
  }

  /**
   * Lightweight planning step: analyze what the task needs and identify missing information.
   */
  private async runPreExecutePlan(input: RuntimeExecutionInput): Promise<{
    needsInput: boolean;
    missingFields: string[];
    question: string;
  }> {
    const systemPrompt = `You are a task planning assistant. Analyze the given task and determine what information is needed to complete it successfully.

Output ONLY valid JSON (no code fences, no explanation):
{
  "plan": "brief 1-2 sentence plan of what needs to be done",
  "needsInput": true/false,
  "missingFields": ["field1", "field2"],
  "question": "a clear question asking for the missing information"
}

Rules:
- needsInput should be true ONLY if critical information is missing that would block task completion
- missingFields should list specific information gaps (e.g., "tech_stack", "auth_method", "target_users")
- question should be a single, clear, actionable question
- If the task explicitly says you may use reasonable defaults / assumptions and continue delivery, set needsInput = false
- For bug fixes, status queries, greetings, or clearly specified tasks: needsInput = false`;

    const messages: ModelMessage[] = [
      {
        role: "system",
        content: systemPrompt
      },
      {
        role: "user",
        content: `Analyze this task and identify missing information:\n\n${input.task.instruction}`
      }
    ];

    try {
      const completion = await this.client.complete(messages);
      if (!completion.text || completion.backendUsed === "fallback") {
        return { needsInput: false, missingFields: [], question: "" };
      }

      // Try to parse JSON from the response
      const cleaned = completion.text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
      const parsed = JSON.parse(cleaned) as {
        needsInput?: boolean;
        missingFields?: string[];
        question?: string;
      };

      if (parsed.needsInput && Array.isArray(parsed.missingFields) && parsed.missingFields.length > 0) {
        return {
          needsInput: true,
          missingFields: parsed.missingFields,
          question: parsed.question || "请提供更多信息以帮助完成任务"
        };
      }

      return { needsInput: false, missingFields: [], question: "" };
    } catch {
      // On any error, assume no missing info and proceed with normal execution
      return { needsInput: false, missingFields: [], question: "" };
    }
  }
}

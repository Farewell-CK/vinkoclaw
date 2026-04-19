/**
 * Unified tool registry for VinkoClaw.
 *
 * Replaces hardcoded tool definitions in tool-executor.ts with a
 * pluggable registry. Tools are registered once at startup and can
 * be discovered by category, risk level, or intent matching.
 *
 * The registry serializes to OpenAI function-calling format for the
 * LLM tool loop in AgentRuntime.
 */

import type { ToolContext, ToolDefinition } from "./tool-executor.js";
import { executeGenerateImage, executeRunCode, executeWebSearch, executeWriteFile } from "./tool-executor.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ToolCategory = "filesystem" | "shell" | "network" | "knowledge" | "custom";
export type ToolRiskLevel = "safe" | "moderate" | "dangerous";

export interface ToolRegistration {
  id: string;
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  executor: (args: Record<string, unknown>, ctx: ToolContext) => Promise<{ output: string; artifactPaths: string[] }>;
  category: ToolCategory;
  riskLevel: ToolRiskLevel;
  /** Tags used for intent-based matching (e.g. ["search", "web", "internet"]) */
  tags: string[];
  /** Whether this tool should be enabled by default. Tools installed via skills can set false. */
  enabledByDefault?: boolean;
}

export interface RuntimeCapabilitySnapshot {
  registryMode: "default";
  totalRegistered: number;
  totalEnabled: number;
  tools: Array<{
    id: string;
    name: string;
    category: ToolCategory;
    riskLevel: ToolRiskLevel;
    enabled: boolean;
    tags: string[];
  }>;
}

// ─── Registry ─────────────────────────────────────────────────────────────────

const TOOL_MATCH_WEIGHTS: Record<string, string[]> = {
  search: ["web_search"],
  搜索: ["web_search"],
  run: ["run_code"],
  exec: ["run_code"],
  code: ["run_code"],
  script: ["run_code"],
  python: ["run_code"],
  bash: ["run_code"],
  calc: ["run_code"],
  计算: ["run_code"],
  代码: ["run_code"],
  运行: ["run_code"],
  write: ["write_file"],
  save: ["write_file"],
  create: ["write_file"],
  file: ["write_file"],
  persist: ["write_file"],
  写: ["write_file"],
  保存: ["write_file"],
  文件: ["write_file"]
};

export class ToolRegistry {
  private tools = new Map<string, ToolRegistration>();

  register(tool: ToolRegistration): void {
    if (this.tools.has(tool.id)) {
      throw new Error(`Tool "${tool.id}" is already registered`);
    }
    this.tools.set(tool.id, tool);
  }

  unregister(id: string): void {
    this.tools.delete(id);
  }

  get(id: string): ToolRegistration | undefined {
    return this.tools.get(id);
  }

  /** List all registered tools, optionally filtered by category or risk level. */
  list(options?: { category?: ToolCategory; riskLevel?: ToolRiskLevel }): ToolRegistration[] {
    let result = Array.from(this.tools.values());
    if (options?.category) {
      result = result.filter((t) => t.category === options.category);
    }
    if (options?.riskLevel) {
      result = result.filter((t) => t.riskLevel === options.riskLevel);
    }
    return result;
  }

  /**
   * Match tools based on user intent text.
   * Returns all tools that seem relevant to the given instruction.
   * If no specific match, returns all enabled tools.
   */
  matchByIntent(intent: string): ToolRegistration[] {
    const normalized = intent.toLowerCase();
    const matchedIds = new Set<string>();

    for (const [keyword, toolIds] of Object.entries(TOOL_MATCH_WEIGHTS)) {
      if (normalized.includes(keyword)) {
        for (const id of toolIds) {
          if (this.tools.has(id)) {
            matchedIds.add(id);
          }
        }
      }
    }

    // Always include run_code and write_file (core execution tools)
    // Only filter web_search based on intent
    if (matchedIds.size === 0) {
      return this.list().filter((t) => t.enabledByDefault !== false);
    }

    // Return matched tools + all core tools that weren't explicitly excluded
    const result: ToolRegistration[] = [];
    for (const tool of this.tools.values()) {
      if (tool.enabledByDefault === false && !matchedIds.has(tool.id)) {
        continue;
      }
      result.push(tool);
    }
    return result;
  }

  /** Serialize registered tools to OpenAI function-calling format for the LLM. */
  serializeForLLM(): ToolDefinition[] {
    const definitions: ToolDefinition[] = [];
    for (const tool of this.tools.values()) {
      if (tool.enabledByDefault === false) continue;
      definitions.push({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters
        }
      });
    }
    return definitions;
  }

  /** Execute a tool call by name using the registered executor. */
  async execute(
    toolName: string,
    args: Record<string, unknown>,
    ctx: ToolContext
  ): Promise<{ output: string; artifactPaths: string[] }> {
    for (const tool of this.tools.values()) {
      if (tool.name === toolName) {
        return tool.executor(args, ctx);
      }
    }
    throw new Error(`Unknown tool: ${toolName}`);
  }

  /** Check if a tool is registered by name. */
  hasTool(toolName: string): boolean {
    return Array.from(this.tools.values()).some((t) => t.name === toolName);
  }

  /** Get tool IDs by name. */
  getIdsByName(toolName: string): string[] {
    return Array.from(this.tools.values())
      .filter((t) => t.name === toolName)
      .map((t) => t.id);
  }
}

// ─── Built-in tool registrations ──────────────────────────────────────────────

function createBuiltinRegistry(): ToolRegistry {
  return new ToolRegistry();
}

/** Create a registry with all built-in tools registered. */
export function createDefaultRegistry(ctx: ToolContext): ToolRegistry {
  return createToolBackedRegistry(ctx);
}

/**
 * Create a registry with built-in tools that delegates execution to executeTool.
 * This is the recommended way — the registry handles discovery and serialization,
 * while tool-executor.ts handles execution (no code duplication).
 */
export function createToolBackedRegistry(ctx: ToolContext): ToolRegistry {
  const registry = createBuiltinRegistry();
  const searchEnabled = Boolean(ctx.searchProvider && getSearchApiKey(ctx));
  const imageEnabled = Boolean(ctx.secrets["AI_STUDIO_API_KEY"]?.trim());

  registry.register({
    id: "web_search",
    name: "web_search",
    description:
      "Search the web for real-time information. Use this when you need current data, documentation, prices, news, or any information that may not be in your training data.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query"
        },
        max_results: {
          type: "number",
          description: "Maximum number of results to return (default 5, max 10)"
        }
      },
      required: ["query"]
    },
    executor: async (args, toolCtx) => executeWebSearch(toolCtx, args as { query: string; max_results?: number }),
    category: "network",
    riskLevel: "safe",
    tags: ["search", "web", "internet", "news", "price", "documentation"],
    enabledByDefault: searchEnabled
  });

  registry.register({
    id: "run_code",
    name: "run_code",
    description:
      "Execute Python or bash code and return the output. Use this to perform calculations, generate files (PDF, Excel, images), process data, install packages, or do anything that requires execution. If a tool you need doesn't exist, write code to create it.",
    parameters: {
      type: "object",
      properties: {
        language: {
          type: "string",
          enum: ["python", "bash"],
          description: "The language to execute"
        },
        code: {
          type: "string",
          description: "The code to run"
        },
        description: {
          type: "string",
          description: "Brief description of what this code does"
        }
      },
      required: ["language", "code"]
    },
    executor: async (args, toolCtx) =>
      executeRunCode(toolCtx, args as { language: "python" | "bash"; code: string; description?: string }),
    category: "shell",
    riskLevel: "dangerous",
    tags: ["run", "exec", "code", "script", "python", "bash", "calc", "process"]
  });

  registry.register({
    id: "write_file",
    name: "write_file",
    description:
      "Write text content to a file in the task workspace. Use this to save deliverables: markdown docs, JSON, CSV, HTML reports, etc. The file path is relative to the workspace.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative file path (e.g. 'report.md', 'data/results.json')"
        },
        content: {
          type: "string",
          description: "Text content to write"
        }
      },
      required: ["path", "content"]
    },
    executor: async (args, toolCtx) =>
      executeWriteFile(toolCtx, args as { path: string; content: string }),
    category: "filesystem",
    riskLevel: "moderate",
    tags: ["write", "save", "create", "file", "persist"]
  });

  registry.register({
    id: "generate_image",
    name: "generate_image",
    description:
      "Generate high-quality images from text prompts using Stable-Diffusion-XL. Use this to create visual assets for proposals, decks, and UI designs, then save them as PNG files.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "The text prompt describing the image to generate"
        },
        filename: {
          type: "string",
          description: "Target filename for the generated image"
        },
        project_name: {
          type: "string",
          description: "Project name used to organize generated assets"
        }
      },
      required: ["prompt"]
    },
    executor: async (args, toolCtx) =>
      executeGenerateImage(toolCtx, args as { prompt: string; filename?: string; project_name?: string }),
    category: "custom",
    riskLevel: "moderate",
    tags: ["image", "design", "visual", "asset", "generate"],
    enabledByDefault: imageEnabled
  });

  return registry;
}

function getSearchApiKey(ctx: ToolContext): string {
  if (ctx.searchProvider === "tavily") {
    return ctx.secrets["TAVILY_API_KEY"] ?? "";
  }
  if (ctx.searchProvider === "serpapi") {
    return ctx.secrets["SERPAPI_API_KEY"] ?? "";
  }
  return "";
}

export function buildRuntimeCapabilitySnapshot(registry: ToolRegistry): RuntimeCapabilitySnapshot {
  const tools = registry.list().map((tool) => ({
    id: tool.id,
    name: tool.name,
    category: tool.category,
    riskLevel: tool.riskLevel,
    enabled: tool.enabledByDefault !== false,
    tags: tool.tags
  }));

  return {
    registryMode: "default",
    totalRegistered: tools.length,
    totalEnabled: tools.filter((tool) => tool.enabled).length,
    tools
  };
}

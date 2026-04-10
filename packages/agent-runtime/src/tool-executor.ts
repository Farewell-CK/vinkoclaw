/**
 * Built-in tool execution for AgentRuntime.
 *
 * Three tools are available to the LLM via function calling:
 *   - web_search: query Tavily or SerpAPI for real-time information
 *   - run_code: execute Python or bash inline; the agent creates its own tools this way
 *   - write_file: persist a text artifact to the task workspace
 *
 * Tool availability is determined by what is configured at runtime:
 *   - web_search requires SEARCH_PROVIDER + API key in toolSecrets
 *   - run_code always available (python3 / bash are assumed present on the DGX Spark host)
 *   - write_file always available
 */

import { execFile, execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ToolContext {
  /** Absolute path to the task-scoped scratch directory */
  workDir: string;
  /** Runtime secrets (TAVILY_API_KEY, SERPAPI_API_KEY, etc.) */
  secrets: Record<string, string>;
  /** The active SEARCH_PROVIDER value ("tavily" | "serpapi" | "") */
  searchProvider: string;
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

export interface ToolCallResult {
  toolCallId: string;
  name: string;
  output: string;
  /** Files created by this tool call (absolute paths) */
  artifactPaths: string[];
  error?: string;
}

// ─── Tool definitions (OpenAI function-calling schema) ───────────────────────

export function buildToolDefinitions(ctx: ToolContext): ToolDefinition[] {
  const tools: ToolDefinition[] = [];

  if (ctx.searchProvider && getSearchApiKey(ctx)) {
    tools.push({
      type: "function",
      function: {
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
        }
      }
    });
  }

  tools.push({
    type: "function",
    function: {
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
      }
    }
  });

  tools.push({
    type: "function",
    function: {
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
      }
    }
  });

  return tools;
}

// ─── Tool execution ───────────────────────────────────────────────────────────

function getSearchApiKey(ctx: ToolContext): string {
  if (ctx.searchProvider === "tavily") {
    return ctx.secrets["TAVILY_API_KEY"] ?? "";
  }
  if (ctx.searchProvider === "serpapi") {
    return ctx.secrets["SERPAPI_API_KEY"] ?? "";
  }
  return "";
}

async function executeWebSearch(
  ctx: ToolContext,
  args: { query: string; max_results?: number }
): Promise<{ output: string; artifactPaths: string[] }> {
  const maxResults = Math.min(args.max_results ?? 5, 10);
  const apiKey = getSearchApiKey(ctx);

  if (ctx.searchProvider === "tavily") {
    const resp = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({ query: args.query, max_results: maxResults }),
      signal: AbortSignal.timeout(15_000)
    });
    if (!resp.ok) {
      return { output: `Search failed: HTTP ${resp.status}`, artifactPaths: [] };
    }
    const data = (await resp.json()) as {
      results?: Array<{ title?: string; url?: string; content?: string }>;
    };
    const results = (data.results ?? []).slice(0, maxResults);
    const formatted = results
      .map((r, i) => `[${i + 1}] ${r.title ?? "No title"}\n${r.url ?? ""}\n${r.content?.slice(0, 400) ?? ""}`)
      .join("\n\n");
    return { output: formatted || "No results found.", artifactPaths: [] };
  }

  if (ctx.searchProvider === "serpapi") {
    const params = new URLSearchParams({ api_key: apiKey, q: args.query, num: String(maxResults) });
    const resp = await fetch(`https://serpapi.com/search.json?${params.toString()}`, {
      signal: AbortSignal.timeout(15_000)
    });
    if (!resp.ok) {
      return { output: `Search failed: HTTP ${resp.status}`, artifactPaths: [] };
    }
    const data = (await resp.json()) as {
      organic_results?: Array<{ title?: string; link?: string; snippet?: string }>;
    };
    const results = (data.organic_results ?? []).slice(0, maxResults);
    const formatted = results
      .map((r, i) => `[${i + 1}] ${r.title ?? "No title"}\n${r.link ?? ""}\n${r.snippet ?? ""}`)
      .join("\n\n");
    return { output: formatted || "No results found.", artifactPaths: [] };
  }

  return { output: "No search provider configured.", artifactPaths: [] };
}

async function executeRunCode(
  ctx: ToolContext,
  args: { language: "python" | "bash"; code: string; description?: string }
): Promise<{ output: string; artifactPaths: string[] }> {
  await mkdir(ctx.workDir, { recursive: true });

  const ext = args.language === "python" ? ".py" : ".sh";
  const scriptPath = path.join(ctx.workDir, `_run_${Date.now()}${ext}`);
  await writeFile(scriptPath, args.code, "utf8");

  const cmd = args.language === "python" ? "python3" : "bash";
  const timeout = 60_000; // 60s max

  // Capture files present before execution to detect newly created artifacts
  let filesBefore: Set<string> = new Set();
  try {
    const { stdout: ls } = await execFileAsync("find", [ctx.workDir, "-maxdepth", "3", "-type", "f"], {
      timeout: 5000
    });
    filesBefore = new Set(ls.trim().split("\n").filter(Boolean));
  } catch {
    // ignore
  }

  let stdout = "";
  let stderr = "";
  let execError: string | undefined;

  try {
    const result = await execFileAsync(cmd, [scriptPath], {
      timeout,
      cwd: ctx.workDir,
      env: {
        ...process.env,
        // Provide HOME and temp dir; strip secrets from subprocess env
        TMPDIR: ctx.workDir,
        HOME: process.env.HOME ?? ctx.workDir
      },
      maxBuffer: 2 * 1024 * 1024 // 2MB stdout
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    stdout = e.stdout ?? "";
    stderr = e.stderr ?? "";
    execError = e.message ?? "unknown execution error";
  }

  // Detect new artifact files
  const artifactPaths: string[] = [];
  try {
    const { stdout: ls } = await execFileAsync("find", [ctx.workDir, "-maxdepth", "3", "-type", "f"], {
      timeout: 5000
    });
    for (const f of ls.trim().split("\n").filter(Boolean)) {
      if (!filesBefore.has(f) && f !== scriptPath) {
        artifactPaths.push(f);
      }
    }
  } catch {
    // ignore
  }

  const parts: string[] = [];
  if (stdout.trim()) parts.push(`STDOUT:\n${stdout.trim().slice(0, 4000)}`);
  if (stderr.trim()) parts.push(`STDERR:\n${stderr.trim().slice(0, 1000)}`);
  if (execError) parts.push(`ERROR: ${execError}`);
  if (artifactPaths.length > 0) {
    parts.push(`FILES CREATED:\n${artifactPaths.map((f) => `  ${path.relative(ctx.workDir, f)}`).join("\n")}`);
  }

  return {
    output: parts.join("\n\n") || "(no output)",
    artifactPaths
  };
}

async function executeWriteFile(
  ctx: ToolContext,
  args: { path: string; content: string }
): Promise<{ output: string; artifactPaths: string[] }> {
  const rawPath = String(args.path ?? "").trim();
  if (!rawPath) {
    throw new Error("write_file requires a non-empty path");
  }

  const workspaceRoot = path.resolve(ctx.workDir, "..", "..", "..");
  const isWithin = (candidate: string, root: string): boolean => {
    const rel = path.relative(root, candidate);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  };

  let fullPath = "";
  let displayPath = "";

  if (path.isAbsolute(rawPath)) {
    const normalizedAbsolute = path.resolve(rawPath);
    if (!isWithin(normalizedAbsolute, workspaceRoot)) {
      throw new Error(`absolute path outside workspace is not allowed: ${rawPath}`);
    }
    fullPath = normalizedAbsolute;
    displayPath = path.relative(workspaceRoot, fullPath).replaceAll(path.sep, "/");
  } else {
    const resolved = path.resolve(ctx.workDir, rawPath);
    if (!isWithin(resolved, ctx.workDir)) {
      throw new Error(`path escapes task workspace: ${rawPath}`);
    }
    fullPath = resolved;
    displayPath = path.relative(ctx.workDir, fullPath).replaceAll(path.sep, "/");
  }

  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, args.content, "utf8");
  return {
    output: `File written: ${displayPath} (${args.content.length} bytes)`,
    artifactPaths: [fullPath]
  };
}

// ─── Dispatch ─────────────────────────────────────────────────────────────────

export async function executeTool(
  ctx: ToolContext,
  toolCallId: string,
  name: string,
  argsRaw: string
): Promise<ToolCallResult> {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(argsRaw) as Record<string, unknown>;
  } catch {
    return { toolCallId, name, output: "", error: `Invalid JSON arguments: ${argsRaw}`, artifactPaths: [] };
  }

  try {
    if (name === "web_search") {
      const r = await executeWebSearch(ctx, args as Parameters<typeof executeWebSearch>[1]);
      return { toolCallId, name, output: r.output, artifactPaths: r.artifactPaths };
    }
    if (name === "run_code") {
      const r = await executeRunCode(ctx, args as Parameters<typeof executeRunCode>[1]);
      return { toolCallId, name, output: r.output, artifactPaths: r.artifactPaths };
    }
    if (name === "write_file") {
      const r = await executeWriteFile(ctx, args as Parameters<typeof executeWriteFile>[1]);
      return { toolCallId, name, output: r.output, artifactPaths: r.artifactPaths };
    }
    return { toolCallId, name, output: "", error: `Unknown tool: ${name}`, artifactPaths: [] };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { toolCallId, name, output: "", error: msg, artifactPaths: [] };
  }
}

// ─── Workspace helpers ────────────────────────────────────────────────────────

export function buildWorkDir(workspaceRoot: string, taskId: string): string {
  return path.join(workspaceRoot, ".vinkoclaw", "tasks", taskId);
}

export function collectArtifactFiles(workDir: string, _taskId: string): string[] {
  if (!existsSync(workDir)) return [];
  try {
    const out = execFileSync("find", [workDir, "-maxdepth", "4", "-type", "f", "-not", "-name", "*.py", "-not", "-name", "*.sh"], {
      encoding: "utf8",
      timeout: 5000
    });
    return out
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((f: string) => {
        // Return as workspace-relative path like ".vinkoclaw/tasks/<id>/report.pdf"
        const rel = path.relative(path.dirname(path.dirname(path.dirname(workDir))), f);
        return rel;
      });
  } catch {
    return [];
  }
}

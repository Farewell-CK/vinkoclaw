/**
 * Rules engine for tool execution safety.
 *
 * Intercepts tool calls before and after execution to enforce
 * security policies: path validation, dangerous command blocking,
 * and sensitive output sanitization.
 */

import path from "node:path";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolContext {
  workDir: string;
  workspaceRoot?: string;
}

export type RuleAction = "allow" | "deny" | "require_approval" | "sanitize";

export interface RuleDecision {
  action: RuleAction;
  reason: string;
  sanitizedOutput?: string | undefined;
}

export interface ToolRule {
  id: string;
  toolId: string | "*";
  phase: "pre" | "post";
  condition: (toolCall: ToolCall, ctx: ToolContext) => boolean;
  action: RuleAction;
  sanitize?: (output: string) => string;
  reason: string;
}

// ─── Rules Engine ─────────────────────────────────────────────────────────────

export class RulesEngine {
  private rules: ToolRule[] = [];

  register(rule: ToolRule): void {
    this.rules.push(rule);
  }

  /** Evaluate all matching rules for a tool call at the given phase. */
  evaluate(toolCall: ToolCall, ctx: ToolContext, phase: "pre" | "post"): RuleDecision {
    const matchedRules = this.rules.filter(
      (r) => r.phase === phase && (r.toolId === "*" || r.toolId === toolCall.name)
    );

    for (const rule of matchedRules) {
      try {
        if (rule.condition(toolCall, ctx)) {
          if (rule.action === "sanitize") {
            const sanitizedOutput = rule.sanitize
              ? rule.sanitize("")
              : undefined;
            return { action: "sanitize", reason: rule.reason, sanitizedOutput };
          }
          return { action: rule.action, reason: rule.reason };
        }
      } catch {
        // If the condition throws, treat it as non-matching and continue
      }
    }

    return { action: "allow", reason: "no matching rule" };
  }

  /** Evaluate a post-execution rule with the actual output. */
  evaluateOutput(toolCall: ToolCall, output: string, ctx: ToolContext): RuleDecision {
    const matchedRules = this.rules.filter(
      (r) => r.phase === "post" && (r.toolId === "*" || r.toolId === toolCall.name)
    );

    for (const rule of matchedRules) {
      try {
        if (rule.condition(toolCall, ctx)) {
          const sanitizedOutput = rule.sanitize ? rule.sanitize(output) : undefined;
          return { action: rule.action, reason: rule.reason, sanitizedOutput };
        }
      } catch {
        // continue
      }
    }

    return { action: "allow", reason: "no matching rule" };
  }

  /** List all registered rules. */
  listRules(): ToolRule[] {
    return [...this.rules];
  }
}

// ─── Built-in safety rules ────────────────────────────────────────────────────

/** Dangerous path patterns for write_file and similar filesystem tools. */
const DANGEROUS_PATH_PATTERNS = [
  /^\//,                          // absolute paths
  /^\.\.\//,                      // leading ../
  /^\.env/i,                      // .env files
  /^\.ssh/i,                      // SSH config
  /^\.git/i,                      // git internals
  /^\/etc\//i,
  /^\/usr\//i,
  /^\/var\//i,
  /^\/tmp\//i,
  /^\/home\//i,
  /\/\.bashrc$/i,
  /\/\.bash_profile$/i,
  /\/\.zshrc$/i,
  /\/\.profile$/i
];

/** Dangerous command patterns for run_code (bash mode). */
const DANGEROUS_COMMAND_PATTERNS = [
  /\brm\s+-rf\s+\//i,            // rm -rf /
  /\bsudo\b/i,                    // sudo usage
  /\bcurl\b.*\|\s*(bash|sh)\b/i,  // curl | bash
  /\bwget\b.*\|\s*(bash|sh)\b/i,  // wget | bash
  /\bmkfs\b/i,                    // filesystem formatting
  /\bdd\s+if=/i,                  // raw disk writing
  /\bchmod\s+[0-7]?777\b/i,      // chmod 777
  /\bchown\b/i,                   // ownership changes
  /\bmount\b/i,                   // mount operations
  /\bumount\b/i,                  // unmount operations
  /\bpasswd\b/i,                  // password changes
  /\buseradd\b/i,                 // user creation
  /\buserdel\b/i,                 // user deletion
  /\biptables\b/i,                // firewall changes
  /\bsystemctl\b/i,               // system service management
  /\breboot\b/i,                  // system reboot
  /\bshutdown\b/i,                // system shutdown
  /\bfork\s+bomb/i,               // fork bomb references
  /:\(\)\s*\{\s*:\|:&\s*\};:/,    // actual fork bomb syntax
  /\beval\s+.*\$/i,               // eval with shell expansion
  /\bexec\b.*\$\(/i,              // exec with command substitution
];

/** Patterns that indicate sensitive data in output. */
const SENSITIVE_DATA_PATTERNS = [
  { regex: /(sk-[a-zA-Z0-9]{20,})/g, replacement: "[REDACTED_API_KEY]" },
  { regex: /(ghp_[a-zA-Z0-9]{36})/g, replacement: "[REDACTED_GITHUB_TOKEN]" },
  { regex: /(xox[bpos]-[a-zA-Z0-9-]+)/g, replacement: "[REDACTED_SLACK_TOKEN]" },
  { regex: /("password"\s*:\s*"[^"]+")/gi, replacement: '"password": "[REDACTED]"' },
  { regex: /("secret"\s*:\s*"[^"]+")/gi, replacement: '"secret": "[REDACTED]"' },
  { regex: /(AKIA[0-9A-Z]{16})/g, replacement: "[REDACTED_AWS_KEY]" },
];

/**
 * Create a rules engine with all built-in safety rules.
 *
 * Rules are evaluated in registration order. The first matching rule
 * determines the action. If no rule matches, the tool call is allowed.
 */
export function createDefaultRulesEngine(): RulesEngine {
  const engine = new RulesEngine();

  // ─── Pre-execution rules ─────────────────────────────────────────────────

  // Rule: write_file — reject dangerous paths
  engine.register({
    id: "block-dangerous-paths",
    toolId: "write_file",
    phase: "pre",
    condition: (call) => {
      const rawPath = String(call.arguments?.path ?? "").trim();
      if (!rawPath) return true;  // empty path → deny (let executor give proper error)
      return DANGEROUS_PATH_PATTERNS.some((pattern) => pattern.test(rawPath));
    },
    action: "deny",
    reason: "Path is not allowed (system paths, dotfiles, or absolute paths outside workspace)"
  });

  // Rule: run_code (bash) — reject dangerous commands
  engine.register({
    id: "block-dangerous-commands",
    toolId: "run_code",
    phase: "pre",
    condition: (call) => {
      if (call.arguments?.language !== "bash") return false;
      const code = String(call.arguments?.code ?? "");
      return DANGEROUS_COMMAND_PATTERNS.some((pattern) => pattern.test(code));
    },
    action: "deny",
    reason: "Command contains dangerous operations (system modification, network, or user management)"
  });

  // Rule: run_code (python) — reject os.system with dangerous patterns
  engine.register({
    id: "block-dangerous-python",
    toolId: "run_code",
    phase: "pre",
    condition: (call) => {
      if (call.arguments?.language !== "python") return false;
      const code = String(call.arguments?.code ?? "");
      // Check for subprocess calls with dangerous commands
      const dangerousPatterns = [
        /os\.system\s*\(.*['"](rm\s+-rf\s+\/|sudo|mkfs|dd\s+if=|chmod.*777|passwd|useradd|userdel)['"]/,
        /subprocess\.\w+\s*\(.*['"](rm\s+-rf\s+\/|sudo|mkfs|dd\s+if=)['"]/,
        /__import__\s*\(\s*['"]os['"]\s*\).*system\s*\(.*['"]\//
      ];
      return dangerousPatterns.some((pattern) => pattern.test(code));
    },
    action: "deny",
    reason: "Python code contains dangerous system operations"
  });

  // Rule: run_code — reject code that is too long (resource protection)
  engine.register({
    id: "block-excessive-code-length",
    toolId: "run_code",
    phase: "pre",
    condition: (call) => {
      const code = String(call.arguments?.code ?? "");
      return code.length > 50_000;  // 50KB limit
    },
    action: "deny",
    reason: "Code exceeds maximum length (50KB)"
  });

  // Rule: web_search — reject empty queries
  engine.register({
    id: "block-empty-search",
    toolId: "web_search",
    phase: "pre",
    condition: (call) => {
      const query = String(call.arguments?.query ?? "").trim();
      return !query;
    },
    action: "deny",
    reason: "Search query is empty"
  });

  // ─── Post-execution rules ────────────────────────────────────────────────

  // Rule: sanitize sensitive data from all tool outputs
  engine.register({
    id: "sanitize-sensitive-output",
    toolId: "*",
    phase: "post",
    condition: (_call, _ctx) => true,  // always runs, but only sanitizes if data is found
    action: "sanitize",
    sanitize: (output) => {
      let result = output;
      for (const { regex, replacement } of SENSITIVE_DATA_PATTERNS) {
        result = result.replace(regex, replacement);
      }
      return result;
    },
    reason: "Output may contain sensitive data (API keys, passwords, tokens)"
  });

  return engine;
}

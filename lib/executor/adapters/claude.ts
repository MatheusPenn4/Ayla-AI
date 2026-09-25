// Claude via the official Claude Code CLI in print mode, authenticated with the
// user's own claude.ai subscription login (stored by Claude Code itself).
// Docs: https://code.claude.com/docs/en/headless
// - no tools (--tools ""), no MCP (--strict-mcp-config), no user/project
//   customizations (--safe-mode, --setting-sources ""), no session saved;
// - the system prompt is passed as a file, the demand through stdin;
// - never --bare: bare mode ignores the subscription login.
import { writeFileSync } from "node:fs";
import path from "node:path";
import type { CallUsage } from "@/lib/engine/types";
import type { Invocation } from "../clients";
import { clientEnv, type Runner, type EnvVars } from "../proc";
import { AgentError, ERROR_MESSAGE, classifyClientError, type AgentAdapter, type AgentCall, type AgentReply } from "./types";

type ClaudeResult = {
  type?: string; subtype?: string; is_error?: boolean; result?: string; structured_output?: unknown; api_error_status?: number | null;
  terminal_reason?: string;
  modelUsage?: Record<string, { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number; thinkingTokens?: number }>;
};

const MODEL_RE = /^[A-Za-z0-9._\-[\]]{1,80}$/;
const EFFORT_RE = /^[a-z]{2,12}$/;

export function claudeArgs(c: AgentCall, systemFile: string): string[] {
  const args = [
    "-p", "--output-format", "json",
    "--json-schema", JSON.stringify(c.schema),
    "--system-prompt-file", systemFile,
    "--tools", "",
    "--strict-mcp-config",
    "--setting-sources", "",
    "--safe-mode",
    "--disable-slash-commands",
    "--no-session-persistence",
    // Second layer: even if a tool appeared, anything that would need permission is denied.
    "--permission-mode", "dontAsk",
    "--disallowedTools", "Bash,PowerShell,Edit,Write,NotebookEdit,WebFetch,WebSearch",
  ];
  if (c.model) { if (!MODEL_RE.test(c.model)) throw new AgentError("model_unavailable", "Nome de modelo inválido na ficha.", false); args.push("--model", c.model); }
  if (c.effort) { if (!EFFORT_RE.test(c.effort)) throw new AgentError("client_error", "Nível de esforço inválido na ficha.", false); args.push("--effort", c.effort); }
  return args;
}

export function parseClaudeOutput(stdout: string): ClaudeResult | null {
  const lines = stdout.trim().split(/\r?\n/).reverse();
  for (const line of lines) {
    const l = line.trim();
    if (!l.startsWith("{")) continue;
    try { const j = JSON.parse(l) as ClaudeResult; if (j.type === "result") return j; } catch { /* not the result line */ }
  }
  try { const j = JSON.parse(stdout) as ClaudeResult; return j.type === "result" ? j : null; } catch { return null; }
}

/** Sum of one field over the models; null when no model reported that field. */
const sumField = <T,>(items: T[], get: (x: T) => number | undefined) => {
  const vals = items.map(get).filter((n): n is number => typeof n === "number" && Number.isFinite(n));
  return vals.length ? vals.reduce((x, y) => x + y, 0) : null;
};

export const CLAUDE_USAGE_SOURCE = "Claude Code · campo modelUsage da saída JSON (--output-format json)";

export function claudeUsage(r: ClaudeResult, label: string): CallUsage | null {
  const entries = Object.entries(r.modelUsage ?? {});
  if (!entries.length) return null;
  const models = entries.map(([, m]) => m);
  return {
    label,
    inputTokens: sumField(models, m => m.inputTokens),
    outputTokens: sumField(models, m => m.outputTokens),
    cacheReadTokens: sumField(models, m => m.cacheReadInputTokens),
    cacheWriteTokens: sumField(models, m => m.cacheCreationInputTokens),
    reasoningTokens: sumField(models, m => m.thinkingTokens),
    model: entries.map(([m]) => m).join(", "),
    source: CLAUDE_USAGE_SOURCE,
  };
}

export function claudeAdapter(inv: Invocation, runner: Runner, env: EnvVars = process.env): AgentAdapter {
  return {
    id: "claude_code",
    async call(c: AgentCall): Promise<AgentReply> {
      const systemFile = path.join(c.workDir, "system-prompt.txt");
      writeFileSync(systemFile, c.system, "utf8");
      const res = await runner({ command: inv.command, args: [...inv.prefix, ...claudeArgs(c, systemFile)], cwd: c.workDir, stdin: c.user, env: clientEnv(env), timeoutMs: c.timeoutMs, signal: c.signal });
      if (res.spawnError) throw new AgentError("not_installed", ERROR_MESSAGE.not_installed, false, res.spawnError);
      if (res.aborted) throw new AgentError("canceled", ERROR_MESSAGE.canceled, false);
      if (res.timedOut) throw new AgentError("timeout", ERROR_MESSAGE.timeout, true);
      if (res.truncated) throw new AgentError("output_too_large", ERROR_MESSAGE.output_too_large, false);
      const r = parseClaudeOutput(res.stdout);
      if (!r) {
        const cls = classifyClientError(`${res.stderr}\n${res.stdout}`);
        throw new AgentError(cls.code, ERROR_MESSAGE[cls.code], cls.retryable, (res.stderr || res.stdout).trim().slice(0, 600) || `código de saída ${res.code}`);
      }
      const usage = claudeUsage(r, c.label);
      if (r.is_error || res.code !== 0) {
        const text = `${r.result ?? ""} ${r.terminal_reason ?? ""} ${res.stderr}`;
        const cls = classifyClientError(text, r.api_error_status);
        const err = new AgentError(cls.code, ERROR_MESSAGE[cls.code], cls.retryable, (r.result ?? res.stderr).trim().slice(0, 600));
        (err as AgentError & { usage?: CallUsage | null }).usage = usage;
        throw err;
      }
      const output = r.structured_output ?? (() => { try { return JSON.parse(r.result ?? ""); } catch { return null; } })();
      return { output, text: typeof r.result === "string" ? r.result : JSON.stringify(r.structured_output ?? null), usage };
    },
  };
}

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

type ClaudeIteration = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
type ClaudeResult = {
  type?: string; subtype?: string; is_error?: boolean; result?: string; structured_output?: unknown; api_error_status?: number | null;
  terminal_reason?: string; num_turns?: number; duration_ms?: number;
  usage?: { iterations?: ClaudeIteration[] };
  modelUsage?: Record<string, { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number; thinkingTokens?: number }>;
};

const MODEL_RE = /^[A-Za-z0-9._\-[\]]{1,80}$/;
const EFFORT_RE = /^[a-z]{2,12}$/;

export function claudeArgs(c: AgentCall, systemFile: string): string[] {
  const args = [
    // stream-json + verbose: one JSON event per line while it runs (progress, API retries, per-message usage);
    // the last line is the same "result" object the json format prints.
    "-p", "--output-format", "stream-json", "--verbose",
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

export const CLAUDE_USAGE_SOURCE = "Claude Code · campo modelUsage do evento result (--output-format stream-json)";
export const CLAUDE_PARTIAL_SOURCE = "Claude Code · usage das mensagens recebidas antes do encerramento (parcial e limite inferior: o cliente informa o uso no início de cada mensagem)";

type StreamUsage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
type StreamEvent = {
  type?: string; subtype?: string; model?: string;
  attempt?: number; max_retries?: number; retry_delay_ms?: number; error_status?: number | null; error?: string;
  message?: { id?: string; usage?: StreamUsage; content?: { type?: string }[] };
};

/** Follows the stream: reports progress and keeps the last usage seen per model message (partial usage on failure). */
export function claudeStreamTracker(label: string, onProgress?: AgentCall["onProgress"]) {
  const usageById = new Map<string, StreamUsage>();
  const ids = new Set<string>();
  let messages = 0, events = 0, lastEvent = "nenhum evento recebido";
  const onLine = (line: string) => {
    const l = line.trim();
    if (!l.startsWith("{")) return;
    let e: StreamEvent;
    try { e = JSON.parse(l) as StreamEvent; } catch { return; }
    if (e.type === "system" && e.subtype === "init") { lastEvent = "sessão iniciada"; onProgress?.({ kind: "started", message: `Claude Code iniciou a sessão${e.model ? ` (modelo ${e.model})` : ""}.`, data: { model: e.model } }); }
    else if (e.type === "system" && e.subtype === "api_retry") {
      lastEvent = `repetição da requisição (${e.error ?? "erro"})`;
      onProgress?.({ kind: "api_retry", message: `O cliente repetiu a requisição ao modelo: ${e.error ?? "erro"}${e.error_status ? ` (HTTP ${e.error_status})` : ""}, tentativa ${e.attempt ?? "?"} de ${e.max_retries ?? "?"}, espera ${Math.round((e.retry_delay_ms ?? 0) / 1000)} s.`, data: { attempt: e.attempt, max: e.max_retries, error: e.error, status: e.error_status, delayMs: e.retry_delay_ms } });
    } else if (e.type === "assistant" && e.message) {
      events++;
      if (e.message.id) ids.add(e.message.id);
      messages = ids.size || events;
      if (e.message.id && e.message.usage) usageById.set(e.message.id, e.message.usage);
      const kinds = (e.message.content ?? []).map(c => c.type).filter(Boolean).join(", ");
      lastEvent = `mensagem do modelo nº ${messages} (${kinds || "sem conteúdo"})`;
      const out = [...usageById.values()].reduce((n, u) => n + (u.output_tokens ?? 0), 0);
      // The usage inside a streamed message is reported when the message starts (observed: 3 tokens for a message
      // that ended with thousands), so it is kept only as a lower bound and not shown as progress.
      onProgress?.({ kind: "model_output", message: `O modelo enviou a mensagem nº ${messages} (${kinds || "sem conteúdo"}).`, data: { messages, outputLowerBound: out } });
    } else if (e.type === "user") { lastEvent = "resultado de ferramenta devolvido ao modelo"; onProgress?.({ kind: "turn", message: "O cliente devolveu ao modelo o resultado da ferramenta de saída estruturada (novo turno)." }); }
  };
  const partial = (): CallUsage | null => {
    if (!usageById.size) return null;
    const us = [...usageById.values()];
    const f = (k: keyof StreamUsage) => sumField(us, u => u[k]);
    return { label: `${label} (parcial, antes do encerramento)`, inputTokens: f("input_tokens"), outputTokens: f("output_tokens"), cacheReadTokens: f("cache_read_input_tokens"), cacheWriteTokens: f("cache_creation_input_tokens"), reasoningTokens: null, model: null, source: CLAUDE_PARTIAL_SOURCE, apiCalls: us.map(u => ({ inputTokens: u.input_tokens ?? null, outputTokens: u.output_tokens ?? null, cacheReadTokens: u.cache_read_input_tokens ?? null, cacheWriteTokens: u.cache_creation_input_tokens ?? null })) };
  };
  return { onLine, partial, summary: () => `${messages} mensagem(ns) distinta(s) do modelo em ${events} evento(s); último evento: ${lastEvent}` };
}

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
    // One entry per request the client made to the model (e.g. the structured-output turn and the final turn).
    apiCalls: (r.usage?.iterations ?? []).map(it => ({
      inputTokens: typeof it.input_tokens === "number" ? it.input_tokens : null,
      outputTokens: typeof it.output_tokens === "number" ? it.output_tokens : null,
      cacheReadTokens: typeof it.cache_read_input_tokens === "number" ? it.cache_read_input_tokens : null,
      cacheWriteTokens: typeof it.cache_creation_input_tokens === "number" ? it.cache_creation_input_tokens : null,
    })),
    turns: typeof r.num_turns === "number" ? r.num_turns : null,
    durationMs: typeof r.duration_ms === "number" ? r.duration_ms : null,
  };
}

export function claudeAdapter(inv: Invocation, runner: Runner, env: EnvVars = process.env): AgentAdapter {
  return {
    id: "claude_code",
    async call(c: AgentCall): Promise<AgentReply> {
      const systemFile = path.join(c.workDir, "system-prompt.txt");
      writeFileSync(systemFile, c.system, "utf8");
      const tracker = claudeStreamTracker(c.label, c.onProgress);
      const res = await runner({ command: inv.command, args: [...inv.prefix, ...claudeArgs(c, systemFile)], cwd: c.workDir, stdin: c.user, env: clientEnv(env), timeoutMs: c.timeoutMs, signal: c.signal, onStdoutLine: tracker.onLine });
      if (res.spawnError) throw new AgentError("not_installed", ERROR_MESSAGE.not_installed, false, res.spawnError);
      // Stopped before the end: keep what the client did report (partial usage, last event, stderr tail).
      const stopped = (code: "canceled" | "timeout" | "output_too_large", retry: boolean) => {
        const e = new AgentError(code, ERROR_MESSAGE[code], retry, `${tracker.summary()}.${res.stderr.trim() ? ` stderr: ${res.stderr.trim().slice(-400)}` : " stderr vazio."}`);
        e.usage = tracker.partial();
        return e;
      };
      if (res.aborted) throw stopped("canceled", false);
      if (res.timedOut) throw stopped("timeout", true);
      if (res.truncated) throw stopped("output_too_large", false);
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

// ChatGPT (Business, Plus, …) via the official Codex CLI in non-interactive
// mode, authenticated with the ChatGPT login stored by Codex itself.
// Docs: https://developers.openai.com/codex/noninteractive
// - read-only sandbox in an empty folder, shell and extra tools disabled,
//   web search off, user config ignored, session not persisted;
// - the whole prompt goes through stdin ("-"), the schema as a file.
import { writeFileSync } from "node:fs";
import path from "node:path";
import type { CallUsage } from "@/lib/engine/types";
import type { Invocation } from "../clients";
import { clientEnv, type Runner, type EnvVars } from "../proc";
import { AgentError, ERROR_MESSAGE, classifyClientError, type AgentAdapter, type AgentCall, type AgentReply } from "./types";

const MODEL_RE = /^[A-Za-z0-9._-]{1,80}$/;
const EFFORT_RE = /^[a-z]{2,12}$/;

/** Codex features that would give the model tools it does not need to plan. */
const DISABLED_FEATURES = ["shell_tool", "unified_exec", "apps", "plugins", "browser_use", "computer_use", "image_generation", "multi_agent", "hooks"];

export function codexArgs(c: AgentCall, schemaFile: string): string[] {
  const args = [
    "exec", "-",
    "--json",
    "--output-schema", schemaFile,
    "--sandbox", "read-only",
    "--cd", c.workDir,
    "--skip-git-repo-check",
    "--ephemeral",
    "--ignore-user-config",
    "-c", 'web_search="disabled"',
  ];
  for (const f of DISABLED_FEATURES) args.push("--disable", f);
  if (c.model) { if (!MODEL_RE.test(c.model)) throw new AgentError("model_unavailable", "Nome de modelo inválido na ficha.", false); args.push("--model", c.model); }
  if (c.effort) { if (!EFFORT_RE.test(c.effort)) throw new AgentError("client_error", "Nível de esforço inválido na ficha.", false); args.push("-c", `model_reasoning_effort="${c.effort}"`); }
  return args;
}

/** Codex has no separate system prompt in exec mode: both parts go in stdin, clearly delimited. */
export function codexPrompt(c: Pick<AgentCall, "system" | "user">) {
  return `=== INSTRUÇÕES DA EXECUÇÃO (Setor IA) ===\n${c.system}\n\n=== SOLICITAÇÃO ===\n${c.user}\n`;
}

type Ev = { type?: string; message?: string; error?: { message?: string }; item?: { type?: string; text?: string; message?: string }; usage?: Record<string, number> };

export function parseCodexEvents(stdout: string, label: string) {
  let text: string | null = null;
  let failure: string | null = null;
  const errors: string[] = [];
  let usage: CallUsage | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    const l = line.trim();
    if (!l.startsWith("{")) continue;
    let e: Ev;
    try { e = JSON.parse(l) as Ev; } catch { continue; }
    if (e.type === "item.completed" && e.item?.type === "agent_message" && typeof e.item.text === "string") text = e.item.text;
    else if (e.type === "turn.failed") failure = e.error?.message ?? "turn.failed";
    else if (e.type === "error" && e.message) errors.push(e.message);
    else if (e.type === "turn.completed" && e.usage) {
      const u = e.usage;
      usage ??= { label, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, model: null };
      usage.inputTokens += Math.max(0, (u.input_tokens ?? 0) - (u.cached_input_tokens ?? 0));
      usage.cacheReadTokens += u.cached_input_tokens ?? 0;
      usage.cacheWriteTokens += u.cache_write_input_tokens ?? 0;
      usage.outputTokens += u.output_tokens ?? 0;
      usage.reasoningTokens += u.reasoning_output_tokens ?? 0;
    }
  }
  return { text, failure, errors, usage };
}

export function codexAdapter(inv: Invocation, runner: Runner, env: EnvVars = process.env): AgentAdapter {
  return {
    id: "codex",
    async call(c: AgentCall): Promise<AgentReply> {
      const schemaFile = path.join(c.workDir, "output-schema.json");
      writeFileSync(schemaFile, JSON.stringify(c.schema), "utf8");
      const args = [...inv.prefix, ...codexArgs(c, schemaFile)];
      const res = await runner({ command: inv.command, args, cwd: c.workDir, stdin: codexPrompt(c), env: clientEnv(env), timeoutMs: c.timeoutMs, signal: c.signal });
      if (res.spawnError) throw new AgentError("not_installed", ERROR_MESSAGE.not_installed, false, res.spawnError);
      if (res.aborted) throw new AgentError("canceled", ERROR_MESSAGE.canceled, false);
      const ev = parseCodexEvents(res.stdout, c.label);
      if (res.timedOut) {
        // A timeout while the client kept retrying an auth/limit error is reported as that error.
        const last = ev.errors.at(-1);
        if (last) { const cls = classifyClientError(last); if (cls.code !== "client_error" && cls.code !== "connection_lost") throw new AgentError(cls.code, ERROR_MESSAGE[cls.code], cls.retryable, last.slice(0, 600)); }
        throw new AgentError("timeout", ERROR_MESSAGE.timeout, true, last?.slice(0, 600));
      }
      if (res.truncated) throw new AgentError("output_too_large", ERROR_MESSAGE.output_too_large, false);
      if (ev.failure || res.code !== 0 || ev.text === null) {
        const detail = ev.failure ?? ev.errors.at(-1) ?? (res.stderr.trim().split(/\r?\n/).slice(-3).join(" ") || `código de saída ${res.code}`);
        const cls = classifyClientError(`${detail}\n${ev.failure ? "" : res.stderr}`);
        const err = new AgentError(cls.code, ERROR_MESSAGE[cls.code], cls.retryable, detail.slice(0, 600) || `código de saída ${res.code}`);
        (err as AgentError & { usage?: CallUsage | null }).usage = ev.usage;
        throw err;
      }
      let output: unknown = null;
      try { output = JSON.parse(ev.text); } catch { output = null; }
      return { output, text: ev.text, usage: ev.usage };
    },
  };
}

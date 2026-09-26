// Official-client adapters and detection, with the process runner replaced by
// recorded outputs (simulated). The outputs below were captured from the real
// clients on the development machine (Claude Code 2.1.280, Codex CLI 0.151.0).
// The real process runner is tested with node itself (no shell involved).
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeAdapter, claudeArgs, parseClaudeOutput } from "@/lib/executor/adapters/claude";
import { codexAdapter, codexArgs, parseCodexEvents } from "@/lib/executor/adapters/codex";
import { AgentError, classifyClientError, type AgentCall } from "@/lib/executor/adapters/types";
import { detectClaude, detectCodex, parseClaudeHelp, parseCodexModels, resolveClient, type ClientDeps } from "@/lib/executor/clients";
import { clientEnv, runProcess, type ProcResult, type ProcSpec, type Runner } from "@/lib/executor/proc";

let work: string;
beforeEach(() => { work = mkdtempSync(path.join(os.tmpdir(), "ayla-ad-")); });
afterEach(() => { rmSync(work, { recursive: true, force: true }); });

const ok = (stdout: string, extra: Partial<ProcResult> = {}): ProcResult => ({ code: 0, stdout, stderr: "", timedOut: false, aborted: false, truncated: false, spawnError: null, ...extra });
/** Runner that answers by the first matching argument pattern and records every spec. */
function scripted(routes: [RegExp, ProcResult][]) {
  const seen: ProcSpec[] = [];
  const runner: Runner = async spec => {
    seen.push(spec);
    const joined = spec.args.join(" ");
    const hit = routes.find(([re]) => re.test(joined));
    return hit ? hit[1] : ok("", { code: 1, stderr: "rota não prevista" });
  };
  return { runner, seen };
}

const call = (over: Partial<AgentCall> = {}): AgentCall => ({ label: "planejamento", system: "SISTEMA", user: "DEMANDA com \"aspas\" e ; rm -rf / && $(whoami)", schema: { type: "object" }, model: "", effort: "", timeoutMs: 5000, workDir: work, ...over });

// Captured from `claude -p --output-format json --json-schema …` (trimmed).
const CLAUDE_OK = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "{\"ok\":true}", structured_output: { ok: true }, api_error_status: null, modelUsage: { "claude-sonnet-5": { inputTokens: 2, outputTokens: 75, cacheReadInputTokens: 0, cacheCreationInputTokens: 1401, thinkingTokens: 0 } } });
const CLAUDE_NOT_LOGGED = JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login", api_error_status: null, terminal_reason: "api_error", modelUsage: {} });
const CLAUDE_BAD_MODEL = JSON.stringify({ type: "result", subtype: "success", is_error: true, api_error_status: 404, result: "There's an issue with the selected model (claude-nao-existe-9). It may not exist or you may not have access to it. Run --model to pick a different model.", modelUsage: {} });
const CLAUDE_EXPIRED = JSON.stringify({ type: "result", is_error: true, result: "Login expired · Please run /login", api_error_status: 401, modelUsage: {} });
const CLAUDE_LIMIT = JSON.stringify({ type: "result", is_error: true, result: "You've hit your usage limit · resets 5pm", api_error_status: 429, modelUsage: {} });
// Captured from `codex exec - --json --output-schema …`.
const CODEX_OK = [
  '{"type":"thread.started","thread_id":"01a0"}', '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"{\\"ok\\":true,\\"nota\\":\\"teste\\"}"}}',
  '{"type":"turn.completed","usage":{"input_tokens":9961,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":19,"reasoning_output_tokens":0}}',
].join("\n");
const CODEX_BAD_MODEL = [
  '{"type":"thread.started","thread_id":"01a0"}',
  '{"type":"turn.failed","error":{"message":"{\\"type\\":\\"error\\",\\"status\\":400,\\"error\\":{\\"type\\":\\"invalid_request_error\\",\\"message\\":\\"The \'modelo-nao-existe-9\' model is not supported when using Codex with a ChatGPT account.\\"}}"}}',
].join("\n");
const CODEX_401 = '{"type":"thread.started","thread_id":"x"}\n{"type":"turn.started"}\n{"type":"error","message":"Reconnecting... 2/5 (unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: wss://api.openai.com/v1/responses)"}';

describe("adaptador Claude Code (assinatura)", () => {
  it("argumentos: modo -p, sem ferramentas, sem MCP, sem personalizações, sem sessão salva e nunca --bare", () => {
    const args = claudeArgs(call({ model: "sonnet", effort: "high" }), "sys.txt");
    expect(args[args.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(args).toEqual(expect.arrayContaining(["-p", "--verbose", "--json-schema", "--system-prompt-file", "sys.txt", "--strict-mcp-config", "--safe-mode", "--disable-slash-commands", "--no-session-persistence"]));
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    expect(args).not.toContain("--bare");
    expect(args.slice(-4)).toEqual(["--model", "sonnet", "--effort", "high"]);
    expect(args.join(" ")).not.toContain("DEMANDA");
  });
  it("demanda vai por stdin; instruções por arquivo; ambiente sem chaves de API", async () => {
    const { runner, seen } = scripted([[/-p/, ok(CLAUDE_OK)]]);
    const r = await claudeAdapter({ command: "claude.exe", prefix: [], source: "t" }, runner, { ANTHROPIC_API_KEY: "sk-x", CLAUDE_CODE_OAUTH_TOKEN: "t", PATH: "p" }).call(call());
    expect(r.output).toEqual({ ok: true });
    expect(r.usage).toMatchObject({ inputTokens: 2, outputTokens: 75, cacheWriteTokens: 1401, model: "claude-sonnet-5" });
    expect(seen[0].stdin).toContain("rm -rf");
    expect(seen[0].args.join(" ")).not.toContain("rm -rf");
    expect(seen[0].env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(seen[0].env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(seen[0].cwd).toBe(work);
    expect(readFileSync(path.join(work, "system-prompt.txt"), "utf8")).toBe("SISTEMA");
  });
  it("erros reais do cliente viram códigos distintos", async () => {
    const run = async (out: string) => claudeAdapter({ command: "c", prefix: [], source: "t" }, scripted([[/-p/, ok(out, { code: 1 })]]).runner, {}).call(call()).catch(e => e as AgentError);
    expect(((await run(CLAUDE_NOT_LOGGED)) as AgentError).code).toBe("not_connected");
    expect(((await run(CLAUDE_BAD_MODEL)) as AgentError).code).toBe("model_unavailable");
    expect(((await run(CLAUDE_EXPIRED)) as AgentError).code).toBe("session_expired");
    expect(((await run(CLAUDE_LIMIT)) as AgentError).code).toBe("usage_limit");
  });
  it("cliente ausente, tempo esgotado e cancelamento", async () => {
    const mk = (r: ProcResult) => claudeAdapter({ command: "c", prefix: [], source: "t" }, async () => r, {}).call(call()).catch(e => (e as AgentError).code);
    expect(await mk(ok("", { code: null, spawnError: "Executável não encontrado." }))).toBe("not_installed");
    expect(await mk(ok("", { code: null, timedOut: true }))).toBe("timeout");
    expect(await mk(ok("", { code: null, aborted: true }))).toBe("canceled");
    expect(await mk(ok("lixo sem json", { code: 3 }))).toBe("client_error");
  });
  it("modelo com caracteres inválidos é recusado sem executar", () => {
    expect(() => claudeArgs(call({ model: "x --bare" }), "s")).toThrow(AgentError);
  });
  it("lê a última linha de resultado mesmo com avisos antes", () => {
    expect(parseClaudeOutput(`[claude-code:aviso] algo\n${CLAUDE_OK}\n`)?.structured_output).toEqual({ ok: true });
  });
});

describe("adaptador Codex CLI (ChatGPT)", () => {
  it("argumentos: exec por stdin, sandbox somente leitura em pasta vazia, sem shell e sem busca", () => {
    const args = codexArgs(call({ model: "gpt-5.5", effort: "high" }), "schema.json");
    expect(args.slice(0, 3)).toEqual(["exec", "-", "--json"]);
    expect(args).toEqual(expect.arrayContaining(["--output-schema", "schema.json", "--sandbox", "read-only", "--cd", work, "--skip-git-repo-check", "--ephemeral", "--ignore-user-config", "--disable", "shell_tool", "unified_exec", 'web_search="disabled"', "--model", "gpt-5.5", 'model_reasoning_effort="high"']));
    expect(args).not.toContain("danger-full-access");
    expect(args.join(" ")).not.toContain("DEMANDA");
  });
  it("resposta e uso informados pelo cliente; ambiente sem chaves", async () => {
    const { runner, seen } = scripted([[/^.*exec/, ok(CODEX_OK)]]);
    const r = await codexAdapter({ command: "node", prefix: ["codex.js"], source: "t" }, runner, { OPENAI_API_KEY: "sk", CODEX_API_KEY: "k" }).call(call());
    expect(r.output).toEqual({ ok: true, nota: "teste" });
    expect(r.usage).toMatchObject({ inputTokens: 9961, outputTokens: 19, model: null });
    expect(seen[0].args[0]).toBe("codex.js");
    expect(seen[0].stdin).toContain("=== INSTRUÇÕES DA EXECUÇÃO (Setor IA) ===\nSISTEMA");
    expect(seen[0].env.OPENAI_API_KEY).toBeUndefined();
    expect(seen[0].env.CODEX_API_KEY).toBeUndefined();
  });
  it("modelo não suportado pela conta, sessão recusada e limite de uso", async () => {
    const run = async (r: ProcResult) => codexAdapter({ command: "c", prefix: [], source: "t" }, async () => r, {}).call(call()).catch(e => e as AgentError);
    expect(((await run(ok(CODEX_BAD_MODEL, { code: 1 }))) as AgentError).code).toBe("model_unavailable");
    // Codex keeps reconnecting on 401 until our timeout: reported as the auth problem, not as a timeout.
    expect(((await run(ok(CODEX_401, { code: null, timedOut: true }))) as AgentError).code).toBe("not_connected");
    expect(((await run(ok('{"type":"turn.failed","error":{"message":"You\'ve hit your usage limit. Try again later."}}', { code: 1 }))) as AgentError).code).toBe("usage_limit");
  });
  it("soma o uso de todos os turnos informados", () => {
    const e = parseCodexEvents(`${CODEX_OK}\n{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":40,"output_tokens":5}}`, "x");
    expect(e.usage).toMatchObject({ inputTokens: 9961 + 60, cacheReadTokens: 40, outputTokens: 24 });
  });
});

describe("classificação de erros dos clientes", () => {
  it.each([
    ["Not logged in · Please run /login", "not_connected"],
    ["Login expired · Please run /login", "session_expired"],
    ["You've hit your usage limit", "usage_limit"],
    ["429 Too Many Requests", "usage_limit"],
    ["stream disconnected before completion", "connection_lost"],
    ["algo inesperado", "client_error"],
  ])("%s → %s", (text, code) => expect(classifyClientError(text).code).toBe(code));
});

describe("detecção dos clientes oficiais", () => {
  const deps = (runner: Runner, files: string[] = [], extra: Partial<ClientDeps> = {}): ClientDeps => ({
    runner, env: { PATH: "C:\\bin;C:\\npm" }, platform: "win32", exists: p => files.includes(p), cwd: work, nodePath: "C:\\node\\node.exe", ...extra,
  });

  it("resolve o executável sem shell: .exe direto, shim .cmd do npm vira node + script", () => {
    expect(resolveClient("claude_code", deps(async () => ok(""), ["C:\\bin\\claude.exe"]))).toMatchObject({ command: "C:\\bin\\claude.exe", prefix: [] });
    const codexJs = "C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js";
    expect(resolveClient("codex", deps(async () => ok(""), ["C:\\npm\\codex.cmd", codexJs]))).toMatchObject({ command: "C:\\node\\node.exe", prefix: [codexJs] });
    expect(resolveClient("codex", deps(async () => ok(""), ["C:\\npm\\codex.cmd"]))).toBeNull();
    expect(resolveClient("claude_code", deps(async () => ok(""), [], { env: { PATH: "C:\\bin", AYLA_CLAUDE_PATH: "relativo\\claude.exe" } }))).toBeNull();
  });

  it("Claude: não instalado / sem login / login por chave de API / conectado pela assinatura", async () => {
    expect((await detectClaude(deps(async () => ok("")))).state).toBe("not_installed");
    const files = ["C:\\bin\\claude.exe"];
    const help = "  --effort <level>   Effort level (low, medium, high, xhigh, max)\n  --model <model>   Model. Provide an alias (e.g. 'fable', 'opus', or 'sonnet') or a model's full name (e.g.\n 'claude-fable-5').\n  -n, --name <name>  x";
    const mk = (status: unknown, code = 0) => scripted([[/--version/, ok("2.1.280 (Claude Code)")], [/--help/, ok(help)], [/auth status/, ok(JSON.stringify(status), { code })]]).runner;
    expect((await detectClaude(deps(mk({ loggedIn: false, authMethod: "none", apiProvider: "firstParty" }, 1), files))).state).toBe("disconnected");
    const apiKey = await detectClaude(deps(mk({ loggedIn: true, authMethod: "api_key", apiProvider: "firstParty" }), files));
    expect(apiKey.state).toBe("disconnected");
    expect(apiKey.message).toContain("não usa chaves de API");
    const good = await detectClaude(deps(mk({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "team" }), files));
    expect(good).toMatchObject({ state: "connected", account: "Claude Team", version: "2.1.280 (Claude Code)", efforts: ["low", "medium", "high", "xhigh", "max"] });
    expect(good.models.map(m => m.value)).toEqual(["fable", "opus", "sonnet"]);
    expect(JSON.stringify(good)).not.toMatch(/@|email/i);
    expect((await detectClaude(deps(async s => (s.args.includes("--version") ? ok("", { code: null, timedOut: true }) : ok("")), files))).state).toBe("unavailable");
  });

  it("Codex: não instalado / sem login / chave de API / conectado pelo ChatGPT com catálogo do cliente", async () => {
    expect((await detectCodex(deps(async () => ok("")))).state).toBe("not_installed");
    const files = ["C:\\bin\\codex.exe"];
    const catalog = JSON.stringify({ models: [{ slug: "gpt-reserve", display_name: "GPT-Reserve", visibility: "hide" }, { slug: "gpt-5.5", display_name: "GPT-5.5", visibility: "list", default_reasoning_level: "xhigh", supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }] }] });
    const mk = (status: ProcResult) => scripted([[/--version/, ok("codex-cli 0.151.0")], [/login status/, status], [/debug models/, ok(catalog)]]).runner;
    expect((await detectCodex(deps(mk(ok("", { code: 1, stderr: "Not logged in" })), files))).state).toBe("disconnected");
    expect((await detectCodex(deps(mk(ok("", { stderr: "Logged in using an API key - sk-***" })), files))).state).toBe("disconnected");
    const good = await detectCodex(deps(mk(ok("", { stderr: "Logged in using ChatGPT" })), files));
    expect(good).toMatchObject({ state: "connected", account: "ChatGPT", version: "codex-cli 0.151.0" });
    expect(good.models).toEqual([{ value: "gpt-5.5", label: "GPT-5.5", efforts: ["low", "high"], defaultEffort: "xhigh" }]);
  });

  it("ajuda e catálogo malformados não inventam modelos", () => {
    expect(parseClaudeHelp("sem nada")).toEqual({ models: [], efforts: [] });
    expect(parseCodexModels("não é json")).toEqual([]);
  });
});

describe("execução controlada de processos (real, com node)", () => {
  const node = process.execPath;
  it("argumentos estruturados e stdin literal: nada é interpretado por shell", async () => {
    const r = await runProcess({ command: node, args: ["-e", "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.stringify({argv:process.argv.slice(1),stdin:s})))", "a b; echo PWNED", "$(whoami)"], cwd: work, stdin: "texto; rm -rf / && `id`", env: clientEnv(), timeoutMs: 10000 });
    const out = JSON.parse(r.stdout);
    expect(out.argv).toEqual(["a b; echo PWNED", "$(whoami)"]);
    expect(out.stdin).toBe("texto; rm -rf / && `id`");
    expect(r.code).toBe(0);
  });
  it("tempo limite encerra o processo", async () => {
    const t = Date.now();
    const r = await runProcess({ command: node, args: ["-e", "setTimeout(()=>{},60000)"], cwd: work, env: clientEnv(), timeoutMs: 400 });
    expect(r.timedOut).toBe(true);
    expect(Date.now() - t).toBeLessThan(8000);
  });
  it("cancelamento encerra o processo", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const r = await runProcess({ command: node, args: ["-e", "setTimeout(()=>{},60000)"], cwd: work, env: clientEnv(), timeoutMs: 20000, signal: ac.signal });
    expect(r.aborted).toBe(true);
  });
  it("saída acima do limite é cortada e marcada", async () => {
    const r = await runProcess({ command: node, args: ["-e", "process.stdout.write('x'.repeat(200000))"], cwd: work, env: clientEnv(), timeoutMs: 10000, maxStdoutBytes: 1000 });
    expect(r.truncated).toBe(true);
    expect(r.stdout.length).toBeLessThanOrEqual(1000);
  });
  it("recusa scripts .cmd/.bat (exigiriam shell) e reporta executável ausente", async () => {
    expect((await runProcess({ command: "C:\\npm\\codex.cmd", args: [], cwd: work, env: {}, timeoutMs: 1000 })).spawnError).toContain(".cmd");
    expect((await runProcess({ command: path.join(work, "nao-existe.exe"), args: [], cwd: work, env: clientEnv(), timeoutMs: 1000 })).spawnError).toBeTruthy();
  });
  it("o ambiente dos clientes não carrega chaves de API nem o token do executor", () => {
    const env = clientEnv({ PATH: "x", ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "b", AYLA_EXECUTOR_TOKEN: "c", GITHUB_TOKEN: "d", HOME: "h" });
    expect(Object.keys(env).sort()).toEqual(["CI", "HOME", "NO_COLOR", "PATH"]);
  });
});

describe("Claude Code em fluxo (stream-json): progresso e uso parcial", () => {
  const INIT = JSON.stringify({ type: "system", subtype: "init", model: "claude-sonnet-5" });
  const RETRY = JSON.stringify({ type: "system", subtype: "api_retry", attempt: 1, max_retries: 10, retry_delay_ms: 4000, error_status: 529, error: "overloaded" });
  const MSG = (id: string, out: number) => JSON.stringify({ type: "assistant", message: { id, usage: { input_tokens: 3, output_tokens: out, cache_creation_input_tokens: 9000 }, content: [{ type: "thinking" }, { type: "tool_use" }] } });
  it("registra início, repetições da API e mensagens; no tempo esgotado guarda o uso parcial informado", async () => {
    const seen: string[] = [];
    const runner: Runner = async spec => {
      for (const l of [INIT, RETRY, MSG("m1", 100), MSG("m1", 900), MSG("m2", 50)]) spec.onStdoutLine?.(l);
      return ok([INIT, RETRY, MSG("m1", 900)].join("\n"), { code: null, timedOut: true, stderr: "algo no stderr" });
    };
    const err = (await claudeAdapter({ command: "c", prefix: [], source: "t" }, runner, {}).call(call({ onProgress: p => seen.push(p.kind) })).catch(e => e)) as AgentError;
    expect(err.code).toBe("timeout");
    expect(seen).toEqual(["started", "api_retry", "model_output", "model_output", "model_output"]);
    // Same message id twice: the last usage wins (no double counting).
    expect(err.usage).toMatchObject({ outputTokens: 950, cacheWriteTokens: 18000, source: expect.stringContaining("parcial") });
    expect(err.detail).toContain("2 mensagem(ns) distinta(s) do modelo em 3 evento(s)");
    expect(err.detail).toContain("algo no stderr");
  });
  it("o resultado final do fluxo é lido como no formato json", async () => {
    const out = [INIT, MSG("m1", 75), CLAUDE_OK].join("\n");
    const r = await claudeAdapter({ command: "c", prefix: [], source: "t" }, async () => ok(out), {}).call(call());
    expect(r.output).toEqual({ ok: true });
    expect(r.usage?.source).toContain("stream-json");
  });
  it("o executor de processos entrega cada linha completa enquanto o processo roda", async () => {
    const lines: string[] = [];
    const r = await runProcess({ command: process.execPath, args: ["-e", "process.stdout.write('a\\nb'); setTimeout(()=>process.stdout.write('c\\nd\\n'),50)"], cwd: work, env: clientEnv(), timeoutMs: 10000, onStdoutLine: l => lines.push(l) });
    expect(r.code).toBe(0);
    expect(lines).toEqual(["a", "bc", "d"]);
  });
});

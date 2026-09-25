// Detection of the official clients: installed? which version? logged in with
// the subscription? which models does the client itself list?
// Only the clients' own status commands are used. Credential files are never
// opened, copied or parsed by the Setor IA.
import path from "node:path";
import type { ConnectionId, ConnectionStatus, ModelOption } from "@/lib/engine/types";
import { clientEnv, type Runner, type EnvVars } from "./proc";

export type Invocation = { command: string; prefix: string[]; source: string };

export type ClientDeps = {
  runner: Runner;
  env: EnvVars;
  platform: NodeJS.Platform;
  exists: (p: string) => boolean;
  /** Working directory for status commands (an empty folder owned by the executor). */
  cwd: string;
  nodePath: string;
};

const CLIENT = { claude_code: "Claude Code", codex: "Codex CLI" } as const;

export const LOGIN_STEPS: Record<ConnectionId, { install: string[]; login: string[]; expired: string[] }> = {
  claude_code: {
    install: [
      "Instale o Claude Code seguindo a documentação oficial: https://code.claude.com/docs/en/setup",
      "Depois clique em “Verificar conexão”.",
    ],
    login: [
      "Abra um terminal seu (fora do Setor IA) e rode: claude auth login --claudeai",
      "Entre com a conta do Claude que tem a assinatura (Pro, Max, Team ou Enterprise) no navegador que abrir.",
      "Se a variável ANTHROPIC_API_KEY estiver definida no seu sistema, o executor a ignora: ele só usa o login da assinatura.",
      "Volte aqui e clique em “Verificar conexão”.",
    ],
    expired: [
      "A sessão salva pelo Claude Code foi recusada. Em um terminal seu, rode: claude auth login --claudeai",
      "Depois clique em “Verificar conexão” e, se quiser confirmar, em “Testar sessão” (faz uma chamada mínima e usa um pouco da assinatura).",
    ],
  },
  codex: {
    install: [
      "Instale o Codex CLI seguindo a documentação oficial: https://developers.openai.com/codex/cli (por exemplo: npm install -g @openai/codex).",
      "Depois clique em “Verificar conexão”.",
    ],
    login: [
      "Abra um terminal seu (fora do Setor IA) e rode: codex login",
      "Escolha “Sign in with ChatGPT” e entre com a conta do ChatGPT Business (o administrador do workspace precisa ter liberado o Codex).",
      "Sem navegador nesta máquina, use: codex login --device-auth",
      "Volte aqui e clique em “Verificar conexão”.",
    ],
    expired: [
      "A sessão salva pelo Codex foi recusada. Em um terminal seu, rode: codex logout e depois codex login",
      "Depois clique em “Verificar conexão” e, se quiser confirmar, em “Testar sessão” (faz uma chamada mínima e usa um pouco da assinatura).",
    ],
  },
};

/** Finds the client executable without a shell. npm .cmd shims are resolved to node + script. */
export function resolveClient(id: ConnectionId, deps: Pick<ClientDeps, "env" | "platform" | "exists" | "nodePath">): Invocation | null {
  const override = (id === "claude_code" ? deps.env.AYLA_CLAUDE_PATH : deps.env.AYLA_CODEX_PATH)?.trim();
  if (override) {
    if (!path.isAbsolute(override) || !deps.exists(override)) return null;
    if (/\.(js|mjs|cjs)$/i.test(override)) return { command: deps.nodePath, prefix: [override], source: override };
    return /\.(cmd|bat)$/i.test(override) ? null : { command: override, prefix: [], source: override };
  }
  const win = deps.platform === "win32";
  const pathVar = deps.env.PATH ?? deps.env.Path ?? "";
  const dirs = pathVar.split(win ? ";" : ":").map(d => d.trim().replace(/^"|"$/g, "")).filter(Boolean);
  const name = id === "claude_code" ? "claude" : "codex";
  const shimScripts = id === "claude_code"
    ? [path.join("node_modules", "@anthropic-ai", "claude-code", "cli.js")]
    : [path.join("node_modules", "@openai", "codex", "bin", "codex.js")];
  const p = win ? path.win32 : path.posix;
  for (const dir of dirs) {
    if (win) {
      const exe = p.join(dir, `${name}.exe`);
      if (deps.exists(exe)) return { command: exe, prefix: [], source: exe };
      if (deps.exists(p.join(dir, `${name}.cmd`))) {
        for (const rel of shimScripts) {
          const script = p.join(dir, rel);
          if (deps.exists(script)) return { command: deps.nodePath, prefix: [script], source: script };
        }
      }
    } else {
      const bin = p.join(dir, name);
      if (deps.exists(bin)) return { command: bin, prefix: [], source: bin };
    }
  }
  return null;
}

const now = () => new Date().toISOString();

function base(id: ConnectionId): Omit<ConnectionStatus, "state" | "message" | "steps"> {
  return { id, client: CLIENT[id], version: null, account: null, checkedAt: now(), models: [], modelsSource: null, efforts: [] };
}

/** Aliases and effort levels as printed by `claude --help` of the installed version. */
export function parseClaudeHelp(help: string): { models: ModelOption[]; efforts: string[] } {
  const flat = help.replace(/\s+/g, " ");
  const modelPart = flat.match(/--model <model>(.*?)(?= --[a-z])/)?.[1] ?? "";
  const eg = modelPart.match(/\(e\.g\.([^)]*)\)/)?.[1] ?? "";
  const aliases = [...eg.matchAll(/'([A-Za-z0-9._-]+)'/g)].map(m => m[1]);
  const effortPart = flat.match(/--effort <level>(.*?)(?= --[a-z])/)?.[1] ?? "";
  const efforts = (effortPart.match(/\(([a-z, ]+)\)/)?.[1] ?? "").split(",").map(s => s.trim()).filter(Boolean);
  return { models: aliases.map(a => ({ value: a, label: a, efforts: [], defaultEffort: null })), efforts };
}

/** Models with visibility "list" in `codex debug models` (the client's own picker list). */
export function parseCodexModels(raw: string): ModelOption[] {
  try {
    const j = JSON.parse(raw) as { models?: { slug?: string; display_name?: string; visibility?: string; default_reasoning_level?: string; supported_reasoning_levels?: { effort?: string }[] }[] };
    return (j.models ?? [])
      .filter(m => m.visibility === "list" && typeof m.slug === "string" && /^[A-Za-z0-9._-]{1,80}$/.test(m.slug))
      .map(m => ({
        value: m.slug!, label: m.display_name || m.slug!,
        efforts: (m.supported_reasoning_levels ?? []).map(l => l.effort).filter((e): e is string => typeof e === "string" && /^[a-z]{2,12}$/.test(e)),
        defaultEffort: m.default_reasoning_level ?? null,
      }));
  } catch { return []; }
}

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

export async function detectClaude(deps: ClientDeps): Promise<ConnectionStatus> {
  const inv = resolveClient("claude_code", deps);
  const b = base("claude_code");
  if (!inv) return { ...b, state: "not_installed", message: "Claude Code não encontrado neste computador (nem no PATH, nem em AYLA_CLAUDE_PATH).", steps: LOGIN_STEPS.claude_code.install };
  const run = (args: string[], timeoutMs = 20000, maxStdoutBytes = 400_000) => deps.runner({ command: inv.command, args: [...inv.prefix, ...args], cwd: deps.cwd, env: clientEnv(deps.env), timeoutMs, maxStdoutBytes });
  const ver = await run(["--version"]);
  if (ver.spawnError || ver.timedOut || ver.code !== 0) {
    return { ...b, state: "unavailable", message: `O Claude Code foi encontrado, mas não respondeu a “--version” (${ver.spawnError ?? (ver.timedOut ? "tempo esgotado" : `código ${ver.code}`)}).`, steps: ["Rode claude --version em um terminal seu para ver o erro.", "Depois clique em “Verificar conexão”."] };
  }
  b.version = ver.stdout.trim().split(/\r?\n/)[0].slice(0, 80);
  const help = await run(["--help"]);
  if (help.code === 0) { const h = parseClaudeHelp(help.stdout); b.models = h.models; b.efforts = h.efforts; b.modelsSource = h.models.length ? "Aliases citados pela ajuda do próprio Claude Code (claude --help). A disponibilidade depende da sua assinatura." : null; }
  const st = await run(["auth", "status", "--json"]);
  if (st.spawnError || st.timedOut) return { ...b, state: "unavailable", message: "O comando “claude auth status” não respondeu a tempo.", steps: ["Rode claude auth status em um terminal seu.", "Depois clique em “Verificar conexão”."] };
  let info: { loggedIn?: boolean; authMethod?: string; apiProvider?: string; subscriptionType?: string } | null = null;
  try { info = JSON.parse(st.stdout); } catch { info = null; }
  if (!info || typeof info.loggedIn !== "boolean") return { ...b, state: "unavailable", message: "Resposta inesperada de “claude auth status”. Versão do cliente incompatível?", steps: ["Atualize o Claude Code (claude update) e clique em “Verificar conexão”."] };
  if (!info.loggedIn) return { ...b, state: "disconnected", message: "O Claude Code está instalado, mas não há login salvo.", steps: LOGIN_STEPS.claude_code.login };
  if (info.apiProvider && info.apiProvider !== "firstParty") return { ...b, state: "disconnected", message: `O Claude Code está configurado para outro provedor (${info.apiProvider}), não para a assinatura do Claude.`, steps: LOGIN_STEPS.claude_code.login };
  if (info.authMethod !== "claude.ai") return { ...b, state: "disconnected", message: `O Claude Code está autenticado por “${info.authMethod ?? "desconhecido"}”, não pela assinatura do claude.ai. O executor não usa chaves de API.`, steps: LOGIN_STEPS.claude_code.login };
  b.account = info.subscriptionType ? `Claude ${cap(info.subscriptionType)}` : "Assinatura Claude";
  return { ...b, state: "connected", message: `Conectado pela assinatura (${b.account}) através do login salvo pelo próprio Claude Code.`, steps: [] };
}

export async function detectCodex(deps: ClientDeps): Promise<ConnectionStatus> {
  const inv = resolveClient("codex", deps);
  const b = base("codex");
  if (!inv) return { ...b, state: "not_installed", message: "Codex CLI não encontrado neste computador (nem no PATH, nem em AYLA_CODEX_PATH).", steps: LOGIN_STEPS.codex.install };
  const run = (args: string[], timeoutMs = 20000, maxStdoutBytes = 400_000) => deps.runner({ command: inv.command, args: [...inv.prefix, ...args], cwd: deps.cwd, env: clientEnv(deps.env), timeoutMs, maxStdoutBytes });
  const ver = await run(["--version"]);
  if (ver.spawnError || ver.timedOut || ver.code !== 0) {
    return { ...b, state: "unavailable", message: `O Codex CLI foi encontrado, mas não respondeu a “--version” (${ver.spawnError ?? (ver.timedOut ? "tempo esgotado" : `código ${ver.code}`)}).`, steps: ["Rode codex --version em um terminal seu para ver o erro.", "Depois clique em “Verificar conexão”."] };
  }
  b.version = ver.stdout.trim().split(/\r?\n/).pop()!.slice(0, 80);
  const st = await run(["login", "status"]);
  if (st.spawnError || st.timedOut) return { ...b, state: "unavailable", message: "O comando “codex login status” não respondeu a tempo.", steps: ["Rode codex login status em um terminal seu.", "Depois clique em “Verificar conexão”."] };
  const text = `${st.stdout}\n${st.stderr}`;
  if (/not logged in/i.test(text)) return { ...b, state: "disconnected", message: "O Codex CLI está instalado, mas não há login salvo.", steps: LOGIN_STEPS.codex.login };
  if (st.code === 0 && /api key/i.test(text)) return { ...b, state: "disconnected", message: "O Codex CLI está autenticado por chave de API, não pela conta do ChatGPT. O executor não usa chaves de API.", steps: LOGIN_STEPS.codex.login };
  if (st.code !== 0 || !/chatgpt/i.test(text)) return { ...b, state: "unavailable", message: "Resposta inesperada de “codex login status”.", steps: ["Rode codex login status em um terminal seu.", "Depois clique em “Verificar conexão”."] };
  const models = await run(["debug", "models"], 30000, 4_000_000);
  if (models.code === 0) { b.models = parseCodexModels(models.stdout); b.modelsSource = b.models.length ? "Catálogo do próprio Codex CLI (codex debug models), apenas modelos visíveis no seletor do cliente." : null; }
  b.account = "ChatGPT";
  return { ...b, state: "connected", message: "Conectado pela conta do ChatGPT através do login salvo pelo próprio Codex CLI. O plano (Business, Plus…) não é informado pelo cliente.", steps: [] };
}

export const detect: Record<ConnectionId, (deps: ClientDeps) => Promise<ConnectionStatus>> = { claude_code: detectClaude, codex: detectCodex };

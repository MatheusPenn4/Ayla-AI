// Read-only, bounded GitHub reader for planning context.
// Supported in this version: PUBLIC repositories only. A private or missing
// repository is reported as an understandable error; a link grants no access.
// Everything read here is untrusted data (see lib/engine/prompt.ts).
import type { ConsultedFile, SourceContext } from "@/lib/engine/types";

export const GITHUB_LIMITS = { maxFiles: 8, maxFileBytes: 24_000, maxTotalChars: 48_000, timeoutMs: 15_000, perRequestMs: 7_000, maxTreeSample: 160 };
/** Architect: more files, smaller each, fixed commit, selection driven by the task. */
export const ARCHITECT_GITHUB_LIMITS = { maxFiles: 10, maxFileBytes: 16_000, maxTotalChars: 56_000, timeoutMs: 20_000, perRequestMs: 7_000, maxTreeSample: 300 };
export type GithubLimits = typeof GITHUB_LIMITS;

/** Path-like tokens written in a task ("components/office/", "lib/office/types.ts", "README.md"). */
export function extractPathMentions(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?:^|[\s`'"(\[,;])((?:[A-Za-z0-9_.@-]+\/)+[A-Za-z0-9_.@\[\]-]*|[A-Za-z0-9_-]+\.(?:md|json|ts|tsx|js|jsx|mjs|css|toml|ya?ml))(?=$|[\s`'")\],;:.])/g)) {
    const t = m[1].replace(/^\.\//, "").replace(/\.+$/, "");
    if (!t || t.startsWith("http") || t.includes("..") || t.length > 200) continue;
    out.add(t);
  }
  return [...out].slice(0, 20);
}

/**
 * Portuguese task words → the English words code usually uses in file names.
 * Deterministic and small on purpose: it only helps pick files by path; it
 * never reads content to decide.
 */
const PT_EN: Record<string, string[]> = {
  janela: ["dialog", "modal", "window"], dialogo: ["dialog"], tela: ["screen", "page", "view"], pagina: ["page"], painel: ["panel"],
  botao: ["button"], componente: ["component"], componentes: ["components"], ficha: ["sheet", "profile"], fila: ["queue"],
  execucao: ["run", "runs", "executor"], execucoes: ["runs"], executor: ["executor"], motor: ["engine"],
  plano: ["plan", "planner"], planejamento: ["plan", "planner"], tarefa: ["task"], tarefas: ["tasks"], etapa: ["step"], etapas: ["steps"],
  diretor: ["director"], arquiteto: ["architect"], desenvolvedor: ["developer"], revisor: ["reviewer"], equipe: ["team"], colaborador: ["agent"],
  demanda: ["demand"], demandas: ["demands"], contrato: ["contract", "contracts"], contratos: ["contracts"], integracao: ["integration", "integracao"],
  tipo: ["type", "types"], tipos: ["types"], esquema: ["schema"], validacao: ["validation", "schema"], teste: ["test", "tests"], testes: ["test", "tests"],
  armazenamento: ["storage", "store"], persistencia: ["storage", "store"], banco: ["store", "db", "sqlite"], estilo: ["style", "css"], estilos: ["styles", "css"], tema: ["theme"],
  exportar: ["export"], exportacao: ["export"], download: ["download"], baixar: ["download"], markdown: ["markdown", "md"], arquivo: ["file"],
  configuracao: ["config"], rota: ["route"], rotas: ["routes", "api"], servidor: ["server"], navegador: ["client", "browser"], gancho: ["hook"],
  conexao: ["connection", "connections"], cliente: ["client"], adaptador: ["adapter"], adaptadores: ["adapters"], uso: ["usage"], tokens: ["usage", "budget"],
};

const STOP = new Set(["para", "como", "file", "arquivo", "arquivos", "dados", "todos", "cada", "mais", "entre", "sobre", "quando", "deve", "esta", "este", "isso", "pelo", "pela", "com", "sem"]);
/** Terms so common in file names that a match says little (weight 1 instead of 2). */
const WEAK_TERMS = new Set(["components", "component", "test", "tests", "run", "runs", "config", "file", "type", "index", "main", "utils"]);
/** Folder names that say nothing about a task (matching them alone is noise). */
const GENERIC_DIRS = new Set(["components", "component", "lib", "src", "app", "apps", "packages", "scripts", "public", "tests", "test", "docs"]);

/** One group per task word: the word itself (no accents) plus its English equivalents. */
export function termGroups(words: string[]): string[][] {
  const seen = new Set<string>();
  const groups: string[][] = [];
  for (const raw of words) {
    const w = raw.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    if (STOP.has(w) || seen.has(w)) continue;
    seen.add(w);
    const g = [...new Set([...(w.length >= 4 ? [w] : []), ...(PT_EN[w] ?? [])])].filter(t => !STOP.has(t));
    if (!g.length) continue;
    // Same concept written twice (componente/componentes, teste/testes) counts once.
    const same = groups.find(x => x.some(t => g.includes(t) || g.some(n => t.startsWith(n) || n.startsWith(t))));
    if (same) { for (const t of g) if (!same.includes(t)) same.push(t); } else groups.push(g);
  }
  return groups;
}

/** Flat list of the terms (used for display and tests). */
export const expandTerms = (words: string[]) => [...new Set(termGroups(words).flat())];

/**
 * Relevance of a path for the Architect: each task concept counts once;
 * a match in the file name weighs 2, in a specific folder 1, in a generic
 * folder 0; shared UI primitives (components/ui/) are pushed down.
 */
export function scorePath(filePath: string, groups: string[][]) {
  const lower = filePath.toLowerCase();
  const base = lower.split("/").pop()!.replace(/\.[a-z0-9]+$/, "");
  const dirs = lower.split("/").slice(0, -1).filter(d => !GENERIC_DIRS.has(d));
  let score = 0;
  for (const g of groups) {
    let best = 0;
    for (const t of g) {
      if (base.includes(t)) best = Math.max(best, WEAK_TERMS.has(t) ? 1 : 2);
      else if (dirs.some(d => d.includes(t))) best = Math.max(best, 1);
    }
    score += best;
  }
  if (/^components\/ui\//.test(lower)) score -= 2;
  return score;
}

export class GithubError extends Error {
  constructor(public code: "invalid_repo" | "repo_not_found" | "private_repo" | "branch_not_found" | "github_rate_limited" | "github_timeout" | "github_unavailable" | "github_not_permitted", message: string) {
    super(message);
  }
}

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

export function validateRepoRef(owner: string, repo: string, branch: string) {
  if (!OWNER.test(owner)) throw new GithubError("invalid_repo", `Dono do repositório inválido: "${owner}".`);
  if (!REPO.test(repo) || repo === "." || repo === ".." || repo.endsWith(".git")) throw new GithubError("invalid_repo", `Nome de repositório inválido: "${repo}".`);
  if (branch) {
    const bad = branch.length > 200 || !/^[A-Za-z0-9._/-]+$/.test(branch) || branch.includes("..") || branch.includes("//") || branch.startsWith("/") || branch.startsWith("-") || branch.endsWith("/") || branch.endsWith(".lock") || branch.endsWith(".");
    if (bad) throw new GithubError("invalid_repo", `Nome de branch inválido: "${branch}".`);
  }
}

const DOC_PRIORITY: [RegExp, string][] = [
  [/^readme(\.[a-z]+)?$/i, "documentação principal"],
  [/^(package\.json|pyproject\.toml|go\.mod|cargo\.toml|composer\.json|gemfile|pom\.xml|build\.gradle(\.kts)?|requirements\.txt|deno\.json)$/i, "manifesto do projeto"],
  [/^(contributing|architecture|agents|claude)\.md$/i, "guia do projeto"],
  [/^docs\/[^/]+\.md$/i, "documentação"],
  [/^(tsconfig\.json|next\.config\.[a-z]+|vite\.config\.[a-z]+|dockerfile)$/i, "configuração"],
];
const SKIP_DIRS = /(^|\/)(node_modules|dist|build|\.next|vendor|coverage|\.git)(\/|$)/;
const TEXT_EXT = /\.(md|mdx|txt|json|ya?ml|toml|ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|php|java|kt|cs|css|scss|html|sql|sh|env\.example)$/i;

type Fetcher = typeof fetch;

export async function readGithubContext(
  opts: {
    owner: string; repo: string; branch: string; keywords: string[];
    /** Read this exact commit instead of the branch head (the Architect reads what the Director read). */
    commit?: string;
    limits?: GithubLimits;
    /** "director" (default): docs, manifests, then keyword matches. "architect": paths cited in the task, manifests, keyword matches. */
    selection?: "director" | "architect";
    mentions?: string[];
  },
  deps: { fetch?: Fetcher; token?: string; apiBase?: string; rawBase?: string } = {},
): Promise<{ context: Extract<SourceContext, { kind: "github" }>; text: string }> {
  const { owner, repo } = opts;
  const LIM = opts.limits ?? GITHUB_LIMITS;
  validateRepoRef(owner, repo, opts.branch);
  if (opts.commit !== undefined && !/^[0-9a-f]{40}$/.test(opts.commit)) throw new GithubError("invalid_repo", "Commit inválido.");
  const f = deps.fetch ?? fetch;
  const api = deps.apiBase ?? "https://api.github.com", raw = deps.rawBase ?? "https://raw.githubusercontent.com";
  const started = Date.now();
  const deadline = started + LIM.timeoutMs;
  const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "setor-ia-director", "x-github-api-version": "2022-11-28" };
  if (deps.token) headers.authorization = `Bearer ${deps.token}`;

  const get = async (url: string, accept?: string) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new GithubError("github_timeout", "Tempo limite da leitura do GitHub atingido.");
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), Math.min(LIM.perRequestMs, remaining));
    try {
      const res = await f(url, { headers: accept ? { ...headers, accept } : headers, signal: ctl.signal });
      if (res.status === 403 || res.status === 429) {
        if (res.headers.get("x-ratelimit-remaining") === "0" || res.status === 429) throw new GithubError("github_rate_limited", "Limite de requisições do GitHub atingido. Tente mais tarde ou configure GITHUB_TOKEN no servidor.");
      }
      return res;
    } catch (err) {
      if (err instanceof GithubError) throw err;
      if ((err as Error).name === "AbortError") throw new GithubError("github_timeout", "O GitHub demorou demais para responder.");
      throw new GithubError("github_unavailable", "Não foi possível contatar o GitHub.");
    } finally {
      clearTimeout(timer);
    }
  };
  const enc = encodeURIComponent;

  const meta = await get(`${api}/repos/${enc(owner)}/${enc(repo)}`);
  if (meta.status === 404) throw new GithubError("repo_not_found", `Repositório ${owner}/${repo} não encontrado ou privado. Nesta versão apenas repositórios públicos podem ser lidos; o link, por si só, não concede acesso.`);
  if (!meta.ok) throw new GithubError("github_unavailable", `O GitHub respondeu ${meta.status} ao consultar o repositório.`);
  const info = (await meta.json()) as { private?: boolean; default_branch?: string; description?: string | null };
  if (info.private) throw new GithubError("private_repo", `O repositório ${owner}/${repo} é privado. Repositórios privados não são suportados nesta versão.`);
  const branch = opts.branch || info.default_branch || "main";

  let commit = opts.commit ?? "";
  if (!commit) {
    const br = await get(`${api}/repos/${enc(owner)}/${enc(repo)}/branches/${branch.split("/").map(enc).join("/")}`);
    if (br.status === 404) throw new GithubError("branch_not_found", `A branch "${branch}" não existe em ${owner}/${repo}.`);
    if (!br.ok) throw new GithubError("github_unavailable", `O GitHub respondeu ${br.status} ao consultar a branch.`);
    commit = ((await br.json()) as { commit?: { sha?: string } }).commit?.sha ?? "";
    if (!/^[0-9a-f]{40}$/.test(commit)) throw new GithubError("github_unavailable", "O GitHub não informou o commit da branch.");
  }

  const treeRes = await get(`${api}/repos/${enc(owner)}/${enc(repo)}/git/trees/${commit}?recursive=1`);
  if (treeRes.status === 404 || treeRes.status === 422) throw new GithubError("branch_not_found", `O commit ${commit.slice(0, 12)} não está mais disponível em ${owner}/${repo}.`);
  if (!treeRes.ok) throw new GithubError("github_unavailable", `O GitHub respondeu ${treeRes.status} ao listar os arquivos.`);
  const tree = (await treeRes.json()) as { tree?: { path: string; type: string; size?: number }[]; truncated?: boolean };
  const entries = (tree.tree ?? []).filter(e => typeof e.path === "string");
  const blobs = entries.filter(e => e.type === "blob" && !SKIP_DIRS.test(e.path));

  // Structure. Director: top-level entries first, then shallow paths.
  // Architect: names of the text files at any depth (paths only, contents not read), so it can say precisely what it did not see.
  const structureSample = opts.selection === "architect"
    ? blobs.filter(b => TEXT_EXT.test(b.path)).map(b => b.path).sort((a, b) => a.localeCompare(b)).slice(0, LIM.maxTreeSample)
    : entries
      .filter(e => !SKIP_DIRS.test(e.path) && e.path.split("/").length <= 2)
      .map(e => (e.type === "tree" ? `${e.path}/` : e.path))
      .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))
      .slice(0, LIM.maxTreeSample);

  // File selection: documentation and manifests first, then files whose path matches the demand's words.
  const chosen: { path: string; size: number; reason: string }[] = [];
  const skipped: { path: string; reason: string }[] = [];
  const pick = (path: string, size: number, reason: string) => {
    if (chosen.some(c => c.path === path)) return;
    if (chosen.length >= LIM.maxFiles) { skipped.push({ path, reason: "limite de arquivos" }); return; }
    chosen.push({ path, size, reason });
  };
  if (opts.selection === "architect") {
    // 1. Files and folders the Director's task cites explicitly.
    for (const m of opts.mentions ?? []) {
      const exact = blobs.find(b => b.path === m || b.path.endsWith(`/${m}`) && !m.includes("/"));
      if (exact) { pick(exact.path, exact.size ?? 0, "citado na tarefa do Diretor"); continue; }
      const dir = m.replace(/\/$/, "") + "/";
      const inside = blobs.filter(b => b.path.startsWith(dir) && TEXT_EXT.test(b.path)).sort((a, b) => (a.size ?? 0) - (b.size ?? 0)).slice(0, 4);
      for (const b of inside) pick(b.path, b.size ?? 0, `dentro de ${dir}, citado na tarefa do Diretor`);
    }
    // 2. Project manifest (dependencies and scripts).
    for (const b of blobs) if (/^(package\.json|pyproject\.toml|go\.mod|cargo\.toml|composer\.json)$/i.test(b.path)) pick(b.path, b.size ?? 0, "manifesto do projeto");
  } else {
    for (const [re, reason] of DOC_PRIORITY) for (const b of blobs) if (re.test(b.path)) pick(b.path, b.size ?? 0, reason);
  }
  const architect = opts.selection === "architect";
  if (architect) {
    const groups = termGroups(opts.keywords);
    const scored = blobs
      .filter(b => TEXT_EXT.test(b.path) && !/(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$/.test(b.path))
      .map(b => ({ b, score: scorePath(b.path, groups) }))
      .filter(x => x.score >= 2)
      .sort((a, b) => b.score - a.score || (a.b.size ?? 0) - (b.b.size ?? 0));
    for (const { b } of scored.slice(0, 8)) pick(b.path, b.size ?? 0, "relacionado a termos da tarefa");
  } else {
    const words = opts.keywords.map(w => w.toLowerCase()).filter(w => w.length >= 4).slice(0, 12);
    if (words.length) {
      const scored = blobs
        .filter(b => TEXT_EXT.test(b.path))
        .map(b => ({ b, score: words.filter(w => b.path.toLowerCase().includes(w)).length }))
        .filter(x => x.score > 0)
        .sort((a, b) => b.score - a.score || (a.b.size ?? 0) - (b.b.size ?? 0));
      for (const { b } of scored.slice(0, 6)) pick(b.path, b.size ?? 0, "relacionado a termos da demanda");
    }
  }

  const files: ConsultedFile[] = [];
  const parts: string[] = [];
  let total = 0;
  // Downloads run 4 at a time; results are applied in the chosen order, so limits and order stay deterministic.
  const fetchOne = async (c: { path: string; size: number }): Promise<{ body: string } | { skip: string }> => {
    if (c.size > LIM.maxFileBytes * 4) return { skip: `arquivo grande (${c.size} bytes)` };
    try {
      const res = await get(`${raw}/${enc(owner)}/${enc(repo)}/${commit}/${c.path.split("/").map(enc).join("/")}`, "text/plain");
      if (!res.ok) return { skip: `GitHub respondeu ${res.status}` };
      return { body: await res.text() };
    } catch (err) {
      if (err instanceof GithubError && err.code === "github_timeout") return { skip: "tempo limite da leitura" };
      throw err;
    }
  };
  const fetched: ({ body: string } | { skip: string })[] = [];
  for (let i = 0; i < chosen.length; i += 4) fetched.push(...(await Promise.all(chosen.slice(i, i + 4).map(fetchOne))));
  for (const [i, c] of chosen.entries()) {
    const got = fetched[i];
    if ("skip" in got) { skipped.push({ path: c.path, reason: got.skip }); continue; }
    if (total >= LIM.maxTotalChars) { skipped.push({ path: c.path, reason: "limite de texto enviado ao modelo" }); continue; }
    const body = got.body;
    const bytes = new TextEncoder().encode(body).length;
    const room = Math.min(LIM.maxFileBytes, LIM.maxTotalChars - total);
    const sent = body.slice(0, room);
    total += sent.length;
    files.push({ path: c.path, bytes, sentChars: sent.length, truncated: sent.length < body.length, reason: c.reason });
    parts.push(`--- arquivo: ${c.path}${sent.length < body.length ? ` (truncado: ${sent.length} de ${body.length} caracteres)` : ""} ---\n${sent}`);
  }

  const context: Extract<SourceContext, { kind: "github" }> = {
    kind: "github", owner, repo, branch, commit, visibility: "public", description: info.description ?? null, defaultBranch: info.default_branch ?? branch,
    treeEntries: entries.length, treeTruncated: !!tree.truncated, structureSample, files, skipped,
    limits: { maxFiles: LIM.maxFiles, maxFileBytes: LIM.maxFileBytes, maxTotalChars: LIM.maxTotalChars, timeoutMs: LIM.timeoutMs },
    elapsedMs: Date.now() - started,
  };
  const text = [
    `Descrição do repositório: ${info.description ?? "(sem descrição)"}`,
    opts.selection === "architect"
      ? `Lista de arquivos de texto do repositório (${structureSample.length} de ${blobs.filter(b => TEXT_EXT.test(b.path)).length}; apenas os caminhos — o conteúdo só foi lido nos arquivos abaixo):\n${structureSample.join("\n")}`
      : `Estrutura (amostra de até ${LIM.maxTreeSample} caminhos rasos):\n${structureSample.join("\n")}`,
    ...parts,
  ].join("\n\n");
  return { context, text };
}

/**
 * Drops consulted files until the text fits (used when the token budget is tight).
 * "size" (Director): largest first. "priority" (Architect): least relevant first,
 * i.e. from the end of the selection order, so files cited by the task stay.
 */
export function shrinkGithubText(ctx: Extract<SourceContext, { kind: "github" }>, text: string, targetChars: number, order: "size" | "priority" = "size") {
  if (text.length <= targetChars) return { ctx, text };
  const sections = text.split(/\n\n(?=--- arquivo: )/);
  const head = sections.shift() ?? "";
  const items = sections.map(s => ({ s, path: /^--- arquivo: (.+?)( \(truncado|\s---)/.exec(s)?.[1] ?? "" }));
  const bySize = order === "priority" ? [...items].reverse() : items.sort((a, b) => b.s.length - a.s.length);
  const dropped = new Set<string>();
  let cur = text.length;
  for (const item of bySize) {
    if (cur <= targetChars) break;
    dropped.add(item.path);
    cur -= item.s.length;
  }
  const keep = sections.filter(s => !dropped.has(/^--- arquivo: (.+?)( \(truncado|\s---)/.exec(s)?.[1] ?? ""));
  const nextCtx = { ...ctx, files: ctx.files.filter(f => !dropped.has(f.path)), skipped: [...ctx.skipped, ...[...dropped].map(path => ({ path, reason: order === "priority" ? "removido (menos relevante) para caber no orçamento de referência da ficha" : "removido para caber no orçamento de tokens" }))] };
  return { ctx: nextCtx, text: [head.slice(0, targetChars), ...keep].join("\n\n") };
}

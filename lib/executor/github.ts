// Read-only, bounded GitHub reader for planning context.
// Supported in this version: PUBLIC repositories only. A private or missing
// repository is reported as an understandable error; a link grants no access.
// Everything read here is untrusted data (see lib/engine/prompt.ts).
import { createHash } from "node:crypto";
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
    requested?: RequestedFile[];
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
  const tree = (await treeRes.json()) as { tree?: { path: string; type: string; size?: number; sha?: string }[]; truncated?: boolean };
  const entries = (tree.tree ?? []).filter(e => typeof e.path === "string").map(e => ({ path: e.path, type: e.type, size: e.size ?? 0, blob: e.sha ?? null }));

  const readFile = async (path: string): Promise<{ body: string } | { skip: string }> => {
    try {
      const res = await get(`${raw}/${enc(owner)}/${enc(repo)}/${commit}/${path.split("/").map(enc).join("/")}`, "text/plain");
      if (!res.ok) return { skip: `GitHub respondeu ${res.status}` };
      return { body: await res.text() };
    } catch (err) {
      if (err instanceof GithubError && err.code === "github_timeout") return { skip: "tempo limite da leitura" };
      throw err;
    }
  };
  return assembleContext({
    owner, repo, branch, commit, description: info.description ?? null, defaultBranch: info.default_branch ?? branch,
    entries, treeTruncated: !!tree.truncated, readFile, limits: LIM, selection: opts.selection ?? "director",
    keywords: opts.keywords, mentions: opts.mentions ?? [], requested: opts.requested ?? [], started, via: "github",
  });
}

export type TreeEntry = { path: string; type: string; size: number; blob: string | null };
/** A file the user (or a resolution by reading) asked for: "path" or "path#Symbol". */
export type RequestedFile = { ref: string; reason: string };

/** Large files are sent as an outline of declarations + the relevant blocks, above this size. */
export const EXCERPT_THRESHOLD = 7_000;

/**
 * Outline of top-level declarations with line numbers and the blocks whose
 * names (or bodies) match the wanted terms. A verifiable excerpt: every block
 * says which lines of the committed file it contains.
 */
export function excerptFile(body: string, symbols: string[], terms: string[], maxChars: number) {
  const lines = body.split(/\r?\n/);
  const decl = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|const|let|class|interface|type|enum)\s+([A-Za-z0-9_$]+)/;
  const marks: { name: string; line: number }[] = [];
  lines.forEach((l, i) => { const m = decl.exec(l); if (m) marks.push({ name: m[1], line: i }); });
  const importsEnd = lines.findIndex(l => l.trim() && !/^(import|export \* from|export \{[^}]*\} from|"use |'use |\/\/)/.test(l.trim()));
  const blocks = marks.map((m, k) => ({ name: m.name, from: m.line, to: (marks[k + 1]?.line ?? lines.length) - 1 }));
  const syms = symbols.filter(x => /^[A-Za-z_$][\w$]*$/.test(x));
  const t = terms.map(x => x.toLowerCase()).filter(x => x.length >= 4);
  // Requested symbols: exact declaration name, plus the top-level declarations they reference (one level).
  // Task terms: only the declaration name, never the body, and only when no symbol was requested.
  const byName = blocks.filter(b => syms.includes(b.name));
  const refText = byName.map(b => lines.slice(b.from, b.to + 1).join("\n")).join("\n");
  // Only type-like declarations or small helpers: a large referenced component would just repeat the file.
  const isTypeLike = (b: { from: number }) => /^(?:export\s+)?(?:type|interface|enum)\s/.test(lines[b.from]);
  const blockChars = (b: { from: number; to: number }) => lines.slice(b.from, b.to + 1).join("\n").length;
  const referenced = blocks.filter(b => !syms.includes(b.name) && byName.length > 0 && isTypeLike(b) && blockChars(b) <= 2500 && new RegExp(`\\b${b.name.replace(/\$/g, "\\$")}\\b`).test(refText));
  const byTerm = syms.length ? [] : blocks.filter(b => t.some(x => b.name.toLowerCase().includes(x)));
  // A requested symbol that is not a top-level declaration (e.g. a function inside a component):
  // a window of lines around where it appears, instead of the whole enclosing block.
  const rawWindows = syms.filter(x => !marks.some(m => m.name === x)).flatMap(x => {
    const at = lines.findIndex(l => new RegExp(`\\b${x.replace(/\$/g, "\\$")}\\b`).test(l));
    return at >= 0 ? [{ name: x, from: Math.max(0, at - 3), to: Math.min(lines.length - 1, at + 25) }] : [];
  }).sort((a, b) => a.from - b.from);
  // Overlapping windows are merged, so no line is sent twice.
  const windows: { name: string; from: number; to: number }[] = [];
  for (const w of rawWindows) {
    if (byName.some(b => w.from >= b.from && w.to <= b.to)) continue; // already inside a requested block
    const last = windows[windows.length - 1];
    if (last && w.from <= last.to + 1) { last.to = Math.max(last.to, w.to); last.name = `${last.name}, ${w.name}`; } else windows.push({ ...w });
  }
  // Test files: the titles of describe/it/test blocks say what is covered.
  const tests = lines.flatMap((l, i) => { const m = /^\s*(describe|it|test)(?:\.each\([^)]*\))?\(\s*(["'`])(.+?)\2/.exec(l); return m ? [`${m[1] === "describe" ? "▸" : "  ·"} ${m[3]} (l.${i + 1})`] : []; });
  const outline = `Declarações de nível superior (${marks.length}): ${marks.map(m => `${m.name} (l.${m.line + 1})`).join(", ") || "nenhuma"}${tests.length ? `\nCasos de teste (${tests.filter(x => !x.startsWith("▸")).length}):\n${tests.join("\n")}` : ""}`;
  const out: string[] = [outline];
  const ranges: [number, number][] = [];
  const sent: string[] = [];
  let used = outline.length;
  // Imports show dependencies; capped so a long import list does not crowd out the requested blocks.
  const head: string[] = [];
  for (const l of importsEnd > 0 ? lines.slice(0, importsEnd) : []) { if (head.join("\n").length + l.length > 1200) break; head.push(l); }
  if (head.length) { const h = `[linhas 1-${head.length}]\n${head.join("\n")}`; if (used + h.length <= maxChars) { out.push(h); ranges.push([1, head.length]); used += h.length; } }
  for (const b of [...byName, ...windows, ...referenced, ...byTerm]) {
    const text = `[linhas ${b.from + 1}-${b.to + 1} · ${b.name}]\n${lines.slice(b.from, b.to + 1).join("\n")}`;
    if (used + text.length > maxChars) {
      const room = maxChars - used - 60;
      if (room > 400) { out.push(`${text.slice(0, room)}\n[… bloco ${b.name} cortado]`); ranges.push([b.from + 1, b.to + 1]); sent.push(b.name); }
      break;
    }
    out.push(text); ranges.push([b.from + 1, b.to + 1]); sent.push(b.name); used += text.length;
  }
  return { text: out.join("\n\n"), ranges, totalLines: lines.length, symbols: sent };
}

/** Compact list of paths grouped by folder (names only; contents not read). */
function groupPaths(paths: string[]) {
  const byDir = new Map<string, string[]>();
  for (const p of paths) { const i = p.lastIndexOf("/"); const d = i < 0 ? "." : p.slice(0, i); byDir.set(d, [...(byDir.get(d) ?? []), p.slice(i + 1)]); }
  return [...byDir.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([d, f]) => `${d}/: ${f.join(", ")}`).join("\n");
}

const sha256hex = async (text: string) => createHash("sha256").update(text).digest("hex");

/** Shared selection, limits and text assembly for every repository source (GitHub or local Git). */
export async function assembleContext(a: {
  owner: string; repo: string; branch: string; commit: string; description: string | null; defaultBranch: string;
  entries: TreeEntry[]; treeTruncated: boolean;
  readFile: (path: string) => Promise<{ body: string } | { skip: string }>;
  limits: GithubLimits; selection: "director" | "architect"; keywords: string[]; mentions: string[]; requested: RequestedFile[];
  started: number; via: "github" | "local_git";
  local?: Extract<SourceContext, { kind: "github" }>["local"];
}): Promise<{ context: Extract<SourceContext, { kind: "github" }>; text: string }> {
  const LIM = a.limits;
  const architect = a.selection === "architect";
  const entries = a.entries;
  const blobs = entries.filter(e => e.type === "blob" && !SKIP_DIRS.test(e.path));
  const textBlobs = blobs.filter(b => TEXT_EXT.test(b.path));

  // Structure. Director: top-level entries first, then shallow paths.
  // Architect: names of the text files at any depth, grouped by folder (paths only, contents not read).
  const structureSample = architect
    ? textBlobs.map(b => b.path).sort((x, y) => x.localeCompare(y)).slice(0, LIM.maxTreeSample)
    : entries
      .filter(e => !SKIP_DIRS.test(e.path) && e.path.split("/").length <= 2)
      .map(e => (e.type === "tree" ? `${e.path}/` : e.path))
      .sort((x, y) => x.split("/").length - y.split("/").length || x.localeCompare(y))
      .slice(0, LIM.maxTreeSample);

  const chosen: { path: string; size: number; reason: string; blob: string | null; symbols: string[] }[] = [];
  const skipped: { path: string; reason: string }[] = [];
  const pick = (b: TreeEntry, reason: string, symbols: string[] = []) => {
    const have = chosen.find(c => c.path === b.path);
    if (have) { for (const x of symbols) if (!have.symbols.includes(x)) have.symbols.push(x); return; }
    if (chosen.length >= LIM.maxFiles) { skipped.push({ path: b.path, reason: "limite de arquivos" }); return; }
    chosen.push({ path: b.path, size: b.size, reason, blob: b.blob, symbols: [...symbols] });
  };
  if (architect) {
    // 0. Files requested to resolve a question by reading (exact paths only, optionally #Symbol).
    for (const r of a.requested) {
      const [path, symbol] = r.ref.split("#");
      const b = blobs.find(x => x.path === path);
      if (!b) { skipped.push({ path, reason: `pedido (${r.reason}), mas não existe neste commit` }); continue; }
      pick(b, r.reason, symbol ? [symbol] : []);
    }
    // 1. Files and folders the Director's task cites explicitly.
    for (const m of a.mentions) {
      const exact = blobs.find(b => b.path === m || (b.path.endsWith(`/${m}`) && !m.includes("/")));
      if (exact) { pick(exact, "citado na tarefa do Diretor"); continue; }
      const dir = m.replace(/\/$/, "") + "/";
      for (const b of textBlobs.filter(x => x.path.startsWith(dir)).sort((x, y) => x.size - y.size).slice(0, 4)) pick(b, `dentro de ${dir}, citado na tarefa do Diretor`);
    }
    // When files were requested explicitly (a follow-up), only those and the task's citations are read:
    // the path heuristic below would only add noise and duplicate what the user already chose.
    const explicit = a.requested.length > 0;
    // 2. Project manifest (dependencies and scripts).
    if (!explicit) for (const b of blobs) if (/^(package\.json|pyproject\.toml|go\.mod|cargo\.toml|composer\.json)$/i.test(b.path)) pick(b, "manifesto do projeto");
    // 3. File names related to the task's terms.
    const groups = explicit ? [] : termGroups(a.keywords);
    const scored = textBlobs
      .filter(b => !/(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$/.test(b.path))
      .map(b => ({ b, score: scorePath(b.path, groups) }))
      .filter(x => x.score >= 2)
      .sort((x, y) => y.score - x.score || x.b.size - y.b.size);
    for (const { b } of scored.slice(0, 8)) pick(b, "relacionado a termos da tarefa");
  } else {
    for (const [re, reason] of DOC_PRIORITY) for (const b of blobs) if (re.test(b.path)) pick(b, reason);
    const words = a.keywords.map(w => w.toLowerCase()).filter(w => w.length >= 4).slice(0, 12);
    if (words.length) {
      const scored = textBlobs
        .map(b => ({ b, score: words.filter(w => b.path.toLowerCase().includes(w)).length }))
        .filter(x => x.score > 0)
        .sort((x, y) => y.score - x.score || x.b.size - y.b.size);
      for (const { b } of scored.slice(0, 6)) pick(b, "relacionado a termos da demanda");
    }
  }

  // Reading runs 4 at a time; results are applied in the chosen order, so limits and order stay deterministic.
  const readOne = async (c: { path: string; size: number }) => (c.size > LIM.maxFileBytes * (architect ? 8 : 4) ? { skip: `arquivo grande (${c.size} bytes)` } : a.readFile(c.path));
  const got: ({ body: string } | { skip: string })[] = [];
  for (let i = 0; i < chosen.length; i += 4) got.push(...(await Promise.all(chosen.slice(i, i + 4).map(readOne))));
  const wantedBase = [...termGroups(a.keywords).flat()];
  const files: ConsultedFile[] = [];
  const parts: string[] = [];
  let total = 0;
  for (const [i, c] of chosen.entries()) {
    const g = got[i];
    if ("skip" in g) { skipped.push({ path: c.path, reason: g.skip }); continue; }
    if (total >= LIM.maxTotalChars) { skipped.push({ path: c.path, reason: "limite de texto enviado ao modelo" }); continue; }
    const body = g.body;
    const bytes = new TextEncoder().encode(body).length;
    const room = Math.min(LIM.maxFileBytes, LIM.maxTotalChars - total);
    let sent: string, header: string, excerpt: ConsultedFile["excerpt"];
    if (architect && body.length > EXCERPT_THRESHOLD) {
      const ex = excerptFile(body, c.symbols, wantedBase, room);
      sent = ex.text;
      excerpt = { ranges: ex.ranges, totalLines: ex.totalLines, symbols: ex.symbols };
      header = `--- arquivo: ${c.path} (trecho verificável: ${ex.ranges.map(([x, y]) => `l.${x}-${y}`).join(", ") || "só a lista de declarações"} de ${ex.totalLines} linhas; commit ${a.commit.slice(0, 12)}) ---`;
    } else {
      sent = body.slice(0, room);
      header = `--- arquivo: ${c.path}${sent.length < body.length ? ` (truncado: ${sent.length} de ${body.length} caracteres)` : ""} ---`;
    }
    total += sent.length;
    files.push({ path: c.path, bytes, sentChars: sent.length, truncated: !!excerpt || sent.length < body.length, reason: c.reason, blob: c.blob, sha256: await sha256hex(body), ...(excerpt ? { excerpt } : {}) });
    parts.push(`${header}\n${sent}`);
  }

  const context: Extract<SourceContext, { kind: "github" }> = {
    kind: "github", owner: a.owner, repo: a.repo, branch: a.branch, commit: a.commit, visibility: "public", description: a.description, defaultBranch: a.defaultBranch,
    treeEntries: entries.length, treeTruncated: a.treeTruncated, structureSample, files, skipped,
    limits: { maxFiles: LIM.maxFiles, maxFileBytes: LIM.maxFileBytes, maxTotalChars: LIM.maxTotalChars, timeoutMs: LIM.timeoutMs },
    elapsedMs: Date.now() - a.started, via: a.via, ...(a.local ? { local: a.local } : {}),
  };
  const text = [
    `Descrição do repositório: ${a.description ?? "(sem descrição)"}`,
    architect
      ? `Arquivos de texto do repositório no commit ${a.commit.slice(0, 12)} (${structureSample.length} de ${textBlobs.length}; apenas os nomes — o conteúdo só foi lido nos arquivos abaixo):\n${groupPaths(structureSample)}`
      : `Estrutura (amostra de até ${LIM.maxTreeSample} caminhos rasos):\n${structureSample.join("\n")}`,
    ...parts,
  ].join("\n\n");
  return { context, text };
}

/**
 * Drops consulted files until the text fits (used when the token budget is tight).
 * "size" (Director): largest first. "priority" (Architect): least relevant first,
 * i.e. from the end of the selection order. Files in `protect` (requested to
 * resolve a question) are never dropped. The text and ctx.files always change
 * together, so a file is listed as read only if its content is in the text.
 */
export function shrinkGithubText(ctx: Extract<SourceContext, { kind: "github" }>, text: string, targetChars: number, order: "size" | "priority" = "size", protect: Set<string> = new Set()) {
  if (text.length <= targetChars) return { ctx, text };
  const sections = text.split(/\n\n(?=--- arquivo: )/);
  const head = sections.shift() ?? "";
  const known = [...ctx.files.map(f => f.path)].sort((a, b) => b.length - a.length);
  const pathOf = (sec: string) => known.find(p => sec.startsWith(`--- arquivo: ${p} `)) ?? "";
  const items = sections.map(sec => ({ sec, path: pathOf(sec) }));
  const candidates = (order === "priority" ? [...items].reverse() : [...items].sort((a, b) => b.sec.length - a.sec.length)).filter(i => i.path && !protect.has(i.path));
  const dropped = new Set<string>();
  let cur = text.length;
  for (const item of candidates) {
    if (cur <= targetChars) break;
    dropped.add(item.path);
    cur -= item.sec.length + 2;
  }
  const keep = items.filter(i => !dropped.has(i.path)).map(i => i.sec);
  const nextCtx = { ...ctx, files: ctx.files.filter(f => !dropped.has(f.path)), skipped: [...ctx.skipped, ...[...dropped].map(path => ({ path, reason: order === "priority" ? "removido (menos relevante) para caber no orçamento de referência da ficha" : "removido para caber no orçamento de tokens" }))] };
  return { ctx: nextCtx, text: [head, ...keep].join("\n\n") };
}

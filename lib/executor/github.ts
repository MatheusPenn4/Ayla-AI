// Read-only, bounded GitHub reader for planning context.
// Supported in this version: PUBLIC repositories only. A private or missing
// repository is reported as an understandable error; a link grants no access.
// Everything read here is untrusted data (see lib/engine/prompt.ts).
import type { ConsultedFile, SourceContext } from "@/lib/engine/types";

export const GITHUB_LIMITS = { maxFiles: 8, maxFileBytes: 24_000, maxTotalChars: 48_000, timeoutMs: 15_000, perRequestMs: 7_000, maxTreeSample: 160 };

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
  opts: { owner: string; repo: string; branch: string; keywords: string[] },
  deps: { fetch?: Fetcher; token?: string; apiBase?: string; rawBase?: string } = {},
): Promise<{ context: Extract<SourceContext, { kind: "github" }>; text: string }> {
  const { owner, repo } = opts;
  validateRepoRef(owner, repo, opts.branch);
  const f = deps.fetch ?? fetch;
  const api = deps.apiBase ?? "https://api.github.com", raw = deps.rawBase ?? "https://raw.githubusercontent.com";
  const started = Date.now();
  const deadline = started + GITHUB_LIMITS.timeoutMs;
  const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "setor-ia-director", "x-github-api-version": "2022-11-28" };
  if (deps.token) headers.authorization = `Bearer ${deps.token}`;

  const get = async (url: string, accept?: string) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new GithubError("github_timeout", "Tempo limite da leitura do GitHub atingido.");
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), Math.min(GITHUB_LIMITS.perRequestMs, remaining));
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

  const br = await get(`${api}/repos/${enc(owner)}/${enc(repo)}/branches/${branch.split("/").map(enc).join("/")}`);
  if (br.status === 404) throw new GithubError("branch_not_found", `A branch "${branch}" não existe em ${owner}/${repo}.`);
  if (!br.ok) throw new GithubError("github_unavailable", `O GitHub respondeu ${br.status} ao consultar a branch.`);
  const commit = ((await br.json()) as { commit?: { sha?: string } }).commit?.sha ?? "";
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new GithubError("github_unavailable", "O GitHub não informou o commit da branch.");

  const treeRes = await get(`${api}/repos/${enc(owner)}/${enc(repo)}/git/trees/${commit}?recursive=1`);
  if (!treeRes.ok) throw new GithubError("github_unavailable", `O GitHub respondeu ${treeRes.status} ao listar os arquivos.`);
  const tree = (await treeRes.json()) as { tree?: { path: string; type: string; size?: number }[]; truncated?: boolean };
  const entries = (tree.tree ?? []).filter(e => typeof e.path === "string");
  const blobs = entries.filter(e => e.type === "blob" && !SKIP_DIRS.test(e.path));

  // Structure: top-level entries first, then shallow paths.
  const structureSample = entries
    .filter(e => !SKIP_DIRS.test(e.path) && e.path.split("/").length <= 2)
    .map(e => (e.type === "tree" ? `${e.path}/` : e.path))
    .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))
    .slice(0, GITHUB_LIMITS.maxTreeSample);

  // File selection: documentation and manifests first, then files whose path matches the demand's words.
  const chosen: { path: string; size: number; reason: string }[] = [];
  const skipped: { path: string; reason: string }[] = [];
  const pick = (path: string, size: number, reason: string) => {
    if (chosen.some(c => c.path === path)) return;
    if (chosen.length >= GITHUB_LIMITS.maxFiles) { skipped.push({ path, reason: "limite de arquivos" }); return; }
    chosen.push({ path, size, reason });
  };
  for (const [re, reason] of DOC_PRIORITY) for (const b of blobs) if (re.test(b.path)) pick(b.path, b.size ?? 0, reason);
  const words = opts.keywords.map(w => w.toLowerCase()).filter(w => w.length >= 4).slice(0, 12);
  if (words.length) {
    const scored = blobs
      .filter(b => TEXT_EXT.test(b.path))
      .map(b => ({ b, score: words.filter(w => b.path.toLowerCase().includes(w)).length }))
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score || (a.b.size ?? 0) - (b.b.size ?? 0));
    for (const { b } of scored.slice(0, 6)) pick(b.path, b.size ?? 0, "relacionado a termos da demanda");
  }

  const files: ConsultedFile[] = [];
  const parts: string[] = [];
  let total = 0;
  for (const c of chosen) {
    if (total >= GITHUB_LIMITS.maxTotalChars) { skipped.push({ path: c.path, reason: "limite de texto enviado ao modelo" }); continue; }
    if (c.size > GITHUB_LIMITS.maxFileBytes * 4) { skipped.push({ path: c.path, reason: `arquivo grande (${c.size} bytes)` }); continue; }
    let res: Response;
    try {
      res = await get(`${raw}/${enc(owner)}/${enc(repo)}/${commit}/${c.path.split("/").map(enc).join("/")}`, "text/plain");
    } catch (err) {
      if (err instanceof GithubError && err.code === "github_timeout") { skipped.push({ path: c.path, reason: "tempo limite" }); break; }
      throw err;
    }
    if (!res.ok) { skipped.push({ path: c.path, reason: `GitHub respondeu ${res.status}` }); continue; }
    const body = await res.text();
    const bytes = new TextEncoder().encode(body).length;
    const room = Math.min(GITHUB_LIMITS.maxFileBytes, GITHUB_LIMITS.maxTotalChars - total);
    const sent = body.slice(0, room);
    total += sent.length;
    files.push({ path: c.path, bytes, sentChars: sent.length, truncated: sent.length < body.length, reason: c.reason });
    parts.push(`--- arquivo: ${c.path}${sent.length < body.length ? ` (truncado: ${sent.length} de ${body.length} caracteres)` : ""} ---\n${sent}`);
  }

  const context: Extract<SourceContext, { kind: "github" }> = {
    kind: "github", owner, repo, branch, commit, visibility: "public", description: info.description ?? null, defaultBranch: info.default_branch ?? branch,
    treeEntries: entries.length, treeTruncated: !!tree.truncated, structureSample, files, skipped,
    limits: { maxFiles: GITHUB_LIMITS.maxFiles, maxFileBytes: GITHUB_LIMITS.maxFileBytes, maxTotalChars: GITHUB_LIMITS.maxTotalChars, timeoutMs: GITHUB_LIMITS.timeoutMs },
    elapsedMs: Date.now() - started,
  };
  const text = [
    `Descrição do repositório: ${info.description ?? "(sem descrição)"}`,
    `Estrutura (amostra de até ${GITHUB_LIMITS.maxTreeSample} caminhos rasos):\n${structureSample.join("\n")}`,
    ...parts,
  ].join("\n\n");
  return { context, text };
}

/** Drops the largest consulted files until the text fits (used when the token budget is tight). */
export function shrinkGithubText(ctx: Extract<SourceContext, { kind: "github" }>, text: string, targetChars: number) {
  if (text.length <= targetChars) return { ctx, text };
  const sections = text.split(/\n\n(?=--- arquivo: )/);
  const head = sections.shift() ?? "";
  const bySize = sections.map(s => ({ s, path: /^--- arquivo: (.+?)( \(truncado|\s---)/.exec(s)?.[1] ?? "" })).sort((a, b) => b.s.length - a.s.length);
  const dropped = new Set<string>();
  let cur = text.length;
  for (const item of bySize) {
    if (cur <= targetChars) break;
    dropped.add(item.path);
    cur -= item.s.length;
  }
  const keep = sections.filter(s => !dropped.has(/^--- arquivo: (.+?)( \(truncado|\s---)/.exec(s)?.[1] ?? ""));
  const nextCtx = { ...ctx, files: ctx.files.filter(f => !dropped.has(f.path)), skipped: [...ctx.skipped, ...[...dropped].map(path => ({ path, reason: "removido para caber no orçamento de tokens" }))] };
  return { ctx: nextCtx, text: [head.slice(0, targetChars), ...keep].join("\n\n") };
}

// Read-only reader of an AUTHORIZED local Git clone, at an exact commit.
// Used when the code a task talks about exists in local commits that were not
// published on GitHub (the public reader cannot see them).
// - only folders listed in AYLA_LOCAL_REPOS (absolute paths) are read;
// - the clone's "origin" must point to the demand's GitHub repository;
// - only committed objects are read (git ls-tree / git show / merge-base / diff-tree /
//   branch --contains): no checkout, no status, no fetch, no writes, and
//   uncommitted changes are never included;
// - structured arguments, no shell, time limit, output cap.
import { existsSync } from "node:fs";
import path from "node:path";
import type { DeveloperDiffFile, SourceComparison, SourceContext } from "@/lib/engine/types";
import { ARCHITECT_GITHUB_LIMITS, GithubError, assembleContext, type RequestedFile, type TreeEntry } from "./github";
import { clientEnv, type EnvVars, type Runner } from "./proc";
import { redactSecrets } from "./redact";

const MAX_COMMIT_DIFF_CHARS = 40_000;
const COMMIT_STATUS: Record<string, DeveloperDiffFile["status"]> = { A: "added", M: "modified", D: "deleted" };

export type LocalRepoInfo = { dir: string; dirName: string; owner: string; repo: string; head: string; headSubject: string };

export type GitDeps = { runner: Runner; env: EnvVars; platform?: NodeJS.Platform; exists?: (p: string) => boolean };

/** Finds git in PATH without a shell. */
export function resolveGit(deps: GitDeps): string | null {
  const win = (deps.platform ?? process.platform) === "win32";
  const exists = deps.exists ?? existsSync;
  const dirs = (deps.env.PATH ?? deps.env.Path ?? "").split(win ? ";" : ":").map(d => d.trim().replace(/^"|"$/g, "")).filter(Boolean);
  for (const d of dirs) {
    const p = (win ? path.win32 : path.posix).join(d, win ? "git.exe" : "git");
    if (exists(p)) return p;
  }
  return null;
}

async function git(deps: GitDeps, gitPath: string, dir: string, args: string[], maxStdoutBytes = 2_000_000) {
  const env = { ...clientEnv(deps.env), GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", LC_ALL: "C" };
  return deps.runner({ command: gitPath, args: ["-C", dir, "--no-pager", "-c", "core.fsmonitor=false", "-c", "core.quotepath=off", ...args], cwd: dir, env, timeoutMs: 15_000, maxStdoutBytes });
}

/**
 * One git command on an authorized project (structured arguments, no shell, no pager, no prompts), for the
 * application flow (lib/executor/apply.ts). Unlike the read-only helpers above it may be given stdin (a patch).
 */
export async function runGit(deps: GitDeps, dir: string, args: string[], opts: { stdin?: string; maxStdoutBytes?: number; timeoutMs?: number } = {}) {
  const g = resolveGit(deps);
  if (!g) return { code: null, stdout: "", stderr: "Git não encontrado neste computador.", timedOut: false, aborted: false, truncated: false, spawnError: "git ausente" };
  const env = { ...clientEnv(deps.env), GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", LC_ALL: "C" };
  return deps.runner({ command: g, args: ["-C", dir, "--no-pager", "-c", "core.fsmonitor=false", "-c", "core.quotepath=off", ...args], cwd: dir, env, timeoutMs: opts.timeoutMs ?? 20_000, stdin: opts.stdin, maxStdoutBytes: opts.maxStdoutBytes ?? 4_000_000 });
}

/** "https://github.com/o/r(.git)" or "git@github.com:o/r(.git)" → { owner, repo }. */
export function parseOrigin(url: string) {
  const m = /github\.com[/:]([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? { owner: m[1], repo: m[2] } : null;
}

/** Authorized local clones and what their HEAD is (for the review screen). */
export async function listLocalRepos(dirs: string[], deps: GitDeps): Promise<LocalRepoInfo[]> {
  const g = resolveGit(deps);
  if (!g) return [];
  const out: LocalRepoInfo[] = [];
  for (const dir of dirs) {
    if (!path.isAbsolute(dir) || !(deps.exists ?? existsSync)(path.join(dir, ".git"))) continue;
    const origin = await git(deps, g, dir, ["remote", "get-url", "origin"]);
    const o = origin.code === 0 ? parseOrigin(origin.stdout) : null;
    const head = await git(deps, g, dir, ["log", "-1", "--format=%H%n%s"]);
    if (!o || head.code !== 0) continue;
    const [sha, subject] = head.stdout.trim().split(/\r?\n/);
    if (!/^[0-9a-f]{40}$/.test(sha)) continue;
    out.push({ dir, dirName: path.basename(dir), owner: o.owner, repo: o.repo, head: sha, headSubject: (subject ?? "").slice(0, 120) });
  }
  return out;
}

/**
 * Compares two commits of an authorized clone for a list of files: does each file exist in each commit,
 * did it change between them, and does `to` descend from `from`. Plumbing commands only (no checkout).
 */
export async function compareLocalCommits(
  opts: { dir: string; from: { commit: string; label: string }; to: { commit: string; label: string }; paths: string[] },
  deps: GitDeps,
): Promise<SourceComparison> {
  const base: SourceComparison = { from: opts.from, to: opts.to, relation: "unknown", changedTotal: null, files: opts.paths.map(p => ({ path: p, atFrom: false, atTo: false, changed: null })), note: "" };
  const hex = /^[0-9a-f]{40}$/;
  if (!hex.test(opts.from.commit) || !hex.test(opts.to.commit)) return { ...base, note: "Commit inválido para comparação." };
  if (opts.from.commit === opts.to.commit) {
    const g0 = resolveGit(deps);
    const t = g0 ? await git(deps, g0, opts.dir, ["ls-tree", "-r", "--name-only", "--full-tree", opts.to.commit], 8_000_000) : null;
    const known = new Set((t?.code === 0 ? t.stdout : "").split(/\r?\n/));
    return { ...base, relation: "same", changedTotal: 0, files: opts.paths.map(p => ({ path: p, atFrom: known.has(p), atTo: known.has(p), changed: false })), note: "Mesmo commit." };
  }
  const g = resolveGit(deps);
  if (!g) return { ...base, note: "Git não encontrado neste computador: comparação indisponível." };
  const names = async (c: string) => {
    const r = await git(deps, g, opts.dir, ["ls-tree", "-r", "--name-only", "--full-tree", c], 8_000_000);
    return r.code === 0 ? new Set(r.stdout.split(/\r?\n/).filter(Boolean)) : null;
  };
  const [a, b] = [await names(opts.from.commit), await names(opts.to.commit)];
  if (!a || !b) return { ...base, note: "Um dos commits não existe na cópia local autorizada." };
  const mb = await git(deps, g, opts.dir, ["merge-base", "--is-ancestor", opts.from.commit, opts.to.commit]);
  const relation: SourceComparison["relation"] = mb.code === 0 ? "descendant" : mb.code === 1 ? "not_descendant" : "unknown";
  const diff = await git(deps, g, opts.dir, ["diff-tree", "-r", "--no-commit-id", "--name-only", opts.from.commit, opts.to.commit], 8_000_000);
  const changed = diff.code === 0 ? new Set(diff.stdout.split(/\r?\n/).filter(Boolean)) : null;
  return {
    ...base, relation, changedTotal: changed ? changed.size : null,
    files: opts.paths.map(p => ({ path: p, atFrom: a.has(p), atTo: b.has(p), changed: changed ? changed.has(p) : null })),
    note: `Comparação feita na cópia local autorizada com git ls-tree, merge-base e diff-tree (somente leitura de objetos).`,
  };
}

/** Bare file listing of a commit (paths, sizes, blob ids), no content — for review screens and scope checks. */
export async function listTreeEntries(dir: string, commit: string, deps: GitDeps): Promise<TreeEntry[]> {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new GithubError("invalid_repo", "Commit local inválido (use o hash completo de 40 caracteres).");
  const g = resolveGit(deps);
  if (!g) throw new GithubError("github_unavailable", "Git não encontrado neste computador.");
  const tree = await git(deps, g, dir, ["ls-tree", "-r", "-l", "--full-tree", commit], 8_000_000);
  if (tree.code !== 0) throw new GithubError("github_unavailable", "Não foi possível listar os arquivos do commit local.");
  const entries: TreeEntry[] = [];
  for (const line of tree.stdout.split(/\r?\n/)) {
    const m = /^\d+ (blob|tree|commit) ([0-9a-f]{40})\s+(-|\d+)\t(.+)$/.exec(line);
    if (m) entries.push({ path: m[4], type: m[1], size: m[3] === "-" ? 0 : Number(m[3]), blob: m[2] });
  }
  return entries;
}

/**
 * Real diff of exactly one commit against its parent (`git show`), from an authorized local clone — for QA,
 * reviewing a commit that was applied directly (no Developer run of its own to reuse a diff from). Read-only:
 * only committed objects, no checkout, no working-tree access. Redacted the same way as the Developer's own
 * diff (worktree.ts#redactSecrets), and capped the same way.
 */
export async function readCommitDiff(dir: string, commit: string, deps: GitDeps): Promise<{ files: DeveloperDiffFile[]; diffText: string; diffTruncated: boolean }> {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new GithubError("invalid_repo", "Commit inválido (use o hash completo de 40 caracteres).");
  const g = resolveGit(deps);
  if (!g) throw new GithubError("github_unavailable", "Git não encontrado neste computador.");
  const nameStatus = await git(deps, g, dir, ["show", "--format=", "--name-status", commit], 4_000_000);
  const numstat = await git(deps, g, dir, ["show", "--format=", "--numstat", commit], 4_000_000);
  const counts = new Map<string, { add: number | null; del: number | null }>();
  if (numstat.code === 0) {
    for (const line of numstat.stdout.split(/\r?\n/).filter(Boolean)) {
      const m = /^(-|\d+)\t(-|\d+)\t(.+)$/.exec(line);
      if (m) counts.set(m[3], { add: m[1] === "-" ? null : Number(m[1]), del: m[2] === "-" ? null : Number(m[2]) });
    }
  }
  const files: DeveloperDiffFile[] = [];
  if (nameStatus.code === 0) {
    for (const line of nameStatus.stdout.split(/\r?\n/).filter(Boolean)) {
      const m = /^([AMD])\d*\t(.+)$/.exec(line);
      if (m) files.push({ path: m[2], status: COMMIT_STATUS[m[1]] ?? "modified", additions: counts.get(m[2])?.add ?? null, deletions: counts.get(m[2])?.del ?? null, inScope: true });
    }
  }
  const patch = await git(deps, g, dir, ["show", "--format=", commit], 6_000_000);
  const raw = redactSecrets(patch.code === 0 ? patch.stdout : "");
  const diffTruncated = raw.length > MAX_COMMIT_DIFF_CHARS;
  return { files, diffText: diffTruncated ? `${raw.slice(0, MAX_COMMIT_DIFF_CHARS)}\n[… diff cortado em ${MAX_COMMIT_DIFF_CHARS} caracteres]` : raw, diffTruncated };
}

/** Reads a commit of an authorized clone with the same selection and limits as the GitHub reader. */
export async function readLocalGitContext(
  opts: {
    dir: string; owner: string; repo: string; commit: string; baseCommit: string | null;
    keywords: string[]; mentions: string[]; requested: RequestedFile[]; limits?: typeof ARCHITECT_GITHUB_LIMITS;
  },
  deps: GitDeps,
): Promise<{ context: Extract<SourceContext, { kind: "github" }>; text: string }> {
  const started = Date.now();
  if (!/^[0-9a-f]{40}$/.test(opts.commit)) throw new GithubError("invalid_repo", "Commit local inválido (use o hash completo de 40 caracteres).");
  const g = resolveGit(deps);
  if (!g) throw new GithubError("github_unavailable", "Git não encontrado neste computador.");
  const origin = await git(deps, g, opts.dir, ["remote", "get-url", "origin"]);
  const o = origin.code === 0 ? parseOrigin(origin.stdout) : null;
  if (!o || o.owner.toLowerCase() !== opts.owner.toLowerCase() || o.repo.toLowerCase() !== opts.repo.toLowerCase()) {
    throw new GithubError("github_not_permitted", `A cópia local autorizada não corresponde a ${opts.owner}/${opts.repo} (origin: ${origin.stdout.trim() || "ausente"}).`);
  }
  const exists = await git(deps, g, opts.dir, ["cat-file", "-t", opts.commit]);
  if (exists.code !== 0 || exists.stdout.trim() !== "commit") throw new GithubError("branch_not_found", `O commit ${opts.commit.slice(0, 12)} não existe na cópia local.`);
  let isDescendant: boolean | null = null;
  if (opts.baseCommit && /^[0-9a-f]{40}$/.test(opts.baseCommit)) {
    const mb = await git(deps, g, opts.dir, ["merge-base", "--is-ancestor", opts.baseCommit, opts.commit]);
    isDescendant = mb.code === 0 ? true : mb.code === 1 ? false : null;
  }
  const remotes = await git(deps, g, opts.dir, ["branch", "-r", "--contains", opts.commit]);
  const published = remotes.code === 0 && /\borigin\//.test(remotes.stdout);
  const tree = await git(deps, g, opts.dir, ["ls-tree", "-r", "-l", "--full-tree", opts.commit], 8_000_000);
  if (tree.code !== 0) throw new GithubError("github_unavailable", "Não foi possível listar os arquivos do commit local.");
  const entries: TreeEntry[] = [];
  for (const line of tree.stdout.split(/\r?\n/)) {
    const m = /^\d+ (blob|tree|commit) ([0-9a-f]{40})\s+(-|\d+)\t(.+)$/.exec(line);
    if (m) entries.push({ path: m[4], type: m[1], size: m[3] === "-" ? 0 : Number(m[3]), blob: m[2] });
  }
  const known = new Set(entries.filter(e => e.type === "blob").map(e => e.path));
  const readFile = async (p: string): Promise<{ body: string } | { skip: string }> => {
    if (!known.has(p)) return { skip: "não existe neste commit" };
    const r = await git(deps, g, opts.dir, ["show", `${opts.commit}:${p}`], 1_000_000);
    if (r.timedOut) return { skip: "tempo limite da leitura" };
    if (r.code !== 0) return { skip: "git show falhou" };
    return { body: r.stdout };
  };
  return assembleContext({
    owner: opts.owner, repo: opts.repo, branch: "(cópia local)", commit: opts.commit, description: null, defaultBranch: "main",
    entries, treeTruncated: false, readFile, limits: opts.limits ?? ARCHITECT_GITHUB_LIMITS, selection: "architect",
    keywords: opts.keywords, mentions: opts.mentions, requested: opts.requested, started, via: "local_git",
    local: { dirName: path.basename(opts.dir), published, descendantOf: opts.baseCommit, isDescendant },
  });
}

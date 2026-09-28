// Isolated working copy for the Developer: built ONLY at approval time (never
// while preparing a review), from an authorized local Git clone, and never
// from the main checkout's working tree.
// - content comes from `git archive` of the exact approved commit: this reads
//   only committed objects (same guarantee as local-git.ts), so uncommitted
//   changes, node_modules, .env*, .dev.vars and the executor's own SQLite
//   file are never included (none of them are part of the commit's tree);
// - `.git` of the source repository is never copied; the copy gets its OWN
//   throwaware repository (no remote, no credentials, no relation to the
//   source repo's history) used only to compute a diff after the model runs;
// - hooks are disabled on that throwaway repo (empty core.hooksPath) and no
//   init template is applied, so nothing local can inject unexpected actions;
// - structured arguments only, no shell, per-command time limits.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { GithubError } from "./github";
import { clientEnv, type Runner } from "./proc";
import { resolveGit, type GitDeps } from "./local-git";
import type { DeveloperDiffFile } from "@/lib/engine/types";

const MAX_DIFF_CHARS = 40_000;

/**
 * Finds `tar` without a shell. On Windows this must be the native bsdtar shipped in System32: MSYS/Cygwin
 * builds (e.g. Git for Windows' usr\bin\tar.exe) mis-parse a native "C:\Users\..." argument when invoked
 * directly (no MSYS shell to translate it first) and can even misread the drive letter as a remote host.
 */
export function resolveTar(deps: GitDeps): string | null {
  const win = (deps.platform ?? process.platform) === "win32";
  const exists = deps.exists ?? existsSync;
  if (win) {
    const native = path.win32.join(deps.env.SystemRoot || deps.env.windir || "C:\\Windows", "System32", "tar.exe");
    if (exists(native)) return native;
  }
  const dirs = (deps.env.PATH ?? deps.env.Path ?? "").split(win ? ";" : ":").map(d => d.trim().replace(/^"|"$/g, "")).filter(Boolean);
  for (const d of dirs) {
    const p = (win ? path.win32 : path.posix).join(d, win ? "tar.exe" : "tar");
    if (exists(p)) return p;
  }
  return null;
}

/** Runs one git command scoped to `dir`, with hooks and templates disabled and no line-ending rewriting. */
async function git(deps: GitDeps, gitPath: string, dir: string, hooksDir: string, args: string[], opts: { stdin?: string; runner?: Runner; maxStdoutBytes?: number } = {}) {
  const env = { ...clientEnv(deps.env), GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", LC_ALL: "C" };
  const run = opts.runner ?? deps.runner;
  return run({
    command: gitPath,
    args: ["-C", dir, "--no-pager", "-c", "core.hooksPath=" + hooksDir, "-c", "core.autocrlf=false", "-c", "core.safecrlf=false", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args],
    cwd: dir, env, timeoutMs: 20_000, stdin: opts.stdin, maxStdoutBytes: opts.maxStdoutBytes ?? 4_000_000,
  });
}

export type Materialized = { workDir: string; hooksDir: string; fileCount: number };

/**
 * Builds the isolated copy: `git archive` of the exact commit into a fresh temp directory (via `tar`,
 * binary-safe), then an empty, hook-less, remote-less throwaway repo committing that exact content as
 * the diff base. Never touches the source repo's working tree or `.git`.
 */
export async function materializeCommit(opts: { sourceDir: string; commit: string; workDir: string }, deps: GitDeps): Promise<Materialized> {
  if (!/^[0-9a-f]{40}$/.test(opts.commit)) throw new GithubError("invalid_repo", "Commit inválido (use o hash completo de 40 caracteres).");
  const g = resolveGit(deps);
  if (!g) throw new GithubError("github_unavailable", "Git não encontrado neste computador.");
  const t = resolveTar(deps);
  if (!t) throw new GithubError("github_unavailable", "O utilitário “tar” não foi encontrado neste computador (necessário para extrair a cópia isolada).");
  const hooksDir = path.join(opts.workDir, ".no-hooks");
  mkdirSync(opts.workDir, { recursive: true });
  mkdirSync(hooksDir, { recursive: true });
  const tarFile = path.join(opts.workDir, ".archive.tar");
  // `git archive` never reads the working tree or the index: only the committed tree of `opts.commit`.
  const arc = await git(deps, g, opts.sourceDir, hooksDir, ["archive", "--format=tar", opts.commit, "-o", tarFile]);
  if (arc.code !== 0) throw new GithubError("github_unavailable", `Não foi possível empacotar o commit (git archive): ${(arc.stderr || "").trim().slice(0, 300) || `código ${arc.code}`}`);
  const ex = await deps.runner({ command: t, args: ["-xf", tarFile, "-C", opts.workDir], cwd: opts.workDir, env: clientEnv(deps.env), timeoutMs: 30_000 });
  try { rmSync(tarFile, { force: true }); } catch { /* best effort */ }
  if (ex.code !== 0) throw new GithubError("github_unavailable", `Não foi possível extrair a cópia isolada (tar): ${(ex.stderr || "").trim().slice(0, 300) || `código ${ex.code}`}`);
  // A fresh, hook-less, remote-less repo, whose single commit IS the approved content — used only to diff later.
  const init = await git(deps, g, opts.workDir, hooksDir, ["init", "-q", "-b", "base", "--template="]);
  if (init.code !== 0) throw new GithubError("github_unavailable", "Não foi possível preparar o controle de versão da cópia isolada.");
  await git(deps, g, opts.workDir, hooksDir, ["add", "-A"]);
  const commit = await git(deps, g, opts.workDir, hooksDir, [
    "-c", "user.name=Setor IA", "-c", "user.email=setor-ia@local",
    "commit", "-q", "--allow-empty", "-m", `base (commit ${opts.commit})`,
  ]);
  if (commit.code !== 0) throw new GithubError("github_unavailable", "Não foi possível gravar o instantâneo base da cópia isolada.");
  const files = await git(deps, g, opts.workDir, hooksDir, ["ls-files"], { maxStdoutBytes: 8_000_000 });
  const fileCount = files.code === 0 ? files.stdout.split(/\r?\n/).filter(Boolean).length : 0;
  return { workDir: opts.workDir, hooksDir, fileCount };
}

const STATUS: Record<string, DeveloperDiffFile["status"]> = { A: "added", M: "modified", D: "deleted" };

/** Stages everything and diffs against the base commit made by materializeCommit. Read-only from the model's edits. */
export async function diffWorktree(m: Pick<Materialized, "workDir" | "hooksDir">, deps: GitDeps): Promise<{ files: DeveloperDiffFile[]; diffText: string; diffTruncated: boolean }> {
  const g = resolveGit(deps);
  if (!g) throw new GithubError("github_unavailable", "Git não encontrado neste computador.");
  await git(deps, g, m.workDir, m.hooksDir, ["add", "-A"]);
  const nameStatus = await git(deps, g, m.workDir, m.hooksDir, ["diff", "--cached", "--find-renames=100%", "--name-status", "-z"], { maxStdoutBytes: 4_000_000 });
  const numstat = await git(deps, g, m.workDir, m.hooksDir, ["diff", "--cached", "--numstat", "-z"], { maxStdoutBytes: 4_000_000 });
  const counts = new Map<string, { add: number | null; del: number | null }>();
  if (numstat.code === 0) {
    const parts = numstat.stdout.split("\0").filter(Boolean);
    for (const line of parts) {
      const m2 = /^(-|\d+)\t(-|\d+)\t(.+)$/.exec(line);
      if (m2) counts.set(m2[3], { add: m2[1] === "-" ? null : Number(m2[1]), del: m2[2] === "-" ? null : Number(m2[2]) });
    }
  }
  const files: DeveloperDiffFile[] = [];
  if (nameStatus.code === 0) {
    const parts = nameStatus.stdout.split("\0").filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      const code = parts[i];
      // Renames/copies (R100, C100...) carry two paths (old, new); treated as delete + add for scope checks.
      if (/^[RC]\d*/.test(code)) {
        const from = parts[++i], to = parts[++i];
        if (from === undefined || to === undefined) break;
        files.push({ path: from, status: "deleted", additions: null, deletions: counts.get(to)?.del ?? null, inScope: false });
        files.push({ path: to, status: "added", additions: counts.get(to)?.add ?? null, deletions: null, inScope: false });
        continue;
      }
      const p = parts[++i];
      if (p === undefined) break;
      const status = STATUS[code[0]] ?? "modified";
      files.push({ path: p, status, additions: counts.get(p)?.add ?? null, deletions: counts.get(p)?.del ?? null, inScope: false });
    }
  }
  const diff = await git(deps, g, m.workDir, m.hooksDir, ["diff", "--cached"], { maxStdoutBytes: 6_000_000 });
  const raw = diff.code === 0 ? diff.stdout : "";
  const diffTruncated = raw.length > MAX_DIFF_CHARS;
  return { files, diffText: diffTruncated ? `${raw.slice(0, MAX_DIFF_CHARS)}\n[… diff cortado em ${MAX_DIFF_CHARS} caracteres]` : raw, diffTruncated };
}

/** Best-effort cleanup; never throws (the run's outcome must not depend on it). */
export function destroyWorktree(workDir: string) {
  try { rmSync(workDir, { recursive: true, force: true }); } catch { /* best effort */ }
}

/** Writes the frozen system prompt into the working copy's parent scratch area, outside the copy itself. */
export function writeScratchFile(dir: string, name: string, content: string) {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  writeFileSync(file, content, "utf8");
  return file;
}

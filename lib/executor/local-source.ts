// "Projeto local autorizado" as the source of a demand (Director planning).
// - Everything is resolved by the project's id, which only the executor hands out (projects.ts); the browser never
//   sends a path that is trusted for reading. A removed or unusable project is refused.
// - The user picks a reference (branch, tag, commit...) and SEES the SHA it resolves to before planning; that exact
//   SHA is what gets read. Moving the branch afterwards does not change the plan (the new position is only reported).
// - Only committed Git objects are read (the same reader the Architect uses: ls-tree / show, no checkout, no
//   status-dependent content). Uncommitted entries are listed as "left out", never read.
// - No GitHub request, no Git credentials; personal configuration files and unmistakable tokens are withheld
//   (github.ts: SENSITIVE_PATH, redact.ts). Same file/char limits as the GitHub reader for the Director.
// The planner and the review screen call the same function (readDirectorLocalContext), so what the user reviews is
// what the Director receives.
import { createHash } from "node:crypto";
import type { LocalProject, LocalSourceRef, ProjectRefs, RefOption, ResolvedSource, SourceContext } from "@/lib/engine/types";
import { GithubError } from "./github";
import { readLocalGitContext, resolveGit, runGit, uncommittedEntries, type GitDeps } from "./local-git";
import { getProject, type ProjectDeps } from "./projects";

export class LocalSourceError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

const HEX40 = /^[0-9a-f]{40}$/;
/** Branch/tag/remote names, short or full SHAs and simple ancestry expressions (HEAD~2, main^). No spaces, ":", "@{", "..", or a leading "-". */
const REF = /^[A-Za-z0-9][A-Za-z0-9._/~^+-]{0,199}$/;


async function usableProject(projectId: unknown, deps: ProjectDeps): Promise<LocalProject & { owner: string; repo: string }> {
  if (typeof projectId !== "string") throw new LocalSourceError(400, "invalid_project", "Projeto local inválido.");
  const p = await getProject(projectId, deps);
  if (!p) throw new LocalSourceError(404, "project_not_found", "Esse projeto local não está mais autorizado no executor (foi removido ou não existe). Escolha outro em Configurações → Conexões de IA → Projetos locais.");
  if (p.problem || !p.owner || !p.repo) throw new LocalSourceError(409, "project_unusable", `O projeto “${p.label}” não pode ser lido agora: ${p.problem ?? "sem remoto origin do GitHub"}`);
  return p as LocalProject & { owner: string; repo: string };
}

const gitOrThrow = (deps: GitDeps) => { if (!resolveGit(deps)) throw new LocalSourceError(503, "git_missing", "Git não encontrado neste computador."); };

/** Branches, remote-tracking branches and tags of the project (newest first), plus the checked-out HEAD. */
export async function listProjectRefs(projectId: string, deps: ProjectDeps): Promise<ProjectRefs> {
  const p = await usableProject(projectId, deps);
  gitOrThrow(deps.git);
  const out = await runGit(deps.git, p.dir, ["for-each-ref", "--sort=-committerdate", "--count=201", "--format=%(refname)%1f%(objectname)%1f%(*objectname)%1f%(subject)", "refs/heads", "refs/remotes", "refs/tags"], { maxStdoutBytes: 2_000_000 });
  if (out.code !== 0) throw new LocalSourceError(502, "refs_unreadable", "Não foi possível listar os branches e tags deste projeto.");
  const lines = out.stdout.split(/\r?\n/).filter(Boolean);
  const refs: RefOption[] = [];
  for (const line of lines.slice(0, 200)) {
    const [full, obj, peeled, subject] = line.split("\x1f");
    const sha = HEX40.test(peeled ?? "") ? peeled : obj;
    if (!full || !HEX40.test(sha ?? "") || /^refs\/remotes\/[^/]+\/HEAD$/.test(full)) continue;
    const kind = full.startsWith("refs/heads/") ? "branch" : full.startsWith("refs/tags/") ? "tag" : "remote";
    refs.push({ name: full.replace(/^refs\/(heads|tags|remotes)\//, ""), kind, sha, subject: (subject ?? "").slice(0, 120), current: kind === "branch" && full === `refs/heads/${p.branch}` });
  }
  return {
    projectId: p.id, projectLabel: p.label, owner: p.owner, repo: p.repo,
    head: { sha: p.head ?? "", branch: p.branch && p.branch !== "HEAD" ? p.branch : null, subject: p.headSubject ?? "" },
    refs, truncated: lines.length > 200,
  };
}

async function commitInfo(dir: string, sha: string, deps: GitDeps) {
  const r = await runGit(deps, dir, ["log", "-1", "--format=%H%x1f%s%x1f%cI", sha]);
  if (r.code !== 0) return null;
  const [h, s, d] = r.stdout.trim().split("\x1f");
  return HEX40.test(h ?? "") ? { sha: h, subject: (s ?? "").slice(0, 160), committedAt: d || null } : null;
}

/** ref → commit SHA (null = it does not name a commit of this project). */
async function revParse(dir: string, ref: string, deps: GitDeps): Promise<string | null> {
  const r = await runGit(deps, dir, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]);
  const sha = r.stdout.trim();
  return r.code === 0 && HEX40.test(sha) ? sha : null;
}

async function refKind(dir: string, ref: string, deps: GitDeps): Promise<ResolvedSource["refKind"]> {
  if (!ref) return "head";
  for (const [prefix, kind] of [["refs/heads/", "branch"], ["refs/tags/", "tag"], ["refs/remotes/", "remote"]] as const) {
    const r = await runGit(deps, dir, ["show-ref", "--verify", "--quiet", `${prefix}${ref}`]);
    if (r.code === 0) return kind;
  }
  return /^[0-9a-f]{7,40}$/i.test(ref) ? "commit" : "expression";
}

/**
 * Resolves what the user picked to an exact commit of the project. `ref` alone (the review screen asking "what
 * does this point to?") or `ref` + `commit` (the run starting with the SHA the user saw): in the second case the
 * pinned commit wins and `refNow` reports where the reference points today.
 */
export async function resolveLocalSource(input: { projectId: unknown; ref?: unknown; commit?: unknown }, deps: ProjectDeps) {
  return resolveFor(await usableProject(input.projectId, deps), input, deps);
}

async function resolveFor(p: LocalProject & { owner: string; repo: string }, input: { ref?: unknown; commit?: unknown }, deps: ProjectDeps): Promise<ResolvedSource & { refNow: string | null }> {
  gitOrThrow(deps.git);
  const ref = typeof input.ref === "string" ? input.ref.trim() : "";
  if (ref && (!REF.test(ref) || ref.includes("..") || ref.includes("//") || ref.endsWith("/") || ref.endsWith(".lock"))) {
    throw new LocalSourceError(400, "invalid_ref", `A referência “${ref.slice(0, 80)}” não é válida. Use o nome de um branch, de uma tag ou de um commit (por exemplo main, v1.2 ou um SHA).`);
  }
  const pinned = typeof input.commit === "string" && input.commit ? input.commit.trim().toLowerCase() : "";
  if (pinned && !HEX40.test(pinned)) throw new LocalSourceError(400, "invalid_commit", "O commit deve ser o SHA completo (40 caracteres).");
  const head = p.head && HEX40.test(p.head) ? p.head : null;
  if (!head) throw new LocalSourceError(409, "no_head", `O projeto “${p.label}” não tem commits (HEAD ilegível).`);
  const byRef = ref ? await revParse(p.dir, ref, deps.git) : head;
  let sha: string;
  if (pinned) {
    const t = await runGit(deps.git, p.dir, ["cat-file", "-t", pinned]);
    if (t.code !== 0 || t.stdout.trim() !== "commit") throw new LocalSourceError(404, "commit_not_found", `O commit ${pinned.slice(0, 12)} não existe no projeto “${p.label}”. Escolha a referência de novo e confira o SHA antes de planejar.`);
    sha = pinned;
  } else {
    if (!byRef) {
      const list = await listProjectRefs(p.id, deps).catch(() => null);
      const some = list?.refs.filter(r => r.kind !== "remote").slice(0, 6).map(r => r.name).join(", ");
      throw new LocalSourceError(404, "ref_not_found", `A referência “${ref}” não existe no projeto “${p.label}”${some ? ` (algumas que existem: ${some})` : ""}. Escolha um branch ou tag da lista, ou informe um SHA.`);
    }
    sha = byRef;
  }
  const info = await commitInfo(p.dir, sha, deps.git);
  if (!info) throw new LocalSourceError(502, "commit_unreadable", `Não foi possível ler o commit ${sha.slice(0, 12)} do projeto.`);
  const remotes = await runGit(deps.git, p.dir, ["branch", "-r", "--contains", sha]);
  return {
    projectId: p.id, projectLabel: p.label, dirName: p.dirName, owner: p.owner, repo: p.repo,
    ref, refKind: await refKind(p.dir, ref, deps.git), commit: sha, subject: info.subject, committedAt: info.committedAt,
    head: { sha: head, branch: p.branch && p.branch !== "HEAD" ? p.branch : null },
    dirty: await uncommittedEntries(p.dir, deps.git),
    published: remotes.code === 0 && /\borigin\//.test(remotes.stdout),
    refNow: pinned && ref && byRef && byRef !== sha ? byRef : null,
  };
}

export function directorKeywords(...texts: string[]) {
  return [...new Set(texts.join(" ").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").split(/[^a-z0-9_-]+/))];
}

const sha256 = (t: string) => createHash("sha256").update(t).digest("hex");

/**
 * The Director's context from an authorized project at the commit the user reviewed: the same selection and limits
 * as the GitHub reader (docs, manifests, files whose names match the demand), through the same local reader the
 * Architect uses. Throws LocalSourceError / GithubError with understandable messages.
 */
export async function readDirectorLocalContext(local: LocalSourceRef, demand: { title: string; description: string }, deps: ProjectDeps): Promise<{ context: Extract<SourceContext, { kind: "github" }>; text: string; resolved: ResolvedSource & { refNow: string | null } }> {
  const p = await usableProject(local.projectId, deps);
  const resolved = await resolveFor(p, { ref: local.ref, commit: local.commit }, deps);
  const r = await readLocalGitContext({
    dir: p.dir, owner: resolved.owner, repo: resolved.repo, commit: resolved.commit, baseCommit: null,
    keywords: directorKeywords(demand.title, demand.description), mentions: [], requested: [], selection: "director",
    source: { branch: resolved.ref || resolved.head.branch || "HEAD", projectId: resolved.projectId, projectLabel: resolved.projectLabel, ref: resolved.ref, refNow: resolved.refNow, subject: resolved.subject, dirty: resolved.dirty },
  }, deps.git).catch(e => { if (e instanceof GithubError) throw new LocalSourceError(e.code === "branch_not_found" ? 404 : 502, e.code, e.message); throw e; });
  r.context.local = { ...r.context.local!, textSha256: sha256(r.text) };
  return { context: r.context, text: r.text, resolved };
}

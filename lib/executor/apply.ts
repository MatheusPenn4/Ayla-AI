// "Revisar alterações → Aplicar ao projeto local": applies the diff a Developer run produced (and the
// executor itself computed and persisted) to an authorized local project, only after the user confirmed a
// review of the exact target state.
// - the browser sends ids (run, project, review token, idempotency key), never a command or a path;
// - the persisted diff is applied as stored (git apply, from stdin), never retranscribed;
// - refused when truncated, redacted, out of scope, inconsistent with the run's own file list, tampered
//   (hash recorded when the diff was computed), binary/symlink/submodule, or when any path could leave
//   the project (".." segments, absolute paths, ".git", links on the way);
// - the review token is a hash of the target's state (HEAD, content and local-change status of every
//   affected file, the dry-run outcome): a confirmation made against a different state is refused and the
//   difference is shown;
// - local changes are preserved: git apply only touches the patch's own hunks and refuses (atomically) on
//   conflict; the affected files are backed up first and restored if anything fails afterwards;
// - never stages, commits, pushes or deploys.
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ApplicationRecord, ApplyCheck, ApplyFileState, ApplyReview, DeveloperDiff, DeveloperSnapshot, RunRecord } from "@/lib/engine/types";
import { runGit, type GitDeps } from "./local-git";
import { canonicalDir, getProject, type ProjectDeps } from "./projects";
import type { RunStore } from "./store";

export type ApplyDeps = {
  store: RunStore;
  git: GitDeps;
  projects: ProjectDeps;
  /** Where backups of the affected files are kept (inside the executor's own data folder). */
  dataDir: string;
  /** Scratch area OUTSIDE any repository (the expected result is computed there). */
  workRoot: string;
  /** Test hook: runs right after git apply wrote the files (a throw simulates a failure after writing). */
  afterWrite?: () => Promise<void>;
};

export class ApplyRefused extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message); }
}

export const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
/** Line-ending-insensitive content hash: the checkout may convert LF↔CRLF (core.autocrlf), the patch is LF. */
const normSha = (b: Buffer) => sha256(b.toString("utf8").replace(/\r\n/g, "\n"));

/** A path taken from a diff header, checked before it is used anywhere (null = acceptable). */
export function relPathProblem(p: string): string | null {
  if (!p || p.length > 240) return "caminho vazio ou longo demais";
  if (p.includes("\0") || p.includes("\\")) return "caracteres não permitidos no caminho";
  if (/^[A-Za-z]:/.test(p) || p.startsWith("/")) return "caminho absoluto";
  const segs = p.split("/");
  if (segs.some(s => s === ".." )) return "travessia de diretório (..)";
  if (segs.some(s => s === "" || s === ".")) return "segmento vazio ou “.” no caminho";
  if (segs.some(s => s.toLowerCase() === ".git")) return "caminho dentro de .git";
  return null;
}

/** Any link (symlink/junction) on the way from the project root to `rel`, or a resolved location outside the root. */
export function pathEscape(projectReal: string, rel: string): string | null {
  let cur = projectReal;
  for (const seg of rel.split("/")) {
    cur = path.join(cur, seg);
    if (!existsSync(cur)) break;
    const st = lstatSync(cur);
    if (st.isSymbolicLink()) return `“${path.relative(projectReal, cur).replace(/\\/g, "/")}” é um link simbólico ou junção`;
    const real = realpathSync.native(cur);
    const root = canonicalDir(projectReal) + "/";
    if (!(canonicalDir(real) + "/").startsWith(root)) return "resolve para fora do projeto";
  }
  return null;
}

type PatchScan = { headerPaths: string[]; problems: string[] };
/** Structural scan of the persisted patch text (never executed, only read). */
export function scanPatch(text: string): PatchScan {
  const headerPaths: string[] = [];
  const problems: string[] = [];
  for (const line of text.split("\n")) {
    const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (m) {
      if (m[1] !== m[2]) problems.push(`renomeação/cópia (${m[1]} → ${m[2]}) não é suportada nesta versão`);
      headerPaths.push(m[2]);
      continue;
    }
    if (/^(new|deleted) file mode 120000|^(old|new) mode 120000/.test(line)) problems.push("o diff cria ou altera um link simbólico");
    if (/^(new|deleted) file mode 160000|^Subproject commit /.test(line)) problems.push("o diff altera um submódulo");
    if (/^GIT binary patch$|^Binary files .* differ$/.test(line)) problems.push("o diff contém arquivo binário, que o texto persistido não representa");
    if (/^rename (from|to) |^copy (from|to) /.test(line)) problems.push("renomeação/cópia não é suportada nesta versão");
  }
  if (text.includes("[REDACTED]")) problems.push("o diff tem trechos redigidos ([REDACTED]) por parecerem segredos: o texto persistido não corresponde ao conteúdo real");
  if (/\[… diff cortado em \d+ caracteres\]/.test(text)) problems.push("o texto do diff foi cortado por tamanho");
  return { headerPaths, problems: [...new Set(problems)] };
}

async function statusMap(dir: string, deps: GitDeps) {
  const st = await runGit(deps, dir, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { maxStdoutBytes: 8_000_000 });
  const map = new Map<string, string>();
  if (st.code !== 0) return map;
  const parts = st.stdout.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (!/^.. /.test(e)) continue;
    const code = e.slice(0, 2), p = e.slice(3);
    map.set(p, code);
    if (code[0] === "R" || code[0] === "C") i++; // the next entry is the original path
  }
  return map;
}

function fileState(root: string, rel: string, action: ApplyFileState["action"], status: Map<string, string>): ApplyFileState {
  const abs = path.join(root, ...rel.split("/"));
  const exists = existsSync(abs);
  return { path: rel, action, exists, sha256: exists ? sha256(readFileSync(abs)) : null, localChange: status.get(rel)?.trim() || null };
}

/** Parses `git apply` errors into "which file, why" (English, LC_ALL=C). */
export function parseApplyErrors(stderr: string): { path: string; reason: string }[] {
  const out: { path: string; reason: string }[] = [];
  for (const line of stderr.split(/\r?\n/)) {
    let m = /^error: patch failed: (.+):(\d+)$/.exec(line);
    if (m) { out.push({ path: m[1], reason: `o trecho na linha ${m[2]} não corresponde ao conteúdo atual do arquivo (alteração local ou versão diferente)` }); continue; }
    m = /^error: (.+): (already exists in working directory|does not exist in index|No such file or directory|does not match index|patch does not apply)$/.exec(line);
    if (m) {
      const why = m[2] === "already exists in working directory" ? "o arquivo que o diff cria já existe no projeto"
        : m[2] === "No such file or directory" || m[2] === "does not exist in index" ? "o arquivo que o diff altera não existe no projeto"
          : m[2] === "patch does not apply" ? "o diff não se aplica a este arquivo" : "o arquivo difere do esperado";
      if (!out.some(o => o.path === m![1])) out.push({ path: m[1], reason: why });
    }
  }
  return out;
}

type ReviewState = { head: string; branch: string | null; affected: ApplyFileState[]; applyState: ApplyReview["applyCheck"]["state"]; diffSha256: string };

function tokenOf(runId: string, projectId: string, st: ReviewState) {
  return sha256(JSON.stringify({ runId, projectId, head: st.head, branch: st.branch, diff: st.diffSha256, apply: st.applyState, affected: st.affected.map(a => [a.path, a.exists, a.sha256, a.localChange]) }));
}

/** What changed between the reviewed state and now (shown when a confirmation is refused). */
export function describeChanges(before: ReviewState, now: ReviewState): string[] {
  const out: string[] = [];
  if (before.head !== now.head) out.push(`O commit atual do projeto mudou: ${before.head.slice(0, 12)} → ${now.head.slice(0, 12)}.`);
  if (before.branch !== now.branch) out.push(`A branch mudou: ${before.branch ?? "—"} → ${now.branch ?? "—"}.`);
  for (const a of now.affected) {
    const b = before.affected.find(x => x.path === a.path);
    if (!b) continue;
    if (b.exists !== a.exists) out.push(`${a.path}: ${a.exists ? "passou a existir" : "foi removido"} depois da revisão.`);
    else if (b.sha256 !== a.sha256) out.push(`${a.path}: o conteúdo mudou depois da revisão.`);
    if (b.localChange !== a.localChange) out.push(`${a.path}: estado local ${b.localChange ?? "sem alteração"} → ${a.localChange ?? "sem alteração"}.`);
  }
  if (before.applyState !== now.applyState) out.push(`O resultado da verificação de aplicação mudou: ${before.applyState} → ${now.applyState}.`);
  if (before.diffSha256 !== now.diffSha256) out.push("O diff registrado mudou depois da revisão (integridade comprometida).");
  return out.length ? out : ["O estado do projeto mudou depois da revisão."];
}

/** The Developer run and its persisted diff, refusing anything that is not a real, finished implementation. */
async function sourceRun(store: RunStore, runId: string): Promise<{ run: RunRecord; diff: DeveloperDiff; snap: DeveloperSnapshot }> {
  if (!/^[0-9a-f-]{36}$/.test(runId)) throw new ApplyRefused(400, "invalid_run", "Execução inválida.");
  const run = await store.get(runId);
  if (!run || run.kind !== "developer_task") throw new ApplyRefused(404, "run_not_found", "Execução do Desenvolvedor não encontrada.");
  if (run.status !== "implementation_ready" || !run.developer?.diff) throw new ApplyRefused(409, "run_not_ready", run.rejectedDiff ? "Esta execução terminou com o diff rejeitado (fora do escopo ou resposta inválida): um diff rejeitado nunca é aplicado." : "Só o diff de uma execução concluída (Implementação pronta) pode ser aplicado.");
  return { run, diff: run.developer.diff, snap: (await store.snapshot(runId)) as DeveloperSnapshot };
}

export async function buildApplyReview(runId: string, projectId: string, deps: ApplyDeps): Promise<{ review: ApplyReview; state: ReviewState }> {
  const { run, diff, snap } = await sourceRun(deps.store, runId);
  const project = await getProject(projectId, deps.projects);
  if (!project) throw new ApplyRefused(404, "project_not_found", "Projeto local não encontrado entre os autorizados no executor.");
  const plan = run.parentRunId ? await deps.store.get(run.parentRunId) : null;
  const task = plan?.result?.tasks.find(t => t.id === run.taskId);
  const checks: ApplyCheck[] = [];
  const blockers: string[] = [];
  const check = (ok: boolean, label: string, detail: string) => { checks.push({ ok, label, detail }); if (!ok) blockers.push(`${label}: ${detail}`); };

  // 1. The diff itself: complete, intact, consistent with the run, inside the approved scope.
  const text = diff.diffText;
  const actual = sha256(text);
  const recorded = diff.diffSha256 ?? null;
  const diffEvent = (await deps.store.events(runId)).filter(e => e.kind === "diff").at(-1);
  const eventHash = (diffEvent?.data as { diffSha256?: string } | undefined)?.diffSha256 ?? null;
  let integrity: ApplyReview["diff"]["integrity"] = "verified";
  if (recorded || eventHash) {
    const ok = (!recorded || recorded === actual) && (!eventHash || eventHash === actual);
    integrity = ok ? "verified" : "mismatch";
    check(ok, "Integridade do diff", ok ? `SHA-256 ${actual.slice(0, 16)}… confere com o registrado quando o executor calculou o diff.` : "O diff persistido não corresponde ao hash registrado quando foi calculado: foi alterado depois.");
  } else {
    integrity = "legacy_unrecorded";
    const evFiles = ((diffEvent?.data as { files?: { path: string }[] } | undefined)?.files ?? []).map(f => f.path).sort().join("\n");
    const ok = !!evFiles && evFiles === diff.files.map(f => f.path).sort().join("\n");
    check(ok, "Integridade do diff", ok ? "Execução anterior ao registro de hash: a lista de arquivos confere com o evento gravado quando o diff foi calculado (conferência parcial)." : "Execução anterior ao registro de hash e a lista de arquivos não confere com o evento original.");
  }
  check(!diff.diffTruncated, "Diff completo", diff.diffTruncated ? "O diff foi cortado por tamanho quando foi registrado; aplicar um diff incompleto não é permitido." : "O diff registrado está completo.");
  const scan = scanPatch(text);
  check(!scan.problems.length, "Conteúdo aplicável", scan.problems.length ? scan.problems.join("; ") : "Somente alterações de texto em arquivos comuns.");
  const recordedPaths = [...new Set(diff.files.map(f => f.path))].sort();
  const headerPaths = [...new Set(scan.headerPaths)].sort();
  check(recordedPaths.join("\n") === headerPaths.join("\n"), "Arquivos do diff", recordedPaths.join("\n") === headerPaths.join("\n") ? `${recordedPaths.length} arquivo(s); os cabeçalhos do diff conferem com a lista registrada pela execução.` : `Os cabeçalhos do diff (${headerPaths.join(", ") || "nenhum"}) não conferem com a lista registrada (${recordedPaths.join(", ") || "nenhum"}).`);
  const editable = new Set((snap?.editScope ?? []).filter(e => e.action !== "consultar").map(e => e.path));
  const outside = recordedPaths.filter(p => !editable.has(p));
  const scopeOk = !diff.outOfScope.length && diff.files.every(f => f.inScope) && !outside.length;
  check(scopeOk, "Escopo aprovado", scopeOk ? `Todos os arquivos estão no escopo de edição que você aprovou (${[...editable].join(", ")}).` : `Fora do escopo aprovado: ${[...new Set([...diff.outOfScope, ...outside])].join(", ")}.`);

  // 2. Every path stays inside the project, with no link on the way.
  const pathIssues: string[] = [];
  let real = project.dir;
  try { real = realpathSync.native(project.dir); } catch { /* reported below by the project problem */ }
  for (const p of headerPaths) {
    const bad = relPathProblem(p) ?? pathEscape(real, p);
    if (bad) pathIssues.push(`${p}: ${bad}`);
  }
  check(!pathIssues.length, "Caminhos dentro do projeto", pathIssues.length ? pathIssues.join("; ") : "Nenhum caminho sai da pasta do projeto (sem “..”, caminho absoluto, .git ou link no trajeto).");

  // 3. The target: same repository as the demand, its state, local changes, dry run.
  if (project.problem) check(false, "Projeto local", project.problem);
  const sameRepo = !!project.owner && !!snap?.base && project.owner.toLowerCase() === snap.base.owner.toLowerCase() && project.repo?.toLowerCase() === snap.base.repo.toLowerCase();
  check(sameRepo, "Repositório de destino", sameRepo ? `${project.owner}/${project.repo}, o mesmo repositório do commit base da execução.` : `O projeto é ${project.owner ?? "?"}/${project.repo ?? "?"}, mas a execução partiu de ${snap?.base?.owner}/${snap?.base?.repo}.`);
  const status = pathIssues.length || project.problem ? new Map<string, string>() : await statusMap(project.dir, deps.git);
  const affected = pathIssues.length ? [] : diff.files.map(f => fileState(project.dir, f.path, f.status, status));
  const dirtyOutside = [...status.keys()].filter(p => !recordedPaths.includes(p)).slice(0, 40);

  let applyCheck: ApplyReview["applyCheck"] = { state: "error", conflicts: [], output: "Verificação não executada (bloqueios acima)." };
  if (!pathIssues.length && !scan.problems.length && !project.problem && sameRepo && integrity !== "mismatch" && !diff.diffTruncated) {
    const fwd = await runGit(deps.git, project.dir, ["apply", "--check", "--verbose", "-"], { stdin: text });
    if (fwd.code === 0) applyCheck = { state: "applies", conflicts: [], output: (fwd.stderr || fwd.stdout).trim().slice(0, 4000) };
    else {
      const rev = await runGit(deps.git, project.dir, ["apply", "--reverse", "--check", "-"], { stdin: text });
      applyCheck = rev.code === 0
        ? { state: "already_present", conflicts: [], output: "Aplicar o diff ao contrário funcionaria: as alterações dele já estão no projeto." }
        : { state: "conflict", conflicts: parseApplyErrors(fwd.stderr), output: (fwd.stderr || fwd.stdout).trim().slice(0, 4000) };
    }
  }
  if (applyCheck.state === "conflict") blockers.push(`Conflito: ${applyCheck.conflicts.map(c => `${c.path} (${c.reason})`).join("; ") || applyCheck.output.slice(0, 300)}`);

  const head = project.head ?? "";
  const state: ReviewState = { head, branch: project.branch, affected, applyState: applyCheck.state, diffSha256: actual };
  const token = tokenOf(runId, projectId, state);
  await deps.store.saveApplyReview(token, runId, projectId, state);
  const review: ApplyReview = {
    token, createdAt: new Date().toISOString(),
    run: { id: run.id, planId: run.parentRunId ?? "", taskId: run.taskId ?? "", taskTitle: task?.title ?? "", baseCommit: diff.baseCommit, finishedAt: run.finishedAt },
    project,
    diff: { text, sha256: actual, recordedSha256: recorded ?? eventHash, integrity, files: diff.files, truncated: diff.diffTruncated },
    checks,
    target: { head, branch: project.branch, dirtyTotal: status.size, dirtyOutside, affected },
    applyCheck,
    blockers,
    applications: await deps.store.applicationsFor(runId),
  };
  return { review, state };
}

const locks = new Map<string, Promise<unknown>>();
async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>(r => (release = r));
  locks.set(key, prev.then(() => mine));
  await prev.catch(() => {});
  try { return await fn(); } finally { release(); if (locks.get(key) === mine) locks.delete(key); }
}

/**
 * The user's confirmation of a review. Idempotent: the same idempotency key returns the same record, and a
 * second confirmation of an already-applied diff never writes again. Serialized per project.
 */
export async function applyReviewed(req: { runId?: unknown; projectId?: unknown; reviewToken?: unknown; idempotencyKey?: unknown }, deps: ApplyDeps): Promise<{ application: ApplicationRecord; duplicate: boolean }> {
  const runId = typeof req.runId === "string" ? req.runId : "";
  const projectId = typeof req.projectId === "string" ? req.projectId : "";
  const token = typeof req.reviewToken === "string" && /^[0-9a-f]{64}$/.test(req.reviewToken) ? req.reviewToken : "";
  const key = typeof req.idempotencyKey === "string" && /^[A-Za-z0-9:_-]{8,120}$/.test(req.idempotencyKey) ? req.idempotencyKey : "";
  if (!runId || !projectId || !token || !key) throw new ApplyRefused(400, "invalid_request", "Informe execução, projeto, a revisão confirmada e a chave de idempotência.");
  return withLock(`project:${projectId}`, async () => {
    const byKey = await deps.store.applicationByKey(key);
    if (byKey) return { application: byKey, duplicate: true };
    const saved = await deps.store.getApplyReview<ReviewState>(token);
    if (!saved || saved.runId !== runId || saved.projectId !== projectId) throw new ApplyRefused(409, "review_not_found", "Esta confirmação não corresponde a uma revisão feita neste executor. Abra a revisão de novo.");
    const { review, state } = await buildApplyReview(runId, projectId, deps);
    if (review.token !== token) throw new ApplyRefused(409, "target_changed", "O projeto mudou depois da revisão; a confirmação foi invalidada. Revise de novo antes de aplicar.", { changes: describeChanges(saved.state, state), review });
    // An application of this same run already succeeded and its result is still what is on disk: nothing to do.
    const prior = review.applications.find(a => a.projectId === projectId && a.outcome === "applied" && a.files.every(f => review.target.affected.find(x => x.path === f.path)?.sha256 === f.afterSha256));
    if (prior) return { application: prior, duplicate: true };
    if (review.blockers.length) throw new ApplyRefused(409, "blocked", "A aplicação foi recusada.", { blockers: review.blockers, review });

    const id = randomUUID();
    const base = {
      id, runId, planId: review.run.planId, taskId: review.run.taskId, projectId, projectDir: review.project.dir, head: review.target.head,
      baseCommit: review.run.baseCommit, diffSha256: review.diff.sha256, reviewToken: token, idempotencyKey: key, createdAt: new Date().toISOString(), verification: null,
    };
    if (review.applyCheck.state === "already_present") {
      const files = review.target.affected.map(a => ({ path: a.path, action: a.action, beforeSha256: a.sha256, afterSha256: a.sha256 }));
      const app = await deps.store.createApplication({ ...base, outcome: "already_present", message: "As alterações deste diff já estavam no projeto; nada foi escrito.", files });
      await deps.store.event(runId, "application_already_present", `Revisão confirmada para ${review.project.label}: as alterações do diff já estavam no projeto; nenhum arquivo foi escrito.`, { applicationId: id, projectId });
      return { application: app, duplicate: false };
    }
    return { application: await writeAndVerify(review, base, deps), duplicate: false };
  });
}

async function writeAndVerify(review: ApplyReview, base: Omit<ApplicationRecord, "outcome" | "message" | "files">, deps: ApplyDeps): Promise<ApplicationRecord> {
  const dir = review.project.dir;
  const backupDir = path.join(deps.dataDir, "applications", base.id, "backup");
  mkdirSync(backupDir, { recursive: true });
  const before = review.target.affected;
  for (const a of before) if (a.exists) {
    const dest = path.join(backupDir, ...a.path.split("/"));
    mkdirSync(path.dirname(dest), { recursive: true });
    copyFileSync(path.join(dir, ...a.path.split("/")), dest);
  }
  writeFileSync(path.join(backupDir, "..", "manifest.json"), JSON.stringify({ project: dir, head: base.head, files: before }, null, 1));
  const abs = (p: string) => path.join(dir, ...p.split("/"));
  const restore = () => {
    for (const a of before) {
      if (a.exists) { mkdirSync(path.dirname(abs(a.path)), { recursive: true }); copyFileSync(path.join(backupDir, ...a.path.split("/")), abs(a.path)); }
      else if (existsSync(abs(a.path))) unlinkSync(abs(a.path));
    }
    return before.filter(a => (existsSync(abs(a.path)) ? sha256(readFileSync(abs(a.path))) : null) !== a.sha256).map(a => a.path);
  };
  const fail = async (why: string) => {
    const left = restore();
    const outcome: ApplicationRecord["outcome"] = left.length ? "failed_unrestored" : "failed_restored";
    const message = left.length ? `${why} A restauração não devolveu exatamente o estado anterior de: ${left.join(", ")}. A cópia de segurança está em ${backupDir}.` : `${why} Os arquivos afetados foram restaurados exatamente ao estado anterior.`;
    const files = before.map(a => ({ path: a.path, action: a.action, beforeSha256: a.sha256, afterSha256: existsSync(abs(a.path)) ? sha256(readFileSync(abs(a.path))) : null }));
    const app = await deps.store.createApplication({ ...base, outcome, message, files });
    await deps.store.event(base.runId, "application_failed", `Aplicação em ${review.project.label} falhou: ${message}`, { applicationId: base.id });
    return app;
  };

  const res = await runGit(deps.git, dir, ["apply", "--whitespace=nowarn", "-"], { stdin: review.diff.text });
  if (res.code !== 0) return fail(`O git apply recusou o diff: ${(res.stderr || res.stdout).trim().slice(0, 400)}.`);
  try { await deps.afterWrite?.(); } catch (e) { return fail(`Falha logo depois de escrever os arquivos: ${(e as Error).message}.`); }

  // The result must be exactly what the persisted patch produces from the previous content: recompute it in a
  // scratch repository outside every project and compare, file by file (line endings normalized).
  const scratch = path.join(deps.workRoot, `apply-${base.id}`);
  try {
    mkdirSync(scratch, { recursive: true });
    for (const a of before) if (a.exists) {
      const dest = path.join(scratch, ...a.path.split("/"));
      mkdirSync(path.dirname(dest), { recursive: true });
      // LF like the persisted patch (the checkout may hold CRLF through core.autocrlf); compared normalized below.
      writeFileSync(dest, readFileSync(path.join(backupDir, ...a.path.split("/"))).toString("utf8").replace(/\r\n/g, "\n"));
    }
    await runGit(deps.git, scratch, ["init", "-q", "--template="]);
    const exp = await runGit(deps.git, scratch, ["-c", "core.autocrlf=false", "apply", "--whitespace=nowarn", "-"], { stdin: review.diff.text });
    if (exp.code !== 0) return fail(`Não foi possível recalcular o resultado esperado do diff: ${(exp.stderr || "").trim().slice(0, 300)}.`);
    const mismatch: string[] = [];
    for (const a of before) {
      const got = existsSync(abs(a.path)) ? normSha(readFileSync(abs(a.path))) : null;
      const want = existsSync(path.join(scratch, ...a.path.split("/"))) ? normSha(readFileSync(path.join(scratch, ...a.path.split("/")))) : null;
      if (got !== want) mismatch.push(a.path);
    }
    const rev = await runGit(deps.git, dir, ["apply", "--reverse", "--check", "-"], { stdin: review.diff.text });
    if (mismatch.length || rev.code !== 0) return fail(`O resultado no projeto não corresponde ao diff${mismatch.length ? ` (${mismatch.join(", ")})` : ""}.`);
  } finally {
    try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  const files = before.map(a => ({ path: a.path, action: a.action, beforeSha256: a.sha256, afterSha256: existsSync(abs(a.path)) ? sha256(readFileSync(abs(a.path))) : null }));
  const app = await deps.store.createApplication({ ...base, outcome: "applied", message: `Diff aplicado em ${review.project.label} (${files.length} arquivo(s)), sem commit. O resultado confere com o diff persistido.`, files });
  await deps.store.event(base.runId, "applied_locally", `Diff aplicado ao projeto local ${review.project.label} (${dir}) após a sua confirmação: ${files.map(f => f.path).join(", ")}. Nada foi commitado, enviado ou publicado.`, { applicationId: base.id, projectId: base.projectId, head: base.head, diffSha256: base.diffSha256, files });
  return app;
}

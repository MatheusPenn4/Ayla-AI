// "Revisar alterações → Aplicar ao projeto local" and the isolated verification — no model is ever called.
// Everything below uses real Git on throwaway repositories and the real executor service.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApplicationRecord, ApplyReview, DeveloperDiff, LocalProject, TaskCompletion } from "@/lib/engine/types";
import { parseApplyErrors, relPathProblem, scanPatch } from "@/lib/executor/apply";
import { runProcess } from "@/lib/executor/proc";
import { buildNewRun, parseStartRequest } from "@/lib/executor/runs-service";
import { ExecutorService, type ExecutorConfig, type ServiceDeps } from "@/lib/executor/service";
import { sqliteDriver } from "@/lib/executor/sqlite";
import { RunStore } from "@/lib/executor/store";
import { connected, goodPlan, member, request } from "./helpers";

let work: string;
let store: RunStore;
beforeEach(() => { work = mkdtempSync(path.join(os.tmpdir(), "ayla-apply-")); store = new RunStore(sqliteDriver(":memory:")); });
afterEach(() => { rmSync(work, { recursive: true, force: true, maxRetries: 3 }); });

const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const A = ["export const a = 1;", "export const b = 2;", "export const c = 3;", "export const d = 4;", "export const e = 5;", ""].join("\n");

/** A project with origin github.com/o/r and two files; returns helpers to produce a diff exactly like the executor does. */
function makeProject(name = "proj") {
  const dir = path.join(work, name);
  mkdirSync(path.join(dir, "src"), { recursive: true });
  const g = (...a: string[]) => execFileSync("git", ["-C", dir, "-c", "core.autocrlf=false", ...a], { encoding: "utf8", env: gitEnv }).trim();
  g("init", "-q", "-b", "main");
  g("remote", "add", "origin", "https://github.com/o/r.git");
  writeFileSync(path.join(dir, "src", "a.ts"), A);
  writeFileSync(path.join(dir, "src", "b.ts"), "export const outro = true;\n");
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "p", scripts: { lint: "x", test: "x", build: "x" } }));
  g("add", "."); g("commit", "-q", "-m", "base");
  const base = g("rev-parse", "HEAD");
  /** Applies `edit` in a throwaway copy of the base commit and returns `git diff --cached` of it (the executor's own format). */
  const diffOf = (edit: (root: string) => void) => {
    const copy = mkdtempSync(path.join(work, "copy-"));
    const c = (...a: string[]) => execFileSync("git", ["-C", copy, "-c", "core.autocrlf=false", ...a], { encoding: "utf8", env: gitEnv });
    c("init", "-q"); c("fetch", "-q", dir, base); c("checkout", "-q", "FETCH_HEAD");
    edit(copy);
    c("add", "-A");
    const text = c("diff", "--cached", "FETCH_HEAD");
    rmSync(copy, { recursive: true, force: true });
    return text;
  };
  return { dir, base, g, diffOf };
}

const cfg = (): ExecutorConfig => ({ version: "t", dataDir: path.join(work, "data"), storePath: ":memory:", workRoot: path.join(work, "wr"), limits: { maxRunsPerHour: 50, maxConcurrentRuns: 1, callTimeoutMs: 1000, leaseMs: 60000, statusCacheMs: 0 }, github: {} });
function service(extra: Partial<ServiceDeps> = {}) {
  return new ExecutorService(cfg(), {
    store, runner: runProcess, env: process.env,
    detectors: { claude_code: async () => connected("claude_code"), codex: async () => connected("codex") },
    adapters: { claude_code: { id: "claude_code", call: async () => { throw new Error("nenhum modelo é chamado aqui"); } }, codex: null }, ...extra,
  });
}
const body = <T,>(r: { body: unknown }) => r.body as T;

/** A finished Director plan (t2 → developer) and a finished Developer run of t2 whose persisted diff is `diffText`. */
async function developerRun(p: ReturnType<typeof makeProject>, diffText: string, over: Partial<DeveloperDiff> = {}, editScope = [{ path: "src/a.ts", action: "alterar" }, { path: "src/novo.ts", action: "criar" }]) {
  const parsed = parseStartRequest(request({}, { source: "github", repo: { url: "https://github.com/o/r", owner: "o", repo: "r", branch: "main" } }));
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  parsed.value.team = [member("director", { handoffTo: ["developer"] }), member("developer")];
  const { run: plan } = await store.create(buildNewRun(parsed.value));
  await store.claim(plan.id, 60000);
  await store.update(plan.id, { status: "plan_ready", finishedAt: new Date().toISOString(), result: { ...goodPlan({ tasks: [{ id: "t2", step_id: "s1", assignee: "developer", title: "Implementar", scope: "x", inputs: "x", deliverable: "diff", acceptance_criteria: ["ok"], depends_on: [] }] }), limitations: [] } });
  const files = [...diffText.matchAll(/^diff --git a\/(.+) b\/(.+)$/gm)].map(m => ({ path: m[2], status: /new file mode/.test(diffText.split(m[0])[1]?.split("diff --git")[0] ?? "") ? "added" as const : "modified" as const, additions: 1, deletions: 0, inScope: true }));
  const diff: DeveloperDiff = { baseCommit: p.base, files, diffText, diffTruncated: false, outOfScope: [], diffSha256: sha(diffText), ...over };
  const { run } = await store.create({
    id: crypto.randomUUID(), kind: "developer_task", demandId: plan.demandId, agentId: "developer", idempotencyKey: `dev:${Math.random()}`, connection: "claude_code", model: "", effort: "",
    snapshotHash: "h", snapshot: { kind: "developer_task", base: { owner: "o", repo: "r", commit: p.base, dirName: path.basename(p.dir), treeEntries: 3, sampleFiles: [] }, editScope: editScope.map(e => ({ ...e, from: ["teste"] })) } as never,
    budget: { sheetTokens: 0, estimatedInputTokens: 0, calls: [], reportedTotalTokens: null, exceeded: false }, previousRunId: null, parentRunId: plan.id, taskId: "t2", initialStatus: "awaiting_approval",
  });
  await store.approve(run.id); await store.claim(run.id, 60000);
  await store.update(run.id, { status: "implementation_ready", finishedAt: new Date().toISOString(), result: { outcome: "done", summary: "s", changes: [], acceptance: [], questions: [], not_verified: [], assumptions: [], limitations: [], diff } as never });
  await store.event(run.id, "diff", "diff real", { files, diffTruncated: false, diffSha256: sha(diffText) });
  return { planId: plan.id, runId: run.id };
}

async function register(svc: ExecutorService, dir: string) {
  const r = await svc.registerProject({ dir, label: "Projeto de teste" });
  expect([200, 201]).toContain(r.status);
  return body<{ project: LocalProject }>(r).project;
}
const review = async (svc: ExecutorService, runId: string, projectId: string) => {
  const r = await svc.applyReview(runId, projectId);
  expect(r.status).toBe(200);
  return body<{ review: ApplyReview }>(r).review;
};
const apply = (svc: ExecutorService, runId: string, projectId: string, token: string, key = `k:${Math.random().toString(36).slice(2, 12)}`) => svc.applyDiff({ runId, projectId, reviewToken: token, idempotencyKey: key });
const editA = (root: string) => writeFileSync(path.join(root, "src", "a.ts"), A.replace("export const b = 2;", "export const b = 20; // alterado"));

describe("cadastro de projetos locais pela interface (o navegador só manda o caminho uma vez; o executor valida)", () => {
  it("aceita a raiz real de um repositório Git e devolve um id; recusa caminho relativo, pasta inexistente, pasta sem Git e subpasta", async () => {
    const p = makeProject();
    const svc = service();
    const proj = await register(svc, p.dir);
    expect(proj).toMatchObject({ source: "ui", owner: "o", repo: "r", head: p.base, problem: null });
    expect(body<{ project: LocalProject; created: boolean }>(await svc.registerProject({ dir: p.dir })).created).toBe(false); // no duplicate
    const code = async (dir: string) => body<{ error: { code: string } }>(await svc.registerProject({ dir })).error.code;
    expect(await code("src/proj")).toBe("not_absolute");
    expect(await code(path.join(work, "nao-existe"))).toBe("not_found");
    mkdirSync(path.join(work, "semgit"));
    expect(await code(path.join(work, "semgit"))).toBe("not_git");
    expect(await code(path.join(p.dir, "src"))).toBe("not_git"); // a subfolder has no .git of its own
    expect(body<{ projects: LocalProject[] }>(await svc.listProjects()).projects.map(x => x.id)).toContain(proj.id);
    expect(body<{ removed: boolean }>(await svc.removeProject(proj.id)).removed).toBe(true);
  });
});

describe("aplicar o diff persistido ao projeto local (git real, sem modelo)", { timeout: 30_000 }, () => {
  it("patch válido: revisão completa, aplicação idêntica ao diff persistido, nada commitado", async () => {
    const p = makeProject();
    const text = p.diffOf(root => { editA(root); writeFileSync(path.join(root, "src", "novo.ts"), "export const novo = 1;\n"); });
    const { runId, planId } = await developerRun(p, text);
    const svc = service();
    const proj = await register(svc, p.dir);
    const rv = await review(svc, runId, proj.id);
    expect(rv.blockers).toEqual([]);
    expect(rv.applyCheck.state).toBe("applies");
    expect(rv.diff).toMatchObject({ integrity: "verified", sha256: sha(text), text });
    expect(rv.run).toMatchObject({ id: runId, planId, taskId: "t2", baseCommit: p.base });
    expect(rv.target.affected.map(a => a.path).sort()).toEqual(["src/a.ts", "src/novo.ts"]);
    const r = await apply(svc, runId, proj.id, rv.token);
    expect(r.status).toBe(201);
    const app = body<{ application: ApplicationRecord }>(r).application;
    expect(app.outcome).toBe("applied");
    expect(readFileSync(path.join(p.dir, "src", "a.ts"), "utf8")).toContain("b = 20; // alterado");
    // git apply writes with the repository's own line-ending conversion (core.autocrlf): compare content, not EOL.
    expect(readFileSync(path.join(p.dir, "src", "novo.ts"), "utf8").replace(/\r\n/g, "\n")).toBe("export const novo = 1;\n");
    expect(p.g("rev-parse", "HEAD")).toBe(p.base); // never commits
    expect(p.g("diff", "--cached", "--name-only")).toBe(""); // never stages
    expect(app.files.find(f => f.path === "src/novo.ts")).toMatchObject({ beforeSha256: null, afterSha256: sha(readFileSync(path.join(p.dir, "src", "novo.ts"))) });
    expect((await store.events(runId)).some(e => e.kind === "applied_locally")).toBe(true);
  });

  it("conflito com alteração local: recusa, explica o arquivo e preserva a alteração; alteração local em outro arquivo é preservada e a aplicação segue", async () => {
    const p = makeProject();
    const text = p.diffOf(editA);
    const { runId } = await developerRun(p, text);
    const svc = service();
    const proj = await register(svc, p.dir);
    const mine = A.replace("export const b = 2;", "export const b = 99; // minha alteração local");
    writeFileSync(path.join(p.dir, "src", "a.ts"), mine);
    const rv = await review(svc, runId, proj.id);
    expect(rv.applyCheck.state).toBe("conflict");
    expect(rv.applyCheck.conflicts.map(c => c.path)).toEqual(["src/a.ts"]);
    expect(rv.target.affected[0]).toMatchObject({ path: "src/a.ts", localChange: "M" });
    const r = await apply(svc, runId, proj.id, rv.token);
    expect(r.status).toBe(409);
    expect(body<{ error: { code: string } }>(r).error.code).toBe("blocked");
    expect(readFileSync(path.join(p.dir, "src", "a.ts"), "utf8")).toBe(mine); // untouched: no reset, no discard, no merge

    writeFileSync(path.join(p.dir, "src", "a.ts"), A);
    writeFileSync(path.join(p.dir, "src", "b.ts"), "export const outro = false; // local\n");
    const rv2 = await review(svc, runId, proj.id);
    expect(rv2.target.dirtyOutside).toContain("src/b.ts");
    expect(body<{ application: ApplicationRecord }>(await apply(svc, runId, proj.id, rv2.token)).application.outcome).toBe("applied");
    expect(readFileSync(path.join(p.dir, "src", "b.ts"), "utf8")).toBe("export const outro = false; // local\n");
  });

  it("caminho fora do projeto (travessia, absoluto, .git) e link no trajeto são recusados antes de qualquer escrita", async () => {
    expect(relPathProblem("../fora.ts")).toContain("travessia");
    expect(relPathProblem("src/../../x")).toContain("travessia");
    expect(relPathProblem("C:/Windows/x")).toContain("absoluto");
    expect(relPathProblem("/etc/passwd")).toContain("absoluto");
    expect(relPathProblem(".git/hooks/pre-commit")).toContain(".git");
    expect(relPathProblem("src\\a.ts")).toContain("caracteres");
    const p = makeProject();
    const evil = p.diffOf(editA).replace(/a\/src\/a\.ts/g, "a/../fora.ts").replace(/b\/src\/a\.ts/g, "b/../fora.ts");
    const { runId } = await developerRun(p, evil, { files: [{ path: "../fora.ts", status: "modified", additions: 1, deletions: 1, inScope: true }] }, [{ path: "../fora.ts", action: "alterar" }]);
    const svc = service();
    const proj = await register(svc, p.dir);
    const rv = await review(svc, runId, proj.id);
    expect(rv.blockers.join(" ")).toContain("travessia");
    expect(body<{ error: { code: string } }>(await apply(svc, runId, proj.id, rv.token)).error.code).toBe("blocked");
    expect(existsSync(path.join(work, "fora.ts"))).toBe(false);

    // A junction inside the project pointing outside it: the path is refused even though its text looks harmless.
    const outside = path.join(work, "lado-de-fora");
    mkdirSync(outside);
    let linked = true;
    try { symlinkSync(outside, path.join(p.dir, "src", "atalho"), "junction"); } catch { linked = false; }
    if (linked) {
      const viaLink = p.diffOf(root => { mkdirSync(path.join(root, "src", "atalho"), { recursive: true }); writeFileSync(path.join(root, "src", "atalho", "x.ts"), "x\n"); });
      const r2 = await developerRun(p, viaLink, {}, [{ path: "src/atalho/x.ts", action: "criar" }]);
      const rv2 = await review(svc, r2.runId, proj.id);
      expect(rv2.blockers.join(" ")).toMatch(/link simbólico ou junção/);
      expect(readdirSync(outside)).toEqual([]);
    }
  });

  it("diff truncado, adulterado (hash diferente do registrado), redigido ou de execução rejeitada é recusado", async () => {
    const p = makeProject();
    const text = p.diffOf(editA);
    const svc = service();
    const proj = await register(svc, p.dir);
    const t = await developerRun(p, text, { diffTruncated: true });
    expect((await review(svc, t.runId, proj.id)).blockers.join(" ")).toContain("cortado por tamanho");
    const tampered = await developerRun(p, text.replace("b = 20", "b = 666"), { diffSha256: sha(text) });
    const rvT = await review(svc, tampered.runId, proj.id);
    expect(rvT.diff.integrity).toBe("mismatch");
    expect(body<{ error: { code: string } }>(await apply(svc, tampered.runId, proj.id, rvT.token)).error.code).toBe("blocked");
    const redacted = await developerRun(p, text.replace("// alterado", "// [REDACTED]"));
    expect((await review(svc, redacted.runId, proj.id)).blockers.join(" ")).toContain("REDACTED");
    const outOfScope = await developerRun(p, text, { outOfScope: ["src/a.ts"] });
    expect((await review(svc, outOfScope.runId, proj.id)).blockers.join(" ")).toContain("Fora do escopo");
    const rejected = await developerRun(p, text);
    await store.update(rejected.runId, { status: "failed", rejectedDiff: { baseCommit: p.base, files: [], diffText: text, diffTruncated: false, outOfScope: ["x"] } });
    expect(body<{ error: { code: string; message: string } }>(await svc.applyReview(rejected.runId, proj.id)).error.code).toBe("run_not_ready");
    expect(readFileSync(path.join(p.dir, "src", "a.ts"), "utf8")).toBe(A);
    expect(scanPatch("diff --git a/x b/x\nnew file mode 120000\n").problems.join(" ")).toContain("link simbólico");
    expect(scanPatch("diff --git a/x b/x\nGIT binary patch\n").problems.join(" ")).toContain("binário");
  });

  it("cliques repetidos e aplicação duplicada: um único registro, nenhuma alteração em dobro; diff já presente é reconhecido sem escrever", async () => {
    const p = makeProject();
    const text = p.diffOf(editA);
    const { runId } = await developerRun(p, text);
    const svc = service();
    const proj = await register(svc, p.dir);
    const rv = await review(svc, runId, proj.id);
    const [a, b] = await Promise.all([apply(svc, runId, proj.id, rv.token, "mesma-chave-123"), apply(svc, runId, proj.id, rv.token, "mesma-chave-123")]);
    const apps = [a, b].map(r => body<{ application: ApplicationRecord; duplicate: boolean }>(r));
    expect(apps[0].application.id).toBe(apps[1].application.id);
    expect(apps.filter(x => x.duplicate)).toHaveLength(1);
    const once = readFileSync(path.join(p.dir, "src", "a.ts"), "utf8");
    expect(once.match(/alterado/g)).toHaveLength(1);
    // A second confirmation with another key (e.g. another tab): nothing is written again.
    const rv2 = await review(svc, runId, proj.id);
    expect(rv2.applyCheck.state).toBe("already_present");
    const again = body<{ application: ApplicationRecord; duplicate: boolean }>(await apply(svc, runId, proj.id, rv2.token));
    expect(again.duplicate).toBe(true);
    expect(again.application.id).toBe(apps[0].application.id);
    expect(readFileSync(path.join(p.dir, "src", "a.ts"), "utf8")).toBe(once);
    // Applied outside the system (e.g. by hand): recorded as already present, still no write.
    const q = makeProject("outro");
    const run2 = await developerRun(q, q.diffOf(editA));
    const proj2 = await register(svc, q.dir);
    editA(q.dir);
    const rv3 = await review(svc, run2.runId, proj2.id);
    expect(rv3.applyCheck.state).toBe("already_present");
    const rec = body<{ application: ApplicationRecord }>(await apply(svc, run2.runId, proj2.id, rv3.token)).application;
    expect(rec.outcome).toBe("already_present");
  });

  it("diff já incorporado ao histórico (commit registrado como entrega, ancestral do HEAD) e arquivo alterado depois: não é tratado como conflito nem reaplicado", async () => {
    const p = makeProject();
    const text = p.diffOf(editA);
    const { runId, planId } = await developerRun(p, text);
    editA(p.dir);
    p.g("commit", "-q", "-am", "entrega aplicada fora do sistema");
    const delivered = p.g("rev-parse", "HEAD");
    await store.recordTaskCompletion({ demandId: "d", parentRunId: planId, taskId: "t2", kind: "applied_run_result", sourceRunId: runId, commit: delivered, files: ["src/a.ts"], verification: { typecheck: null, lint: null, tests: null, build: null }, note: "aplicado fora", validatedBy: "orchestrator", validatedAt: new Date().toISOString() });
    writeFileSync(path.join(p.dir, "src", "a.ts"), readFileSync(path.join(p.dir, "src", "a.ts"), "utf8").replace("export const a = 1;", "export const a = 100; // depois"));
    p.g("commit", "-q", "-am", "mudança posterior no mesmo trecho");
    const svc = service();
    const proj = await register(svc, p.dir);
    const rv = await review(svc, runId, proj.id);
    expect(rv.applyCheck).toMatchObject({ state: "incorporated", incorporatedIn: delivered });
    expect(rv.blockers.join(" ")).toContain("Nada a aplicar");
    expect(rv.blockers.join(" ")).not.toContain("Conflito");
    const before = readFileSync(path.join(p.dir, "src", "a.ts"));
    expect(body<{ error: { code: string } }>(await apply(svc, runId, proj.id, rv.token)).error.code).toBe("blocked");
    expect(readFileSync(path.join(p.dir, "src", "a.ts")).equals(before)).toBe(true);
  });

  it("destino alterado depois da revisão: a confirmação é invalidada e a diferença é mostrada", async () => {
    const p = makeProject();
    const text = p.diffOf(editA);
    const { runId } = await developerRun(p, text);
    const svc = service();
    const proj = await register(svc, p.dir);
    const rv = await review(svc, runId, proj.id);
    writeFileSync(path.join(p.dir, "src", "a.ts"), A + "// mexi depois da revisão\n");
    const r = await apply(svc, runId, proj.id, rv.token);
    expect(r.status).toBe(409);
    const e = body<{ error: { code: string; details: { changes: string[]; review: ApplyReview } } }>(r).error;
    expect(e.code).toBe("target_changed");
    expect(e.details.changes.join(" ")).toContain("src/a.ts: o conteúdo mudou depois da revisão");
    expect(e.details.review.token).not.toBe(rv.token);
    expect(readFileSync(path.join(p.dir, "src", "a.ts"), "utf8")).toBe(A + "// mexi depois da revisão\n");
    // A commit after the review invalidates it too.
    writeFileSync(path.join(p.dir, "src", "a.ts"), A);
    const rv2 = await review(svc, runId, proj.id);
    writeFileSync(path.join(p.dir, "src", "b.ts"), "export const outro = 1;\n");
    p.g("commit", "-q", "-am", "outro commit");
    const e2 = body<{ error: { code: string; details: { changes: string[] } } }>(await apply(svc, runId, proj.id, rv2.token)).error;
    expect(e2.code).toBe("target_changed");
    expect(e2.details.changes.join(" ")).toContain("O commit atual do projeto mudou");
  });

  it("falha depois de escrever: os arquivos afetados voltam exatamente ao estado anterior (inclusive o arquivo que não existia)", async () => {
    const p = makeProject();
    const text = p.diffOf(root => { editA(root); writeFileSync(path.join(root, "src", "novo.ts"), "export const novo = 1;\n"); });
    const { runId } = await developerRun(p, text);
    const svc = service({ applyAfterWrite: async () => { throw new Error("disco cheio (simulado)"); } });
    const proj = await register(svc, p.dir);
    const before = readFileSync(path.join(p.dir, "src", "a.ts"));
    const rv = await review(svc, runId, proj.id);
    const app = body<{ application: ApplicationRecord }>(await apply(svc, runId, proj.id, rv.token)).application;
    expect(app.outcome).toBe("failed_restored");
    expect(app.message).toContain("disco cheio");
    expect(readFileSync(path.join(p.dir, "src", "a.ts")).equals(before)).toBe(true);
    expect(existsSync(path.join(p.dir, "src", "novo.ts"))).toBe(false);
  });

  it("interpreta os erros do git apply como “qual arquivo, por quê”", () => {
    expect(parseApplyErrors("error: patch failed: src/a.ts:2\nerror: src/a.ts: patch does not apply")).toEqual([{ path: "src/a.ts", reason: expect.stringContaining("linha 2") }]);
    expect(parseApplyErrors("error: src/novo.ts: already exists in working directory")[0].reason).toContain("já existe");
  });
});

// ---- isolated verification of an applied delivery: a controlled stand-in for pnpm (no real install) ----
const FAKE_PM = path.join(os.tmpdir(), `ayla-fake-pnpm-${process.pid}.mjs`);
writeFileSync(FAKE_PM, [
  "import { writeFileSync, mkdirSync } from 'node:fs'; import path from 'node:path';",
  "const [cmd, ...rest] = process.argv.slice(2);",
  "if (process.env.FAKE_PID_FILE) writeFileSync(process.env.FAKE_PID_FILE + '.' + (rest[0] || cmd), String(process.pid));",
  "writeFileSync(path.join(process.env.TEMP || process.env.TMPDIR, 'tmp-' + cmd + '.txt'), 'x');",
  "console.log('fake-pnpm', cmd, rest.join(' '), 'cwd=' + process.cwd(), 'AYLA=' + Object.keys(process.env).filter(k => k.startsWith('AYLA_')).join(','), 'CLAUDE_CONFIG_DIR=' + process.env.CLAUDE_CONFIG_DIR);",
  "if (cmd === 'install') { mkdirSync('node_modules', { recursive: true }); process.exit(0); }",
  "const script = rest[0]; if (process.env.FAKE_FAIL === script) { console.error('falhou de propósito'); process.exit(3); }",
  "if (process.env.FAKE_SLOW === script) { setTimeout(() => process.exit(0), 60000); } else process.exit(0);",
].join("\n"));
const fakePm = { ok: true as const, name: "pnpm" as const, command: process.execPath, prefix: [FAKE_PM], detail: "pnpm simulado (teste)" };

async function appliedDelivery(svc: ExecutorService) {
  const p = makeProject();
  writeFileSync(path.join(p.dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  p.g("add", "."); p.g("commit", "-q", "-m", "lock");
  const base = p.g("rev-parse", "HEAD");
  const { runId, planId } = await developerRun({ ...p, base }, p.diffOf(editA));
  const proj = await register(svc, p.dir);
  const rv = await review(svc, runId, proj.id);
  const app = body<{ application: ApplicationRecord }>(await apply(svc, runId, proj.id, rv.token)).application;
  return { p, runId, planId, app };
}

describe("verificação isolada da entrega aplicada (aplicado ≠ verificado)", { timeout: 60_000 }, () => {
  it("todas as verificações passam: registra comandos com diretório, duração, código de saída e log, e só então cria o TaskCompletion vinculado à aplicação e à execução original", async () => {
    process.env.AYLA_SEGREDO_TESTE = "nao-pode-vazar";
    const svc = service({ packageManager: fakePm });
    const { p, runId, planId, app } = await appliedDelivery(svc);
    expect((await store.taskCompletionsForPlan(planId))).toHaveLength(0); // applied, not yet validated
    expect((await svc.verifyApplication(app.id)).status).toBe(202);
    await svc.verificationsIdle();
    const done = (await store.getApplication(app.id))!;
    delete process.env.AYLA_SEGREDO_TESTE;
    expect(done.verification?.status).toBe("passed");
    expect(done.verification?.version).toMatchObject({ kind: "commit_plus_files", applicationId: app.id, treeHash: expect.stringMatching(/^[0-9a-f]{40}$/) });
    const labels = done.verification!.checks.map(c => c.label);
    expect(labels[0]).toContain("Preparação das dependências");
    expect(labels).toEqual(expect.arrayContaining(["Lint", "Testes automatizados", "Build"]));
    for (const c of done.verification!.checks) {
      expect(c.exitCode).toBe(0);
      expect(c.durationMs).toBeGreaterThanOrEqual(0);
      expect(c.cwd).not.toBe(p.dir); // never in the user's checkout
      expect(existsSync(path.join(work, "data", "artifacts", app.id, c.logArtifact!))).toBe(true);
    }
    const log = readFileSync(path.join(work, "data", "artifacts", app.id, done.verification!.checks[1].logArtifact!), "utf8");
    expect(log).toMatch(/AYLA= CLAUDE_CONFIG_DIR=/); // no AYLA_* variable reached the environment
    expect(log).not.toContain("nao-pode-vazar");
    expect(log).toMatch(/CLAUDE_CONFIG_DIR=.*sem-sessao-claude/);
    const c = (await store.taskCompletionsForPlan(planId)) as TaskCompletion[];
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ kind: "applied_run_result", sourceRunId: runId, applicationId: app.id, commit: app.head });
    expect(c[0].verification.tests?.ran).toBe(true);
    expect(readdirSync(path.join(work, "wr")).some(n => n.startsWith("verify-"))).toBe(false); // environment removed
  });

  it("uma verificação que falha fica registrada como falha e NÃO cria entrega validada", async () => {
    process.env.FAKE_FAIL = "test";
    const svc = service({ packageManager: fakePm });
    const { planId, app } = await appliedDelivery(svc);
    await svc.verifyApplication(app.id);
    await svc.verificationsIdle();
    delete process.env.FAKE_FAIL;
    const done = (await store.getApplication(app.id))!;
    expect(done.verification?.status).toBe("failed");
    expect(done.verification?.checks.find(x => x.label === "Testes automatizados")?.exitCode).toBe(3);
    expect(await store.taskCompletionsForPlan(planId)).toHaveLength(0);
  });

  it("cancelar encerra o processo em andamento e registra o cancelamento", async () => {
    const pidFile = path.join(work, "pid");
    process.env.FAKE_SLOW = "test"; process.env.FAKE_PID_FILE = pidFile;
    const svc = service({ packageManager: fakePm });
    const { planId, app } = await appliedDelivery(svc);
    await svc.verifyApplication(app.id);
    for (let i = 0; i < 200 && !existsSync(`${pidFile}.test`); i++) await new Promise(r => setTimeout(r, 50));
    const pid = Number(readFileSync(`${pidFile}.test`, "utf8"));
    expect(body<{ canceled: boolean }>(await svc.cancelVerification(app.id)).canceled).toBe(true);
    await svc.verificationsIdle();
    delete process.env.FAKE_SLOW; delete process.env.FAKE_PID_FILE;
    const done = (await store.getApplication(app.id))!;
    expect(done.verification?.status).toBe("canceled");
    await new Promise(r => setTimeout(r, 500));
    expect(() => process.kill(pid, 0)).toThrow(); // the process started by this verification is gone
    expect(await store.taskCompletionsForPlan(planId)).toHaveLength(0);
  });

  it("sem gerenciador de pacotes utilizável a verificação não finge: registra o motivo concreto", async () => {
    const svc = service({ packageManager: { ok: false, name: "pnpm", detail: "pnpm não encontrado no PATH do executor." } });
    const { app } = await appliedDelivery(svc);
    await svc.verifyApplication(app.id);
    await svc.verificationsIdle();
    const done = (await store.getApplication(app.id))!;
    expect(done.verification).toMatchObject({ status: "error", message: "pnpm não encontrado no PATH do executor." });
  });
});


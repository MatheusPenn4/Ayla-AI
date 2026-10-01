// "Projeto local autorizado" as the source of a demand: Git real em pasta temporária, clientes simulados, nenhum
// modelo e nenhuma chamada ao GitHub (o fetch do GitHub aqui falha o teste se for usado).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ArchitectSnapshot, DirectorSnapshot, RunDetail, SourceContext } from "@/lib/engine/types";
import { SENSITIVE_PATH } from "@/lib/executor/github";
import { redactSecretTokens } from "@/lib/executor/redact";
import { runProcess } from "@/lib/executor/proc";
import { ExecutorService, type ExecutorConfig } from "@/lib/executor/service";
import { sqliteDriver } from "@/lib/executor/sqlite";
import { RunStore } from "@/lib/executor/store";
import { normalizeData } from "@/lib/office/storage";
import { connected, fakeAdapter, goodPlan, member, reply, request } from "./helpers";

let work: string;
let store: RunStore;
beforeEach(() => { work = mkdtempSync(path.join(os.tmpdir(), "ayla-lsrc-")); store = new RunStore(sqliteDriver(":memory:")); });
afterEach(() => { rmSync(work, { recursive: true, force: true, maxRetries: 3 }); });

const ghCalls: string[] = [];
const noGithub = (async (url: string) => { ghCalls.push(String(url)); throw new Error("o GitHub não deve ser consultado numa fonte local"); }) as unknown as typeof fetch;

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const TOKEN = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";

/** A private-looking repo (origin on github.com but never contacted): main with 2 commits, a tag on the first, a feature branch, committed secrets, uncommitted edits. */
function makeProject(root = work) {
  const dir = path.join(root, "privado");
  mkdirSync(dir);
  const g = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", env: ENV }).trim();
  const w = (rel: string, text: string) => { const f = path.join(dir, ...rel.split("/")); mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, text); };
  g("init", "-q", "-b", "main");
  g("config", "core.autocrlf", "false");
  g("remote", "add", "origin", "https://github.com/acme/privado.git");
  w("README.md", "# Privado\nGerador de relatorios financeiros da Acme.\n");
  w("package.json", '{"name":"privado","scripts":{"dev":"node server.js"}}');
  w("src/relatorio.ts", "export const gerarRelatorio = () => 'relatorio-v1';\n");
  w("src/cliente.ts", `export const token = "${TOKEN}";\nexport const apiKey: string = "";\n`);
  w(".env", "DATABASE_URL=postgres://admin:senha@prod.acme.com/db\n");
  w(".npmrc", "//registry.npmjs.org/:_authToken=npm_SEGREDO_DO_REGISTRO\n");
  w("config/credentials.json", '{"password":"hunter2"}');
  w(".env.example", "DATABASE_URL=\n");
  g("add", "-A"); g("commit", "-q", "-m", "primeira versão");
  const c1 = g("rev-parse", "HEAD");
  g("tag", "v1");
  w("README.md", "# Privado\nGerador de relatorios financeiros da Acme (segunda versão).\n");
  g("add", "-A"); g("commit", "-q", "-m", "atualiza o README");
  const c2 = g("rev-parse", "HEAD");
  g("checkout", "-q", "-b", "feature/exportar", c1);
  w("src/exportar.ts", "export const exportar = () => 'csv';\n");
  g("add", "-A"); g("commit", "-q", "-m", "exportar em csv");
  const c3 = g("rev-parse", "HEAD");
  g("checkout", "-q", "main");
  // Uncommitted: must never be read.
  w("src/relatorio.ts", "export const gerarRelatorio = () => 'SO_LOCAL_NAO_COMMITADO';\n");
  w("rascunho.md", "rascunho que nao foi commitado\n");
  return { dir, c1, c2, c3, status: () => g("status", "--porcelain"), headFile: () => execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim() };
}

const cfg = (): ExecutorConfig => ({ version: "t", dataDir: work, storePath: ":memory:", workRoot: path.join(work, "wr"), limits: { maxRunsPerHour: 50, maxConcurrentRuns: 1, callTimeoutMs: 5000, leaseMs: 60000, statusCacheMs: 0 }, github: { fetch: noGithub } });
function service(steps: Parameters<typeof fakeAdapter>[0] = []) {
  const a = fakeAdapter(steps);
  const svc = new ExecutorService(cfg(), {
    store, runner: runProcess, env: process.env,
    detectors: { claude_code: async () => connected("claude_code"), codex: async () => connected("codex") },
    adapters: { claude_code: a.adapter, codex: a.adapter },
  });
  return { svc, calls: a.calls };
}
const body = <T,>(r: { body: unknown }) => r.body as T;
async function register(svc: ExecutorService, dir: string) {
  const r = await svc.registerProject({ dir, label: "Relatórios (privado)" });
  expect(r.status).toBe(201);
  return body<{ project: { id: string } }>(r).project.id;
}

const planWithArchitect = () => goodPlan({
  steps: [{ id: "s1", title: "Desenho", owner: "architect", depends_on: [], done_when: "Proposta" }],
  tasks: [{ id: "t1", step_id: "s1", assignee: "architect", title: "Definir o relatório", scope: "Ler src/relatorio.ts", inputs: "Demanda", deliverable: "Proposta técnica", acceptance_criteria: ["Arquivos afetados listados"], depends_on: [] }],
  flow: { type: "short", rationale: "x", skipped_roles: [] }, risks: [], assumptions: [], not_verified: [],
});

function localRequest(projectId: string, ref: string, commit: string, over: Record<string, unknown> = {}) {
  const r = request({}, { source: "local", local: { projectId, ref, commit }, title: "Gerar relatório", description: "Corrigir o relatorio financeiro" } as never);
  r.team = [member("director", { handoffTo: ["architect"] }), member("architect")];
  return { ...r, ...over };
}

describe("referências e resolução do SHA (antes de planejar)", { timeout: 60_000 }, () => {
  it("lista branches e tags do projeto pelo identificador e mostra o HEAD", async () => {
    const p = makeProject();
    const { svc } = service();
    const id = await register(svc, p.dir);
    const r = body<{ head: { sha: string; branch: string }; refs: { name: string; kind: string; sha: string }[] }>(await svc.projectRefs(id));
    expect(r.head).toMatchObject({ sha: p.c2, branch: "main" });
    expect(r.refs.find(x => x.name === "main")).toMatchObject({ kind: "branch", sha: p.c2 });
    expect(r.refs.find(x => x.name === "feature/exportar")).toMatchObject({ kind: "branch", sha: p.c3 });
    expect(r.refs.find(x => x.name === "v1")).toMatchObject({ kind: "tag", sha: p.c1 });
  });

  it("resolve branch, tag, SHA curto e HEAD para o SHA completo, informando o que fica fora (alterações não commitadas)", async () => {
    const p = makeProject();
    const { svc } = service();
    const id = await register(svc, p.dir);
    const src = async (ref: string) => body<{ source: { commit: string; refKind: string; ref: string; subject: string; dirty: { count: number; paths: string[] } | null; head: { sha: string } } }>(await svc.resolveSource(id, ref, null)).source;
    expect((await src("")).commit).toBe(p.c2);
    expect((await src("")).refKind).toBe("head");
    expect(await src("v1")).toMatchObject({ commit: p.c1, refKind: "tag", subject: "primeira versão" });
    expect(await src("feature/exportar")).toMatchObject({ commit: p.c3, refKind: "branch" });
    expect(await src(p.c1.slice(0, 9))).toMatchObject({ commit: p.c1, refKind: "commit" });
    expect((await src("main~1")).commit).toBe(p.c1);
    const s = await src("main");
    expect(s.dirty?.count).toBe(2);
    expect(s.dirty?.paths.sort()).toEqual(["rascunho.md", "src/relatorio.ts"]);
    expect(s.head.sha).toBe(p.c2);
  });

  it("referência inexistente ou inválida dá erro claro; um caminho nunca vale como projeto", async () => {
    const p = makeProject();
    const { svc } = service();
    const id = await register(svc, p.dir);
    const missing = await svc.resolveSource(id, "nao-existe", null);
    expect(missing.status).toBe(404);
    expect(body<{ error: { code: string; message: string } }>(missing).error).toMatchObject({ code: "ref_not_found" });
    expect(body<{ error: { message: string } }>(missing).error.message).toMatch(/“nao-existe” não existe no projeto/);
    expect(body<{ error: { message: string } }>(missing).error.message).toContain("main");
    for (const bad of ["--upload-pack=calc", "a..b", "x y", "main:arquivo", "../fora"]) {
      const r = await svc.resolveSource(id, bad, null);
      expect(r.status, bad).toBe(400);
      expect(body<{ error: { code: string } }>(r).error.code).toBe("invalid_ref");
    }
    expect(body<{ error: { code: string } }>(await svc.resolveSource("00000000-aaaa", "", null)).error.code).toBe("project_not_found");
    expect(body<{ error: { code: string } }>(await svc.resolveSource(p.dir, "", null)).error.code).toBe("project_not_found");
    expect(body<{ error: { code: string } }>(await svc.resolveSource(id, "", "f".repeat(40))).error.code).toBe("commit_not_found");
  });
});

describe("contexto lido do commit (o que o Diretor recebe)", { timeout: 60_000 }, () => {
  it("lê objetos do commit: sem alterações não commitadas, sem GitHub, com arquivos pessoais e credenciais retidos", async () => {
    const p = makeProject();
    const { svc } = service();
    const id = await register(svc, p.dir);
    const before = p.status();
    const r = await svc.contextPreview(id, { ref: "main", commit: p.c2, title: "Gerar relatório", description: "Corrigir o relatorio financeiro" });
    expect(r.status).toBe(200);
    const { context, text, textSha256, source } = body<{ context: Extract<SourceContext, { kind: "github" }>; text: string; textSha256: string; source: { commit: string } }>(r);
    expect(source.commit).toBe(p.c2);
    expect(context).toMatchObject({ via: "local_git", visibility: "local", commit: p.c2, owner: "acme", repo: "privado", local: { projectLabel: "Relatórios (privado)", ref: "main", dirName: "privado" } });
    const paths = context.files.map(f => f.path);
    expect(paths).toEqual(expect.arrayContaining(["README.md", "package.json", "src/relatorio.ts"]));
    // Only committed objects: the working-tree edit and the untracked draft are out — and reported as out.
    expect(text).toContain("relatorio-v1");
    expect(text).not.toContain("SO_LOCAL_NAO_COMMITADO");
    expect(text).not.toContain("rascunho");
    expect(context.local?.dirty).toMatchObject({ count: 2 });
    // Personal configuration and credentials are withheld (listed only as a count), never read.
    for (const secret of [".env", ".npmrc", "config/credentials.json"]) {
      expect(paths).not.toContain(secret);
      expect(context.structureSample).not.toContain(secret);
    }
    expect(text).not.toMatch(/postgres:\/\/admin|npm_SEGREDO|hunter2/);
    expect(context.withheld?.count).toBe(3);
    expect(paths).not.toContain(".env.example"); // templates are allowed but the Director's selection did not need it
    // Unmistakable tokens inside a source file are masked in the text (the hash stays that of the original).
    const cliente = await svc.contextPreview(id, { ref: "main", commit: p.c2, title: "cliente token", description: "ajustar o cliente" });
    const c = body<{ context: Extract<SourceContext, { kind: "github" }>; text: string }>(cliente);
    if (c.context.files.some(f => f.path === "src/cliente.ts")) {
      expect(c.text).not.toContain(TOKEN);
      expect(c.context.files.find(f => f.path === "src/cliente.ts")?.redactions).toBe(1);
    }
    expect(textSha256).toBe(createHash("sha256").update(text).digest("hex"));
    expect(ghCalls).toEqual([]);
    expect(p.status()).toBe(before); // nothing in the project changed
    expect(p.headFile()).toBe(p.c2);
  });

  it("lê o commit pedido, não o HEAD: a tag v1 mostra o README antigo", async () => {
    const p = makeProject();
    const { svc } = service();
    const id = await register(svc, p.dir);
    const old = body<{ text: string }>(await svc.contextPreview(id, { ref: "v1", commit: p.c1, title: "t", description: "d" })).text;
    const now = body<{ text: string }>(await svc.contextPreview(id, { ref: "main", commit: p.c2, title: "t", description: "d" })).text;
    expect(old).toContain("Gerador de relatorios financeiros da Acme.");
    expect(old).not.toContain("segunda versão");
    expect(now).toContain("segunda versão");
  });

  it("regras de proteção de caminhos e de credenciais", () => {
    for (const p of [".env", "api/.env.local", ".npmrc", "x/.git-credentials", ".ssh/id_rsa", "chave.pem", "config/credentials.json", "secrets.yaml", ".dev.vars", "infra/terraform.tfstate", "a/service-account-prod.json"]) expect(SENSITIVE_PATH.test(p), p).toBe(true);
    for (const p of [".env.example", ".env.sample", "src/secrets.ts", "src/credentials.tsx", "lib/executor/secret-store.ts", "docs/env.md", "src/environment.ts"]) expect(SENSITIVE_PATH.test(p), p).toBe(false);
    expect(redactSecretTokens(`a ${TOKEN} b`)).toEqual({ text: "a [REDACTED] b", count: 1 });
    expect(redactSecretTokens("apiKey: string").count).toBe(0);
  });
});

describe("planejamento do Diretor com projeto local (cliente simulado)", { timeout: 60_000 }, () => {
  it("registra projeto, referência e SHA; o modelo recebe só o commit; o que foi mostrado é o que foi lido", async () => {
    const p = makeProject();
    const { svc, calls } = service([reply(planWithArchitect())]);
    const id = await register(svc, p.dir);
    const preview = body<{ context: Extract<SourceContext, { kind: "github" }>; textSha256: string }>(await svc.contextPreview(id, { ref: "main", commit: p.c2, title: "Gerar relatório", description: "Corrigir o relatorio financeiro" }));
    const started = await svc.start(localRequest(id, "main", p.c2));
    expect(started.status).toBe(202);
    await svc.idle();
    const run = body<{ run: { id: string } }>(started).run;
    const detail = (await store.detail(run.id))! as RunDetail;
    expect(detail.status).toBe("plan_ready");
    const snap = detail.snapshot as DirectorSnapshot;
    expect(snap.demand).toMatchObject({ source: "local", local: { projectId: id, ref: "main", commit: p.c2, projectLabel: "Relatórios (privado)", owner: "acme", repo: "privado", subject: "atualiza o README" }, repo: { owner: "acme", repo: "privado" } });
    const ctx = detail.context as Extract<SourceContext, { kind: "github" }>;
    expect(ctx).toMatchObject({ via: "local_git", commit: p.c2, local: { projectId: id, ref: "main" } });
    // Same function for the review and for the run: same files, same text hash.
    expect(ctx.files.map(f => f.path)).toEqual(preview.context.files.map(f => f.path));
    expect(ctx.local?.textSha256).toBe(preview.textSha256);
    const sent = calls[0].user;
    expect(sent).toContain("Projeto local autorizado acme/privado");
    expect(sent).toContain("relatorio-v1");
    expect(sent).not.toContain("SO_LOCAL_NAO_COMMITADO");
    expect(sent).not.toContain(p.dir); // the model never sees the user's folder path
    expect(sent).toContain("2 alteração(ões) local(is) não commitada(s) NÃO fazem parte do contexto");
    expect(detail.events.map(e => e.kind)).toEqual(expect.arrayContaining(["local_source", "local_done"]));
    expect(detail.result?.limitations.join(" ")).toMatch(/2 alteração\(ões\) local\(is\) não commitada\(s\) ficaram FORA do contexto/);
    expect(ghCalls).toEqual([]);
  });

  it("o SHA mostrado ao usuário vale mesmo se o branch andar depois; a mudança é só informada", async () => {
    const p = makeProject();
    const { svc } = service([reply(planWithArchitect())]);
    const id = await register(svc, p.dir);
    // The user reviewed feature/exportar at c3... then the branch moved to c1's descendant elsewhere.
    execFileSync("git", ["-C", p.dir, "branch", "-f", "feature/exportar", p.c2], { env: ENV });
    const started = await svc.start(localRequest(id, "feature/exportar", p.c3));
    await svc.idle();
    const detail = (await store.detail(body<{ run: { id: string } }>(started).run.id))!;
    const ctx = detail.context as Extract<SourceContext, { kind: "github" }>;
    expect(ctx.commit).toBe(p.c3);
    expect(ctx.local?.refNow).toBe(p.c2);
    // The tree that was read is c3's (feature branch), not the current position of the branch nor main's.
    expect(ctx.structureSample).toContain("src/exportar.ts");
  });

  it("recusas claras: projeto removido, commit inexistente, sem permissão de leitura, caminho no lugar do id", async () => {
    const p = makeProject();
    const { svc } = service([reply(planWithArchitect())]);
    const id = await register(svc, p.dir);
    const err = async (r: { status: number; body: unknown }) => body<{ error: { code: string; message: string } }>(r).error;
    expect(await err(await svc.start(localRequest(id, "main", "e".repeat(40))))).toMatchObject({ code: "commit_not_found" });
    expect(await err(await svc.start(localRequest(p.dir, "main", p.c2)))).toMatchObject({ code: "invalid_request" }); // a path is not a project id
    expect(await err(await svc.start(localRequest("11111111-2222", "main", p.c2)))).toMatchObject({ code: "project_not_found" });
    expect(await err(await svc.start(localRequest(id, "main", "curto")))).toMatchObject({ code: "invalid_request" });
    // Reading switched off in the Director's sheet.
    const noRead = localRequest(id, "main", p.c2, { team: [member("director", { handoffTo: ["architect"], tools: { read: false } }), member("architect")] });
    const started = await svc.start(noRead);
    await svc.idle();
    const failed = (await store.get(body<{ run: { id: string } }>(started).run.id))!;
    expect(failed).toMatchObject({ status: "failed", error: { code: "local_not_permitted" } });
    // The project is removed after the demand was prepared: planning fails with the reason, nothing is read.
    await svc.removeProject(id);
    expect(await err(await svc.start(localRequest(id, "main", p.c2, { demand: { ...localRequest(id, "main", p.c2).demand, id: "d2" } })))).toMatchObject({ code: "project_not_found" });
  });
});

describe("encaminhamentos mantêm o mesmo commit, salvo mudança revisada", { timeout: 60_000 }, () => {
  it("Arquiteto lê o mesmo projeto e o mesmo SHA; trocar de commit exige motivo e fica registrado", async () => {
    const p = makeProject();
    const { svc } = service([reply(planWithArchitect())]);
    const id = await register(svc, p.dir);
    const started = await svc.start(localRequest(id, "v1", p.c1));
    await svc.idle();
    const planId = body<{ run: { id: string } }>(started).run.id;
    expect((await store.get(planId))!.status).toBe("plan_ready");
    const handoff = (over = {}) => ({ idempotencyKey: `h:${Math.random().toString(36).slice(2, 12)}`, directorRunId: planId, taskId: "t1", agent: member("architect", { budget: 24000 }), ...over });
    const opts = body<{ directorCommit: string; proposed: { via: string; commit: string }; localRepos: { dirName: string }[] }>(await svc.sourceOptions(planId, "t1"));
    expect(opts).toMatchObject({ directorCommit: p.c1, proposed: { via: "local_git", commit: p.c1 } });
    expect(opts.localRepos[0].dirName).toBe("privado");
    const first = await svc.prepare(handoff());
    expect(first.status).toBe(201);
    const run = body<{ run: RunDetail }>(first).run;
    expect(run.context).toMatchObject({ kind: "github", via: "local_git", commit: p.c1 });
    expect((run.snapshot as ArchitectSnapshot).revision).toMatchObject({ commit: p.c1, via: "local_git", changedCommit: false });
    expect(run.prompt?.user).toContain("relatorio-v1");
    expect(run.prompt?.user).not.toContain("SO_LOCAL_NAO_COMMITADO");
    // A different commit is a revision: refused without a reason, recorded with one.
    await svc.cancel(run.id);
    const other = (extra = {}) => handoff({ previousRunId: run.id, source: { via: "local_git", commit: p.c2 }, ...extra });
    expect(body<{ error: { code: string } }>(await svc.prepare(other())).error.code).toBe("revision_reason_required");
    const revised = body<{ run: RunDetail }>(await svc.prepare(other({ revisionReason: "Usar a segunda versão do README." }))).run;
    expect((revised.snapshot as ArchitectSnapshot).revision).toMatchObject({ commit: p.c2, previousCommit: p.c1, changedCommit: true, reason: "Usar a segunda versão do README." });
    expect(ghCalls).toEqual([]);
  });
});

describe("compatibilidade", () => {
  it("demandas antigas (GitHub, pasta, sem fonte) continuam válidas; fonte local sem dados é descartada", () => {
    const old = { id: "a", title: "x", description: "", acceptanceCriteria: [], project: "", priority: "normal", recipient: "director", source: "github", sourceLabel: "https://github.com/o/r", fileCount: 0, status: "prepared", createdAt: "2026-01-01T00:00:00Z" };
    const d = normalizeData({ agents: [], demands: [old, { ...old, id: "b", source: "none" }, { ...old, id: "c", source: "local" }, { ...old, id: "e", source: "local", local: { projectId: "p1", projectLabel: "P", owner: "o", repo: "r", ref: "main", commit: "a".repeat(40), subject: "s", resolvedAt: "x" } }] }).demands;
    expect(d.find(x => x.id === "a")).toMatchObject({ source: "github", repo: { owner: "o", repo: "r" } });
    expect(d.find(x => x.id === "c")?.source).toBe("none");
    expect(d.find(x => x.id === "e")).toMatchObject({ source: "local", local: { projectId: "p1", commit: "a".repeat(40) } });
  });
});

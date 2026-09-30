// Per-project execution settings: command validation (no shell), detection of package managers/folders,
// protected test variables, "não configurado" never counted as passing, and a REAL npm project in a subfolder
// verified end to end (no model is called anywhere here).
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApplicationRecord, DeveloperDiff, LocalProject } from "@/lib/engine/types";
import { detectProject, externalHosts, parseCommandLine, withTestFiles } from "@/lib/executor/project-config";
import { runProcess } from "@/lib/executor/proc";
import { resolveTool } from "@/lib/executor/qa-env";
import { buildNewRun, parseStartRequest } from "@/lib/executor/runs-service";
import { ExecutorService } from "@/lib/executor/service";
import { sqliteDriver } from "@/lib/executor/sqlite";
import { RunStore } from "@/lib/executor/store";
import { connected, goodPlan, member, request } from "./helpers";

let work: string;
let store: RunStore;
beforeEach(() => { work = mkdtempSync(path.join(os.tmpdir(), "ayla-pcfg-")); store = new RunStore(sqliteDriver(":memory:")); });
afterEach(() => { rmSync(work, { recursive: true, force: true, maxRetries: 3 }); });

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const w = (root: string, rel: string, text: string) => { const f = path.join(root, ...rel.split("/")); mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, text); };

describe("linha de comando sem shell", () => {
  const npm = { manager: "npm" as const };
  it("aceita comandos do gerenciador do projeto, npx e node; {port} só no servidor", () => {
    expect(parseCommandLine("npm run dev -- --port {port}", { ...npm, allowPort: true })).toEqual({ ok: true, argv: ["npm", "run", "dev", "--", "--port", "{port}"] });
    expect(parseCommandLine('node --test "test/a b.test.mjs"', npm)).toEqual({ ok: true, argv: ["node", "--test", "test/a b.test.mjs"] });
    expect(parseCommandLine("npx tsc --noEmit", npm).ok).toBe(true);
    expect(parseCommandLine("pnpm exec tsc --noEmit", { manager: "pnpm" }).ok).toBe(true);
  });
  it("recusa shell, outro gerenciador, caminhos fora da cópia e aspas abertas", () => {
    const err = (t: string, o: Parameters<typeof parseCommandLine>[1] = npm) => { const r = parseCommandLine(t, o); return r.ok ? "" : r.error; };
    expect(err("npm test | tee saida.txt")).toContain("sem shell");
    expect(err("npm ci && npm test")).toContain("sem shell");
    expect(err("npm test > log.txt")).toContain("sem shell");
    expect(err("yarn test")).toContain("deve começar com");
    expect(err("pnpm test")).toContain("deve começar com"); // npm project: its lockfile's manager only
    expect(err("npx tsc", { manager: "pnpm" })).toContain("deve começar com");
    expect(err("node C:\\Users\\voce\\script.js")).toContain("absolutos");
    expect(err("node ../fora.js")).toContain("absolutos");
    expect(err("node --require=/etc/x.js a.js")).toContain("absolutos");
    expect(err("npm run dev -- --port {port}")).toContain("{port}");
    expect(err('npm run "dev')).toContain("aspas");
    expect(err("npm run $(whoami)")).toContain("substituição");
  });
  it("arquivos de teste pedidos pelo QA: npm precisa de -- para repassá-los ao script", () => {
    expect(withTestFiles(["npm", "test"], ["t/a.test.mjs"])).toEqual(["npm", "test", "--", "t/a.test.mjs"]);
    expect(withTestFiles(["npm", "run", "test", "--", "--x"], ["t/a.test.mjs"])).toEqual(["npm", "run", "test", "--", "--x", "t/a.test.mjs"]);
    expect(withTestFiles(["pnpm", "run", "test"], ["t/a.test.mjs"])).toEqual(["pnpm", "run", "test", "t/a.test.mjs"]);
  });
  it("valores que apontam para fora deste computador", () => {
    expect(externalHosts("postgres://app:senha@db.producao.exemplo.com:5432/app")).toEqual(["db.producao.exemplo.com"]);
    expect(externalHosts("http://localhost:3000/api e http://127.0.0.1:5432")).toEqual([]);
    expect(externalHosts("valor-simples")).toEqual([]);
  });
});

describe("detecção de gerenciador, subpastas e o que não é suportado", () => {
  it("npm numa subpasta: sugere a subpasta, os scripts existentes e deixa o resto como não configurado", () => {
    const root = path.join(work, "r");
    w(root, "README.md", "x");
    w(root, "front/package.json", JSON.stringify({ scripts: { dev: "vite", build: "vite build", test: "echo \"Error: no test specified\" && exit 1" }, devDependencies: { vite: "1", typescript: "5" } }));
    w(root, "front/package-lock.json", "{}");
    w(root, "front/tsconfig.json", "{}");
    w(root, "api/package.json", JSON.stringify({ scripts: { start: "node x.js" } }));
    w(root, "api/yarn.lock", "");
    w(root, "requirements.txt", "flask");
    const d = detectProject(root);
    expect(d.chosen).toBe("front");
    expect(d.suggestion).toMatchObject({ workDir: "front", packageManager: "npm", commands: { install: "npm ci", typecheck: "npx tsc --noEmit", lint: "", test: "", build: "npm run build", dev: "npm run dev -- --port {port}" }, browserData: "app" });
    expect(d.notes.join(" ")).toContain("no test specified");
    expect(d.unsupported.join(" ")).toMatch(/api\/yarn\.lock \(yarn\).*Python/);
    expect(detectProject(root, "api").suggestion).toBeNull(); // yarn: not supported, never guessed
    expect(detectProject(root, "api").manager.detail).toContain("não é suportado");
  });
  it("sem lockfile não há sugestão (a instalação não seria reproduzível)", () => {
    const root = path.join(work, "s");
    w(root, "package.json", JSON.stringify({ scripts: { test: "node --test" } }));
    const d = detectProject(root);
    expect(d.suggestion).toBeNull();
    expect(d.manager.detail).toContain("Sem lockfile");
  });
});

// ---- service: saving, protected variables, and a real npm project verified end to end ----------------------

/** A tiny npm app in "app/" (no dependencies: npm ci works offline) whose test reads a configured variable. */
function npmProject() {
  const dir = path.join(work, "proj");
  w(dir, "README.md", "raiz\n");
  w(dir, "app/package.json", JSON.stringify({ name: "p", version: "1.0.0", type: "module", scripts: { test: "node --test", build: "node build.mjs", dev: "node server.mjs" } }));
  w(dir, "app/package-lock.json", JSON.stringify({ name: "p", version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "p", version: "1.0.0" } } }));
  w(dir, "app/build.mjs", "console.log('build ok');\n");
  w(dir, "app/server.mjs", "import http from 'node:http'; http.createServer((q, r) => r.end('ok')).listen(Number(process.env.PORT));\n");
  w(dir, "app/v.mjs", "export const v = 1;\n");
  w(dir, "app/v.test.mjs", [
    "import { test } from 'node:test'; import assert from 'node:assert/strict'; import os from 'node:os'; import { v } from './v.mjs';",
    "test('versão', () => assert.equal(v, 2));",
    // The configured variable arrives; personal folders and credentials do not.
    "test('ambiente de teste', () => { assert.equal(process.env.CHAVE_TESTE, 'valor-secreto-123'); console.log('valor visto: ' + process.env.CHAVE_TESTE); assert.match(os.homedir(), /home$/); assert.equal(process.env.AYLA_SEGREDO_CFG, undefined); });",
  ].join("\n"));
  const g = (...a: string[]) => execFileSync("git", ["-C", dir, "-c", "core.autocrlf=false", ...a], { encoding: "utf8", env: gitEnv }).trim();
  g("init", "-q", "-b", "main"); g("remote", "add", "origin", "https://github.com/o/r.git"); g("add", "."); g("commit", "-q", "-m", "base");
  return { dir, base: g("rev-parse", "HEAD"), g };
}

function service() {
  return new ExecutorService({ version: "t", dataDir: path.join(work, "data"), storePath: ":memory:", workRoot: path.join(work, "wr"), limits: { maxRunsPerHour: 50, maxConcurrentRuns: 1, callTimeoutMs: 1000, leaseMs: 60000, statusCacheMs: 0 }, github: {} }, {
    store, runner: runProcess, env: process.env,
    detectors: { claude_code: async () => connected("claude_code"), codex: async () => connected("codex") },
    adapters: { claude_code: { id: "claude_code", call: async () => { throw new Error("nenhum modelo é chamado aqui"); } }, codex: null },
  });
}
const body = <T,>(r: { body: unknown }) => r.body as T;

const npmAvailable = resolveTool("npm", { git: { runner: runProcess, env: process.env }, spawnBg: () => { throw new Error("x"); }, nodePath: process.execPath }).ok;

describe("configuração salva pelo usuário no executor", { timeout: 60_000 }, () => {
  it("exige a confirmação de que os comandos executam código do projeto; valida pasta e comandos; recusa endereço externo sem autorização explícita", async () => {
    const p = npmProject();
    const svc = service();
    const proj = body<{ project: LocalProject }>(await svc.registerProject({ dir: p.dir })).project;
    const d = body<{ detection: { chosen: string; suggestion: Record<string, unknown> } }>(await svc.projectConfig(proj.id)).detection;
    expect(d.chosen).toBe("app");
    const cfg: Record<string, unknown> = { ...d.suggestion, env: [{ name: "CHAVE_TESTE", value: "valor-secreto-123", external: false }] };
    expect(body<{ error: { code: string } }>(await svc.saveProjectConfig(proj.id, { config: cfg })).error.code).toBe("acknowledgement_required");
    const bad = await svc.saveProjectConfig(proj.id, { config: { ...cfg, workDir: "../fora", commands: { ...(cfg.commands as object), test: "npm test && rm -rf ." }, env: [{ name: "DATABASE_URL", value: "postgres://u:p@db.producao.exemplo.com/app", external: false }, { name: "PATH", value: "x", external: false }] }, acknowledgeCodeExecution: true });
    const errors = body<{ error: { details: string[] } }>(bad).error.details.join(" | ");
    expect(errors).toContain("Diretório de execução");
    expect(errors).toContain("sem shell");
    expect(errors).toContain("aponta para fora deste computador");
    expect(errors).toContain("PATH: nome reservado");
    const ok = await svc.saveProjectConfig(proj.id, { config: cfg, acknowledgeCodeExecution: true });
    expect(ok.status).toBe(200);
    // The value never comes back: not in the list, not in the settings, not in the status.
    for (const r of [await svc.listProjects(), await svc.projectConfig(proj.id), { body: await svc.status() }]) expect(JSON.stringify(r.body)).not.toContain("valor-secreto-123");
    expect(body<{ config: { env: unknown[] } }>(await svc.projectConfig(proj.id)).config.env).toEqual([{ name: "CHAVE_TESTE", set: true, external: false }]);
    // Saving again without a value keeps the stored one; an external test database needs the explicit flag.
    expect((await svc.saveProjectConfig(proj.id, { config: { ...cfg, env: [{ name: "CHAVE_TESTE", external: false }] }, acknowledgeCodeExecution: true })).status).toBe(200);
    expect((await svc.saveProjectConfig(proj.id, { config: { ...cfg, env: [{ name: "CHAVE_TESTE", external: false }, { name: "DB_TESTE", value: "postgres://u:p@teste.exemplo.com/db", external: true }] }, acknowledgeCodeExecution: true })).status).toBe(200);
    const raw = JSON.stringify(await store.getProjectConfig(proj.id));
    expect(raw).not.toContain("valor-secreto-123"); // encrypted at rest
  });

  it.skipIf(!npmAvailable)("projeto npm numa subpasta, de ponta a ponta: aplica, verifica com npm de verdade, variável protegida chega ao teste e não aos logs, e nada não configurado conta como aprovado", async () => {
    process.env.AYLA_SEGREDO_CFG = "nao-pode-vazar";
    const p = npmProject();
    const svc = service();
    const proj = body<{ project: LocalProject }>(await svc.registerProject({ dir: p.dir })).project;
    const d = body<{ detection: { suggestion: Record<string, unknown> } }>(await svc.projectConfig(proj.id)).detection;
    expect((await svc.saveProjectConfig(proj.id, { config: { ...d.suggestion, env: [{ name: "CHAVE_TESTE", value: "valor-secreto-123", external: false }] }, acknowledgeCodeExecution: true })).status).toBe(200);
    // A Developer delivery (v = 2), then review + apply through the same service calls as the interface.
    const diffText = "diff --git a/app/v.mjs b/app/v.mjs\n--- a/app/v.mjs\n+++ b/app/v.mjs\n@@ -1 +1 @@\n-export const v = 1;\n+export const v = 2;\n";
    const parsed = parseStartRequest(request({}, { source: "github", repo: { url: "https://github.com/o/r", owner: "o", repo: "r", branch: "main" } }));
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    parsed.value.team = [member("director", { handoffTo: ["developer"] }), member("developer")];
    const { run: plan } = await store.create(buildNewRun(parsed.value));
    await store.claim(plan.id, 60000);
    await store.update(plan.id, { status: "plan_ready", finishedAt: new Date().toISOString(), result: { ...goodPlan({ tasks: [{ id: "t2", step_id: "s1", assignee: "developer", title: "Implementar", scope: "x", inputs: "x", deliverable: "diff", acceptance_criteria: ["ok"], depends_on: [] }] }), limitations: [] } });
    const sha = (await import("node:crypto")).createHash("sha256").update(diffText).digest("hex");
    const diff: DeveloperDiff = { baseCommit: p.base, files: [{ path: "app/v.mjs", status: "modified", additions: 1, deletions: 1, inScope: true }], diffText, diffTruncated: false, outOfScope: [], diffSha256: sha };
    const { run } = await store.create({ id: crypto.randomUUID(), kind: "developer_task", demandId: plan.demandId, agentId: "developer", idempotencyKey: `dev:${Math.random()}`, connection: "claude_code", model: "", effort: "", snapshotHash: "h", snapshot: { kind: "developer_task", base: { owner: "o", repo: "r", commit: p.base, dirName: "proj", treeEntries: 3, sampleFiles: [] }, editScope: [{ path: "app/v.mjs", action: "alterar", from: ["t"] }] } as never, budget: { sheetTokens: 0, estimatedInputTokens: 0, calls: [], reportedTotalTokens: null, exceeded: false }, previousRunId: null, parentRunId: plan.id, taskId: "t2", initialStatus: "awaiting_approval" });
    await store.approve(run.id); await store.claim(run.id, 60000);
    await store.update(run.id, { status: "implementation_ready", finishedAt: new Date().toISOString(), result: { outcome: "done", summary: "s", changes: [], acceptance: [], questions: [], not_verified: [], assumptions: [], limitations: [], diff } as never });
    const review = body<{ review: { token: string; blockers: string[] } }>(await svc.applyReview(run.id, proj.id)).review;
    expect(review.blockers).toEqual([]);
    const app = body<{ application: ApplicationRecord }>(await svc.applyDiff({ runId: run.id, projectId: proj.id, reviewToken: review.token, idempotencyKey: "k:npm-e2e-1", acknowledgeLocalChanges: true })).application;
    expect(app.outcome).toBe("applied");
    expect(readFileSync(path.join(p.dir, "app", "v.mjs"), "utf8")).toContain("v = 2");
    await svc.verifyApplication(app.id);
    await svc.verificationsIdle();
    delete process.env.AYLA_SEGREDO_CFG;
    const v = (await store.getApplication(app.id))!.verification!;
    expect(v.status, v.message).toBe("passed");
    expect(v.checks.map(c => c.command)).toEqual(["npm ci --offline", "npm test", "npm run build"]);
    for (const c of v.checks) expect(c.cwd.replace(/\\/g, "/")).toMatch(/verify-.*\/src\/app$/); // the configured package folder of the isolated copy
    expect(v.notConfigured).toEqual(["Tipos", "Lint"]);
    expect(v.message).toContain("Não configurado (não conta como aprovado): Tipos, Lint");
    const logs = readdirSync(path.join(work, "data", "artifacts", app.id)).map(f => readFileSync(path.join(work, "data", "artifacts", app.id, f), "utf8")).join("\n");
    expect(logs).toContain("valor visto: [valor de variável configurada omitido]");
    expect(logs).not.toContain("valor-secreto-123");
    expect(logs).not.toContain("nao-pode-vazar");
    const c = await store.taskCompletionsForPlan(plan.id);
    expect(c).toHaveLength(1);
    expect(c[0].verification).toMatchObject({ typecheck: null, lint: null, tests: { ran: true } });
  });

  it("sem configuração confirmada nada é executado; sem nenhuma verificação configurada nada é aprovado", async () => {
    const p = npmProject();
    const svc = service();
    const proj = body<{ project: LocalProject }>(await svc.registerProject({ dir: p.dir })).project;
    const st = await svc.status();
    expect(st.qaTooling?.operations.find(o => o.id === "commands")).toMatchObject({ available: false, how: expect.stringContaining("configuração de execução") });
    const d = body<{ detection: { suggestion: Record<string, unknown> } }>(await svc.projectConfig(proj.id)).detection;
    const none = { ...d.suggestion, commands: { install: "npm ci", typecheck: "", lint: "", test: "", build: "", dev: "", seed: "" } };
    expect((await svc.saveProjectConfig(proj.id, { config: none, acknowledgeCodeExecution: true })).status).toBe(200);
    const st2 = await svc.status();
    expect(st2.qaTooling?.operations.find(o => o.id === "commands")).toMatchObject({ available: false, how: expect.stringContaining("nenhuma verificação") });
    expect(st2.qaTooling?.operations.find(o => o.id === "browser")).toMatchObject({ available: false, how: expect.stringContaining("servidor de desenvolvimento configurado") });
  });
});

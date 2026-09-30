// Tool-equipped QA: the model asks for operations, the EXECUTOR runs them in an isolated environment of the
// exact version and returns numbered evidence. Model calls are scripted (fakeAdapter); git, the environment,
// commands (a controlled pnpm stand-in) and — when installed — the real browser are exercised for real.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateToolQAResult } from "@/lib/engine/qa-tooled-schema";
import type { DeveloperDiff, QASnapshot, RunDetail } from "@/lib/engine/types";
import type { AgentCall } from "@/lib/executor/adapters/types";
import { compareTexts, findBrowser, loadPlaywright, runScenario, type BrowserStep } from "@/lib/executor/qa-browser";
import { runProcess } from "@/lib/executor/proc";
import { buildNewRun, parseStartRequest } from "@/lib/executor/runs-service";
import { ExecutorService, type ServiceDeps } from "@/lib/executor/service";
import { sqliteDriver } from "@/lib/executor/sqlite";
import { RunStore } from "@/lib/executor/store";
import { connected, fakeAdapter, goodPlan, member, reply, request } from "./helpers";

let work: string;
let store: RunStore;
beforeEach(() => { work = mkdtempSync(path.join(os.tmpdir(), "ayla-qat-")); store = new RunStore(sqliteDriver(":memory:")); });
afterEach(() => { rmSync(work, { recursive: true, force: true, maxRetries: 3 }); });

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const CRITERIA = ["O valor b passa a ser 20.", "QA verifica os critérios com resultados observados; Revisor distingue fatos verificados de limitações."];

// ---- validation rules (pure) --------------------------------------------------------------------------------
const crit = (over: Record<string, unknown> = {}) => ({ criterion: CRITERIA[0], verdict: "approved", evidence_ids: ["E1"], evidence: "E1 mostra b = 20.", steps: "", expected: "", observed: "", impact: "", notVerifiedReason: "", pending_reason: "", evaluated_part: "", pending_part: "", pending_task: "", ...over });
const future = (over: Record<string, unknown> = {}) => crit({ criterion: CRITERIA[1], verdict: "not_verified", evidence_ids: ["E2"], evidence: "", notVerifiedReason: "A parte do Revisor vem depois.", pending_reason: "future_step", evaluated_part: "O QA verificou com as evidências E1 e E2.", pending_part: "Revisor distinguir fatos de limitações.", pending_task: "t4", ...over });
const evalRaw = (criteria: unknown[], over: Record<string, unknown> = {}) => ({ outcome: "done", summary: "ok", criteria, questions: [], not_verified: [], recommendation: "ready_for_review", followup_operations: [], ...over });
const opts = { expectedCriteria: CRITERIA, evidenceIds: new Set(["E1", "E2"]), downstreamTasks: ["t4"], allowFollowups: false };

describe("validação do parecer do QA com ferramentas", () => {
  it("critério de vários colaboradores: a parte futura fica pendente (not_verified, future_step, tarefa posterior real) e o parecer segue para a revisão final", () => {
    const v = validateToolQAResult(evalRaw([crit(), future()]), opts);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.result.criteria[1]).toMatchObject({ verdict: "not_verified", pendingReason: "future_step", pendingTask: "t4", evaluatedPart: expect.any(String), pendingPart: expect.any(String) });
  });
  it("recusa: parte pendente aprovada, tarefa futura que não é posterior, evidência inexistente, aprovação sem evidência do executor", () => {
    const errs = (c: unknown[], o = {}) => { const v = validateToolQAResult(evalRaw(c, o), opts); return v.ok ? "" : v.errors.join(" | "); };
    expect(errs([crit(), future({ verdict: "approved", evidence: "x" })])).toContain("parte pendente");
    expect(errs([crit(), future({ pending_task: "t1" })])).toContain("não é uma tarefa posterior");
    expect(errs([crit({ evidence_ids: ["E9"] }), future()])).toContain("evidência inexistente");
    expect(errs([crit({ evidence_ids: [] }), future()])).toContain("sem citar evidência do executor");
  });
  it("recomendação: nada volta ao Desenvolvedor por ferramenta indisponível ou etapa futura; needs_more_work só com evidência insuficiente; reprovado → blocked", () => {
    const toolOnly = crit({ verdict: "not_verified", evidence_ids: [], evidence: "", notVerifiedReason: "sem navegador", pending_reason: "tool_unavailable" });
    const v1 = validateToolQAResult(evalRaw([toolOnly, future()], { recommendation: "needs_more_work" }), opts);
    expect(v1.ok).toBe(false);
    expect(validateToolQAResult(evalRaw([toolOnly, future()]), opts).ok).toBe(true);
    const insufficient = crit({ verdict: "not_verified", evidence_ids: ["E1"], evidence: "", notVerifiedReason: "não mostra", pending_reason: "insufficient_evidence" });
    expect(validateToolQAResult(evalRaw([insufficient, future()], { recommendation: "needs_more_work" }), opts).ok).toBe(true);
    const rej = crit({ verdict: "rejected", evidence: "", steps: "li E1", expected: "20", observed: "2", impact: "errado" });
    expect(validateToolQAResult(evalRaw([rej, future()], { recommendation: "ready_for_review" }), opts).ok).toBe(false);
    expect(validateToolQAResult(evalRaw([rej, future()], { recommendation: "blocked" }), opts).ok).toBe(true);
  });
  it("última rodada não aceita novas operações", () => {
    const v = validateToolQAResult(evalRaw([crit(), future()], { followup_operations: [{ id: "x", type: "search", criteria: [1], purpose: "p", path: "", start_line: 0, end_line: 0, query: "b = 20", check: "", test_files: [], scenario_name: "", steps: [] }] }), opts);
    expect(v.ok).toBe(false);
  });
});

// ---- the pipeline, end to end (fake model calls, real git/environment/commands) ------------------------------
const FAKE_PM = path.join(os.tmpdir(), `ayla-fake-pnpm-qa-${process.pid}.mjs`);
writeFileSync(FAKE_PM, [
  "import { writeFileSync, mkdirSync } from 'node:fs';",
  "const [cmd, ...rest] = process.argv.slice(2);",
  "if (process.env.FAKE_PID_FILE) writeFileSync(process.env.FAKE_PID_FILE, String(process.pid));",
  "console.log('fake-pnpm', cmd, rest.join(' '));",
  "if (cmd === 'install') { mkdirSync('node_modules', { recursive: true }); process.exit(0); }",
  "if (process.env.FAKE_SLOW === rest[0]) { setTimeout(() => process.exit(0), 60000); } else { console.log('Tests 3 passed'); process.exit(0); }",
].join("\n"));
const fakePm = { ok: true as const, name: "pnpm" as const, command: process.execPath, prefix: [FAKE_PM], detail: "pnpm simulado (teste)" };

async function scenario() {
  const dir = path.join(work, "proj");
  mkdirSync(path.join(dir, "src"), { recursive: true });
  const g = (...a: string[]) => execFileSync("git", ["-C", dir, "-c", "core.autocrlf=false", ...a], { encoding: "utf8", env: gitEnv }).trim();
  g("init", "-q", "-b", "main"); g("remote", "add", "origin", "https://github.com/o/r.git");
  writeFileSync(path.join(dir, "src", "a.ts"), "export const a = 1;\nexport const b = 2;\n");
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "p", scripts: { lint: "x", test: "x", build: "x" } }));
  writeFileSync(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  g("add", "."); g("commit", "-q", "-m", "base");
  const base = g("rev-parse", "HEAD");
  const diffText = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n export const a = 1;\n-export const b = 2;\n+export const b = 20;\n";
  const parsed = parseStartRequest(request({}, { source: "github", repo: { url: "https://github.com/o/r", owner: "o", repo: "r", branch: "main" }, acceptanceCriteria: CRITERIA }));
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  parsed.value.team = [member("director", { handoffTo: ["developer", "qa", "reviewer"] }), member("developer"), member("qa"), member("reviewer")];
  const { run: plan } = await store.create(buildNewRun(parsed.value));
  await store.claim(plan.id, 60000);
  await store.update(plan.id, { status: "plan_ready", finishedAt: new Date().toISOString(), result: { ...goodPlan({ tasks: [
    { id: "t2", step_id: "s1", assignee: "developer", title: "Implementar", scope: "x", inputs: "x", deliverable: "diff", acceptance_criteria: ["ok"], depends_on: [] },
    { id: "t3", step_id: "s1", assignee: "qa", title: "Verificar", scope: "x", inputs: "t2", deliverable: "parecer", acceptance_criteria: ["ok"], depends_on: ["t2"] },
    { id: "t4", step_id: "s1", assignee: "reviewer", title: "Revisar", scope: "x", inputs: "t3", deliverable: "parecer final", acceptance_criteria: ["ok"], depends_on: ["t3"] },
  ] }), limitations: [] } });
  const diff: DeveloperDiff = { baseCommit: base, files: [{ path: "src/a.ts", status: "modified", additions: 1, deletions: 1, inScope: true }], diffText, diffTruncated: false, outOfScope: [], diffSha256: sha(diffText) };
  const { run } = await store.create({
    id: crypto.randomUUID(), kind: "developer_task", demandId: plan.demandId, agentId: "developer", idempotencyKey: `dev:${Math.random()}`, connection: "claude_code", model: "", effort: "", snapshotHash: "h",
    snapshot: { kind: "developer_task", base: { owner: "o", repo: "r", commit: base, dirName: "proj", treeEntries: 3, sampleFiles: [] }, editScope: [{ path: "src/a.ts", action: "alterar", from: ["t"] }] } as never,
    budget: { sheetTokens: 0, estimatedInputTokens: 0, calls: [], reportedTotalTokens: null, exceeded: false }, previousRunId: null, parentRunId: plan.id, taskId: "t2", initialStatus: "awaiting_approval",
  });
  await store.approve(run.id); await store.claim(run.id, 60000);
  await store.update(run.id, { status: "implementation_ready", finishedAt: new Date().toISOString(), result: { outcome: "done", summary: "s", changes: [], acceptance: [], questions: [], not_verified: [], assumptions: [], limitations: [], diff } as never });
  return { dir, base, planId: plan.id, devRunId: run.id, diffText };
}
const svcWith = (steps: Parameters<typeof fakeAdapter>[0], extra: Partial<ServiceDeps> = {}) => {
  const f = fakeAdapter(steps);
  const svc = new ExecutorService({ version: "t", dataDir: path.join(work, "data"), storePath: ":memory:", workRoot: path.join(work, "wr"), limits: { maxRunsPerHour: 50, maxConcurrentRuns: 1, callTimeoutMs: 5000, leaseMs: 60000, statusCacheMs: 0 }, github: {}, localRepos: [path.join(work, "proj")] }, {
    store, runner: runProcess, env: process.env, packageManager: fakePm,
    detectors: { claude_code: async () => connected("claude_code"), codex: async () => connected("codex") },
    adapters: { claude_code: f.adapter, codex: null }, ...extra,
  });
  return { svc, calls: f.calls };
};
const qaReq = (planId: string) => ({ idempotencyKey: `q:${Math.random().toString(36).slice(2, 12)}`, directorRunId: planId, taskId: "t3", agent: member("qa", { connection: "claude_code", brief: "# QA", budget: 48000 }) });
const op = (o: Record<string, unknown>) => ({ id: "op", type: "read_file", criteria: [1], purpose: "p", path: "", start_line: 0, end_line: 0, query: "", check: "", test_files: [], scenario_name: "", steps: [], ...o });

describe("QA com operações do executor, de ponta a ponta", { timeout: 60_000 }, () => {
  it("monta a versão exata, gera evidências automáticas, roda as operações pedidas e só aceita vereditos que citam essas evidências", async () => {
    const s = await scenario();
    let evalPrompt = "";
    const { svc, calls } = svcWith([
      reply({ plan_summary: "Ler o arquivo, buscar o valor, rodar os testes e tentar o navegador.", operations: [
        op({ id: "ler", type: "read_file", path: "src/a.ts" }),
        op({ id: "buscar", type: "search", query: "b = 20" }),
        op({ id: "testes", type: "run_check", check: "test" }),
        op({ id: "fora", type: "read_file", path: "../../segredo.txt" }),
        op({ id: "nav", type: "browser", scenario_name: "tela", steps: [{ action: "open", target: "", url_path: "/", save_as: "", first: "", second: "", ignore_line_regex: "", setting: "", timeout_ms: 0 }] }),
      ] }),
      async (c: AgentCall) => {
        evalPrompt = c.user;
        const ids = [...c.user.matchAll(/^\[(E\d+)\]/gm)].map(m => m[1]);
        const read = ids.find(id => c.user.includes(`[${id}] inspeção · pedida pelo QA`))!;
        return reply(evalRaw([crit({ evidence_ids: [read], evidence: `${read} mostra b = 20.` }), future({ evidence_ids: [] })]));
      },
    ]);
    const prep = await svc.prepareQA(qaReq(s.planId));
    const run = (prep.body as { run: RunDetail }).run;
    const snap = run.snapshot as QASnapshot;
    expect(snap.testedVersion).toMatchObject({ kind: "commit_plus_patch", commit: s.base, patchSha256: sha(s.diffText) });
    await svc.approve(run.id, { snapshotHash: run.snapshotHash });
    await svc.idle();
    expect(calls).toHaveLength(2);
    const done = (await store.detail(run.id))!;
    expect(done.status).toBe("review_ready");
    const ev = done.qa!.evidence!;
    expect(ev[0]).toMatchObject({ id: "E1", method: "inspection", requestedBy: "executor" }); // the delivered diff
    expect(ev.find(e => e.purpose.includes("Preparar dependências"))).toMatchObject({ method: "command", ok: true });
    expect(ev.filter(e => e.requestedBy === "executor" && e.method === "command").map(e => e.command!.label)).toEqual(expect.arrayContaining(["Lint", "Testes automatizados", "Build"]));
    const read = ev.find(e => e.steps[0]?.startsWith("ler src/a.ts"))!;
    expect(read.observed).toContain("export const b = 20;"); // the EXACT tested version: base + persisted diff
    expect(ev.find(e => e.steps[0]?.startsWith("buscar"))!.observed).toContain("src/a.ts:2");
    const test = ev.find(e => e.requestedBy === "qa" && e.method === "command")!;
    expect(test.command).toMatchObject({ exitCode: 0, command: "pnpm run test" });
    expect(test.command!.cwd).toContain(`${run.id}.qa`);
    expect(ev.find(e => e.steps[0]?.includes("segredo"))).toMatchObject({ ok: false, observed: expect.stringContaining("recusad") });
    const nav = ev.find(e => e.method === "browser")!;
    expect(nav.ok).toBe(false);
    expect(nav.observed).toContain("Ferramenta indisponível"); // no dev script: a concrete reason, not a guess
    for (const e of ev) for (const a of e.artifacts) expect(existsSync(path.join(work, "data", "artifacts", run.id, a.name))).toBe(true);
    expect(done.qa!.testedVersion?.treeHash).toMatch(/^[0-9a-f]{40}$/);
    expect(done.qa!.environment?.modifiedDeliveryFiles).toEqual([]);
    expect(done.qa!.criteria[1]).toMatchObject({ verdict: "not_verified", pendingReason: "future_step", pendingTask: "t4" });
    expect(evalPrompt).toContain("autor: o agente Desenvolvedor"); // narrative reports carry their real author
    expect(readdirSync(path.join(work, "wr")).some(n => n.endsWith(".qa"))).toBe(false); // environment removed
    expect(readFileSync(path.join(s.dir, "src", "a.ts"), "utf8")).toContain("b = 2;"); // the source project was never touched
  });

  it("cancelar durante um comando encerra o processo iniciado pela execução e remove o ambiente", async () => {
    const s = await scenario();
    const pidFile = path.join(work, "pid");
    process.env.FAKE_SLOW = "test"; process.env.FAKE_PID_FILE = pidFile;
    const { svc, calls } = svcWith([]);
    const run = ((await svc.prepareQA(qaReq(s.planId))).body as { run: RunDetail }).run;
    await svc.approve(run.id, { snapshotHash: run.snapshotHash });
    let pid = 0;
    // Wait until the baseline "Testes" check started (the stand-in then hangs) and take ITS pid (last writer).
    for (let i = 0; i < 400 && !pid; i++) {
      await new Promise(r => setTimeout(r, 50));
      if ((await store.events(run.id)).some(e => e.kind === "qa_check" && e.message.includes("Testes"))) { await new Promise(r => setTimeout(r, 800)); pid = Number(readFileSync(pidFile, "utf8")); }
    }
    expect(pid).toBeGreaterThan(0);
    expect(body(await svc.cancel(run.id)).canceled).toBe(true);
    await svc.idle();
    delete process.env.FAKE_SLOW; delete process.env.FAKE_PID_FILE;
    expect((await store.get(run.id))!.status).toBe("canceled");
    await new Promise(r => setTimeout(r, 500));
    expect(() => process.kill(pid, 0)).toThrow();
    expect(calls).toHaveLength(0); // canceled before any model call
    expect(readdirSync(path.join(work, "wr")).some(n => n.endsWith(".qa"))).toBe(false);
  });
});

const body = (r: { body: unknown }) => r.body as { canceled: boolean };

// ---- the controlled browser, for real (skipped when no Edge/Chrome is installed) --------------------------
const browser = findBrowser();
describe.skipIf(!browser)("navegador controlado (Edge/Chrome instalado, perfil temporário, só a origem da aplicação)", { timeout: 60_000 }, () => {
  it("clique real, área de transferência real, download real, comparação, permissão negada, API ausente, recarregar — e nenhuma escrita chega ao servidor", async () => {
    expect(await loadPlaywright()).not.toBeNull();
    const posts: string[] = [];
    const page = `<!doctype html><meta charset=utf-8><button id=c>Copiar</button><a href="/f.md" download>Baixar</a><p id=t></p><script>
      document.getElementById('c').onclick=function(){ if(!navigator.clipboard){document.getElementById('t').textContent='Sem API';return;}
        navigator.clipboard.writeText(['# T','gerado em '+Date.now(),'x'].join(String.fromCharCode(10))).then(function(){document.getElementById('t').textContent='Copiado'},function(e){document.getElementById('t').textContent='Falhou: '+e.name}); };
      fetch('/api/runs',{method:'POST'});</script>`;
    const srv = http.createServer((q, r) => {
      if (q.method !== "GET") posts.push(`${q.method} ${q.url}`);
      if (q.url === "/f.md") { r.writeHead(200, { "content-type": "text/markdown", "content-disposition": "attachment; filename=f.md" }); r.end("# T\ngerado em 1\nx\n"); }
      else { r.writeHead(200, { "content-type": "text/html; charset=utf-8" }); r.end(page); }
    }).listen(0, "127.0.0.1");
    await new Promise(r => srv.once("listening", r));
    const port = (srv.address() as { port: number }).port;
    const step = (o: Partial<BrowserStep>): BrowserStep => ({ action: "wait", target: "", url_path: "", save_as: "", first: "", second: "", ignore_line_regex: "", setting: "", timeout_ms: 0, ...o });
    const artifactsDir = path.join(work, "art");
    const res = await runScenario({ appUrl: `http://localhost:${port}`, name: "t", evidenceId: "E1", executable: browser!.executable, artifactsDir, fixture: { localStorage: {}, api: {}, note: "bloqueado no QA" }, steps: [
      step({ action: "open", url_path: "/" }), step({ action: "click", target: "Copiar" }), step({ action: "wait_for_text", target: "Copiado" }), step({ action: "read_clipboard", save_as: "c" }),
      step({ action: "download", target: "Baixar", save_as: "d" }), step({ action: "compare", first: "c", second: "d", ignore_line_regex: "^gerado em " }),
      step({ action: "clipboard_permission", setting: "deny" }), step({ action: "click", target: "Copiar" }), step({ action: "wait_for_text", target: "Falhou: NotAllowedError" }),
      step({ action: "clipboard_permission", setting: "grant" }), step({ action: "disable_clipboard_api" }), step({ action: "click", target: "Copiar" }), step({ action: "wait_for_text", target: "Sem API" }),
      step({ action: "reload" }), step({ action: "expect_text", target: "Sem API" }),
      step({ action: "expect_text", target: "Copiar" }), step({ action: "read_text" }),
    ] });
    srv.close();
    expect(res.ok).toBe(true);
    expect(res.steps.find(s => s.action === "read_clipboard")!.observed).toContain("gerado em");
    expect(res.steps.find(s => s.action === "compare")!.observed).toMatch(/^IGUAIS/);
    // expect_text tells a real control from the same words in plain text; read_text lists what can be clicked next.
    expect(res.steps.find(s => s.action === "expect_text" && s.args.includes("Copiar"))!.observed).toContain("COMO BOTÃO");
    expect(res.steps.find(s => s.action === "expect_text" && s.args.includes("Sem API"))!.observed).toMatch(/AUSENTE/);
    expect(res.steps.find(s => s.action === "read_text")!.observed).toMatch(/Clicáveis visíveis: .*Copiar.*Baixar \[link\]/);
    expect(res.observed).toContain("Tela ao final — clicáveis visíveis:");
    expect(res.api.blocked).toBe(2); // the page POSTs on each load (open + reload): both blocked, none reached the server
    expect(posts).toEqual([]);
    expect(res.artifacts.some(a => a.kind === "download") && res.artifacts.some(a => a.kind === "clipboard") && res.artifacts.some(a => a.kind === "screenshot")).toBe(true);
    for (const a of res.artifacts) expect(existsSync(path.join(artifactsDir, a.name))).toBe(true);
  });

  it("compare normaliza só quebras de linha e no máximo 3 linhas do padrão permitido", () => {
    expect(compareTexts("a\r\nb\r\n", "a\nb", "").equal).toBe(true);
    expect(compareTexts("a\ngerado em 1\nc", "a\ngerado em 2\nc", "^gerado em ").equal).toBe(true);
    expect(compareTexts("a\ngerado em 1\nc", "a\ngerado em 2\nZ", "^gerado em ").equal).toBe(false);
    expect(compareTexts("a\nb", "a\nB", "").differences[0]).toMatchObject({ line: 2 });
  });
});

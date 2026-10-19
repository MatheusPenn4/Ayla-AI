// Director → user approval → Architect. The official clients are replaced by
// scripted adapters (SIMULATED); GitHub is a fake fetch. Real runs are done
// separately (see docs/executor-local.md, "Verificação").
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { refPath, validateAnalysis } from "@/lib/engine/analysis-schema";
import { taskState } from "@/lib/engine/handoff-state";
import { dependencyBlocker, findDependencyIssues } from "@/lib/engine/dependency";
import { reportedTotal, type ArchitectAnalysis, type ArchitectSnapshot, type DirectorPlan, type PlanTask, type RunDetail, type RunRecord, type TaskCompletion } from "@/lib/engine/types";
import { claudeArgs, claudeUsage, claudeAdapter } from "@/lib/executor/adapters/claude";
import { codexArgs, parseCodexEvents, codexAdapter } from "@/lib/executor/adapters/codex";
import { AgentError, type AgentCall } from "@/lib/executor/adapters/types";
import { expandTerms, extractPathMentions, scorePath, shrinkGithubText, termGroups } from "@/lib/executor/github";
import { buildNewRun, parseStartRequest } from "@/lib/executor/runs-service";
import { ExecutorService, type ExecutorConfig } from "@/lib/executor/service";
import { sqliteDriver } from "@/lib/executor/sqlite";
import { RunStore } from "@/lib/executor/store";
import { runProcess, type Runner } from "@/lib/executor/proc";
import { redactSecrets } from "@/lib/executor/redact";
import { excerptFile } from "@/lib/executor/github";
import { questionSimilarity } from "@/lib/engine/analysis-schema";
import { promptComposition } from "@/lib/engine/composition";
import { execFileSync } from "node:child_process";
import { createHash as hashOf } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { connected, fakeAdapter, goodPlan, member, reply, request, usage } from "./helpers";
import { partialTexts } from "@/lib/engine/analysis-schema";
import { developerPreviewMarkdown, type DeveloperPreview } from "@/lib/engine/developer-preview";
import { TASK_STATE_LABEL } from "@/lib/engine/handoff-state";
import { extractFileRefs } from "@/lib/executor/github";
import { suggestFiles, type SourceOptions } from "@/lib/executor/handoff";

let work: string;
let store: RunStore;
beforeEach(() => { work = mkdtempSync(path.join(os.tmpdir(), "ayla-hand-")); store = new RunStore(sqliteDriver(":memory:")); });
afterEach(() => { rmSync(work, { recursive: true, force: true }); });

const COMMIT = "c".repeat(40);
const FILES: Record<string, string> = {
  "README.md": "# Projeto", "package.json": '{"name":"x","dependencies":{"react":"19"}}',
  "src/botao.tsx": "export const Botao = () => null", "src/estilo.css": ".botao{}", "docs/a.md": "doc", "lib/outro.ts": "export {}",
};
function ghFetch(log: string[] = []) {
  return (async (url: string) => {
    const u = String(url);
    log.push(u);
    if (u.includes("/branches/")) return new Response(JSON.stringify({ commit: { sha: COMMIT } }), { status: 200 });
    if (u.includes("/git/trees/")) return new Response(JSON.stringify({ truncated: false, tree: Object.keys(FILES).map(p => ({ path: p, type: "blob", size: FILES[p].length })) }), { status: 200 });
    if (u.startsWith("https://raw.githubusercontent.com/")) { const p = decodeURIComponent(u.split("/").slice(6).join("/")); return new Response(FILES[p] ?? "", { status: FILES[p] ? 200 : 404 }); }
    return new Response(JSON.stringify({ private: false, default_branch: "main", description: "desc" }), { status: 200 });
  }) as unknown as typeof fetch;
}

const archPlan = (over: Partial<DirectorPlan> = {}): DirectorPlan => goodPlan({
  steps: [{ id: "s1", title: "Desenho", owner: "architect", depends_on: [], done_when: "Proposta" }, { id: "s2", title: "Implementar", owner: "developer", depends_on: ["s1"], done_when: "Feito" }],
  tasks: [
    { id: "t1", step_id: "s1", assignee: "architect", title: "Definir o componente do botão", scope: "Ler src/botao.tsx e docs/ para propor a mudança", inputs: "Demanda", deliverable: "Proposta técnica", acceptance_criteria: ["Arquivos afetados listados"], depends_on: [] },
    { id: "t2", step_id: "s1", assignee: "architect", title: "Definir estilo", scope: "Tema em src/estilo.css", inputs: "t1", deliverable: "Proposta", acceptance_criteria: ["Cores definidas"], depends_on: ["t1"] },
    { id: "t3", step_id: "s2", assignee: "developer", title: "Alterar", scope: "CSS", inputs: "t1", deliverable: "Diff", acceptance_criteria: ["Azul"], depends_on: ["t1"] },
    { id: "t4", step_id: "s2", assignee: "architect", title: "Revisar depois do dev", scope: "x", inputs: "t3", deliverable: "Nota", acceptance_criteria: ["ok"], depends_on: ["t3"] },
  ],
  ...over,
});

const analysis = (over: Partial<ArchitectAnalysis> = {}): ArchitectAnalysis => ({
  outcome: "analysis_ready", technical_understanding: "Trocar a cor do botão salvar.", assumptions: ["O tema usa CSS simples"],
  examined: [{ ref: "src/botao.tsx#Botao", kind: "symbol", basis: "read", note: "componente atual" }, { ref: "src/tema.ts", kind: "file", basis: "inferred", note: "não enviado" }],
  recommendation: { summary: "Adicionar a classe azul no Botao.", rationale: "Mudança local e reversível." }, alternatives: [],
  dependencies: [], compatibility: ["Nenhuma API muda"], risks: [{ risk: "Contraste", regression_area: "Tela de edição", mitigation: "Checar contraste" }],
  developer_guidance: ["Editar src/botao.tsx", "Adicionar teste de snapshot"], qa_checks: ["Conferir a cor na tela de edição"], questions: [], not_verified: ["Nada foi executado"], ...over,
});

const cfg = (): ExecutorConfig => ({ version: "t", dataDir: work, storePath: ":memory:", workRoot: work, limits: { maxRunsPerHour: 50, maxConcurrentRuns: 1, callTimeoutMs: 1000, leaseMs: 60000, statusCacheMs: 0 }, github: { fetch: ghFetch() } });

function service(steps: Parameters<typeof fakeAdapter>[0] = [], opts: { claude?: "connected" | "disconnected"; s?: RunStore; log?: string[]; localRepos?: string[] } = {}) {
  const arch = fakeAdapter(steps);
  const svc = new ExecutorService({ ...cfg(), github: { fetch: ghFetch(opts.log) }, localRepos: opts.localRepos ?? [] }, {
    // Only git (local reader) runs as a real process; the official clients are scripted.
    store: opts.s ?? store, runner: opts.localRepos ? runProcess : async () => { throw new Error("nenhum processo real nos testes"); }, env: opts.localRepos ? process.env : {},
    detectors: { claude_code: async () => connected("claude_code", opts.claude === "disconnected" ? { state: "disconnected", message: "sem login", steps: ["claude auth login --claudeai"] } : {}), codex: async () => connected("codex") },
    adapters: { claude_code: arch.adapter, codex: arch.adapter },
  });
  return { svc, calls: arch.calls };
}

/** A finished Director plan (as if the Director had run), with GitHub context at COMMIT. */
async function directorPlan(plan: DirectorPlan = archPlan(), s: RunStore = store, status: "plan_ready" | "failed" = "plan_ready") {
  const parsed = parseStartRequest(request({}, { source: "github", repo: { url: "https://github.com/o/r", owner: "o", repo: "r", branch: "" } }));
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  parsed.value.team = [member("director", { handoffTo: ["architect", "developer", "qa"] }), member("architect", { connection: "claude_code", brief: "# Arquiteto\nFicha salva do Arquiteto.", budget: 24000 }), member("developer"), member("qa")];
  const { run } = await s.create(buildNewRun(parsed.value));
  await s.claim(run.id, 60000);
  const context = { kind: "github" as const, owner: "o", repo: "r", branch: "main", commit: COMMIT, visibility: "public" as const, description: null, defaultBranch: "main", treeEntries: 6, treeTruncated: false, structureSample: [], files: [{ path: "README.md", bytes: 9, sentChars: 9, truncated: false, reason: "doc" }, { path: "package.json", bytes: 40, sentChars: 40, truncated: false, reason: "manifesto" }], skipped: [], limits: { maxFiles: 8, maxFileBytes: 1, maxTotalChars: 1, timeoutMs: 1 }, elapsedMs: 1 };
  await s.update(run.id, { status, result: { ...plan, limitations: [] }, context, finishedAt: new Date().toISOString(), leaseUntil: null });
  return run.id;
}

const architectSheet = (over = {}) => member("architect", { connection: "claude_code", brief: "# Arquiteto\nFicha salva do Arquiteto.", budget: 24000, ...over });
const handoffReq = (planId: string, taskId = "t1", over = {}) => ({ idempotencyKey: `h:${Math.random().toString(36).slice(2, 12)}`, directorRunId: planId, taskId, agent: architectSheet(), ...over });
const body = <T,>(r: { body: unknown }) => r.body as T;

describe("preparar o envio ao Arquiteto (nada executa)", () => {
  it("tarefa elegível: prepara, congela o conteúdo e fica aguardando aprovação sem chamar o cliente", async () => {
    const log: string[] = [];
    const { svc, calls } = service([], { log });
    const plan = await directorPlan();
    const r = await svc.prepare(handoffReq(plan));
    expect(r.status).toBe(201);
    const run = body<{ run: RunDetail }>(r).run;
    expect(run).toMatchObject({ kind: "architect_task", status: "awaiting_approval", parentRunId: plan, taskId: "t1", connection: "claude_code", agentId: "architect" });
    const snap = run.snapshot as ArchitectSnapshot;
    expect(snap.task.id).toBe("t1");
    expect(snap.agent.brief).toContain("Ficha salva do Arquiteto");
    expect(snap.plan.directorFiles.map(f => f.path)).toEqual(["README.md", "package.json"]);
    expect(snap.tools.find(t => t.label.startsWith("Editar"))?.allowed).toBe(false);
    expect(run.prompt?.system).toContain("PROTOCOLO DE EXECUÇÃO DO SETOR IA — ARQUITETO");
    expect(run.prompt?.system).toContain("Ficha salva do Arquiteto");
    expect(run.prompt?.user).toContain("Definir o componente do botão");
    expect(run.prompt?.user).not.toContain("Revisar depois do dev");
    // Same commit as the Director; files cited in the task and the manifest; README not re-sent.
    expect(log.some(u => u.includes("/branches/"))).toBe(false);
    expect(log.some(u => u.includes(`/git/trees/${COMMIT}`))).toBe(true);
    const sent = run.context?.kind === "github" ? run.context.files.map(f => f.path) : [];
    expect(sent).toEqual(expect.arrayContaining(["src/botao.tsx", "docs/a.md", "package.json"]));
    expect(sent).not.toContain("README.md");
    expect(run.context?.kind === "github" && run.context.commit).toBe(COMMIT);
    // Paths of every text file are listed (names only), so the Architect knows what exists and what it did not read.
    expect(run.prompt?.user).toContain("apenas os nomes");
    expect(run.prompt?.user).toContain("lib/: outro.ts");
    expect(run.context?.kind === "github" && run.context.files.map(f => f.path)).not.toContain("lib/outro.ts");
    await svc.idle();
    expect(calls).toHaveLength(0);
    expect((await store.get(run.id))!.status).toBe("awaiting_approval");
  });

  it("plano sem tarefa do Arquiteto e tarefa de outro responsável: recusados", async () => {
    const { svc } = service();
    const noArch = await directorPlan(goodPlan());
    expect(body<{ error: { code: string } }>(await svc.prepare(handoffReq(noArch, "t1"))).error.code).toBe("not_architect_task");
    const plan = await directorPlan();
    expect(body<{ error: { code: string } }>(await svc.prepare(handoffReq(plan, "t3"))).error.code).toBe("not_architect_task");
  });

  it("dados adulterados pelo navegador não passam: tarefa inexistente, plano inexistente, ficha de outro, sem conexão", async () => {
    const { svc } = service();
    const plan = await directorPlan();
    expect((await svc.prepare(handoffReq(plan, "t999"))).status).toBe(404);
    expect((await svc.prepare(handoffReq("00000000-0000-4000-8000-000000000000"))).status).toBe(404);
    expect(body<{ error: { code: string } }>(await svc.prepare(handoffReq(plan, "t1", { agent: member("developer", { connection: "claude_code" }) }))).error.code).toBe("agent_mismatch");
    expect(body<{ error: { code: string } }>(await svc.prepare(handoffReq(plan, "t1", { agent: architectSheet({ connection: "none" }) }))).error.code).toBe("no_connection");
    expect((await svc.prepare({ ...handoffReq(plan), agent: { ...architectSheet(), modelName: "x; rm -rf /" } })).status).toBe(400);
    const failed = await directorPlan(archPlan(), store, "failed");
    expect(body<{ error: { code: string } }>(await svc.prepare(handoffReq(failed))).error.code).toBe("plan_not_ready");
  });

  it("dependências: não envia antes da tarefa de que depende, nem se depender de quem não executa", async () => {
    const { svc } = service([reply(analysis())]);
    const plan = await directorPlan();
    const early = await svc.prepare(handoffReq(plan, "t2"));
    expect(body<{ error: { code: string; details: string[] } }>(early).error).toMatchObject({ code: "dependency_pending" });
    expect(body<{ error: { code: string } }>(await svc.prepare(handoffReq(plan, "t4"))).error.code).toBe("dependency_pending");
    const first = body<{ run: RunDetail }>(await svc.prepare(handoffReq(plan, "t1"))).run;
    await svc.approve(first.id, { snapshotHash: first.snapshotHash });
    await svc.idle();
    const second = await svc.prepare(handoffReq(plan, "t2"));
    expect(second.status).toBe(201);
    const snap = body<{ run: RunDetail }>(second).run.snapshot as ArchitectSnapshot;
    expect(snap.plan.dependsOn[0]).toMatchObject({ id: "t1", analysisRunId: first.id, analysisSummary: "Adicionar a classe azul no Botao." });
    // The concluded analysis goes once, in its own section, with its commit (not repeated in the plan summary).
    expect(body<{ run: RunDetail }>(second).run.prompt?.user).toContain(`t1 · análise concluída ${first.id.slice(0, 8)}`);
    expect(body<{ run: RunDetail }>(second).run.prompt?.user).toContain("Recomendação: Adicionar a classe azul no Botao.");
  });

  it("o estado das tarefas na interface segue os registros do executor", () => {
    const plan = archPlan();
    // t3 is a Developer task: it now has its own hand-off flow, so it is "proposed" (executable), not "not_executable".
    expect(taskState(plan.tasks[2], []).key).toBe("proposed");
    expect(taskState(plan.tasks[0], []).key).toBe("proposed");
    expect(dependencyBlocker(plan.tasks[1], plan.tasks, () => [], () => [])).toContain("t1");
    // t4 (architect) depends on t3 (developer). Under the old Architect-only rule this was a categorical
    // "developer doesn't execute" block; the coherent rule (lib/engine/dependency.ts) now reports the real,
    // more accurate reason — t3 simply hasn't been sent to anyone yet — since a Developer dependency CAN be
    // satisfied once it has real evidence (see the dedicated describe block below for that behavior).
    expect(dependencyBlocker(plan.tasks[3], plan.tasks, () => [], () => [])).toBe("Depende de t3: ainda não foi enviado a ninguém.");
    const mk = (id: string, status: RunDetail["status"]) => ({ id, status } as RunDetail);
    expect(taskState(plan.tasks[0], [mk("r3", "failed"), mk("r1", "awaiting_clarification")])).toMatchObject({ key: "awaiting_clarification", run: { id: "r1" } });
    expect(taskState(plan.tasks[0], [mk("r4", "awaiting_approval"), mk("r1", "awaiting_clarification")]).key).toBe("awaiting_approval");
  });
});

describe("aprovação e execução do Arquiteto", () => {
  it("sem aprovação nada executa; hash diferente é recusado; o Arquiteto não inicia execução sozinho", async () => {
    const { svc, calls } = service([reply(analysis())]);
    const plan = await directorPlan();
    const run = body<{ run: RunDetail }>(await svc.prepare(handoffReq(plan))).run;
    expect((await svc.approve(run.id, { snapshotHash: "outro" })).status).toBe(409);
    expect((await svc.approve(run.id, {})).status).toBe(409);
    const direct = parseStartRequest(request({ directorId: "architect", team: [architectSheet()] }));
    expect(direct.ok).toBe(false);
    await svc.idle();
    expect(calls).toHaveLength(0);
  });

  it("cliques repetidos: um único encaminhamento, uma única aprovação e um único processo", async () => {
    const { svc, calls } = service([async () => { await new Promise(r => setTimeout(r, 20)); return reply(analysis()); }, reply(analysis())]);
    const plan = await directorPlan();
    const prepared = await Promise.all([svc.prepare(handoffReq(plan)), svc.prepare(handoffReq(plan)), svc.prepare(handoffReq(plan))]);
    const ids = new Set(prepared.map(r => body<{ run: RunDetail }>(r).run.id));
    expect(ids.size).toBe(1);
    const run = body<{ run: RunDetail }>(prepared[0]).run;
    const approvals = await Promise.all([1, 2, 3].map(() => svc.approve(run.id, { snapshotHash: run.snapshotHash })));
    expect(approvals.filter(a => body<{ approved: boolean }>(a).approved)).toHaveLength(1);
    await svc.idle();
    expect(calls).toHaveLength(1);
    expect((await store.runsForTask(plan, "t1"))).toHaveLength(1);
  });

  it("análise concluída: vinculada à tarefa e ao plano, com limitações honestas; ficha congelada; a tarefa não é refeita", async () => {
    const { svc, calls } = service([async (c: AgentCall) => { expect(readdirSync(c.workDir).filter(f => !["system-prompt.txt", "output-schema.json"].includes(f))).toEqual([]); return reply(analysis(), usage(900, 400)); }]);
    const plan = await directorPlan();
    const sheet = architectSheet();
    const run = body<{ run: RunDetail }>(await svc.prepare({ ...handoffReq(plan), agent: sheet })).run;
    sheet.brief = "ficha editada depois";
    await svc.approve(run.id, { snapshotHash: run.snapshotHash });
    await svc.idle();
    const done = (await store.detail(run.id))!;
    expect(done).toMatchObject({ status: "analysis_ready", parentRunId: plan, taskId: "t1", kind: "architect_task" });
    expect(done.analysis?.recommendation.summary).toBe("Adicionar a classe azul no Botao.");
    expect(done.analysis?.limitations.join(" ")).toContain("não editou arquivos, não executou comandos nem testes");
    expect((done.snapshot as ArchitectSnapshot).agent.brief).toContain("Ficha salva do Arquiteto");
    expect(calls[0].system).toBe(run.prompt?.system);
    expect(calls[0].user).toBe(run.prompt?.user);
    expect(done.events.map(e => e.kind)).toEqual(expect.arrayContaining(["created", "prepared", "approved", "started", "connection", "calling", "reply", "analysis_ready"]));
    expect(body<{ error: { code: string } }>(await svc.prepare(handoffReq(plan))).error.code).toBe("already_done");
    // The Director's plan is untouched.
    expect((await store.get(plan))!.status).toBe("plan_ready");
  });

  it("“lido” só para arquivos realmente enviados: a resposta que inventa leitura é corrigida uma vez", async () => {
    const bad = analysis({ examined: [{ ref: "lib/segredo.ts", kind: "file", basis: "read", note: "nunca enviado" }] });
    const { svc, calls } = service([reply(bad), reply(analysis())]);
    const plan = await directorPlan();
    const run = body<{ run: RunDetail }>(await svc.prepare(handoffReq(plan))).run;
    await svc.approve(run.id, { snapshotHash: run.snapshotHash });
    await svc.idle();
    expect(calls).toHaveLength(2);
    expect(calls[1].user).toContain("lib/segredo.ts");
    expect((await store.get(run.id))!.status).toBe("analysis_ready");
    expect(validateAnalysis(bad, ["src/botao.tsx"]).ok).toBe(false);
    expect(refPath("src/botao.tsx#Botao")).toBe("src/botao.tsx");
    expect(refPath("src/botao.tsx:12")).toBe("src/botao.tsx");
  });

  it("esclarecimento: registra as perguntas; reenviar só com respostas, de novo com revisão e aprovação", async () => {
    const q = analysis({ outcome: "needs_clarification", recommendation: { summary: "", rationale: "" }, developer_guidance: [], qa_checks: [], questions: [{ question: "Qual tom de azul?", why_it_blocks: "Há dois temas" }] });
    const { svc, calls } = service([reply(q), reply(analysis())]);
    const plan = await directorPlan();
    const first = body<{ run: RunDetail }>(await svc.prepare(handoffReq(plan))).run;
    await svc.approve(first.id, { snapshotHash: first.snapshotHash });
    await svc.idle();
    expect((await store.get(first.id))!.status).toBe("awaiting_clarification");
    expect(body<{ error: { code: string } }>(await svc.prepare(handoffReq(plan))).error.code).toBe("awaiting_answers");
    const again = await svc.prepare(handoffReq(plan, "t1", { previousRunId: first.id, answers: [{ question: "Qual tom de azul?", answer: "#1e6bd6" }] }));
    expect(again.status).toBe(201);
    const second = body<{ run: RunDetail }>(again).run;
    expect(second).toMatchObject({ status: "awaiting_approval", previousRunId: first.id });
    expect(second.prompt?.user).toContain("#1e6bd6");
    await svc.idle();
    expect(calls).toHaveLength(1);
  });

  it("cliente desconectado: falha com o motivo e os passos, sem chamar o cliente", async () => {
    const { svc, calls } = service([], { claude: "disconnected" });
    const plan = await directorPlan();
    const run = body<{ run: RunDetail }>(await svc.prepare(handoffReq(plan))).run;
    await svc.approve(run.id, { snapshotHash: run.snapshotHash });
    await svc.idle();
    expect((await store.get(run.id))!).toMatchObject({ status: "failed", error: { code: "not_connected", recovery: ["claude auth login --claudeai"] } });
    expect(calls).toHaveLength(0);
  });

  it("erro do cliente vira falha com recuperação; depois pode ser enviado de novo", async () => {
    const { svc } = service([new AgentError("usage_limit", "Limite atingido.", true, "You've hit your usage limit"), reply(analysis())]);
    const plan = await directorPlan();
    const run = body<{ run: RunDetail }>(await svc.prepare(handoffReq(plan))).run;
    await svc.approve(run.id, { snapshotHash: run.snapshotHash });
    await svc.idle();
    expect((await store.get(run.id))!.error).toMatchObject({ code: "usage_limit", retryable: true });
    expect((await store.get(run.id))!.error?.recovery?.join(" ")).toContain("ficha do Arquiteto");
    expect((await svc.prepare(handoffReq(plan))).status).toBe(201);
  });

  it("cancelar: descarta um envio preparado e interrompe o processo em andamento", async () => {
    let aborted = false;
    const { svc } = service([c => new Promise((_, rej) => { c.signal?.addEventListener("abort", () => { aborted = true; rej(new AgentError("canceled", "cancelada", false)); }); })]);
    const plan = await directorPlan();
    const prepared = body<{ run: RunDetail }>(await svc.prepare(handoffReq(plan))).run;
    await svc.cancel(prepared.id);
    expect((await store.detail(prepared.id))!.events.at(-1)?.message).toContain("descartado");
    const run = body<{ run: RunDetail }>(await svc.prepare(handoffReq(plan))).run;
    await svc.approve(run.id, { snapshotHash: run.snapshotHash });
    await new Promise(r => setTimeout(r, 30));
    await svc.cancel(run.id);
    await svc.idle();
    expect(aborted).toBe(true);
    expect((await store.get(run.id))!.status).toBe("canceled");
    expect((await store.detail(run.id))!.events.at(-1)?.message).toContain("processos iniciados por ela (cliente oficial, ambiente isolado, aplicação em teste) foram encerrados");
  });
});

describe("somente leitura garantido pela configuração do cliente", () => {
  const c: AgentCall = { label: "x", system: "s", user: "edite o arquivo e rode rm -rf", schema: {}, model: "", effort: "", timeoutMs: 1000, workDir: "W" };
  it("Claude Code: sem ferramentas, permissões negadas, sem MCP e sem personalizações", () => {
    const a = claudeArgs(c, "sys.txt");
    expect(a[a.indexOf("--tools") + 1]).toBe("");
    expect(a[a.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(a[a.indexOf("--disallowedTools") + 1]).toContain("Edit,Write");
    expect(a).toEqual(expect.arrayContaining(["--strict-mcp-config", "--safe-mode", "--no-session-persistence"]));
    expect(a.join(" ")).not.toMatch(/bypassPermissions|acceptEdits|--add-dir|--bare/);
  });
  it("Codex CLI: sandbox somente leitura, aprovação 'never', shell desligado, pasta vazia", () => {
    const a = codexArgs(c, "schema.json");
    expect(a[a.indexOf("--sandbox") + 1]).toBe("read-only");
    expect(a).toEqual(expect.arrayContaining(['approval_policy="never"', "shell_tool", "unified_exec", "--cd", "W", "--ephemeral"]));
    expect(a.join(" ")).not.toMatch(/workspace-write|danger-full-access|--dangerously/);
  });
});

describe("uso informado com categorias indisponíveis", () => {
  it("categoria ausente fica null (indisponível), nunca 0 inventado", () => {
    const u = claudeUsage({ type: "result", modelUsage: { m: { inputTokens: 10, outputTokens: 5 } } }, "x")!;
    expect(u).toMatchObject({ inputTokens: 10, outputTokens: 5, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null });
    expect(u.source).toContain("modelUsage");
    expect(reportedTotal(u)).toBe(15);
    const e = parseCodexEvents('{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":30,"output_tokens":7}}', "x");
    expect(e.usage).toMatchObject({ inputTokens: 70, cacheReadTokens: 30, cacheWriteTokens: null, reasoningTokens: null, outputTokens: 7 });
    expect(reportedTotal({ label: "x", inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null, model: null })).toBeNull();
  });
  it("registros antigos (todas as categorias numéricas, sem fonte) continuam somando como foram gravados", () => {
    expect(reportedTotal({ label: "planejamento", inputTokens: 4, outputTokens: 6954, cacheReadTokens: 15263, cacheWriteTokens: 17107, reasoningTokens: 356, model: "claude-opus-5-5[1m]" })).toBe(39328);
  });
});

describe("persistência e migração", () => {
  it("encaminhamento e análise sobrevivem a fechar e reabrir o banco; reinício interrompe o que estava em andamento", async () => {
    const file = path.join(work, "runs.sqlite");
    const d1 = sqliteDriver(file);
    const s1 = new RunStore(d1);
    const { svc } = service([reply(analysis())], { s: s1 });
    const plan = await directorPlan(archPlan(), s1);
    const run = body<{ run: RunDetail }>(await svc.prepare(handoffReq(plan))).run;
    await svc.approve(run.id, { snapshotHash: run.snapshotHash });
    await svc.idle();
    const pending = body<{ run: RunDetail }>(await svc.prepare(handoffReq(plan, "t2"))).run;
    d1.close();
    const d2 = sqliteDriver(file);
    const s2 = new RunStore(d2);
    expect((await s2.detail(run.id))).toMatchObject({ status: "analysis_ready", parentRunId: plan, taskId: "t1" });
    expect((await s2.get(pending.id))!.status).toBe("awaiting_approval");
    await s2.approve(pending.id);
    await s2.claim(pending.id, 60000);
    const { svc: after } = service([], { s: s2 });
    await after.boot();
    expect((await s2.get(pending.id))!).toMatchObject({ status: "failed", error: { code: "interrupted" } });
    expect((await s2.get(plan))!.status).toBe("plan_ready");
    d2.close();
  });

  it("banco da versão anterior: cópia de segurança, colunas novas e linhas antigas intactas", async () => {
    const file = path.join(work, "v1.sqlite");
    const raw = new DatabaseSync(file);
    raw.exec(`CREATE TABLE director_runs (id TEXT PRIMARY KEY, demand_id TEXT NOT NULL, agent_id TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, status TEXT NOT NULL, connection TEXT NOT NULL, model TEXT NOT NULL, effort TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, lease_until TEXT, attempt INTEGER NOT NULL DEFAULT 0, snapshot_hash TEXT NOT NULL, snapshot_json TEXT NOT NULL, prompt_json TEXT, context_json TEXT, result_json TEXT, error_json TEXT, budget_json TEXT NOT NULL, raw_output TEXT, previous_run_id TEXT);
      CREATE UNIQUE INDEX director_runs_one_active ON director_runs (demand_id) WHERE status IN ('queued', 'planning');
      CREATE TABLE director_run_events (run_id TEXT NOT NULL, seq INTEGER NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL, message TEXT NOT NULL, data_json TEXT, PRIMARY KEY (run_id, seq));`);
    const plan = JSON.stringify({ ...goodPlan(), limitations: [] });
    raw.prepare(`INSERT INTO director_runs VALUES ('11111111-1111-4111-8111-111111111111','d1','director','k-antiga-1','plan_ready','codex','','','2026-09-25T20:44:03Z','2026-09-25T20:45:09Z',NULL,'2026-09-25T20:45:09Z',NULL,1,'h','{"director":{}}',NULL,NULL,?,NULL,'{"sheetTokens":16000,"estimatedInputTokens":1,"calls":[],"reportedTotalTokens":18860,"exceeded":true}',NULL,NULL)`).run(plan);
    const before = raw.prepare(`SELECT * FROM director_runs`).all();
    raw.close();
    const d = sqliteDriver(file);
    const s = new RunStore(d);
    expect(await s.needsMigration()).toBe(true);
    const backup = path.join(work, "backup.sqlite");
    await s.backupTo(backup);
    await s.ensureSchema();
    expect(await s.needsMigration()).toBe(false);
    const rec = (await s.get("11111111-1111-4111-8111-111111111111"))!;
    expect(rec).toMatchObject({ kind: "director_plan", status: "plan_ready", parentRunId: null, taskId: null, budget: { reportedTotalTokens: 18860 } });
    expect(rec.result?.tasks).toHaveLength(2);
    d.close();
    const check = new DatabaseSync(file, { readOnly: true });
    const after = check.prepare(`SELECT * FROM director_runs`).all() as Record<string, unknown>[];
    for (const [k, v] of Object.entries(before[0] as Record<string, unknown>)) expect(after[0][k]).toEqual(v);
    const idx = (check.prepare(`SELECT name FROM sqlite_master WHERE type='index'`).all() as { name: string }[]).map(r => r.name);
    expect(idx).not.toContain("director_runs_one_active");
    expect(idx).toEqual(expect.arrayContaining(["runs_one_active_plan", "runs_one_active_task"]));
    // v5: task_completions exists for a DB that started life as v1, and the old row still has no completion.
    const tables = (check.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]).map(r => r.name);
    expect(tables).toContain("task_completions");
    expect((check.prepare(`SELECT COUNT(*) AS n FROM task_completions`).get() as { n: number }).n).toBe(0);
    check.close();
    const b = new DatabaseSync(backup, { readOnly: true });
    expect((b.prepare(`SELECT COUNT(*) AS n FROM director_runs`).get() as { n: number }).n).toBe(1);
    b.close();
  });
});

describe("redução de contexto por relevância", () => {
  it("para o Arquiteto, descarta primeiro os arquivos menos relevantes (fim da ordem de seleção)", () => {
    const ctx = { kind: "github" as const, owner: "o", repo: "r", branch: "main", commit: COMMIT, visibility: "public" as const, description: null, defaultBranch: "main", treeEntries: 3, treeTruncated: false, structureSample: [],
      files: [{ path: "a.ts", bytes: 3000, sentChars: 3000, truncated: false, reason: "citado" }, { path: "b.ts", bytes: 100, sentChars: 100, truncated: false, reason: "termo" }], skipped: [], limits: { maxFiles: 1, maxFileBytes: 1, maxTotalChars: 1, timeoutMs: 1 }, elapsedMs: 1 };
    const text = `cabeçalho\n\n--- arquivo: a.ts ---\n${"a".repeat(3000)}\n\n--- arquivo: b.ts ---\n${"b".repeat(100)}`;
    expect(shrinkGithubText(ctx, text, 3050, "priority").ctx.files.map(f => f.path)).toEqual(["a.ts"]);
    expect(shrinkGithubText(ctx, text, 3050, "size").ctx.files.map(f => f.path)).toEqual(["b.ts"]);
  });
  it("texto e lista de arquivos lidos mudam juntos, também com cabeçalho de trecho; arquivos pedidos nunca saem", () => {
    const ctx = { kind: "github" as const, owner: "o", repo: "r", branch: "main", commit: COMMIT, visibility: "public" as const, description: null, defaultBranch: "main", treeEntries: 3, treeTruncated: false, structureSample: [],
      files: [{ path: "pedido.ts", bytes: 3000, sentChars: 3000, truncated: true, reason: "pedido" }, { path: "extra.ts", bytes: 3000, sentChars: 3000, truncated: true, reason: "termo" }], skipped: [], limits: { maxFiles: 1, maxFileBytes: 1, maxTotalChars: 1, timeoutMs: 1 }, elapsedMs: 1 };
    const text = `lista\n\n--- arquivo: pedido.ts (trecho verificável: l.1-9 de 90 linhas; commit c) ---\n${"a".repeat(3000)}\n\n--- arquivo: extra.ts (trecho verificável: l.1-9 de 90 linhas; commit c) ---\n${"b".repeat(3000)}`;
    const r = shrinkGithubText(ctx, text, 100, "priority", new Set(["pedido.ts"]));
    expect(r.ctx.files.map(f => f.path)).toEqual(["pedido.ts"]);
    expect(r.text).toContain("aaaa");
    expect(r.text).not.toContain("bbbb");
    expect(r.ctx.skipped).toEqual([expect.objectContaining({ path: "extra.ts" })]);
  });
});

describe("seleção de arquivos citados na tarefa", () => {
  it("termos da tarefa em português também procuram os nomes em inglês usados no código", () => {
    const t = expandTerms(["Janela", "de", "execução", "contrato", "tipos", "para"]);
    expect(t).toEqual(expect.arrayContaining(["janela", "dialog", "execucao", "run", "contract", "types"]));
    expect(t).not.toContain("para");
    expect(t).not.toContain("de");
  });
  it("pontuação: nome do arquivo pesa mais, pasta genérica não conta, primitivas de UI caem", () => {
    const g = termGroups(["janela", "execução", "tipos", "testes", "componentes"]);
    expect(scorePath("components/office/panels/run-dialog.tsx", g)).toBeGreaterThan(scorePath("components/ui/dialog.tsx", g));
    expect(scorePath("lib/office/types.ts", g)).toBe(2);
    expect(scorePath("components/ui/aspect-ratio.tsx", g)).toBeLessThan(2);
    expect(scorePath("tests/profiles.test.ts", g)).toBe(1);
    expect(scorePath("components.json", g)).toBe(1);
    expect(termGroups(["componente", "componentes", "teste", "testes"])).toHaveLength(2);
  });
  it("extrai caminhos e pastas citados, sem URLs nem subidas de diretório", () => {
    expect(extractPathMentions("Ler components/office/ e lib/office/types.ts. Ver README.md e https://x.com/a/b e ../etc/passwd")).toEqual(expect.arrayContaining(["components/office/", "lib/office/types.ts", "README.md"]));
    expect(extractPathMentions("../etc/passwd https://x.com/a/b")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Clarification, context revision and local Git source
// ---------------------------------------------------------------------------

const QUESTIONS = [
  { question: "Qual arquivo implementa a janela de execução do Diretor?", why_it_blocks: "Sem ele não há ponto de inserção." },
  { question: "O arquivo .md deve incluir o estado dos encaminhamentos?", why_it_blocks: "Decisão de produto." },
];
const clarify = (over: Partial<ArchitectAnalysis> = {}) => analysis({ outcome: "needs_clarification", recommendation: { summary: "Provisória: usar Blob.", rationale: "" }, developer_guidance: [], qa_checks: [], questions: QUESTIONS, ...over });

async function waitingRun(svc: ExecutorService, plan: string) {
  const first = body<{ run: RunDetail }>(await svc.prepare(handoffReq(plan))).run;
  await svc.approve(first.id, { snapshotHash: first.snapshotHash });
  await svc.idle();
  return (await store.detail(first.id))!;
}

describe("esclarecimento pergunta a pergunta", () => {
  it("respostas precisam corresponder às perguntas da execução certa, uma vez cada, todas resolvidas", async () => {
    const { svc } = service([reply(clarify())]);
    const plan = await directorPlan();
    const w = await waitingRun(svc, plan);
    expect(w.status).toBe("awaiting_clarification");
    const code = async (over: object) => body<{ error: { code: string } }>(await svc.prepare(handoffReq(plan, "t1", { previousRunId: w.id, ...over }))).error.code;
    expect(await code({ answers: [{ question: "Pergunta inventada?", answer: "x" }] })).toBe("unknown_question");
    expect(await code({ answers: [{ question: QUESTIONS[0].question, answer: "x" }] })).toBe("unanswered_questions");
    expect(await code({ answers: QUESTIONS.map(q => ({ question: q.question, answer: "x" })), technical: [{ question: QUESTIONS[0].question, files: ["src/botao.tsx"] }] })).toBe("question_twice");
    expect(await code({ technical: [{ question: QUESTIONS[0].question, files: ["../segredo"] }], answers: [{ question: QUESTIONS[1].question, answer: "x" }] })).toBe("invalid_request");
    const other = await directorPlan();
    expect(body<{ error: { code: string } }>(await svc.prepare(handoffReq(other, "t1", { previousRunId: w.id, answers: [] }))).error.code).toBe("invalid_previous_run");
  });

  it("resposta sua e dúvida resolvida por leitura ficam identificadas, vinculadas e entram no envio; o anterior não muda", async () => {
    const { svc } = service([reply(clarify())]);
    const plan = await directorPlan();
    const w = await waitingRun(svc, plan);
    const before = JSON.stringify(await store.detail(w.id));
    const r = await svc.prepare(handoffReq(plan, "t1", {
      previousRunId: w.id,
      technical: [{ question: QUESTIONS[0].question, files: ["src/botao.tsx#Botao", "lib/inexistente.ts"] }],
      answers: [{ question: QUESTIONS[1].question, answer: "Não: só o plano, sem estados." }],
      decisions: [{ topic: "Nome do arquivo", answer: "plano-<id>.md" }],
    }));
    expect(r.status).toBe(201);
    const run = body<{ run: RunDetail }>(r).run;
    const snap = run.snapshot as ArchitectSnapshot;
    expect(run.previousRunId).toBe(w.id);
    expect(snap.revision).toMatchObject({ number: 2, previousRunId: w.id, changedCommit: false, commit: COMMIT });
    expect(snap.clarifications?.[0]).toMatchObject({ askedIn: w.id, resolution: { by: "reading", readFiles: ["src/botao.tsx"], missing: ["lib/inexistente.ts"], commit: COMMIT } });
    expect(snap.clarifications?.[1]).toMatchObject({ resolution: { by: "user", answer: "Não: só o plano, sem estados." } });
    expect(snap.previousAnalysis).toMatchObject({ runId: w.id, provisional: "Provisória: usar Blob." });
    expect(run.prompt?.user).toContain("→ Resposta do solicitante (usuário): Não: só o plano, sem estados.");
    expect(run.prompt?.user).toContain("→ Resolvida por leitura no commit");
    expect(run.prompt?.user).toContain("<decisoes_do_solicitante>");
    expect(run.prompt?.user).toContain("Fora do escopo:");
    expect(run.context?.kind === "github" && run.context.files.find(f => f.path === "src/botao.tsx")?.reason).toContain("pergunta 1 por leitura");
    expect(JSON.stringify(await store.detail(w.id))).toBe(before);
  });

  it("cliques repetidos no novo envio e na confirmação: um envio e uma chamada", async () => {
    const { svc, calls } = service([reply(clarify()), reply(analysis())]);
    const plan = await directorPlan();
    const w = await waitingRun(svc, plan);
    const req = () => handoffReq(plan, "t1", { previousRunId: w.id, answers: QUESTIONS.map(q => ({ question: q.question, answer: "sim" })) });
    const rs = await Promise.all([svc.prepare(req()), svc.prepare(req()), svc.prepare(req())]);
    expect(new Set(rs.map(r => body<{ run: RunDetail }>(r).run.id)).size).toBe(1);
    const run = body<{ run: RunDetail }>(rs[0]).run;
    await Promise.all([1, 2, 3].map(() => svc.approve(run.id, { snapshotHash: run.snapshotHash })));
    await svc.idle();
    expect(calls).toHaveLength(2);
    expect((await store.get(run.id))!.status).toBe("analysis_ready");
    expect((await store.get(w.id))!.status).toBe("awaiting_clarification");
  });

  it("o Arquiteto não pode repetir pergunta já respondida, salvo contradição declarada", async () => {
    const again = clarify({ questions: [{ question: "Qual arquivo implementa a janela de execução do Diretor, afinal?", why_it_blocks: "ainda não sei" }] });
    const contra = clarify({ questions: [{ question: "Qual arquivo implementa a janela de execução do Diretor?", why_it_blocks: "Contradição: a resposta cita run-dialog.tsx, mas o arquivo lido não tem a janela." }] });
    const { svc, calls } = service([reply(clarify()), reply(again), reply(contra)]);
    const plan = await directorPlan();
    const w = await waitingRun(svc, plan);
    const run = body<{ run: RunDetail }>(await svc.prepare(handoffReq(plan, "t1", { previousRunId: w.id, answers: QUESTIONS.map(q => ({ question: q.question, answer: "sim" })) }))).run;
    await svc.approve(run.id, { snapshotHash: run.snapshotHash });
    await svc.idle();
    expect(calls).toHaveLength(3);
    expect(calls[2].user).toContain("repete uma dúvida já resolvida");
    expect((await store.get(run.id))!.status).toBe("awaiting_clarification");
    expect(questionSimilarity(QUESTIONS[0].question, "Qual arquivo implementa a janela de execução do Diretor, afinal?")).toBeGreaterThanOrEqual(0.5);
  });
});

describe("tempo esgotado numa revisão", () => {
  it("falha com o limite explícito e uso desconhecido; a nova tentativa vira a revisão seguinte, ligada à mesma pergunta pendente", async () => {
    const { svc } = service([reply(clarify()), new AgentError("timeout", "O cliente não terminou dentro do tempo limite do executor.", true)]);
    const plan = await directorPlan();
    const w = await waitingRun(svc, plan);
    const req = () => handoffReq(plan, "t1", { previousRunId: w.id, answers: QUESTIONS.map(q => ({ question: q.question, answer: "sim" })) });
    const r2 = body<{ run: RunDetail }>(await svc.prepare(req())).run;
    await svc.approve(r2.id, { snapshotHash: r2.snapshotHash });
    await svc.idle();
    const failed = (await store.get(r2.id))!;
    expect(failed.error?.message).toMatch(/limite de \d+ min do executor/);
    expect(failed.error?.recovery?.join(" ")).toContain("consumo desta tentativa não é conhecido");
    expect(failed.budget.reportedTotalTokens).toBeNull();
    const r3 = body<{ run: RunDetail }>(await svc.prepare(req())).run;
    expect((r3.snapshot as ArchitectSnapshot).revision?.number).toBe(3);
    expect(r3.previousRunId).toBe(w.id);
    expect((await store.get(w.id))!.status).toBe("awaiting_clarification");
  });
});

describe("revisão de commit", () => {
  it("trocar o commit exige motivo e vira nova revisão; o envio aprovado anterior fica como estava", async () => {
    const log: string[] = [];
    const NEW = "d".repeat(40);
    const { svc } = service([reply(clarify())], { log });
    const plan = await directorPlan();
    const w = await waitingRun(svc, plan);
    const before = JSON.stringify(await store.detail(w.id));
    const base = { previousRunId: w.id, answers: QUESTIONS.map(q => ({ question: q.question, answer: "sim" })), source: { via: "github" as const, commit: NEW } };
    expect(body<{ error: { code: string } }>(await svc.prepare(handoffReq(plan, "t1", base))).error.code).toBe("revision_reason_required");
    const r = await svc.prepare(handoffReq(plan, "t1", { ...base, revisionReason: "O código citado está num commit mais novo." }));
    const run = body<{ run: RunDetail }>(r).run;
    expect((run.snapshot as ArchitectSnapshot).revision).toMatchObject({ number: 2, changedCommit: true, previousCommit: COMMIT, commit: NEW, via: "github", reason: "O código citado está num commit mais novo." });
    expect(log.some(u => u.includes(`/git/trees/${NEW}`))).toBe(true);
    expect(run.events.map(e => e.kind)).toContain("context_revision");
    expect(JSON.stringify(await store.detail(w.id))).toBe(before);
    expect(run.prompt?.user).toContain("<revisao_do_contexto>");
  });
});

describe("cópia local autorizada (somente leitura, Git real em pasta temporária)", { timeout: 30_000 }, () => {
  function makeRepo(root: string) {
    const dir = path.join(root, "clone");
    mkdirSync(dir);
    const g = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
    g("init", "-q", "-b", "main");
    g("remote", "add", "origin", "https://github.com/o/r.git");
    writeFileSync(path.join(dir, "package.json"), '{"name":"x"}');
    writeFileSync(path.join(dir, "README.md"), "# r");
    g("add", "."); g("commit", "-q", "-m", "base");
    const base = g("rev-parse", "HEAD");
    mkdirSync(path.join(dir, "components"), { recursive: true });
    writeFileSync(path.join(dir, "components", "run-dialog.tsx"), "export function DirectorBody() { return null }\n");
    g("add", "."); g("commit", "-q", "-m", "janela do diretor");
    const head = g("rev-parse", "HEAD");
    // A commit with no relation to the Director's history, created without touching the working tree.
    const emptyTree = execFileSync("git", ["-C", dir, "mktree"], { input: "", encoding: "utf8" }).trim();
    const orphan = g("commit-tree", emptyTree, "-m", "solta");
    // Uncommitted change: must never be read.
    writeFileSync(path.join(dir, "components", "run-dialog.tsx"), "ALTERACAO NAO COMMITADA");
    return { dir, base, head, orphan, status: () => g("status", "--porcelain") };
  }

  it("lê o commit local indicado, registra fonte, publicação e ascendência, sem alterar a cópia", async () => {
    const repo = makeRepo(work);
    const { svc } = service([reply(clarify())], { localRepos: [repo.dir] });
    const plan = await directorPlan(archPlan(), store, "plan_ready");
    // The fake Director read COMMIT; in this repo the Director commit is `base`.
    const detail = (await store.detail(plan))!;
    await store.update(plan, { context: { ...(detail.context as Extract<RunDetail["context"], { kind: "github" }>)!, commit: repo.base } });
    const w = await waitingRun(svc, plan);
    const statusBefore = repo.status();
    const hashBefore = hashOf("sha256").update(readFileSync(path.join(repo.dir, "components", "run-dialog.tsx"))).digest("hex");
    const r = await svc.prepare(handoffReq(plan, "t1", {
      previousRunId: w.id, revisionReason: "A janela só existe em commits locais não publicados.",
      source: { via: "local_git", commit: repo.head },
      technical: [{ question: QUESTIONS[0].question, files: ["components/run-dialog.tsx#DirectorBody"] }],
      answers: [{ question: QUESTIONS[1].question, answer: "Não." }],
    }));
    expect(r.status).toBe(201);
    const run = body<{ run: RunDetail }>(r).run;
    const ctx = run.context as Extract<RunDetail["context"], { kind: "github" }>;
    expect(ctx).toMatchObject({ via: "local_git", commit: repo.head, local: { dirName: "clone", published: false, isDescendant: true, descendantOf: repo.base } });
    expect(ctx.files.map(f => f.path)).toContain("components/run-dialog.tsx");
    expect(run.prompt?.user).toContain("export function DirectorBody()");
    expect(run.prompt?.user).not.toContain("ALTERACAO NAO COMMITADA");
    expect(JSON.stringify(run)).not.toContain(repo.dir.replace(/\\/g, "\\\\"));
    expect(repo.status()).toBe(statusBefore);
    expect(hashOf("sha256").update(readFileSync(path.join(repo.dir, "components", "run-dialog.tsx"))).digest("hex")).toBe(hashBefore);
    const st = await svc.status();
    expect(st.localRepos?.[0]).toMatchObject({ dirName: "clone", owner: "o", repo: "r" });
    expect(JSON.stringify(st.localRepos)).not.toContain(work.replace(/\\/g, "\\\\"));
  });

  it("recusa pasta não autorizada, commit fora da história do Diretor e origem diferente", async () => {
    const repo = makeRepo(work);
    const plan = await directorPlan();
    const detail = (await store.detail(plan))!;
    await store.update(plan, { context: { ...(detail.context as Extract<RunDetail["context"], { kind: "github" }>)!, commit: repo.base } });
    const none = service([reply(clarify())], { localRepos: [] });
    const w = await waitingRun(none.svc, plan);
    const req = (commit: string) => handoffReq(plan, "t1", { previousRunId: w.id, revisionReason: "teste", source: { via: "local_git", commit }, answers: QUESTIONS.map(q => ({ question: q.question, answer: "sim" })) });
    expect(body<{ error: { code: string } }>(await none.svc.prepare(req(repo.head))).error.code).toBe("local_not_authorized");
    const ok = service([], { localRepos: [repo.dir] });
    expect(body<{ error: { code: string } }>(await ok.svc.prepare(req(repo.orphan))).error.code).toBe("commit_not_descendant");
    execFileSync("git", ["-C", repo.dir, "remote", "set-url", "origin", "https://github.com/outro/repo.git"]);
    expect(body<{ error: { code: string } }>(await ok.svc.prepare(req(repo.head))).error.code).toBe("local_not_authorized");
  });
});

describe("contexto verificável e diagnóstico de tamanho", () => {
  it("arquivo grande vira lista de declarações + blocos relevantes com linhas", () => {
    const body = ["import x from \"y\";", "", ...Array.from({ length: 30 }, (_, i) => [`export function Parte${i}() {`, "  return " + "'x'".repeat(60) + ";", "}"]).flat(), "export function DirectorBody() {", "  return null;", "}"].join("\n");
    const ex = excerptFile(body, ["DirectorBody"], ["parte"], 3000);
    expect(ex.text).toContain("Declarações de nível superior (31)");
    expect(ex.text).toContain("DirectorBody (l.");
    expect(ex.symbols[0]).toBe("DirectorBody");
    // A symbol inside a block gets a window of lines, not the whole enclosing block.
    const inner = excerptFile(["export function Home() {", ...Array.from({ length: 80 }, (_, i) => `  const v${i} = ${i};`), "  const exportData = () => 1;", ...Array.from({ length: 80 }, (_, i) => `  const w${i} = ${i};`), "}"].join("\n"), ["exportData"], [], 5000);
    expect(inner.symbols).toEqual(["exportData"]);
    expect(inner.text).toContain("const exportData");
    expect(inner.text).not.toContain("const w70");
    const near = excerptFile(["export function useX() {", "  const a = 1;", "  const latestFor = () => a;", "  const taskRunsFor = () => a;", ...Array.from({ length: 60 }, (_, i) => `  const z${i} = ${i};`), "}"].join("\n"), ["latestFor", "taskRunsFor"], [], 5000);
    expect(near.ranges).toHaveLength(1);
    expect(near.text.match(/const latestFor/g)).toHaveLength(1);
    const withRefs = excerptFile(["type A = { b: B };", ...Array.from({ length: 40 }, () => "// ruído"), "type B = { x: number };", "type C = { y: string };", "export function useA(): A { return null as never }"].join("\n"), ["useA"], ["c"], 5000);
    expect(withRefs.symbols).toEqual(["useA", "A"]);
    const tests = excerptFile(['import { it } from "vitest";', 'describe("migração", () => {', '  it("mantém a ficha", () => {});', "});"].join("\n"), [], [], 5000);
    expect(tests.text).toContain("▸ migração (l.2)");
    expect(tests.text).toContain("· mantém a ficha (l.3)");
    expect(ex.ranges.some(([a, b]) => a <= 93 && b >= 92)).toBe(true);
  });
  it("composição por seção em caracteres, somando exatamente o texto montado", () => {
    const system = "PROTOCOLO\n\n=== FICHA DO ARQUITETO ===\nficha";
    const user = "<demanda>\nd\n</demanda>\n\n<dados_da_fonte>\nlista\n\n--- arquivo: a.ts ---\nabc\n</dados_da_fonte>\n\nfim";
    const c = promptComposition({ system, user }, 100);
    expect(c.total).toBe(system.length + user.length + 100);
    expect(c.parts.map(p => p.label)).toEqual(expect.arrayContaining(["Protocolo da execução (instruções)", "Ficha salva do colaborador (instruções)", "Demanda", "Arquivo: a.ts", "Esquema JSON da resposta (enviado como formato de saída)"]));
  });
  it("Claude Code: detalhe por requisição e turnos quando o cliente informa", () => {
    const u = claudeUsage({ type: "result", num_turns: 2, duration_ms: 1500, usage: { iterations: [{ input_tokens: 2, cache_creation_input_tokens: 1400, output_tokens: 70 }, { input_tokens: 1, cache_read_input_tokens: 1400, output_tokens: 5 }] }, modelUsage: { m: { inputTokens: 3, outputTokens: 75, cacheReadInputTokens: 1400, cacheCreationInputTokens: 1400 } } } as never, "x")!;
    expect(u.turns).toBe(2);
    expect(u.apiCalls).toEqual([{ inputTokens: 2, outputTokens: 70, cacheReadTokens: null, cacheWriteTokens: 1400 }, { inputTokens: 1, outputTokens: 5, cacheReadTokens: 1400, cacheWriteTokens: null }]);
  });
});

// ---- Task chain: an Architect task that depends on another, and the Developer preview (SIMULATED clients) ----
const chainPlan = () => archPlan({
  tasks: archPlan().tasks.map(t => (t.id === "t3" ? { ...t, depends_on: ["t2"], scope: "Criar src/serializador.ts e alterar src/botao.tsx" } : t)),
});
/** chainPlan plus a QA task (t5) depending on the Developer task (t3) — for testing the QA hand-off. */
const qaChainPlan = () => {
  const p = chainPlan();
  return { ...p, tasks: [...p.tasks, { id: "t5", step_id: "s2", assignee: "qa", title: "Verificar a entrega", scope: "Conferir o serializador contra os critérios", inputs: "t3", deliverable: "Parecer de QA", acceptance_criteria: ["Botão azul"], depends_on: ["t3"] }] };
};
const DECISION = { topic: "Formato", answer: "Mostrar o estado real de cada tarefa." };

/** t1 concluded (with a decision of the user recorded in its hand-off). */
async function chainWithT1(svc: ExecutorService) {
  const plan = await directorPlan(chainPlan());
  const t1 = body<{ run: RunDetail }>(await svc.prepare(handoffReq(plan, "t1", { decisions: [DECISION] }))).run;
  await svc.approve(t1.id, { snapshotHash: t1.snapshotHash });
  await svc.idle();
  return { plan, t1: (await store.detail(t1.id))! };
}

describe("tarefa dependente e prévia do Desenvolvedor", () => {
  it("opções de fonte: propõe o commit da análise da dependência e sugere os arquivos dela, sem criar registro", async () => {
    const { svc } = service([reply(analysis())]);
    const { plan, t1 } = await chainWithT1(svc);
    const before = await store.listForDemands([t1.demandId]);
    const o = body<SourceOptions>(await svc.sourceOptions(plan, "t2"));
    expect(o.proposed).toMatchObject({ commit: COMMIT, via: "github" });
    expect(o.dependencies).toEqual([expect.objectContaining({ taskId: "t1", runId: t1.id, commit: COMMIT })]);
    const refs = o.suggestedFiles.map(f => f.ref);
    expect(refs).toContain("src/botao.tsx#Botao");
    expect(refs).toContain("src/tema.ts");
    // "Editar src/botao.tsx" in the guidance does not add the bare path again.
    expect(refs).not.toContain("src/botao.tsx");
    expect(o.suggestedFiles.find(f => f.ref === "src/tema.ts")?.reason).toContain("inferido");
    expect(await store.listForDemands([t1.demandId])).toEqual(before);
    expect(body<{ error: { code: string } }>(await svc.sourceOptions("nao-e-uuid", "t2")).error.code).toBe("invalid_request");
  });

  it("envio de t2: leva a análise de t1 (uma vez, com commit e a decisão sua), só os arquivos confirmados, e não reaproveita a aprovação de t1", async () => {
    const { svc, calls } = service([reply(analysis()), reply(analysis({ recommendation: { summary: "Especificação do .md.", rationale: "Curta." } }))]);
    const { plan, t1 } = await chainWithT1(svc);
    const r = await svc.prepare(handoffReq(plan, "t2", { files: ["src/botao.tsx#Botao", "src/nao-existe.ts"] }));
    expect(r.status).toBe(201);
    const run = body<{ run: RunDetail }>(r).run;
    const snap = run.snapshot as ArchitectSnapshot;
    expect(snap.plan.dependsOn[0].analysis).toMatchObject({ runId: t1.id, commit: COMMIT, via: "github", decisions: [DECISION] });
    expect(snap.revision?.requestedFiles).toEqual([
      { ref: "src/botao.tsx#Botao", reason: `lido na análise de t1 (${t1.id.slice(0, 8)})` },
      { ref: "src/nao-existe.ts", reason: "indicado por você no preparo do envio" },
    ]);
    const u = run.prompt!.user;
    expect(u).toContain("<analises_das_dependencias>");
    expect(u.split("Adicionar a classe azul no Botao.").length - 1).toBe(1);
    expect(u).toContain("Decisões do solicitante registradas nesse envio (valem como decisão do usuário):\n- Formato: Mostrar o estado real de cada tarefa.");
    expect(run.prompt!.system).toContain("13. <analises_das_dependencias>");
    const ctx = run.context as Extract<RunDetail["context"], { kind: "github" }>;
    // Explicit files: the confirmed ones plus the task's own citations; no manifest, no name heuristic.
    expect(ctx.files.map(f => f.path).sort()).toEqual(["src/botao.tsx", "src/estilo.css"]);
    expect(ctx.skipped.map(s => s.path)).toContain("src/nao-existe.ts");
    expect(run.events.map(e => e.kind)).toContain("requested_files");
    // The approval of another run is not valid here.
    expect((await svc.approve(run.id, { snapshotHash: t1.snapshotHash })).status).toBe(409);
    expect((await store.get(run.id))!.status).toBe("awaiting_approval");
    await svc.approve(run.id, { snapshotHash: run.snapshotHash });
    await svc.idle();
    expect(calls).toHaveLength(2);
    expect((await store.get(run.id))!.status).toBe("analysis_ready");
    expect((await store.get(t1.id))!.status).toBe("analysis_ready");
  });

  it("prévia do Desenvolvedor: bloqueada até todas as dependências (inclusive indiretas); depois, só visualização com estados reais", async () => {
    const { svc, calls } = service([reply(analysis()), reply(analysis({ recommendation: { summary: "Criar src/serializador.ts puro, sem alterar src/tipos.ts.", rationale: "Especificar (sem implementar) o uso dos campos já validados (src/contrato.ts, confirmados)." }, developer_guidance: ["Criar src/serializador.ts", "Alterar src/botao.tsx", "Antes de implementar, ler src/estilo.css"] }))]);
    const { plan } = await chainWithT1(svc);
    const tasks = chainPlan().tasks;
    const runsOf = (id: string) => (id === "t1" ? [{ status: "analysis_ready" }] : []) as never;
    expect(dependencyBlocker(tasks.find(t => t.id === "t3")!, tasks, runsOf, () => [])).toContain("t2");
    const early = body<{ preview: DeveloperPreview }>(await svc.developerPreview(plan, "t3")).preview;
    expect(early.eligible).toBe(false);
    expect(early.blockers.join(" ")).toContain("t2");
    expect(body<{ error: { code: string } }>(await svc.developerPreview(plan, "t1")).error.code).toBe("not_developer_task");

    const t2 = body<{ run: RunDetail }>(await svc.prepare(handoffReq(plan, "t2"))).run;
    await svc.approve(t2.id, { snapshotHash: t2.snapshotHash });
    await svc.idle();
    expect(dependencyBlocker(tasks.find(t => t.id === "t3")!, tasks, (id: string) => (id === "t1" || id === "t2") ? ([{ status: "analysis_ready" }] as never) : [], () => [])).toBeNull();
    const runsBefore = await store.listForDemands([t2.demandId]);
    const p = body<{ preview: DeveloperPreview }>(await svc.developerPreview(plan, "t3")).preview;
    expect(p.eligible).toBe(true);
    expect(p.analyses.map(a => a.taskId)).toEqual(["t2", "t1"]);
    expect(p.analyses[1].decisions).toEqual([DECISION]);
    expect(p.base.proposed).toMatchObject({ commit: COMMIT });
    // t3 (Developer) now has its own hand-off flow: "proposed" (executable), not "not_executable".
    expect(p.tasks.find(t => t.id === "t3")).toMatchObject({ relation: "esta tarefa", state: "proposed" });
    expect(p.tasks.find(t => t.id === "t2")).toMatchObject({ relation: "dependência direta", state: "analysis_ready", runId: t2.id });
    expect(p.tasks.find(t => t.id === "t1")).toMatchObject({ relation: "dependência indireta", state: "analysis_ready" });
    expect(p.tasks.find(t => t.id === "t4")).toMatchObject({ relation: "depende desta" });
    expect(p.editScope.map(e => e.path)).toEqual(expect.arrayContaining(["src/serializador.ts", "src/botao.tsx"]));
    expect(p.editScope.find(e => e.path === "src/estilo.css")?.action).toBe("consultar"); // "ler" before the path: read, not edit
    expect(p.editScope.find(e => e.path === "src/serializador.ts")?.action).toBe("a confirmar");
    // Cited without an edit verb right before it, or after "sem": only consulted.
    expect(p.editScope.find(e => e.path === "src/tipos.ts")?.action).toBe("consultar");
    expect(p.editScope.find(e => e.path === "src/contrato.ts")?.action).toBe("consultar");
    expect(p.unverified.some(x => x.source.startsWith("inferido") && x.text.includes("src/tema.ts"))).toBe(true);
    // Same states in the Markdown copy as on screen (both come from taskState of the executor's records).
    const md = developerPreviewMarkdown(p);
    for (const t of p.tasks) expect(md).toContain(`| ${t.id} · ${t.title} | ${t.assigneeName} | ${t.relation} | ${TASK_STATE_LABEL[t.state]}`);
    expect(md).toContain("não concede acesso de escrita");
    // A view only: no run recorded, no client called, nothing changed.
    expect(await store.listForDemands([t2.demandId])).toEqual(runsBefore);
    expect(calls).toHaveLength(2);
  });

  it("sugestões e referências: caminho com símbolo, sem duplicar o caminho puro, sem ..", () => {
    expect(extractFileRefs("Ler lib/engine/types.ts#RunRecord e lib/utils.ts (ex.: lib/utils.ts#downloadTextFile); ../x/y.ts não")).toEqual(["lib/engine/types.ts#RunRecord", "lib/utils.ts", "lib/utils.ts#downloadTextFile"]);
    const a = { runId: "r".repeat(36), revision: 1, commit: COMMIT, via: "github" as const, understanding: "", recommendation: { summary: "", rationale: "" }, guidance: ["Editar lib/a.ts"], risks: [], assumptions: [], notVerified: ["lib/b.ts l.1-9 não lido"], examined: [{ ref: "lib/a.ts#A", basis: "read" as const }], decisions: [], omitted: { guidance: 0, risks: 0, assumptions: 0, notVerified: 0, examined: 0 } };
    expect(suggestFiles([{ taskId: "t1", analysis: a }]).map(x => x.ref)).toEqual(["lib/a.ts#A", "lib/b.ts"]);
  });
});

describe("\"lido\" em arquivo enviado só em trecho", () => {
  it("um símbolo que só aparece na lista de declarações não pode ser marcado como lido", () => {
    const user = [
      "<fonte>x</fonte>", "", "<dados_da_fonte>", "Descrição do repositório: x", "",
      "--- arquivo: lib/t.ts (trecho verificável: l.1-3 de 40 linhas; commit cccccccccccc) ---",
      "Declarações de nível superior (2): A (l.1), RunRecord (l.20)", "", "[linhas 1-3 · A]", "export type A = {", "  x: number;", "};",
      "", "--- arquivo: lib/inteiro.ts ---", "export const B = 1;", "</dados_da_fonte>",
    ].join("\n");
    const files = [{ path: "lib/t.ts", truncated: true }, { path: "lib/inteiro.ts", truncated: false }];
    const partial = partialTexts(user, files);
    expect(Object.keys(partial)).toEqual(["lib/t.ts"]);
    expect(partial["lib/t.ts"]).not.toContain("RunRecord");
    const mk = (ref: string) => analysis({ examined: [{ ref, kind: "symbol", basis: "read", note: "" }] });
    const read = ["lib/t.ts", "lib/inteiro.ts"];
    expect(validateAnalysis(mk("lib/t.ts#A"), read, [], partial).ok).toBe(true);
    expect(validateAnalysis(mk("lib/inteiro.ts#Qualquer"), read, [], partial).ok).toBe(true);
    const bad = validateAnalysis(mk("lib/t.ts#RunRecord"), read, [], partial);
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.errors[0]).toContain("só em trecho");
    expect(validateAnalysis(analysis({ examined: [{ ref: "lib/t.ts#RunRecord", kind: "symbol", basis: "inferred", note: "" }] }), read, [], partial).ok).toBe(true);
  });
});

describe("primeiro envio numa cópia local, comparado com o commit do Diretor (Git real)", { timeout: 30_000 }, () => {
  it("registra arquivos confirmados e a comparação arquivo a arquivo; o evento não fala de envio anterior inexistente", async () => {
    const dir = path.join(work, "clone");
    mkdirSync(dir);
    const g = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
    g("init", "-q", "-b", "main"); g("remote", "add", "origin", "https://github.com/o/r.git");
    writeFileSync(path.join(dir, "package.json"), '{"name":"x"}');
    mkdirSync(path.join(dir, "src"));
    writeFileSync(path.join(dir, "src", "estilo.css"), ".a{}");
    g("add", "."); g("commit", "-q", "-m", "base");
    const base = g("rev-parse", "HEAD");
    writeFileSync(path.join(dir, "src", "botao.tsx"), "export const Botao = () => null\n");
    writeFileSync(path.join(dir, "src", "estilo.css"), ".a{color:blue}");
    g("add", "."); g("commit", "-q", "-m", "botao");
    const head = g("rev-parse", "HEAD");
    const { svc } = service([], { localRepos: [dir] });
    const plan = await directorPlan();
    const detail = (await store.detail(plan))!;
    await store.update(plan, { context: { ...(detail.context as Extract<RunDetail["context"], { kind: "github" }>)!, commit: base } });
    const statusBefore = g("status", "--porcelain");
    const o = body<SourceOptions>(await svc.sourceOptions(plan, "t1"));
    expect(o.localRepos[0]).toMatchObject({ dirName: "clone", head });
    const req = handoffReq(plan, "t1", { source: { via: "local_git", commit: head }, files: ["src/botao.tsx#Botao"] });
    expect(body<{ error: { code: string } }>(await svc.prepare(req)).error.code).toBe("revision_reason_required");
    const run = body<{ run: RunDetail }>(await svc.prepare({ ...req, revisionReason: "O botão só existe no commit local." })).run;
    const rev = (run.snapshot as ArchitectSnapshot).revision!;
    expect(rev).toMatchObject({ number: 1, previousRunId: null, previousCommit: base, commit: head, via: "local_git", changedCommit: true });
    expect(rev.comparisons?.[0]).toMatchObject({ from: { commit: base, label: "commit do Diretor" }, to: { commit: head }, relation: "descendant", changedTotal: 2 });
    expect(rev.comparisons?.[0].files).toEqual([{ path: "src/botao.tsx", atFrom: false, atTo: true, changed: true }]);
    const ev = run.events.find(e => e.kind === "context_revision")!;
    expect(ev.message).toContain("Primeiro envio desta tarefa");
    expect(ev.message).not.toContain("undefined");
    expect(run.prompt!.user).toContain("Primeiro envio desta tarefa, em um commit diferente do que o Diretor leu");
    expect(run.prompt!.user).toContain("não existiam lá: src/botao.tsx");
    expect(g("status", "--porcelain")).toBe(statusBefore);
  });
});

// ---- Developer: prepare/approve, real isolated copy (Git + tar), real diff, scope enforcement ----
import { existsSync } from "node:fs";
import type { DeveloperResult, QAResult, QASnapshot } from "@/lib/engine/types";

const developerSheet = (over = {}) => member("developer", { connection: "claude_code", tools: { read: true, edit: true, terminal: false }, brief: "# Desenvolvedor\nFicha salva do Desenvolvedor.", budget: 48000, ...over });
// Matches what chainPlan's t3 (and archPlan's t3, same repo fixture) really has in makeDevRepo(): src/botao.tsx
// exists (alterar), src/serializador.ts does not yet (criar) — the same pair the old auto-inference used to
// derive from the Architect's guidance text. Explicit now: the caller states it, prepareDeveloperHandoff no
// longer infers it from that text (see "Desenvolvedor: escopo de edição escolhido explicitamente" below).
const devEditScope = [{ path: "src/serializador.ts", action: "criar" as const }, { path: "src/botao.tsx", action: "alterar" as const }];
const devReq = (planId: string, taskId = "t3", over = {}) => ({ idempotencyKey: `h:${Math.random().toString(36).slice(2, 12)}`, directorRunId: planId, taskId, agent: developerSheet(), editScope: devEditScope, ...over });

const devResult = (over: Partial<DeveloperResult> = {}): DeveloperResult => ({
  outcome: "done", summary: "Criado o serializador e ajustado o botão.",
  changes: [{ path: "src/serializador.ts", action: "created", reason: "Novo módulo puro pedido pela tarefa." }, { path: "src/botao.tsx", action: "modified", reason: "Usa o novo serializador." }],
  acceptance: [{ criterion: "Azul", status: "met", note: "Classe aplicada." }],
  questions: [], not_verified: [], assumptions: [], ...over,
});

/** A real, local repo with the files chainPlan's Architect guidance cites (src/estilo.css, src/botao.tsx). */
function makeDevRepo(root: string) {
  const dir = path.join(root, "devclone");
  mkdirSync(dir);
  const g = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
  g("init", "-q", "-b", "main");
  g("remote", "add", "origin", "https://github.com/o/r.git");
  writeFileSync(path.join(dir, "package.json"), '{"name":"x"}');
  mkdirSync(path.join(dir, "src"));
  writeFileSync(path.join(dir, "src", "estilo.css"), ".a{}");
  writeFileSync(path.join(dir, "src", "botao.tsx"), "export const Botao = () => null\n");
  g("add", "."); g("commit", "-q", "-m", "base");
  const base = g("rev-parse", "HEAD");
  return { dir, base, status: () => g("status", "--porcelain") };
}

/**
 * chainPlan (t3 developer ← t2 architect ← t1 architect), both Architect analyses done for REAL against
 * `repo.base`, using their own scripted service (kept apart from whatever service the caller tests the
 * Developer hand-off with). Shares `s` so the resulting rows are visible to the caller's own service.
 */
async function localChainWithAnalyses(repo: { dir: string; base: string }, s: RunStore, plan_ = chainPlan()) {
  const { svc } = service(
    [reply(analysis()), reply(analysis({ recommendation: { summary: "Serializador puro, sem alterar tipos.", rationale: "Menor risco, mais fácil de testar." }, developer_guidance: ["Criar src/serializador.ts", "Alterar src/botao.tsx"] }))],
    { s, localRepos: [repo.dir] },
  );
  const plan = await directorPlan(plan_, s, "plan_ready");
  const detail = (await s.detail(plan))!;
  await s.update(plan, { context: { ...(detail.context as Extract<RunDetail["context"], { kind: "github" }>)!, commit: repo.base } });
  const local = { via: "local_git" as const, commit: repo.base };
  const t1 = body<{ run: RunDetail }>(await svc.prepare({ ...handoffReq(plan, "t1", { decisions: [DECISION] }), source: local, revisionReason: "Ler do commit local real (teste)." })).run;
  await svc.approve(t1.id, { snapshotHash: t1.snapshotHash });
  await svc.idle();
  const t2 = body<{ run: RunDetail }>(await svc.prepare({ ...handoffReq(plan, "t2"), source: local, revisionReason: "Ler do commit local real (teste)." })).run;
  await svc.approve(t2.id, { snapshotHash: t2.snapshotHash });
  await svc.idle();
  return { plan, t1: (await s.detail(t1.id))!, t2: (await s.detail(t2.id))! };
}

describe("Desenvolvedor: comandos e caminhos permitidos (verificação real dos argumentos do cliente, sem chamada)", () => {
  it("modo developer_write concede só Read/Edit/Write/Glob/Grep, confina ao --restricted e nega Bash/PowerShell/rede/subagente", () => {
    const args = claudeArgs({ mode: "developer_write", schema: {}, label: "x", system: "s", user: "u", model: "", effort: "", timeoutMs: 1, workDir: "w" }, "sys.txt");
    expect(args).toContain("--restricted");
    expect(args.join(" ")).toContain("--allowedTools Read Edit Write Glob Grep");
    const disallowed = args.slice(args.indexOf("--disallowedTools") + 1, args.indexOf("--permission-mode"));
    for (const tool of ["Bash", "PowerShell", "NotebookEdit", "WebFetch", "WebSearch", "Task"]) expect(disallowed).toContain(tool);
    expect(disallowed).not.toContain("Edit");
    expect(args).not.toContain("--tools"); // "--tools \"\"" (no tools at all) is the READ-ONLY (Architect) flag, not used here
    expect(args).toContain("--safe-mode");
    expect(args).toContain("acceptEdits");
  });
  it("modo padrão (Arquiteto) continua sem nenhuma ferramenta, inalterado", () => {
    const args = claudeArgs({ schema: {}, label: "x", system: "s", user: "u", model: "", effort: "", timeoutMs: 1, workDir: "w" }, "sys.txt");
    expect(args).toContain("--tools");
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args).not.toContain("--restricted");
  });
});

describe("Adaptadores: o arquivo de apoio do cliente (prompt de sistema / schema) nunca vai para dentro de workDir quando há scratchDir", () => {
  const inv = { command: "cliente-fake", prefix: [], source: "cliente-fake" };
  const okRunner: Runner = async () => ({
    code: 0, stdout: JSON.stringify({ type: "result", is_error: false, structured_output: { ok: true }, result: JSON.stringify({ ok: true }) }),
    stderr: "", timedOut: false, aborted: false, truncated: false, spawnError: null,
  });
  // Bug corrigido: antes, claude.ts/codex.ts escreviam o arquivo de apoio direto em c.workDir — inofensivo para
  // o Arquiteto (workDir nunca é diffado), mas para o Desenvolvedor esse MESMO workDir é a cópia isolada que
  // diffWorktree() depois compara com o commit base, então o arquivo aparecia como uma edição fora do escopo
  // em toda chamada, independente do que o modelo fizesse (caso real: task-3, execução 352a1344, 28/09/2026).
  it("claude: com scratchDir definido, system-prompt.txt vai só para scratchDir", async () => {
    const workDir = path.join(work, "copia-isolada"); mkdirSync(workDir);
    const scratchDir = path.join(work, "copia-isolada.prompt"); mkdirSync(scratchDir);
    await claudeAdapter(inv, okRunner).call({ label: "x", system: "PROMPT-DE-SISTEMA", user: "u", schema: {}, model: "", effort: "", timeoutMs: 1000, workDir, scratchDir, mode: "developer_write" });
    expect(existsSync(path.join(workDir, "system-prompt.txt"))).toBe(false);
    expect(readFileSync(path.join(scratchDir, "system-prompt.txt"), "utf8")).toBe("PROMPT-DE-SISTEMA");
  });
  it("claude: sem scratchDir (Arquiteto), cai de volta em workDir — comportamento antigo preservado", async () => {
    const workDir = path.join(work, "pasta-vazia"); mkdirSync(workDir);
    await claudeAdapter(inv, okRunner).call({ label: "x", system: "PROMPT", user: "u", schema: {}, model: "", effort: "", timeoutMs: 1000, workDir });
    expect(readFileSync(path.join(workDir, "system-prompt.txt"), "utf8")).toBe("PROMPT");
  });
  it("codex: com scratchDir definido, output-schema.json vai só para scratchDir", async () => {
    const workDir = path.join(work, "copia-isolada-codex"); mkdirSync(workDir);
    const scratchDir = path.join(work, "copia-isolada-codex.prompt"); mkdirSync(scratchDir);
    const codexRunner: Runner = async () => ({ code: 0, stdout: "", stderr: "", timedOut: false, aborted: false, truncated: false, spawnError: null });
    await codexAdapter(inv, codexRunner).call({ label: "x", system: "s", user: "u", schema: { type: "object" }, model: "", effort: "", timeoutMs: 1000, workDir, scratchDir }).catch(() => {}); // empty stdout fails parsing; only the file placement is under test
    expect(existsSync(path.join(workDir, "output-schema.json"))).toBe(false);
    expect(JSON.parse(readFileSync(path.join(scratchDir, "output-schema.json"), "utf8"))).toEqual({ type: "object" });
  });
});

describe("redactSecrets: o diff nunca guarda um segredo reconhecível, mas não mutila código comum", () => {
  it("apaga padrões reconhecíveis de credencial", () => {
    expect(redactSecrets('const k = "AKIAABCDEFGHIJ12345K";')).not.toContain("AKIAABCDEFGHIJ12345K");
    expect(redactSecrets("const k = 'sk-ant-" + "b".repeat(30) + "';")).not.toContain("b".repeat(30));
    expect(redactSecrets("const t = 'ghp_" + "c".repeat(30) + "';")).not.toContain("c".repeat(30));
    expect(redactSecrets("Authorization: Bearer abcdef0123456789ghij")).not.toContain("abcdef0123456789ghij");
    expect(redactSecrets('API_KEY = "abcdefghij123456"')).toBe('API_KEY = "[REDACTED]"');
    expect(redactSecrets("-----BEGIN PRIVATE KEY-----\nZm9v\n-----END PRIVATE KEY-----")).not.toContain("Zm9v");
  });
  it("não mexe em código comum sem nada que pareça credencial", () => {
    const code = "export function soma(a: number, b: number) { return a + b; }\nconst token = 1;\n";
    expect(redactSecrets(code)).toBe(code);
  });
});

describe("Desenvolvedor: preparar o envio (nada é construído ou chamado)", { timeout: 30_000 }, () => {
  it("recusa quando as dependências (Arquiteto) não estão concluídas", async () => {
    const { svc } = service([reply(analysis())]);
    const { plan } = await chainWithT1(svc); // only t1 done; t2 still pending
    const r = await svc.prepareDeveloper(devReq(plan, "t3"));
    expect(body<{ error: { code: string; details?: string[] } }>(r).error).toMatchObject({ code: "dependency_pending" });
  });
  it("recusa conexão diferente de Claude Code e ficha sem permissão de editar", async () => {
    const repo = makeDevRepo(work);
    const { plan } = await localChainWithAnalyses(repo, store);
    const { svc } = service([], { s: store, localRepos: [repo.dir] });
    // Blocked earlier, at the service's connection gate (WRITE_RESTRICTED), before prepareDeveloperHandoff's own redundant check ever runs.
    expect(body<{ error: { code: string } }>(await svc.prepareDeveloper(devReq(plan, "t3", { agent: developerSheet({ connection: "codex" }) }))).error.code).toBe("adapter_not_write_restricted");
    expect(body<{ error: { code: string } }>(await svc.prepareDeveloper(devReq(plan, "t3", { agent: developerSheet({ tools: { read: true, edit: false } }) }))).error.code).toBe("no_write_permission");
  });
  it("congela a revisão sem criar cópia de trabalho nem chamar o cliente; recusa sem cópia local autorizada", async () => {
    const repo = makeDevRepo(work);
    const { plan } = await localChainWithAnalyses(repo, store);
    const unauthorized = service([], { s: store, localRepos: [] });
    expect(body<{ error: { code: string } }>(await unauthorized.svc.prepareDeveloper(devReq(plan, "t3"))).error.code).toBe("local_not_authorized");
    const { svc, calls } = service([], { s: store, localRepos: [repo.dir] });
    const r = await svc.prepareDeveloper(devReq(plan, "t3"));
    expect(r.status).toBe(201);
    const run = body<{ run: RunDetail }>(r).run;
    expect(run.status).toBe("awaiting_approval");
    const snap = run.snapshot as { base: { commit: string; owner: string; repo: string; dirName: string }; editScope: { path: string; action: string }[]; tools: { label: string; allowed: boolean }[] };
    expect(snap.base).toMatchObject({ commit: repo.base, owner: "o", repo: "r", dirName: "devclone" });
    expect(snap.editScope.filter(e => e.action !== "consultar").map(e => e.path).sort()).toEqual(["src/botao.tsx", "src/serializador.ts"]);
    const tool = (label: string) => snap.tools.find(t => t.label === label)!;
    expect(tool("Criar, editar e remover arquivos").allowed).toBe(true);
    expect(tool("Terminal / comandos").allowed).toBe(false);
    expect(run.prompt!.user).toContain("<escopo_de_edicao>");
    expect(run.prompt!.user).not.toContain("<dados_da_fonte>"); // no file content is pasted — the Developer reads the copy itself
    expect(JSON.stringify(run)).not.toContain(repo.dir.replace(/\\/g, "\\\\")); // no full local path leaked
    // Nothing built, nothing called yet.
    expect(existsSync(path.join(work, run.id))).toBe(false);
    await svc.idle();
    expect(calls).toHaveLength(0);
    expect(repo.status()).toBe(""); // the source repo's working tree is untouched
  });
  it("cliques repetidos preparando o mesmo envio: um único registro", async () => {
    const repo = makeDevRepo(work);
    const { plan } = await localChainWithAnalyses(repo, store);
    const { svc } = service([], { s: store, localRepos: [repo.dir] });
    const [a, b, c] = await Promise.all([svc.prepareDeveloper(devReq(plan, "t3")), svc.prepareDeveloper(devReq(plan, "t3")), svc.prepareDeveloper(devReq(plan, "t3"))]);
    const ids = new Set([a, b, c].map(r => body<{ run: RunDetail }>(r).run.id));
    expect(ids.size).toBe(1);
  });
});

describe("Desenvolvedor: escopo de edição escolhido explicitamente (nunca inferido da sugestão do Arquiteto)", { timeout: 30_000 }, () => {
  it("recusa corpo sem editScope (campo agora obrigatório na validação de entrada)", async () => {
    const repo = makeDevRepo(work);
    const { plan } = await localChainWithAnalyses(repo, store);
    const { svc } = service([], { s: store, localRepos: [repo.dir] });
    const { editScope, ...noScope } = devReq(plan, "t3");
    void editScope;
    const r = await svc.prepareDeveloper(noScope);
    expect(r.status).toBe(400);
  });

  it("recusa quando nenhum caminho é marcado para alterar/criar (só consultar não autoriza nada)", async () => {
    const repo = makeDevRepo(work);
    const { plan } = await localChainWithAnalyses(repo, store);
    const { svc } = service([], { s: store, localRepos: [repo.dir] });
    const r = await svc.prepareDeveloper(devReq(plan, "t3", { editScope: [{ path: "src/botao.tsx", action: "consultar" }] }));
    expect(body<{ error: { code: string } }>(r).error.code).toBe("no_edit_scope");
  });

  it("valida que um caminho marcado \"alterar\" ou \"consultar\" existe de verdade no commit escolhido — recusa se não existir", async () => {
    const repo = makeDevRepo(work);
    const { plan } = await localChainWithAnalyses(repo, store);
    const { svc } = service([], { s: store, localRepos: [repo.dir] });
    const r = await svc.prepareDeveloper(devReq(plan, "t3", { editScope: [{ path: "src/nao-existe.ts", action: "alterar" }] }));
    const err = body<{ error: { code: string; details?: string[] } }>(r).error;
    expect(err.code).toBe("path_not_found");
    expect(err.details).toContain("src/nao-existe.ts");
  });

  it("um caminho marcado \"criar\" não precisa existir no commit — passa mesmo sem estar na árvore", async () => {
    const repo = makeDevRepo(work);
    const { plan } = await localChainWithAnalyses(repo, store);
    const { svc } = service([], { s: store, localRepos: [repo.dir] });
    const r = await svc.prepareDeveloper(devReq(plan, "t3", { editScope: [{ path: "src/novo-arquivo-que-nao-existe.ts", action: "criar" }] }));
    expect(r.status).toBe(201);
    const snap = body<{ run: RunDetail }>(r).run.snapshot as { editScope: { path: string; action: string }[] };
    expect(snap.editScope).toEqual([{ path: "src/novo-arquivo-que-nao-existe.ts", action: "criar", from: ["Selecionado por você na revisão do envio."] }]);
  });

  it("recusa caminho repetido no escopo de edição", async () => {
    const repo = makeDevRepo(work);
    const { plan } = await localChainWithAnalyses(repo, store);
    const { svc } = service([], { s: store, localRepos: [repo.dir] });
    const r = await svc.prepareDeveloper(devReq(plan, "t3", { editScope: [{ path: "src/botao.tsx", action: "alterar" }, { path: "src/botao.tsx", action: "consultar" }] }));
    expect(body<{ error: { code: string } }>(r).error.code).toBe("duplicate_path");
  });

  it("a sugestão do Arquiteto/tarefa fica só como suggestedEditScope, informativa — um caminho que ela cita mas o usuário não escolheu NÃO fica autorizado", async () => {
    const repo = makeDevRepo(work);
    const { plan } = await localChainWithAnalyses(repo, store); // t2's guidance mentions src/serializador.ts and src/botao.tsx
    const { svc } = service([], { s: store, localRepos: [repo.dir] });
    // The user explicitly authorizes ONLY src/estilo.css (present in the repo, never mentioned by the Architect at all) to consult.
    const r = await svc.prepareDeveloper(devReq(plan, "t3", { editScope: [{ path: "src/estilo.css", action: "consultar" }, { path: "src/serializador.ts", action: "criar" }] }));
    expect(r.status).toBe(201);
    const snap = body<{ run: RunDetail }>(r).run.snapshot as {
      editScope: { path: string; action: string }[];
      suggestedEditScope: { path: string; action: string }[];
    };
    // Real, enforced authorization: exactly what was chosen — src/botao.tsx is NOT there, even though the
    // Architect's own guidance (reused by localChainWithAnalyses) recommends changing it.
    expect(snap.editScope.map(e => e.path).sort()).toEqual(["src/estilo.css", "src/serializador.ts"]);
    expect(snap.editScope.find(e => e.path === "src/botao.tsx")).toBeUndefined();
    // The suggestion is still shown (transparency), but it is a different field, never merged into editScope.
    expect(snap.suggestedEditScope.some(e => e.path === "src/botao.tsx")).toBe(true);
  });

  // The exact real-world scenario (plan d1618429, task T2, commit 5272e1f0e5a486f85d15340ec5675c6272f09933,
  // editScope = run-dialog.tsx:alterar + plan-markdown.ts:consultar) was verified live against the real
  // running executor and the real plan instead of a synthetic fixture here — see the session report: it
  // reproduced the original "no_edit_scope" failure's exact cause (the old heuristic classified every cited
  // path, including run-dialog.tsx, as "consultar") and confirmed the explicit editScope fixes it, without
  // ever calling a model, then canceled that test hand-off so the user's own selection is what they confirm.
});

describe("Desenvolvedor: aprovação, execução real (materializada) e diff", { timeout: 30_000 }, () => {
  it("divergência no momento da confirmação: hash diferente é recusado; aprovação dupla enfileira uma única vez", async () => {
    const repo = makeDevRepo(work);
    const { plan } = await localChainWithAnalyses(repo, store);
    // No real edits reported: matches the (also empty) real diff, so this validates cleanly on the first attempt —
    // the point of this test is approval de-dup, not the outcome.
    const { svc, calls } = service([reply(devResult({ changes: [] }), usage())], { s: store, localRepos: [repo.dir] });
    const run = body<{ run: RunDetail }>(await svc.prepareDeveloper(devReq(plan, "t3"))).run;
    expect((await svc.approve(run.id, { snapshotHash: "outro" })).status).toBe(409);
    const [x, y] = await Promise.all([svc.approve(run.id, { snapshotHash: run.snapshotHash }), svc.approve(run.id, { snapshotHash: run.snapshotHash })]);
    expect([x, y].filter(r => body<{ approved: boolean }>(r).approved)).toHaveLength(1);
    await svc.idle();
    expect(calls).toHaveLength(1);
    expect((await store.get(run.id))!.status).toBe("implementation_ready");
  });

  it("execução real (Claude Code simulado, escrita de verdade na cópia isolada): materializa, valida e calcula o diff — nada toca o repositório de origem", async () => {
    const repo = makeDevRepo(work);
    const { plan } = await localChainWithAnalyses(repo, store);
    let seenWorkDir = "", seenScratchDir = "";
    const { svc, calls } = service(
      [async (c: AgentCall) => {
        seenWorkDir = c.workDir; seenScratchDir = c.scratchDir!;
        expect(c.mode).toBe("developer_write");
        // Simulates the model's Edit/Write tool: real writes, confined by the real client's own flags (not by this test).
        expect(existsSync(path.join(c.workDir, "src", "botao.tsx"))).toBe(true);
        expect(existsSync(path.join(c.workDir, ".git"))).toBe(true); // the throwaway diff-base repo, not the real project's
        expect(existsSync(path.join(c.workDir, "node_modules"))).toBe(false);
        // Regression check for the real task-3 failure (28/09/2026): the planner must hand the Developer a
        // scratchDir separate from the isolated copy, so the client's own support files never pollute the diff.
        expect(c.scratchDir).toBeTruthy();
        expect(c.scratchDir).not.toBe(c.workDir);
        writeFileSync(path.join(c.workDir, "src", "serializador.ts"), "export const toMarkdown = () => \"\";\n");
        writeFileSync(path.join(c.workDir, "src", "botao.tsx"), "export const Botao = () => null // usa o serializador\n");
        return reply(devResult());
      }],
      { s: store, localRepos: [repo.dir] },
    );
    const run = body<{ run: RunDetail }>(await svc.prepareDeveloper(devReq(plan, "t3"))).run;
    await svc.approve(run.id, { snapshotHash: run.snapshotHash });
    await svc.idle();
    expect(calls).toHaveLength(1); // one call: no false out-of-scope violation, no wasted correction attempt
    const done = (await store.detail(run.id))!;
    expect(done.status).toBe("implementation_ready");
    const dev = done.developer!;
    expect(dev.diff!.outOfScope).toEqual([]);
    const byPath = Object.fromEntries(dev.diff!.files.map(f => [f.path, f]));
    expect(byPath["src/serializador.ts"]).toMatchObject({ status: "added", inScope: true });
    expect(byPath["src/botao.tsx"]).toMatchObject({ status: "modified", inScope: true });
    expect(dev.diff!.files.map(f => f.path)).not.toContain("system-prompt.txt"); // the regression itself
    expect(dev.changes.map(c => c.path).sort()).toEqual(["src/botao.tsx", "src/serializador.ts"]);
    expect(dev.limitations.join(" ")).toContain("Nenhum comando foi executado");
    // Isolation, proven for real: the isolated copy AND the scratch dir are gone, and the SOURCE repo was never touched.
    expect(existsSync(seenWorkDir)).toBe(false);
    expect(existsSync(seenScratchDir)).toBe(false);
    expect(repo.status()).toBe("");
    expect(existsSync(path.join(repo.dir, "src", "serializador.ts"))).toBe(false);
  });

  it("pedido adversarial: escreve fora do escopo aprovado dentro da própria cópia — reprovado pelo diff real, não pelo que o modelo relata; o diff rejeitado fica gravado (com segredos tratados) e a cópia é destruída mesmo assim", async () => {
    const repo = makeDevRepo(work);
    const { plan } = await localChainWithAnalyses(repo, store);
    const SECRET = "sk-ant-" + "a".repeat(32);
    let seenWorkDir = "";
    const { svc, calls } = service(
      [
        async (c: AgentCall) => {
          seenWorkDir = c.workDir;
          writeFileSync(path.join(c.workDir, "src", "serializador.ts"), "export const x = 1;\n");
          // Out of scope: package.json is not in editScope for this task at all — and it leaks something secret-shaped.
          writeFileSync(path.join(c.workDir, "package.json"), `{"name":"x","tampered":true,"leak":"${SECRET}"}`);
          return reply(devResult({ changes: [{ path: "src/serializador.ts", action: "created", reason: "ok" }] }));
        },
        async (c: AgentCall) => {
          // Second attempt (correction): still out of scope (and still leaking) — must fail for good, not be silently accepted.
          writeFileSync(path.join(c.workDir, "package.json"), `{"name":"x","tampered":"again","leak":"${SECRET}"}`);
          return reply(devResult({ changes: [{ path: "src/serializador.ts", action: "created", reason: "ok" }] }));
        },
      ],
      { s: store, localRepos: [repo.dir] },
    );
    const run = body<{ run: RunDetail }>(await svc.prepareDeveloper(devReq(plan, "t3"))).run;
    await svc.approve(run.id, { snapshotHash: run.snapshotHash });
    await svc.idle();
    expect(calls).toHaveLength(2); // one retry, per the standard correction policy — a genuine model violation, unlike the fixed false positive above
    const done = (await store.get(run.id))!;
    expect(done.status).toBe("failed"); // never "implementation_ready" for an out-of-scope diff
    const events = (await store.detail(run.id))!.events;
    expect(events.some(e => e.kind === "diff" && e.message.includes("FORA DO ESCOPO") && e.message.includes("package.json"))).toBe(true);
    // The real, rejected diff is kept for inspection — never turned into an exception, never applied anywhere.
    const rd = done.rejectedDiff!;
    expect(rd.baseCommit).toBe(repo.base);
    expect(rd.outOfScope).toEqual(["package.json"]);
    expect(rd.files.some(f => f.path === "package.json" && !f.inScope)).toBe(true);
    expect(rd.files.some(f => f.path === "src/serializador.ts" && f.inScope)).toBe(true);
    expect(rd.diffText).not.toContain(SECRET);
    expect(rd.diffText).toContain("[REDACTED]");
    expect(done.developer).toBeNull(); // rejected, not a developer result
    // Isolation still holds even on failure: the copy is destroyed, the source repo untouched.
    expect(existsSync(seenWorkDir)).toBe(false);
    expect(repo.status()).toBe("");
  });

  it("cancelamento antes da aprovação não cria cópia nem chama o cliente; cancelamento em execução aborta o processo", async () => {
    const repo = makeDevRepo(work);
    const { plan } = await localChainWithAnalyses(repo, store);
    const { svc, calls } = service([async () => { await new Promise(r => setTimeout(r, 500)); return reply(devResult()); }], { s: store, localRepos: [repo.dir] });
    const run = body<{ run: RunDetail }>(await svc.prepareDeveloper(devReq(plan, "t3"))).run;
    const discarded = await svc.cancel(run.id);
    expect(body<{ canceled: boolean }>(discarded).canceled).toBe(true);
    expect((await store.get(run.id))!.status).toBe("canceled");
    await svc.idle();
    expect(calls).toHaveLength(0);

    const run2 = body<{ run: RunDetail }>(await svc.prepareDeveloper(devReq(plan, "t3"))).run;
    await svc.approve(run2.id, { snapshotHash: run2.snapshotHash });
    await new Promise(r => setTimeout(r, 50));
    await svc.cancel(run2.id);
    await svc.idle();
    expect((await store.get(run2.id))!.status).toBe("canceled");
  });

  it("persistência: o relatório e o diff reabrem do banco exatamente como gravados (kind developer_task)", async () => {
    const repo = makeDevRepo(work);
    const { plan } = await localChainWithAnalyses(repo, store);
    const { svc } = service(
      [async (c: AgentCall) => { writeFileSync(path.join(c.workDir, "src", "serializador.ts"), "export {};\n"); return reply(devResult({ changes: [{ path: "src/serializador.ts", action: "created", reason: "ok" }] })); }],
      { s: store, localRepos: [repo.dir] },
    );
    const run = body<{ run: RunDetail }>(await svc.prepareDeveloper(devReq(plan, "t3"))).run;
    await svc.approve(run.id, { snapshotHash: run.snapshotHash });
    await svc.idle();
    const detail = (await store.detail(run.id))!;
    expect(detail.kind).toBe("developer_task");
    expect(detail.developer?.outcome).toBe("done");
    expect(detail.developer?.diff?.baseCommit).toBe(repo.base);
    expect(detail.result).toBeNull();
    expect(detail.analysis).toBeNull();
    // Same record via the plain (non-detail) accessor, confirming the store's generic kind branch (store.ts#toRecord).
    expect((await store.get(run.id))!.developer?.outcome).toBe("done");
  });
});

describe("Desenvolvedor: esclarecimento resolvido fora do modelo (nunca reescreve o status nem o resultado)", { timeout: 30_000 }, () => {
  async function awaitingClarificationRun() {
    const repo = makeDevRepo(work);
    const { plan } = await localChainWithAnalyses(repo, store);
    const { svc } = service(
      [reply(devResult({ outcome: "needs_clarification", changes: [], questions: [{ question: "Onde colocar o teste?", why_it_blocks: "Nenhum caminho de teste está no escopo aprovado." }] }))],
      { s: store, localRepos: [repo.dir] },
    );
    const run = body<{ run: RunDetail }>(await svc.prepareDeveloper(devReq(plan, "t3"))).run;
    await svc.approve(run.id, { snapshotHash: run.snapshotHash });
    await svc.idle();
    return { svc, runId: run.id };
  }
  const RESOLUTION = { note: "Testes escritos localmente, fora do escopo aprovado da execução isolada.", commit: "6".repeat(40), testFile: "tests/plan-markdown.test.ts", testCount: 13 };

  it("registra a resolução sem tocar em status/result; fica visível no registro e num evento", async () => {
    const { svc, runId } = await awaitingClarificationRun();
    expect((await store.get(runId))!.status).toBe("awaiting_clarification");
    const r = await svc.resolveClarificationLocally(runId, RESOLUTION);
    expect(r.status).toBe(200);
    const after = await store.get(runId);
    expect(after!.status).toBe("awaiting_clarification"); // never rewritten as if the model had finished
    expect(after!.developer?.outcome).toBe("needs_clarification"); // the model's own answer, untouched
    expect(after!.localResolution).toMatchObject(RESOLUTION);
    expect(after!.localResolution!.by).toBe("orchestrator");
    const detail = (await store.detail(runId))!;
    expect(detail.events.some(e => e.kind === "clarification_resolved_locally" && e.message.includes(RESOLUTION.note))).toBe(true);
  });

  it("recusa corpo inválido (commit não é hash de 40, note vazia)", async () => {
    const { svc, runId } = await awaitingClarificationRun();
    expect(body<{ error: { code: string } }>(await svc.resolveClarificationLocally(runId, { ...RESOLUTION, commit: "abc" })).error.code).toBe("invalid_body");
    expect(body<{ error: { code: string } }>(await svc.resolveClarificationLocally(runId, { ...RESOLUTION, note: "  " })).error.code).toBe("invalid_body");
    expect((await store.get(runId))!.localResolution).toBeNull();
  });

  it("recusa quando a execução não está aguardando esclarecimento (já foi para outra tentativa)", async () => {
    const repo = makeDevRepo(work);
    const { plan } = await localChainWithAnalyses(repo, store);
    const { svc } = service([reply(devResult({ changes: [] }), usage())], { s: store, localRepos: [repo.dir] }); // outcome "done" this time, real diff empty and matching
    const run = body<{ run: RunDetail }>(await svc.prepareDeveloper(devReq(plan, "t3"))).run;
    await svc.approve(run.id, { snapshotHash: run.snapshotHash });
    await svc.idle();
    expect((await store.get(run.id))!.status).toBe("implementation_ready");
    expect(body<{ error: { code: string } }>(await svc.resolveClarificationLocally(run.id, RESOLUTION)).error.code).toBe("not_awaiting_clarification");
  });

  it("Desenvolvedor → Desenvolvedor: bloqueado enquanto não há entrega real, liberado só por evidência (execução concluída OU esclarecimento validado) — nunca por localResolution sozinho", async () => {
    const t3: PlanTask = { id: "t3", step_id: "s1", assignee: "developer", title: "t3", scope: "", inputs: "", deliverable: "", acceptance_criteria: [], depends_on: [] };
    const t4: PlanTask = { id: "t4", step_id: "s2", assignee: "developer", title: "t4", scope: "", inputs: "", deliverable: "", acceptance_criteria: [], depends_on: ["t3"] };
    const noCompletions = () => [] as TaskCompletion[];
    // Nothing sent yet: blocked, not a categorical "developer doesn't execute" message anymore.
    expect(dependencyBlocker(t4, [t3, t4], () => [], noCompletions)).toBe("Depende de t3: ainda não foi enviado a ninguém.");
    // A real completed run satisfies it (the coherent rule the user asked for: any assignee, any assignee).
    const doneRun = { id: "r1", status: "implementation_ready" } as unknown as RunRecord;
    expect(dependencyBlocker(t4, [t3, t4], (id: string) => (id === "t3" ? [doneRun] : []), noCompletions)).toBeNull();
    // Asked for clarification, answered, but NOT validated: still blocked, with a distinct message —
    // this is exactly the case the user called out: a question answered is not a code delivery.
    const waitingRun = { id: "r2", status: "awaiting_clarification", localResolution: { at: "x", by: "orchestrator", note: "n", commit: "c", testFile: null, testCount: null } } as unknown as RunRecord;
    expect(dependencyBlocker(t4, [t3, t4], (id: string) => (id === "t3" ? [waitingRun] : []), noCompletions)).toContain("não há entrega local validada");
    // Now with a matching, validated TaskCompletion: satisfied.
    const completion = { id: "c1", demandId: "d", parentRunId: "p", taskId: "t3", kind: "resolved_clarification", sourceRunId: "r2", commit: "c", files: [], verification: { typecheck: null, lint: null, tests: null, build: null }, note: "n", validatedBy: "orchestrator", validatedAt: "x", createdAt: "x" } as TaskCompletion;
    expect(dependencyBlocker(t4, [t3, t4], (id: string) => (id === "t3" ? [waitingRun] : []), (id: string) => (id === "t3" ? [completion] : []))).toBeNull();
  });

  it("detecta dependência inexistente e dependência circular", () => {
    const a: PlanTask = { id: "a", step_id: "s", assignee: "developer", title: "a", scope: "", inputs: "", deliverable: "", acceptance_criteria: [], depends_on: ["ghost"] };
    expect(dependencyBlocker(a, [a], () => [], () => [])).toBe('Depende de "ghost", que não existe neste plano.');
    const b: PlanTask = { id: "b", step_id: "s", assignee: "developer", title: "b", scope: "", inputs: "", deliverable: "", acceptance_criteria: [], depends_on: ["c"] };
    const c: PlanTask = { id: "c", step_id: "s", assignee: "developer", title: "c", scope: "", inputs: "", deliverable: "", acceptance_criteria: [], depends_on: ["b"] };
    expect(dependencyBlocker(b, [b, c], () => [], () => [])).toContain("Dependência circular detectada");
    const { missing, cycles } = findDependencyIssues([a, b, c]);
    expect(missing).toEqual([{ task: "a", dep: "ghost" }]);
    expect(cycles.length).toBeGreaterThan(0);
  });
});

// ---- QA: hand-off, real dependency evidence (transitive), token budget, criterion classification ----
const qaSheet = (over = {}) => member("qa", { connection: "claude_code", brief: "# QA\nFicha salva do QA.", budget: 48000, ...over });
const qaReq = (planId: string, taskId = "t5", over = {}) => ({ idempotencyKey: `h:${Math.random().toString(36).slice(2, 12)}`, directorRunId: planId, taskId, agent: qaSheet(), ...over });
const qaResult = (over: Partial<QAResult> = {}): QAResult => ({
  outcome: "done", summary: "Revisado contra os critérios da demanda.",
  criteria: [{ criterion: "Botão azul", verdict: "approved", evidence: "O diff real de t3 mostra a classe azul aplicada em src/botao.tsx." }],
  questions: [], not_verified: [], recommendation: "ready_for_review", ...over,
});
/**
 * The client always sends every field of the schema (empty string where N/A) — this mirrors that shape for the
 * tool-equipped QA's evaluation schema. Approvals/rejections cite E1 by default: the delivered diff, the first
 * evidence the executor produces automatically (never a narrative report).
 */
const qaResultRaw = (over: Partial<QAResult> = {}) => {
  const r = qaResult(over);
  return {
    outcome: r.outcome, summary: r.summary, questions: r.questions, not_verified: r.not_verified, recommendation: r.recommendation, followup_operations: [],
    criteria: r.criteria.map(c => ({
      criterion: c.criterion, verdict: c.verdict, evidence_ids: c.evidenceIds ?? (c.verdict === "not_verified" ? [] : ["E1"]),
      steps: c.rejected?.steps ?? "", expected: c.rejected?.expected ?? "", observed: c.rejected?.observed ?? "", impact: c.rejected?.impact ?? "",
      notVerifiedReason: c.notVerifiedReason ?? "", evidence: c.evidence ?? "",
      pending_reason: c.pendingReason ?? (c.verdict === "not_verified" ? "insufficient_evidence" : ""), evaluated_part: c.evaluatedPart ?? "", pending_part: c.pendingPart ?? "", pending_task: c.pendingTask ?? "",
    })),
  };
};
/** First QA call (which operations?) answered with none: the automatic evidence (the diff) is enough for these tests. */
const QA_NO_OPS = { plan_summary: "O diff entregue (E1) basta para estes critérios.", operations: [] };
/** The two model calls of a tool-equipped QA run: plan operations, then evaluate. */
const qaTurns = (over: Partial<QAResult> = {}) => [reply(QA_NO_OPS), reply(qaResultRaw(over))];

/** t1/t2 analyses done, t3 (Developer) implementation_ready for real, in a plan that also has t5 (QA) depending on t3. */
async function chainWithRealImplementation(repo: { dir: string; base: string }, s: RunStore) {
  const { plan } = await localChainWithAnalyses(repo, s, qaChainPlan());
  const { svc } = service(
    [async (c: AgentCall) => { writeFileSync(path.join(c.workDir, "src", "serializador.ts"), "export const toMarkdown = () => \"\";\n"); return reply(devResult({ changes: [{ path: "src/serializador.ts", action: "created", reason: "Novo módulo puro." }] })); }],
    { s, localRepos: [repo.dir] },
  );
  const t3 = body<{ run: RunDetail }>(await svc.prepareDeveloper(devReq(plan, "t3"))).run;
  await svc.approve(t3.id, { snapshotHash: t3.snapshotHash });
  await svc.idle();
  return { plan };
}

describe("QA: preparar o envio (dependência real, transitiva, jamais por chamada direta indevida)", { timeout: 30_000 }, () => {
  it("recusa quando a dependência (Desenvolvedor) ainda não tem entrega concluída — inclusive por chamada direta ao serviço", async () => {
    const repo = makeDevRepo(work);
    const { plan } = await localChainWithAnalyses(repo, store, qaChainPlan()); // t3 NOT sent to the Developer yet
    const { svc } = service([], { s: store, localRepos: [repo.dir] });
    const r = await svc.prepareQA(qaReq(plan, "t5"));
    expect(body<{ error: { code: string; details?: string[] } }>(r).error).toMatchObject({ code: "dependency_pending" });
  });

  it("recusa ficha sem conexão; recusa tarefa que não é do QA", async () => {
    const repo = makeDevRepo(work);
    const { plan } = await chainWithRealImplementation(repo, store);
    const { svc } = service([], { s: store, localRepos: [repo.dir] });
    expect(body<{ error: { code: string } }>(await svc.prepareQA(qaReq(plan, "t5", { agent: qaSheet({ connection: "none" }) }))).error.code).toBe("no_connection");
    expect(body<{ error: { code: string } }>(await svc.prepareQA(qaReq(plan, "t3"))).error.code).toBe("not_qa_task");
  });

  it("uma vez satisfeita a dependência, congela a revisão com as entregas reais, a versão exata a testar e as ferramentas que o executor de fato oferece — sem chamar o modelo", async () => {
    const repo = makeDevRepo(work);
    const { plan } = await chainWithRealImplementation(repo, store);
    const { svc, calls } = service([], { s: store, localRepos: [repo.dir] });
    const r = body<{ run: RunDetail; created: boolean }>(await svc.prepareQA(qaReq(plan, "t5")));
    expect(r.created).toBe(true);
    expect(r.run.status).toBe("awaiting_approval");
    const snap = r.run.snapshot as QASnapshot;
    expect(snap.deliverables.map(d => d.taskId)).toContain("t3");
    const t3d = snap.deliverables.find(d => d.taskId === "t3")!;
    expect(t3d.origin).toBe("run_completed");
    expect(t3d.diffText).toContain("serializador");
    expect(snap.analyses.map(a => a.taskId).sort()).toEqual(["t1", "t2"]); // whole chain, not just the direct dependency
    // The exact version: the run's base commit + its persisted diff (not applied anywhere), identified by hash.
    expect(snap.toolsMode).toBe("executor_operations");
    expect(snap.testedVersion).toMatchObject({ kind: "commit_plus_patch", commit: repo.base, patchSha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    // Tools come from what the executor detected — this test repo has no lockfile, so no commands/browser, with the reason.
    const tool = (label: string) => snap.tools.find(t => t.label === label)!;
    expect(tool("Ler arquivos da versão testada").allowed).toBe(true);
    expect(tool("Rodar verificações do projeto")).toMatchObject({ allowed: false, how: expect.stringContaining("configuração de execução") });
    expect(tool("Navegador automatizado").allowed).toBe(false);
    expect(tool("Editar o código da entrega").allowed).toBe(false);
    expect(tool("Publicar, fazer push ou deploy").allowed).toBe(false);
    expect(r.run.prompt!.user).toContain("src/serializador.ts"); // the file list of the tested version
    expect(snap.contextBudget.estimatedInputTokens).toBeGreaterThan(0);
    await svc.idle();
    expect(calls).toHaveLength(0); // preparing never calls the model
    expect(readdirSync(work).some(n => n.endsWith(".qa"))).toBe(false); // nor builds any environment
  });
});

describe("TaskCompletion applied_run_result: o resultado da execução do Desenvolvedor, aplicado e validado, vinculado à execução original", { timeout: 30_000 }, () => {
  const VERIF = (at = "2026-09-29T19:00:00.000Z") => ({
    typecheck: { ran: true, command: "pnpm exec tsc --noEmit", result: "0 erros", at }, lint: { ran: true, command: "pnpm lint", result: "0 problemas", at },
    tests: { ran: true, command: "pnpm test", result: "225 passando", at }, build: { ran: true, command: "pnpm build", result: "ok", at },
  });
  async function setup() {
    const repo = makeDevRepo(work);
    const { plan } = await chainWithRealImplementation(repo, store);
    const { svc } = service([], { s: store, localRepos: [repo.dir] });
    const demandId = (await store.get(plan))!.demandId;
    const devRun = (await store.listForDemands([demandId])).find(r => r.kind === "developer_task" && r.taskId === "t3")!;
    const full = (await store.get(devRun.id))!;
    return { repo, plan, svc, full, files: full.developer!.diff!.files.map(f => f.path) };
  }
  const req = (plan: string, over: Record<string, unknown>) => ({ parentRunId: plan, taskId: "t3", kind: "applied_run_result", commit: "a".repeat(40), verification: VERIF(), note: "Aplicado e validado.", ...over });

  it("registra vinculado à execução original, sem alterar essa execução, e o QA passa a receber a entrega com commit, arquivos e verificação", async () => {
    const { repo, plan, svc, full, files } = await setup();
    const before = JSON.stringify(await store.get(full.id));
    const r = await svc.recordTaskCompletion(req(plan, { sourceRunId: full.id, files, commit: repo.base }));
    expect(r.status).toBe(201);
    const c = body<{ completion: TaskCompletion }>(r).completion;
    expect(c).toMatchObject({ kind: "applied_run_result", sourceRunId: full.id, taskId: "t3", commit: repo.base, files, validatedBy: "orchestrator" });
    expect(JSON.stringify(await store.get(full.id))).toBe(before); // histórico da execução original intacto
    const qa = body<{ run: RunDetail }>(await svc.prepareQA(qaReq(plan, "t5"))).run;
    const d = (qa.snapshot as QASnapshot).deliverables.find(x => x.taskId === "t3")!;
    expect(d.origin).toBe("applied_run_result_validated");
    expect(d.commit).toBe(repo.base);
    expect(d.files).toEqual(files);
    expect(d.verification?.tests?.result).toBe("225 passando");
    expect(d.note).toContain(full.id);
  });

  it("recusa arquivos que a execução original não alterou, lista vazia, origem de outra tarefa e origem inexistente", async () => {
    const { plan, svc, full, files } = await setup();
    const code = async (over: Record<string, unknown>) => body<{ error: { code: string } }>(await svc.recordTaskCompletion(req(plan, over))).error.code;
    expect(await code({ sourceRunId: full.id, files: [...files, "src/outro.ts"] })).toBe("files_outside_run_diff");
    expect(await code({ sourceRunId: full.id, files: [] })).toBe("files_outside_run_diff");
    expect(await code({ sourceRunId: undefined, files })).toBe("invalid_body");
    expect(await code({ sourceRunId: "00000000-0000-4000-8000-000000000000", files })).toBe("source_run_not_found");
    expect(await code({ sourceRunId: full.id, files, taskId: "t1" })).toBe("source_run_not_found");
  });

  it("a regra de dependência só reconhece a conclusão que aponta para a ÚLTIMA execução (uma antiga não sobrepõe o estado real)", () => {
    const t3: PlanTask = { id: "t3", step_id: "s", assignee: "developer", title: "t3", scope: "", inputs: "", deliverable: "", acceptance_criteria: [], depends_on: [] };
    const t4: PlanTask = { id: "t4", step_id: "s", assignee: "developer", title: "t4", scope: "", inputs: "", deliverable: "", acceptance_criteria: [], depends_on: ["t3"] };
    const old = { id: "old", status: "implementation_ready" } as unknown as RunRecord;
    const latestFailed = { id: "new", status: "failed" } as unknown as RunRecord;
    const done = { id: "c", kind: "applied_run_result", sourceRunId: "old", taskId: "t3" } as unknown as TaskCompletion;
    expect(dependencyBlocker(t4, [t3, t4], () => [old], () => [done])).toBeNull();
    expect(dependencyBlocker(t4, [t3, t4], () => [latestFailed, old], () => [done])).toBe("Depende de t3: a última execução falhou.");
  });
});

describe("QA: aprovação, execução real (simulada) e classificação dos critérios", { timeout: 30_000 }, () => {
  it("execução completa: cada critério classificado citando evidência do executor, review_ready, duas chamadas (planejar e avaliar)", async () => {
    const repo = makeDevRepo(work);
    const { plan } = await chainWithRealImplementation(repo, store);
    const { svc, calls } = service(qaTurns(), { s: store, localRepos: [repo.dir] });
    const run = body<{ run: RunDetail }>(await svc.prepareQA(qaReq(plan, "t5"))).run;
    await svc.approve(run.id, { snapshotHash: run.snapshotHash });
    await svc.idle();
    expect(calls).toHaveLength(2);
    const done = (await store.detail(run.id))!;
    expect(done.status).toBe("review_ready");
    expect(done.qa?.criteria).toMatchObject([{ criterion: "Botão azul", verdict: "approved", evidenceIds: ["E1"] }]);
    expect(done.qa?.recommendation).toBe("ready_for_review");
    expect(done.qa?.evidence?.[0]).toMatchObject({ id: "E1", method: "inspection", author: "executor", requestedBy: "executor" });
    expect(done.qa?.testedVersion).toMatchObject({ kind: "commit_plus_patch", treeHash: expect.stringMatching(/^[0-9a-f]{40}$/) });
    expect(done.qa?.environment?.modifiedDeliveryFiles).toEqual([]);
    expect(readdirSync(work).some(n => n.endsWith(".qa"))).toBe(false); // environment removed after the run
  });

  it("reprova a resposta do modelo quando falta classificar um critério da demanda, quando falta evidência de aprovação, ou quando reprovação vem sem steps/expected/observed/impact", async () => {
    // Two full real materialized-copy Developer runs in one test (two independent repos/stores) — heavier than most.
    const repo = makeDevRepo(work);
    const { plan: p1 } = await chainWithRealImplementation(repo, store);
    const { svc: s1, calls: c1 } = service([reply(QA_NO_OPS), reply(qaResultRaw({ criteria: [] })), reply(qaResultRaw({ criteria: [] }))], { s: store, localRepos: [repo.dir] });
    const r1 = body<{ run: RunDetail }>(await s1.prepareQA(qaReq(p1, "t5"))).run;
    await s1.approve(r1.id, { snapshotHash: r1.snapshotHash });
    await s1.idle();
    expect(c1).toHaveLength(3); // plan + evaluation + one correction attempt, per the standard policy
    expect((await store.get(r1.id))!.status).toBe("failed");

    const root2 = mkdtempSync(path.join(os.tmpdir(), "ayla-hand2-"));
    const repo2 = makeDevRepo(root2);
    const store2 = new RunStore(sqliteDriver(":memory:"));
    const { plan: p2 } = await chainWithRealImplementation(repo2, store2);
    const bad = qaResultRaw({ criteria: [{ criterion: "Botão azul", verdict: "approved", evidence: "O diff mostra.", evidenceIds: [] }] }); // approval citing no executor evidence
    const { svc: s2 } = service([reply(QA_NO_OPS), reply(bad), reply(bad)], { s: store2, localRepos: [repo2.dir] });
    const r2 = body<{ run: RunDetail }>(await s2.prepareQA(qaReq(p2, "t5"))).run;
    await s2.approve(r2.id, { snapshotHash: r2.snapshotHash });
    await s2.idle();
    expect((await store2.get(r2.id))!.status).toBe("failed");
    rmSync(root2, { recursive: true, force: true });
  }, 20000);

  it("evidência insuficiente não segue como ready_for_review; pendência só por ferramenta indisponível segue para a revisão final com ressalvas (nunca de volta ao Desenvolvedor)", async () => {
    const repo = makeDevRepo(work);
    const { plan } = await chainWithRealImplementation(repo, store);
    const bad = qaResultRaw({ criteria: [{ criterion: "Botão azul", verdict: "not_verified", notVerifiedReason: "As evidências não mostram a cor.", pendingReason: "insufficient_evidence" }], recommendation: "ready_for_review" });
    const toolOnly = qaResultRaw({ criteria: [{ criterion: "Botão azul", verdict: "not_verified", notVerifiedReason: "Sem navegador nesta execução.", pendingReason: "tool_unavailable" }], recommendation: "ready_for_review" });
    const { svc, calls } = service([reply(QA_NO_OPS), reply(bad), reply(toolOnly)], { s: store, localRepos: [repo.dir] });
    const run = body<{ run: RunDetail }>(await svc.prepareQA(qaReq(plan, "t5"))).run;
    await svc.approve(run.id, { snapshotHash: run.snapshotHash });
    await svc.idle();
    expect(calls).toHaveLength(3); // the invalid recommendation was corrected once
    const done = (await store.detail(run.id))!;
    expect(done.status).toBe("review_ready");
    expect(done.qa?.criteria[0]).toMatchObject({ verdict: "not_verified", pendingReason: "tool_unavailable" });
    expect(done.qa?.recommendation).toBe("ready_for_review");
  });

  it("clique repetido na confirmação enfileira uma única vez; cancelamento antes da confirmação não chama o modelo", async () => {
    const repo = makeDevRepo(work);
    const { plan } = await chainWithRealImplementation(repo, store);
    const { svc: sPending } = service([], { s: store, localRepos: [repo.dir] });
    const runPending = body<{ run: RunDetail }>(await sPending.prepareQA(qaReq(plan, "t5"))).run;
    const discarded = await sPending.cancel(runPending.id);
    expect(body<{ canceled: boolean }>(discarded).canceled).toBe(true);
    await sPending.idle();

    const { svc, calls } = service(qaTurns(), { s: store, localRepos: [repo.dir] });
    const run = body<{ run: RunDetail }>(await svc.prepareQA(qaReq(plan, "t5"))).run;
    const [a, b] = await Promise.all([svc.approve(run.id, { snapshotHash: run.snapshotHash }), svc.approve(run.id, { snapshotHash: run.snapshotHash })]);
    expect([a, b].filter(r => body<{ approved: boolean }>(r).approved)).toHaveLength(1);
    await svc.idle();
    expect(calls).toHaveLength(2); // one run: plan + evaluation, never twice
  });

  it("persistência: o parecer do QA reabre do banco exatamente como gravado (kind qa_task)", async () => {
    const repo = makeDevRepo(work);
    const { plan } = await chainWithRealImplementation(repo, store);
    const { svc } = service(qaTurns(), { s: store, localRepos: [repo.dir] });
    const run = body<{ run: RunDetail }>(await svc.prepareQA(qaReq(plan, "t5"))).run;
    await svc.approve(run.id, { snapshotHash: run.snapshotHash });
    await svc.idle();
    const detail = (await store.detail(run.id))!;
    expect(detail.kind).toBe("qa_task");
    expect(detail.qa?.outcome).toBe("done");
    expect(detail.developer).toBeNull();
    expect(detail.analysis).toBeNull();
    expect((await store.get(run.id))!.qa?.outcome).toBe("done");
  });
});

// ---- Reviewer: depends on a concluded QA task, reuses QA's own frozen snapshot (no second evidence pass) ----
import { validateReviewerResult } from "@/lib/engine/reviewer-schema";
import type { ReviewerResult, ReviewerSnapshot } from "@/lib/engine/types";

/** qaChainPlan plus a Reviewer task (t6) depending on the QA task (t5) — for testing the Reviewer hand-off. */
const reviewerChainPlan = () => {
  const p = qaChainPlan();
  return { ...p, tasks: [...p.tasks, { id: "t6", step_id: "s2", assignee: "reviewer", title: "Formar o parecer final", scope: "Ler o parecer do QA e formar o parecer final", inputs: "t5", deliverable: "Parecer final", acceptance_criteria: ["Botão azul"], depends_on: ["t5"] }] };
};
/** A Reviewer task that (wrongly) depends directly on the Developer task, skipping QA. */
const reviewerWithoutQaDepPlan = () => {
  const p = chainPlan();
  return { ...p, tasks: [...p.tasks, { id: "t6", step_id: "s2", assignee: "reviewer", title: "Formar o parecer final", scope: "x", inputs: "t3", deliverable: "Parecer final", acceptance_criteria: ["Botão azul"], depends_on: ["t3"] }] };
};
const reviewerSheet = (over = {}) => member("reviewer", { connection: "claude_code", brief: "# Revisor\nFicha salva do Revisor.", budget: 48000, ...over });
const reviewerReq = (planId: string, taskId = "t6", over = {}) => ({ idempotencyKey: `h:${Math.random().toString(36).slice(2, 12)}`, directorRunId: planId, taskId, agent: reviewerSheet(), ...over });
const reviewerResultRaw = (over: Partial<ReviewerResult> = {}) => ({
  outcome: "done" as const, summary: "Parecer final formado a partir do parecer do QA.",
  facts: [{ statement: "O QA aprovou o único critério da demanda.", evidence: "Critério \"Botão azul\" aprovado pelo QA com evidência do diff real de t3." }],
  inferences: [] as { statement: string; basis: string }[], not_verified: [] as string[], questions: [] as { question: string; why_it_blocks: string }[], verdict: "aprovado" as const, ...over,
});

/** t3 (Developer) real, t5 (QA) concluded, in a plan that also has t6 (Reviewer) depending on t5. */
async function chainWithQAConcluded(repo: { dir: string; base: string }, s: RunStore, qaOverride: Partial<QAResult> = {}) {
  const { plan } = await localChainWithAnalyses(repo, s, reviewerChainPlan());
  const { svc: devSvc } = service(
    [async (c: AgentCall) => { writeFileSync(path.join(c.workDir, "src", "serializador.ts"), "export const toMarkdown = () => \"\";\n"); return reply(devResult({ changes: [{ path: "src/serializador.ts", action: "created", reason: "Novo módulo puro." }] })); }],
    { s, localRepos: [repo.dir] },
  );
  const t3 = body<{ run: RunDetail }>(await devSvc.prepareDeveloper(devReq(plan, "t3"))).run;
  await devSvc.approve(t3.id, { snapshotHash: t3.snapshotHash });
  await devSvc.idle();
  const { svc: qaSvc } = service(qaTurns(qaOverride), { s, localRepos: [repo.dir] });
  const t5 = body<{ run: RunDetail }>(await qaSvc.prepareQA(qaReq(plan, "t5"))).run;
  await qaSvc.approve(t5.id, { snapshotHash: t5.snapshotHash });
  await qaSvc.idle();
  return { plan };
}

describe("validateReviewerResult: o veredito nunca pode contradizer o próprio parecer do QA", () => {
  it("aceita aprovado quando o QA aprovou tudo e há ao menos um fato", () => {
    const v = validateReviewerResult(reviewerResultRaw(), qaResult());
    expect(v.ok).toBe(true);
  });
  it("recusa aprovado quando o QA reprovou algum critério", () => {
    const qa = qaResult({ criteria: [{ criterion: "Botão azul", verdict: "rejected", rejected: { steps: "Abri a tela", expected: "Azul", observed: "Vermelho", impact: "Critério não atendido" } }], recommendation: "blocked" });
    const v = validateReviewerResult(reviewerResultRaw({ verdict: "aprovado" }), qa);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.join(" ")).toContain("reprovado");
  });
  it("recusa aprovado sem ressalvas quando o QA deixou algum critério não verificado", () => {
    const qa = qaResult({ criteria: [{ criterion: "Botão azul", verdict: "not_verified", notVerifiedReason: "Sem terminal." }] });
    const v = validateReviewerResult(reviewerResultRaw({ verdict: "aprovado" }), qa);
    expect(v.ok).toBe(false);
  });
  it("exige ao menos um fato quando outcome é done", () => {
    const v = validateReviewerResult(reviewerResultRaw({ facts: [] }), qaResult());
    expect(v.ok).toBe(false);
  });
  it("needs_clarification exige pelo menos uma pergunta", () => {
    const v = validateReviewerResult(reviewerResultRaw({ outcome: "needs_clarification", questions: [] }), qaResult());
    expect(v.ok).toBe(false);
  });
});

describe("Revisor: preparar o envio (depende de um QA já concluído; reaproveita o próprio contexto do QA)", { timeout: 30_000 }, () => {
  it("recusa quando a tarefa não depende de nenhuma tarefa do QA", async () => {
    const plan = await directorPlan(reviewerWithoutQaDepPlan());
    const { svc } = service([], { s: store });
    const r = await svc.prepareReviewer(reviewerReq(plan, "t6"));
    expect(body<{ error: { code: string } }>(r).error.code).toBe("no_qa_dependency");
  });

  it("recusa quando o QA ainda não concluiu a revisão — inclusive por chamada direta ao serviço", async () => {
    const repo = makeDevRepo(work);
    const { plan } = await localChainWithAnalyses(repo, store, reviewerChainPlan()); // t3/t5 not sent yet
    const { svc } = service([], { s: store, localRepos: [repo.dir] });
    const r = await svc.prepareReviewer(reviewerReq(plan, "t6"));
    expect(body<{ error: { code: string } }>(r).error.code).toBe("dependency_pending");
  });

  it("recusa ficha sem conexão; recusa tarefa que não é do Revisor", async () => {
    const repo = makeDevRepo(work);
    const { plan } = await chainWithQAConcluded(repo, store);
    const { svc } = service([], { s: store, localRepos: [repo.dir] });
    expect(body<{ error: { code: string } }>(await svc.prepareReviewer(reviewerReq(plan, "t6", { agent: reviewerSheet({ connection: "none" }) }))).error.code).toBe("no_connection");
    expect(body<{ error: { code: string } }>(await svc.prepareReviewer(reviewerReq(plan, "t5"))).error.code).toBe("not_reviewer_task");
  });

  it("uma vez concluído o QA, congela o parecer reaproveitando exatamente as entregas/análises do QA e o parecer dele — sem chamar o modelo", async () => {
    const repo = makeDevRepo(work);
    const { plan } = await chainWithQAConcluded(repo, store);
    const { svc, calls } = service([], { s: store, localRepos: [repo.dir] });
    const r = body<{ run: RunDetail; created: boolean }>(await svc.prepareReviewer(reviewerReq(plan, "t6")));
    expect(r.created).toBe(true);
    expect(r.run.status).toBe("awaiting_approval");
    const snap = r.run.snapshot as ReviewerSnapshot;
    expect(snap.qa.taskId).toBe("t5");
    expect(snap.qa.result.criteria).toMatchObject([{ criterion: "Botão azul", verdict: "approved" }]);
    expect(snap.deliverables.map(d => d.taskId)).toContain("t3");
    expect(snap.analyses.map(a => a.taskId).sort()).toEqual(["t1", "t2"]);
    expect(snap.tools.every(t => !t.allowed)).toBe(true); // Reviewer: no live tools at all
    await svc.idle();
    expect(calls).toHaveLength(0); // preparing never calls the model
  });

  it("orçamento pequeno: cada diff é reduzido uma única vez (sem registrar a mesma redução repetida)", async () => {
    const repo = makeDevRepo(work);
    const { plan } = await chainWithQAConcluded(repo, store);
    const { svc } = service([], { s: store, localRepos: [repo.dir] });
    const snap = body<{ run: RunDetail }>(await svc.prepareReviewer(reviewerReq(plan, "t6", { agent: reviewerSheet({ budget: 50 }) }))).run.snapshot as ReviewerSnapshot;
    const cuts = snap.contextBudget.omitted.filter(o => o.startsWith("Diff de t3"));
    expect(cuts.length).toBeLessThanOrEqual(1);
  });

  it("nova revisão final só com um parecer do QA mais novo; o parecer final anterior fica intacto; o Revisor recebe o que as evidências do executor mostram", async () => {
    const repo = makeDevRepo(work);
    const { plan } = await chainWithQAConcluded(repo, store);
    const { svc } = service([reply(reviewerResultRaw())], { s: store, localRepos: [repo.dir] });
    const first = body<{ run: RunDetail }>(await svc.prepareReviewer(reviewerReq(plan, "t6"))).run;
    await svc.approve(first.id, { snapshotHash: first.snapshotHash });
    await svc.idle();
    const before = (await store.detail(first.id))!;
    expect(before.status).toBe("concluded");
    expect(body<{ error: { code: string } }>(await svc.prepareReviewer(reviewerReq(plan, "t6"))).error.code).toBe("already_done");
    expect(body<{ error: { code: string } }>(await svc.prepareReviewer(reviewerReq(plan, "t6", { repeat: true }))).error.code).toBe("nothing_new"); // same QA parecer: no paid call on the same input

    const { svc: qaSvc } = service(qaTurns(), { s: store, localRepos: [repo.dir] });
    const qa2 = body<{ run: RunDetail }>(await qaSvc.prepareQA(qaReq(plan, "t5", { repeat: true }))).run;
    await qaSvc.approve(qa2.id, { snapshotHash: qa2.snapshotHash });
    await qaSvc.idle();

    const { svc: s2, calls } = service([], { s: store, localRepos: [repo.dir] });
    const r = body<{ run: RunDetail; created: boolean }>(await s2.prepareReviewer(reviewerReq(plan, "t6", { repeat: true })));
    expect(r.created).toBe(true);
    expect(r.run.status).toBe("awaiting_approval");
    expect((r.run.snapshot as ReviewerSnapshot).qa.runId).toBe(qa2.id);
    const prepared = (await store.detail(r.run.id))!;
    expect(prepared.prompt!.user).toContain("<evidencias_do_executor>");
    expect(prepared.prompt!.user).toMatch(/\[E1\] inspeção · automática · concluída/);
    expect((await store.events(r.run.id)).find(e => e.kind === "prepared")!.message).toContain(`parecer anterior (${first.id.slice(0, 8)}) continua no histórico`);
    const after = (await store.detail(first.id))!;
    expect(after.status).toBe("concluded");
    expect(after.reviewer).toEqual(before.reviewer); // the earlier final review is untouched
    await s2.idle();
    expect(calls).toHaveLength(0);
  });
});

describe("Revisor: aprovação, execução real (simulada) e veredito final coerente com o QA", { timeout: 30_000 }, () => {
  it("execução completa: veredito aprovado quando o QA aprovou tudo, concluded, uma única chamada", async () => {
    const repo = makeDevRepo(work);
    const { plan } = await chainWithQAConcluded(repo, store);
    const { svc, calls } = service([reply(reviewerResultRaw())], { s: store, localRepos: [repo.dir] });
    const run = body<{ run: RunDetail }>(await svc.prepareReviewer(reviewerReq(plan, "t6"))).run;
    await svc.approve(run.id, { snapshotHash: run.snapshotHash });
    await svc.idle();
    expect(calls).toHaveLength(1);
    const done = (await store.detail(run.id))!;
    expect(done.status).toBe("concluded");
    expect(done.reviewer?.verdict).toBe("aprovado");
  });

  it("reprova a resposta do modelo quando o veredito diz aprovado mas o parecer do QA tem critério reprovado", async () => {
    const repo = makeDevRepo(work);
    const { plan } = await chainWithQAConcluded(repo, store, { criteria: [{ criterion: "Botão azul", verdict: "rejected", rejected: { steps: "Abri a tela", expected: "Azul", observed: "Vermelho", impact: "Critério não atendido" } }], recommendation: "blocked" });
    const badVerdict = reviewerResultRaw({ verdict: "aprovado" });
    const { svc, calls } = service([reply(badVerdict), reply(badVerdict)], { s: store, localRepos: [repo.dir] });
    const run = body<{ run: RunDetail }>(await svc.prepareReviewer(reviewerReq(plan, "t6"))).run;
    await svc.approve(run.id, { snapshotHash: run.snapshotHash });
    await svc.idle();
    expect(calls).toHaveLength(2); // one correction attempt, per the standard policy
    expect((await store.get(run.id))!.status).toBe("failed");
  });

  it("aceita reprovado quando o parecer do QA tem um critério reprovado", async () => {
    const repo = makeDevRepo(work);
    const { plan } = await chainWithQAConcluded(repo, store, { criteria: [{ criterion: "Botão azul", verdict: "rejected", rejected: { steps: "Abri a tela", expected: "Azul", observed: "Vermelho", impact: "Critério não atendido" } }], recommendation: "blocked" });
    const { svc, calls } = service([reply(reviewerResultRaw({ verdict: "reprovado", facts: [{ statement: "O QA reprovou o critério de cor.", evidence: "Observado vermelho, esperado azul." }] }))], { s: store, localRepos: [repo.dir] });
    const run = body<{ run: RunDetail }>(await svc.prepareReviewer(reviewerReq(plan, "t6"))).run;
    await svc.approve(run.id, { snapshotHash: run.snapshotHash });
    await svc.idle();
    expect(calls).toHaveLength(1);
    expect((await store.get(run.id))!.status).toBe("concluded");
    expect((await store.get(run.id))!.reviewer?.verdict).toBe("reprovado");
  });

  it("clique repetido na confirmação enfileira uma única vez; cancelamento antes da confirmação não chama o modelo", async () => {
    const repo = makeDevRepo(work);
    const { plan } = await chainWithQAConcluded(repo, store);
    const { svc: sPending } = service([], { s: store, localRepos: [repo.dir] });
    const runPending = body<{ run: RunDetail }>(await sPending.prepareReviewer(reviewerReq(plan, "t6"))).run;
    const discarded = await sPending.cancel(runPending.id);
    expect(body<{ canceled: boolean }>(discarded).canceled).toBe(true);
    await sPending.idle();

    const { svc, calls } = service([reply(reviewerResultRaw())], { s: store, localRepos: [repo.dir] });
    const run = body<{ run: RunDetail }>(await svc.prepareReviewer(reviewerReq(plan, "t6"))).run;
    const [a, b] = await Promise.all([svc.approve(run.id, { snapshotHash: run.snapshotHash }), svc.approve(run.id, { snapshotHash: run.snapshotHash })]);
    expect([a, b].filter(r => body<{ approved: boolean }>(r).approved)).toHaveLength(1);
    await svc.idle();
    expect(calls).toHaveLength(1);
  });

  it("persistência: o parecer final reabre do banco exatamente como gravado (kind reviewer_task)", async () => {
    const repo = makeDevRepo(work);
    const { plan } = await chainWithQAConcluded(repo, store);
    const { svc } = service([reply(reviewerResultRaw())], { s: store, localRepos: [repo.dir] });
    const run = body<{ run: RunDetail }>(await svc.prepareReviewer(reviewerReq(plan, "t6"))).run;
    await svc.approve(run.id, { snapshotHash: run.snapshotHash });
    await svc.idle();
    const detail = (await store.detail(run.id))!;
    expect(detail.kind).toBe("reviewer_task");
    expect(detail.reviewer?.outcome).toBe("done");
    expect(detail.qa).toBeNull();
    expect(detail.developer).toBeNull();
    expect((await store.get(run.id))!.reviewer?.verdict).toBe("aprovado");
  });
});

// ---- Piloto automático (fase 1): política aprovada uma vez; Arquiteto, QA e Revisor enviados pelo supervisor ----

const apSheets = () => ({ architect: architectSheet(), qa: qaSheet(), reviewer: reviewerSheet() });
const apReq = (planRunId: string, over: Record<string, unknown> = {}) => ({ idempotencyKey: `ap:${Math.random().toString(36).slice(2, 12)}`, planRunId, sheets: apSheets(), budgetTokens: 2_000_000, maxRuns: 10, validityHours: 24, ...over });
type AP = { id: string; status: string; policyHash: string; runs: { runId: string; taskId: string }[]; stop: { code: string; message: string; runId: string | null } | null; waiting: { message: string; taskIds: string[] } | null; usedTokens: number };
async function activate(svc: ExecutorService, planRunId: string, over: Record<string, unknown> = {}) {
  const prep = await svc.prepareAutopilot(apReq(planRunId, over));
  expect(prep.status).toBe(201);
  const ap = body<{ autopilot: AP }>(prep).autopilot;
  expect(ap.status).toBe("awaiting_approval");
  const ok = await svc.approveAutopilot(ap.id, { policyHash: ap.policyHash });
  expect(ok.status).toBe(202);
  await svc.idle();
  return ap.id;
}
const apOf = async (id: string) => (await store.getAutopilot(id)) as unknown as AP;
/** reviewerChainPlan (t1, t2 Architect → t3 Developer → t4 Architect, t5 QA → t6 Reviewer), with the Director's commit = the local repo's base. */
async function apPlan(repo: { dir: string; base: string }, plan_: DirectorPlan = reviewerChainPlan()) {
  const plan = await directorPlan(plan_, store, "plan_ready");
  const detail = (await store.detail(plan))!;
  await store.update(plan, { context: { ...(detail.context as Extract<RunDetail["context"], { kind: "github" }>)!, commit: repo.base } });
  return plan;
}
const devWrites = async (c: AgentCall) => { writeFileSync(path.join(c.workDir, "src", "serializador.ts"), "export const toMarkdown = () => \"\";\n"); return reply(devResult({ changes: [{ path: "src/serializador.ts", action: "created", reason: "Novo módulo puro." }] })); };

describe("Piloto automático: cadeia completa com a política aprovada uma vez", { timeout: 60_000 }, () => {
  it("envia t1 e t2 (Arquiteto) sozinho, espera você no Desenvolvedor, e depois envia t5 (QA) e t6 (Revisor) até concluir — nunca o Desenvolvedor", async () => {
    const repo = makeDevRepo(work);
    const plan = await apPlan(repo);
    const { svc, calls } = service([reply(analysis()), reply(analysis()), devWrites, ...qaTurns(), reply(reviewerResultRaw())], { s: store, localRepos: [repo.dir] });
    const id = await activate(svc, plan);
    let ap = await apOf(id);
    // t4 (Architect depending on the Developer task) stays with the user: the Architect hand-off only accepts Architect dependencies.
    expect((await store.getAutopilot(id))!.policy.tasks.map(t => t.id)).toEqual(["t1", "t2", "t5", "t6"]);
    expect(ap.runs.map(r => r.taskId)).toEqual(["t1", "t2"]);
    expect(ap.status).toBe("waiting_user");
    expect(ap.waiting?.taskIds).toContain("t3");
    expect(ap.waiting?.message).toContain("Desenvolvedor");
    expect(calls).toHaveLength(2);
    for (const r of ap.runs) {
      const ev = await store.events(r.runId);
      expect(ev.some(e => e.kind === "auto_approved" && e.message.includes(id.slice(0, 8)))).toBe(true);
      expect(ev.some(e => e.kind === "approved")).toBe(false); // never recorded as the user's own confirmation
    }
    expect(await store.runsForTask(plan, "t3")).toHaveLength(0); // the Developer is never prepared by the supervisor

    // The user sends the Developer task by hand; when it settles, the supervisor continues by itself.
    const t3 = body<{ run: RunDetail }>(await svc.prepareDeveloper(devReq(plan, "t3"))).run;
    await svc.approve(t3.id, { snapshotHash: t3.snapshotHash });
    await svc.idle();
    ap = await apOf(id);
    expect(ap.runs.map(r => r.taskId)).toEqual(["t1", "t2", "t5", "t6"]);
    expect(ap.status).toBe("concluded");
    expect((await store.get(ap.runs[3].runId))!.reviewer?.verdict).toBe("aprovado");
    expect((await store.events(t3.id)).some(e => e.kind === "auto_approved")).toBe(false);
    expect(ap.usedTokens).toBeGreaterThan(0);
    expect((await store.events(plan)).map(e => e.kind)).toEqual(expect.arrayContaining(["autopilot_prepared", "autopilot_approved", "autopilot_step", "autopilot_waiting", "autopilot_concluded"]));
    expect(repo.status()).toBe(""); // the user's checkout is never touched
  });
});

describe("Piloto automático: freios", { timeout: 60_000 }, () => {
  it("esclarecimento pedido para a política; a tarefa seguinte não é preparada", async () => {
    const repo = makeDevRepo(work);
    const plan = await apPlan(repo);
    const { svc } = service([reply(clarify())], { s: store, localRepos: [repo.dir] });
    const id = await activate(svc, plan);
    expect(await apOf(id)).toMatchObject({ status: "paused", stop: { code: "clarification" } });
    expect(await store.runsForTask(plan, "t2")).toHaveLength(0);
  });

  it("falha para a política (D3: sem nova tentativa automática)", async () => {
    const repo = makeDevRepo(work);
    const plan = await apPlan(repo);
    const { svc, calls } = service([new AgentError("auth_busy", "Failed to refresh OAuth token", false)], { s: store, localRepos: [repo.dir] });
    const id = await activate(svc, plan);
    expect(await apOf(id)).toMatchObject({ status: "paused", stop: { code: "failed" } });
    expect(calls).toHaveLength(1);
    expect(await store.runsForTask(plan, "t1")).toHaveLength(1);
  });

  it("uso não informado pelo cliente para a política", async () => {
    const repo = makeDevRepo(work);
    const plan = await apPlan(repo);
    const { svc } = service([reply(analysis(), null)], { s: store, localRepos: [repo.dir] });
    const id = await activate(svc, plan);
    expect(await apOf(id)).toMatchObject({ status: "paused", stop: { code: "usage_unknown" } });
  });

  it("orçamento da demanda: a projeção passaria do limite — o envio fica aguardando a sua revisão e nada é chamado", async () => {
    const repo = makeDevRepo(work);
    const plan = await apPlan(repo);
    const { svc, calls } = service([], { s: store, localRepos: [repo.dir] });
    const id = await activate(svc, plan, { budgetTokens: 1_000 });
    const ap = await apOf(id);
    expect(ap).toMatchObject({ status: "paused", stop: { code: "budget" } });
    expect(ap.runs).toHaveLength(0);
    expect((await store.get(ap.stop!.runId!))!.status).toBe("awaiting_approval");
    expect(calls).toHaveLength(0);
  });

  it("estimativa acima do orçamento da ficha para antes de aprovar", async () => {
    const repo = makeDevRepo(work);
    const plan = await apPlan(repo);
    const { svc, calls } = service([], { s: store, localRepos: [repo.dir] });
    const id = await activate(svc, plan, { sheets: { ...apSheets(), architect: architectSheet({ budget: 10 }) } });
    expect(await apOf(id)).toMatchObject({ status: "paused", stop: { code: "sheet_budget" } });
    expect(calls).toHaveLength(0);
  });

  it("máximo de execuções da política", async () => {
    const repo = makeDevRepo(work);
    const plan = await apPlan(repo);
    const { svc } = service([reply(analysis())], { s: store, localRepos: [repo.dir] });
    const id = await activate(svc, plan, { maxRuns: 1 });
    expect(await apOf(id)).toMatchObject({ status: "paused", stop: { code: "max_runs" } });
    expect((await apOf(id)).runs.map(r => r.taskId)).toEqual(["t1"]);
  });

  it("cancelamento de uma execução da política para a política", async () => {
    const repo = makeDevRepo(work);
    const plan = await apPlan(repo);
    let svcRef: ExecutorService | null = null;
    const { svc } = service([async () => { const open = (await store.runsForTask(plan, "t1"))[0]; await svcRef!.cancel(open.id); return reply(analysis()); }], { s: store, localRepos: [repo.dir] });
    svcRef = svc;
    const id = await activate(svc, plan);
    expect(await apOf(id)).toMatchObject({ status: "paused", stop: { code: "canceled_by_user" } });
  });

  it("D2: QA sem versão para testar (sem projeto local) para a política antes de aprovar", async () => {
    const plan = await directorPlan(goodPlan()); // t1 Developer → t2 QA; no local project authorized
    const { svc, calls } = service();
    expect((await svc.recordTaskCompletion({ parentRunId: plan, taskId: "t1", kind: "direct_implementation", commit: "a".repeat(40), files: ["src/botao.tsx"], verification: { typecheck: null, lint: null, tests: null, build: null }, note: "Implementado fora do encaminhamento (teste)." })).status).toBe(201);
    await svc.idle();
    const id = await activate(svc, plan, { sheets: { qa: qaSheet() } });
    expect(await apOf(id)).toMatchObject({ status: "paused", stop: { code: "no_tested_version" } });
    expect(calls).toHaveLength(0);
  });
});

describe("Piloto automático: integridade", { timeout: 60_000 }, () => {
  it("hash adulterado é recusado na confirmação e na retomada", async () => {
    const repo = makeDevRepo(work);
    const plan = await apPlan(repo);
    const { svc } = service([reply(clarify())], { s: store, localRepos: [repo.dir] });
    const ap = body<{ autopilot: AP }>(await svc.prepareAutopilot(apReq(plan))).autopilot;
    expect((await svc.approveAutopilot(ap.id, { policyHash: "0".repeat(64) })).status).toBe(409);
    expect((await apOf(ap.id)).status).toBe("awaiting_approval");
    await svc.approveAutopilot(ap.id, { policyHash: ap.policyHash });
    await svc.idle();
    expect((await apOf(ap.id)).status).toBe("paused"); // clarification
    expect((await svc.resumeAutopilot(ap.id, { policyHash: "f".repeat(64) })).status).toBe(409);
    expect((await apOf(ap.id)).status).toBe("paused");
  });

  it("o supervisor nunca aprova um envio do Desenvolvedor, mesmo chamado diretamente", async () => {
    const repo = makeDevRepo(work);
    const { plan } = await localChainWithAnalyses(repo, store);
    const { svc } = service([], { s: store, localRepos: [repo.dir] });
    const t3 = body<{ run: RunDetail }>(await svc.prepareDeveloper(devReq(plan, "t3"))).run;
    expect(await svc.approveByPolicy(t3.id, t3.snapshotHash, { id: "x".repeat(36), policyHash: "h", approvedAt: null }, "teste")).toBe(false);
    expect((await store.get(t3.id))!.status).toBe("awaiting_approval");
  });

  it("dois acionamentos simultâneos geram um único envio", async () => {
    const repo = makeDevRepo(work);
    const plan = await apPlan(repo);
    const { svc } = service([reply(clarify())], { s: store, localRepos: [repo.dir] });
    const ap = body<{ autopilot: AP }>(await svc.prepareAutopilot(apReq(plan))).autopilot;
    await Promise.all([svc.approveAutopilot(ap.id, { policyHash: ap.policyHash }), svc.supervisor.tick(ap.id), svc.supervisor.tick(ap.id)]);
    await svc.idle();
    expect(await store.runsForTask(plan, "t1")).toHaveLength(1);
  });

  it("limite por hora: espera sem chamar você; ao reiniciar o executor com limite livre, retoma sozinho — e uma política pausada continua parada", async () => {
    const repo = makeDevRepo(work);
    const plan = await apPlan(repo);
    const limited = (steps: Parameters<typeof fakeAdapter>[0], maxRunsPerHour: number) => {
      const a = fakeAdapter(steps);
      const svc = new ExecutorService({ ...cfg(), limits: { ...cfg().limits, maxRunsPerHour }, localRepos: [repo.dir] }, { store, runner: runProcess, env: process.env, detectors: { claude_code: async () => connected("claude_code"), codex: async () => connected("codex") }, adapters: { claude_code: a.adapter, codex: a.adapter } });
      return { svc, calls: a.calls };
    };
    const one = limited([], 1); // the Director plan itself already counts in the last hour
    const id = await activate(one.svc, plan);
    expect(await apOf(id)).toMatchObject({ status: "waiting_rate_limit" });
    expect(await store.runsForTask(plan, "t1")).toHaveLength(0);
    one.svc.abortAll();

    const two = limited([reply(clarify())], 50);
    await two.svc.boot();
    await two.svc.idle();
    expect(await store.runsForTask(plan, "t1")).toHaveLength(1);
    expect(await apOf(id)).toMatchObject({ status: "paused", stop: { code: "clarification" } });

    const three = limited([], 50);
    await three.svc.boot();
    await three.svc.idle();
    expect(await store.runsForTask(plan, "t2")).toHaveLength(0);
    expect(three.calls).toHaveLength(0);
  });

  it("D1: commit proposto diferente do Diretor é aceito com o motivo registrado na revisão", async () => {
    const repo = makeDevRepo(work);
    const plan = await apPlan(repo);
    // t1 analyzed by hand from the local copy, so t2's proposal (local_git) differs from the Director's GitHub commit.
    const manual = service([reply(analysis())], { s: store, localRepos: [repo.dir] });
    const t1 = body<{ run: RunDetail }>(await manual.svc.prepare({ ...handoffReq(plan, "t1"), source: { via: "local_git", commit: repo.base }, revisionReason: "Ler do commit local real (teste)." })).run;
    await manual.svc.approve(t1.id, { snapshotHash: t1.snapshotHash });
    await manual.svc.idle();
    const { svc } = service([reply(clarify())], { s: store, localRepos: [repo.dir] });
    const id = await activate(svc, plan, { taskIds: ["t2"] });
    const t2 = (await apOf(id)).runs[0];
    expect(t2.taskId).toBe("t2");
    const snap = (await store.snapshot(t2.runId)) as ArchitectSnapshot;
    expect(snap.revision?.reason).toContain("Piloto automático (D1)");
    expect((await store.events(t2.runId)).find(e => e.kind === "auto_approved")?.message).toContain("D1");
  });

  it("recusa preparar sem a ficha do responsável, com ficha sem conexão ou num plano que já tem política em andamento", async () => {
    const repo = makeDevRepo(work);
    const plan = await apPlan(repo);
    const { svc } = service([reply(clarify())], { s: store, localRepos: [repo.dir] });
    expect(body<{ error: { code: string } }>(await svc.prepareAutopilot(apReq(plan, { sheets: { qa: qaSheet(), reviewer: reviewerSheet() } }))).error.code).toBe("sheet_missing");
    expect(body<{ error: { code: string } }>(await svc.prepareAutopilot(apReq(plan, { sheets: { ...apSheets(), qa: qaSheet({ connection: "none" }) } }))).error.code).toBe("no_connection");
    await activate(svc, plan);
    expect(body<{ error: { code: string } }>(await svc.prepareAutopilot(apReq(plan))).error.code).toBe("autopilot_open");
  });
});

// Director → user approval → Architect. The official clients are replaced by
// scripted adapters (SIMULATED); GitHub is a fake fetch. Real runs are done
// separately (see docs/executor-local.md, "Verificação").
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { refPath, validateAnalysis } from "@/lib/engine/analysis-schema";
import { handoffBlocker, taskState } from "@/lib/engine/handoff-state";
import { reportedTotal, type ArchitectAnalysis, type ArchitectSnapshot, type DirectorPlan, type RunDetail } from "@/lib/engine/types";
import { claudeArgs, claudeUsage } from "@/lib/executor/adapters/claude";
import { codexArgs, parseCodexEvents } from "@/lib/executor/adapters/codex";
import { AgentError, type AgentCall } from "@/lib/executor/adapters/types";
import { expandTerms, extractPathMentions, scorePath, shrinkGithubText, termGroups } from "@/lib/executor/github";
import { buildNewRun, parseStartRequest } from "@/lib/executor/runs-service";
import { ExecutorService, type ExecutorConfig } from "@/lib/executor/service";
import { sqliteDriver } from "@/lib/executor/sqlite";
import { RunStore } from "@/lib/executor/store";
import { runProcess } from "@/lib/executor/proc";
import { excerptFile } from "@/lib/executor/github";
import { questionSimilarity } from "@/lib/engine/analysis-schema";
import { promptComposition } from "@/lib/engine/composition";
import { execFileSync } from "node:child_process";
import { createHash as hashOf } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { connected, fakeAdapter, goodPlan, member, reply, request, usage } from "./helpers";

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
    expect(body<{ run: RunDetail }>(second).run.prompt?.user).toContain("Análise registrada do Arquiteto: Adicionar a classe azul no Botao.");
  });

  it("o estado das tarefas na interface segue os registros do executor", () => {
    const plan = archPlan();
    expect(taskState(plan.tasks[2], []).key).toBe("not_executable");
    expect(taskState(plan.tasks[0], []).key).toBe("proposed");
    expect(handoffBlocker(plan.tasks[1], plan.tasks, () => [])).toContain("t1");
    expect(handoffBlocker(plan.tasks[3], plan.tasks, () => [])).toContain("ainda não executa");
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
    expect((await store.detail(run.id))!.events.at(-1)?.message).toContain("processo do cliente oficial foi encerrado");
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

describe("cópia local autorizada (somente leitura, Git real em pasta temporária)", () => {
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

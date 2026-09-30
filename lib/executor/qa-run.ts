// Execution of a tool-equipped QA run (toolsMode "executor_operations"), after the user approved it:
// 1. the executor builds the isolated environment of the exact tested version and produces the automatic
//    evidence (the delivered diff, dependency preparation, the project's own checks);
// 2. model call 1: QA asks for operations (reads, searches, checks, browser scenarios) — the executor runs them;
// 3. model call 2: QA classifies the criteria citing evidence ids, or asks for ONE extra round of operations;
// 4. (optional) model call 3: final classification, no more operations.
// The model never gets a tool: every observation in the result is evidence the executor itself produced,
// with its artifacts kept under the run's artifact folder. Whatever happens (success, failure, cancellation)
// the app under test, the browser and the environment are stopped/removed; the tested files are checked
// for changes before removal.
import { readFileSync } from "node:fs";
import path from "node:path";
import { QA_OPS_SCHEMA, QA_TOOL_EVAL_SCHEMA, validateOperations, validateToolQAResult, type OperationRequest } from "@/lib/engine/qa-tooled-schema";
import { evalInstruction, evidenceBlock, PLAN_INSTRUCTION, versionLine } from "@/lib/engine/qa-tooled-prompt";
import type { QAEnvironmentReport, QAEvidence, QAResult, QASnapshot, QAToolingStatus, RunError, RunStatus } from "@/lib/engine/types";
import type { AgentReply } from "./adapters/types";
import type { AppFixture } from "./qa-browser";
import { CHECK_LABEL, buildEnv, checkCatalog, deliveryChanges, destroyEnv, prepareDependencies, resolvePackageManager, runEnvCommand, writeArtifact, type EnvDeps, type QAEnv } from "./qa-env";
import { runOperation, runOrientation, type OpsContext } from "./qa-ops";
import { getProject, type ProjectDeps } from "./projects";
import type { RunStore } from "./store";
import { trackedFiles } from "./worktree";

export type ToolQAContext = {
  runId: string;
  snap: QASnapshot;
  prompt: { system: string; user: string };
  store: RunStore;
  envDeps: EnvDeps;
  projects: ProjectDeps;
  workRoot: string;
  artifactsDir: string;
  fixture: (planId: string, srcDir: string) => Promise<AppFixture | null>;
  planId: string;
  /** One model call through the approved connection (errors already turned into run failures); null = canceled. */
  callModel: (label: string, user: string, schema: Record<string, unknown>) => Promise<AgentReply | null>;
  fail: (e: RunError) => never;
};

type Outcome = { status: RunStatus; result: object; message: string };

const clipText = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n[… cortado em ${n} caracteres; completo no artefato]` : s);

export async function runToolQA(c: ToolQAContext): Promise<Outcome | null> {
  const { snap, store, runId } = c;
  const signal = c.envDeps.signal;
  let n = 0;
  const nextId = () => `E${++n}`;
  const evidence: QAEvidence[] = [];
  let tooling: QAToolingStatus = snap.tooling!;
  let env: QAEnv | null = null;
  const app: OpsContext["app"] = { current: null, error: null };
  const report: QAEnvironmentReport = { preparedAt: new Date().toISOString(), dependencies: null, network: "Nenhuma preparação de dependências foi feita.", browser: null, appUrl: null, modifiedDeliveryFiles: [], apiRequests: { blocked: 0, servedFromFixture: 0, notFound: 0 }, cleanup: "" };
  const version = snap.testedVersion ?? null;
  /** Marks operations unavailable with the concrete reason; reading/searching need the environment too (all = true). */
  const disable = (why: string, all = false) => { tooling = { ...tooling, operations: tooling.operations.map(o => (!all && (o.id === "read" || o.id === "search") ? o : { ...o, available: false, how: why })) }; };

  try {
    // 1a. The delivered diff, as the executor itself computed/recorded it (automatic inspection evidence).
    for (const d of snap.deliverables) {
      if (!d.diffText) continue;
      const art = writeArtifact(c.artifactsDir, `diff-${d.taskId}.patch`, d.diffText, "text", `Diff entregue de ${d.taskId}`);
      evidence.push({ id: nextId(), method: "inspection", criteria: [], purpose: `Diff real da entrega de ${d.taskId} (${d.files.join(", ")})`, requestedBy: "executor", round: 0, version: versionLine(version), steps: [`diff registrado pelo executor para ${d.taskId}`], command: null, observed: clipText(d.diffText, 20_000), ok: true, artifacts: [art], author: "executor", origin: "Produzida automaticamente pelo executor a partir do registro da entrega (não é relato de nenhum colaborador)." });
    }
    // 1b. The environment of the exact version.
    let pm = resolvePackageManager(c.envDeps, null);
    if (version) {
      await store.event(runId, "qa_env", `Montando o ambiente isolado da versão testada: ${versionLine(version)}.`);
      try {
        const project = await getProject(version.projectId, c.projects);
        if (!project || project.problem) throw new Error(project?.problem ?? "o projeto local da versão testada não está mais autorizado no executor");
        let patch: string | undefined, files: { path: string; content: Buffer }[] | undefined;
        if (version.kind === "commit_plus_patch") patch = (await store.get(version.runId))?.developer?.diff?.diffText;
        if (version.kind === "commit_plus_files") files = version.files.filter(f => f.sha256).map(f => ({ path: f.path, content: readFileSync(path.join(project.dir, ...f.path.split("/"))) }));
        env = await buildEnv({ root: path.join(c.workRoot, `${runId}.qa`), artifactsDir: c.artifactsDir, sourceDir: project.dir, version, patch, files }, c.envDeps);
        await store.event(runId, "qa_env_ready", `Ambiente isolado pronto: ${env.fileCount} arquivo(s) da versão ${version.label}; árvore ${env.version.treeHash}.`, { treeHash: env.version.treeHash });
      } catch (e) {
        disable(`o ambiente isolado da versão testada não pôde ser montado: ${(e as Error).message}`, true);
        await store.event(runId, "qa_env_failed", `Não foi possível montar o ambiente isolado: ${(e as Error).message}. Comandos e navegador ficam indisponíveis nesta revisão.`);
      }
    } else disable("nenhuma versão reproduzível da entrega (ver <versao_testada>)", true);
    if (signal?.aborted) return null;

    if (env) {
      pm = resolvePackageManager(c.envDeps, env.srcDir);
      if (!pm.ok) disable(pm.detail);
    }
    if (env && pm.ok) {
      await store.event(runId, "qa_deps", "Preparando as dependências pelo lockfile do projeto (sem rede, do store local, primeiro).");
      const deps = await prepareDependencies(env, pm, c.envDeps);
      report.dependencies = deps.evidence; report.network = deps.network;
      evidence.push({ id: nextId(), method: "command", criteria: [], purpose: "Preparar dependências (etapa separada dos testes)", requestedBy: "executor", round: 0, version: versionLine(env.version), steps: [deps.evidence.command], command: deps.evidence, observed: `${deps.network} Código de saída ${deps.evidence.exitCode}.\n${deps.evidence.tail.slice(-1200)}`, ok: deps.evidence.exitCode === 0, artifacts: deps.artifacts, author: "executor", origin: "Produzida automaticamente pelo executor." });
      if (signal?.aborted) return null;
      if (deps.evidence.exitCode !== 0) disable("as dependências do projeto não puderam ser preparadas (ver a evidência de preparação)");
      else {
        for (const chk of checkCatalog(env.srcDir)) {
          if (signal?.aborted) return null;
          await store.event(runId, "qa_check", `Rodando ${CHECK_LABEL[chk.id]} no ambiente isolado…`);
          const r = await runEnvCommand(env, pm as Extract<typeof pm, { ok: true }>, CHECK_LABEL[chk.id], chk.args, `base-${chk.id}.log`, 900_000, c.envDeps);
          evidence.push({ id: nextId(), method: "command", criteria: [], purpose: `Verificação padrão do projeto: ${CHECK_LABEL[chk.id]}`, requestedBy: "executor", round: 0, version: versionLine(env.version), steps: [r.evidence.command], command: r.evidence, observed: `Código de saída ${r.evidence.exitCode}${r.evidence.timedOut ? " (tempo esgotado)" : ""}. Final da saída:\n${r.evidence.tail.slice(-1500)}`, ok: r.evidence.exitCode === 0, artifacts: [r.artifact], author: "executor", origin: "Produzida automaticamente pelo executor (verificações do próprio projeto)." });
        }
      }
    }
    if (signal?.aborted) return null;

    const tracked = env ? await trackedFiles({ workDir: env.srcDir, hooksDir: env.hooksDir }, c.envDeps.git) : [];
    const fixture = env ? await c.fixture(c.planId, env.srcDir) : null;
    const ctx: OpsContext = { env: env!, pm, deps: c.envDeps, tracked, fixture, tooling, versionLabel: versionLine(env?.version ?? version), nextId, app };
    // 1c. Orientation map of the interface (executor-authored; checks no criterion), so call 1 can plan real paths.
    if (env) {
      await store.event(runId, "qa_orientation", "Registrando a orientação da interface (o que cada clicável da tela inicial abre)…");
      const o = await runOrientation(ctx).catch(e => { if (signal?.aborted) return null; void store.event(runId, "qa_orientation_failed", `A orientação da interface falhou: ${(e as Error).message.slice(0, 300)}. Os cenários pedidos pelo QA seguem normalmente.`); return null; });
      if (o) { evidence.push(o); report.browser = tooling.browser.detail; report.appUrl = app.current?.url ?? null; }
    }
    if (signal?.aborted) return null;
    const runOps = async (ops: OperationRequest[], round: number) => {
      for (const op of ops) {
        if (signal?.aborted) return false;
        await store.event(runId, "qa_operation", `Rodada ${round}: ${op.type}${op.path ? ` ${op.path}` : ""}${op.check ? ` ${op.check}` : ""}${op.scenario_name ? ` “${op.scenario_name}”` : ""} — ${op.purpose.slice(0, 160)}`);
        const e = await runOperation(ctx, op, round);
        evidence.push(e);
        if (e.method === "browser") { report.browser = tooling.browser.detail; report.appUrl = app.current?.url ?? null; }
      }
      return true;
    };

    // 2. Call 1 — which operations?
    const expected = snap.demand.acceptanceCriteria;
    const downstream = snap.plan.dependents.map(d => d.id);
    const ask = async <T,>(label: string, instruction: string, schema: Record<string, unknown>, validate: (out: unknown) => ({ ok: true } & T) | { ok: false; errors: string[] }): Promise<(({ ok: true } & T)) | null> => {
      const user = `${c.prompt.user}\n\n${evidenceBlock(evidence)}\n\n${instruction}`;
      let prompt = user;
      for (let attempt = 1; attempt <= 2; attempt++) {
        const reply = await c.callModel(attempt === 1 ? label : `${label} (correção)`, prompt, schema);
        if (!reply) return null;
        const v = reply.output && typeof reply.output === "object" ? validate(reply.output) : { ok: false as const, errors: ["A resposta não é um JSON válido."] };
        if (v.ok) return v;
        await store.event(runId, "invalid_response", `Resposta inválida (${v.errors.length} problema(s)).`, { errors: v.errors });
        if (attempt === 2) c.fail({ code: "invalid_response", message: "O modelo não produziu uma resposta válida após uma tentativa de correção.", detail: v.errors.join(" | "), retryable: true, recovery: ["Prepare um novo envio ao QA. Se repetir, revise a ficha do QA."] });
        prompt = `${user}\n\n<resposta_anterior_invalida>\n${reply.text.slice(0, 20000)}\n</resposta_anterior_invalida>\nA resposta anterior não passou na validação do Setor IA:\n- ${v.errors.join("\n- ")}\nEnvie a resposta completa corrigida no mesmo formato.`;
        await store.event(runId, "correction", "Pedindo uma correção ao modelo (uma única tentativa).");
      }
      return null;
    };

    let calls = 0;
    const plan = await ask<{ summary: string; operations: OperationRequest[] }>("QA: planejar operações", PLAN_INSTRUCTION, QA_OPS_SCHEMA as unknown as Record<string, unknown>, validateOperations);
    calls++;
    if (!plan) return null;
    await store.event(runId, "qa_plan", `O QA pediu ${plan.operations.length} operação(ões): ${plan.summary.slice(0, 300)}`, { operations: plan.operations.map(o => ({ id: o.id, type: o.type })) });
    if (!(await runOps(plan.operations, 1))) return null;

    // 3. Call 2 (and at most one extra round).
    let final: QAResult | null = null;
    for (let round = 2; round <= 3 && !final; round++) {
      const allow = round === 2;
      const ids = new Set(evidence.map(e => e.id));
      const v = await ask<{ result: QAResult; followups: OperationRequest[] }>(round === 2 ? "QA: avaliar" : "QA: avaliar (rodada final)", evalInstruction(allow), QA_TOOL_EVAL_SCHEMA as unknown as Record<string, unknown>, out => validateToolQAResult(out, { expectedCriteria: expected, evidenceIds: ids, downstreamTasks: downstream, allowFollowups: allow }));
      calls++;
      if (!v) return null;
      if (allow && v.followups.length) {
        await store.event(runId, "qa_followup", `O QA pediu mais ${v.followups.length} operação(ões) antes de concluir.`);
        if (!(await runOps(v.followups, 2))) return null;
        continue;
      }
      final = v.result;
    }
    if (!final) c.fail({ code: "invalid_response", message: "O QA não concluiu a classificação dentro das rodadas permitidas.", retryable: true });

    // 4. Integrity of the tested code and the report.
    if (env) report.modifiedDeliveryFiles = await deliveryChanges(env, c.envDeps);
    for (const e of evidence) if (e.method === "browser") {
      const m = /(\d+) atendidas por dados simulados, (\d+) bloqueadas \(escrita\/execução\), (\d+) sem dado simulado/.exec(e.observed);
      if (m) { report.apiRequests.servedFromFixture += +m[1]; report.apiRequests.blocked += +m[2]; report.apiRequests.notFound += +m[3]; }
    }
    const result: QAResult = { ...final!, evidence, testedVersion: env?.version ?? version ?? undefined, environment: report, rounds: calls };
    const approved = final!.criteria.filter(x => x.verdict === "approved").length;
    const status: RunStatus = final!.outcome === "needs_clarification" ? "awaiting_clarification" : "review_ready";
    return { status, result, message: status === "review_ready" ? `Revisão de QA com operações do executor concluída: ${approved}/${final!.criteria.length} critério(s) aprovado(s), ${evidence.length} evidência(s) registrada(s).` : `O QA precisa de esclarecimento: ${final!.questions.length} pergunta(s).` };
  } finally {
    const cleanup: string[] = [];
    if (app.current) { try { cleanup.push(await app.current.stop()); } catch { cleanup.push("falha ao encerrar o servidor da aplicação em teste"); } }
    if (env && !report.modifiedDeliveryFiles.length) { try { report.modifiedDeliveryFiles = await deliveryChanges(env, c.envDeps); } catch { /* best effort */ } }
    cleanup.push(destroyEnv(env));
    report.cleanup = cleanup.join("; ");
  }
}

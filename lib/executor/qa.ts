// Hand-off of ONE QA task, in the same two steps as the Architect's and the Developer's:
// 1. prepare: validates against the executor's own records (every dependency, transitively, must have real
//    evidence — see lib/engine/dependency.ts), gathers the real deliverables (commits, diffs, verification
//    results already computed elsewhere) and freezes the exact prompt as "awaiting_approval". QA gets NO
//    live tools at all (read_only mode, like the Architect): nothing is materialized, no working copy, no
//    model is called here.
// 2. approve: the user confirms that exact prompt (by its hash); only then the run is queued.
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { buildToolQAMessage, buildToolQASystem } from "@/lib/engine/qa-tooled-prompt";
import { QA_OPS_SCHEMA, QA_TOOL_EVAL_SCHEMA } from "@/lib/engine/qa-tooled-schema";
import { dependencyEvidence, findDependencyIssues } from "@/lib/engine/dependency";
import { isHandoffTarget } from "@/lib/engine/handoff-state";
import { QA_ASSIGNEE, type DependencyAnalysis, type DirectorSnapshot, type PlanTask, type QADeliverable, type QASnapshot, type QATool, type QAToolingStatus, type RunBudget, type RunRecord, type TestedVersion } from "@/lib/engine/types";
import { scanPatch, sha256 as sha256Hex } from "./apply";
import { detectQATooling } from "./qa-ops";
import { listProjects, loadExecPlan } from "./projects";
import { dependencyAnalysis, HandoffRefused, type PrepareDeps } from "./handoff";
import { listLocalRepos, listTreeEntries, readCommitDiff, runGit } from "./local-git";
import { estimateTokens } from "./planner";
import { MemberZ } from "./runs-service";
import type { NewRun, RunStore } from "./store";

const refuse = (status: number, code: string, message: string, details?: string[]): never => { throw new HandoffRefused(status, code, message, details); };
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

export const QAHandoffZ = z.object({
  idempotencyKey: z.string().regex(/^[A-Za-z0-9:_-]{8,120}$/),
  directorRunId: z.string().uuid(),
  taskId: z.string().min(1).max(64),
  /** The QA's saved sheet (configuration only; it cannot change who runs or what task). */
  agent: MemberZ,
  /** Explicit new review of a task that already has one (the earlier parecer stays in the history, untouched). */
  repeat: z.boolean().optional(),
});
export type QAHandoffRequest = z.infer<typeof QAHandoffZ>;

/**
 * What a tool-equipped QA run may do, as the EXECUTOR provides it (the model itself still has no tool): the
 * operations detected on this computer, plus what stays impossible whatever the connection.
 */
export function toolQATools(t: QAToolingStatus): QATool[] {
  return [
    ...t.operations.map(o => ({ label: o.label, allowed: o.available, how: o.how })),
    { label: "Editar o código da entrega", allowed: false, how: "Bloqueado: não existe operação de escrita no catálogo; o executor confere ao final que nenhum arquivo versionado da versão testada mudou." },
    { label: "Publicar, fazer push ou deploy", allowed: false, how: "Impossível: o ambiente isolado não tem remoto, credenciais do GitHub nem das contas; nenhuma operação do catálogo publica nada." },
  ];
}

/** Legacy text-only QA (runs prepared before the tool-equipped mode). Kept so their records still render. */
export function qaTools(): QATool[] {
  return [
    { label: "Ler arquivos do repositório", allowed: false, how: "Bloqueada: QA não recebe acesso ao repositório. Tudo o que precisa (commits, diffs reais, resultados de verificação) já vem pronto em <entregas_reais>." },
    { label: "Editar arquivos", allowed: false, how: "Bloqueada: sem ferramentas nesta execução (--tools \"\" / sandbox somente leitura), pasta de trabalho vazia." },
    { label: "Terminal / comandos", allowed: false, how: "Bloqueado pelo executor. Os resultados de verificação mostrados foram executados fora desta chamada, pelo próprio executor, e são colados como texto." },
    { label: "Navegador e busca na web", allowed: false, how: "Bloqueados pelo executor." },
    { label: "Publicar, fazer push ou abrir pull request", allowed: false, how: "Impossível: o cliente não recebe o repositório nem credencial do GitHub." },
  ];
}

/** What identifies the delivered code of the nearest dependency with code (BFS order = direct dependency first). */
type VersionHint =
  | { taskId: string; kind: "commit"; commit: string; label: string }
  | { taskId: string; kind: "patch"; baseCommit: string; runId: string; diffText: string; truncated: boolean }
  | { taskId: string; kind: "application"; applicationId: string };
type Chain = { analyses: (DependencyAnalysis & { taskId: string; title: string })[]; deliverables: QADeliverable[]; hint: VersionHint | null };

/**
 * Walks the WHOLE dependency chain of `task` (not only direct dependencies), refusing if any ancestor is
 * unmet, and collects real evidence for every ancestor that has it: Architect analyses and validated
 * deliverables (commit, files, verification, real diff). Never trusts a bare LocalResolution — only a
 * validated TaskCompletion or a genuinely completed run counts (see lib/engine/dependency.ts).
 */
async function collectDeliveryChain(task: PlanTask, tasks: PlanTask[], store: RunStore, parentRunId: string, local: PrepareDeps["local"]): Promise<Chain> {
  const runsCache = new Map<string, RunRecord[]>();
  const runsOf = (id: string) => runsCache.get(id) ?? [];
  const completions = await store.taskCompletionsForPlan(parentRunId);
  const completionsOf = (id: string) => completions.filter(c => c.taskId === id);
  for (const t of tasks) runsCache.set(t.id, await store.runsForTask(parentRunId, t.id));

  const { missing, cycles } = findDependencyIssues(tasks);
  if (missing.some(m => m.task === task.id || tasks.some(x => x.id === m.task))) {
    const m = missing[0];
    refuse(409, "dependency_missing", `A tarefa ${m.task} depende de "${m.dep}", que não existe neste plano.`);
  }
  if (cycles.length) refuse(409, "dependency_cycle", `Dependência circular detectada: ${cycles[0].join(" → ")}.`);

  const analyses: Chain["analyses"] = [];
  const deliverables: QADeliverable[] = [];
  let hint: VersionHint | null = null;
  const seen = new Set<string>();
  const queue = [...task.depends_on];
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id) || id === task.id) continue;
    seen.add(id);
    const dep = tasks.find(t => t.id === id);
    if (!dep) continue;
    const ev = dependencyEvidence(dep, runsOf, completionsOf);
    if (ev.kind === "unmet") refuse(409, "dependency_pending", `A tarefa ${task.id} depende de ${dep.id}, que ainda não tem entrega concluída e validada.`, [dep.id]);
    if (ev.kind === "run_completed" && isHandoffTarget(dep.assignee) && ev.run.analysis) {
      const a = await dependencyAnalysis(store, ev.run);
      if (a) analyses.push({ ...a, taskId: dep.id, title: dep.title });
    } else if (ev.kind === "run_completed" && ev.run.developer) {
      deliverables.push({
        taskId: dep.id, title: dep.title, assignee: dep.assignee, origin: "run_completed",
        commit: ev.run.developer.diff?.baseCommit ?? null, files: ev.run.developer.diff?.files.map(f => f.path) ?? [],
        verification: null, diffText: ev.run.developer.diff?.diffText ?? null, diffTruncated: ev.run.developer.diff?.diffTruncated ?? false,
        note: "Execução do Desenvolvedor concluída (implementation_ready): diff real calculado pelo executor; ainda não aplicado a nenhum projeto.",
      });
      if (!hint && ev.run.developer.diff) hint = { taskId: dep.id, kind: "patch", baseCommit: ev.run.developer.diff.baseCommit, runId: ev.run.id, diffText: ev.run.developer.diff.diffText, truncated: ev.run.developer.diff.diffTruncated };
    } else if (ev.kind === "resolved_clarification_validated") {
      const diff = ev.run.developer?.diff;
      deliverables.push({
        taskId: dep.id, title: dep.title, assignee: dep.assignee, origin: "resolved_clarification_validated",
        commit: ev.completion.commit, files: ev.completion.files, verification: ev.completion.verification,
        diffText: diff?.diffText ?? null, diffTruncated: diff?.diffTruncated ?? false,
        note: `Pediu esclarecimento ao modelo; entrega resolvida e validada localmente. ${ev.completion.note}`,
      });
      if (!hint) hint = { taskId: dep.id, kind: "commit", commit: ev.completion.commit, label: `commit ${ev.completion.commit.slice(0, 8)} (entrega validada localmente)` };
    } else if (ev.kind === "applied_run_result_validated") {
      // The FINAL diff is the committed one (what actually landed in the checkout); the Developer run's own
      // original diff stays in that run's record, referenced by id, untouched.
      let diffText: string | null = null, diffTruncated = false;
      if (ev.completion.applicationId) {
        // Applied through the interface and not committed: the change is the run's own persisted diff.
        diffText = ev.run.developer?.diff?.diffText ?? null; diffTruncated = ev.run.developer?.diff?.diffTruncated ?? false;
      } else if (local?.dirs.length) {
        try {
          const repos = await listLocalRepos(local.dirs, local.git);
          const repo = repos[0];
          if (repo) { const d = await readCommitDiff(repo.dir, ev.completion.commit, local.git); diffText = d.diffText; diffTruncated = d.diffTruncated; }
        } catch { /* best effort: the deliverable still lists commit/files/verification without a diff */ }
      }
      if (!hint) hint = ev.completion.applicationId ? { taskId: dep.id, kind: "application", applicationId: ev.completion.applicationId } : { taskId: dep.id, kind: "commit", commit: ev.completion.commit, label: `commit ${ev.completion.commit.slice(0, 8)} (entrega aplicada e commitada)` };
      deliverables.push({
        taskId: dep.id, title: dep.title, assignee: dep.assignee, origin: "applied_run_result_validated",
        commit: ev.completion.commit, files: ev.completion.files, verification: ev.completion.verification,
        diffText, diffTruncated, note: `Resultado da execução ${ev.run.id} do Desenvolvedor, aplicado ao checkout e validado localmente (diff acima = diff final do commit; o diff original continua no registro dessa execução). ${ev.completion.note}`,
      });
    } else if (ev.kind === "direct_implementation_validated") {
      let diffText: string | null = null, diffTruncated = false;
      if (local?.dirs.length) {
        try {
          const repos = await listLocalRepos(local.dirs, local.git);
          const repo = repos[0];
          if (repo) { const d = await readCommitDiff(repo.dir, ev.completion.commit, local.git); diffText = d.diffText; diffTruncated = d.diffTruncated; }
        } catch { /* best effort: the deliverable still lists commit/files/verification without a diff */ }
      }
      deliverables.push({
        taskId: dep.id, title: dep.title, assignee: dep.assignee, origin: "direct_implementation_validated",
        commit: ev.completion.commit, files: ev.completion.files, verification: ev.completion.verification,
        diffText, diffTruncated, note: `Implementada diretamente, fora de qualquer encaminhamento. ${ev.completion.note}`,
      });
      if (!hint) hint = { taskId: dep.id, kind: "commit", commit: ev.completion.commit, label: `commit ${ev.completion.commit.slice(0, 8)} (implementação direta)` };
    }
    queue.push(...dep.depends_on);
  }
  return { analyses, deliverables, hint };
}

/**
 * The exact version QA will test, from the nearest code delivery, in an authorized project of the demand's
 * repository that has that commit. Null (with the reason) when it cannot be reproduced exactly.
 */
async function resolveTestedVersion(hint: VersionHint | null, repo: { owner: string; repo: string } | undefined, deps: PrepareDeps): Promise<{ version: TestedVersion | null; projectDir: string | null; files: string[]; reason: string | null }> {
  const none = (reason: string) => ({ version: null, projectDir: null, files: [], reason });
  if (!hint) return none("nenhuma dependência desta tarefa entregou código");
  if (!deps.projects) return none("o cadastro de projetos locais não está disponível neste executor");
  const git = deps.projects.git;
  const candidates = (await listProjects(deps.projects)).filter(p => !p.problem && (!repo || (p.owner?.toLowerCase() === repo.owner.toLowerCase() && p.repo?.toLowerCase() === repo.repo.toLowerCase())));
  const withCommit = async (commit: string) => {
    for (const p of candidates) { const r = await runGit(git, p.dir, ["cat-file", "-t", commit]); if (r.code === 0 && r.stdout.trim() === "commit") return p; }
    return null;
  };
  const treeFiles = async (dir: string, commit: string) => (await listTreeEntries(dir, commit, git)).filter(e => e.type === "blob").map(e => e.path);
  if (hint.kind === "application") {
    const app = await deps.store.getApplication(hint.applicationId);
    const p = app ? candidates.find(x => x.id === app.projectId) : null;
    if (!app || !p) return none("a aplicação registrada ou o projeto dela não está mais disponível");
    const files = [...new Set([...(await treeFiles(p.dir, app.head)), ...app.files.filter(f => f.afterSha256).map(f => f.path)])].filter(f => !app.files.some(a => a.path === f && !a.afterSha256));
    return { version: { kind: "commit_plus_files", projectId: p.id, dirName: p.dirName, commit: app.head, applicationId: app.id, files: app.files.map(f => ({ path: f.path, sha256: f.afterSha256 })), treeHash: null, label: `HEAD ${app.head.slice(0, 8)} + arquivos aplicados pela interface` }, projectDir: p.dir, files, reason: null };
  }
  if (hint.kind === "patch") {
    const problems = scanPatch(hint.diffText).problems;
    if (hint.truncated || problems.length) return none(`o diff entregue não reproduz a versão exatamente (${hint.truncated ? "cortado por tamanho" : problems.join("; ")})`);
    const p = await withCommit(hint.baseCommit);
    if (!p) return none(`nenhum projeto local autorizado tem o commit base ${hint.baseCommit.slice(0, 12)}`);
    const added = [...hint.diffText.matchAll(/^diff --git a\/.+ b\/(.+)$/gm)].map(m => m[1]);
    return { version: { kind: "commit_plus_patch", projectId: p.id, dirName: p.dirName, commit: hint.baseCommit, patchSha256: sha256Hex(hint.diffText), runId: hint.runId, treeHash: null, label: `commit ${hint.baseCommit.slice(0, 8)} + diff da execução ${hint.runId.slice(0, 8)} (não aplicado)` }, projectDir: p.dir, files: [...new Set([...(await treeFiles(p.dir, hint.baseCommit)), ...added])], reason: null };
  }
  const p = await withCommit(hint.commit);
  if (!p) return none(`nenhum projeto local autorizado tem o commit ${hint.commit.slice(0, 12)}`);
  return { version: { kind: "commit", projectId: p.id, dirName: p.dirName, commit: hint.commit, treeHash: null, label: hint.label }, projectDir: p.dir, files: await treeFiles(p.dir, hint.commit), reason: null };
}

export const KNOWN_LIMITATIONS = [
  "Testes, lint, checagem de tipos e build nunca foram executados DENTRO da cópia isolada do Desenvolvedor nesta versão (sem terminal); os resultados mostrados aqui, quando existem, foram rodados fora dela, no checkout principal, pelo próprio executor.",
  "Leitura de arquivo por symlink dentro do isolamento do Desenvolvedor não foi verificada nesta versão (o teste de isolamento não pôde criar um link simbólico neste computador).",
];

/** Validates the QA hand-off against the executor's records and freezes what will be sent. Nothing runs. */
export async function prepareQAHandoff(req: QAHandoffRequest, deps: PrepareDeps): Promise<{ run: RunRecord; created: boolean }> {
  const { store } = deps;
  const parent = await store.get(req.directorRunId);
  if (!parent || parent.kind !== "director_plan") refuse(404, "plan_not_found", "Execução do Diretor não encontrada.");
  if (parent!.status !== "plan_ready" || !parent!.result) refuse(409, "plan_not_ready", "Só é possível encaminhar tarefas de um plano pronto do Diretor.");
  const plan = parent!.result!;
  const task = plan.tasks.find(t => t.id === req.taskId);
  if (!task) refuse(404, "task_not_found", `A tarefa "${req.taskId}" não existe neste plano do Diretor.`);
  if (task!.assignee !== QA_ASSIGNEE) refuse(409, "not_qa_task", `A tarefa ${task!.id} foi atribuída a "${task!.assignee}", não ao QA.`);
  if (req.agent.id !== task!.assignee) refuse(400, "agent_mismatch", "A ficha enviada não é a do responsável pela tarefa.");
  if (req.agent.connection === "none") refuse(400, "no_connection", "Escolha a conexão do QA na ficha dele (aba Perfil).");

  // Already sent? One open hand-off per task; a finished review is never redone.
  const existing = await store.runsForTask(parent!.id, task!.id);
  const open = existing.find(r => ["awaiting_approval", "queued", "planning"].includes(r.status));
  if (open) return { run: open, created: false };
  if (!req.repeat && existing.some(r => r.status === "review_ready")) refuse(409, "already_done", `A tarefa ${task!.id} já tem uma revisão concluída do QA. Para uma nova revisão, peça explicitamente “Enviar ao QA novamente” (o parecer anterior continua no histórico).`);

  const { analyses, deliverables, hint } = await collectDeliveryChain(task!, plan.tasks, store, parent!.id, deps.local);

  const pSnap = (await store.snapshot(parent!.id)) as DirectorSnapshot;
  const demand = pSnap.demand;
  const team = pSnap.team;
  const agent = req.agent;
  const pSnap0 = (await store.snapshot(parent!.id)) as DirectorSnapshot;
  const resolved = await resolveTestedVersion(hint, pSnap0.demand.repo, deps);
  const exec = resolved.version && deps.projects ? await loadExecPlan(resolved.version.projectId, deps.projects) : null;
  const tooling = deps.envDeps ? await detectQATooling(deps.envDeps, exec, !!resolved.version) : null;
  if (!tooling) refuse(503, "qa_tools_unavailable", "Este executor não tem o ambiente de QA configurado.");
  if (resolved.reason) tooling!.operations = tooling!.operations.map(o => ({ ...o, available: false, how: resolved.reason! }));
  const tools = toolQATools(tooling!);
  const planExcerpt: QASnapshot["plan"] = {
    objective_summary: plan.objective_summary,
    step: plan.steps.find(s => s.id === task!.step_id) ?? null,
    dependents: plan.tasks.filter(t => t.depends_on.includes(task!.id)).map(t => ({ id: t.id, title: t.title, assignee: t.assignee })),
  };

  const system = buildToolQASystem(agent, exec?.config.browserData ?? "app");
  const build = (deliv: QADeliverable[]) => buildToolQAMessage({ demand, task: task!, plan: planExcerpt, team, analyses, deliverables: deliv, version: resolved.version, tooling: tooling!, files: resolved.files });
  const schemaText = JSON.stringify(QA_OPS_SCHEMA) + JSON.stringify(QA_TOOL_EVAL_SCHEMA);
  const budgetTokens = Math.max(0, Math.floor(agent.budget));
  // Token budget is shown, never silently exceeded: trim diffs (largest first) before the sheet's own limit,
  // keeping commit/files/verification/note intact — the smallest useful summary is never dropped, only diffs.
  let liveDeliverables = deliverables;
  let user = build(liveDeliverables);
  let estimate = estimateTokens(system + user + schemaText);
  const omitted: string[] = [];
  const trimmed = new Set<number>(); // each diff is reduced at most once (reducing it again changes nothing)
  for (let i = 0; i < 4 && budgetTokens > 0 && estimate > budgetTokens * 0.7; i++) {
    const idx = liveDeliverables.reduce((best, d, j) => (d.diffText && !trimmed.has(j) && (best < 0 || (liveDeliverables[best].diffText?.length ?? 0) < d.diffText.length) ? j : best), -1);
    if (idx < 0) break;
    trimmed.add(idx);
    const cut = liveDeliverables[idx];
    omitted.push(`Diff de ${cut.taskId} (${cut.diffText?.length ?? 0} caracteres) reduzido para caber no orçamento; commit, arquivos e verificação continuam presentes; o diff completo continua no registro da execução ${cut.taskId}.`);
    liveDeliverables = liveDeliverables.map((d, j) => (j === idx ? { ...d, diffText: d.diffText ? `${d.diffText.slice(0, 2000)}\n[… reduzido para caber no orçamento; diff completo no registro de ${d.taskId}]` : null, diffTruncated: true } : d));
    user = build(liveDeliverables);
    estimate = estimateTokens(system + user + schemaText);
  }

  const snapshot: QASnapshot = {
    kind: "qa_task", agent, team, demand, task: task!, plan: planExcerpt, analyses, deliverables: liveDeliverables, tools, contextBudget: { estimatedInputTokens: estimate, omitted },
    toolsMode: "executor_operations", testedVersion: resolved.version ?? undefined, tooling: tooling!, maxModelCalls: 3, projectConfigAt: exec?.config.updatedAt ?? null,
  };
  const prompt = { system, user };
  const budget: RunBudget = { sheetTokens: budgetTokens, estimatedInputTokens: estimate, calls: [], reportedTotalTokens: null, exceeded: false };
  const nr: NewRun = {
    id: randomUUID(), kind: "qa_task", demandId: demand.id, agentId: agent.id, idempotencyKey: req.idempotencyKey,
    connection: agent.connection as NewRun["connection"], model: agent.modelName.trim(), effort: agent.effort.trim(),
    snapshotHash: sha256(JSON.stringify([snapshot, prompt, agent.connection, agent.modelName.trim(), agent.effort.trim()])),
    snapshot, budget, previousRunId: existing[0]?.id ?? null, parentRunId: parent!.id, taskId: task!.id,
    initialStatus: "awaiting_approval", prompt, context: null,
  };
  const res = await store.create(nr);
  if (res.created) {
    await store.event(res.run.id, "prepared", `Tarefa ${task!.id} do plano ${parent!.id.slice(0, 8)} preparada para o QA: ${liveDeliverables.length} entrega(s) real(is) e ${analyses.length} análise(s) do Arquiteto no contexto, cerca de ${estimate} tokens de texto (estimativa). Versão a testar: ${resolved.version ? resolved.version.label : `nenhuma (${resolved.reason})`}. Nenhuma chamada foi feita ainda e nenhum ambiente foi montado; isso só começa se você confirmar.`, { deliverables: liveDeliverables.map(d => d.taskId), analyses: analyses.map(a => a.taskId), testedVersion: resolved.version, tooling: tooling!.operations });
    if (omitted.length) await store.event(res.run.id, "context_trim", `${omitted.length} diff(s) reduzido(s) para caber no orçamento da ficha do QA; nada foi omitido do commit, dos arquivos ou dos resultados de verificação — só o texto do diff em si.`, { omitted });
    if (budgetTokens > 0 && estimate >= budgetTokens) await store.event(res.run.id, "budget_alert", `Alerta: a estimativa do texto (${estimate}) já passa do orçamento da ficha do QA (${budgetTokens}). O orçamento é referência; o cliente não é interrompido no meio da resposta, e a execução só começa se você confirmar.`);
  }
  return res;
}

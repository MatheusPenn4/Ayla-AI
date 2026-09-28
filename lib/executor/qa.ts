// Hand-off of ONE QA task, in the same two steps as the Architect's and the Developer's:
// 1. prepare: validates against the executor's own records (every dependency, transitively, must have real
//    evidence — see lib/engine/dependency.ts), gathers the real deliverables (commits, diffs, verification
//    results already computed elsewhere) and freezes the exact prompt as "awaiting_approval". QA gets NO
//    live tools at all (read_only mode, like the Architect): nothing is materialized, no working copy, no
//    model is called here.
// 2. approve: the user confirms that exact prompt (by its hash); only then the run is queued.
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { buildQAMessage, buildQASystem } from "@/lib/engine/qa-prompt";
import { QA_JSON_SCHEMA } from "@/lib/engine/qa-schema";
import { dependencyEvidence, findDependencyIssues } from "@/lib/engine/dependency";
import { isHandoffTarget } from "@/lib/engine/handoff-state";
import { QA_ASSIGNEE, type DependencyAnalysis, type DirectorSnapshot, type PlanTask, type QADeliverable, type QASnapshot, type QATool, type RunBudget, type RunRecord } from "@/lib/engine/types";
import { dependencyAnalysis, HandoffRefused, type PrepareDeps } from "./handoff";
import { listLocalRepos, readCommitDiff } from "./local-git";
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
});
export type QAHandoffRequest = z.infer<typeof QAHandoffZ>;

/** What the executor lets this QA run do — no live tools at all, like the Architect. Enforced by client flags, not by this text. */
export function qaTools(): QATool[] {
  return [
    { label: "Ler arquivos do repositório", allowed: false, how: "Bloqueada: QA não recebe acesso ao repositório. Tudo o que precisa (commits, diffs reais, resultados de verificação) já vem pronto em <entregas_reais>." },
    { label: "Editar arquivos", allowed: false, how: "Bloqueada: sem ferramentas nesta execução (--tools \"\" / sandbox somente leitura), pasta de trabalho vazia." },
    { label: "Terminal / comandos", allowed: false, how: "Bloqueado pelo executor. Os resultados de verificação mostrados foram executados fora desta chamada, pelo próprio executor, e são colados como texto." },
    { label: "Navegador e busca na web", allowed: false, how: "Bloqueados pelo executor." },
    { label: "Publicar, fazer push ou abrir pull request", allowed: false, how: "Impossível: o cliente não recebe o repositório nem credencial do GitHub." },
  ];
}

type Chain = { analyses: (DependencyAnalysis & { taskId: string; title: string })[]; deliverables: QADeliverable[] };

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
        note: "Execução do Desenvolvedor concluída (implementation_ready): diff real calculado pelo executor.",
      });
    } else if (ev.kind === "resolved_clarification_validated") {
      const diff = ev.run.developer?.diff;
      deliverables.push({
        taskId: dep.id, title: dep.title, assignee: dep.assignee, origin: "resolved_clarification_validated",
        commit: ev.completion.commit, files: ev.completion.files, verification: ev.completion.verification,
        diffText: diff?.diffText ?? null, diffTruncated: diff?.diffTruncated ?? false,
        note: `Pediu esclarecimento ao modelo; entrega resolvida e validada localmente. ${ev.completion.note}`,
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
    }
    queue.push(...dep.depends_on);
  }
  return { analyses, deliverables };
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
  if (existing.some(r => r.status === "review_ready")) refuse(409, "already_done", `A tarefa ${task!.id} já tem uma revisão concluída do QA.`);

  const { analyses, deliverables } = await collectDeliveryChain(task!, plan.tasks, store, parent!.id, deps.local);

  const pSnap = (await store.snapshot(parent!.id)) as DirectorSnapshot;
  const demand = pSnap.demand;
  const team = pSnap.team;
  const agent = req.agent;
  const tools = qaTools();
  const planExcerpt: QASnapshot["plan"] = {
    objective_summary: plan.objective_summary,
    step: plan.steps.find(s => s.id === task!.step_id) ?? null,
    dependents: plan.tasks.filter(t => t.depends_on.includes(task!.id)).map(t => ({ id: t.id, title: t.title, assignee: t.assignee })),
  };

  const system = buildQASystem(agent);
  const build = (deliv: QADeliverable[]) => buildQAMessage({ demand, task: task!, plan: planExcerpt, team, analyses, deliverables: deliv, tools, knownLimitations: KNOWN_LIMITATIONS });
  const schemaText = JSON.stringify(QA_JSON_SCHEMA);
  const budgetTokens = Math.max(0, Math.floor(agent.budget));
  // Token budget is shown, never silently exceeded: trim diffs (largest first) before the sheet's own limit,
  // keeping commit/files/verification/note intact — the smallest useful summary is never dropped, only diffs.
  let liveDeliverables = deliverables;
  let user = build(liveDeliverables);
  let estimate = estimateTokens(system + user + schemaText);
  const omitted: string[] = [];
  for (let i = 0; i < 4 && budgetTokens > 0 && estimate > budgetTokens * 0.7; i++) {
    const idx = liveDeliverables.reduce((best, d, j) => (d.diffText && (best < 0 || (liveDeliverables[best].diffText?.length ?? 0) < d.diffText.length) ? j : best), -1);
    if (idx < 0) break;
    const cut = liveDeliverables[idx];
    omitted.push(`Diff de ${cut.taskId} (${cut.diffText?.length ?? 0} caracteres) reduzido para caber no orçamento; commit, arquivos e verificação continuam presentes; o diff completo continua no registro da execução ${cut.taskId}.`);
    liveDeliverables = liveDeliverables.map((d, j) => (j === idx ? { ...d, diffText: d.diffText ? `${d.diffText.slice(0, 2000)}\n[… reduzido para caber no orçamento; diff completo no registro de ${d.taskId}]` : null, diffTruncated: true } : d));
    user = build(liveDeliverables);
    estimate = estimateTokens(system + user + schemaText);
  }

  const snapshot: QASnapshot = { kind: "qa_task", agent, team, demand, task: task!, plan: planExcerpt, analyses, deliverables: liveDeliverables, tools, contextBudget: { estimatedInputTokens: estimate, omitted } };
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
    await store.event(res.run.id, "prepared", `Tarefa ${task!.id} do plano ${parent!.id.slice(0, 8)} preparada para o QA: ${liveDeliverables.length} entrega(s) real(is) e ${analyses.length} análise(s) do Arquiteto no contexto, cerca de ${estimate} tokens de texto (estimativa). Nenhuma chamada foi feita ainda; ela só começa se você confirmar.`, { deliverables: liveDeliverables.map(d => d.taskId), analyses: analyses.map(a => a.taskId) });
    if (omitted.length) await store.event(res.run.id, "context_trim", `${omitted.length} diff(s) reduzido(s) para caber no orçamento da ficha do QA; nada foi omitido do commit, dos arquivos ou dos resultados de verificação — só o texto do diff em si.`, { omitted });
    if (budgetTokens > 0 && estimate >= budgetTokens) await store.event(res.run.id, "budget_alert", `Alerta: a estimativa do texto (${estimate}) já passa do orçamento da ficha do QA (${budgetTokens}). O orçamento é referência; o cliente não é interrompido no meio da resposta, e a execução só começa se você confirmar.`);
  }
  return res;
}

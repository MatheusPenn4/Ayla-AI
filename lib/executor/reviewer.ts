// Hand-off of ONE Reviewer task, in the same two steps as the Architect's, the Developer's and QA's:
// 1. prepare: validates against the executor's own records — the task must depend on a QA task that already
//    reached review_ready — and freezes the exact prompt as "awaiting_approval". The Reviewer gets NO live
//    tools at all (read_only mode, like QA): nothing is materialized, no model is called here. It never
//    re-derives evidence: it reuses QA's OWN frozen snapshot (the exact deliverables and analyses QA itself
//    was given) plus QA's own concluded parecer — never a second, parallel evidence-gathering pass.
// 2. approve: the user confirms that exact prompt (by its hash); only then the run is queued.
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { buildReviewerMessage, buildReviewerSystem } from "@/lib/engine/reviewer-prompt";
import { REVIEWER_JSON_SCHEMA } from "@/lib/engine/reviewer-schema";
import { findDependencyIssues } from "@/lib/engine/dependency";
import { QA_ASSIGNEE, REVIEWER_ASSIGNEE, type DirectorSnapshot, type QASnapshot, type ReviewerSnapshot, type ReviewerTool, type RunBudget, type RunRecord } from "@/lib/engine/types";
import { HandoffRefused, type PrepareDeps } from "./handoff";
import { estimateTokens } from "./planner";
import { MemberZ } from "./runs-service";
import type { NewRun } from "./store";

const refuse = (status: number, code: string, message: string, details?: string[]): never => { throw new HandoffRefused(status, code, message, details); };
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

export const ReviewerHandoffZ = z.object({
  idempotencyKey: z.string().regex(/^[A-Za-z0-9:_-]{8,120}$/),
  directorRunId: z.string().uuid(),
  taskId: z.string().min(1).max(64),
  /** The Reviewer's saved sheet (configuration only; it cannot change who runs or what task). */
  agent: MemberZ,
  /** Explicit new final review after a NEWER QA parecer (the earlier Reviewer parecer stays in the history, untouched). */
  repeat: z.boolean().optional(),
});
export type ReviewerHandoffRequest = z.infer<typeof ReviewerHandoffZ>;

/** What the executor lets this Reviewer run do — no live tools at all, like QA. Enforced by client flags, not by this text. */
export function reviewerTools(): ReviewerTool[] {
  return [
    { label: "Ler arquivos do repositório", allowed: false, how: "Bloqueada: o Revisor não recebe acesso ao repositório. Tudo o que precisa (parecer do QA, commits, diffs reais, verificações) já vem pronto em <parecer_do_qa> e <entregas_reais>." },
    { label: "Editar arquivos", allowed: false, how: "Bloqueada: sem ferramentas nesta execução (--tools \"\" / sandbox somente leitura), pasta de trabalho vazia." },
    { label: "Terminal / comandos", allowed: false, how: "Bloqueado pelo executor. Os resultados de verificação mostrados foram executados fora desta chamada, pelo próprio executor, e são colados como texto." },
    { label: "Navegador e busca na web", allowed: false, how: "Bloqueados pelo executor." },
    { label: "Publicar, fazer push ou abrir pull request", allowed: false, how: "Impossível: o cliente não recebe o repositório nem credencial do GitHub." },
  ];
}

/** Validates the Reviewer hand-off against the executor's records and freezes what will be sent. Nothing runs. */
export async function prepareReviewerHandoff(req: ReviewerHandoffRequest, deps: PrepareDeps): Promise<{ run: RunRecord; created: boolean }> {
  const { store } = deps;
  const parent = await store.get(req.directorRunId);
  if (!parent || parent.kind !== "director_plan") refuse(404, "plan_not_found", "Execução do Diretor não encontrada.");
  if (parent!.status !== "plan_ready" || !parent!.result) refuse(409, "plan_not_ready", "Só é possível encaminhar tarefas de um plano pronto do Diretor.");
  const plan = parent!.result!;
  const task = plan.tasks.find(t => t.id === req.taskId);
  if (!task) refuse(404, "task_not_found", `A tarefa "${req.taskId}" não existe neste plano do Diretor.`);
  if (task!.assignee !== REVIEWER_ASSIGNEE) refuse(409, "not_reviewer_task", `A tarefa ${task!.id} foi atribuída a "${task!.assignee}", não ao Revisor.`);
  if (req.agent.id !== task!.assignee) refuse(400, "agent_mismatch", "A ficha enviada não é a do responsável pela tarefa.");
  if (req.agent.connection === "none") refuse(400, "no_connection", "Escolha a conexão do Revisor na ficha dele (aba Perfil).");

  // Already sent? One open hand-off per task; a finished review is never redone.
  const existing = await store.runsForTask(parent!.id, task!.id);
  const open = existing.find(r => ["awaiting_approval", "queued", "planning"].includes(r.status));
  if (open) return { run: open, created: false };
  const concluded = existing.filter(r => r.status === "concluded");
  if (concluded.length && !req.repeat) refuse(409, "already_done", `A tarefa ${task!.id} já tem um parecer final concluído do Revisor. Para uma nova revisão final com um parecer do QA mais recente, peça explicitamente “Nova revisão do Revisor” (o parecer anterior continua no histórico).`);

  // Structural integrity first, same rule as any other dependency (lib/engine/dependency.ts).
  const { missing, cycles } = findDependencyIssues(plan.tasks);
  if (missing.some(m => m.task === task!.id)) refuse(409, "dependency_missing", `A tarefa ${task!.id} depende de "${missing[0].dep}", que não existe neste plano.`);
  if (cycles.some(cy => cy.includes(task!.id))) refuse(409, "dependency_cycle", `Dependência circular detectada: ${cycles[0].join(" → ")}.`);

  // The Reviewer's one real dependency: a QA task, already concluded. Never a direct call, never a task run
  // via API without this check — the executor checks it again here regardless of what the UI already showed.
  const qaDepId_ = task!.depends_on.find(id => plan.tasks.find(t => t.id === id)?.assignee === QA_ASSIGNEE);
  if (!qaDepId_) refuse(409, "no_qa_dependency", `A tarefa ${task!.id} não depende de nenhuma tarefa do QA. O Revisor precisa de um parecer do QA já concluído para formar o parecer final.`);
  const qaDepId = qaDepId_!;
  const qaRuns = await store.runsForTask(parent!.id, qaDepId);
  const qaRun_ = qaRuns[0];
  if (!qaRun_ || qaRun_.status !== "review_ready" || !qaRun_.qa) refuse(409, "dependency_pending", `A tarefa ${task!.id} depende de ${qaDepId} (QA), que ainda não tem revisão concluída.`, [qaDepId]);
  const qaRun = qaRun_!;
  // A repeat only makes sense against a QA parecer the last final review did not see (never a paid call on the same input).
  if (concluded.length && req.repeat) {
    const lastQA = ((await store.detail(concluded[0].id))?.snapshot as ReviewerSnapshot | undefined)?.qa?.runId;
    if (lastQA === qaRun.id) refuse(409, "nothing_new", `O último parecer final de ${task!.id} já usou a revisão do QA mais recente (${qaRun.id.slice(0, 8)}). Uma nova revisão final só é preparada com um parecer do QA mais novo.`);
  }
  const qaDetail = await store.detail(qaRun.id);
  const qaSnap_ = qaDetail?.snapshot as QASnapshot | undefined;
  if (!qaSnap_ || qaSnap_.kind !== "qa_task") refuse(500, "qa_snapshot_missing", "O registro congelado da revisão de QA não foi encontrado.");
  const qaSnap = qaSnap_!;

  const pSnap = (await store.snapshot(parent!.id)) as DirectorSnapshot;
  const demand = pSnap.demand;
  const team = pSnap.team;
  const agent = req.agent;
  const tools = reviewerTools();
  const planExcerpt: ReviewerSnapshot["plan"] = {
    objective_summary: plan.objective_summary,
    step: plan.steps.find(s => s.id === task!.step_id) ?? null,
    dependents: plan.tasks.filter(t => t.depends_on.includes(task!.id)).map(t => ({ id: t.id, title: t.title, assignee: t.assignee })),
  };

  const system = buildReviewerSystem(agent);
  const build = (deliv: typeof qaSnap.deliverables) => buildReviewerMessage({ demand, task: task!, plan: planExcerpt, team, qa: qaRun.qa!, qaTaskId: qaDepId, analyses: qaSnap.analyses, deliverables: deliv, tools });
  const schemaText = JSON.stringify(REVIEWER_JSON_SCHEMA);
  const budgetTokens = Math.max(0, Math.floor(agent.budget));
  // Same transparency rule as QA: trim the largest diff first (never commit/files/verification), logged and shown.
  let liveDeliverables = qaSnap.deliverables;
  let user = build(liveDeliverables);
  let estimate = estimateTokens(system + user + schemaText);
  const omitted: string[] = [...qaSnap.contextBudget.omitted];
  const trimmed = new Set<number>(); // each diff is reduced at most once (reducing it again changes nothing)
  for (let i = 0; i < 4 && budgetTokens > 0 && estimate > budgetTokens * 0.7; i++) {
    const idx = liveDeliverables.reduce((best, d, j) => (d.diffText && !trimmed.has(j) && (best < 0 || (liveDeliverables[best].diffText?.length ?? 0) < d.diffText.length) ? j : best), -1);
    if (idx >= 0) trimmed.add(idx);
    if (idx < 0) break;
    const cut = liveDeliverables[idx];
    omitted.push(`Diff de ${cut.taskId} (${cut.diffText?.length ?? 0} caracteres) reduzido para caber no orçamento; commit, arquivos e verificação continuam presentes; o diff completo continua no registro da execução ${cut.taskId}.`);
    liveDeliverables = liveDeliverables.map((d, j) => (j === idx ? { ...d, diffText: d.diffText ? `${d.diffText.slice(0, 2000)}\n[… reduzido para caber no orçamento; diff completo no registro de ${d.taskId}]` : null, diffTruncated: true } : d));
    user = build(liveDeliverables);
    estimate = estimateTokens(system + user + schemaText);
  }

  const snapshot: ReviewerSnapshot = {
    kind: "reviewer_task", agent, team, demand, task: task!, plan: planExcerpt,
    qa: { taskId: qaDepId, runId: qaRun.id, result: qaRun.qa! },
    analyses: qaSnap.analyses, deliverables: liveDeliverables, tools,
    contextBudget: { estimatedInputTokens: estimate, omitted },
  };
  const prompt = { system, user };
  const budget: RunBudget = { sheetTokens: budgetTokens, estimatedInputTokens: estimate, calls: [], reportedTotalTokens: null, exceeded: false };
  const nr: NewRun = {
    id: randomUUID(), kind: "reviewer_task", demandId: demand.id, agentId: agent.id, idempotencyKey: req.idempotencyKey,
    connection: agent.connection as NewRun["connection"], model: agent.modelName.trim(), effort: agent.effort.trim(),
    snapshotHash: sha256(JSON.stringify([snapshot, prompt, agent.connection, agent.modelName.trim(), agent.effort.trim()])),
    snapshot, budget, previousRunId: existing[0]?.id ?? null, parentRunId: parent!.id, taskId: task!.id,
    initialStatus: "awaiting_approval", prompt, context: null,
  };
  const res = await store.create(nr);
  if (res.created) {
    await store.event(res.run.id, "prepared", `Tarefa ${task!.id} do plano ${parent!.id.slice(0, 8)} preparada para o Revisor: parecer do QA (${qaDepId}, execução ${qaRun.id.slice(0, 8)}) e ${liveDeliverables.length} entrega(s) real(is) reaproveitada(s) do próprio contexto do QA, cerca de ${estimate} tokens de texto (estimativa). ${concluded.length ? ` Nova revisão final: o parecer anterior (${concluded[0].id.slice(0, 8)}) continua no histórico, sem alteração.` : ""} Nenhuma chamada foi feita ainda; ela só começa se você confirmar.`, { qaRunId: qaRun.id, deliverables: liveDeliverables.map(d => d.taskId), previousReviewerRunId: concluded[0]?.id ?? null });
    if (omitted.length > qaSnap.contextBudget.omitted.length) await store.event(res.run.id, "context_trim", `${omitted.length - qaSnap.contextBudget.omitted.length} diff(s) adicional(is) reduzido(s) para caber no orçamento da ficha do Revisor; nada foi omitido do commit, dos arquivos ou dos resultados de verificação — só o texto do diff em si.`, { omitted });
    if (budgetTokens > 0 && estimate >= budgetTokens) await store.event(res.run.id, "budget_alert", `Alerta: a estimativa do texto (${estimate}) já passa do orçamento da ficha do Revisor (${budgetTokens}). O orçamento é referência; o cliente não é interrompido no meio da resposta, e a execução só começa se você confirmar.`);
  }
  return res;
}

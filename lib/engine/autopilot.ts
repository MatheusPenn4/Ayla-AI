// Decisions of the autopilot (phase 1), pure and shared by the executor's supervisor and the interface, so
// the timeline the user approves and what the supervisor does come from the same rules. No I/O here.
//
// The supervisor never invents a path of its own: the next task is the first task of the policy, in plan
// order, that was never sent (D4) and whose whole dependency chain is satisfied by evidence — exactly the rule
// that enables the "Enviar" buttons (dependency.ts). Everything that is not decided here (preparing, the hash,
// the brakes on the prepared content, approving) is done by the executor with its usual gates.
import { dependencyBlocker, dependencyEvidence, evidenceSatisfied } from "./dependency";
import { TASK_STATE_LABEL, taskState } from "./handoff-state";
import { AUTOPILOT_STAGES, type AutopilotPolicy, type AutopilotStage, type AutopilotStopCode, type AutopilotSuggestion, type PlanTask, type RunRecord, type TaskCompletion } from "./types";

export const isAutopilotStage = (assignee: string): assignee is AutopilotStage => (AUTOPILOT_STAGES as string[]).includes(assignee);

export const STAGE_LABEL: Record<AutopilotStage, string> = { architect: "Arquiteto", qa: "QA", reviewer: "Revisor" };

/** Statuses that mean the task's own call finished well for each stage. */
const DONE: Record<AutopilotStage, RunRecord["status"]> = { architect: "analysis_ready", qa: "review_ready", reviewer: "concluded" };

export type TimelineRow = { taskId: string; title: string; assignee: string; dependsOn: string[]; mode: "auto" | "manual" | "excluded"; reason: string | null };

/**
 * Why the supervisor may not send this task even though it is an Architect/QA/Reviewer task — mirrors the
 * executor's own prepare rules, so a policy never contains a task the executor would refuse:
 * the Architect hand-off (lib/executor/handoff.ts) only accepts DIRECT dependencies that are Architect analyses.
 */
export function autopilotIneligibility(task: PlanTask, tasks: PlanTask[]): string | null {
  if (!isAutopilotStage(task.assignee)) return task.assignee === "developer" ? "Desenvolvedor: sempre enviado por você nesta fase." : "Responsável fora do piloto automático.";
  if (task.assignee === "architect") {
    const other = task.depends_on.map(id => tasks.find(t => t.id === id)).filter((t): t is PlanTask => !!t && t.assignee !== "architect");
    if (other.length) return `Depende de ${other.map(t => `${t.id} (${roleName(t.assignee)})`).join(", ")}: o envio ao Arquiteto ainda só aceita dependências que sejam análises do Arquiteto, então esta tarefa fica com você.`;
  }
  return null;
}

/** How each task of the plan would be handled: automatic (in the policy), by the user (Developer…), or left out by the user. */
export function autopilotTimeline(tasks: PlanTask[], included: string[] | null): TimelineRow[] {
  return tasks.map(t => {
    const why = autopilotIneligibility(t, tasks);
    return {
      taskId: t.id, title: t.title, assignee: t.assignee, dependsOn: t.depends_on,
      mode: why ? "manual" : !included || included.includes(t.id) ? "auto" : "excluded",
      reason: why,
    };
  });
}

export type NextStep =
  | { kind: "send"; task: PlanTask }
  /** A hand-off of the plan is queued or running: wait for it to settle. */
  | { kind: "busy"; runId: string; taskId: string }
  /** Nothing the supervisor may send right now; the reason names the tasks that wait for the user. */
  | { kind: "waiting_user"; message: string; taskIds: string[] }
  | { kind: "concluded"; message: string };

/**
 * The next thing to do for a policy. `runsOf` returns a task's hand-offs, newest first; `ownRuns` are the runs
 * the supervisor approved itself (a prepared hand-off waiting for the user is never one of them).
 */
export function nextAutopilotStep(policy: Pick<AutopilotPolicy, "tasks">, tasks: PlanTask[], runsOf: (taskId: string) => RunRecord[], completionsOf: (taskId: string) => TaskCompletion[]): NextStep {
  const included = new Set(policy.tasks.map(t => t.id));
  // One hand-off at a time, whoever started it: a running one (even the user's own) is always waited for.
  for (const t of tasks) {
    const open = runsOf(t.id).find(r => r.status === "queued" || r.status === "planning");
    if (open) return { kind: "busy", runId: open.id, taskId: t.id };
  }
  const pendingUser = tasks.filter(t => runsOf(t.id)[0]?.status === "awaiting_approval");
  if (pendingUser.length) {
    return { kind: "waiting_user", taskIds: pendingUser.map(t => t.id), message: `Há envio preparado aguardando a sua revisão: ${pendingUser.map(t => t.id).join(", ")}. O piloto automático não confirma esse envio por você; ele continua depois que você confirmar ou descartar.` };
  }
  for (const t of tasks) {
    if (!included.has(t.id) || autopilotIneligibility(t, tasks)) continue;
    if (taskState(t, runsOf(t.id)).key !== "proposed") continue; // D4: never sent again by the supervisor
    if (dependencyBlocker(t, tasks, runsOf, completionsOf) === null) return { kind: "send", task: t };
  }
  const remaining = policy.tasks.filter(p => {
    const t = tasks.find(x => x.id === p.id);
    return t && runsOf(t.id)[0]?.status !== DONE[p.assignee];
  });
  if (!remaining.length) return { kind: "concluded", message: "Todas as tarefas do piloto automático foram concluídas." };
  // What blocks the rest: a task of the user's (Developer…), or a task of the policy that settled badly earlier.
  const waitingOn = new Set<string>();
  const reasons: string[] = [];
  for (const p of remaining) {
    const t = tasks.find(x => x.id === p.id)!;
    const st = taskState(t, runsOf(t.id));
    if (st.key !== "proposed") { waitingOn.add(t.id); reasons.push(`${t.id} (${STAGE_LABEL[p.assignee]}) está em “${TASK_STATE_LABEL[st.key]}” e não é reenviada pelo piloto automático`); continue; }
    const blocker = dependencyBlocker(t, tasks, runsOf, completionsOf);
    const manual = blockingManualTasks(t, tasks, included, runsOf, completionsOf);
    manual.forEach(id => waitingOn.add(id));
    if (blocker) reasons.push(`${t.id}: ${blocker}`);
  }
  const manual = [...waitingOn].filter(id => !included.has(id));
  const head = manual.length ? `Aguardando você em ${manual.map(id => `${id} (${roleName(tasks.find(t => t.id === id)?.assignee ?? "")})`).join(", ")}.` : "Aguardando você.";
  return { kind: "waiting_user", taskIds: [...waitingOn], message: `${head} ${reasons.slice(0, 3).join("; ")}${reasons.length > 3 ? "; …" : ""}`.trim() };
}

const roleName = (assignee: string) => (isAutopilotStage(assignee) ? STAGE_LABEL[assignee] : assignee === "developer" ? "Desenvolvedor" : assignee);

/** Unsatisfied dependencies of the task, transitively, that the supervisor will never send itself (Developer, excluded tasks…). */
function blockingManualTasks(task: PlanTask, tasks: PlanTask[], included: Set<string>, runsOf: (taskId: string) => RunRecord[], completionsOf: (taskId: string) => TaskCompletion[]): string[] {
  const byId = new Map(tasks.map(t => [t.id, t]));
  const out = new Set<string>(), seen = new Set<string>();
  const walk = (id: string) => {
    for (const d of byId.get(id)?.depends_on ?? []) {
      if (seen.has(d)) continue;
      seen.add(d);
      const dep = byId.get(d);
      if (!dep) continue;
      const auto = included.has(dep.id) && isAutopilotStage(dep.assignee);
      if (!auto && !evidenceSatisfied(dependencyEvidence(dep, runsOf, completionsOf))) out.add(dep.id);
      walk(d);
    }
  };
  walk(task.id);
  return [...out];
}

/** How a run the supervisor approved settled, as a brake (null = fine, keep going). */
export function settledBrake(run: RunRecord, stage: AutopilotStage): { code: AutopilotStopCode; message: string } | null {
  if (run.status === "queued" || run.status === "planning" || run.status === "awaiting_approval") return null;
  if (run.status === "failed") return { code: "failed", message: `A execução ${run.id.slice(0, 8)} (${run.taskId}) falhou${run.error?.message ? `: ${run.error.message}` : "."} O piloto automático não tenta de novo sozinho.` };
  if (run.status === "canceled") return { code: "canceled_by_user", message: `A execução ${run.id.slice(0, 8)} (${run.taskId}) foi cancelada.` };
  if (run.status === "awaiting_clarification") return { code: "clarification", message: `${STAGE_LABEL[stage]} pediu esclarecimento em ${run.taskId} (${run.id.slice(0, 8)}). Responda pela execução; o piloto automático não responde por você.` };
  if (run.status === DONE[stage] && run.budget?.reportedTotalTokens == null) return { code: "usage_unknown", message: `A execução ${run.id.slice(0, 8)} (${run.taskId}) terminou sem uso informado pelo cliente; o orçamento da demanda deixaria de ser garantido.` };
  return null;
}

/**
 * Real/estimated ratio observed in earlier runs of the same kind and connection (median), used to project the
 * cost of the next hand-off from its text estimate. Default 4 (the pilots measured 3× to 5×), clamped to [1, 20].
 */
export function costRatio(history: Pick<RunRecord, "budget">[]): { ratio: number; samples: number } {
  const ratios = history
    .map(r => (r.budget?.reportedTotalTokens && r.budget.estimatedInputTokens ? r.budget.reportedTotalTokens / r.budget.estimatedInputTokens : null))
    .filter((x): x is number => x != null && Number.isFinite(x) && x > 0)
    .sort((a, b) => a - b);
  if (!ratios.length) return { ratio: 4, samples: 0 };
  const mid = Math.floor(ratios.length / 2);
  const median = ratios.length % 2 ? ratios[mid] : (ratios[mid - 1] + ratios[mid]) / 2;
  return { ratio: Math.min(20, Math.max(1, Math.round(median * 10) / 10)), samples: ratios.length };
}

export const projectTokens = (estimatedInputTokens: number | null, ratio: number) => Math.ceil((estimatedInputTokens ?? 0) * ratio);

const KIND_OF: Record<AutopilotStage, "architect_task" | "qa_task" | "reviewer_task"> = { architect: "architect_task", qa: "qa_task", reviewer: "reviewer_task" };

/**
 * Budget suggestion for a new policy: per included task, the median usage the clients reported in earlier runs
 * of that kind (or 4× the sheet's budget when there is no history yet), plus a 25% margin, rounded up to 10k.
 * It is a suggestion shown with its basis; the user types the budget that is frozen.
 */
export function suggestAutopilotBudget(tasks: { assignee: AutopilotStage }[], history: Partial<Record<"architect_task" | "qa_task" | "reviewer_task", { median: number | null; samples: number }>> | null, sheetBudget: (stage: AutopilotStage) => number): AutopilotSuggestion {
  let total = 0;
  const basis: string[] = [];
  for (const stage of AUTOPILOT_STAGES) {
    const n = tasks.filter(t => t.assignee === stage).length;
    if (!n) continue;
    const h = history?.[KIND_OF[stage]];
    const per = h?.median ?? Math.max(1, sheetBudget(stage)) * 4;
    total += per * n;
    basis.push(h?.median ? `${STAGE_LABEL[stage]}: ${n} × ${per.toLocaleString("pt-BR")} (mediana de ${h.samples} execução(ões) anteriores)` : `${STAGE_LABEL[stage]}: ${n} × ${per.toLocaleString("pt-BR")} (4× o orçamento da ficha; ainda sem histórico)`);
  }
  basis.push("+25% de margem, arredondado para cima.");
  return { budgetTokens: Math.max(10_000, Math.ceil((total * 1.25) / 10_000) * 10_000), maxRuns: tasks.length, basis };
}

/** Token usage the clients reported for these runs (unknown counts as 0 here; settledBrake stops on it). */
export const usedTokens = (runs: Pick<RunRecord, "budget">[]) => runs.reduce((s, r) => s + (r.budget?.reportedTotalTokens ?? 0), 0);

// State of a Director task from the user's point of view, derived only from
// the executor's records of that task's hand-offs.
import { HANDOFF_TARGETS, type PlanTask, type RunRecord } from "./types";

export type TaskStateKey = "proposed" | "not_executable" | "awaiting_approval" | "queued" | "working" | "analysis_ready" | "awaiting_clarification" | "failed" | "canceled";

export const TASK_STATE_LABEL: Record<TaskStateKey, string> = {
  proposed: "Proposta pelo Diretor",
  not_executable: "Proposta pelo Diretor · responsável ainda não executa",
  awaiting_approval: "Aguardando sua aprovação",
  queued: "Na fila do executor",
  working: "Arquiteto trabalhando",
  analysis_ready: "Análise concluída",
  awaiting_clarification: "Arquiteto aguardando esclarecimento",
  failed: "Falha",
  canceled: "Cancelada",
};

export const isHandoffTarget = (assignee: string) => (HANDOFF_TARGETS as readonly string[]).includes(assignee);

/** @param taskRuns hand-offs of this task, newest first. */
export function taskState(task: PlanTask, taskRuns: RunRecord[]): { key: TaskStateKey; run: RunRecord | null } {
  if (!isHandoffTarget(task.assignee)) return { key: "not_executable", run: null };
  const latest = taskRuns[0] ?? null;
  if (!latest) return { key: "proposed", run: null };
  const map: Record<RunRecord["status"], TaskStateKey> = {
    awaiting_approval: "awaiting_approval", queued: "queued", planning: "working", analysis_ready: "analysis_ready",
    awaiting_clarification: "awaiting_clarification", failed: "failed", canceled: "canceled", plan_ready: "analysis_ready",
  };
  return { key: map[latest.status], run: latest };
}

/**
 * Why a task cannot be sent yet (null = it can). The executor checks the same
 * rules again; this only avoids offering a button that would be refused.
 */
export function handoffBlocker(task: PlanTask, tasks: PlanTask[], runsOf: (taskId: string) => RunRecord[]): string | null {
  if (!isHandoffTarget(task.assignee)) return "Nesta fase só o Arquiteto recebe encaminhamentos.";
  for (const depId of task.depends_on) {
    const dep = tasks.find(t => t.id === depId);
    if (!dep) continue;
    if (!isHandoffTarget(dep.assignee)) return `Depende de ${dep.id} (${dep.assignee}), que ainda não executa nesta fase.`;
    if (!runsOf(dep.id).some(r => r.status === "analysis_ready")) return `Depende de ${dep.id}: envie e conclua essa análise antes.`;
  }
  return null;
}

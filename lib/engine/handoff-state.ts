// State of a Director task from the user's point of view, derived only from
// the executor's records of that task's hand-offs.
import { HANDOFF_TARGETS, type PlanTask, type RunRecord } from "./types";

export type TaskStateKey = "proposed" | "not_executable" | "awaiting_approval" | "queued" | "working" | "analysis_ready" | "implementation_ready" | "awaiting_clarification" | "failed" | "canceled";

export const TASK_STATE_LABEL: Record<TaskStateKey, string> = {
  proposed: "Proposta pelo Diretor",
  not_executable: "Proposta pelo Diretor · responsável ainda não executa",
  awaiting_approval: "Aguardando sua aprovação",
  queued: "Na fila do executor",
  working: "Em execução",
  analysis_ready: "Análise concluída",
  implementation_ready: "Implementação pronta (não aplicada)",
  awaiting_clarification: "Aguardando esclarecimento",
  failed: "Falha",
  canceled: "Cancelada",
};

export const isHandoffTarget = (assignee: string) => (HANDOFF_TARGETS as readonly string[]).includes(assignee);
/** Architect (read-only) or Developer (write, own flow) — the two assignees with a real hand-off in this phase. */
export const isExecutableAssignee = (assignee: string) => isHandoffTarget(assignee) || assignee === "developer";

/** @param taskRuns hand-offs of this task, newest first. */
export function taskState(task: PlanTask, taskRuns: RunRecord[]): { key: TaskStateKey; run: RunRecord | null } {
  if (!isExecutableAssignee(task.assignee)) return { key: "not_executable", run: null };
  const latest = taskRuns[0] ?? null;
  if (!latest) return { key: "proposed", run: null };
  // A failed or discarded follow-up does not hide pending questions: the task still waits for answers.
  const waiting = taskRuns.find(r => r.status === "awaiting_clarification");
  if (waiting && (latest.status === "failed" || latest.status === "canceled")) return { key: "awaiting_clarification", run: waiting };
  const map: Record<RunRecord["status"], TaskStateKey> = {
    awaiting_approval: "awaiting_approval", queued: "queued", planning: "working", analysis_ready: "analysis_ready",
    implementation_ready: "implementation_ready",
    awaiting_clarification: "awaiting_clarification", failed: "failed", canceled: "canceled", plan_ready: "analysis_ready",
  };
  return { key: map[latest.status], run: latest };
}

/**
 * Why the preview of a Developer task is not available yet (null = it is): every task it depends on,
 * directly or not, must be an Architect task with a concluded analysis. The executor checks it again.
 */
export function developerBlocker(task: PlanTask, tasks: PlanTask[], runsOf: (taskId: string) => RunRecord[]): string | null {
  if (task.assignee !== "developer") return "A prévia é só para tarefas do Desenvolvedor.";
  const seen = new Set<string>();
  const queue = [...task.depends_on];
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id) || id === task.id) continue;
    seen.add(id);
    const dep = tasks.find(t => t.id === id);
    if (!dep) continue;
    if (!isHandoffTarget(dep.assignee)) return `Depende de ${dep.id} (${dep.assignee}), que ainda não executa nesta fase.`;
    if (!runsOf(dep.id).some(r => r.status === "analysis_ready")) return `Depende de ${dep.id}: essa análise do Arquiteto ainda não foi concluída.`;
    queue.push(...dep.depends_on);
  }
  return null;
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

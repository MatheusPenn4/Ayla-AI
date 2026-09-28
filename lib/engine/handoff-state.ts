// State of a Director task from the user's point of view, derived only from
// the executor's records of that task's hand-offs.
import { HANDOFF_TARGETS, type PlanTask, type RunRecord } from "./types";

export type TaskStateKey = "proposed" | "not_executable" | "awaiting_approval" | "queued" | "working" | "analysis_ready" | "implementation_ready" | "review_ready" | "concluded" | "awaiting_clarification" | "failed" | "canceled";

export const TASK_STATE_LABEL: Record<TaskStateKey, string> = {
  proposed: "Proposta pelo Diretor",
  not_executable: "Proposta pelo Diretor · responsável ainda não executa",
  awaiting_approval: "Aguardando sua aprovação",
  queued: "Na fila do executor",
  working: "Em execução",
  analysis_ready: "Análise concluída",
  implementation_ready: "Implementação pronta (não aplicada)",
  review_ready: "Revisão de QA concluída",
  concluded: "Revisão final concluída",
  awaiting_clarification: "Aguardando esclarecimento",
  failed: "Falha",
  canceled: "Cancelada",
};

export const isHandoffTarget = (assignee: string) => (HANDOFF_TARGETS as readonly string[]).includes(assignee);
/** Architect (read-only), Developer (write, own flow), QA (read-only review) or Reviewer (read-only final parecer) — the assignees with a real hand-off in this phase. */
export const isExecutableAssignee = (assignee: string) => isHandoffTarget(assignee) || assignee === "developer" || assignee === "qa" || assignee === "reviewer";

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
    implementation_ready: "implementation_ready", review_ready: "review_ready", concluded: "concluded",
    awaiting_clarification: "awaiting_clarification", failed: "failed", canceled: "canceled", plan_ready: "analysis_ready",
  };
  return { key: map[latest.status], run: latest };
}

// developerBlocker/handoffBlocker (Architect-only / Developer-only dependency checks) were replaced by a
// single coherent rule for any assignee depending on any other: see dependencyBlocker in lib/engine/dependency.ts.

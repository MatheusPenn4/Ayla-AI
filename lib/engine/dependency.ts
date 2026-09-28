// Whether a task's dependency is really satisfied, for ANY assignee depending on ANY other assignee
// (Architect → Architect, Developer → Developer, Developer → QA, etc.) — one coherent rule, replacing the
// Architect-only and ad-hoc Developer-only checks that used to live separately in handoff-state.ts,
// developer-preview.ts and handoff.ts.
//
// A dependency counts as satisfied only by evidence:
// - the dependency's own agent call finished for real (analysis_ready / implementation_ready / review_ready);
// - OR a clarification it asked was resolved outside the model AND that resolution was itself validated
//   (a TaskCompletion of kind "resolved_clarification" exists, referencing the run's own LocalResolution);
// - OR the task was implemented directly by the orchestrator, outside any hand-off, with its own validated
//   TaskCompletion (kind "direct_implementation").
// A LocalResolution alone (the model asked a question, later answered) never satisfies anything by itself —
// only a matching, validated TaskCompletion does. This module never writes anything; it only reads.
import { isExecutableAssignee } from "./handoff-state";
import type { PlanTask, RunRecord, TaskCompletion } from "./types";

export type DependencyEvidence =
  | { kind: "run_completed"; run: RunRecord }
  | { kind: "resolved_clarification_validated"; run: RunRecord; completion: TaskCompletion }
  | { kind: "direct_implementation_validated"; completion: TaskCompletion }
  | { kind: "unmet"; reason: "not_executable" | "proposed" | "in_progress" | "clarification_unvalidated" | "failed" | "canceled" };

/** Statuses that mean "this collaborator's own call finished successfully" — one per phase added so far. */
const COMPLETED_STATUSES: RunRecord["status"][] = ["analysis_ready", "implementation_ready", "review_ready"];

export const evidenceSatisfied = (ev: DependencyEvidence): boolean => ev.kind !== "unmet";

/** Real, verifiable reason a dependency is (or isn't) satisfied — never inferred from `localResolution` alone. */
export function dependencyEvidence(dep: PlanTask, runsOf: (taskId: string) => RunRecord[], completionsOf: (taskId: string) => TaskCompletion[]): DependencyEvidence {
  const completions = completionsOf(dep.id);
  // A direct implementation needs no run at all (e.g. code the orchestrator wrote outside any hand-off).
  const direct = completions.find(c => c.kind === "direct_implementation");
  if (direct) return { kind: "direct_implementation_validated", completion: direct };
  if (!isExecutableAssignee(dep.assignee)) return { kind: "unmet", reason: "not_executable" };
  const runs = runsOf(dep.id);
  const latest = runs[0] ?? null;
  if (!latest) return { kind: "unmet", reason: "proposed" };
  if (COMPLETED_STATUSES.includes(latest.status)) return { kind: "run_completed", run: latest };
  if (latest.status === "awaiting_clarification") {
    const match = latest.localResolution && completions.find(c => c.kind === "resolved_clarification" && c.sourceRunId === latest.id && c.commit === latest.localResolution!.commit);
    if (match) return { kind: "resolved_clarification_validated", run: latest, completion: match };
    return { kind: "unmet", reason: "clarification_unvalidated" };
  }
  if (latest.status === "failed") return { kind: "unmet", reason: "failed" };
  if (latest.status === "canceled") return { kind: "unmet", reason: "canceled" };
  return { kind: "unmet", reason: "in_progress" }; // awaiting_approval, queued, planning
}

function unmetMessage(dep: PlanTask, reason: Extract<DependencyEvidence, { kind: "unmet" }>["reason"]): string {
  switch (reason) {
    case "not_executable": return `Depende de ${dep.id} (${dep.assignee}), que ainda não executa nesta fase.`;
    case "proposed": return `Depende de ${dep.id}: ainda não foi enviado a ninguém.`;
    case "in_progress": return `Depende de ${dep.id}: ainda em execução ou aguardando sua aprovação.`;
    case "clarification_unvalidated": return `Depende de ${dep.id}: pediu esclarecimento, e a pergunta pode até ter sido respondida, mas não há entrega local validada (commit, arquivos e verificações) registrada para ela ainda.`;
    case "failed": return `Depende de ${dep.id}: a última execução falhou.`;
    case "canceled": return `Depende de ${dep.id}: a última execução foi cancelada.`;
  }
}

/** A short label for the UI/exported Markdown — distinguishes a real agent completion from a locally validated one. */
export function evidenceLabel(ev: DependencyEvidence): string {
  switch (ev.kind) {
    case "run_completed": return "Execução do agente concluída";
    case "resolved_clarification_validated": return `Esclarecimento resolvido e entrega validada localmente (commit ${ev.completion.commit.slice(0, 8)})`;
    case "direct_implementation_validated": return `Implementada diretamente, fora do encaminhamento (commit ${ev.completion.commit.slice(0, 8)})`;
    case "unmet": return "Não satisfeita";
  }
}

/** A task's own id depended on by itself, directly or through others — every cycle that includes `startId`. */
export function findDependencyIssues(tasks: PlanTask[]): { missing: { task: string; dep: string }[]; cycles: string[][] } {
  const byId = new Map(tasks.map(t => [t.id, t]));
  const missing: { task: string; dep: string }[] = [];
  for (const t of tasks) for (const d of t.depends_on) if (!byId.has(d)) missing.push({ task: t.id, dep: d });
  const cycles: string[][] = [];
  const color = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const dfs = (id: string) => {
    color.set(id, 1);
    stack.push(id);
    for (const d of byId.get(id)?.depends_on ?? []) {
      if (!byId.has(d)) continue; // reported above
      const c = color.get(d) ?? 0;
      if (c === 1) cycles.push(stack.slice(stack.indexOf(d)).concat(d));
      else if (c === 0) dfs(d);
    }
    stack.pop();
    color.set(id, 2);
  };
  for (const t of tasks) if (!color.has(t.id)) dfs(t.id);
  return { missing, cycles };
}

/**
 * Why a task cannot be sent yet (null = it can), walking the WHOLE dependency chain (not only direct
 * dependencies) so a task two levels deep in an unsatisfied chain is reported accurately. Detects a missing
 * or circular dependency before checking evidence. The executor checks the same rule again at prepare time
 * (lib/executor/handoff.ts, developer.ts, qa.ts) — this only avoids offering a button that would be refused.
 */
export function dependencyBlocker(task: PlanTask, tasks: PlanTask[], runsOf: (taskId: string) => RunRecord[], completionsOf: (taskId: string) => TaskCompletion[]): string | null {
  const byId = new Map(tasks.map(t => [t.id, t]));

  // Structural integrity FIRST, over the whole plan, before any evidence check: a missing or circular
  // dependency reachable from this task must never be masked by a mundane "not sent yet" surfacing from a
  // node deeper in the very cycle being checked (evidence on a cyclic/dangling node is meaningless anyway).
  const reachable = new Set<string>();
  const queue = [...task.depends_on];
  while (queue.length) {
    const id = queue.shift()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    const t = byId.get(id);
    if (t) queue.push(...t.depends_on);
  }
  const { missing, cycles } = findDependencyIssues(tasks);
  const missingHit = missing.find(m => m.task === task.id || reachable.has(m.task));
  if (missingHit) return `Depende de "${missingHit.dep}", que não existe neste plano.`;
  const cycleHit = cycles.find(cy => cy.includes(task.id) || cy.some(id => reachable.has(id)));
  if (cycleHit) return `Dependência circular detectada: ${cycleHit.join(" → ")}.`;

  // The graph reachable from `task` is now known acyclic and fully resolvable — walk it for evidence.
  const seen = new Set<string>();
  const walk = (id: string): string | null => {
    const t = byId.get(id);
    if (!t) return null;
    for (const depId of t.depends_on) {
      const dep = byId.get(depId)!;
      const ev = dependencyEvidence(dep, runsOf, completionsOf);
      if (ev.kind === "unmet") return unmetMessage(dep, ev.reason);
      if (!seen.has(depId)) {
        seen.add(depId);
        const r = walk(depId);
        if (r) return r;
      }
    }
    return null;
  };
  return walk(task.id);
}

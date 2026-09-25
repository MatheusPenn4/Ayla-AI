// Output contract for the Director's planning call.
// - PLAN_JSON_SCHEMA is sent to the provider as a structured-output format
//   (only features supported by structured outputs: no min/max constraints).
// - validatePlan() is the server-side check that decides whether the answer is
//   usable. Nothing is filled in or invented when the answer is incomplete.
import { z } from "zod";
import type { DirectorPlan } from "./types";

const str = { type: "string" } as const;
const strArr = { type: "array", items: str } as const;

export const PLAN_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["outcome", "objective_summary", "context_understanding", "flow", "questions", "steps", "tasks", "risks", "assumptions", "not_verified"],
  properties: {
    outcome: { type: "string", enum: ["plan_ready", "needs_clarification"], description: "plan_ready quando é seguro planejar; needs_clarification quando alguma dúvida impede uma decisão segura." },
    objective_summary: { ...str, description: "O objetivo da demanda em uma ou duas frases." },
    context_understanding: { ...str, description: "O que se sabe do contexto (demanda, fonte, arquivos lidos) e o que não se sabe." },
    flow: {
      type: "object",
      additionalProperties: false,
      required: ["type", "rationale", "skipped_roles"],
      properties: {
        type: { type: "string", enum: ["short", "standard", "full"], description: "short = fluxo curto (ex.: Desenvolvedor → QA); standard = com Arquiteto ou Revisor; full = todos." },
        rationale: str,
        skipped_roles: { ...strArr, description: "IDs de colaboradores dispensados e por quê não participam." },
      },
    },
    questions: {
      type: "array",
      description: "Perguntas objetivas ao solicitante. Vazio quando nada impede a decisão.",
      items: { type: "object", additionalProperties: false, required: ["question", "why_it_blocks"], properties: { question: str, why_it_blocks: str } },
    },
    steps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "title", "owner", "depends_on", "done_when"],
        properties: { id: str, title: str, owner: { ...str, description: "ID de um colaborador existente." }, depends_on: { ...strArr, description: "IDs de etapas anteriores." }, done_when: { ...str, description: "Critério verificável de conclusão da etapa." } },
      },
    },
    tasks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "step_id", "assignee", "title", "scope", "inputs", "deliverable", "acceptance_criteria", "depends_on"],
        properties: {
          id: str, step_id: str,
          assignee: { ...str, description: "ID de um colaborador existente e permitido nos encaminhamentos do Diretor." },
          title: str, scope: str, inputs: str, deliverable: str,
          acceptance_criteria: { ...strArr, description: "Critérios verificáveis desta tarefa." },
          depends_on: { ...strArr, description: "IDs de outras tarefas." },
        },
      },
    },
    risks: strArr,
    assumptions: strArr,
    not_verified: { ...strArr, description: "O que ainda não foi verificado (nada foi executado nesta fase)." },
  },
} as const;

const nonEmpty = z.string().transform(s => s.trim()).pipe(z.string().min(1));
const PlanZ = z.object({
  outcome: z.enum(["plan_ready", "needs_clarification"]),
  objective_summary: nonEmpty,
  context_understanding: z.string(),
  flow: z.object({ type: z.enum(["short", "standard", "full"]), rationale: z.string(), skipped_roles: z.array(z.string()) }).strict(),
  questions: z.array(z.object({ question: nonEmpty, why_it_blocks: z.string() }).strict()).max(10),
  steps: z.array(z.object({ id: nonEmpty, title: nonEmpty, owner: nonEmpty, depends_on: z.array(z.string()), done_when: nonEmpty }).strict()).max(20),
  tasks: z.array(z.object({
    id: nonEmpty, step_id: z.string(), assignee: nonEmpty, title: nonEmpty, scope: nonEmpty, inputs: z.string(), deliverable: nonEmpty,
    acceptance_criteria: z.array(nonEmpty).min(1), depends_on: z.array(z.string()),
  }).strict()).max(30),
  risks: z.array(z.string()).max(20),
  assumptions: z.array(z.string()).max(20),
  not_verified: z.array(z.string()).max(20),
}).strict();

export type PlanValidation = { ok: true; plan: DirectorPlan } | { ok: false; errors: string[] };

function hasCycle(nodes: { id: string; depends_on: string[] }[]) {
  const deps = new Map(nodes.map(n => [n.id, n.depends_on]));
  const state = new Map<string, 1 | 2>();
  const visit = (id: string): boolean => {
    if (state.get(id) === 1) return true;
    if (state.get(id) === 2) return false;
    state.set(id, 1);
    for (const d of deps.get(id) ?? []) if (deps.has(d) && visit(d)) return true;
    state.set(id, 2);
    return false;
  };
  return nodes.some(n => visit(n.id));
}

/**
 * @param allowedAssignees collaborators the Director may delegate to (existing + in its hand-offs), plus the Director itself.
 */
export function validatePlan(raw: unknown, allowedAssignees: string[]): PlanValidation {
  const parsed = PlanZ.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.slice(0, 12).map(i => `${i.path.join(".") || "(raiz)"}: ${i.message}`) };
  }
  const plan = parsed.data as DirectorPlan;
  const errors: string[] = [];
  const allowed = new Set(allowedAssignees);
  const stepIds = plan.steps.map(s => s.id), taskIds = plan.tasks.map(t => t.id);
  const dup = (ids: string[]) => ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dup(stepIds).length) errors.push(`IDs de etapa repetidos: ${[...new Set(dup(stepIds))].join(", ")}`);
  if (dup(taskIds).length) errors.push(`IDs de tarefa repetidos: ${[...new Set(dup(taskIds))].join(", ")}`);
  for (const s of plan.steps) {
    if (!allowed.has(s.owner)) errors.push(`Etapa ${s.id}: responsável "${s.owner}" não existe ou não é um encaminhamento permitido.`);
    for (const d of s.depends_on) if (!stepIds.includes(d)) errors.push(`Etapa ${s.id}: depende de etapa inexistente "${d}".`);
  }
  for (const t of plan.tasks) {
    if (!allowed.has(t.assignee)) errors.push(`Tarefa ${t.id}: responsável "${t.assignee}" não existe ou não é um encaminhamento permitido.`);
    if (t.step_id && !stepIds.includes(t.step_id)) errors.push(`Tarefa ${t.id}: etapa inexistente "${t.step_id}".`);
    for (const d of t.depends_on) if (!taskIds.includes(d)) errors.push(`Tarefa ${t.id}: depende de tarefa inexistente "${d}".`);
  }
  if (hasCycle(plan.steps)) errors.push("As dependências entre etapas formam um ciclo.");
  if (hasCycle(plan.tasks)) errors.push("As dependências entre tarefas formam um ciclo.");
  if (plan.outcome === "needs_clarification" && !plan.questions.length) errors.push("outcome = needs_clarification exige pelo menos uma pergunta ao solicitante.");
  if (plan.outcome === "plan_ready") {
    if (!plan.steps.length) errors.push("Um plano pronto precisa de pelo menos uma etapa.");
    if (!plan.tasks.length) errors.push("Um plano pronto precisa de pelo menos uma tarefa proposta.");
  }
  return errors.length ? { ok: false, errors } : { ok: true, plan };
}

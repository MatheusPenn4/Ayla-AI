// Output contracts of the tool-equipped QA (toolsMode "executor_operations"). The model never gets a tool of
// its own: it ASKS for controlled operations (QA_OPS_SCHEMA), the executor runs them in the isolated
// environment of the exact tested version and returns the results as numbered evidence (E1, E2…), and the
// model then classifies the criteria (QA_TOOL_EVAL_SCHEMA), citing that evidence by id.
// Rules checked here, never left to the prompt alone:
// - approved / rejected must cite at least one evidence id that exists (produced by the executor) — a
//   narrative report from another collaborator is never evidence;
// - a criterion with a pending part (evaluatedPart/pendingPart) can only be not_verified, never approved;
// - a pending part owned by a later step (future_step) must name a real downstream task of the plan (e.g. the
//   Reviewer's) — so QA never waits for it (no circular dependency) and never "approves" it;
// - recommendation: blocked iff something was rejected; needs_more_work only when evidence was genuinely
//   insufficient — a pending item caused only by an unavailable tool or a later step goes to the final review
//   with reservations (ready_for_review), never back to the Developer.
import { z } from "zod";
import type { QAPendingReason, QAResult } from "./types";

const str = { type: "string" } as const;
const strArr = { type: "array", items: str } as const;
const int = { type: "integer" } as const;
const obj = (props: Record<string, unknown>) => ({ type: "object", additionalProperties: false, required: Object.keys(props), properties: props });

export const OPERATION_TYPES = ["read_file", "search", "run_check", "run_tests", "browser"] as const;
export const CHECK_IDS = ["typecheck", "lint", "test", "build"] as const;
export const STEP_ACTIONS = ["open", "click", "wait_for_text", "expect_text", "read_text", "reload", "clipboard_permission", "disable_clipboard_api", "read_clipboard", "download", "compare", "screenshot", "wait"] as const;

const STEP = obj({
  action: { type: "string", enum: [...STEP_ACTIONS] },
  target: { ...str, description: "click/download/wait_for_text/expect_text: texto visível do botão, link ou mensagem. Vazio nos outros." },
  url_path: { ...str, description: "open: caminho da aplicação em teste, começando com /. Vazio nos outros." },
  save_as: { ...str, description: "read_clipboard/download/screenshot: nome curto para guardar o resultado (ex.: copia1). Vazio nos outros." },
  first: { ...str, description: "compare: nome salvo do primeiro texto. Vazio nos outros." },
  second: { ...str, description: "compare: nome salvo do segundo texto. Vazio nos outros." },
  ignore_line_regex: { ...str, description: "compare: expressão regular de UMA linha permitida a diferir (ex.: o horário de geração). Vazio se nada pode diferir." },
  setting: { ...str, description: "clipboard_permission: grant ou deny. Vazio nos outros." },
  timeout_ms: { ...int, description: "Espera máxima deste passo (0 = padrão de 8 s; máximo 30 s)." },
});

const OPERATION = obj({
  id: { ...str, description: "Identificador curto que você escolhe (ex.: op1)." },
  type: { type: "string", enum: [...OPERATION_TYPES] },
  criteria: { type: "array", items: int, description: "Números (1, 2…) dos critérios de aceite da demanda que esta operação ajuda a verificar." },
  purpose: { ...str, description: "Para que serve esta operação, em uma frase." },
  path: { ...str, description: "read_file: caminho exato de um arquivo da lista de arquivos da versão testada. Vazio nos outros." },
  start_line: { ...int, description: "read_file: primeira linha (1 = início; 0 = arquivo inteiro)." },
  end_line: { ...int, description: "read_file: última linha (0 = até o fim)." },
  query: { ...str, description: "search: texto literal a procurar (2 a 100 caracteres). Vazio nos outros." },
  check: { type: "string", enum: ["", ...CHECK_IDS], description: "run_check: qual verificação do projeto rodar de novo. Vazio nos outros." },
  test_files: { ...strArr, description: "run_tests: arquivos de teste existentes na versão testada. Vazio nos outros." },
  scenario_name: { ...str, description: "browser: nome curto do cenário. Vazio nos outros." },
  steps: { type: "array", items: STEP, description: "browser: passos do cenário, em ordem. Vazio nos outros." },
});

export const QA_OPS_SCHEMA = obj({
  plan_summary: { ...str, description: "Como você vai verificar os critérios com as operações abaixo." },
  operations: { type: "array", items: OPERATION, description: "Operações para o executor rodar agora (no máximo 12)." },
});

const CRITERION = obj({
  criterion: { ...str, description: "Texto exato do critério de aceite, copiado da demanda." },
  verdict: { type: "string", enum: ["approved", "rejected", "not_verified"] },
  evidence_ids: { ...strArr, description: "Ids das evidências do executor (E1, E2…) em que este veredito se apoia. Obrigatório em approved e rejected." },
  evidence: { ...str, description: "Aprovado: o que as evidências citadas mostram. Vazio nos outros casos." },
  steps: { ...str, description: "Reprovado: o que foi feito. Vazio nos outros casos." },
  expected: { ...str, description: "Reprovado: o que se esperava. Vazio nos outros casos." },
  observed: { ...str, description: "Reprovado: o que as evidências mostram de fato. Vazio nos outros casos." },
  impact: { ...str, description: "Reprovado: impacto do problema. Vazio nos outros casos." },
  notVerifiedReason: { ...str, description: "Não verificado: por que não deu para concluir. Vazio nos outros casos." },
  pending_reason: { type: "string", enum: ["", "tool_unavailable", "insufficient_evidence", "future_step"], description: "Não verificado: tool_unavailable (faltou ferramenta), insufficient_evidence (as evidências não bastam), future_step (parte do critério cabe a uma etapa posterior do plano). Vazio nos outros casos." },
  evaluated_part: { ...str, description: "Critério que envolve outro colaborador: a parte que você avaliou e o resultado. Vazio se o critério é todo seu." },
  pending_part: { ...str, description: "Critério que envolve outro colaborador: a parte que fica pendente. Vazio se nada fica pendente." },
  pending_task: { ...str, description: "future_step: id da tarefa posterior do plano dona da parte pendente (ex.: T4). Vazio nos outros casos." },
});

export const QA_TOOL_EVAL_SCHEMA = obj({
  outcome: { type: "string", enum: ["done", "needs_clarification"] },
  summary: { ...str, description: "Resumo do que foi verificado, com que evidências, e da conclusão." },
  criteria: { type: "array", items: CRITERION, description: "Um item por critério de aceite da DEMANDA, na mesma ordem." },
  questions: { type: "array", items: obj({ question: str, why_it_blocks: str }) },
  not_verified: { ...strArr, description: "O que não pôde ser verificado, fora dos critérios." },
  recommendation: { type: "string", enum: ["ready_for_review", "blocked", "needs_more_work"], description: "blocked = há reprovação; needs_more_work = as evidências foram insuficientes e é preciso trabalho antes de revisar; ready_for_review = pode seguir para a revisão final (com ressalvas, se houver pendência só por ferramenta indisponível ou etapa posterior)." },
  followup_operations: { type: "array", items: OPERATION, description: "Somente se ainda for permitido: operações extras de que você precisa antes de concluir (no máximo 8). Vazio para concluir agora." },
});

// ---- validation ----------------------------------------------------------------------------------------

export type OperationRequest = z.infer<typeof OperationZ>;
const StepZ = z.object({
  action: z.enum(STEP_ACTIONS), target: z.string().max(300), url_path: z.string().max(300), save_as: z.string().max(40), first: z.string().max(40), second: z.string().max(40),
  ignore_line_regex: z.string().max(200), setting: z.string().max(20), timeout_ms: z.number().int().min(0).max(60_000),
}).strict();
const OperationZ = z.object({
  id: z.string().max(40), type: z.enum(OPERATION_TYPES), criteria: z.array(z.number().int()).max(20), purpose: z.string().max(600),
  path: z.string().max(300), start_line: z.number().int().min(0), end_line: z.number().int().min(0), query: z.string().max(200),
  check: z.enum(["", ...CHECK_IDS]), test_files: z.array(z.string().max(300)).max(20), scenario_name: z.string().max(60), steps: z.array(StepZ).max(40),
}).strict();

function operationErrors(ops: OperationRequest[], max: number, where: string): string[] {
  const errors: string[] = [];
  if (ops.length > max) errors.push(`${where}: no máximo ${max} operações por rodada (recebidas ${ops.length}).`);
  ops.forEach((o, i) => {
    const at = `${where}[${i}] (${o.type})`;
    if (o.type === "read_file" && !o.path.trim()) errors.push(`${at}: informe path.`);
    if (o.type === "search" && (o.query.trim().length < 2 || o.query.length > 100)) errors.push(`${at}: query deve ter de 2 a 100 caracteres.`);
    if (o.type === "run_check" && !o.check) errors.push(`${at}: informe check (typecheck, lint, test ou build).`);
    if (o.type === "run_tests" && !o.test_files.length) errors.push(`${at}: informe test_files.`);
    if (o.type === "browser") {
      if (!o.steps.length) errors.push(`${at}: um cenário de navegador precisa de passos.`);
      if (o.steps.length > 30) errors.push(`${at}: no máximo 30 passos por cenário.`);
      o.steps.forEach((s, j) => {
        if (["click", "download", "wait_for_text", "expect_text"].includes(s.action) && !s.target.trim()) errors.push(`${at} passo ${j + 1} (${s.action}): informe target.`);
        if (s.action === "compare" && (!s.first || !s.second)) errors.push(`${at} passo ${j + 1} (compare): informe first e second.`);
        if (s.action === "compare" && s.ignore_line_regex) { try { new RegExp(s.ignore_line_regex); } catch { errors.push(`${at} passo ${j + 1}: ignore_line_regex inválida.`); } }
        if (s.action === "clipboard_permission" && !["grant", "deny", "granted", "denied"].includes(s.setting)) errors.push(`${at} passo ${j + 1}: setting deve ser grant ou deny.`);
      });
    }
  });
  return errors;
}

export function validateOperations(raw: unknown): { ok: true; summary: string; operations: OperationRequest[] } | { ok: false; errors: string[] } {
  const p = z.object({ plan_summary: z.string().max(4000), operations: z.array(OperationZ).max(40) }).strict().safeParse(raw);
  if (!p.success) return { ok: false, errors: p.error.issues.slice(0, 12).map(i => `${i.path.join(".") || "(raiz)"}: ${i.message}`) };
  const errors = operationErrors(p.data.operations, 12, "operations");
  return errors.length ? { ok: false, errors } : { ok: true, summary: p.data.plan_summary, operations: p.data.operations };
}

const nonEmpty = z.string().transform(s => s.trim()).pipe(z.string().min(1));
const EvalZ = z.object({
  outcome: z.enum(["done", "needs_clarification"]),
  summary: z.string(),
  criteria: z.array(z.object({
    criterion: nonEmpty, verdict: z.enum(["approved", "rejected", "not_verified"]), evidence_ids: z.array(z.string().max(20)).max(30),
    evidence: z.string(), steps: z.string(), expected: z.string(), observed: z.string(), impact: z.string(), notVerifiedReason: z.string(),
    pending_reason: z.enum(["", "tool_unavailable", "insufficient_evidence", "future_step"]), evaluated_part: z.string(), pending_part: z.string(), pending_task: z.string(),
  }).strict()).max(30),
  questions: z.array(z.object({ question: nonEmpty, why_it_blocks: z.string() }).strict()).max(10),
  not_verified: z.array(z.string()).max(30),
  recommendation: z.enum(["ready_for_review", "blocked", "needs_more_work"]),
  followup_operations: z.array(OperationZ).max(40),
}).strict();

export type ToolQAValidation = { ok: true; result: QAResult; followups: OperationRequest[] } | { ok: false; errors: string[] };

export function validateToolQAResult(raw: unknown, o: { expectedCriteria: string[]; evidenceIds: Set<string>; downstreamTasks: string[]; allowFollowups: boolean }): ToolQAValidation {
  const parsed = EvalZ.safeParse(raw);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.slice(0, 12).map(i => `${i.path.join(".") || "(raiz)"}: ${i.message}`) };
  const d = parsed.data;
  const errors: string[] = [];
  const seen = new Set<string>();
  const short = (c: string) => `"${c.slice(0, 70)}"`;
  for (const c of d.criteria) {
    if (seen.has(c.criterion)) errors.push(`Critério ${short(c.criterion)} classificado mais de uma vez.`);
    seen.add(c.criterion);
    if (!o.expectedCriteria.includes(c.criterion)) errors.push(`Critério ${short(c.criterion)} não corresponde a nenhum critério de aceite real da demanda. Copie o texto exato.`);
    const unknown = c.evidence_ids.filter(id => !o.evidenceIds.has(id));
    if (unknown.length) errors.push(`Critério ${short(c.criterion)} cita evidência inexistente: ${unknown.join(", ")}. Cite só ids de <evidencias_do_executor>.`);
    if ((c.verdict === "approved" || c.verdict === "rejected") && !c.evidence_ids.length) errors.push(`Critério ${short(c.criterion)} ${c.verdict === "approved" ? "aprovado" : "reprovado"} sem citar evidência do executor (evidence_ids). Relatos narrativos de outros colaboradores não são evidência.`);
    if (c.verdict === "approved" && !c.evidence.trim()) errors.push(`Critério ${short(c.criterion)} aprovado sem descrever o que as evidências mostram.`);
    if (c.verdict === "rejected" && !(c.steps.trim() && c.expected.trim() && c.observed.trim() && c.impact.trim())) errors.push(`Critério ${short(c.criterion)} reprovado sem steps/expected/observed/impact completos.`);
    if (c.verdict === "not_verified" && (!c.notVerifiedReason.trim() || !c.pending_reason)) errors.push(`Critério ${short(c.criterion)} não verificado sem motivo (notVerifiedReason e pending_reason).`);
    if (c.pending_part.trim() && c.verdict !== "not_verified") errors.push(`Critério ${short(c.criterion)} tem parte pendente e por isso não pode ser ${c.verdict}: use not_verified e registre evaluated_part/pending_part.`);
    if (c.pending_reason === "future_step") {
      if (!c.pending_part.trim() || !c.evaluated_part.trim()) errors.push(`Critério ${short(c.criterion)} com future_step exige evaluated_part (o que você verificou) e pending_part (o que cabe à etapa posterior).`);
      if (!o.downstreamTasks.includes(c.pending_task)) errors.push(`Critério ${short(c.criterion)}: pending_task "${c.pending_task}" não é uma tarefa posterior desta no plano (${o.downstreamTasks.join(", ") || "nenhuma"}).`);
    }
  }
  for (const ec of o.expectedCriteria) if (!seen.has(ec)) errors.push(`Critério de aceite da demanda não classificado: ${short(ec)}.`);
  if (d.outcome === "needs_clarification" && !d.questions.length) errors.push("outcome = needs_clarification exige pelo menos uma pergunta.");
  const rejected = d.criteria.some(c => c.verdict === "rejected");
  const pending = d.criteria.filter(c => c.verdict === "not_verified");
  const insufficient = pending.some(c => c.pending_reason === "insufficient_evidence");
  if (rejected && d.recommendation !== "blocked") errors.push("Há critério reprovado: recommendation deve ser blocked.");
  if (!rejected && d.recommendation === "blocked") errors.push("Nenhum critério foi reprovado: recommendation não pode ser blocked.");
  if (!rejected && d.recommendation === "needs_more_work" && !insufficient) errors.push("needs_more_work só quando alguma evidência foi insuficiente (insufficient_evidence). Pendência causada só por ferramenta indisponível ou por etapa posterior segue para a revisão final com ressalvas: use ready_for_review.");
  if (!rejected && insufficient && d.recommendation === "ready_for_review") errors.push("Há critério com evidência insuficiente: recommendation deve ser needs_more_work.");
  if (!o.allowFollowups && d.followup_operations.length) errors.push("Esta é a última rodada: followup_operations deve ficar vazio; conclua com as evidências que existem.");
  if (o.allowFollowups) errors.push(...operationErrors(d.followup_operations, 8, "followup_operations"));
  if (errors.length) return { ok: false, errors };
  const result: QAResult = {
    outcome: d.outcome, summary: d.summary,
    criteria: d.criteria.map(c => ({
      criterion: c.criterion, verdict: c.verdict, evidenceIds: c.evidence_ids,
      ...(c.verdict === "rejected" ? { rejected: { steps: c.steps, expected: c.expected, observed: c.observed, impact: c.impact } } : {}),
      ...(c.verdict === "not_verified" ? { notVerifiedReason: c.notVerifiedReason, pendingReason: c.pending_reason as QAPendingReason } : {}),
      ...(c.verdict === "approved" ? { evidence: c.evidence } : {}),
      ...(c.evaluated_part.trim() ? { evaluatedPart: c.evaluated_part } : {}),
      ...(c.pending_part.trim() ? { pendingPart: c.pending_part } : {}),
      ...(c.pending_task.trim() ? { pendingTask: c.pending_task } : {}),
    })),
    questions: d.questions, not_verified: d.not_verified, recommendation: d.recommendation,
  };
  return { ok: true, result, followups: d.followup_operations };
}

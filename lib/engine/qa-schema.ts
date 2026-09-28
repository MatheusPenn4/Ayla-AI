// Output contract of the QA review.
// - QA_JSON_SCHEMA goes to the official client as structured output (strict).
// - validateQAResult() is the executor's check: every acceptance criterion of the DEMAND must be classified
//   exactly once, a rejection must carry steps/expected/observed/impact, a not_verified must carry a reason,
//   an approval must cite real evidence — a bare "ok" is refused. A build passing is never accepted as a
//   substitute for a functional criterion, and the model has no terminal anyway to claim it ran one itself.
import { z } from "zod";
import type { QAResult } from "./types";

const str = { type: "string" } as const;
const strArr = { type: "array", items: str } as const;
const obj = (props: Record<string, unknown>) => ({ type: "object", additionalProperties: false, required: Object.keys(props), properties: props });

export const QA_JSON_SCHEMA = obj({
  outcome: { type: "string", enum: ["done", "needs_clarification"], description: "done quando cada critério de aceite da demanda foi classificado; needs_clarification quando falta informação para classificar algum com segurança." },
  summary: { ...str, description: "Resumo do que foi revisado e da conclusão geral." },
  criteria: {
    type: "array",
    description: "Um item por critério de aceite da DEMANDA original (não da tarefa de QA), na mesma ordem.",
    items: obj({
      criterion: { ...str, description: "Texto exato do critério de aceite, copiado da demanda." },
      verdict: { type: "string", enum: ["approved", "rejected", "not_verified"] },
      steps: { ...str, description: "Reprovado: o que foi feito para checar. Vazio nos outros casos." },
      expected: { ...str, description: "Reprovado: o que se esperava. Vazio nos outros casos." },
      observed: { ...str, description: "Reprovado: o que foi observado de fato. Vazio nos outros casos." },
      impact: { ...str, description: "Reprovado: impacto do problema. Vazio nos outros casos." },
      notVerifiedReason: { ...str, description: "Não verificado: por que não deu para checar. Vazio nos outros casos." },
      evidence: { ...str, description: "Aprovado: a evidência real (arquivo, trecho de diff, resultado de verificação) que sustenta a aprovação. Vazio nos outros casos." },
    }),
  },
  questions: { type: "array", items: obj({ question: str, why_it_blocks: str }) },
  not_verified: { ...strArr, description: "O que não pôde ser verificado nesta revisão, fora dos critérios (ex.: leitura por symlink, testes dentro da cópia isolada do Desenvolvedor)." },
  recommendation: { type: "string", enum: ["ready_for_review", "blocked", "needs_more_work"], description: "ready_for_review = pode seguir para o Revisor humano; blocked = há reprovação que impede seguir; needs_more_work = falta trabalho antes de revisar de novo." },
});

const nonEmpty = z.string().transform(s => s.trim()).pipe(z.string().min(1));
const QAZ = z.object({
  outcome: z.enum(["done", "needs_clarification"]),
  summary: z.string(),
  criteria: z.array(z.object({
    criterion: nonEmpty, verdict: z.enum(["approved", "rejected", "not_verified"]),
    steps: z.string(), expected: z.string(), observed: z.string(), impact: z.string(),
    notVerifiedReason: z.string(), evidence: z.string(),
  }).strict()).max(30),
  questions: z.array(z.object({ question: nonEmpty, why_it_blocks: z.string() }).strict()).max(10),
  not_verified: z.array(z.string()).max(30),
  recommendation: z.enum(["ready_for_review", "blocked", "needs_more_work"]),
}).strict();

export type QAValidation = { ok: true; result: QAResult } | { ok: false; errors: string[] };

/** @param expectedCriteria the demand's own acceptance criteria — every one of them must appear, verbatim, exactly once. */
export function validateQAResult(raw: unknown, expectedCriteria: string[]): QAValidation {
  const parsed = QAZ.safeParse(raw);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.slice(0, 12).map(i => `${i.path.join(".") || "(raiz)"}: ${i.message}`) };
  const d = parsed.data;
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const c of d.criteria) {
    if (seen.has(c.criterion)) errors.push(`Critério "${c.criterion.slice(0, 80)}" classificado mais de uma vez.`);
    seen.add(c.criterion);
    if (!expectedCriteria.includes(c.criterion)) errors.push(`Critério "${c.criterion.slice(0, 80)}" não corresponde a nenhum critério de aceite real da demanda. Copie o texto exato.`);
    if (c.verdict === "rejected" && !(c.steps.trim() && c.expected.trim() && c.observed.trim() && c.impact.trim())) errors.push(`Critério "${c.criterion.slice(0, 80)}" reprovado sem steps/expected/observed/impact completos.`);
    if (c.verdict === "not_verified" && !c.notVerifiedReason.trim()) errors.push(`Critério "${c.criterion.slice(0, 80)}" marcado como não verificado sem motivo.`);
    if (c.verdict === "approved" && !c.evidence.trim()) errors.push(`Critério "${c.criterion.slice(0, 80)}" aprovado sem evidência real.`);
  }
  for (const ec of expectedCriteria) if (!seen.has(ec)) errors.push(`Critério de aceite da demanda não classificado: "${ec.slice(0, 80)}".`);
  if (d.outcome === "needs_clarification" && !d.questions.length) errors.push("outcome = needs_clarification exige pelo menos uma pergunta.");
  if (d.criteria.some(c => c.verdict !== "approved") && d.recommendation === "ready_for_review") errors.push("Há critério reprovado ou não verificado; recommendation não pode ser ready_for_review.");
  if (errors.length) return { ok: false, errors };
  const result: QAResult = {
    outcome: d.outcome, summary: d.summary,
    criteria: d.criteria.map(c => ({
      criterion: c.criterion, verdict: c.verdict,
      ...(c.verdict === "rejected" ? { rejected: { steps: c.steps, expected: c.expected, observed: c.observed, impact: c.impact } } : {}),
      ...(c.verdict === "not_verified" ? { notVerifiedReason: c.notVerifiedReason } : {}),
      ...(c.verdict === "approved" ? { evidence: c.evidence } : {}),
    })),
    questions: d.questions, not_verified: d.not_verified, recommendation: d.recommendation,
  };
  return { ok: true, result };
}

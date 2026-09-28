// Output contract of the Reviewer's final parecer.
// - REVIEWER_JSON_SCHEMA goes to the official client as structured output (strict).
// - validateReviewerResult() is the executor's check: at least one fact (cited against real evidence) when
//   concluded, every inference states its basis, and the overall verdict cannot contradict QA's own parecer
//   — "aprovado" is refused when QA still has a rejected or not_verified criterion, and "reprovado" is
//   required when QA has any rejected criterion. The Reviewer never overrides QA's criterion verdicts here;
//   it only may not contradict them with a milder overall verdict than the evidence supports.
import { z } from "zod";
import type { QAResult, ReviewerResult } from "./types";

const str = { type: "string" } as const;
const strArr = { type: "array", items: str } as const;
const obj = (props: Record<string, unknown>) => ({ type: "object", additionalProperties: false, required: Object.keys(props), properties: props });

export const REVIEWER_JSON_SCHEMA = obj({
  outcome: { type: "string", enum: ["done", "needs_clarification"], description: "done quando o parecer final foi formado; needs_clarification quando falta informação para concluir com segurança." },
  summary: { ...str, description: "Resumo da revisão final e da conclusão geral." },
  facts: {
    type: "array",
    description: "O que foi verificado DIRETAMENTE contra as entregas reais e o parecer do QA (nunca contra o que alguém apenas afirmou).",
    items: obj({ statement: { ...str, description: "A afirmação verificada." }, evidence: { ...str, description: "A evidência real citada (arquivo, trecho de diff, resultado de verificação ou item do parecer do QA)." } }),
  },
  inferences: {
    type: "array",
    description: "Conclusões que não vêm de um fato citado diretamente, mas de dedução sobre o conjunto.",
    items: obj({ statement: { ...str, description: "A conclusão." }, basis: { ...str, description: "Em que ela se baseia (quais fatos, análises ou limitações)." } }),
  },
  not_verified: { ...strArr, description: "O que esta revisão final não pôde confirmar, além do que o QA já listou." },
  questions: { type: "array", items: obj({ question: str, why_it_blocks: str }) },
  verdict: { type: "string", enum: ["aprovado", "aprovado_com_ressalvas", "reprovado"], description: "Veredito final sobre a entrega desta demanda." },
});

const nonEmpty = z.string().transform(s => s.trim()).pipe(z.string().min(1));
const ReviewerZ = z.object({
  outcome: z.enum(["done", "needs_clarification"]),
  summary: z.string(),
  facts: z.array(z.object({ statement: nonEmpty, evidence: nonEmpty }).strict()).max(30),
  inferences: z.array(z.object({ statement: nonEmpty, basis: nonEmpty }).strict()).max(20),
  not_verified: z.array(z.string()).max(30),
  questions: z.array(z.object({ question: nonEmpty, why_it_blocks: z.string() }).strict()).max(10),
  verdict: z.enum(["aprovado", "aprovado_com_ressalvas", "reprovado"]),
}).strict();

export type ReviewerValidation = { ok: true; result: ReviewerResult } | { ok: false; errors: string[] };

/** @param qaResult the QA parecer this review is built on — the verdict may never contradict it. */
export function validateReviewerResult(raw: unknown, qaResult: QAResult): ReviewerValidation {
  const parsed = ReviewerZ.safeParse(raw);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.slice(0, 12).map(i => `${i.path.join(".") || "(raiz)"}: ${i.message}`) };
  const d = parsed.data;
  const errors: string[] = [];
  if (d.outcome === "needs_clarification" && !d.questions.length) errors.push("outcome = needs_clarification exige pelo menos uma pergunta.");
  if (d.outcome === "done" && !d.facts.length) errors.push("outcome = done exige pelo menos um fato verificado, com evidência real.");
  const qaRejected = qaResult.criteria.some(c => c.verdict === "rejected");
  const qaNotVerified = qaResult.criteria.some(c => c.verdict === "not_verified");
  if (d.outcome === "done") {
    if (qaRejected && d.verdict !== "reprovado") errors.push("O parecer do QA tem ao menos um critério reprovado; o veredito final não pode ser diferente de reprovado.");
    if (!qaRejected && (qaNotVerified || d.not_verified.length > 0) && d.verdict === "aprovado") errors.push("Há critério do QA não verificado ou item não verificado nesta revisão; o veredito não pode ser aprovado sem ressalvas.");
  }
  if (errors.length) return { ok: false, errors };
  const result: ReviewerResult = { outcome: d.outcome, summary: d.summary, facts: d.facts, inferences: d.inferences, not_verified: d.not_verified, questions: d.questions, verdict: d.verdict };
  return { ok: true, result };
}

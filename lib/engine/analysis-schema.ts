// Output contract of the Architect's analysis.
// - ANALYSIS_JSON_SCHEMA goes to the official client as structured output
//   (strict: every property required, no extra properties, no min/max).
// - validateAnalysis() is the executor's check. It rejects, never fills in:
//   a file marked as "read" must be one the executor really sent.
import { z } from "zod";
import type { ArchitectAnalysis } from "./types";

const str = { type: "string" } as const;
const strArr = { type: "array", items: str } as const;
const obj = (props: Record<string, unknown>) => ({ type: "object", additionalProperties: false, required: Object.keys(props), properties: props });

export const ANALYSIS_JSON_SCHEMA = obj({
  outcome: { type: "string", enum: ["analysis_ready", "needs_clarification"], description: "analysis_ready quando é seguro recomendar; needs_clarification quando alguma dúvida impede uma recomendação segura." },
  technical_understanding: { ...str, description: "Entendimento técnico da tarefa." },
  assumptions: { ...strArr, description: "Suposições feitas, cada uma explícita." },
  examined: {
    type: "array",
    description: "Arquivos, símbolos ou contratos examinados. basis=read só para conteúdo recebido em <dados_da_fonte>; o resto é inferred.",
    items: obj({ ref: { ...str, description: "Caminho do arquivo, opcionalmente com #símbolo." }, kind: { type: "string", enum: ["file", "symbol", "contract", "config", "other"] }, basis: { type: "string", enum: ["read", "inferred"] }, note: str }),
  },
  recommendation: obj({ summary: { ...str, description: "Solução recomendada." }, rationale: { ...str, description: "Justificativa." } }),
  alternatives: { type: "array", description: "Somente quando houver uma decisão técnica real; senão, lista vazia.", items: obj({ option: str, tradeoff: str, why_not_chosen: str }) },
  dependencies: strArr,
  compatibility: strArr,
  risks: { type: "array", items: obj({ risk: str, regression_area: str, mitigation: str }) },
  developer_guidance: { ...strArr, description: "Orientação objetiva ao Desenvolvedor, em passos." },
  qa_checks: { ...strArr, description: "Checagens recomendadas ao QA. Nada disso foi executado." },
  questions: { type: "array", items: obj({ question: str, why_it_blocks: str }) },
  not_verified: { ...strArr, description: "O que não foi verificado." },
});

const nonEmpty = z.string().transform(s => s.trim()).pipe(z.string().min(1));
const AnalysisZ = z.object({
  outcome: z.enum(["analysis_ready", "needs_clarification"]),
  technical_understanding: nonEmpty,
  assumptions: z.array(z.string()).max(30),
  examined: z.array(z.object({ ref: nonEmpty, kind: z.enum(["file", "symbol", "contract", "config", "other"]), basis: z.enum(["read", "inferred"]), note: z.string() }).strict()).max(60),
  recommendation: z.object({ summary: z.string(), rationale: z.string() }).strict(),
  alternatives: z.array(z.object({ option: nonEmpty, tradeoff: z.string(), why_not_chosen: z.string() }).strict()).max(10),
  dependencies: z.array(z.string()).max(30),
  compatibility: z.array(z.string()).max(30),
  risks: z.array(z.object({ risk: nonEmpty, regression_area: z.string(), mitigation: z.string() }).strict()).max(30),
  developer_guidance: z.array(z.string()).max(40),
  qa_checks: z.array(z.string()).max(40),
  questions: z.array(z.object({ question: nonEmpty, why_it_blocks: z.string() }).strict()).max(10),
  not_verified: z.array(z.string()).max(30),
}).strict();

export type AnalysisValidation = { ok: true; analysis: ArchitectAnalysis } | { ok: false; errors: string[] };

/** File part of a reference such as "lib/a.ts#Foo", "lib/a.ts:12" or "lib/a.ts (Foo)". */
export function refPath(ref: string) {
  return ref.trim().replace(/^`|`$/g, "").split(/[#\s(]|:(?=\d|[A-Za-z_]\w*$)/)[0].replace(/\/$/, "");
}

const words = (t: string) => new Set(t.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").split(/[^a-z0-9_./-]+/).filter(w => w.length >= 4));
/** Word overlap (Jaccard) between two questions: 1 = same words. */
export function questionSimilarity(a: string, b: string) {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

/**
 * @param readPaths files whose content the executor actually sent to the Architect.
 * @param answered questions already resolved (by the user or by reading); repeating one is refused unless a contradiction is stated.
 */
export function validateAnalysis(raw: unknown, readPaths: string[], answered: string[] = []): AnalysisValidation {
  const parsed = AnalysisZ.safeParse(raw);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.slice(0, 12).map(i => `${i.path.join(".") || "(raiz)"}: ${i.message}`) };
  const a = parsed.data as ArchitectAnalysis;
  const errors: string[] = [];
  const read = new Set(readPaths);
  for (const e of a.examined) {
    if (e.basis !== "read") continue;
    const p = refPath(e.ref);
    if (!read.has(p)) errors.push(`examined "${e.ref}": marcado como lido, mas o conteúdo desse arquivo não foi enviado nesta execução. Use basis = "inferred" ou remova.`);
  }
  for (const q of a.questions) {
    const same = answered.find(x => questionSimilarity(x, q.question) >= 0.5);
    if (same && !/^contradi[cç][aã]o\s*:/i.test(q.why_it_blocks.trim())) errors.push(`A pergunta "${q.question.slice(0, 120)}" repete uma dúvida já resolvida em <esclarecimentos>. Use a resposta dada; só repita se houver contradição nova, começando why_it_blocks com "Contradição:".`);
  }
  if (a.outcome === "needs_clarification" && !a.questions.length) errors.push("outcome = needs_clarification exige pelo menos uma pergunta.");
  if (a.outcome === "analysis_ready") {
    if (!a.recommendation.summary.trim()) errors.push("Uma análise concluída precisa de recommendation.summary.");
    if (!a.recommendation.rationale.trim()) errors.push("Uma análise concluída precisa de recommendation.rationale.");
    if (!a.developer_guidance.some(g => g.trim())) errors.push("Uma análise concluída precisa de orientação ao Desenvolvedor.");
    if (!a.qa_checks.some(g => g.trim())) errors.push("Uma análise concluída precisa de checagens recomendadas ao QA.");
  }
  return errors.length ? { ok: false, errors } : { ok: true, analysis: a };
}

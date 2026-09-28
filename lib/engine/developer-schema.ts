// Output contract of the Developer's own report. The actual result of the
// execution is the diff the executor computes independently (see
// lib/executor/worktree.ts#diffWorktree); this schema is the model's
// self-report, validated and cross-checked against that diff, never trusted
// on its own ("uma resposta textual não substitui o diff").
import { z } from "zod";
import type { DeveloperResult } from "./types";

const str = { type: "string" } as const;
const strArr = { type: "array", items: str } as const;
const obj = (props: Record<string, unknown>) => ({ type: "object", additionalProperties: false, required: Object.keys(props), properties: props });

export const DEVELOPER_JSON_SCHEMA = obj({
  outcome: { type: "string", enum: ["done", "needs_clarification"], description: "done quando a implementação está pronta para o QA; needs_clarification quando uma dúvida real impede continuar com segurança." },
  summary: { ...str, description: "Resumo da solução implementada." },
  changes: {
    type: "array",
    description: "Arquivos que você criou, alterou ou removeu, e o motivo de cada um. O executor confere isto contra o diff real; não invente nem omita.",
    items: obj({ path: str, action: { type: "string", enum: ["created", "modified", "deleted"] }, reason: str }),
  },
  acceptance: {
    type: "array",
    description: "Um item por critério de aceite da tarefa, na mesma ordem.",
    items: obj({ criterion: str, status: { type: "string", enum: ["met", "not_met", "not_verified"] }, note: str }),
  },
  questions: { type: "array", description: "Só quando outcome = needs_clarification.", items: obj({ question: str, why_it_blocks: str }) },
  not_verified: { ...strArr, description: "O que não foi verificado (nenhum comando foi executado nesta versão; veja o protocolo)." },
  assumptions: { ...strArr, description: "Suposições feitas, cada uma explícita." },
});

const nonEmpty = z.string().transform(s => s.trim()).pipe(z.string().min(1));
const pathZ = z.string().max(300).regex(/^[A-Za-z0-9_.@[\]/-]+$/, "caminho inválido").refine(v => !v.includes(".."), "caminho inválido");

const DeveloperZ = z.object({
  outcome: z.enum(["done", "needs_clarification"]),
  summary: z.string(),
  changes: z.array(z.object({ path: pathZ, action: z.enum(["created", "modified", "deleted"]), reason: z.string() }).strict()).max(60),
  acceptance: z.array(z.object({ criterion: nonEmpty, status: z.enum(["met", "not_met", "not_verified"]), note: z.string() }).strict()).max(30),
  questions: z.array(z.object({ question: nonEmpty, why_it_blocks: z.string() }).strict()).max(10),
  not_verified: z.array(z.string()).max(30),
  assumptions: z.array(z.string()).max(30),
}).strict();

export type DeveloperValidation = { ok: true; result: DeveloperResult } | { ok: false; errors: string[] };

/**
 * Validates the model's self-report and cross-checks it against the diff the executor computed
 * independently. A claim that does not match the real diff is refused, never silently accepted.
 * @param diffPaths files the independently computed diff actually touched (any status).
 * @param outOfScope files touched outside the approved edit scope (non-empty ⇒ refused).
 */
export function validateDeveloperResult(raw: unknown, diffPaths: string[], outOfScope: string[]): DeveloperValidation {
  const parsed = DeveloperZ.safeParse(raw);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.slice(0, 12).map(i => `${i.path.join(".") || "(raiz)"}: ${i.message}`) };
  const r = parsed.data as DeveloperResult;
  const errors: string[] = [];
  if (outOfScope.length) errors.push(`O diff real alterou arquivo(s) fora do escopo aprovado: ${outOfScope.join(", ")}. Desfaça essas alterações (edite-as de volta ao conteúdo original) e mantenha-se apenas nos caminhos aprovados.`);
  const diff = new Set(diffPaths);
  for (const c of r.changes) if (!diff.has(c.path)) errors.push(`changes "${c.path}": você relatou esta alteração, mas o diff real da cópia isolada não mostra nenhuma mudança nesse arquivo.`);
  const reported = new Set(r.changes.map(c => c.path));
  const unreported = diffPaths.filter(p => !reported.has(p) && !outOfScope.includes(p));
  if (unreported.length) errors.push(`O diff real alterou ${unreported.join(", ")}, mas isso não aparece em "changes". Relate todos os arquivos que você tocou.`);
  if (r.outcome === "needs_clarification" && !r.questions.length) errors.push("outcome = needs_clarification exige pelo menos uma pergunta.");
  if (r.outcome === "done") {
    if (!r.summary.trim()) errors.push("Uma implementação pronta precisa de summary.");
    if (!r.acceptance.length) errors.push("Uma implementação pronta precisa avaliar os critérios de aceite em acceptance.");
  }
  return errors.length ? { ok: false, errors } : { ok: true, result: r };
}

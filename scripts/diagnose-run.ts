// Usage diagnosis of a recorded run: what the Setor IA assembled (measured in
// characters from the frozen prompt) next to what the official client reported
// (tokens by category). Reads the executor's SQLite file in read-only mode.
// Usage: pnpm diagnose:run <run-id-prefix>
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ANALYSIS_JSON_SCHEMA } from "@/lib/engine/analysis-schema";
import { promptComposition } from "@/lib/engine/composition";
import { PLAN_JSON_SCHEMA } from "@/lib/engine/plan-schema";
import type { RunBudget, SourceContext } from "@/lib/engine/types";

const prefix = (process.argv[2] ?? "").toLowerCase();
if (!/^[0-9a-f-]{4,36}$/.test(prefix)) { console.error("Informe o início do ID da execução."); process.exit(1); }
const db = new DatabaseSync(path.join(process.cwd(), ".ayla", "runs.sqlite"), { readOnly: true });
const row = db.prepare("SELECT * FROM director_runs WHERE id LIKE ?").get(`${prefix}%`) as Record<string, string> | undefined;
if (!row) { console.error("Execução não encontrada."); process.exit(1); }
const prompt = JSON.parse(row.prompt_json) as { system: string; user: string };
const budget = JSON.parse(row.budget_json) as RunBudget;
const ctx = JSON.parse(row.context_json ?? "null") as SourceContext | null;
const schema = JSON.stringify(row.kind === "architect_task" ? ANALYSIS_JSON_SCHEMA : PLAN_JSON_SCHEMA).length;
const comp = promptComposition(prompt, schema);
const n = (x: number | null | undefined) => (x == null ? "indisponível" : x.toLocaleString("pt-BR"));

console.log(`Execução ${row.id} (${row.kind}, ${row.status}, ${row.connection}${row.model ? `, modelo ${row.model}` : ""})`);
if (ctx?.kind === "github") console.log(`Fonte: ${ctx.owner}/${ctx.repo} @ ${ctx.commit}${ctx.via === "local_git" ? " (cópia local)" : " (GitHub)"}`);
console.log("\n1) Texto montado pelo Setor IA (medido em caracteres, a partir da entrada congelada):");
for (const p of comp.parts) console.log(`   ${p.label.padEnd(58)} ${p.chars.toLocaleString("pt-BR").padStart(8)}  ${((p.chars / comp.total) * 100).toFixed(1).padStart(5)}%${p.detail ? `  (${p.detail})` : ""}`);
console.log(`   ${"TOTAL".padEnd(58)} ${comp.total.toLocaleString("pt-BR").padStart(8)}`);
if (ctx?.kind === "github") {
  console.log("\n   Arquivos: bytes no commit / caracteres enviados");
  for (const f of ctx.files) console.log(`   - ${f.path}: ${f.bytes.toLocaleString("pt-BR")} B / ${f.sentChars.toLocaleString("pt-BR")}${f.excerpt ? " (trecho)" : f.truncated ? " (truncado)" : ""}`);
}
console.log(`\n   Estimativa do Setor IA antes da chamada (caracteres ÷ 3,5): ≈ ${n(budget.estimatedInputTokens)} tokens — é estimativa, não medida.`);
console.log("\n2) Medido pelo cliente oficial:");
for (const c of budget.calls) {
  console.log(`   [${c.label}] fonte: ${c.source ?? "registro anterior à identificação da fonte"}`);
  console.log(`     entrada ${n(c.inputTokens)} · cache lido ${n(c.cacheReadTokens)} · cache gravado ${n(c.cacheWriteTokens)} · saída ${n(c.outputTokens)} (raciocínio ${n(c.reasoningTokens)}) · modelo ${c.model ?? "não informado"}`);
  console.log(`     turnos: ${c.turns == null ? "indisponível" : c.turns} · por requisição: ${c.apiCalls?.length ? c.apiCalls.map((x, i) => `#${i + 1} ent ${n(x.inputTokens)}/cache-l ${n(x.cacheReadTokens)}/cache-g ${n(x.cacheWriteTokens)}/saída ${n(x.outputTokens)}`).join("; ") : "indisponível neste registro"}`);
  if ((c.turns ?? 0) > (c.apiCalls?.length ?? 0)) console.log(`     atenção: o cliente detalhou ${c.apiCalls?.length ?? 0} de ${c.turns} turnos; o detalhe não soma o total.`);
}
console.log(`   Total informado: ${n(budget.reportedTotalTokens)} · orçamento da ficha (referência): ${budget.sheetTokens.toLocaleString("pt-BR")}`);
console.log(`   Resposta devolvida: ${(row.raw_output ?? "").length.toLocaleString("pt-BR")} caracteres`);
console.log("\n3) Limites da atribuição:");
console.log("   - O cliente informa tokens só por categoria; não há contagem por seção. Não existe tokenizador local oficial sem chave de API.");
console.log("   - O cliente acrescenta contexto próprio (definição da ferramenta de saída estruturada com o esquema, instruções internas) e pode usar mais de uma requisição por execução; essas partes não vêm separadas.");
console.log("   - Cache gravado e cache lido são a mesma entrada contada em requisições diferentes; somá-los ao total não significa texto novo enviado.");

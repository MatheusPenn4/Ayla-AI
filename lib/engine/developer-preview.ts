// Preview of a FUTURE hand-off to the Developer. It is only a view built from
// the executor's records: it creates no run, calls no model and grants no
// write access. The Developer does not execute in this phase.
import type { TaskStateKey } from "./handoff-state";
import type { DependencyAnalysis, PlanTask } from "./types";

export const DEVELOPER_PREVIEW_NOTICE = [
  "Esta é apenas uma visualização do futuro envio ao Desenvolvedor.",
  "Ela não cria execução, não chama nenhum modelo e não concede acesso de escrita a nenhum arquivo.",
  "O Desenvolvedor ainda não executa no Setor IA: nada será editado, commitado, publicado ou enviado a partir dela.",
];

export type PreviewTaskRow = {
  id: string; title: string; assignee: string; assigneeName: string;
  relation: "esta tarefa" | "dependência direta" | "dependência indireta" | "depende desta" | "outra";
  state: TaskStateKey; stateLabel: string; runId: string | null;
};

export type DeveloperPreview = {
  generatedAt: string;
  notice: string[];
  demand: { title: string; description: string; acceptanceCriteria: string[]; project?: string };
  plan: { runId: string; connection: string; objective: string; flowType: string };
  task: PlanTask;
  /** Every dependency (direct and indirect) has a concluded analysis. */
  eligible: boolean;
  blockers: string[];
  tasks: PreviewTaskRow[];
  analyses: (DependencyAnalysis & { taskId: string; title: string; qaChecks: number })[];
  base: {
    proposed: { commit: string; via: "github" | "local_git"; why: string } | null;
    head: { commit: string; subject: string; dirName: string; descendsFromProposed: boolean | null } | null;
    /** Files changed between each analysis commit and the proposed base that the analysis examined. */
    sinceAnalyses: { taskId: string; commit: string; relation: string; changedTotal: number | null; examinedChanged: string[] }[];
    note: string;
  };
  unverified: { source: string; text: string }[];
  /** "consultar" = the analyses only ask to read it before changing anything. */
  editScope: { path: string; action: "alterar" | "criar" | "consultar" | "a confirmar"; from: string[] }[];
  outOfScope: string[];
  /** What a future Developer execution would need (not implemented). */
  future: string[];
};

// Line breaks are flattened and the characters that change Markdown structure are escaped (intraword "_" is harmless).
const esc = (t: string) => t.replace(/\r?\n+/g, " ").replace(/([\\`*[\]<>|])/g, "\\$1");

/** Markdown copy of the preview, generated from the same object the screen shows. */
export function developerPreviewMarkdown(p: DeveloperPreview): string {
  const L: string[] = [];
  L.push(`# Prévia do envio ao Desenvolvedor: ${p.task.id}`);
  L.push("");
  for (const n of p.notice) L.push(`> **${esc(n)}**`);
  L.push("");
  L.push(`Gerada em ${p.generatedAt} a partir dos registros do executor local. Plano do Diretor \`${p.plan.runId.slice(0, 8)}\`.`);
  L.push("");
  L.push("## Demanda original");
  L.push(`**${esc(p.demand.title)}**${p.demand.project ? ` · ${esc(p.demand.project)}` : ""}`);
  L.push("");
  L.push(esc(p.demand.description));
  if (p.demand.acceptanceCriteria.length) { L.push(""); L.push("Critérios de aceite:"); p.demand.acceptanceCriteria.forEach((c, i) => L.push(`${i + 1}. ${esc(c)}`)); }
  L.push("");
  L.push(`## Tarefa ${p.task.id}: ${esc(p.task.title)}`);
  L.push(`- Escopo: ${esc(p.task.scope)}`);
  L.push(`- Insumos: ${esc(p.task.inputs || "—")}`);
  L.push(`- Entregável: ${esc(p.task.deliverable)}`);
  L.push("- Critérios de aceite:");
  for (const c of p.task.acceptance_criteria) L.push(`  - ${esc(c)}`);
  L.push(`- Apta para revisão: ${p.eligible ? "sim, todas as dependências têm análise concluída" : `não (${p.blockers.map(esc).join("; ")})`}`);
  L.push("");
  L.push("## Tarefas relevantes do plano (estado real no executor)");
  L.push("| Tarefa | Responsável | Relação | Estado |");
  L.push("|---|---|---|---|");
  for (const t of p.tasks) L.push(`| ${t.id} · ${esc(t.title)} | ${esc(t.assigneeName)} | ${t.relation} | ${t.stateLabel}${t.runId ? ` (\`${t.runId.slice(0, 8)}\`)` : ""} |`);
  L.push("");
  L.push("## Análises registradas dos Arquitetos");
  if (!p.analyses.length) L.push("Nenhuma.");
  for (const a of p.analyses) {
    L.push(`### ${a.taskId} · ${esc(a.title)}`);
    L.push(`Execução \`${a.runId.slice(0, 8)}\`${a.revision ? `, revisão ${a.revision}` : ""}, commit \`${a.commit?.slice(0, 12) ?? "—"}\`${a.via === "local_git" ? " (cópia local)" : ""}. Análise de outro colaborador: insumo, não fato verificado.`);
    L.push("");
    L.push(`- Recomendação: ${esc(a.recommendation.summary)}`);
    L.push(`- Justificativa: ${esc(a.recommendation.rationale)}`);
    if (a.guidance.length) { L.push("- Orientação ao Desenvolvedor:"); a.guidance.forEach((g, i) => L.push(`  ${i + 1}. ${esc(g)}`)); }
    if (a.risks.length) { L.push("- Riscos:"); for (const r of a.risks) L.push(`  - ${esc(r)}`); }
    if (a.decisions.length) { L.push("- Decisões suas registradas nesse envio:"); for (const d of a.decisions) L.push(`  - ${esc(d.topic)}: ${esc(d.answer)}`); }
    L.push(`- Checagens recomendadas ao QA: ${a.qaChecks} (não executadas)`);
    L.push("");
  }
  L.push("## Commit de base proposto");
  L.push(p.base.proposed ? `\`${p.base.proposed.commit}\`${p.base.proposed.via === "local_git" ? " (cópia local, não publicado)" : ""}: ${esc(p.base.proposed.why)}` : "Nenhum.");
  if (p.base.head) L.push(`HEAD da cópia local: \`${p.base.head.commit.slice(0, 12)}\` (${esc(p.base.head.subject)})${p.base.head.descendsFromProposed === true ? ", descende do proposto" : p.base.head.descendsFromProposed === false ? ", NÃO descende do proposto" : ""}.`);
  for (const s of p.base.sinceAnalyses) L.push(`- Desde a análise de ${s.taskId} (\`${s.commit.slice(0, 12)}\`, ${s.relation}): ${s.changedTotal ?? "?"} arquivo(s) alterado(s) no repositório${s.examinedChanged.length ? `; examinados por ela e alterados: ${s.examinedChanged.join(", ")}` : "; nenhum arquivo examinado por ela foi alterado"}.`);
  L.push(esc(p.base.note));
  L.push("");
  L.push("## Pontos ainda não verificados");
  if (!p.unverified.length) L.push("Nenhum registrado.");
  for (const u of p.unverified) L.push(`- [${esc(u.source)}] ${esc(u.text)}`);
  L.push("");
  L.push("## Escopo de edição previsto (não é permissão)");
  if (!p.editScope.length) L.push("Nenhum arquivo citado.");
  for (const e of p.editScope) L.push(`- ${e.path}: ${e.action} (citado em: ${e.from.join(", ")})`);
  L.push("");
  L.push("Fora do escopo desta tarefa:");
  for (const o of p.outOfScope) L.push(`- ${esc(o)}`);
  L.push("");
  L.push("## O que uma futura execução do Desenvolvedor exigiria (não implementado)");
  for (const f of p.future) L.push(`- ${esc(f)}`);
  L.push("");
  return L.join("\n");
}

// Pure serializer for the Director plan export (task-2's canonical format).
// Turns a plan the caller has already resolved (owner/assignee names, a
// per-task state label and, when available, the Architect's analysis
// summary) into the Markdown document the user downloads from the run
// window. No React, no DOM, no network, no store/client imports: only plain
// data in, one string out — safe to unit test with plain objects.
import type { DirectorPlan, PlanStep, PlanTask } from "./types";

export type PlanMarkdownStep = { step: PlanStep; ownerName: string };

export type PlanMarkdownTask = {
  task: PlanTask;
  assigneeName: string;
  /** Real state of the task as shown in the UI (e.g. "Proposta", "Análise concluída (Arquiteto)"). Never implies code was written. */
  stateLabel: string;
  /** Architect's recommendation summary, only when an analysis for this task was actually concluded. */
  architectSummary: string | null;
  /** Note about that summary (e.g. it could not be fetched), shown alongside or instead of it. */
  architectSummaryNote: string | null;
};

export type PlanMarkdownInput = {
  demandTitle: string;
  runId: string;
  /** Already formatted for display by the caller (e.g. "28/09/2026 14:32"). Not reformatted here. */
  generatedAt: string;
  plan: DirectorPlan;
  /** Same order as plan.steps — never reordered or filtered. */
  steps: PlanMarkdownStep[];
  /** Same order as plan.tasks — never reordered or filtered. Every entry here is rendered. */
  tasks: PlanMarkdownTask[];
};

const EMPTY_MARK = "_Nenhum item registrado._";

/** ASCII punctuation with Markdown meaning in the contexts this document uses (paragraphs, lists, headings, blockquotes, emphasis, links). */
const MD_SPECIAL = /[\\`*_{}[\]()#+\-.!|><~]/g;

/**
 * Escapes free text authored by the Director/Architect so it can never be
 * misread as Markdown structure (a heading, a list marker, a blockquote, a
 * link, emphasis...). Also collapses internal line breaks to a single space,
 * so a value with an embedded newline can never split a list item into a
 * new, unmarked line or start an accidental heading/list on its own line.
 * Safe on falsy input: returns "".
 */
export function escapeMdText(text: string): string {
  if (!text) return "";
  const oneLine = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map(l => l.trim())
    .filter(Boolean)
    .join(" ");
  return oneLine.replace(MD_SPECIAL, m => `\\${m}`);
}

/**
 * Wraps arbitrary text (an id) in a Markdown inline-code span, choosing a
 * backtick fence one longer than the longest run of backticks already in
 * the text (and padding with a space on any side that starts/ends with a
 * backtick), so the id can never break out of its own code span — including
 * the rare case where an id itself contains a backtick. escapeMdText is
 * deliberately NOT applied here: inside a code span backslash escapes are
 * literal text, not escapes, so running it first would show a visible
 * backslash instead of protecting anything.
 */
function mdCode(text: string): string {
  const t = text ?? "";
  if (!t) return "``";
  const runs = t.match(/`+/g) ?? [];
  const maxRun = runs.reduce((max, r) => Math.max(max, r.length), 0);
  const fence = "`".repeat(maxRun + 1);
  const padded = t.startsWith("`") || t.endsWith("`") ? ` ${t} ` : t;
  return `${fence}${padded}${fence}`;
}

function idList(ids: string[]): string {
  return ids.length ? ids.map(mdCode).join(", ") : "—";
}

function bulletList(items: string[]): string {
  return items.length ? items.map(i => `- ${escapeMdText(i)}`).join("\n") : EMPTY_MARK;
}

function renderStep(entry: PlanMarkdownStep): string {
  const { step, ownerName } = entry;
  return [
    `- ${mdCode(step.id)} **${escapeMdText(step.title)}** — responsável: ${escapeMdText(ownerName)}; depende de: ${idList(step.depends_on)}`,
    `  Concluída quando: ${escapeMdText(step.done_when)}`,
  ].join("\n");
}

function renderTask(entry: PlanMarkdownTask): string {
  const { task, assigneeName, stateLabel, architectSummary, architectSummaryNote } = entry;
  const lines: string[] = [];
  lines.push(`### ${escapeMdText(task.title)}`);
  lines.push("");
  lines.push(`- **Responsável:** ${escapeMdText(assigneeName)}`);
  lines.push(`- **Etapa:** ${task.step_id ? mdCode(task.step_id) : "—"}`);
  lines.push(`- **Depende de:** ${idList(task.depends_on)}`);
  lines.push(`- **Estado:** ${escapeMdText(stateLabel)}`);
  lines.push(`- **Escopo:** ${escapeMdText(task.scope)}`);
  lines.push(`- **Insumos:** ${task.inputs ? escapeMdText(task.inputs) : "—"}`);
  lines.push(`- **Entregável:** ${escapeMdText(task.deliverable)}`);
  lines.push(`- **Critérios de aceite:**`);
  if (task.acceptance_criteria.length) {
    for (const c of task.acceptance_criteria) lines.push(`  - ${escapeMdText(c)}`);
  } else {
    lines.push(`  - ${EMPTY_MARK}`);
  }
  if (architectSummary) lines.push(`- **Resumo do Arquiteto:** ${escapeMdText(architectSummary)}`);
  if (architectSummaryNote) lines.push(`- _${escapeMdText(architectSummaryNote)}_`);
  return lines.join("\n");
}

/**
 * Serializes a Director plan into the canonical Markdown export: title/meta,
 * an explicit "this is a proposal, nothing ran" warning, then, in this fixed
 * order and with no other section, Objetivo → Etapas → Tarefas propostas →
 * Riscos → Ainda não verificado. Every entry of `input.tasks` is rendered,
 * in the same order as `input.plan.tasks` — none is skipped, merged or
 * reordered. Pure function: no DOM, no network, no randomness (besides the
 * caller-supplied `generatedAt`).
 */
export function directorPlanToMarkdown(input: PlanMarkdownInput): string {
  const { demandTitle, runId, generatedAt, plan, steps, tasks } = input;
  const shortRunId = runId ? runId.slice(0, 8) : "—";
  const parts: string[] = [];
  parts.push(`# Plano do Diretor — ${escapeMdText(demandTitle)}`);
  parts.push(`_Execução ${mdCode(shortRunId)} · gerado em ${escapeMdText(generatedAt)}_`);
  parts.push(
    "> **Atenção: proposta, não execução.** Este documento é uma proposta do Diretor. " +
      "Nenhuma tarefa foi implementada. Quando indicado, o estado de cada tarefa mostra apenas se a " +
      "análise técnica do Arquiteto foi concluída para ela — nenhum código foi escrito, testado ou " +
      "publicado a partir deste plano."
  );
  parts.push(`## Objetivo\n\n${escapeMdText(plan.objective_summary)}`);
  parts.push(`## Etapas\n\n${steps.length ? steps.map(renderStep).join("\n\n") : EMPTY_MARK}`);
  parts.push(`## Tarefas propostas\n\n${tasks.length ? tasks.map(renderTask).join("\n\n") : EMPTY_MARK}`);
  parts.push(`## Riscos\n\n${bulletList(plan.risks)}`);
  parts.push(`## Ainda não verificado\n\n${bulletList(plan.not_verified)}`);
  return parts.join("\n\n") + "\n";
}

/** Slug of demandTitle + short run id + ".md", safe as a filename on every common OS/filesystem. */
export function planMarkdownFilename(demandTitle: string, runId: string): string {
  const slug = demandTitle
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  const shortRun = runId ? runId.slice(0, 8) : "run";
  return `plano-${slug || "diretor"}-${shortRun}.md`;
}

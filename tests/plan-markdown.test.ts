// Task-3 (Exportar o plano do Diretor em Markdown): unit coverage for the pure serializer,
// written locally after the Developer's sandboxed run flagged it could not create a test file
// itself (no test path was in the approved edit scope for that execution, and it had no
// terminal to run vitest even if one had been). Criterion 6 of the task ("os testes demonstram
// que nenhuma tarefa da entrada é omitida") is exercised directly below.
import { describe, expect, it } from "vitest";
import { directorPlanToMarkdown, escapeMdText, planMarkdownFilename, type PlanMarkdownInput, type PlanMarkdownTask } from "@/lib/engine/plan-markdown";
import type { DirectorPlan, PlanStep, PlanTask } from "@/lib/engine/types";

const plan = (over: Partial<DirectorPlan> = {}): DirectorPlan => ({
  outcome: "plan_ready", objective_summary: "Deixar o plano exportável em Markdown.",
  context_understanding: "", flow: { type: "short", rationale: "", skipped_roles: [] }, questions: [],
  steps: [], tasks: [], risks: [], assumptions: [], not_verified: [],
  ...over,
});

const step = (over: Partial<PlanStep> = {}): PlanStep => ({ id: "step-1", title: "Implementar", owner: "developer", depends_on: [], done_when: "Feito", ...over });
const task = (over: Partial<PlanTask> = {}): PlanTask => ({
  id: "task-1", step_id: "step-1", assignee: "developer", title: "Tarefa", scope: "Escopo", inputs: "Demanda",
  deliverable: "Diff", acceptance_criteria: ["Critério 1"], depends_on: [], ...over,
});
const mdTask = (t: PlanTask, over: Partial<PlanMarkdownTask> = {}): PlanMarkdownTask => ({
  task: t, assigneeName: "Desenvolvedor", stateLabel: "Proposta", architectSummary: null, architectSummaryNote: null, ...over,
});
const input = (over: Partial<PlanMarkdownInput> = {}): PlanMarkdownInput => ({
  demandTitle: "Exportar o plano do Diretor em Markdown", runId: "92788815-fd9f-4fbd-be6a-bf9aa6fb3cca", generatedAt: "28/09/2026 15:00",
  plan: plan(), steps: [], tasks: [], ...over,
});

describe("directorPlanToMarkdown: estrutura, aviso e ordem fixa das seções", () => {
  it("inclui as 5 seções obrigatórias, nesta ordem, mais o aviso de proposta não executada", () => {
    const md = directorPlanToMarkdown(input({ plan: plan({ risks: ["Risco 1"], not_verified: ["Item 1"] }) }));
    const order = ["## Objetivo", "## Etapas", "## Tarefas propostas", "## Riscos", "## Ainda não verificado"].map(h => md.indexOf(h));
    expect(order.every(i => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order); // fixed order, not just present
    expect(md).toContain("proposta do Diretor");
    expect(md).toContain("Nenhuma tarefa foi implementada");
    expect(md.indexOf("Nenhuma tarefa foi implementada")).toBeLessThan(md.indexOf("## Objetivo")); // warning comes before any section
  });

  it("listas vazias (etapas, tarefas, riscos, não verificados) usam o marcador de vazio, nunca uma seção ausente ou quebrada", () => {
    const md = directorPlanToMarkdown(input());
    for (const h of ["## Etapas", "## Tarefas propostas", "## Riscos", "## Ainda não verificado"]) {
      const start = md.indexOf(h) + h.length;
      expect(md.slice(start, start + 40)).toContain("_Nenhum item registrado._");
    }
  });
});

describe("directorPlanToMarkdown: nenhuma tarefa de entrada é omitida (critério de aceite 6)", () => {
  it("plano só com tarefas propostas (nenhum especialista executou) — todas aparecem, nenhuma marcada como feita", () => {
    const tasks = [task({ id: "t1", title: "Primeira" }), task({ id: "t2", title: "Segunda", assignee: "architect" }), task({ id: "t3", title: "Terceira", assignee: "qa" })];
    const md = directorPlanToMarkdown(input({ plan: plan({ tasks }), tasks: tasks.map(t => mdTask(t, { stateLabel: "Proposta pelo Diretor" })) }));
    for (const t of tasks) expect(md).toContain(`### ${t.title}`);
    expect(md.match(/^### /gm)).toHaveLength(3);
    for (const t of tasks) expect(md).toMatch(new RegExp(`### ${t.title}[\\s\\S]*?\\*\\*Estado:\\*\\* Proposta pelo Diretor`));
  });

  it("nenhuma tarefa é perdida com uma lista maior e fora de ordem alfabética", () => {
    const tasks = Array.from({ length: 9 }, (_, i) => task({ id: `t${i}`, title: `Tarefa ${9 - i}` }));
    const md = directorPlanToMarkdown(input({ plan: plan({ tasks }), tasks: tasks.map(t => mdTask(t)) }));
    const headings = [...md.matchAll(/^### (.+)$/gm)].map(m => m[1]);
    expect(headings).toEqual(tasks.map(t => t.title)); // same order as input, none skipped, none reordered
  });

  it("tarefa com análise concluída do Arquiteto inclui o resumo, sem apresentá-lo como implementação", () => {
    const t = task({ id: "t1", title: "Analisada", assignee: "architect" });
    const md = directorPlanToMarkdown(input({
      plan: plan({ tasks: [t] }),
      tasks: [mdTask(t, { stateLabel: "Análise concluída (Arquiteto)", architectSummary: "Adicionar a classe azul no botão." })],
    }));
    expect(md).toContain("**Resumo do Arquiteto:** Adicionar a classe azul no botão\\.");
    expect(md).toContain("**Estado:** Análise concluída \\(Arquiteto\\)");
  });

  it("tarefa com execução com falha ou cancelada mostra o estado real, sem esconder nem inventar sucesso", () => {
    const failed = task({ id: "t1", title: "Com falha" });
    const canceled = task({ id: "t2", title: "Cancelada" });
    const md = directorPlanToMarkdown(input({
      plan: plan({ tasks: [failed, canceled] }),
      tasks: [mdTask(failed, { stateLabel: "Falha" }), mdTask(canceled, { stateLabel: "Cancelada" })],
    }));
    expect(md).toContain("### Com falha");
    expect(md).toMatch(/### Com falha[\s\S]*?\*\*Estado:\*\* Falha/);
    expect(md).toMatch(/### Cancelada[\s\S]*?\*\*Estado:\*\* Cancelada/);
  });
});

describe("directorPlanToMarkdown / escapeMdText: texto de usuário, caracteres especiais e quebras de linha", () => {
  it("escapa marcações que quebrariam a estrutura do documento (heading, lista, blockquote, ênfase, link)", () => {
    const dangerous = "# Fake heading\n- fake item\n> fake quote\n**not bold** [link](evil)";
    const t = task({ id: "t1", title: dangerous, scope: dangerous });
    const md = directorPlanToMarkdown(input({ plan: plan({ tasks: [t] }), tasks: [mdTask(t)] }));
    expect(md).not.toMatch(/^# Fake heading$/m);
    expect(md).not.toMatch(/^- fake item$/m);
    expect(md).not.toMatch(/^> fake quote$/m);
    expect(md).toContain("\\#");
    expect(md).toContain("\\[link\\]\\(evil\\)");
  });

  it("colapsa quebras de linha internas para uma só linha (não quebra a lista/estrutura em volta)", () => {
    expect(escapeMdText("linha 1\nlinha 2\r\nlinha 3")).toBe("linha 1 linha 2 linha 3");
  });

  it("texto vazio ou undefined-like não quebra a função (retorna string vazia)", () => {
    expect(escapeMdText("")).toBe("");
  });

  it("id com crases não escapa para fora do próprio code span (mdCode via renderStep)", () => {
    const s = step({ id: "id`com`crase" });
    const md = directorPlanToMarkdown(input({ steps: [{ step: s, ownerName: "Diretor" }] }));
    // Fence one backtick longer than the longest internal run (here: two single-backtick runs, so a 2-backtick fence suffices).
    expect(md).toContain("``id`com`crase``");
  });
});

describe("planMarkdownFilename", () => {
  it("normaliza acentos, espaços e maiúsculas; sempre termina em .md", () => {
    expect(planMarkdownFilename("Exportar o Plano do Diretor em Markdown", "92788815-xxxx")).toBe("plano-exportar-o-plano-do-diretor-em-markdown-92788815.md");
  });
  it("título vazio ou só símbolos cai num nome seguro, nunca um arquivo sem nome", () => {
    expect(planMarkdownFilename("!!!", "abc12345")).toBe("plano-diretor-abc12345.md");
  });
  it("é determinístico: a mesma entrada produz sempre o mesmo nome (base para 'exportar de novo após recarregar')", () => {
    const a = planMarkdownFilename("Demanda X", "run-1");
    const b = planMarkdownFilename("Demanda X", "run-1");
    expect(a).toBe(b);
  });
});

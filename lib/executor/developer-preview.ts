// Builds the preview of a future Developer hand-off from the executor's own
// records. Read-only: nothing is recorded, no client is called, no file is
// written, and no permission is granted.
import { partialTexts, refPath, refSymbol } from "@/lib/engine/analysis-schema";
import { DEVELOPER_PREVIEW_NOTICE, type DeveloperPreview, type PreviewTaskRow } from "@/lib/engine/developer-preview";
import { TASK_STATE_LABEL, isHandoffTarget, taskState } from "@/lib/engine/handoff-state";
import type { DirectorSnapshot, PlanTask } from "@/lib/engine/types";
import { extractFileRefs } from "./github";
import { HandoffRefused, dependencyAnalysis, type PrepareDeps } from "./handoff";
import { compareLocalCommits, listLocalRepos } from "./local-git";
import type { RunStore } from "./store";

const refuse = (status: number, code: string, message: string): never => { throw new HandoffRefused(status, code, message); };

/** Dependencies of a task, nearest first (direct, then indirect), without repetition. */
export function dependencyClosure(task: PlanTask, tasks: PlanTask[]) {
  const out: { task: PlanTask; direct: boolean }[] = [];
  const queue = task.depends_on.map(id => ({ id, direct: true }));
  while (queue.length) {
    const { id, direct } = queue.shift()!;
    const t = tasks.find(x => x.id === id);
    if (!t || t.id === task.id || out.some(o => o.task.id === id)) continue;
    out.push({ task: t, direct });
    queue.push(...t.depends_on.map(d => ({ id: d, direct: false })));
  }
  return out;
}

export async function developerPreview(q: { directorRunId: string; taskId: string }, deps: PrepareDeps & { store: RunStore }): Promise<DeveloperPreview> {
  const { store } = deps;
  const parent = await store.detail(q.directorRunId);
  if (!parent || parent.kind !== "director_plan") refuse(404, "plan_not_found", "Execução do Diretor não encontrada.");
  if (parent!.status !== "plan_ready" || !parent!.result) refuse(409, "plan_not_ready", "A prévia só existe para um plano pronto do Diretor.");
  const plan = parent!.result!;
  const task = plan.tasks.find(t => t.id === q.taskId);
  if (!task) refuse(404, "task_not_found", `A tarefa "${q.taskId}" não existe neste plano do Diretor.`);
  if (task!.assignee !== "developer") refuse(409, "not_developer_task", `A tarefa ${task!.id} é de "${task!.assignee}", não do Desenvolvedor.`);
  const snap = parent!.snapshot as DirectorSnapshot;
  const nameOf = (id: string) => snap.team.find(t => t.id === id)?.name ?? id;

  const closure = dependencyClosure(task!, plan.tasks);
  const rowsFor = async (t: PlanTask, relation: PreviewTaskRow["relation"]): Promise<PreviewTaskRow> => {
    const st = taskState(t, await store.runsForTask(parent!.id, t.id));
    return { id: t.id, title: t.title, assignee: t.assignee, assigneeName: nameOf(t.assignee), relation, state: st.key, stateLabel: TASK_STATE_LABEL[st.key], runId: st.run?.id ?? null };
  };
  const rows: PreviewTaskRow[] = [await rowsFor(task!, "esta tarefa")];
  for (const c of closure) rows.push(await rowsFor(c.task, c.direct ? "dependência direta" : "dependência indireta"));
  for (const t of plan.tasks.filter(x => x.depends_on.includes(task!.id))) rows.push(await rowsFor(t, "depende desta"));

  // Eligible only when every dependency (direct or not) is done by someone who runs in this phase.
  const blockers: string[] = [];
  const analyses: DeveloperPreview["analyses"] = [];
  for (const c of closure) {
    if (!isHandoffTarget(c.task.assignee)) { blockers.push(`${c.task.id} (${c.task.assignee}) ainda não executa nesta fase`); continue; }
    const done = (await store.runsForTask(parent!.id, c.task.id)).find(r => r.status === "analysis_ready");
    const a = done ? await dependencyAnalysis(store, done) : null;
    if (!done || !a) { blockers.push(`${c.task.id} ainda não tem análise concluída do Arquiteto`); continue; }
    analyses.push({ ...a, taskId: c.task.id, title: c.task.title, qaChecks: done.analysis?.qa_checks.length ?? 0 });
  }

  // Base commit: the most recent analysis commit; the local HEAD is compared with it and with every analysis commit.
  const ctx = parent!.context?.kind === "github" ? parent!.context : null;
  const latest = [...analyses].filter(a => a.commit).sort((x, y) => closure.findIndex(c => c.task.id === x.taskId) - closure.findIndex(c => c.task.id === y.taskId))[0];
  const proposed = latest?.commit ? { commit: latest.commit, via: (latest.via ?? "github") as "github" | "local_git", why: `Commit da análise de ${latest.taskId} (${latest.runId.slice(0, 8)}), a dependência mais próxima com análise registrada.` } : ctx ? { commit: ctx.commit, via: "github" as const, why: "Commit que o Diretor leu (nenhuma análise registrada)." } : null;
  const repos = deps.local?.dirs.length && ctx ? (await listLocalRepos(deps.local.dirs, deps.local.git)).filter(r => r.owner.toLowerCase() === ctx.owner.toLowerCase() && r.repo.toLowerCase() === ctx.repo.toLowerCase()) : [];
  const repo = repos[0] ?? null;
  const sinceAnalyses: DeveloperPreview["base"]["sinceAnalyses"] = [];
  let head: DeveloperPreview["base"]["head"] = null;
  if (repo && proposed) {
    const toHead = await compareLocalCommits({ dir: repo.dir, from: { commit: proposed.commit, label: "proposto" }, to: { commit: repo.head, label: "HEAD" }, paths: [] }, deps.local!.git);
    head = { commit: repo.head, subject: repo.headSubject, dirName: repo.dirName, descendsFromProposed: toHead.relation === "same" || toHead.relation === "descendant" ? true : toHead.relation === "not_descendant" ? false : null };
    for (const a of analyses.filter(x => x.commit)) {
      const paths = [...new Set(a.examined.map(e => e.ref.split("#")[0].trim()))];
      const cmp = await compareLocalCommits({ dir: repo.dir, from: { commit: a.commit!, label: `análise de ${a.taskId}` }, to: { commit: repo.head, label: "HEAD" }, paths }, deps.local!.git);
      sinceAnalyses.push({ taskId: a.taskId, commit: a.commit!, relation: cmp.relation === "same" ? "mesmo commit do HEAD" : cmp.relation === "descendant" ? "o HEAD descende dele" : cmp.relation === "not_descendant" ? "o HEAD NÃO descende dele" : "relação desconhecida", changedTotal: cmp.changedTotal, examinedChanged: cmp.files.filter(f => f.changed).map(f => f.path) });
    }
  }

  // Not verified: what the analyses say they did not verify, assumed, or only inferred; plus files changed since they were read.
  const unverified: DeveloperPreview["unverified"] = [];
  for (const a of analyses) {
    for (const t of a.notVerified) unverified.push({ source: `não verificado · ${a.taskId}`, text: t });
    for (const t of a.assumptions) unverified.push({ source: `suposição · ${a.taskId}`, text: t });
    for (const e of a.examined.filter(x => x.basis === "inferred")) unverified.push({ source: `inferido · ${a.taskId}`, text: `${e.ref} (não lido pelo Arquiteto)` });
    // Analyses recorded before the per-symbol check: a symbol marked as read whose block was not in the excerpt sent.
    const d = await store.detail(a.runId);
    if (d?.prompt && d.context?.kind === "github") {
      const partial = partialTexts(d.prompt.user, d.context.files);
      for (const e of a.examined.filter(x => x.basis === "read")) {
        const p = refPath(e.ref), sym = refSymbol(e.ref);
        if (sym && p in partial && !new RegExp(`(^|[^\\w$])${sym.replace(/\$/g, "\\$")}([^\\w$]|$)`).test(partial[p])) {
          unverified.push({ source: `lido só em parte · ${a.taskId}`, text: `${e.ref}: marcado como lido, mas o trecho enviado não continha o bloco de ${sym}; trate como não verificado.` });
        }
      }
    }
  }
  for (const s of sinceAnalyses) if (s.examinedChanged.length) unverified.push({ source: `alterado desde a análise · ${s.taskId}`, text: `${s.examinedChanged.join(", ")} mudaram entre ${s.commit.slice(0, 12)} e o HEAD; o que a análise diz sobre eles deve ser reconferido.` });

  // Edit scope: files cited by the task and by the analyses' recommendation and guidance. A forecast, never a permission.
  // The verb right before a path tells whether the text asks to change it or only to read it ("Ler lib/x.ts…").
  const scope = new Map<string, { from: Set<string>; edit: boolean }>();
  const cite = (text: string, from: string) => {
    for (const r of extractFileRefs(text)) {
      const p = r.split("#")[0];
      const before = text.slice(0, Math.max(0, text.indexOf(p))).toLowerCase();
      const verbs = [...before.matchAll(/\b(ler|leia|consultar|confirmar|verificar|conferir|criar|adicionar|alterar|editar|extrair|mover|implementar|incluir|reaproveitar|generalizar|inserir|modificar|atualizar)\b/g)];
      const last = verbs[verbs.length - 1]?.[1];
      const edit = !last || !["ler", "leia", "consultar", "confirmar", "verificar", "conferir"].includes(last);
      const cur = scope.get(p) ?? { from: new Set<string>(), edit: false };
      cur.from.add(from); cur.edit ||= edit;
      scope.set(p, cur);
    }
  };
  cite([task!.scope, task!.deliverable, task!.inputs].join("\n"), `tarefa ${task!.id}`);
  for (const a of analyses) { cite(`${a.recommendation.summary}\n${a.recommendation.rationale}`, `recomendação de ${a.taskId}`); for (const g of a.guidance) cite(g, `orientação de ${a.taskId}`); }
  let known: Set<string> | null = null;
  if (repo && proposed) {
    const all = await compareLocalCommits({ dir: repo.dir, from: { commit: proposed.commit, label: "proposto" }, to: { commit: proposed.commit, label: "proposto" }, paths: [...scope.keys()] }, deps.local!.git);
    known = new Set(all.files.filter(f => f.atTo).map(f => f.path));
  }
  const editScope = [...scope.entries()].map(([path, c]) => ({ path, action: (!c.edit ? "consultar" : known ? (known.has(path) ? "alterar" : "criar") : "a confirmar") as DeveloperPreview["editScope"][number]["action"], from: [...c.from] }));
  const others = plan.tasks.filter(t => t.id !== task!.id && !closure.some(c => c.task.id === t.id));
  return {
    generatedAt: new Date().toISOString(),
    notice: DEVELOPER_PREVIEW_NOTICE,
    demand: { title: snap.demand.title, description: snap.demand.description, acceptanceCriteria: snap.demand.acceptanceCriteria, ...(snap.demand.project ? { project: snap.demand.project } : {}) },
    plan: { runId: parent!.id, connection: parent!.connection, objective: plan.objective_summary, flowType: plan.flow.type },
    task: task!, eligible: blockers.length === 0, blockers, tasks: rows, analyses,
    base: {
      proposed, head, sinceAnalyses,
      note: "Proposta para a futura revisão do Desenvolvedor: a escolha final do commit será sua, na revisão daquele envio. O projeto na sua pasta não é tocado.",
    },
    unverified,
    editScope,
    outOfScope: [
      ...others.map(t => `${t.id} · ${t.title} (${nameOf(t.assignee)})`),
      "Arquivos citados pelas análises para outras tarefas (por exemplo, o botão da janela) ficam para a tarefa correspondente.",
      "Publicar, fazer push, abrir pull request ou deploy.",
    ],
    future: [
      "Revisão e aprovação explícitas suas, como no envio ao Arquiteto, com o commit de base escolhido por você.",
      "Cópia de trabalho isolada no commit de base, em pasta temporária do executor, sem credencial de push; a sua pasta não é alterada.",
      "Permissão de escrita restrita a essa cópia e a um conjunto fechado de comandos de verificação, com limite de tempo e de saída.",
      "Resultado entregue como diff e saída real dos comandos, para o QA; nada é mesclado ou publicado sem outra aprovação sua.",
    ],
  };
}

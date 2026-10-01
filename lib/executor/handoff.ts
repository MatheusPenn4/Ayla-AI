// Hand-off of ONE task of a Director plan to the Architect, in two steps:
// 1. prepare: the executor checks everything against its own records (the
//    browser only names the plan run and the task id, sends the Architect's
//    saved sheet and, for a follow-up, how each earlier question was resolved
//    and which source/commit to read), reads the sources, builds the exact
//    prompt and stores it frozen as a run in "awaiting_approval". Nothing runs.
// 2. approve: the user confirms that exact prompt (by its hash); only then the
//    run is queued. See service.ts.
// Earlier hand-offs are never modified: a follow-up is a new run linked by
// previous_run_id, with an explicit context revision (commit and source).
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { buildArchitectMessage, buildArchitectSystem } from "@/lib/engine/architect-prompt";
import { ANALYSIS_JSON_SCHEMA } from "@/lib/engine/analysis-schema";
import { HANDOFF_TARGETS, type ArchitectSnapshot, type Clarification, type ContextRevision, type DependencyAnalysis, type DirectorSnapshot, type HandoffTask, type PlanExcerpt, type RunBudget, type RunRecord, type SourceComparison, type SourceContext, type TeamMemberInput } from "@/lib/engine/types";
import { ARCHITECT_GITHUB_LIMITS, GithubError, extractFileRefs, extractPathMentions, readGithubContext, shrinkGithubText, type RequestedFile } from "./github";
import { compareLocalCommits, listLocalRepos, readLocalGitContext, type GitDeps } from "./local-git";
import { estimateTokens } from "./planner";
import { getProject } from "./projects";
import { MemberZ } from "./runs-service";
import type { NewRun, RunStore } from "./store";

const hex40 = z.string().regex(/^[0-9a-f]{40}$/, "commit deve ter 40 caracteres hexadecimais");
const fileRef = z.string().max(240).regex(/^[A-Za-z0-9_.@\[\]/-]+(#[A-Za-z0-9_$]+)?$/, "use caminho ou caminho#Símbolo").refine(v => !v.includes(".."), "caminho inválido");

export const HandoffZ = z.object({
  idempotencyKey: z.string().regex(/^[A-Za-z0-9:_-]{8,120}$/),
  directorRunId: z.string().uuid(),
  taskId: z.string().min(1).max(64),
  /** The Architect's saved sheet (configuration only; it cannot change who runs or what task). */
  agent: MemberZ,
  previousRunId: z.string().uuid().optional(),
  /** The user's own answers, question by question (question text must match the earlier run exactly). */
  answers: z.array(z.object({ question: z.string().max(2000), answer: z.string().trim().min(1).max(4000) })).max(10).optional(),
  /** Questions to resolve by reading files of the repository (the Architect answers from the content). */
  technical: z.array(z.object({ question: z.string().max(2000), files: z.array(fileRef).min(1).max(4) })).max(10).optional(),
  /** Extra decisions the user states for this hand-off. */
  decisions: z.array(z.object({ topic: z.string().trim().min(1).max(300), answer: z.string().trim().min(1).max(2000) })).max(5).optional(),
  /** Source to read. Default: the same GitHub commit the Director read. */
  source: z.object({ via: z.enum(["github", "local_git"]), commit: hex40 }).optional(),
  /** Required when the source/commit differs from the previous hand-off of the task. */
  revisionReason: z.string().trim().max(500).optional(),
  /** Files the user confirmed for reading (path or path#Symbol); when present, the path heuristic is not used. */
  files: z.array(fileRef).max(12).optional(),
});
export type HandoffRequest = z.infer<typeof HandoffZ>;

export class HandoffRefused extends Error {
  constructor(public status: number, public code: string, message: string, public details?: string[]) { super(message); }
}
const refuse = (status: number, code: string, message: string, details?: string[]): never => { throw new HandoffRefused(status, code, message, details); };

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** Hash the user confirms: covers the exact prompt, context, sheet, task and settings. */
export function handoffHash(x: { snapshot: ArchitectSnapshot; prompt: { system: string; user: string }; context: SourceContext; connection: string; model: string; effort: string }) {
  return sha256(JSON.stringify([x.snapshot, x.prompt, x.context, x.connection, x.model, x.effort]));
}

/** What the executor lets this Architect run do (enforced by client flags and the empty working folder, not by the prompt). */
export function architectTools(agent: TeamMemberInput, hasRepo: boolean, connection: string, via: "github" | "local_git" = "github"): ArchitectSnapshot["tools"] {
  const readsRepo = hasRepo && (agent.tools.read !== false || agent.tools.github === true);
  return [
    { label: "Ler arquivos do repositório", allowed: readsRepo, how: readsRepo ? (via === "local_git" ? "Feita pelo executor antes da chamada, na cópia local autorizada, só com leitura de objetos do Git (commit fixo, sem checkout, sem alterações não commitadas), com limites; o modelo recebe o texto e não acessa a pasta." : "Feita pelo executor antes da chamada, só em repositório público, no commit fixo, com limites; o modelo recebe o texto e não acessa o repositório.") : hasRepo ? "Desligada: a permissão “Ler arquivos” está desligada na ficha do Arquiteto." : "Sem repositório GitHub na demanda." },
    { label: "Editar arquivos", allowed: false, how: connection === "codex" ? "Bloqueada: Codex em sandbox somente leitura, ferramentas de shell desligadas, pasta de trabalho vazia." : connection.startsWith("api:") ? "Bloqueada: conexão de API, sem nenhuma ferramenta de arquivo nesta versão (uma única chamada, só texto estruturado)." : "Bloqueada: Claude Code sem ferramentas (--tools \"\"), permissões negadas (dontAsk), pasta de trabalho vazia." },
    { label: "Terminal / comandos", allowed: false, how: "Bloqueado pelo executor, mesmo que esteja planejado na ficha." },
    { label: "Navegador e busca na web", allowed: false, how: "Bloqueados pelo executor." },
    { label: "Publicar, fazer push ou abrir pull request", allowed: false, how: "Impossível: o cliente não recebe o repositório nem credencial do GitHub." },
  ];
}

export type PrepareDeps = {
  store: RunStore;
  github: { fetch?: typeof fetch; token?: string; apiBase?: string; rawBase?: string };
  /** Local clones authorized for reading (AYLA_LOCAL_REPOS) and how to run git. */
  local?: { dirs: string[]; git: GitDeps };
  /** Authorized projects (AYLA_LOCAL_REPOS + Configurações → Projetos locais) — QA resolves the tested version here. */
  projects?: import("./projects").ProjectDeps;
  /** How the isolated QA environment would be built (tool detection at prepare time). */
  envDeps?: import("./qa-env").EnvDeps;
};

const cap = <T,>(items: T[], n: number) => ({ items: items.slice(0, n), omitted: Math.max(0, items.length - n) });
const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
const FILE_REF = /^[A-Za-z0-9_.@[\]/-]+(#[A-Za-z0-9_$]+)?$/;

/** Bounded excerpt of a concluded analysis, for the collaborator whose task depends on it. */
export async function dependencyAnalysis(store: RunStore, run: RunRecord): Promise<DependencyAnalysis | null> {
  const a = run.analysis;
  if (!a || run.status !== "analysis_ready") return null;
  const snap = (await store.snapshot(run.id)) as ArchitectSnapshot | null;
  const ctx = run.context?.kind === "github" ? run.context : null;
  const guidance = cap(a.developer_guidance.map(x => clip(x, 260)), 8);
  const risks = cap(a.risks.map(x => clip(`${x.risk}${x.mitigation ? ` — mitigação: ${x.mitigation}` : ""}`, 260)), 4);
  const assumptions = cap(a.assumptions.map(x => clip(x, 240)), 4);
  const notVerified = cap(a.not_verified.map(x => clip(x, 240)), 4);
  const examined = cap(a.examined.map(e => ({ ref: clip(e.ref, 160), basis: e.basis })), 12);
  return {
    runId: run.id, revision: snap?.revision?.number ?? null, commit: ctx?.commit ?? null, via: ctx ? (ctx.via ?? "github") : null,
    understanding: clip(a.technical_understanding, 400),
    recommendation: { summary: clip(a.recommendation.summary, 700), rationale: clip(a.recommendation.rationale, 500) },
    guidance: guidance.items, risks: risks.items, assumptions: assumptions.items, notVerified: notVerified.items, examined: examined.items,
    decisions: snap?.decisions ?? [],
    omitted: { guidance: guidance.omitted, risks: risks.omitted, assumptions: assumptions.omitted, notVerified: notVerified.omitted, examined: examined.omitted },
  };
}

/**
 * Files worth reading for a task, taken from the analyses it depends on: what they examined (read or
 * inferred) and the paths they list as not verified or cite in their guidance. A suggestion only: the
 * user confirms the list when preparing, and the executor reads only what exists at the chosen commit.
 */
export function suggestFiles(deps: { taskId: string; analysis: DependencyAnalysis }[], known?: Set<string>) {
  const out: { ref: string; reason: string }[] = [];
  const add = (ref: string, reason: string) => {
    if (!FILE_REF.test(ref) || ref.includes("..")) return;
    const path = ref.split("#")[0];
    if (known && !known.has(path)) return;
    if (!out.some(x => x.ref === ref)) out.push({ ref, reason });
  };
  for (const d of deps) {
    const id = `${d.taskId} (${d.analysis.runId.slice(0, 8)})`;
    for (const e of d.analysis.examined) add(e.ref.trim(), e.basis === "read" ? `lido na análise de ${id}` : `inferido (não lido) na análise de ${id}`);
    for (const t of d.analysis.notVerified) for (const m of extractFileRefs(t)) add(m, `citado como não verificado na análise de ${id}`);
    for (const t of [...d.analysis.assumptions, ...d.analysis.guidance]) for (const m of extractFileRefs(t)) add(m, `citado na análise de ${id}`);
  }
  // A bare path adds nothing when the same file is already asked for by symbol (it would only widen the excerpt).
  return out.filter(x => x.ref.includes("#") || !out.some(y => y.ref.startsWith(`${x.ref}#`))).slice(0, 24);
}

/** Concluded analyses of the tasks this one depends on (direct dependencies). */
async function dependencyRuns(store: RunStore, planRunId: string, plan: NonNullable<RunRecord["result"]>, task: HandoffTask) {
  const out: { task: HandoffTask; run: RunRecord; analysis: DependencyAnalysis }[] = [];
  for (const depId of task.depends_on) {
    const dep = plan.tasks.find(t => t.id === depId);
    if (!dep) continue;
    const done = (await store.runsForTask(planRunId, dep.id)).find(r => r.status === "analysis_ready");
    const analysis = done ? await dependencyAnalysis(store, done) : null;
    if (done && analysis) out.push({ task: dep, run: done, analysis });
  }
  return out;
}

/** Compares the chosen commit with the Director's commit and with each dependency analysis commit (local clone only). */
async function compareWith(local: PrepareDeps["local"], owner: string, repo: string, to: { commit: string; label: string }, froms: { commit: string; label: string }[], paths: string[]): Promise<SourceComparison[]> {
  if (!local?.dirs.length) return [];
  const repos = await listLocalRepos(local.dirs, local.git);
  const r = repos.find(x => x.owner.toLowerCase() === owner.toLowerCase() && x.repo.toLowerCase() === repo.toLowerCase());
  if (!r) return [];
  const seen = new Set<string>();
  const out: SourceComparison[] = [];
  for (const f of froms) {
    if (seen.has(f.commit)) continue;
    seen.add(f.commit);
    out.push(await compareLocalCommits({ dir: r.dir, from: f, to, paths }, local.git));
  }
  return out;
}

export type SourceOptions = {
  directorCommit: string | null;
  owner: string | null; repo: string | null;
  dependencies: { taskId: string; runId: string; revision: number | null; commit: string | null; via: "github" | "local_git" | null }[];
  localRepos: { dirName: string; head: string; headSubject: string }[];
  /** Proposal: the commit of the most recent dependency analysis, else the Director's commit. */
  proposed: { via: "github" | "local_git"; commit: string; why: string } | null;
  suggestedFiles: { ref: string; reason: string }[];
  comparisons: SourceComparison[];
  /** Latest hand-off of this task (a retry starts from its commit and files; it is never modified). */
  previous: { runId: string; status: string; revision: number | null; commit: string | null; via: "github" | "local_git" | null; files: string[] } | null;
};

/** What the user needs to choose the source of a first hand-off (read-only: nothing is recorded, no model is called). */
export async function sourceOptions(q: { directorRunId: string; taskId: string }, deps: PrepareDeps): Promise<SourceOptions> {
  const parent = await deps.store.get(q.directorRunId);
  if (!parent || parent.kind !== "director_plan" || !parent.result) refuse(404, "plan_not_found", "Plano do Diretor não encontrado ou não concluído.");
  const task = parent!.result!.tasks.find(t => t.id === q.taskId);
  if (!task) refuse(404, "task_not_found", `A tarefa "${q.taskId}" não existe neste plano do Diretor.`);
  const ctx = (await deps.store.detail(parent!.id))?.context;
  const gh = ctx?.kind === "github" ? ctx : null;
  const deps_ = await dependencyRuns(deps.store, parent!.id, parent!.result!, task!);
  const repos = deps.local?.dirs.length && gh ? (await listLocalRepos(deps.local.dirs, deps.local.git)).filter(r => r.owner.toLowerCase() === gh.owner.toLowerCase() && r.repo.toLowerCase() === gh.repo.toLowerCase()) : [];
  const latestDep = deps_.filter(d => d.analysis.commit).sort((a, b) => (b.run.finishedAt ?? "").localeCompare(a.run.finishedAt ?? ""))[0];
  const proposed = latestDep?.analysis.commit
    ? { via: (latestDep.analysis.via ?? "github") as "github" | "local_git", commit: latestDep.analysis.commit, why: `Commit em que foi feita a análise de ${latestDep.task.id} (${latestDep.run.id.slice(0, 8)}), da qual esta tarefa depende.` }
    : gh ? { via: (gh.via ?? "github") as "github" | "local_git", commit: gh.commit, why: "Commit que o Diretor leu." } : null;
  const suggestedFiles = suggestFiles(deps_.map(d => ({ taskId: d.task.id, analysis: d.analysis })));
  const paths = [...new Set(suggestedFiles.map(f => f.ref.split("#")[0]))];
  const comparisons: SourceComparison[] = [];
  if (gh && repos.length) {
    const froms = [{ commit: gh.commit, label: "commit do Diretor" }, ...deps_.filter(d => d.analysis.commit).map(d => ({ commit: d.analysis.commit!, label: `análise de ${d.task.id}` }))];
    const tos = [...new Map([...(proposed ? [[proposed.commit, "proposto"]] : []), [repos[0].head, "HEAD da cópia local"]] as [string, string][]).entries()];
    for (const [commit, label] of tos) comparisons.push(...(await compareWith(deps.local, gh.owner, gh.repo, { commit, label }, froms.filter(f => f.commit !== commit), paths)));
  }
  const last = (await deps.store.runsForTask(parent!.id, task!.id))[0] ?? null;
  const lastSnap = last ? ((await deps.store.snapshot(last.id)) as ArchitectSnapshot | null) : null;
  const lastCtx = last?.context?.kind === "github" ? last.context : null;
  const previous = last ? { runId: last.id, status: last.status, revision: lastSnap?.revision?.number ?? null, commit: lastCtx?.commit ?? null, via: lastCtx ? (lastCtx.via ?? "github") : null, files: (lastSnap?.revision?.requestedFiles ?? []).map(x => x.ref) } : null;
  return {
    directorCommit: gh?.commit ?? null, owner: gh?.owner ?? null, repo: gh?.repo ?? null, previous,
    dependencies: deps_.map(d => ({ taskId: d.task.id, runId: d.run.id, revision: d.analysis.revision, commit: d.analysis.commit, via: d.analysis.via })),
    localRepos: repos.map(r => ({ dirName: r.dirName, head: r.head, headSubject: r.headSubject })),
    proposed, suggestedFiles, comparisons,
  };
}

/** Validates the hand-off against the executor's records and freezes what will be sent. */
export async function prepareHandoff(req: HandoffRequest, deps: PrepareDeps): Promise<{ run: RunRecord; created: boolean }> {
  const { store } = deps;
  const parent = await store.get(req.directorRunId);
  if (!parent || parent.kind !== "director_plan") refuse(404, "plan_not_found", "Execução do Diretor não encontrada.");
  if (parent!.status !== "plan_ready" || !parent!.result) refuse(409, "plan_not_ready", "Só é possível encaminhar tarefas de um plano pronto do Diretor.");
  const plan = parent!.result!;
  const task = plan.tasks.find(t => t.id === req.taskId);
  if (!task) refuse(404, "task_not_found", `A tarefa "${req.taskId}" não existe neste plano do Diretor.`);
  if (!HANDOFF_TARGETS.includes(task!.assignee as (typeof HANDOFF_TARGETS)[number])) refuse(409, "not_architect_task", `A tarefa ${task!.id} foi atribuída a "${task!.assignee}", não ao Arquiteto. Nesta fase só o Arquiteto recebe encaminhamentos.`);
  if (req.agent.id !== task!.assignee) refuse(400, "agent_mismatch", "A ficha enviada não é a do responsável pela tarefa.");
  if (req.agent.connection === "none") refuse(400, "no_connection", "Escolha a conexão do Arquiteto na ficha dele (aba Perfil): Claude via Claude Code ou ChatGPT Business via Codex.");

  // Already sent? One open hand-off per task; a finished analysis is never redone.
  const existing = await store.runsForTask(parent!.id, task!.id);
  const open = existing.find(r => ["awaiting_approval", "queued", "planning"].includes(r.status));
  if (open) return { run: open, created: false };
  if (existing.some(r => r.status === "analysis_ready")) refuse(409, "already_done", `A tarefa ${task!.id} já tem uma análise concluída do Arquiteto.`);
  const waiting = existing.find(r => r.status === "awaiting_clarification");
  if (req.previousRunId && !existing.some(r => r.id === req.previousRunId)) refuse(400, "invalid_previous_run", "A execução anterior informada não é um envio desta tarefa.");
  if (waiting && req.previousRunId !== waiting.id) refuse(409, "awaiting_answers", "O Arquiteto está aguardando esclarecimento nesta tarefa. Resolva as perguntas da análise para preparar um novo envio.");
  const previous = req.previousRunId ? (await store.detail(req.previousRunId))! : existing[0] ? (await store.detail(existing[0].id)) : null;

  // Clarifications: each earlier question resolved exactly once, by the user or by reading.
  const clarifications: Clarification[] = [];
  const requested: RequestedFile[] = [];
  if (waiting) {
    const asked = waiting.analysis?.questions.map(q => q.question) ?? [];
    const answers = req.answers ?? [], technical = req.technical ?? [];
    const unknown = [...answers.map(a => a.question), ...technical.map(t => t.question)].filter(q => !asked.includes(q));
    if (unknown.length) refuse(400, "unknown_question", "Há respostas para perguntas que o Arquiteto não fez nesta execução.", unknown.map(q => clip(q, 160)));
    const twice = asked.filter(q => answers.some(a => a.question === q) && technical.some(t => t.question === q));
    if (twice.length) refuse(400, "question_twice", "Cada pergunta deve ser resolvida de um único jeito (sua resposta ou leitura).", twice.map(q => clip(q, 160)));
    const missing = asked.filter(q => !answers.some(a => a.question === q) && !technical.some(t => t.question === q));
    if (missing.length) refuse(400, "unanswered_questions", "Resolva todas as perguntas da análise anterior antes de reenviar.", missing.map(q => clip(q, 160)));
    asked.forEach((q, i) => {
      const t = technical.find(x => x.question === q);
      if (t) for (const f of t.files) requested.push({ ref: f, reason: `pedido para resolver a pergunta ${i + 1} por leitura` });
    });
  } else if (req.answers?.length || req.technical?.length) {
    refuse(400, "nothing_to_answer", "Não há perguntas pendentes do Arquiteto nesta tarefa.");
  }

  // Dependencies: every task this one depends on must be done by someone who can run in this phase.
  const dependsOn: PlanExcerpt["dependsOn"] = [];
  const blockers: string[] = [];
  for (const depId of task!.depends_on) {
    const dep = plan.tasks.find(t => t.id === depId);
    if (!dep) continue;
    if (!HANDOFF_TARGETS.includes(dep.assignee as (typeof HANDOFF_TARGETS)[number])) { blockers.push(`${dep.id} (${dep.assignee}) ainda não executa nesta fase`); continue; }
    const done = (await store.runsForTask(parent!.id, dep.id)).find(r => r.status === "analysis_ready");
    if (!done) { blockers.push(`${dep.id} precisa antes de uma análise concluída do Arquiteto`); continue; }
    dependsOn.push({ id: dep.id, title: dep.title, assignee: dep.assignee, analysisSummary: done.analysis?.recommendation.summary ?? null, analysisRunId: done.id, analysis: await dependencyAnalysis(store, done) });
  }
  if (blockers.length) refuse(409, "dependency_pending", `A tarefa ${task!.id} depende de outras ainda não concluídas.`, blockers);

  // Files the user confirmed when preparing (usually suggested from the analyses this task depends on).
  const suggested = suggestFiles(dependsOn.filter(d => d.analysis).map(d => ({ taskId: d.id, analysis: d.analysis! })));
  const confirmedFiles = [...new Set(req.files ?? [])].map(ref => ({ ref, reason: suggested.find(s => s.ref === ref)?.reason ?? "indicado por você no preparo do envio" }));
  for (const f of confirmedFiles) if (!requested.some(r => r.ref === f.ref)) requested.push(f);

  const pSnap = (await store.snapshot(parent!.id)) as DirectorSnapshot;
  const pDetail = (await store.detail(parent!.id))!;
  const directorCtx = pDetail.context;
  // The plan is summarised, not repeated: at most 6 items per list, with a count of what was left in the Director run.
  const risks = cap(plan.risks.map(r => clip(r, 220)), 4), assumptions = cap(plan.assumptions.map(r => clip(r, 220)), 4), notVerified = cap(plan.not_verified.map(r => clip(r, 220)), 4);
  const excerpt: PlanExcerpt = {
    directorRunId: parent!.id, directorConnection: parent!.connection,
    objective_summary: plan.objective_summary, flow: { type: plan.flow.type, rationale: plan.flow.rationale },
    step: plan.steps.find(s => s.id === task!.step_id) ?? null,
    dependsOn,
    dependents: plan.tasks.filter(t => t.depends_on.includes(task!.id)).map(t => ({ id: t.id, title: t.title, assignee: t.assignee })),
    risks: risks.items, assumptions: assumptions.items, not_verified: notVerified.items,
    omitted: { risks: risks.omitted, assumptions: assumptions.omitted, not_verified: notVerified.omitted },
    directorFiles: directorCtx?.kind === "github" ? directorCtx.files.map(f => ({ path: f.path, bytes: f.bytes, truncated: f.truncated })) : [],
    directorCommit: directorCtx?.kind === "github" ? directorCtx.commit : null,
  };

  // Source and commit: explicit. Default = what the Director read; any change is a recorded revision.
  const prevCtx = previous?.context?.kind === "github" ? previous.context : null;
  const prevCommit = prevCtx?.commit ?? excerpt.directorCommit;
  const prevVia = prevCtx ? (prevCtx.via ?? "github") : directorCtx?.kind === "github" ? (directorCtx.via ?? "github") : null;
  const want = req.source ?? (prevCommit ? { via: (prevVia ?? "github") as "github" | "local_git", commit: prevCommit } : undefined);
  const changedCommit = !!want && !!prevCommit && (want.commit !== prevCommit || want.via !== prevVia);
  if (changedCommit && !req.revisionReason) refuse(400, "revision_reason_required", "Informe o motivo da troca de commit ou de fonte; ela fica registrada na nova revisão.");
  if (want && directorCtx?.kind !== "github") refuse(400, "no_repository", "Esta demanda não tem repositório GitHub; não há commit para escolher.");

  const agent = req.agent;
  const demand = pSnap.demand;
  const tools = architectTools(agent, directorCtx?.kind === "github", agent.connection, want?.via ?? "github");
  let context: SourceContext = directorCtx?.kind === "folder" ? directorCtx : { kind: "none", note: "Demanda sem fonte de projeto." };
  let sourceText = "";
  if (directorCtx?.kind === "github" && want) {
    if (!tools[0].allowed) {
      context = { kind: "none", note: "Leitura do repositório desligada na ficha do Arquiteto: nenhum arquivo foi enviado." };
      if (requested.length) refuse(400, "reading_disabled", "Há perguntas marcadas para resolver por leitura, mas a leitura está desligada na ficha do Arquiteto.");
    } else {
      const taskText = [task!.title, task!.scope, task!.inputs, task!.deliverable, ...task!.acceptance_criteria].join("\n");
      const keywords = [...new Set(`${taskText}\n${excerpt.step?.title ?? ""}\n${demand.title}\n${(req.decisions ?? []).map(d => d.answer).join(" ")}`.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").split(/[^a-z0-9_-]+/))];
      try {
        if (want.via === "local_git") {
          if (!deps.local?.dirs.length) refuse(403, "local_not_authorized", "Nenhuma cópia local do repositório está autorizada para leitura (AYLA_LOCAL_REPOS).");
          // A Director that read an authorized project (demand source "Projeto local autorizado") keeps reading that same project, by id.
          const pid = directorCtx.local?.projectId;
          const byId = pid && deps.projects ? await getProject(pid, deps.projects) : null;
          const repos = byId && !byId.problem ? [{ dir: byId.dir, owner: directorCtx.owner, repo: directorCtx.repo }] : await listLocalRepos(deps.local!.dirs, deps.local!.git);
          const repo = repos.find(r => r.owner.toLowerCase() === directorCtx.owner.toLowerCase() && r.repo.toLowerCase() === directorCtx.repo.toLowerCase());
          if (!repo) refuse(403, "local_not_authorized", pid ? "O projeto local que o Diretor leu não está mais autorizado no executor." : `Nenhuma cópia local autorizada corresponde a ${directorCtx.owner}/${directorCtx.repo}.`);
          const r = await readLocalGitContext({ dir: repo!.dir, owner: directorCtx.owner, repo: directorCtx.repo, commit: want.commit, baseCommit: excerpt.directorCommit, keywords, mentions: extractPathMentions(taskText), requested }, deps.local!.git);
          if (r.context.local?.isDescendant !== true) refuse(409, "commit_not_descendant", `O commit ${want.commit.slice(0, 12)} não descende do commit ${excerpt.directorCommit?.slice(0, 12)} que o Diretor leu; use um commit da mesma história.`);
          context = r.context; sourceText = r.text;
        } else {
          const r = await readGithubContext({ owner: directorCtx.owner, repo: directorCtx.repo, branch: directorCtx.branch, commit: want.commit, keywords, limits: ARCHITECT_GITHUB_LIMITS, selection: "architect", mentions: extractPathMentions(taskText), requested }, deps.github);
          context = r.context; sourceText = r.text;
        }
      } catch (err) {
        if (err instanceof GithubError) refuse(502, err.code, err.message);
        throw err;
      }
    }
  }

  // How each earlier question was resolved (the user's answers stay marked as the user's).
  if (waiting) {
    const readPaths = context.kind === "github" ? context.files.map(f => f.path) : [];
    for (const q of waiting.analysis?.questions ?? []) {
      const a = req.answers?.find(x => x.question === q.question);
      if (a) { clarifications.push({ question: q.question, askedIn: waiting.id, resolution: { by: "user", answer: a.answer } }); continue; }
      const t = req.technical!.find(x => x.question === q.question)!;
      const paths = [...new Set(t.files.map(f => f.split("#")[0]))];
      clarifications.push({ question: q.question, askedIn: waiting.id, resolution: { by: "reading", requested: t.files, readFiles: paths.filter(p => readPaths.includes(p)), missing: paths.filter(p => !readPaths.includes(p)), commit: context.kind === "github" ? context.commit : "" } });
    }
  }
  // The previous analysis is referenced, not repeated. Its provisional recommendation is only resent when the
  // commit did not change: made on another commit, it would push the Architect towards an outdated conclusion.
  const prevAnalysisCommit = waiting?.context?.kind === "github" ? waiting.context.commit : null;
  const sameCommitAsWaiting = !!prevAnalysisCommit && context.kind === "github" && context.commit === prevAnalysisCommit;
  const previousAnalysis = waiting?.analysis ? {
    runId: waiting.id,
    commit: prevAnalysisCommit,
    understanding: clip(waiting.analysis.technical_understanding, 300),
    provisional: sameCommitAsWaiting ? clip(waiting.analysis.recommendation.summary, 600) : "",
  } : null;
  const revision: ContextRevision = {
    // Every earlier attempt of this task counts (a failed or discarded revision keeps its number).
    number: Math.max(0, ...(await Promise.all(existing.map(async r => ((await store.snapshot(r.id)) as ArchitectSnapshot | null)?.revision?.number ?? 1)))) + 1,
    previousRunId: previous?.id ?? null, previousCommit: prevCommit ?? null, previousVia: prevVia,
    commit: context.kind === "github" ? context.commit : null, via: context.kind === "github" ? (context.via ?? "github") : null,
    changedCommit, reason: req.revisionReason || (waiting ? "Esclarecimento das perguntas da análise anterior." : previous ? "Novo envio após falha ou cancelamento." : "Primeiro envio."),
  };
  if (confirmedFiles.length) revision.requestedFiles = confirmedFiles;
  // A local commit is compared, file by file, with the Director's commit and with the commits of the analyses it builds on.
  if (context.kind === "github" && context.via === "local_git") {
    const c = context;
    const froms = [
      ...(excerpt.directorCommit ? [{ commit: excerpt.directorCommit, label: "commit do Diretor" }] : []),
      ...dependsOn.filter(d => d.analysis?.commit).map(d => ({ commit: d.analysis!.commit!, label: `análise de ${d.id}` })),
    ].filter(f => f.commit !== c.commit);
    const cmp = await compareWith(deps.local, c.owner, c.repo, { commit: c.commit, label: "commit deste envio" }, froms, [...new Set(requested.map(r => r.ref.split("#")[0]))]);
    if (cmp.length) revision.comparisons = cmp;
  }
  const others = plan.tasks.filter(t => t.id !== task!.id);
  const scope = {
    asked: [`Análise técnica da tarefa ${task!.id} (${task!.title}), com o entregável: ${task!.deliverable}`, "Separar o que foi lido do que foi inferido; orientar o Desenvolvedor; recomendar checagens ao QA."],
    outOfScope: [
      "Implementar, editar arquivos, rodar comandos ou testes (nada disso é possível nesta execução).",
      others.length ? `As demais tarefas do plano (${others.map(t => t.id).join(", ")}), que não são desta análise.` : "Outras tarefas.",
      "Decisões de produto que você não tomou: registre-as como pergunta, não como decisão.",
    ],
  };

  const system = buildArchitectSystem(agent);
  const team = pSnap.team;
  const decisions = req.decisions?.length ? req.decisions : [];
  const build = () => buildArchitectMessage({ demand, task: task!, plan: excerpt, team, context, sourceText, revision, clarifications, decisions, previousAnalysis, scope });
  let user = build();
  const schemaText = JSON.stringify(ANALYSIS_JSON_SCHEMA);
  let estimate = estimateTokens(system + user + schemaText);
  const budgetTokens = Math.max(0, Math.floor(agent.budget));
  // Reduce repository text when it would take most of the sheet budget: least relevant files first,
  // files requested to resolve a question are the most relevant and go last (documented in docs/executor-local.md).
  for (let i = 0; i < 3 && context.kind === "github" && budgetTokens > 0 && estimate > budgetTokens * 0.6; i++) {
    const protect = new Set(requested.map(r => r.ref.split("#")[0]));
    const shrunk = shrinkGithubText(context, sourceText, Math.floor(sourceText.length * 0.75), "priority", protect);
    if (shrunk.ctx.files.length === context.files.length) break;
    context = shrunk.ctx; sourceText = shrunk.text;
    for (const c of clarifications) if (c.resolution.by === "reading") { const kept = context.files.map(f => f.path); c.resolution.missing.push(...c.resolution.readFiles.filter(p => !kept.includes(p))); c.resolution.readFiles = c.resolution.readFiles.filter(p => kept.includes(p)); }
    user = build();
    estimate = estimateTokens(system + user + schemaText);
  }

  const snapshot: ArchitectSnapshot = { kind: "architect_task", agent, team, demand, task: task!, plan: excerpt, tools, answers: null, revision, clarifications, decisions, previousAnalysis, scope };
  const prompt = { system, user };
  const budget: RunBudget = { sheetTokens: budgetTokens, estimatedInputTokens: estimate, calls: [], reportedTotalTokens: null, exceeded: false };
  const nr: NewRun = {
    id: randomUUID(), kind: "architect_task", demandId: demand.id, agentId: agent.id, idempotencyKey: req.idempotencyKey,
    connection: agent.connection as NewRun["connection"], model: agent.modelName.trim(), effort: agent.effort.trim(),
    snapshotHash: handoffHash({ snapshot, prompt, context, connection: agent.connection, model: agent.modelName.trim(), effort: agent.effort.trim() }),
    snapshot, budget, previousRunId: previous?.id ?? null, parentRunId: parent!.id, taskId: task!.id,
    initialStatus: "awaiting_approval", prompt, context,
  };
  const res = await store.create(nr);
  if (res.created) {
    await store.event(res.run.id, "prepared", `Tarefa ${task!.id} do plano ${parent!.id.slice(0, 8)} preparada para o Arquiteto (revisão ${revision.number}): ${context.kind === "github" ? `${context.files.length} arquivo(s) do commit ${context.commit.slice(0, 12)}${context.via === "local_git" ? " (cópia local)" : ""}` : "sem arquivos do repositório"}, cerca de ${estimate} tokens de texto (estimativa).`, { files: context.kind === "github" ? context.files.map(f => f.path) : [] });
    if (changedCommit) await store.event(res.run.id, "context_revision", `Revisão de contexto: commit ${prevCommit?.slice(0, 12)} (${prevVia}) → ${want!.commit.slice(0, 12)} (${want!.via}). Motivo: ${revision.reason}. ${previous ? `O envio anterior (${previous.id.slice(0, 8)}) não foi alterado.` : "Primeiro envio desta tarefa: o commit anterior é o que o Diretor leu; o plano do Diretor não foi alterado."}${revision.comparisons?.length ? ` Comparação: ${revision.comparisons.map(c => `${c.from.label} ${c.from.commit.slice(0, 12)} → ${c.to.commit.slice(0, 12)}: ${c.files.filter(f => !f.atFrom && f.atTo).length} arquivo(s) pedido(s) inexistente(s) antes, ${c.files.filter(f => f.changed).length} alterado(s)`).join("; ")}.` : ""}`, { comparisons: revision.comparisons ?? [] });
    if (confirmedFiles.length) await store.event(res.run.id, "requested_files", `${confirmedFiles.length} arquivo(s) confirmado(s) por você para leitura: ${confirmedFiles.map(f => f.ref).join(", ")}.`, { files: confirmedFiles });
    if (clarifications.length) await store.event(res.run.id, "clarifications", `${clarifications.filter(c => c.resolution.by === "user").length} resposta(s) sua(s) e ${clarifications.filter(c => c.resolution.by === "reading").length} dúvida(s) resolvida(s) por leitura, vinculadas às perguntas da execução ${waiting!.id.slice(0, 8)}.`);
    if (budgetTokens > 0 && estimate >= budgetTokens) await store.event(res.run.id, "budget_alert", `Alerta: a estimativa do texto (${estimate}) já passa do orçamento da ficha do Arquiteto (${budgetTokens}). O orçamento é referência; a execução só começa se você confirmar.`);
  }
  return res;
}

// Hand-off of ONE Developer task, in the same two steps as the Architect's:
// 1. prepare: validates against the executor's own records, resolves the
//    approved edit scope and freezes the exact prompt as "awaiting_approval".
//    NOTHING is materialized here — no working copy is built, no model is
//    called. The working copy is built only inside the planner, at approval
//    time (lib/executor/planner.ts#developerSpec), and only for that one run.
// 2. approve: the user confirms that exact prompt (by its hash); only then
//    the run is queued and the isolated copy gets built.
// Earlier hand-offs are never modified: a follow-up is a new run linked by
// previous_run_id, with an explicit context revision (commit).
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { buildDeveloperMessage, buildDeveloperSystem } from "@/lib/engine/developer-prompt";
import { DEVELOPER_JSON_SCHEMA } from "@/lib/engine/developer-schema";
import { DEVELOPER_ASSIGNEE, type ContextRevision, type DeveloperSnapshot, type DeveloperTool, type DirectorSnapshot, type EditScopeEntry, type RunBudget, type RunRecord, type SourceContext } from "@/lib/engine/types";
import { developerPreview } from "./developer-preview";
import { GithubError } from "./github";
import { HandoffRefused, type PrepareDeps } from "./handoff";
import { compareLocalCommits, listLocalRepos, listTreeEntries } from "./local-git";
import { estimateTokens } from "./planner";
import { MemberZ } from "./runs-service";
import type { NewRun, RunStore } from "./store";

const refuse = (status: number, code: string, message: string, details?: string[]): never => { throw new HandoffRefused(status, code, message, details); };
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

export const DeveloperHandoffZ = z.object({
  idempotencyKey: z.string().regex(/^[A-Za-z0-9:_-]{8,120}$/),
  directorRunId: z.string().uuid(),
  taskId: z.string().min(1).max(64),
  /** The Developer's saved sheet (configuration only; it cannot change who runs or what task). */
  agent: MemberZ,
  /** Commit to work on. Default: the base the executor proposes (the nearest dependency analysis' commit). */
  source: z.object({ commit: z.string().regex(/^[0-9a-f]{40}$/, "commit deve ter 40 caracteres hexadecimais") }).optional(),
  /** Required when the commit differs from the proposed base. */
  revisionReason: z.string().trim().max(500).optional(),
});
export type DeveloperHandoffRequest = z.infer<typeof DeveloperHandoffZ>;

/** What the executor lets this Developer run do — real capabilities, enforced by client flags (see adapters/claude.ts), not by this text. */
export function developerTools(): DeveloperTool[] {
  return [
    { label: "Ler arquivos", allowed: true, how: "Confinada à cópia de trabalho isolada, montada por git archive do commit aprovado: sem .git do projeto real, sem node_modules, sem alterações não commitadas. O modelo não acessa o resto do computador." },
    { label: "Criar, editar e remover arquivos", allowed: true, how: "Confinada à mesma cópia isolada, e só nos caminhos aprovados nesta revisão como \"criar\" ou \"alterar\". Uma edição fora deles reprova a execução — conferido no diff real da cópia, não no que o modelo relata." },
    { label: "Terminal / comandos", allowed: false, how: "Bloqueado nesta versão: o Setor IA ainda não tem um mecanismo de isolamento de rede comprovado para o terminal, e a cópia isolada não tem node_modules (não copiado por não fazer parte do commit aprovado — instalar dependências exigiria rede). A ficha do Desenvolvedor já planeja essa permissão; ela liga quando houver um mecanismo comprovado." },
    { label: "Navegador e busca na web", allowed: false, how: "Bloqueados: nenhuma ferramenta de rede é concedida nesta execução (o modo restrito do cliente remove WebFetch por padrão; WebSearch é negada explicitamente)." },
    { label: "Publicar, fazer push ou abrir pull request", allowed: false, how: "Impossível: a cópia isolada é um repositório novo e vazio de remotos, sem credencial do GitHub." },
  ];
}

/** Validates the Developer hand-off against the executor's records and freezes what will be sent. Nothing is built or called. */
export async function prepareDeveloperHandoff(req: DeveloperHandoffRequest, deps: PrepareDeps, limits: { callTimeoutMs: number }): Promise<{ run: RunRecord; created: boolean }> {
  const { store } = deps;
  const parent = await store.get(req.directorRunId);
  if (!parent || parent.kind !== "director_plan") refuse(404, "plan_not_found", "Execução do Diretor não encontrada.");
  if (parent!.status !== "plan_ready" || !parent!.result) refuse(409, "plan_not_ready", "Só é possível encaminhar tarefas de um plano pronto do Diretor.");
  const plan = parent!.result!;
  const task = plan.tasks.find(t => t.id === req.taskId);
  if (!task) refuse(404, "task_not_found", `A tarefa "${req.taskId}" não existe neste plano do Diretor.`);
  if (task!.assignee !== DEVELOPER_ASSIGNEE) refuse(409, "not_developer_task", `A tarefa ${task!.id} foi atribuída a "${task!.assignee}", não ao Desenvolvedor.`);
  if (req.agent.id !== task!.assignee) refuse(400, "agent_mismatch", "A ficha enviada não é a do responsável pela tarefa.");
  if (req.agent.connection === "none") refuse(400, "no_connection", "Escolha a conexão do Desenvolvedor na ficha dele (aba Perfil).");
  if (req.agent.connection !== "claude_code") refuse(400, "connection_not_write_restricted", "Esta versão só executa o Desenvolvedor pelo Claude Code, cujo isolamento de escrita (--restricted) está documentado e verificado. Escolha essa conexão na ficha do Desenvolvedor.");
  if (req.agent.tools.edit !== true) refuse(400, "no_write_permission", "A permissão “Editar arquivos” está desligada na ficha do Desenvolvedor (aba Permissões).");

  // Already sent? One open hand-off per task; a finished implementation is never redone.
  const existing = await store.runsForTask(parent!.id, task!.id);
  const open = existing.find(r => ["awaiting_approval", "queued", "planning"].includes(r.status));
  if (open) return { run: open, created: false };
  if (existing.some(r => r.status === "implementation_ready")) refuse(409, "already_done", `A tarefa ${task!.id} já tem uma implementação pronta do Desenvolvedor.`);
  const previous = existing[0] ? await store.detail(existing[0].id) : null;

  // Reuses the exact dependency/eligibility/edit-scope logic the preview screen shows — no separate copy of it here.
  const preview = await developerPreview({ directorRunId: req.directorRunId, taskId: req.taskId }, deps as PrepareDeps & { store: RunStore });
  if (!preview.eligible) refuse(409, "dependency_pending", `A tarefa ${task!.id} depende de outras ainda não concluídas.`, preview.blockers);
  if (!preview.base.proposed) refuse(409, "no_base_commit", "Não foi possível propor um commit de base: nenhuma análise concluída da qual esta tarefa depende registrou commit.");

  const pDetail = (await store.detail(parent!.id))!;
  const ctx0 = pDetail.context;
  if (ctx0 === null || ctx0.kind !== "github") refuse(400, "no_repository", "Esta demanda não tem repositório GitHub; não há commit para trabalhar.");
  const ctx = ctx0 as Extract<SourceContext, { kind: "github" }>;

  const proposed = preview.base.proposed!;
  const wantCommit = req.source?.commit ?? proposed.commit;
  const changedCommit = wantCommit !== proposed.commit;
  if (changedCommit && !req.revisionReason) refuse(400, "revision_reason_required", "Informe o motivo da troca de commit; ela fica registrada na revisão.");
  if (!deps.local?.dirs.length) refuse(403, "local_not_authorized", "Nenhuma cópia local do repositório está autorizada para o Desenvolvedor (AYLA_LOCAL_REPOS). A escrita exige a cópia local: o leitor público não basta para montar a cópia isolada.");
  const repos = await listLocalRepos(deps.local!.dirs, deps.local!.git);
  const repo0 = repos.find(r => r.owner.toLowerCase() === ctx.owner.toLowerCase() && r.repo.toLowerCase() === ctx.repo.toLowerCase());
  if (!repo0) refuse(403, "local_not_authorized", `Nenhuma cópia local autorizada corresponde a ${ctx.owner}/${ctx.repo}.`);
  const repo = repo0!;
  if (changedCommit) {
    const cmp = await compareLocalCommits({ dir: repo.dir, from: { commit: proposed.commit, label: "proposto" }, to: { commit: wantCommit, label: "escolhido" }, paths: [] }, deps.local!.git);
    if (cmp.relation !== "same" && cmp.relation !== "descendant") refuse(409, "commit_not_descendant", `O commit ${wantCommit.slice(0, 12)} não descende do commit proposto (${proposed.commit.slice(0, 12)}); use um commit da mesma história.`);
  }
  let entries;
  try { entries = await listTreeEntries(repo.dir, wantCommit, deps.local!.git); }
  catch (err) { if (err instanceof GithubError) refuse(502, err.code, err.message); throw err; }
  const known = new Set(entries.filter(e => e.type === "blob").map(e => e.path));

  // The preview's scope is resolved against the actual chosen commit's tree (it may differ from the proposed one).
  const editScope: EditScopeEntry[] = preview.editScope.map(e => ({
    path: e.path, from: e.from,
    action: e.action === "consultar" ? "consultar" : known.has(e.path) ? "alterar" : "criar",
  }));
  if (!editScope.some(e => e.action !== "consultar")) refuse(409, "no_edit_scope", "Nenhum caminho de edição foi identificado para esta tarefa a partir da tarefa do Diretor e das análises do Arquiteto. Ajuste a tarefa do Diretor antes de enviar ao Desenvolvedor.");

  const pSnap = (await store.snapshot(parent!.id)) as DirectorSnapshot;
  const demand = pSnap.demand;
  const team = pSnap.team;
  const agent = req.agent;
  const tools = developerTools();
  const revision: ContextRevision = {
    number: Math.max(0, ...(await Promise.all(existing.map(async r => ((await store.snapshot(r.id)) as DeveloperSnapshot | null)?.revision?.number ?? 1)))) + 1,
    previousRunId: previous?.id ?? null,
    previousCommit: previous ? (previous.snapshot as DeveloperSnapshot).base?.commit ?? null : null,
    previousVia: "local_git", commit: wantCommit, via: "local_git",
    changedCommit, reason: req.revisionReason || (previous ? "Novo envio após falha ou cancelamento." : "Primeiro envio."),
  };
  const base: DeveloperSnapshot["base"] = {
    owner: ctx.owner, repo: ctx.repo, commit: wantCommit, dirName: repo.dirName,
    treeEntries: entries.length,
    sampleFiles: entries.filter(e => e.type === "blob").map(e => e.path).sort().slice(0, 60),
  };
  const planExcerpt: DeveloperSnapshot["plan"] = {
    objective_summary: plan.objective_summary,
    step: plan.steps.find(s => s.id === task!.step_id) ?? null,
    dependents: plan.tasks.filter(t => t.depends_on.includes(task!.id)).map(t => ({ id: t.id, title: t.title, assignee: t.assignee })),
  };
  const others = plan.tasks.filter(t => t.id !== task!.id);
  const outOfScope = [
    ...others.map(t => `${t.id} · ${t.title}`),
    "Instalar dependências, rodar comandos, testes, lint ou build (sem ferramenta de terminal nesta versão).",
    "Publicar, fazer push, abrir pull request ou deploy.",
    "Aplicar qualquer alteração ao projeto original: tudo fica na cópia isolada, removida ao final.",
  ];

  const system = buildDeveloperSystem(agent);
  const user = buildDeveloperMessage({ demand, task: task!, plan: planExcerpt, team, base, editScope, outOfScope, dependencies: preview.analyses, tools });
  const schemaText = JSON.stringify(DEVELOPER_JSON_SCHEMA);
  const estimate = estimateTokens(system + user + schemaText);
  const budgetTokens = Math.max(0, Math.floor(agent.budget));

  const snapshot: DeveloperSnapshot = {
    kind: "developer_task", agent, team, demand, task: task!, plan: planExcerpt, dependencies: preview.analyses,
    base, editScope, outOfScope, tools, revision, limits: { timeoutMs: limits.callTimeoutMs, maxDiffChars: 40_000 },
  };
  const prompt = { system, user };
  const budget: RunBudget = { sheetTokens: budgetTokens, estimatedInputTokens: estimate, calls: [], reportedTotalTokens: null, exceeded: false };
  const nr: NewRun = {
    id: randomUUID(), kind: "developer_task", demandId: demand.id, agentId: agent.id, idempotencyKey: req.idempotencyKey,
    connection: agent.connection as NewRun["connection"], model: agent.modelName.trim(), effort: agent.effort.trim(),
    snapshotHash: sha256(JSON.stringify([snapshot, prompt, agent.connection, agent.modelName.trim(), agent.effort.trim()])),
    snapshot, budget, previousRunId: previous?.id ?? null, parentRunId: parent!.id, taskId: task!.id,
    initialStatus: "awaiting_approval", prompt, context: null,
  };
  const res = await store.create(nr);
  if (res.created) {
    const editable = editScope.filter(e => e.action !== "consultar");
    await store.event(res.run.id, "prepared", `Tarefa ${task!.id} do plano ${parent!.id.slice(0, 8)} preparada para o Desenvolvedor (revisão ${revision.number}): commit ${wantCommit.slice(0, 12)} (cópia local “${repo.dirName}”), ${editable.length} caminho(s) de edição aprovado(s), cerca de ${estimate} tokens de texto (estimativa). Nenhuma cópia de trabalho foi criada ainda; ela só é montada se você confirmar.`, { editScope: editable.map(e => e.path) });
    if (changedCommit) await store.event(res.run.id, "context_revision", `Revisão de contexto: commit proposto ${proposed.commit.slice(0, 12)} → ${wantCommit.slice(0, 12)}. Motivo: ${revision.reason}. ${previous ? `O envio anterior (${previous.id.slice(0, 8)}) não foi alterado.` : "Primeiro envio desta tarefa."}`);
    if (budgetTokens > 0 && estimate >= budgetTokens) await store.event(res.run.id, "budget_alert", `Alerta: a estimativa do texto (${estimate}) já passa do orçamento da ficha do Desenvolvedor (${budgetTokens}). O orçamento é referência; a execução só começa se você confirmar.`);
  }
  return res;
}

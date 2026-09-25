// Hand-off of ONE task of a Director plan to the Architect, in two steps:
// 1. prepare: the executor checks everything against its own records (the
//    browser only names the plan run and the task id, and sends the
//    Architect's saved sheet), reads the sources, builds the exact prompt and
//    stores it frozen as a run in "awaiting_approval". Nothing runs.
// 2. approve: the user confirms that exact prompt (by its hash); only then the
//    run is queued. See service.ts.
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { buildArchitectMessage, buildArchitectSystem } from "@/lib/engine/architect-prompt";
import { ANALYSIS_JSON_SCHEMA } from "@/lib/engine/analysis-schema";
import { HANDOFF_TARGETS, type ArchitectSnapshot, type DirectorSnapshot, type PlanExcerpt, type RunBudget, type RunRecord, type SourceContext, type TeamMemberInput } from "@/lib/engine/types";
import { ARCHITECT_GITHUB_LIMITS, GithubError, extractPathMentions, readGithubContext, shrinkGithubText } from "./github";
import { estimateTokens } from "./planner";
import { MemberZ } from "./runs-service";
import type { NewRun, RunStore } from "./store";

export const HandoffZ = z.object({
  idempotencyKey: z.string().regex(/^[A-Za-z0-9:_-]{8,120}$/),
  directorRunId: z.string().uuid(),
  taskId: z.string().min(1).max(64),
  /** The Architect's saved sheet (configuration only; it cannot change who runs or what task). */
  agent: MemberZ,
  previousRunId: z.string().uuid().optional(),
  answers: z.array(z.object({ question: z.string().max(2000), answer: z.string().min(1).max(4000) })).max(10).optional(),
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
export function architectTools(agent: TeamMemberInput, hasRepo: boolean, connection: string): ArchitectSnapshot["tools"] {
  const readsRepo = hasRepo && (agent.tools.read !== false || agent.tools.github === true);
  return [
    { label: "Ler arquivos do repositório", allowed: readsRepo, how: readsRepo ? "Feita pelo executor antes da chamada, só em repositório público, no commit fixo, com limites; o modelo recebe o texto e não acessa o repositório." : hasRepo ? "Desligada: a permissão “Ler arquivos” está desligada na ficha do Arquiteto." : "Sem repositório GitHub na demanda." },
    { label: "Editar arquivos", allowed: false, how: connection === "codex" ? "Bloqueada: Codex em sandbox somente leitura, ferramentas de shell desligadas, pasta de trabalho vazia." : "Bloqueada: Claude Code sem ferramentas (--tools \"\"), permissões negadas (dontAsk), pasta de trabalho vazia." },
    { label: "Terminal / comandos", allowed: false, how: "Bloqueado pelo executor, mesmo que esteja planejado na ficha." },
    { label: "Navegador e busca na web", allowed: false, how: "Bloqueados pelo executor." },
    { label: "Publicar, fazer push ou abrir pull request", allowed: false, how: "Impossível: o repositório nunca é clonado e nenhuma credencial do GitHub é passada ao cliente." },
  ];
}

export type PrepareDeps = {
  store: RunStore;
  github: { fetch?: typeof fetch; token?: string; apiBase?: string; rawBase?: string };
};

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
  if (waiting && (req.previousRunId !== waiting.id || !req.answers?.length)) refuse(409, "awaiting_answers", "O Arquiteto está aguardando suas respostas nesta tarefa. Responda às perguntas da análise para reenviar.");
  if (req.previousRunId && req.previousRunId !== waiting?.id) refuse(400, "invalid_previous_run", "As respostas não correspondem a uma análise desta tarefa aguardando esclarecimento.");

  // Dependencies: every task this one depends on must be done by someone who can run in this phase.
  const dependsOn: PlanExcerpt["dependsOn"] = [];
  const blockers: string[] = [];
  for (const depId of task!.depends_on) {
    const dep = plan.tasks.find(t => t.id === depId);
    if (!dep) continue;
    if (!HANDOFF_TARGETS.includes(dep.assignee as (typeof HANDOFF_TARGETS)[number])) { blockers.push(`${dep.id} (${dep.assignee}) ainda não executa nesta fase`); continue; }
    const done = (await store.runsForTask(parent!.id, dep.id)).find(r => r.status === "analysis_ready");
    if (!done) { blockers.push(`${dep.id} precisa antes de uma análise concluída do Arquiteto`); continue; }
    dependsOn.push({ id: dep.id, title: dep.title, assignee: dep.assignee, analysisSummary: done.analysis?.recommendation.summary ?? null, analysisRunId: done.id });
  }
  if (blockers.length) refuse(409, "dependency_pending", `A tarefa ${task!.id} depende de outras ainda não concluídas.`, blockers);

  const pSnap = (await store.snapshot(parent!.id)) as DirectorSnapshot;
  const pDetail = (await store.detail(parent!.id))!;
  const directorCtx = pDetail.context;
  const excerpt: PlanExcerpt = {
    directorRunId: parent!.id, directorConnection: parent!.connection,
    objective_summary: plan.objective_summary, flow: { type: plan.flow.type, rationale: plan.flow.rationale },
    step: plan.steps.find(s => s.id === task!.step_id) ?? null,
    dependsOn,
    dependents: plan.tasks.filter(t => t.depends_on.includes(task!.id)).map(t => ({ id: t.id, title: t.title, assignee: t.assignee })),
    risks: plan.risks, assumptions: plan.assumptions, not_verified: plan.not_verified,
    directorFiles: directorCtx?.kind === "github" ? directorCtx.files.map(f => ({ path: f.path, bytes: f.bytes, truncated: f.truncated })) : [],
    directorCommit: directorCtx?.kind === "github" ? directorCtx.commit : null,
  };

  // Sources: same repository and commit the Director read, selection driven by the task.
  const agent = req.agent;
  const demand = pSnap.demand;
  const tools = architectTools(agent, directorCtx?.kind === "github", agent.connection);
  let context: SourceContext = directorCtx?.kind === "folder" ? directorCtx : { kind: "none", note: "Demanda sem fonte de projeto." };
  let sourceText = "";
  if (directorCtx?.kind === "github") {
    if (!tools[0].allowed) {
      context = { kind: "none", note: "Leitura do repositório desligada na ficha do Arquiteto: nenhum arquivo foi enviado." };
    } else {
      const taskText = [task!.title, task!.scope, task!.inputs, task!.deliverable, ...task!.acceptance_criteria].join("\n");
      try {
        const r = await readGithubContext({
          owner: directorCtx.owner, repo: directorCtx.repo, branch: directorCtx.branch, commit: directorCtx.commit,
          keywords: [...new Set(`${taskText}\n${excerpt.step?.title ?? ""}\n${demand.title}`.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").split(/[^a-z0-9_-]+/))],
          limits: ARCHITECT_GITHUB_LIMITS, selection: "architect", mentions: extractPathMentions(taskText),
        }, deps.github);
        context = r.context;
        sourceText = r.text;
      } catch (err) {
        if (err instanceof GithubError) refuse(502, err.code, err.message);
        throw err;
      }
    }
  }

  const system = buildArchitectSystem(agent);
  const team = pSnap.team;
  const answers = req.answers?.length ? req.answers : null;
  let user = buildArchitectMessage({ demand, task: task!, plan: excerpt, team, context, sourceText, answers });
  const schemaText = JSON.stringify(ANALYSIS_JSON_SCHEMA);
  let estimate = estimateTokens(system + user + schemaText);
  const budgetTokens = Math.max(0, Math.floor(agent.budget));
  // Reduce repository text when it would take most of the sheet budget (documented in docs/executor-local.md).
  for (let i = 0; i < 3 && context.kind === "github" && budgetTokens > 0 && estimate > budgetTokens * 0.6; i++) {
    const shrunk = shrinkGithubText(context, sourceText, Math.floor(sourceText.length * 0.75), "priority");
    context = shrunk.ctx; sourceText = shrunk.text;
    user = buildArchitectMessage({ demand, task: task!, plan: excerpt, team, context, sourceText, answers });
    estimate = estimateTokens(system + user + schemaText);
  }

  const snapshot: ArchitectSnapshot = { kind: "architect_task", agent, team, demand, task: task!, plan: excerpt, tools, answers };
  const prompt = { system, user };
  const budget: RunBudget = { sheetTokens: budgetTokens, estimatedInputTokens: estimate, calls: [], reportedTotalTokens: null, exceeded: false };
  const nr: NewRun = {
    id: randomUUID(), kind: "architect_task", demandId: demand.id, agentId: agent.id, idempotencyKey: req.idempotencyKey,
    connection: agent.connection as NewRun["connection"], model: agent.modelName.trim(), effort: agent.effort.trim(),
    snapshotHash: handoffHash({ snapshot, prompt, context, connection: agent.connection, model: agent.modelName.trim(), effort: agent.effort.trim() }),
    snapshot, budget, previousRunId: req.previousRunId ?? null, parentRunId: parent!.id, taskId: task!.id,
    initialStatus: "awaiting_approval", prompt, context,
  };
  const res = await store.create(nr);
  if (res.created) {
    await store.event(res.run.id, "prepared", `Tarefa ${task!.id} do plano ${parent!.id.slice(0, 8)} preparada para o Arquiteto: ${context.kind === "github" ? `${context.files.length} arquivo(s) do commit ${context.commit.slice(0, 12)}` : "sem arquivos do repositório"}, cerca de ${estimate} tokens de texto (estimativa).`, { files: context.kind === "github" ? context.files.map(f => f.path) : [] });
    if (budgetTokens > 0 && estimate >= budgetTokens) await store.event(res.run.id, "budget_alert", `Alerta: a estimativa do texto (${estimate}) já passa do orçamento da ficha do Arquiteto (${budgetTokens}). O orçamento é referência; a execução só começa se você confirmar.`);
  }
  return res;
}

// Autopilot, phase 1: the user approves ONE policy for a Director plan, and the supervisor sends the
// Architect, QA and Reviewer tasks of that plan by itself, in dependency order, stopping whenever something
// needs the user. It never sends a Developer task and never bypasses a gate:
// - every hand-off is prepared by the very same service methods the interface calls (read-only check, hourly
//   limit, one open hand-off per task, dependency evidence), with the sheets frozen in the policy;
// - the prepared content is checked against the policy (frozen sheet, D2, sheet budget, demand budget) BEFORE
//   it is approved; a brake leaves it waiting for the user's own review, exactly like a manual hand-off;
// - approving goes through service.approveByPolicy(), which refuses any Developer hand-off and records
//   "auto_approved" with the policy id and hash instead of the user's "approved";
// - one step at a time per policy (serialized), idempotent (deterministic idempotency keys), resumed on boot.
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { architectDefaults } from "@/lib/engine/send-defaults";
import { autopilotIneligibility, costRatio, isAutopilotStage, nextAutopilotStep, projectTokens, settledBrake, STAGE_LABEL, usedTokens } from "@/lib/engine/autopilot";
import { AUTOPILOT_FINAL, type AgentConnectionRef, type AutopilotPolicy, type AutopilotRecord, type AutopilotStage, type AutopilotStatus, type AutopilotStop, type AutopilotStopCode, type PlanTask, type QASnapshot, type RunDetail, type RunRecord, type TeamMemberInput } from "@/lib/engine/types";
import type { SourceOptions } from "@/lib/engine/client";
import { MemberZ } from "./runs-service";
import type { RunStore } from "./store";

type Reply = { status: number; body: unknown };

/** What the supervisor needs from the executor service (the same entry points the interface uses). */
export interface SupervisorHost {
  store: RunStore;
  maxRunsPerHour: number;
  readOnlySafe(ref: AgentConnectionRef): boolean;
  prepare(body: unknown): Promise<Reply>;
  prepareQA(body: unknown): Promise<Reply>;
  prepareReviewer(body: unknown): Promise<Reply>;
  sourceOptions(directorRunId: string, taskId: string): Promise<Reply>;
  approveByPolicy(runId: string, snapshotHash: string, autopilot: Pick<AutopilotRecord, "id" | "policyHash" | "approvedAt">, rule: string): Promise<boolean>;
}

const LIVE: AutopilotStatus[] = ["active", "waiting_user", "waiting_rate_limit"];
const err = (status: number, code: string, message: string, details?: string[]): Reply => ({ status, body: { error: { code, message, ...(details ? { details } : {}) } } });
export const policyHash = (p: AutopilotPolicy) => createHash("sha256").update(JSON.stringify(p)).digest("hex");
/** Order-independent JSON (to compare a frozen sheet with the one a prepared hand-off carries). */
const stable = (v: unknown): string => (Array.isArray(v) ? `[${v.map(stable).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v as object).sort().map(k => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(",")}}` : JSON.stringify(v));
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export const AutopilotRequestZ = z.object({
  idempotencyKey: z.string().regex(/^[A-Za-z0-9:_-]{8,120}$/),
  planRunId: z.string().uuid(),
  /** The saved sheets of the collaborators the policy will use, frozen with it. */
  sheets: z.object({ architect: MemberZ.optional(), qa: MemberZ.optional(), reviewer: MemberZ.optional() }).strict(),
  /** Tasks to include (default: every Architect, QA and Reviewer task of the plan). */
  taskIds: z.array(z.string().min(1).max(64)).max(60).optional(),
  budgetTokens: z.number().int().min(1_000).max(5_000_000),
  maxRuns: z.number().int().min(1).max(60),
  validityHours: z.number().int().min(1).max(72),
}).strict();

export class Supervisor {
  private chains = new Map<string, Promise<void>>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private inFlight = 0;
  constructor(private host: SupervisorHost, private now: () => number = Date.now) {}

  private get store() { return this.host.store; }

  // ---- user actions ------------------------------------------------------------------------------------

  /** Step 1: validates and freezes the policy (status awaiting_approval). Nothing is sent. */
  async prepare(body: unknown): Promise<Reply> {
    const parsed = AutopilotRequestZ.safeParse(body);
    if (!parsed.success) return err(400, "invalid_request", "Dados do piloto automático inválidos.", parsed.error.issues.slice(0, 10).map(i => `${i.path.join(".")}: ${i.message}`));
    const req = parsed.data;
    const plan = await this.store.get(req.planRunId);
    if (!plan || plan.kind !== "director_plan") return err(404, "plan_not_found", "Plano do Diretor não encontrado.");
    if (plan.status !== "plan_ready" || !plan.result) return err(409, "plan_not_ready", "O piloto automático só pode ser ativado num plano pronto do Diretor.");
    const stageTasks = plan.result.tasks.filter(t => isAutopilotStage(t.assignee) && !autopilotIneligibility(t, plan.result!.tasks));
    const unknown = (req.taskIds ?? []).filter(id => !stageTasks.some(t => t.id === id));
    if (unknown.length) return err(400, "invalid_tasks", `Estas tarefas não podem entrar no piloto automático: ${unknown.map(id => { const t = plan.result!.tasks.find(x => x.id === id); return t ? `${id} (${autopilotIneligibility(t, plan.result!.tasks) ?? "?"})` : `${id} (não existe no plano)`; }).join("; ")}.`);
    const included = req.taskIds ? stageTasks.filter(t => req.taskIds!.includes(t.id)) : stageTasks;
    if (!included.length) return err(409, "no_tasks", "Este plano não tem tarefas do Arquiteto, do QA ou do Revisor para o piloto automático.");
    const sheets: AutopilotPolicy["sheets"] = {};
    for (const stage of new Set(included.map(t => t.assignee as AutopilotStage))) {
      const sheet = req.sheets[stage] as TeamMemberInput | undefined;
      if (!sheet || sheet.id !== stage) return err(400, "sheet_missing", `Falta a ficha do ${STAGE_LABEL[stage]} para as tarefas dele.`);
      if (sheet.connection === "none") return err(400, "no_connection", `Escolha a conexão do ${STAGE_LABEL[stage]} na ficha dele (aba Perfil).`);
      if (!this.host.readOnlySafe(sheet.connection as AgentConnectionRef)) return err(409, "adapter_not_read_only", `A conexão do ${STAGE_LABEL[stage]} não pode ser restrita a somente leitura.`);
      sheets[stage] = sheet;
    }
    // A repeated request (same idempotency key) returns the policy it already created.
    const prior = await this.store.autopilotByKey(req.idempotencyKey);
    if (prior) return { status: 200, body: { autopilot: prior, created: false } };
    const open = await this.store.openAutopilotForPlan(plan.id);
    if (open && open.status !== "awaiting_approval") return err(409, "autopilot_open", "Este plano já tem um piloto automático em andamento. Encerre-o antes de preparar outro.", [`${open.id.slice(0, 8)}: ${open.status}`]);
    const policy: AutopilotPolicy = {
      version: 1, planRunId: plan.id, demandId: plan.demandId,
      tasks: included.map(t => ({ id: t.id, assignee: t.assignee as AutopilotStage, title: t.title })),
      sheets, budgetTokens: req.budgetTokens, maxRuns: req.maxRuns,
      expiresAt: new Date(this.now() + req.validityHours * 3600_000).toISOString(),
      rules: { acceptProposedCommit: true, qaRequiresTestedVersion: true, stopOnFailure: true, neverRepeat: true },
    };
    // An unconfirmed policy of this plan is replaced by the new one (it never ran).
    if (open) await this.store.updateAutopilot(open.id, { status: "canceled", stop: this.stopOf("user_paused", "Substituída por uma nova política preparada antes da confirmação.") }, ["awaiting_approval"]);
    const { autopilot, created } = await this.store.createAutopilot({ id: randomUUID(), idempotencyKey: req.idempotencyKey, planRunId: plan.id, demandId: plan.demandId, policy, policyHash: policyHash(policy) });
    if (created) await this.store.event(plan.id, "autopilot_prepared", `Piloto automático preparado (${autopilot.id.slice(0, 8)}): ${policy.tasks.map(t => t.id).join(", ")}; orçamento ${policy.budgetTokens} tokens, até ${policy.maxRuns} execução(ões), válido até ${policy.expiresAt}. Nada é enviado antes da sua confirmação.`, { autopilotId: autopilot.id, policyHash: autopilot.policyHash });
    return { status: created ? 201 : 200, body: { autopilot, created } };
  }

  /** Step 2: the user's confirmation of exactly that policy (by its hash). */
  async approve(id: string, body: unknown): Promise<Reply> {
    const ap = await this.store.getAutopilot(id);
    if (!ap) return err(404, "not_found", "Piloto automático não encontrado.");
    const hash = (body as { policyHash?: unknown } | null)?.policyHash;
    if (ap.status !== "awaiting_approval") return { status: 200, body: { autopilot: ap, approved: false } };
    if (typeof hash !== "string" || hash !== ap.policyHash || policyHash(ap.policy) !== ap.policyHash) return err(409, "content_changed", "A política confirmada não corresponde à preparada. Abra a revisão de novo.");
    if (Date.parse(ap.policy.expiresAt) <= this.now()) return err(409, "expired", "Esta política venceu antes de ser confirmada. Prepare outra.");
    const plan = await this.store.get(ap.planRunId);
    if (!plan || plan.status !== "plan_ready") return err(409, "plan_not_ready", "O plano do Diretor desta política não está mais disponível.");
    const at = new Date(this.now()).toISOString();
    if (!(await this.store.updateAutopilot(id, { status: "active", approvedAt: at }, ["awaiting_approval"]))) return { status: 200, body: { autopilot: await this.store.getAutopilot(id), approved: false } };
    await this.store.event(ap.planRunId, "autopilot_approved", `Piloto automático ${id.slice(0, 8)} confirmado por você. O executor passa a enviar sozinho as tarefas ${ap.policy.tasks.map(t => t.id).join(", ")} quando cada uma ficar apta; ele para e chama você nos freios da política.`, { autopilotId: id, policyHash: ap.policyHash });
    await this.tick(id);
    return { status: 202, body: { autopilot: await this.store.getAutopilot(id), approved: true } };
  }

  async pause(id: string): Promise<Reply> {
    const ap = await this.store.getAutopilot(id);
    if (!ap) return err(404, "not_found", "Piloto automático não encontrado.");
    await this.withChain(id, async () => {
      if (await this.store.updateAutopilot(id, { status: "paused", waiting: null, stop: this.stopOf("user_paused", "Pausado por você. Execuções já em andamento continuam; nada novo é enviado.") }, LIVE)) {
        this.clearTimer(id);
        await this.store.event(ap.planRunId, "autopilot_paused", `Piloto automático ${id.slice(0, 8)} pausado por você.`, { autopilotId: id });
      }
    });
    return { status: 200, body: { autopilot: await this.store.getAutopilot(id) } };
  }

  /** Resumes a paused policy (the same one: its hash must match). The settled runs that caused a stop are not evaluated again. */
  async resume(id: string, body: unknown): Promise<Reply> {
    const ap = await this.store.getAutopilot(id);
    if (!ap) return err(404, "not_found", "Piloto automático não encontrado.");
    const hash = (body as { policyHash?: unknown } | null)?.policyHash;
    if (ap.status !== "paused") return { status: 200, body: { autopilot: ap, resumed: false } };
    if (typeof hash !== "string" || hash !== ap.policyHash) return err(409, "content_changed", "A política não corresponde à que está pausada. Abra o painel de novo.");
    if (Date.parse(ap.policy.expiresAt) <= this.now()) return err(409, "expired", "Esta política venceu. Encerre-a e prepare outra.");
    if (!(await this.store.updateAutopilot(id, { status: "active", stop: null }, ["paused"]))) return { status: 200, body: { autopilot: await this.store.getAutopilot(id), resumed: false } };
    await this.store.event(ap.planRunId, "autopilot_resumed", `Piloto automático ${id.slice(0, 8)} retomado por você${ap.stop ? ` (estava parado: ${ap.stop.message})` : ""}.`, { autopilotId: id, previousStop: ap.stop });
    await this.tick(id);
    return { status: 202, body: { autopilot: await this.store.getAutopilot(id), resumed: true } };
  }

  /** Ends a policy for good (any non-final status). Runs already in progress are not touched. */
  async cancel(id: string): Promise<Reply> {
    const ap = await this.store.getAutopilot(id);
    if (!ap) return err(404, "not_found", "Piloto automático não encontrado.");
    await this.withChain(id, async () => {
      if (await this.store.updateAutopilot(id, { status: "canceled", waiting: null }, ["awaiting_approval", ...LIVE, "paused"])) {
        this.clearTimer(id);
        await this.store.event(ap.planRunId, "autopilot_canceled", `Piloto automático ${id.slice(0, 8)} encerrado por você. Execuções já em andamento continuam; nada novo é enviado por ele.`, { autopilotId: id });
      }
    });
    return { status: 200, body: { autopilot: await this.store.getAutopilot(id) } };
  }

  /** Policies of a plan (or of demands), plus the observed usage of earlier runs for the budget suggestion. */
  async list(q: { planRunId?: string; demandIds?: string[] }): Promise<Reply> {
    const autopilots = await this.store.autopilotsFor(q);
    const history: Record<string, { median: number | null; samples: number }> = {};
    for (const kind of ["architect_task", "qa_task", "reviewer_task"] as const) {
      const vals: number[] = [];
      for (const conn of ["claude_code", "codex"]) for (const r of await this.store.usageHistory(kind, conn)) if (r.budget.reportedTotalTokens) vals.push(r.budget.reportedTotalTokens);
      vals.sort((a, b) => a - b);
      history[kind] = { median: vals.length ? vals[Math.floor(vals.length / 2)] : null, samples: vals.length };
    }
    return { status: 200, body: { autopilots, usageHistory: history } };
  }

  // ---- triggers ------------------------------------------------------------------------------------------

  /** A run settled (finished, failed, canceled…) or was discarded: look at its plan's live policy. */
  async onRunSettled(runId: string) {
    const run = await this.store.get(runId);
    if (run?.parentRunId) await this.poke(run.parentRunId);
  }

  /** Something changed in a plan (a completion was recorded, a run settled): re-evaluate its live policy. */
  async poke(planRunId: string) {
    const ap = await this.store.openAutopilotForPlan(planRunId);
    if (ap && LIVE.includes(ap.status)) await this.tick(ap.id);
  }

  /** On executor start: every live policy is re-evaluated (rate-limit waits resume by themselves). */
  async boot() {
    for (const ap of await this.store.liveAutopilots()) await this.tick(ap.id);
  }

  /** Waits for every pending step (tests). */
  async idle() { while (this.inFlight) await new Promise(r => setTimeout(r, 10)); }

  stopTimers() { for (const t of this.timers.values()) clearTimeout(t); this.timers.clear(); }

  tick(id: string): Promise<void> { return this.withChain(id, () => this.step(id)); }

  // ---- the supervisor itself ------------------------------------------------------------------------------

  private withChain(id: string, fn: () => Promise<void>): Promise<void> {
    this.inFlight++;
    const prev = this.chains.get(id) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn).finally(() => { this.inFlight--; if (this.chains.get(id) === next) this.chains.delete(id); });
    this.chains.set(id, next);
    return next;
  }

  private stopOf(code: AutopilotStopCode, message: string, taskId: string | null = null, runId: string | null = null): AutopilotStop {
    return { code, message, taskId, runId, at: new Date(this.now()).toISOString() };
  }

  private async halt(ap: AutopilotRecord, code: AutopilotStopCode, message: string, taskId: string | null = null, runId: string | null = null, extra: Partial<Pick<AutopilotRecord, "handled" | "usedTokens">> = {}) {
    this.clearTimer(ap.id);
    if (await this.store.updateAutopilot(ap.id, { status: "paused", waiting: null, stop: this.stopOf(code, message, taskId, runId), ...extra }, LIVE)) {
      await this.store.event(ap.planRunId, "autopilot_stopped", `Piloto automático ${ap.id.slice(0, 8)} parou (${code}): ${message}`, { autopilotId: ap.id, code, taskId, runId });
    }
  }

  private clearTimer(id: string) { const t = this.timers.get(id); if (t) clearTimeout(t); this.timers.delete(id); }

  private async step(id: string): Promise<void> {
    const ap = await this.store.getAutopilot(id);
    if (!ap || !LIVE.includes(ap.status)) return;
    if (Date.parse(ap.policy.expiresAt) <= this.now()) {
      if (await this.store.updateAutopilot(id, { status: "expired", waiting: null }, LIVE)) await this.store.event(ap.planRunId, "autopilot_expired", `Piloto automático ${id.slice(0, 8)} venceu (${ap.policy.expiresAt}). Nada novo é enviado por ele.`, { autopilotId: id });
      return;
    }
    const plan = await this.store.get(ap.planRunId);
    if (!plan || plan.status !== "plan_ready" || !plan.result) return this.halt(ap, "plan_unavailable", "O plano do Diretor não está mais pronto.");
    const tasks = plan.result.tasks;
    const runsByTask = new Map<string, RunRecord[]>();
    for (const t of tasks) runsByTask.set(t.id, await this.store.runsForTask(plan.id, t.id));
    const completions = await this.store.taskCompletionsForPlan(plan.id);
    const runsOf = (taskId: string) => runsByTask.get(taskId) ?? [];
    const completionsOf = (taskId: string) => completions.filter(c => c.taskId === taskId);

    // 1. How did the runs this policy approved settle? (each settled run is looked at once)
    const own = (await Promise.all(ap.runs.map(r => this.store.get(r.runId)))).filter((r): r is RunRecord => !!r);
    const used = usedTokens(own);
    const handled = [...ap.handled];
    for (const run of own) {
      if (handled.includes(run.id) || ["awaiting_approval", "queued", "planning"].includes(run.status)) continue;
      handled.push(run.id);
      const stage = ap.policy.tasks.find(t => t.id === run.taskId)?.assignee;
      const brake = stage ? settledBrake(run, stage) : null;
      if (brake) return this.halt(ap, brake.code, brake.message, run.taskId, run.id, { handled, usedTokens: used });
    }
    if (used > ap.policy.budgetTokens) return this.halt(ap, "budget", `O uso informado das execuções desta política (${used} tokens) já passou do orçamento da demanda (${ap.policy.budgetTokens}).`, null, null, { handled, usedTokens: used });
    if (handled.length !== ap.handled.length || used !== ap.usedTokens) await this.store.updateAutopilot(id, { handled, usedTokens: used });

    // 2. What next?
    const next = nextAutopilotStep(ap.policy, tasks, runsOf, completionsOf);
    if (next.kind === "busy") {
      if (ap.status !== "active" || ap.waiting) await this.store.updateAutopilot(id, { status: "active", waiting: null }, LIVE);
      return;
    }
    if (next.kind === "waiting_user") {
      if (ap.status !== "waiting_user" || ap.waiting?.message !== next.message) {
        await this.store.updateAutopilot(id, { status: "waiting_user", waiting: { message: next.message, until: null, taskIds: next.taskIds } }, LIVE);
        if (ap.status !== "waiting_user") await this.store.event(plan.id, "autopilot_waiting", `Piloto automático ${id.slice(0, 8)}: ${next.message}`, { autopilotId: id, taskIds: next.taskIds });
      }
      return;
    }
    if (next.kind === "concluded") {
      const reviewer = ap.policy.tasks.filter(t => t.assignee === "reviewer").map(t => runsOf(t.id)[0]).find(r => r?.reviewer);
      const verdict = reviewer?.reviewer?.verdict ? ` Veredito do Revisor: ${reviewer.reviewer.verdict}.` : "";
      if (await this.store.updateAutopilot(id, { status: "concluded", waiting: null }, LIVE)) await this.store.event(plan.id, "autopilot_concluded", `Piloto automático ${id.slice(0, 8)} concluído: ${next.message}${verdict}`, { autopilotId: id, verdict: reviewer?.reviewer?.verdict ?? null });
      return;
    }
    await this.send(ap, plan, next.task, used);
  }

  private async send(ap: AutopilotRecord, plan: RunRecord, task: PlanTask, used: number): Promise<void> {
    const stage = task.assignee as AutopilotStage;
    if (ap.runs.length >= ap.policy.maxRuns) return this.halt(ap, "max_runs", `A política já aprovou ${ap.runs.length} execução(ões), o máximo definido.`, task.id);
    const hourAgo = new Date(this.now() - 3600_000).toISOString();
    if ((await this.store.countCreatedSince(hourAgo)) >= this.host.maxRunsPerHour) return this.waitRateLimit(ap, task.id, hourAgo);
    const sheet = ap.policy.sheets[stage];
    if (!sheet) return this.halt(ap, "prepare_refused", `A política não tem a ficha do ${STAGE_LABEL[stage]}.`, task.id);
    const key = `ap:${ap.id.slice(0, 8)}:${task.id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 60)}`;
    const base = { idempotencyKey: key, directorRunId: plan.id, taskId: task.id, agent: sheet };
    let rule = `Tarefa ${task.id} (${STAGE_LABEL[stage]}) apta: todas as dependências satisfeitas por evidência; ficha congelada na política.`;
    let reply: Reply;
    if (stage === "architect") {
      const opts = await this.host.sourceOptions(plan.id, task.id);
      if (opts.status !== 200) return this.halt(ap, "prepare_refused", `Não foi possível ler as opções de fonte de ${task.id}: ${errorMessage(opts)}`, task.id);
      const d = architectDefaults(opts.body as SourceOptions);
      const reason = d.changedFromDirector ? clip(`Piloto automático (D1): ${d.why ?? "commit proposto pelo executor"}`, 500) : null;
      if (reason) rule += ` D1: commit ${d.source!.commit.slice(0, 12)} (${d.source!.via}) proposto pelo executor, diferente do commit do Diretor; motivo registrado na revisão.`;
      reply = await this.host.prepare({ ...base, ...(d.source ? { source: d.source } : {}), ...(reason ? { revisionReason: reason } : {}), ...(d.files.length ? { files: d.files.slice(0, 12) } : {}) });
    } else if (stage === "qa") {
      reply = await this.host.prepareQA(base);
    } else {
      reply = await this.host.prepareReviewer(base);
    }
    if (reply.status === 429) return this.waitRateLimit(ap, task.id, hourAgo);
    if (reply.status !== 200 && reply.status !== 201) return this.halt(ap, "prepare_refused", `O executor recusou preparar ${task.id}: ${errorMessage(reply)}`, task.id);
    const run = (reply.body as { run: RunDetail }).run;
    if (run.status !== "awaiting_approval") return; // already moving (a concurrent step approved it)

    // 3. Brakes on the prepared content (it stays waiting for the user's own review when one applies).
    const snap = run.snapshot as { agent?: TeamMemberInput };
    if (!snap.agent || stable(snap.agent) !== stable(sheet)) return this.halt(ap, "sheet_mismatch", `O envio preparado de ${task.id} não usa a ficha congelada na política. Revise-o você.`, task.id, run.id);
    if (stage === "qa" && !(run.snapshot as QASnapshot).testedVersion) return this.halt(ap, "no_tested_version", `O QA de ${task.id} não teria versão para testar (sem projeto local autorizado com a entrega): só produziria “não verificado”. O envio ficou aguardando a sua revisão.`, task.id, run.id);
    const estimate = run.budget?.estimatedInputTokens ?? 0;
    if (sheet.budget > 0 && estimate > sheet.budget) return this.halt(ap, "sheet_budget", `A estimativa do texto de ${task.id} (${estimate} tokens) já passa do orçamento da ficha do ${STAGE_LABEL[stage]} (${Math.floor(sheet.budget)}). O envio ficou aguardando a sua revisão.`, task.id, run.id);
    const { ratio, samples } = costRatio(await this.store.usageHistory(run.kind, run.connection));
    const projected = projectTokens(estimate, ratio);
    if (used + projected > ap.policy.budgetTokens) return this.halt(ap, "budget", `Usado ${used} + projeção de ${task.id} ${projected} (estimativa ${estimate} × ${ratio}${samples ? `, razão observada em ${samples} execução(ões)` : ", razão padrão"}) passaria do orçamento da demanda (${ap.policy.budgetTokens}). O envio ficou aguardando a sua revisão.`, task.id, run.id);
    rule += ` Custo projetado ${projected} tokens (estimativa ${estimate} × ${ratio}); usado até aqui ${used} de ${ap.policy.budgetTokens}.`;

    // 4. Approve through the policy (never a Developer hand-off; the service checks it again).
    if (!(await this.host.approveByPolicy(run.id, run.snapshotHash, ap, rule))) return;
    const runs = [...ap.runs, { runId: run.id, taskId: task.id, at: new Date(this.now()).toISOString(), projectedTokens: projected }];
    await this.store.updateAutopilot(ap.id, { runs, status: "active", waiting: null }, LIVE);
    await this.store.event(plan.id, "autopilot_step", `Piloto automático ${ap.id.slice(0, 8)} enviou ${task.id} (${STAGE_LABEL[stage]}): execução ${run.id.slice(0, 8)}.`, { autopilotId: ap.id, runId: run.id, taskId: task.id, projectedTokens: projected });
  }

  /** The local hourly limit is not a judgement call: wait for the window to open, then look again by itself. */
  private async waitRateLimit(ap: AutopilotRecord, taskId: string, hourAgo: string) {
    const oldest = await this.store.oldestCreatedSince(hourAgo);
    const until = new Date((oldest ? Date.parse(oldest) : this.now()) + 3600_000 + 1_000).toISOString();
    await this.store.updateAutopilot(ap.id, { status: "waiting_rate_limit", waiting: { message: `Limite local de ${this.host.maxRunsPerHour} execuções por hora atingido; ${taskId} será enviada quando a janela abrir.`, until, taskIds: [taskId] } }, LIVE);
    this.clearTimer(ap.id);
    const t = setTimeout(() => { this.timers.delete(ap.id); void this.tick(ap.id); }, Math.max(1_000, Date.parse(until) - this.now()));
    (t as { unref?: () => void }).unref?.();
    this.timers.set(ap.id, t);
  }
}

function errorMessage(r: Reply): string {
  const e = (r.body as { error?: { message?: string; details?: string[] } } | null)?.error;
  return e?.message ? `${e.message}${e.details?.length ? ` (${e.details.slice(0, 3).join("; ")})` : ""}` : `resposta ${r.status}`;
}

export const isFinalAutopilot = (s: AutopilotStatus) => AUTOPILOT_FINAL.includes(s);

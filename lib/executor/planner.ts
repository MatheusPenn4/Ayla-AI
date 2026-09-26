// Run pipeline of the local executor. One core for every kind of run:
// claim → connection check → prompt → official client call → validation (at
// most one correction) → final state, with events, lease renewal, reported
// usage and cancellation. Each kind only supplies how its prompt is built and
// how its answer is validated:
// - director_plan: the Director plans a demand (reads GitHub here);
// - architect_task: the Architect analyses one approved task. Its prompt was
//   built and frozen when the hand-off was prepared (the user approved exactly
//   that text), so nothing is read again here.
// Nothing is simulated: when the client is not usable the run fails with the
// reason and the recovery steps. No collaborator triggers another one.
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { ANALYSIS_JSON_SCHEMA, partialTexts, validateAnalysis } from "@/lib/engine/analysis-schema";
import { PLAN_JSON_SCHEMA, validatePlan } from "@/lib/engine/plan-schema";
import { buildSystemPrompt, buildUserMessage } from "@/lib/engine/prompt";
import { reportedTotal, type ArchitectSnapshot, type CallUsage, type ConnectionStatus, type DirectorSnapshot, type RunBudget, type RunDetail, type RunError, type RunRecord, type RunStatus, type SourceContext } from "@/lib/engine/types";
import { LOGIN_STEPS } from "./clients";
import { AgentError, type AgentAdapter, type AgentErrorCode, type AgentProgress } from "./adapters/types";
import { GithubError, readGithubContext, shrinkGithubText } from "./github";
import type { RunStore } from "./store";

export type PlannerDeps = {
  store: RunStore;
  /** Fresh status of the chosen connection (checked right before the call). */
  connection: () => Promise<ConnectionStatus>;
  /** Adapter for the chosen connection; null when the client is not installed. */
  adapter: AgentAdapter | null;
  limits: { callTimeoutMs: number; leaseMs: number };
  /** Used by the Director only (the Architect's sources were read when the hand-off was prepared). */
  github: { fetch?: typeof fetch; token?: string; apiBase?: string; rawBase?: string; permitted: boolean };
  /** Parent folder for per-call empty working directories. */
  workRoot: string;
  signal?: AbortSignal;
};

/** Rough estimate used only before the call; the reported figures replace it afterwards. */
export const estimateTokens = (text: string) => Math.ceil(text.length / 3.5);

export class RunFailure extends Error {
  constructor(public err: RunError) { super(err.message); }
}
const fail = (err: RunError): never => { throw new RunFailure(err); };

function recoveryFor(code: AgentErrorCode | string, conn: ConnectionStatus | null, who: string, timeoutMs = 0): string[] {
  const id = conn?.id ?? "claude_code";
  switch (code) {
    case "not_installed": return LOGIN_STEPS[id].install;
    case "not_connected": return LOGIN_STEPS[id].login;
    case "session_expired": return LOGIN_STEPS[id].expired;
    case "usage_limit": return ["Aguarde a renovação do limite da assinatura (o cliente não informa o saldo restante ao Setor IA).", `Ou escolha a outra conexão na ficha do ${who} e tente novamente.`];
    case "model_unavailable": return [`Na ficha do ${who} (aba Perfil), deixe o modelo em “Padrão do cliente” ou escolha um modelo listado pelo próprio cliente.`, "Depois tente novamente."];
    case "timeout": return [`O limite do executor por chamada é de ${Math.round(timeoutMs / 60000)} min (AYLA_CALL_TIMEOUT_MS). Respostas longas podem passar disso.`, "Tente de novo; se repetir, reduza o contexto enviado ou escolha um esforço menor na ficha.", "O cliente foi encerrado antes de informar o uso: o consumo desta tentativa não é conhecido."];
    case "connection_lost": case "client_error": case "interrupted": return ["Verifique a conexão de rede e tente novamente.", "Se repetir, rode o mesmo cliente no seu terminal para ver a mensagem completa."];
    default: return ["Tente novamente."];
  }
}

function usageNotes(budget: RunBudget) {
  const out: string[] = [];
  if (budget.reportedTotalTokens === null) out.push("O cliente não informou o uso de tokens desta execução.");
  if (budget.exceeded) out.push(`O uso informado pelo cliente (${budget.reportedTotalTokens} tokens) passou do orçamento da ficha (${budget.sheetTokens}). O orçamento é referência/alerta: o cliente não pode ser interrompido no meio da resposta.`);
  return out;
}

function directorLimitations(ctx: SourceContext, budget: RunBudget) {
  const out = ["Nada foi executado: as tarefas são propostas de delegação e nenhum outro colaborador foi acionado."];
  if (ctx.kind === "none") out.push("Sem fonte do projeto: o plano considera apenas a descrição e os critérios de aceite.");
  if (ctx.kind === "folder") out.push("Os arquivos da pasta local NÃO foram lidos: o Diretor recebeu apenas nome, quantidade, tamanho e extensões. O envio real dos arquivos pertence a uma etapa futura.");
  if (ctx.kind === "github") {
    out.push(`Leitura parcial do repositório: ${ctx.files.length} arquivo(s) lido(s) (limites: ${ctx.limits.maxFiles} arquivos, ${ctx.limits.maxFileBytes} caracteres por arquivo, ${ctx.limits.maxTotalChars} no total). O restante não foi lido.`);
    if (ctx.files.some(f => f.truncated)) out.push("Alguns arquivos foram lidos apenas em parte (truncados).");
    if (ctx.treeTruncated) out.push("A listagem de arquivos do GitHub veio truncada.");
  }
  return [...out, ...usageNotes(budget)];
}

export function architectLimitations(ctx: SourceContext, budget: RunBudget) {
  const out = [
    "O Arquiteto não editou arquivos, não executou comandos nem testes e não acessou a rede: a execução não tem ferramentas e roda sem acesso ao repositório (somente o texto enviado pelo executor).",
    "A análise fica registrada. O Desenvolvedor não foi acionado e nada foi delegado automaticamente.",
  ];
  if (ctx.kind === "github") {
    out.push(`Leitura limitada no commit ${ctx.commit.slice(0, 12)}: ${ctx.files.length} arquivo(s) com conteúdo enviado (limites: ${ctx.limits.maxFiles} arquivos, ${ctx.limits.maxFileBytes} caracteres por arquivo, ${ctx.limits.maxTotalChars} no total). Qualquer outro arquivo não foi lido.`);
    if (ctx.files.some(f => f.truncated)) out.push("Alguns arquivos foram enviados apenas em parte (truncados).");
  }
  if (ctx.kind === "folder") out.push("Os arquivos da pasta local não foram lidos nem enviados.");
  if (ctx.kind === "none") out.push("Sem fonte do projeto: a análise se baseia apenas na demanda, na tarefa e no resumo do plano.");
  return [...out, ...usageNotes(budget)];
}

function keywords(...texts: string[]) {
  return [...new Set(texts.join(" ").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").split(/[^a-z0-9_-]+/))];
}

type Prepared = { system: string; user: string; context: SourceContext; readPaths: string[]; answered?: string[]; partial?: Record<string, string> };
type Outcome = { status: RunStatus; result: object; message: string };
type Spec = {
  who: string;
  schema: Record<string, unknown>;
  prepare: (run: RunRecord, budget: RunBudget) => Promise<Prepared>;
  validate: (output: unknown, p: Prepared, budget: RunBudget) => { ok: true; outcome: Outcome } | { ok: false; errors: string[] };
  /** Director: the call is refused when even the text sent exceeds the sheet budget. Architect: the user saw the alert and approved. */
  blockOverBudget: boolean;
};

function directorSpec(deps: PlannerDeps, snap: DirectorSnapshot): Spec {
  const store = deps.store;
  const allowed = [snap.director.id, ...snap.director.handoffTo.filter(id => snap.team.some(t => t.id === id))];
  return {
    who: "Diretor",
    schema: PLAN_JSON_SCHEMA as unknown as Record<string, unknown>,
    blockOverBudget: true,
    async prepare(run, budget) {
      const runId = run.id;
      let context: SourceContext = { kind: "none", note: "Demanda sem fonte de projeto." };
      let sourceText = "";
      const d = snap.demand;
      if (d.source === "github" && d.repo) {
        if (!deps.github.permitted) fail({ code: "github_not_permitted", message: "Leitura do GitHub não permitida: a permissão “GitHub” está desligada na ficha do Diretor.", retryable: false, recovery: ["Ligue a permissão “GitHub” na ficha do Diretor (aba Permissões) ou remova a fonte da demanda."] });
        await store.event(runId, "github", `Lendo o repositório público ${d.repo.owner}/${d.repo.repo} (somente consulta, com limites).`);
        try {
          const r = await readGithubContext({ owner: d.repo.owner, repo: d.repo.repo, branch: d.repo.branch, keywords: keywords(d.title, d.description) }, deps.github);
          context = r.context;
          sourceText = r.text;
        } catch (err) {
          if (err instanceof GithubError) fail({ code: err.code, message: err.message, retryable: ["github_rate_limited", "github_timeout", "github_unavailable"].includes(err.code) });
          throw err;
        }
        const gh = context as Extract<SourceContext, { kind: "github" }>;
        await store.event(runId, "github_done", `${gh.files.length} arquivo(s) lido(s) do commit ${gh.commit.slice(0, 12)}.`, { files: gh.files.map(f => f.path), skipped: gh.skipped });
      } else if (d.source === "github") {
        fail({ code: "invalid_repo", message: "A demanda tem fonte GitHub, mas sem um repositório válido (dono/repositório).", retryable: false });
      } else if (d.source === "folder" && d.folder) {
        context = { kind: "folder", summary: d.folder, note: "Pasta local: apenas metadados disponíveis. O conteúdo dos arquivos não foi enviado nem lido." };
        await store.event(runId, "folder", "Pasta local: o Diretor usará apenas os metadados; os arquivos não foram lidos.");
      }
      await store.update(runId, { context });
      const system = buildSystemPrompt(snap.director);
      const schemaText = JSON.stringify(PLAN_JSON_SCHEMA);
      let user = buildUserMessage({ demand: d, team: snap.team, director: snap.director, allowed, context, sourceText, answers: snap.answers });
      let estimate = estimateTokens(system + user + schemaText);
      for (let i = 0; i < 3 && context.kind === "github" && budget.sheetTokens > 0 && estimate > budget.sheetTokens * 0.6; i++) {
        const shrunk = shrinkGithubText(context as Extract<SourceContext, { kind: "github" }>, sourceText, Math.floor(sourceText.length * 0.55));
        context = shrunk.ctx; sourceText = shrunk.text;
        user = buildUserMessage({ demand: d, team: snap.team, director: snap.director, allowed, context, sourceText, answers: snap.answers });
        estimate = estimateTokens(system + user + schemaText);
        await store.event(runId, "context_trim", "Contexto do repositório reduzido para caber no orçamento da ficha.", { estimatedInputTokens: estimate });
        await store.update(runId, { context });
      }
      budget.estimatedInputTokens = estimate;
      return { system, user, context, readPaths: context.kind === "github" ? context.files.map(f => f.path) : [] };
    },
    validate(output, p, budget) {
      const v = validatePlan(output, allowed);
      if (!v.ok) return v;
      const status = v.plan.outcome === "needs_clarification" ? "awaiting_clarification" : "plan_ready";
      return { ok: true, outcome: { status, result: { ...v.plan, limitations: directorLimitations(p.context, budget) }, message: status === "plan_ready" ? `Plano pronto: ${v.plan.tasks.length} tarefa(s) proposta(s).` : `O Diretor precisa de esclarecimento: ${v.plan.questions.length} pergunta(s).` } };
    },
  };
}

function architectSpec(deps: PlannerDeps): Spec {
  return {
    who: "Arquiteto",
    schema: ANALYSIS_JSON_SCHEMA as unknown as Record<string, unknown>,
    blockOverBudget: false,
    async prepare(run) {
      const detail = (await deps.store.detail(run.id))!;
      if (!detail.prompt || !detail.context) fail({ code: "handoff_incomplete", message: "O encaminhamento não tem a entrada congelada na aprovação. Prepare o envio novamente.", retryable: false, recovery: ["Abra a tarefa e clique em “Enviar ao Arquiteto” de novo."] });
      const context = detail.context!;
      const answered = ((detail.snapshot as ArchitectSnapshot).clarifications ?? []).map(c => c.question);
      const partial = context.kind === "github" ? partialTexts(detail.prompt!.user, context.files) : {};
      return { system: detail.prompt!.system, user: detail.prompt!.user, context, readPaths: context.kind === "github" ? context.files.map(f => f.path) : [], answered, partial };
    },
    validate(output, p, budget) {
      const v = validateAnalysis(output, p.readPaths, p.answered ?? [], p.partial ?? {});
      if (!v.ok) return v;
      const status = v.analysis.outcome === "needs_clarification" ? "awaiting_clarification" : "analysis_ready";
      return { ok: true, outcome: { status, result: { ...v.analysis, limitations: architectLimitations(p.context, budget) }, message: status === "analysis_ready" ? "Análise técnica concluída e registrada." : `O Arquiteto precisa de esclarecimento: ${v.analysis.questions.length} pergunta(s).` } };
    },
  };
}

/** Processes one run. Safe to call more than once: only the caller that claims the run does the work. */
export async function processRun(runId: string, deps: PlannerDeps): Promise<void> {
  const { store } = deps;
  if (!(await store.claim(runId, deps.limits.leaseMs))) return;
  const run = (await store.get(runId))!;
  const snap = (await store.snapshot(runId)) as RunDetail["snapshot"];
  const spec = run.kind === "architect_task" ? architectSpec(deps) : directorSpec(deps, snap as DirectorSnapshot);
  await store.event(runId, "started", run.kind === "architect_task" ? "O executor local iniciou a análise do Arquiteto." : "O executor local iniciou o planejamento.");
  const budget: RunBudget = { ...run.budget, calls: [], reportedTotalTokens: null, exceeded: false };
  const record = (u: CallUsage | null) => {
    if (!u) return;
    budget.calls.push(u);
    const t = reportedTotal(u);
    if (t !== null) budget.reportedTotalTokens = (budget.reportedTotalTokens ?? 0) + t;
    budget.exceeded = budget.sheetTokens > 0 && (budget.reportedTotalTokens ?? 0) > budget.sheetTokens;
  };
  const workDir = path.join(deps.workRoot, runId);
  const lease = setInterval(() => { void store.renewLease(runId, deps.limits.leaseMs); }, Math.max(1000, Math.floor(deps.limits.leaseMs / 3)));
  let conn: ConnectionStatus | null = null;

  try {
    // 1. The chosen official client must be installed and logged in right now.
    conn = await deps.connection();
    await store.event(runId, "connection", `Conexão: ${conn.client} — ${conn.message}`, { state: conn.state, version: conn.version, account: conn.account });
    if (conn.state !== "connected" || !deps.adapter) {
      const code = conn.state === "not_installed" ? "not_installed" : conn.state === "expired" ? "session_expired" : conn.state === "disconnected" ? "not_connected" : "client_error";
      fail({ code, message: `${conn.client}: ${conn.message}`, retryable: false, recovery: conn.steps.length ? conn.steps : recoveryFor(code, conn, spec.who) });
    }
    const adapter = deps.adapter!;

    // 2. Prompt (built now for the Director, frozen at approval for the Architect).
    const prepared = await spec.prepare(run, budget);
    await store.update(runId, { prompt: { system: prepared.system, user: prepared.user }, budget });
    if (spec.blockOverBudget && budget.sheetTokens > 0 && (budget.estimatedInputTokens ?? 0) >= budget.sheetTokens) {
      fail({ code: "budget_insufficient", message: `Orçamento da ficha insuficiente: só o texto enviado pelo Setor IA tem cerca de ${budget.estimatedInputTokens} tokens (estimativa) e o orçamento do ${spec.who} é ${budget.sheetTokens}.`, retryable: false, recovery: [`Aumente o orçamento de tokens do ${spec.who} na ficha (aba Perfil) ou reduza a demanda.`, "Esse orçamento é um limite do Setor IA; o limite da assinatura é controlado pelo próprio Claude/ChatGPT."] });
    }

    // 3. Call through the official client, validate, at most one correction.
    mkdirSync(workDir, { recursive: true });
    let prompt = prepared.user;
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (deps.signal?.aborted) return;
      await store.event(runId, "calling", `Chamando ${conn.client}${run.model ? ` (modelo ${run.model})` : " (modelo padrão do cliente)"}${run.effort ? `, esforço ${run.effort}` : ""}. Texto enviado: cerca de ${estimateTokens(prepared.system + prompt)} tokens (estimativa).`);
      let reply;
      try {
        // Progress from the client is recorded as events: start and API retries always, model output at most every 20 s.
        let lastOutputEvent = 0;
        const onProgress = (p: AgentProgress) => {
          if (p.kind === "model_output" && Date.now() - lastOutputEvent < 20_000) return;
          if (p.kind === "model_output") lastOutputEvent = Date.now();
          void store.event(runId, `client_${p.kind}`, p.message, p.data);
        };
        reply = await adapter.call({ label: attempt === 1 ? (run.kind === "architect_task" ? "análise" : "planejamento") : "correção", system: prepared.system, user: prompt, schema: spec.schema, model: run.model, effort: run.effort, timeoutMs: deps.limits.callTimeoutMs, signal: deps.signal, workDir, onProgress });
      } catch (err) {
        if (err instanceof AgentError) {
          record((err as AgentError & { usage?: CallUsage | null }).usage ?? null);
          if (["not_connected", "session_expired"].includes(err.code)) await store.logConnection(conn.id, false, err.code);
          if (err.code === "canceled") return;
          fail({ code: err.code, message: err.code === "timeout" ? `O cliente não terminou dentro do limite de ${Math.round(deps.limits.callTimeoutMs / 60000)} min do executor e foi encerrado.` : err.message, detail: err.detail, retryable: err.retryable, recovery: recoveryFor(err.code, conn, spec.who, deps.limits.callTimeoutMs) });
        }
        throw err;
      }
      await store.logConnection(conn.id, true, null);
      record(reply.usage);
      await store.update(runId, { rawOutput: reply.text, budget });
      const total = reply.usage ? reportedTotal(reply.usage) : null;
      await store.event(runId, "reply", total !== null ? `Resposta recebida. Uso informado pelo cliente: ${total} tokens${reply.usage?.model ? ` (${reply.usage.model})` : ""}.` : "Resposta recebida. O cliente não informou o uso de tokens.");

      const v = reply.output === null || typeof reply.output !== "object" ? { ok: false as const, errors: ["A resposta não é um JSON válido."] } : spec.validate(reply.output, prepared, budget);
      if (v.ok) {
        const current = await store.get(runId);
        if (current?.status === "canceled") return;
        await store.update(runId, { status: v.outcome.status, result: v.outcome.result as RunRecord["result"], finishedAt: new Date().toISOString(), leaseUntil: null, budget }, ["planning"]);
        await store.event(runId, v.outcome.status, v.outcome.message);
        return;
      }
      await store.event(runId, "invalid_response", `Resposta inválida (${v.errors.length} problema(s)).`, { errors: v.errors });
      if (attempt === 2) fail({ code: "invalid_response", message: "O modelo não produziu uma resposta válida após uma tentativa de correção.", detail: v.errors.join(" | "), retryable: true, recovery: ["Tente novamente. Se repetir, simplifique a demanda ou revise a ficha."] });
      prompt = `${prepared.user}\n\n<resposta_anterior_invalida>\n${reply.text.slice(0, 20000)}\n</resposta_anterior_invalida>\nA resposta anterior não passou na validação do Setor IA:\n- ${v.errors.join("\n- ")}\nEnvie a resposta completa corrigida no mesmo formato. Não invente informações para preencher campos.`;
      const next = estimateTokens(prepared.system + prompt);
      if (spec.blockOverBudget && budget.sheetTokens > 0 && (budget.reportedTotalTokens ?? 0) + next >= budget.sheetTokens) {
        fail({ code: "invalid_response", message: "A resposta do modelo foi inválida e o orçamento da ficha não comporta uma tentativa de correção.", detail: v.errors.join(" | "), retryable: true, recovery: [`Aumente o orçamento do ${spec.who} na ficha e tente novamente.`] });
      }
      await store.event(runId, "correction", "Pedindo uma correção ao modelo (uma única tentativa).");
    }
  } catch (err) {
    const e: RunError = err instanceof RunFailure ? err.err
      : { code: "internal", message: "Falha interna do executor.", retryable: true, detail: (err as Error)?.message, recovery: ["Tente novamente. Se repetir, veja o terminal do executor."] };
    const current = await store.get(runId);
    if (current?.status === "canceled") return;
    await store.update(runId, { status: "failed", error: e, finishedAt: new Date().toISOString(), leaseUntil: null, budget }, ["planning"]);
    await store.event(runId, "failed", e.message, e.detail ? { detail: e.detail } : undefined);
  } finally {
    clearInterval(lease);
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

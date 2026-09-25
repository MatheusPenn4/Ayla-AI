// Director planning pipeline (phase 1), run inside the local executor.
// Every step is bounded and recorded as an event. Nothing is simulated: when
// the chosen official client is not usable the run fails with the reason and
// the steps to recover. No other collaborator is called; proposed tasks are
// only proposals.
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { PLAN_JSON_SCHEMA, validatePlan } from "@/lib/engine/plan-schema";
import { buildSystemPrompt, buildUserMessage } from "@/lib/engine/prompt";
import type { CallUsage, ConnectionStatus, RunBudget, RunDetail, RunError, SourceContext } from "@/lib/engine/types";
import { LOGIN_STEPS } from "./clients";
import { AgentError, type AgentAdapter, type AgentErrorCode } from "./adapters/types";
import { GithubError, readGithubContext, shrinkGithubText } from "./github";
import type { RunStore } from "./store";

export type PlannerDeps = {
  store: RunStore;
  /** Fresh status of the chosen connection (checked right before the call). */
  connection: () => Promise<ConnectionStatus>;
  /** Adapter for the chosen connection; null when the client is not installed. */
  adapter: AgentAdapter | null;
  limits: { callTimeoutMs: number; leaseMs: number };
  github: { fetch?: typeof fetch; token?: string; apiBase?: string; rawBase?: string; permitted: boolean };
  /** Parent folder for per-call empty working directories. */
  workRoot: string;
  signal?: AbortSignal;
};

const schema = PLAN_JSON_SCHEMA as unknown as Record<string, unknown>;
/** Rough estimate used only before the call; the reported figures replace it afterwards. */
export const estimateTokens = (text: string) => Math.ceil(text.length / 3.5);

class RunFailure extends Error {
  constructor(public err: RunError) { super(err.message); }
}
const fail = (err: RunError): never => { throw new RunFailure(err); };

function recoveryFor(code: AgentErrorCode | string, conn: ConnectionStatus | null): string[] {
  const id = conn?.id ?? "claude_code";
  switch (code) {
    case "not_installed": return LOGIN_STEPS[id].install;
    case "not_connected": return LOGIN_STEPS[id].login;
    case "session_expired": return LOGIN_STEPS[id].expired;
    case "usage_limit": return ["Aguarde a renovação do limite da assinatura (o cliente não informa o saldo restante ao Setor IA).", "Ou escolha a outra conexão na ficha do Diretor e clique em “Planejar novamente”."];
    case "model_unavailable": return ["Na ficha do Diretor (aba Perfil), deixe o modelo em “Padrão do cliente” ou escolha um modelo listado pelo próprio cliente.", "Depois clique em “Planejar novamente”."];
    case "timeout": case "connection_lost": case "client_error": case "interrupted": return ["Verifique a conexão de rede e clique em “Planejar novamente”.", "Se repetir, rode o mesmo cliente no seu terminal para ver a mensagem completa."];
    default: return ["Clique em “Planejar novamente”."];
  }
}

function limitationsFor(ctx: SourceContext, budget: RunBudget) {
  const out = ["Nada foi executado: as tarefas são propostas de delegação e nenhum outro colaborador foi acionado."];
  if (ctx.kind === "none") out.push("Sem fonte do projeto: o plano considera apenas a descrição e os critérios de aceite.");
  if (ctx.kind === "folder") out.push("Os arquivos da pasta local NÃO foram lidos: o Diretor recebeu apenas nome, quantidade, tamanho e extensões. O envio real dos arquivos pertence a uma etapa futura.");
  if (ctx.kind === "github") {
    out.push(`Leitura parcial do repositório: ${ctx.files.length} arquivo(s) lido(s) (limites: ${ctx.limits.maxFiles} arquivos, ${ctx.limits.maxFileBytes} caracteres por arquivo, ${ctx.limits.maxTotalChars} no total). O restante não foi lido.`);
    if (ctx.files.some(f => f.truncated)) out.push("Alguns arquivos foram lidos apenas em parte (truncados).");
    if (ctx.treeTruncated) out.push("A listagem de arquivos do GitHub veio truncada.");
  }
  if (budget.reportedTotalTokens === null) out.push("O cliente não informou o uso de tokens desta execução.");
  if (budget.exceeded) out.push(`O uso informado pelo cliente (${budget.reportedTotalTokens} tokens) passou do orçamento da ficha (${budget.sheetTokens}). O cliente não pode ser interrompido no meio da resposta; ajuste o orçamento ou a demanda.`);
  return out;
}

function keywords(title: string, description: string) {
  return [...new Set(`${title} ${description}`.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").split(/[^a-z0-9_-]+/))];
}

const totalOf = (u: CallUsage) => u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;

/** Processes one run. Safe to call more than once: only the caller that claims the run does the work. */
export async function processRun(runId: string, deps: PlannerDeps): Promise<void> {
  const { store } = deps;
  if (!(await store.claim(runId, deps.limits.leaseMs))) return;
  await store.event(runId, "started", "O executor local iniciou o planejamento.");
  const run = (await store.get(runId))!;
  const snap = (await store.snapshot(runId)) as RunDetail["snapshot"];
  const budget: RunBudget = { ...run.budget, calls: [], reportedTotalTokens: null, exceeded: false };
  const record = (u: CallUsage | null) => {
    if (!u) return;
    budget.calls.push(u);
    budget.reportedTotalTokens = (budget.reportedTotalTokens ?? 0) + totalOf(u);
    budget.exceeded = budget.sheetTokens > 0 && budget.reportedTotalTokens > budget.sheetTokens;
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
      fail({ code, message: `${conn.client}: ${conn.message}`, retryable: false, recovery: conn.steps.length ? conn.steps : recoveryFor(code, conn) });
    }
    const adapter = deps.adapter!;

    // 2. Source context.
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

    // 3. Prompt + estimate against the sheet budget (shrinking repository text if needed).
    const director = snap.director;
    const allowed = [director.id, ...director.handoffTo.filter(id => snap.team.some(t => t.id === id))];
    const system = buildSystemPrompt(director);
    let user = buildUserMessage({ demand: d, team: snap.team, director, allowed, context, sourceText, answers: snap.answers });
    let estimate = estimateTokens(system + user + JSON.stringify(schema));
    for (let i = 0; i < 3 && context.kind === "github" && budget.sheetTokens > 0 && estimate > budget.sheetTokens * 0.6; i++) {
      const shrunk = shrinkGithubText(context as Extract<SourceContext, { kind: "github" }>, sourceText, Math.floor(sourceText.length * 0.55));
      context = shrunk.ctx; sourceText = shrunk.text;
      user = buildUserMessage({ demand: d, team: snap.team, director, allowed, context, sourceText, answers: snap.answers });
      estimate = estimateTokens(system + user + JSON.stringify(schema));
      await store.event(runId, "context_trim", "Contexto do repositório reduzido para caber no orçamento da ficha.", { estimatedInputTokens: estimate });
      await store.update(runId, { context });
    }
    budget.estimatedInputTokens = estimate;
    await store.update(runId, { prompt: { system, user }, budget });
    if (budget.sheetTokens > 0 && estimate >= budget.sheetTokens) {
      fail({ code: "budget_insufficient", message: `Orçamento da ficha insuficiente: só o texto enviado pelo Setor IA tem cerca de ${estimate} tokens (estimativa) e o orçamento do Diretor é ${budget.sheetTokens}.`, retryable: false, recovery: ["Aumente o orçamento de tokens do Diretor na ficha (aba Perfil) ou reduza a demanda.", "Esse orçamento é um limite do Setor IA; o limite da assinatura é controlado pelo próprio Claude/ChatGPT."] });
    }

    // 4. Call through the official client, validate, at most one correction.
    mkdirSync(workDir, { recursive: true });
    let prompt = user;
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (deps.signal?.aborted) return;
      await store.event(runId, "calling", `Chamando ${conn.client}${run.model ? ` (modelo ${run.model})` : " (modelo padrão do cliente)"}${run.effort ? `, esforço ${run.effort}` : ""}. Texto enviado: cerca de ${estimateTokens(system + prompt)} tokens (estimativa).`);
      let reply;
      try {
        reply = await adapter.call({ label: attempt === 1 ? "planejamento" : "correção", system, user: prompt, schema, model: run.model, effort: run.effort, timeoutMs: deps.limits.callTimeoutMs, signal: deps.signal, workDir });
      } catch (err) {
        if (err instanceof AgentError) {
          record((err as AgentError & { usage?: CallUsage | null }).usage ?? null);
          if (["not_connected", "session_expired"].includes(err.code)) await store.logConnection(conn.id, false, err.code);
          if (err.code === "canceled") return;
          fail({ code: err.code, message: err.message, detail: err.detail, retryable: err.retryable, recovery: recoveryFor(err.code, conn) });
        }
        throw err;
      }
      await store.logConnection(conn.id, true, null);
      record(reply.usage);
      await store.update(runId, { rawOutput: reply.text, budget });
      await store.event(runId, "reply", reply.usage ? `Resposta recebida. Uso informado pelo cliente: ${totalOf(reply.usage)} tokens${reply.usage.model ? ` (${reply.usage.model})` : ""}.` : "Resposta recebida. O cliente não informou o uso de tokens.");

      const errors = reply.output === null || typeof reply.output !== "object" ? ["A resposta não é um JSON válido."] : (() => { const v = validatePlan(reply.output, allowed); return v.ok ? v : v.errors; })();
      if (!Array.isArray(errors)) {
        const plan = errors.plan;
        const current = await store.get(runId);
        if (current?.status === "canceled") return;
        const status = plan.outcome === "needs_clarification" ? "awaiting_clarification" : "plan_ready";
        await store.update(runId, { status, result: { ...plan, limitations: limitationsFor(context, budget) }, finishedAt: new Date().toISOString(), leaseUntil: null, budget }, ["planning"]);
        await store.event(runId, status, status === "plan_ready" ? `Plano pronto: ${plan.tasks.length} tarefa(s) proposta(s).` : `O Diretor precisa de esclarecimento: ${plan.questions.length} pergunta(s).`);
        return;
      }
      await store.event(runId, "invalid_response", `Resposta inválida (${errors.length} problema(s)).`, { errors });
      if (attempt === 2) fail({ code: "invalid_response", message: "O modelo não produziu uma resposta válida após uma tentativa de correção.", detail: errors.join(" | "), retryable: true, recovery: ["Clique em “Planejar novamente”. Se repetir, simplifique a demanda ou revise a ficha do Diretor."] });
      prompt = `${user}\n\n<resposta_anterior_invalida>\n${reply.text.slice(0, 20000)}\n</resposta_anterior_invalida>\nA resposta anterior não passou na validação do Setor IA:\n- ${errors.join("\n- ")}\nEnvie a resposta completa corrigida no mesmo formato. Não invente informações para preencher campos.`;
      const next = estimateTokens(system + prompt);
      if (budget.sheetTokens > 0 && (budget.reportedTotalTokens ?? 0) + next >= budget.sheetTokens) {
        fail({ code: "invalid_response", message: "A resposta do modelo foi inválida e o orçamento da ficha não comporta uma tentativa de correção.", detail: errors.join(" | "), retryable: true, recovery: ["Aumente o orçamento do Diretor na ficha e clique em “Planejar novamente”."] });
      }
      await store.event(runId, "correction", "Pedindo uma correção ao modelo (uma única tentativa).");
    }
  } catch (err) {
    const e: RunError = err instanceof RunFailure ? err.err
      : { code: "internal", message: "Falha interna do executor.", retryable: true, detail: (err as Error)?.message, recovery: ["Clique em “Planejar novamente”. Se repetir, veja o terminal do executor."] };
    const current = await store.get(runId);
    if (current?.status === "canceled") return;
    await store.update(runId, { status: "failed", error: e, finishedAt: new Date().toISOString(), leaseUntil: null, budget }, ["planning"]);
    await store.event(runId, "failed", e.message, e.detail ? { detail: e.detail } : undefined);
  } finally {
    clearInterval(lease);
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

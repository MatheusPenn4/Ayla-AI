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
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { ANALYSIS_JSON_SCHEMA, partialTexts, validateAnalysis } from "@/lib/engine/analysis-schema";
import { DEVELOPER_JSON_SCHEMA, validateDeveloperResult } from "@/lib/engine/developer-schema";
import { QA_JSON_SCHEMA, validateQAResult } from "@/lib/engine/qa-schema";
import { REVIEWER_JSON_SCHEMA, validateReviewerResult } from "@/lib/engine/reviewer-schema";
import { PLAN_JSON_SCHEMA, validatePlan } from "@/lib/engine/plan-schema";
import { buildSystemPrompt, buildUserMessage } from "@/lib/engine/prompt";
import { reportedTotal, type ArchitectSnapshot, type CallUsage, type ConnectionId, type ConnectionStatus, type DeveloperDiff, type DeveloperSnapshot, type DirectorSnapshot, type EditScopeEntry, type QAResult, type QASnapshot, type ReviewerSnapshot, type RunBudget, type RunDetail, type RunError, type RunRecord, type RunStatus, type SourceContext } from "@/lib/engine/types";
import { LOGIN_STEPS } from "./clients";
import { AgentError, type AgentAdapter, type AgentErrorCode, type AgentProgress } from "./adapters/types";
import { GithubError, readGithubContext, shrinkGithubText } from "./github";
import { LocalSourceError, readDirectorLocalContext } from "./local-source";
import { listLocalRepos, type GitDeps } from "./local-git";
import { KNOWN_LIMITATIONS } from "./qa";
import type { AppFixture } from "./qa-browser";
import type { EnvDeps } from "./qa-env";
import { runToolQA } from "./qa-run";
import type { ProjectDeps } from "./projects";
import type { RunStore } from "./store";
import { destroyWorktree, diffWorktree, materializeCommit } from "./worktree";

export type PlannerDeps = {
  store: RunStore;
  /** Fresh status of the chosen connection (checked right before the call). */
  connection: () => Promise<ConnectionStatus>;
  /** Adapter for the chosen connection; null when the client is not installed. */
  adapter: AgentAdapter | null;
  limits: { callTimeoutMs: number; leaseMs: number };
  /** Used by the Director only (the Architect's sources were read when the hand-off was prepared). */
  github: { fetch?: typeof fetch; token?: string; apiBase?: string; rawBase?: string; permitted: boolean };
  /** Local Git clones authorized for reading — the Developer materializes its isolated copy from here. */
  local?: { dirs: string[]; git: GitDeps };
  /** Director only, demand source "Projeto local autorizado": the authorized projects, and whether the Director sheet allows reading files. */
  projects?: ProjectDeps;
  localReadPermitted?: boolean;
  /** Parent folder for per-call empty working directories. */
  workRoot: string;
  signal?: AbortSignal;
  /** Tool-equipped QA only: how to build its isolated environment, where its artifacts live, its app fixture. */
  qa?: { envDeps: EnvDeps; projects: ProjectDeps; artifactsRoot: string; fixture: (planId: string, srcDir: string) => Promise<AppFixture | null> };
};

/** How a sheet's model choice is described: "" means the client picks it (its own default), never the Setor IA. */
export const modelPhrase = (model: string) => (model ? `modelo ${model}` : "modelo escolhido pelo próprio cliente (a ficha usa o padrão dele; o modelo usado é registrado ao final)");

/** Rough estimate used only before the call; the reported figures replace it afterwards. */
export const estimateTokens = (text: string) => Math.ceil(text.length / 3.5);

export class RunFailure extends Error {
  constructor(public err: RunError, public rejectedDiff?: DeveloperDiff | null) { super(err.message); }
}
const fail = (err: RunError, rejectedDiff?: DeveloperDiff | null): never => { throw new RunFailure(err, rejectedDiff); };

function recoveryFor(code: AgentErrorCode | string, conn: ConnectionStatus | null, who: string, timeoutMs = 0): string[] {
  if (conn?.id === "api") {
    switch (code) {
      case "not_connected": return ["A chave de API foi recusada (inválida ou revogada).", "Abra Configurações → Conexões de IA, corrija ou substitua a chave e teste a sessão."];
      case "usage_limit": return ["A API recusou por limite de uso/taxa (a cobrança é separada das assinaturas Claude/ChatGPT).", `Aguarde e tente novamente, ou escolha outra conexão na ficha do ${who}.`];
      case "model_unavailable": return [`Na ficha do ${who} (aba Perfil), deixe o modelo em branco (padrão) ou use um nome de modelo válido para o provedor.`];
      case "output_too_large": return ["A resposta foi cortada pelo limite de tokens de saída desta versão (sem streaming). Simplifique a demanda/tarefa ou escolha outra conexão."];
      default: return ["Verifique a chave em Configurações → Conexões de IA e tente novamente."];
    }
  }
  const id = (conn?.id ?? "claude_code") as ConnectionId;
  switch (code) {
    case "not_installed": return LOGIN_STEPS[id].install;
    case "not_connected": return LOGIN_STEPS[id].login;
    case "session_expired": return LOGIN_STEPS[id].expired;
    case "auth_busy": return [
      "Espere cerca de um minuto e prepare um novo envio: o cliente diz que costuma ser passageiro.",
      "Se repetir, feche as outras sessões do mesmo cliente e, no seu terminal, rode o cliente uma vez (claude) para ele mesmo renovar o login; se ele pedir, entre de novo (claude auth login --claudeai).",
      "O Setor IA não mexe nos arquivos de login nem na trava de renovação do cliente.",
    ];
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
    out.push(`Leitura parcial ${ctx.via === "local_git" ? "do projeto local" : "do repositório"}: ${ctx.files.length} arquivo(s) lido(s) (limites: ${ctx.limits.maxFiles} arquivos, ${ctx.limits.maxFileBytes} caracteres por arquivo, ${ctx.limits.maxTotalChars} no total). O restante não foi lido.`);
    if (ctx.files.some(f => f.truncated)) out.push("Alguns arquivos foram lidos apenas em parte (truncados).");
    if (ctx.treeTruncated) out.push("A listagem de arquivos do GitHub veio truncada.");
    if (ctx.via === "local_git") {
      out.push(`Só objetos commitados do commit ${ctx.commit.slice(0, 12)} foram lidos (sem GitHub, sem checkout)${ctx.local?.dirty?.count ? `; ${ctx.local.dirty.count} alteração(ões) local(is) não commitada(s) ficaram FORA do contexto` : ""}.`);
      if (ctx.withheld) out.push(`${ctx.withheld.count} arquivo(s) de configuração pessoal ou credenciais foram omitidos do contexto por proteção (${ctx.withheld.examples.join(", ")}).`);
      if (ctx.files.some(f => f.redactions)) out.push("Strings com aparência de credencial foram trocadas por [REDACTED] no texto enviado.");
    }
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

type Prepared = {
  system: string; user: string; context: SourceContext | null; readPaths: string[]; answered?: string[]; partial?: Record<string, string>;
  /** Developer only: where the isolated working copy lives, how to diff it, and what it may touch. */
  runId?: string; workDir?: string; hooksDir?: string; gitDeps?: GitDeps; editScope?: EditScopeEntry[]; baseCommit?: string;
  /** QA only: the demand's own acceptance criteria, verbatim — every one must be classified exactly once. */
  qaExpectedCriteria?: string[];
  /** Reviewer only: the QA parecer this review is built on — the verdict may never contradict it. */
  reviewerQaResult?: QAResult;
};
type Outcome = { status: RunStatus; result: object; message: string };
/** Developer only: `diff` on the failure branch carries the real diff even when it was rejected, so it can be kept for inspection. */
type ValidateResult = { ok: true; outcome: Outcome } | { ok: false; errors: string[]; diff?: DeveloperDiff };
type Spec = {
  who: string;
  schema: Record<string, unknown>;
  prepare: (run: RunRecord, budget: RunBudget) => Promise<Prepared>;
  validate: (output: unknown, p: Prepared, budget: RunBudget) => ValidateResult | Promise<ValidateResult>;
  /** Director: the call is refused when even the text sent exceeds the sheet budget. Architect/Developer: the user saw the alert and approved. */
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
      } else if (d.source === "local") {
        if (!d.local || !deps.projects) fail({ code: "local_not_authorized", message: "A demanda tem fonte “Projeto local autorizado”, mas este executor não tem os projetos locais disponíveis.", retryable: false, recovery: ["Reinicie o executor (pnpm executor) e tente de novo."] });
        if (deps.localReadPermitted === false) fail({ code: "local_not_permitted", message: "Leitura de arquivos não permitida: a permissão “Ler arquivos” está desligada na ficha do Diretor.", retryable: false, recovery: ["Ligue a permissão “Ler arquivos” na ficha do Diretor (aba Permissões) ou troque a fonte da demanda."] });
        const l = d.local!;
        await store.event(runId, "local_source", `Lendo o projeto local autorizado “${l.projectLabel ?? l.projectId}” no commit ${l.commit.slice(0, 12)}${l.ref ? ` (referência ${l.ref})` : ""}: somente objetos Git, sem GitHub e sem alterações não commitadas.`);
        try {
          const r = await readDirectorLocalContext(l, { title: d.title, description: d.description }, deps.projects!);
          context = r.context;
          sourceText = r.text;
        } catch (err) {
          if (err instanceof LocalSourceError) fail({ code: err.code, message: err.message, retryable: false, recovery: ["Abra a demanda, escolha o projeto e a referência de novo (o SHA resolvido aparece antes de planejar) e tente outra vez."] });
          if (err instanceof GithubError) fail({ code: err.code, message: err.message, retryable: false });
          throw err;
        }
        const lc = context as Extract<SourceContext, { kind: "github" }>;
        await store.event(runId, "local_done", `${lc.files.length} arquivo(s) lido(s) do commit ${lc.commit.slice(0, 12)} do projeto local.${lc.local?.dirty?.count ? ` ${lc.local.dirty.count} alteração(ões) não commitada(s) ficaram fora do contexto.` : ""}`, { files: lc.files.map(f => f.path), skipped: lc.skipped, withheld: lc.withheld ?? null, dirty: lc.local?.dirty ?? null, textSha256: lc.local?.textSha256 ?? null });
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
        // The hash recorded for a local read must be that of the text actually sent.
        if (context.kind === "github" && context.local?.textSha256) context = { ...context, local: { ...context.local, textSha256: createHash("sha256").update(sourceText).digest("hex") } };
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
      return { ok: true, outcome: { status, result: { ...v.plan, limitations: directorLimitations(p.context!, budget) }, message: status === "plan_ready" ? `Plano pronto: ${v.plan.tasks.length} tarefa(s) proposta(s).` : `O Diretor precisa de esclarecimento: ${v.plan.questions.length} pergunta(s).` } };
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
      return { ok: true, outcome: { status, result: { ...v.analysis, limitations: architectLimitations(p.context!, budget) }, message: status === "analysis_ready" ? "Análise técnica concluída e registrada." : `O Arquiteto precisa de esclarecimento: ${v.analysis.questions.length} pergunta(s).` } };
    },
  };
}

function qaLimitations(budget: RunBudget) {
  return [
    "QA não teve nenhuma ferramenta nesta execução: não leu o repositório, não editou, não rodou comando nem acessou a rede. Tudo o que classificou veio do texto de entregas reais preparado pelo executor.",
    "Um build, typecheck, lint ou teste automatizado passando não é, por si só, validação funcional de um critério de aceite do usuário — só evidência de qualidade de código.",
    ...KNOWN_LIMITATIONS,
    ...usageNotes(budget),
  ];
}

function toolQALimitations(r: QAResult, budget: RunBudget) {
  const env = r.environment;
  const out = [
    "O modelo do QA não recebeu nenhuma ferramenta: pediu operações de um catálogo fixo e o executor local as executou no ambiente isolado; toda observação citada vem de evidência produzida pelo executor.",
    "Um build, typecheck, lint ou teste automatizado passando não é, por si só, validação funcional de um critério de aceite do usuário — só evidência de qualidade de código.",
    (env?.apiRequests.servedFromFixture ?? 0) > 0 || (env?.apiRequests.blocked ?? 0) > 0
      ? "O navegador de QA usou dados simulados somente leitura desta demanda; ações que executariam agentes foram bloqueadas (nenhuma chamada paga partiu dele)."
      : "O navegador de QA usou a aplicação em teste rodando na cópia isolada, com as variáveis de teste configuradas no projeto; outras origens foram bloqueadas.",
    "Isolamento de rede dos comandos não é imposto pelo sistema operacional nesta versão: a preparação de dependências usa o store local sem rede (e só recorre à rede se isso falhar); os comandos rodam sem credenciais nem sessões dos clientes; o navegador só acessa a origem da aplicação em teste.",
  ];
  if (env?.modifiedDeliveryFiles.length) out.push(`ATENÇÃO: arquivos versionados da entrega mudaram durante a revisão: ${env.modifiedDeliveryFiles.join(", ")}.`);
  return [...out, ...usageNotes(budget)];
}

function qaSpec(deps: PlannerDeps): Spec {
  return {
    who: "QA",
    schema: QA_JSON_SCHEMA as unknown as Record<string, unknown>,
    blockOverBudget: false,
    async prepare(run) {
      const detail = (await deps.store.detail(run.id))!;
      if (!detail.prompt) fail({ code: "handoff_incomplete", message: "O encaminhamento não tem a entrada congelada na aprovação. Prepare o envio novamente.", retryable: false, recovery: ["Abra a tarefa e clique em “Enviar ao QA” de novo."] });
      const snap = detail.snapshot as QASnapshot;
      return { system: detail.prompt!.system, user: detail.prompt!.user, context: null, readPaths: [], qaExpectedCriteria: snap.demand.acceptanceCriteria };
    },
    validate(output, p, budget) {
      const v = validateQAResult(output, p.qaExpectedCriteria ?? []);
      if (!v.ok) return v;
      const status = v.result.outcome === "needs_clarification" ? "awaiting_clarification" : "review_ready";
      return { ok: true, outcome: { status, result: { ...v.result, limitations: qaLimitations(budget) }, message: status === "review_ready" ? `Revisão de QA concluída: ${v.result.criteria.filter(c => c.verdict === "approved").length}/${v.result.criteria.length} critério(s) aprovado(s).` : `O QA precisa de esclarecimento: ${v.result.questions.length} pergunta(s).` } };
    },
  };
}

function reviewerLimitations(budget: RunBudget) {
  return [
    "O Revisor não teve nenhuma ferramenta nesta execução: não leu o repositório, não editou, não rodou comando nem acessou a rede. Reaproveitou exatamente o parecer do QA e as entregas reais que o próprio QA recebeu, sem uma segunda leitura independente do repositório.",
    "Um build, typecheck, lint ou teste automatizado passando não é, por si só, validação funcional de um critério de aceite do usuário — só evidência de qualidade de código.",
    ...KNOWN_LIMITATIONS,
    ...usageNotes(budget),
  ];
}

function reviewerSpec(deps: PlannerDeps): Spec {
  return {
    who: "Revisor",
    schema: REVIEWER_JSON_SCHEMA as unknown as Record<string, unknown>,
    blockOverBudget: false,
    async prepare(run) {
      const detail = (await deps.store.detail(run.id))!;
      if (!detail.prompt) fail({ code: "handoff_incomplete", message: "O encaminhamento não tem a entrada congelada na aprovação. Prepare o envio novamente.", retryable: false, recovery: ["Abra a tarefa e clique em “Enviar ao Revisor” de novo."] });
      const snap = detail.snapshot as ReviewerSnapshot;
      return { system: detail.prompt!.system, user: detail.prompt!.user, context: null, readPaths: [], reviewerQaResult: snap.qa.result };
    },
    validate(output, p, budget) {
      const v = validateReviewerResult(output, p.reviewerQaResult!);
      if (!v.ok) return v;
      const status = v.result.outcome === "needs_clarification" ? "awaiting_clarification" : "concluded";
      return { ok: true, outcome: { status, result: { ...v.result, limitations: reviewerLimitations(budget) }, message: status === "concluded" ? `Parecer final concluído: ${v.result.verdict}.` : `O Revisor precisa de esclarecimento: ${v.result.questions.length} pergunta(s).` } };
    },
  };
}

function developerLimitations(diff: DeveloperDiff, budget: RunBudget) {
  const out = [
    "Nenhum comando foi executado nesta execução: sem ferramenta de terminal nesta versão, tipos, lint, testes e build continuam sem verificação real.",
    "Nada foi aplicado ao projeto original, commitado, publicado ou enviado ao QA: o resultado existiu só na cópia isolada (já removida) e fica registrado aqui (diff e relatório).",
  ];
  if (diff.diffTruncated) out.push(`O diff mostrado foi cortado por tamanho; o diff real pode ser maior que o texto exibido.`);
  return [...out, ...usageNotes(budget)];
}

function developerSpec(deps: PlannerDeps): Spec {
  return {
    who: "Desenvolvedor",
    schema: DEVELOPER_JSON_SCHEMA as unknown as Record<string, unknown>,
    blockOverBudget: false,
    async prepare(run) {
      const detail = (await deps.store.detail(run.id))!;
      if (!detail.prompt) fail({ code: "handoff_incomplete", message: "O encaminhamento não tem a entrada congelada na aprovação. Prepare o envio novamente.", retryable: false, recovery: ["Abra a tarefa e clique em “Enviar ao Desenvolvedor” de novo."] });
      const snap = detail.snapshot as DeveloperSnapshot;
      if (!deps.local?.dirs.length) fail({ code: "local_not_authorized", message: "Nenhuma cópia local autorizada está configurada (AYLA_LOCAL_REPOS); o Desenvolvedor não tem de onde montar a cópia isolada.", retryable: false, recovery: ["Configure AYLA_LOCAL_REPOS e prepare o envio novamente."] });
      const repos = await listLocalRepos(deps.local!.dirs, deps.local!.git);
      const repo = repos.find(r => r.owner.toLowerCase() === snap.base.owner.toLowerCase() && r.repo.toLowerCase() === snap.base.repo.toLowerCase() && r.dirName === snap.base.dirName);
      if (!repo) fail({ code: "local_not_authorized", message: "A cópia local autorizada usada no preparo deste envio não está mais disponível.", retryable: false, recovery: ["Prepare o envio novamente."] });
      const workDir = path.join(deps.workRoot, run.id);
      await deps.store.event(run.id, "worktree", `Preparando a cópia de trabalho isolada do commit ${snap.base.commit.slice(0, 12)} (git archive, sem node_modules, sem histórico do projeto real)…`);
      let m;
      try { m = await materializeCommit({ sourceDir: repo!.dir, commit: snap.base.commit, workDir }, deps.local!.git); }
      catch (err) { if (err instanceof GithubError) fail({ code: err.code, message: err.message, retryable: false }); throw err; }
      await deps.store.event(run.id, "worktree_ready", `Cópia isolada pronta: ${m.fileCount} arquivo(s). O modelo só enxerga esta pasta.`);
      return {
        system: detail.prompt!.system, user: detail.prompt!.user, context: null, readPaths: [],
        runId: run.id, workDir: m.workDir, hooksDir: m.hooksDir, gitDeps: deps.local!.git, editScope: snap.editScope, baseCommit: snap.base.commit,
      };
    },
    async validate(output, p, budget) {
      const d = await diffWorktree({ workDir: p.workDir!, hooksDir: p.hooksDir! }, p.gitDeps!);
      const editable = new Set((p.editScope ?? []).filter(e => e.action !== "consultar").map(e => e.path));
      const touched = [...new Set(d.files.map(f => f.path))];
      const outOfScope = touched.filter(t => !editable.has(t));
      const files = d.files.map(f => ({ ...f, inScope: !outOfScope.includes(f.path) }));
      await deps.store.event(p.runId!, "diff", `Diff real da cópia isolada: ${files.length} arquivo(s) tocado(s) (${files.filter(f => f.status === "added").length} criado(s), ${files.filter(f => f.status === "modified").length} alterado(s), ${files.filter(f => f.status === "deleted").length} removido(s))${outOfScope.length ? `; FORA DO ESCOPO APROVADO: ${outOfScope.join(", ")}` : "; todos dentro do escopo aprovado"}.`, { files, diffTruncated: d.diffTruncated, diffSha256: createHash("sha256").update(d.diffText).digest("hex") });
      // The hash is recorded now, when the executor itself computed the diff, and checked again before it is applied anywhere.
      const diffSha256 = createHash("sha256").update(d.diffText).digest("hex");
      const diff: DeveloperDiff = { baseCommit: p.baseCommit!, files, diffText: d.diffText, diffTruncated: d.diffTruncated, outOfScope, diffSha256 };
      const v = validateDeveloperResult(output, touched, outOfScope);
      if (!v.ok) return { ok: false, errors: v.errors, diff };
      const status = v.result.outcome === "needs_clarification" ? "awaiting_clarification" : "implementation_ready";
      return { ok: true, outcome: { status, result: { ...v.result, diff, limitations: developerLimitations(diff, budget) }, message: status === "implementation_ready" ? `Implementação pronta na cópia isolada: ${files.length} arquivo(s) tocado(s). Nada foi aplicado ao projeto original.` : `O Desenvolvedor precisa de esclarecimento: ${v.result.questions.length} pergunta(s).` } };
    },
  };
}

/** Processes one run. Safe to call more than once: only the caller that claims the run does the work. */
export async function processRun(runId: string, deps: PlannerDeps): Promise<void> {
  const { store } = deps;
  if (!(await store.claim(runId, deps.limits.leaseMs))) return;
  const run = (await store.get(runId))!;
  const snap = (await store.snapshot(runId)) as RunDetail["snapshot"];
  const spec = run.kind === "architect_task" ? architectSpec(deps) : run.kind === "developer_task" ? developerSpec(deps) : run.kind === "qa_task" ? qaSpec(deps) : run.kind === "reviewer_task" ? reviewerSpec(deps) : directorSpec(deps, snap as DirectorSnapshot);
  await store.event(runId, "started", run.kind === "architect_task" ? "O executor local iniciou a análise do Arquiteto." : run.kind === "qa_task" ? "O executor local iniciou a revisão do QA." : run.kind === "reviewer_task" ? "O executor local iniciou a revisão final do Revisor." : run.kind === "developer_task" ? "O executor local iniciou a implementação do Desenvolvedor." : "O executor local iniciou o planejamento.");
  const budget: RunBudget = { ...run.budget, calls: [], reportedTotalTokens: null, exceeded: false };
  const record = (u: CallUsage | null) => {
    if (!u) return;
    budget.calls.push(u);
    const t = reportedTotal(u);
    if (t !== null) budget.reportedTotalTokens = (budget.reportedTotalTokens ?? 0) + t;
    budget.exceeded = budget.sheetTokens > 0 && (budget.reportedTotalTokens ?? 0) > budget.sheetTokens;
  };
  const workDir = path.join(deps.workRoot, runId);
  // Always a sibling of workDir, never inside it: for the Developer, workDir IS the isolated copy that gets
  // diffed afterwards, and a file the executor writes there (system prompt, output schema) would otherwise be
  // mistaken for an out-of-scope edit (see lib/executor/adapters/claude.ts and worktree.ts).
  const scratchDir = path.join(deps.workRoot, `${runId}.prompt`);
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
    mkdirSync(scratchDir, { recursive: true });

    // 3'. Tool-equipped QA: the executor runs operations between model calls (see qa-run.ts). Same client, same
    // read-only profile (the model itself gets no tool), same error handling, usage and cancellation as below.
    if (run.kind === "qa_task" && (snap as QASnapshot).toolsMode === "executor_operations") {
      if (!deps.qa) fail({ code: "qa_tools_unavailable", message: "Este executor não tem o ambiente de QA configurado.", retryable: false });
      let lastOutputEvent = 0;
      const onProgress = (p: AgentProgress) => {
        if (p.kind === "model_output" && Date.now() - lastOutputEvent < 20_000) return;
        if (p.kind === "model_output") lastOutputEvent = Date.now();
        void store.event(runId, `client_${p.kind}`, p.message, p.data);
      };
      const callModel = async (label: string, user: string, schema: Record<string, unknown>) => {
        if (deps.signal?.aborted) return null;
        await store.event(runId, "calling", `Chamando ${conn!.client} (${modelPhrase(run.model)})${run.effort ? `, esforço ${run.effort}` : ""} — ${label}. Texto enviado: cerca de ${estimateTokens(prepared.system + user)} tokens (estimativa).`);
        try {
          const reply = await adapter.call({ label, system: prepared.system, user, schema, model: run.model, effort: run.effort, timeoutMs: deps.limits.callTimeoutMs, signal: deps.signal, workDir, scratchDir, onProgress, mode: "read_only" });
          await store.logConnection(conn!.id, true, null);
          record(reply.usage);
          await store.update(runId, { rawOutput: reply.text, budget });
          const total = reply.usage ? reportedTotal(reply.usage) : null;
          await store.event(runId, "reply", total !== null ? `Resposta recebida (${label}). Uso informado pelo cliente: ${total} tokens${reply.usage?.model ? ` (${reply.usage.model}${run.model ? "" : " — modelo escolhido pelo cliente"})` : ""}.` : `Resposta recebida (${label}). O cliente não informou o uso de tokens.`);
          return reply;
        } catch (err) {
          if (err instanceof AgentError) {
            record((err as AgentError & { usage?: CallUsage | null }).usage ?? null);
            if (["not_connected", "session_expired", "auth_busy"].includes(err.code)) await store.logConnection(conn!.id, false, err.code);
            if (err.code === "canceled") return null;
            fail({ code: err.code, message: err.code === "timeout" ? `O cliente não terminou dentro do limite de ${Math.round(deps.limits.callTimeoutMs / 60000)} min do executor e foi encerrado.` : err.message, detail: err.detail, retryable: err.retryable, recovery: recoveryFor(err.code, conn, spec.who, deps.limits.callTimeoutMs) });
          }
          throw err;
        }
      };
      const outcome = await runToolQA({
        runId, snap: snap as QASnapshot, prompt: { system: prepared.system, user: prepared.user }, store, envDeps: { ...deps.qa!.envDeps, signal: deps.signal },
        projects: deps.qa!.projects, workRoot: deps.workRoot, artifactsDir: path.join(deps.qa!.artifactsRoot, runId), fixture: deps.qa!.fixture, planId: run.parentRunId ?? "",
        callModel, fail: e => fail(e),
      });
      if (!outcome) return;
      const current = await store.get(runId);
      if (current?.status === "canceled") return;
      await store.update(runId, { status: outcome.status, result: { ...outcome.result, limitations: toolQALimitations(outcome.result as QAResult, budget) } as RunRecord["result"], finishedAt: new Date().toISOString(), leaseUntil: null, budget }, ["planning"]);
      await store.event(runId, outcome.status, outcome.message);
      return;
    }
    let prompt = prepared.user;
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (deps.signal?.aborted) return;
      await store.event(runId, "calling", `Chamando ${conn.client} (${modelPhrase(run.model)})${run.effort ? `, esforço ${run.effort}` : ""}. Texto enviado: cerca de ${estimateTokens(prepared.system + prompt)} tokens (estimativa).`);
      let reply;
      try {
        // Progress from the client is recorded as events: start and API retries always, model output at most every 20 s.
        let lastOutputEvent = 0;
        const onProgress = (p: AgentProgress) => {
          if (p.kind === "model_output" && Date.now() - lastOutputEvent < 20_000) return;
          if (p.kind === "model_output") lastOutputEvent = Date.now();
          void store.event(runId, `client_${p.kind}`, p.message, p.data);
        };
        const label = attempt === 1 ? (run.kind === "architect_task" ? "análise" : run.kind === "developer_task" ? "implementação" : run.kind === "qa_task" ? "revisão" : run.kind === "reviewer_task" ? "revisão final" : "planejamento") : "correção";
        const mode = run.kind === "developer_task" ? "developer_write" : "read_only";
        reply = await adapter.call({ label, system: prepared.system, user: prompt, schema: spec.schema, model: run.model, effort: run.effort, timeoutMs: deps.limits.callTimeoutMs, signal: deps.signal, workDir, scratchDir, onProgress, mode });
      } catch (err) {
        if (err instanceof AgentError) {
          record((err as AgentError & { usage?: CallUsage | null }).usage ?? null);
          if (["not_connected", "session_expired", "auth_busy"].includes(err.code)) await store.logConnection(conn.id, false, err.code);
          if (err.code === "canceled") return;
          fail({ code: err.code, message: err.code === "timeout" ? `O cliente não terminou dentro do limite de ${Math.round(deps.limits.callTimeoutMs / 60000)} min do executor e foi encerrado.` : err.message, detail: err.detail, retryable: err.retryable, recovery: recoveryFor(err.code, conn, spec.who, deps.limits.callTimeoutMs) });
        }
        throw err;
      }
      await store.logConnection(conn.id, true, null);
      record(reply.usage);
      await store.update(runId, { rawOutput: reply.text, budget });
      const total = reply.usage ? reportedTotal(reply.usage) : null;
      await store.event(runId, "reply", total !== null ? `Resposta recebida. Uso informado pelo cliente: ${total} tokens${reply.usage?.model ? ` (${reply.usage.model}${run.model ? "" : " — modelo escolhido pelo cliente"})` : ""}.` : "Resposta recebida. O cliente não informou o uso de tokens.");

      const v = reply.output === null || typeof reply.output !== "object" ? { ok: false as const, errors: ["A resposta não é um JSON válido."] } : await spec.validate(reply.output, prepared, budget);
      if (v.ok) {
        const current = await store.get(runId);
        if (current?.status === "canceled") return;
        await store.update(runId, { status: v.outcome.status, result: v.outcome.result as RunRecord["result"], finishedAt: new Date().toISOString(), leaseUntil: null, budget }, ["planning"]);
        await store.event(runId, v.outcome.status, v.outcome.message);
        return;
      }
      await store.event(runId, "invalid_response", `Resposta inválida (${v.errors.length} problema(s)).`, { errors: v.errors });
      if (attempt === 2) fail({ code: "invalid_response", message: "O modelo não produziu uma resposta válida após uma tentativa de correção.", detail: v.errors.join(" | "), retryable: true, recovery: ["Tente novamente. Se repetir, simplifique a demanda ou revise a ficha."] }, v.diff ?? null);
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
    const rejectedDiff = err instanceof RunFailure ? (err.rejectedDiff ?? null) : null;
    const current = await store.get(runId);
    if (current?.status === "canceled") return;
    // The rejected diff (if any) is kept even though the copy it came from is destroyed right after this:
    // it is the only way to inspect what the model actually wrote when the run is rejected, not applied anywhere.
    await store.update(runId, { status: "failed", error: e, rejectedDiff, finishedAt: new Date().toISOString(), leaseUntil: null, budget }, ["planning"]);
    await store.event(runId, "failed", e.message, e.detail ? { detail: e.detail } : undefined);
  } finally {
    clearInterval(lease);
    destroyWorktree(workDir);
    destroyWorktree(scratchDir);
  }
}

"use client";

import { useEffect, useState } from "react";
import { Tabs } from "radix-ui";
import { AlertTriangle, ArrowLeft, CheckCircle2, CircleDashed, Clock, FileText, HelpCircle, Loader2, RefreshCw, Send, ShieldCheck, XCircle } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { useRuns } from "@/hooks/use-runs";
import { Avatar } from "../avatar";
import { UsagePanel } from "./usage-panel";
import { engineApi } from "@/lib/engine/client";
import { connectionLabel } from "@/lib/engine/connections";
import { TASK_STATE_LABEL, handoffBlocker, isHandoffTarget, taskState, type TaskStateKey } from "@/lib/engine/handoff-state";
import { ACTIVE_STATUSES, RUN_STATUS_LABEL, type ArchitectSnapshot, type DirectorSnapshot, type RunDetail, type RunStatus } from "@/lib/engine/types";
import type { Agent } from "@/lib/office/types";

type RunsApi = ReturnType<typeof useRuns>;
type Answers = { question: string; answer: string }[];

const fmt = (n: number | null | undefined) => (n == null ? "—" : n.toLocaleString("pt-BR"));
const time = (iso: string | null) => (iso ? new Date(iso).toLocaleString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit", day: "2-digit", month: "short" }) : "—");

export function StatusBadge({ status }: { status: RunStatus | "prepared" }) {
  const label = status === "prepared" ? "Preparada" : RUN_STATUS_LABEL[status];
  const Icon = status === "prepared" ? CircleDashed : ACTIVE_STATUSES.includes(status as RunStatus) ? Loader2 : status === "plan_ready" || status === "analysis_ready" ? CheckCircle2 : status === "awaiting_clarification" ? HelpCircle : status === "awaiting_approval" ? Clock : status === "failed" ? XCircle : CircleDashed;
  return <span className={`run-badge st-${status}`}><Icon size={13} className={ACTIVE_STATUSES.includes(status as RunStatus) ? "spin" : ""} aria-hidden />{label}</span>;
}

export function TaskStateBadge({ state }: { state: TaskStateKey }) {
  const Icon = state === "working" || state === "queued" ? Loader2 : state === "analysis_ready" ? CheckCircle2 : state === "awaiting_clarification" ? HelpCircle : state === "awaiting_approval" ? Clock : state === "failed" ? XCircle : CircleDashed;
  return <span className={`task-state ts-${state}`}><Icon size={12} className={state === "working" || state === "queued" ? "spin" : ""} aria-hidden />{TASK_STATE_LABEL[state]}</span>;
}

type DialogProps = {
  runId: string | null;
  agents: Agent[];
  runs: RunsApi;
  onClose: () => void;
  onOpenRun: (id: string) => void;
  onReplan: (run: RunDetail, answers?: Answers) => void;
  onCancel: (runId: string) => void;
  /** “Enviar ao Arquiteto” on a task of a Director plan (prepares the hand-off and opens the review). */
  onHandoff: (planRunId: string, taskId: string) => void;
  /** Reopens the review of a prepared hand-off. */
  onReview: (handoffRunId: string) => void;
  /** Answers to the Architect's questions (prepares a new hand-off for review). */
  onAnswerArchitect: (run: RunDetail, answers: Answers) => void;
};
type BodyProps = DialogProps & { run: RunDetail; active: boolean };

export function RunDialog(props: DialogProps) {
  const { runId, onClose } = props;
  return (
    <Dialog open={!!runId} onOpenChange={v => !v && onClose()}>
      <DialogContent className="game-dialog run-dialog">
        {runId && <RunBody key={runId} {...props} runId={runId} />}
      </DialogContent>
    </Dialog>
  );
}

/** Loads a run from the executor and polls it while it is active. */
export function useRunDetail(runId: string | null) {
  const [run, setRun] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const active = run ? ACTIVE_STATUSES.includes(run.status) : true;
  useEffect(() => {
    if (!runId) return;
    let stop = false;
    const load = async () => {
      try { const r = (await engineApi.get(runId)).run; if (!stop) { setRun(r); setError(null); } }
      catch (e) { if (!stop) setError((e as Error).message); }
    };
    void load();
    const t = setInterval(() => { if (active) void load(); }, 2000);
    return () => { stop = true; clearInterval(t); };
  }, [runId, active]);
  return { run, error, active };
}

function RunBody(props: DialogProps & { runId: string }) {
  const { run, error, active } = useRunDetail(props.runId);
  if (!run) return <div className="run-loading">{error ?? <><Loader2 size={16} className="spin" /> Carregando execução…</>}</div>;
  return run.kind === "architect_task" ? <ArchitectBody {...props} run={run} active={active} /> : <DirectorBody {...props} run={run} active={active} />;
}

function ErrorBox({ run }: { run: RunDetail }) {
  if (!run.error) return null;
  return (
    <div className="run-error" role="alert">
      <AlertTriangle size={16} />
      <div><b>{run.error.message}</b><small>Código: {run.error.code}{run.error.retryable ? " · pode tentar novamente" : ""}</small>{run.error.detail && <pre>{run.error.detail}</pre>}{!!run.error.recovery?.length && <><span className="eyebrow">COMO RESOLVER</span><ol className="conn-steps">{run.error.recovery.map((r, i) => <li key={i}>{r}</li>)}</ol></>}</div>
    </div>
  );
}

function Events({ run }: { run: RunDetail }) {
  return <ol className="events">{run.events.map(e => <li key={e.seq} className={`ev-${e.kind}`}><time>{time(e.at)}</time><span>{e.message}</span></li>)}</ol>;
}

export function ContextFiles({ run }: { run: RunDetail }) {
  const c = run.context;
  if (!c) return <p className="muted">O contexto ainda não foi montado.</p>;
  if (c.kind === "none") return <p>{c.note}</p>;
  if (c.kind === "folder") return <div className="notice"><b>Os arquivos da pasta “{c.summary.name}” não foram lidos.</b> Apenas metadados: {c.summary.fileCount} arquivos, {fmt(c.summary.totalBytes)} bytes.</div>;
  return (
    <>
      <p>Repositório público <b>{c.owner}/{c.repo}</b>, branch <b>{c.branch}</b>, commit <code>{c.commit.slice(0, 12)}</code> · leitura em {fmt(c.elapsedMs)} ms.</p>
      <h4 className="ctx-h">Arquivos realmente consultados ({c.files.length})</h4>
      <table className="ctx-table"><thead><tr><th>Arquivo</th><th>Motivo</th><th>Tamanho</th><th>Enviado</th></tr></thead>
        <tbody>{c.files.map(f => <tr key={f.path}><td><FileText size={12} /> {f.path}</td><td>{f.reason}</td><td>{fmt(f.bytes)} B</td><td>{fmt(f.sentChars)} car.{f.truncated ? " (truncado)" : ""}</td></tr>)}</tbody>
      </table>
      {!!c.skipped.length && <><h4 className="ctx-h">Não lidos</h4><ul className="ctx-skip">{c.skipped.map(s => <li key={s.path}>{s.path} — {s.reason}</li>)}</ul></>}
      <small className="muted">Limites: {c.limits.maxFiles} arquivos, {fmt(c.limits.maxFileBytes)} caracteres por arquivo, {fmt(c.limits.maxTotalChars)} no total, {c.limits.timeoutMs / 1000}s. Conteúdo do repositório tratado como dado não confiável.</small>
    </>
  );
}

function Input({ run, systemTitle }: { run: RunDetail; systemTitle: string }) {
  return (
    <>
      <p className="pane-intro">Entrada congelada (instantâneo {run.snapshotHash.slice(0, 12)}). Alterações posteriores na ficha não mudam este registro.</p>
      {run.prompt ? (
        <>
          <h4 className="ctx-h">{systemTitle}{run.connection === "codex" ? " — enviadas ao Codex no início da mesma entrada" : " — enviadas ao Claude Code como system prompt"}</h4>
          <pre className="brief">{run.prompt.system}</pre>
          <h4 className="ctx-h">Mensagem</h4>
          <pre className="brief">{run.prompt.user}</pre>
        </>
      ) : <p className="muted">A entrada ainda não foi montada.</p>}
      {run.rawOutput && <><h4 className="ctx-h">Resposta bruta devolvida pelo cliente</h4><pre className="brief">{run.rawOutput}</pre></>}
    </>
  );
}

function Meta({ run }: { run: RunDetail }) {
  const reported = [...new Set(run.budget.calls.map(c => c.model).filter(Boolean))].join(", ");
  return (
    <div className="run-meta">
      <StatusBadge status={run.status} />
      <span>Conexão: <b>{connectionLabel(run.connection)}</b></span>
      <span>Modelo: <b>{run.model || "padrão do cliente"}</b>{reported ? <small> (informado: {reported})</small> : null}</span>
      {run.effort && <span>Esforço: <b>{run.effort}</b></span>}
      <span>Criada {time(run.createdAt)}</span>
      {run.finishedAt && <span>Encerrada {time(run.finishedAt)}</span>}
    </div>
  );
}

// ---- Director plan ---------------------------------------------------------

function DirectorBody({ run, active, agents, runs, onReplan, onCancel, onHandoff, onReview, onOpenRun }: BodyProps) {
  const [tab, setTab] = useState("plan");
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const res = run.result;
  const snap = run.snapshot as DirectorSnapshot;
  const who = (id: string) => agents.find(a => a.id === id) ?? null;
  const name = (id: string) => who(id)?.name ?? snap.team.find(t => t.id === id)?.name ?? id;
  const architectTasks = res?.tasks.filter(t => isHandoffTarget(t.assignee)) ?? [];
  const runsOf = (taskId: string) => runs.taskRunsFor(run.id, taskId);

  return (
    <>
      <DialogHeader>
        <span className="eyebrow">EXECUÇÃO DO DIRETOR · {run.id.slice(0, 8).toUpperCase()}</span>
        <DialogTitle className="run-title">{snap.demand.title}</DialogTitle>
        <DialogDescription asChild><div><Meta run={run} /></div></DialogDescription>
      </DialogHeader>
      {active && (
        <div className="run-live"><Loader2 size={15} className="spin" /> O Diretor está {run.status === "queued" ? "na fila do executor local" : `planejando via ${connectionLabel(run.connection)}`}. Esta janela atualiza sozinha.
          <button className="btn-ghost" onClick={() => onCancel(run.id)}>Cancelar</button>
        </div>
      )}
      <ErrorBox run={run} />

      <Tabs.Root value={tab} onValueChange={setTab} className="run-tabs">
        <Tabs.List className="tab-list" aria-label="Detalhes da execução">
          <Tabs.Trigger value="plan">Plano</Tabs.Trigger>
          <Tabs.Trigger value="tasks">Tarefas {res ? `(${res.tasks.length})` : ""}{architectTasks.length ? ` · Arquiteto ${architectTasks.length}` : ""}</Tabs.Trigger>
          <Tabs.Trigger value="questions">Dúvidas {res?.questions.length ? `(${res.questions.length})` : ""}</Tabs.Trigger>
          <Tabs.Trigger value="context">Contexto</Tabs.Trigger>
          <Tabs.Trigger value="events">Eventos</Tabs.Trigger>
          <Tabs.Trigger value="tokens">Tokens</Tabs.Trigger>
          <Tabs.Trigger value="input">Entrada</Tabs.Trigger>
        </Tabs.List>
        <div className="dialog-scroll run-scroll">
          <Tabs.Content value="plan" className="run-pane">
            {!res && <p className="pane-intro">{active ? "O plano aparecerá aqui quando o Diretor terminar." : "Esta execução não produziu um plano."}</p>}
            {res && (
              <>
                <section className="run-sec"><h4>Objetivo</h4><p>{res.objective_summary}</p></section>
                <section className="run-sec"><h4>Entendimento do contexto</h4><p>{res.context_understanding || "—"}</p></section>
                <section className="run-sec"><h4>Fluxo escolhido · {res.flow.type === "short" ? "curto" : res.flow.type === "standard" ? "padrão" : "completo"}</h4><p>{res.flow.rationale}</p>{!!res.flow.skipped_roles.length && <small>Dispensados: {res.flow.skipped_roles.join(", ")}</small>}</section>
                {!!res.steps.length && (
                  <section className="run-sec"><h4>Etapas</h4>
                    <ol className="run-steps">{res.steps.map(s => <li key={s.id}><b>{s.id} · {s.title}</b> <span className="muted">→ {name(s.owner)}{s.depends_on.length ? ` · depende de ${s.depends_on.join(", ")}` : ""}</span><small>Concluída quando: {s.done_when}</small></li>)}</ol>
                  </section>
                )}
                <div className="run-cols">
                  <section className="run-sec"><h4>Riscos</h4>{res.risks.length ? <ul>{res.risks.map((r, i) => <li key={i}>{r}</li>)}</ul> : <p className="muted">Nenhum informado.</p>}</section>
                  <section className="run-sec"><h4>Suposições</h4>{res.assumptions.length ? <ul>{res.assumptions.map((r, i) => <li key={i}>{r}</li>)}</ul> : <p className="muted">Nenhuma.</p>}</section>
                </div>
                <section className="run-sec"><h4>Ainda não verificado</h4>{res.not_verified.length ? <ul>{res.not_verified.map((r, i) => <li key={i}>{r}</li>)}</ul> : <p className="muted">—</p>}</section>
                <section className="run-sec limits"><h4>Limitações desta execução</h4><ul>{res.limitations.map((r, i) => <li key={i}>{r}</li>)}</ul></section>
              </>
            )}
          </Tabs.Content>

          <Tabs.Content value="tasks" className="run-pane">
            <p className="pane-intro">Propostas de delegação do Diretor. Nesta fase, somente tarefas do <b>Arquiteto</b> podem ser enviadas, uma de cada vez e só depois que você revisar e confirmar. Desenvolvedor, QA e Revisor não executam.</p>
            {res && run.status === "plan_ready" && !architectTasks.length && (
              <div className="notice">Nenhuma tarefa deste plano foi atribuída ao Arquiteto: não há encaminhamento arquitetural neste plano.</div>
            )}
            {res && run.status !== "plan_ready" && <div className="notice">Encaminhamentos só são possíveis a partir de um plano pronto.</div>}
            {res?.tasks.map(t => {
              const a = who(t.assignee);
              const tr = runsOf(t.id);
              const st = taskState(t, tr);
              const canSend = st.key === "proposed" || st.key === "failed" || st.key === "canceled";
              const blocker = canSend ? handoffBlocker(t, res.tasks, runsOf) : null;
              const sending = runs.pending.has(`${run.id}:${t.id}`);
              return (
                <article key={t.id} className={`task-card ${isHandoffTarget(t.assignee) ? "is-handoff" : ""}`}>
                  <header>{a ? <Avatar look={a.look} color={a.color} size={30} /> : null}<div><b>{t.id} · {t.title}</b><small>{name(t.assignee)} · etapa {t.step_id || "—"}{t.depends_on.length ? ` · depende de ${t.depends_on.join(", ")}` : ""}</small></div><TaskStateBadge state={st.key} /></header>
                  <dl>
                    <dt>Escopo</dt><dd>{t.scope}</dd>
                    <dt>Insumos</dt><dd>{t.inputs || "—"}</dd>
                    <dt>Entregável</dt><dd>{t.deliverable}</dd>
                    <dt>Critérios de aceite</dt><dd><ul>{t.acceptance_criteria.map((c, i) => <li key={i}>{c}</li>)}</ul></dd>
                  </dl>
                  {isHandoffTarget(t.assignee) && run.status === "plan_ready" && (
                    <div className="task-actions">
                      {canSend && (
                        <button className="btn-primary small" disabled={!!blocker || sending || !runs.status?.executionEnabled} title={blocker ?? runs.status?.disabledReason ?? undefined} onClick={() => onHandoff(run.id, t.id)}>
                          {sending ? <><Loader2 size={13} className="spin" /> Preparando o envio…</> : <><Send size={13} /> {st.key === "proposed" ? "Enviar ao Arquiteto" : "Enviar ao Arquiteto novamente"}</>}
                        </button>
                      )}
                      {st.key === "awaiting_approval" && st.run && <button className="btn-primary small" onClick={() => onReview(st.run!.id)}><ShieldCheck size={13} /> Revisar e confirmar envio</button>}
                      {st.run && st.key !== "awaiting_approval" && <button className="btn-secondary small" onClick={() => onOpenRun(st.run!.id)}>{st.key === "analysis_ready" ? "Ver análise" : st.key === "awaiting_clarification" ? "Responder ao Arquiteto" : "Ver execução do Arquiteto"}</button>}
                      {(st.key === "queued" || st.key === "working") && st.run && <button className="btn-ghost small" onClick={() => onCancel(st.run!.id)}>Cancelar</button>}
                      {blocker && <span className="run-hint">{blocker}</span>}
                      {canSend && !runs.status?.executionEnabled && <span className="run-hint bad">{runs.status?.disabledReason ?? "Executor local indisponível."}</span>}
                      {tr.length > 1 && <span className="run-history">Histórico: {tr.map(r => <button key={r.id} className="chip" onClick={() => (r.status === "awaiting_approval" ? onReview(r.id) : onOpenRun(r.id))} title={time(r.createdAt)}>{RUN_STATUS_LABEL[r.status]}</button>)}</span>}
                    </div>
                  )}
                  {!isHandoffTarget(t.assignee) && <small className="muted">Proposta registrada. {name(t.assignee)} ainda não executa nesta fase; nada foi delegado.</small>}
                </article>
              );
            }) ?? <p className="muted">Sem tarefas.</p>}
            {res && !res.tasks.length && <p className="muted">O Diretor não propôs tarefas nesta execução.</p>}
          </Tabs.Content>

          <Tabs.Content value="questions" className="run-pane">
            {!res?.questions.length && <p className="muted">Nenhuma pergunta ao solicitante.</p>}
            {!!res?.questions.length && (
              <>
                <p className="pane-intro">{run.status === "awaiting_clarification" ? "O Diretor precisa destas respostas para planejar com segurança." : "Perguntas registradas nesta execução."}</p>
                {res.questions.map((q, i) => (
                  <div key={i} className="question">
                    <b>{i + 1}. {q.question}</b>
                    <small>Por que bloqueia: {q.why_it_blocks || "—"}</small>
                    {run.status === "awaiting_clarification" && <textarea rows={2} value={answers[i] ?? ""} onChange={e => setAnswers(s => ({ ...s, [i]: e.target.value }))} placeholder="Sua resposta" aria-label={`Resposta à pergunta ${i + 1}`} />}
                  </div>
                ))}
                {run.status === "awaiting_clarification" && (
                  <button className="btn-primary" disabled={!res.questions.every((_, i) => (answers[i] ?? "").trim())} onClick={() => onReplan(run, res.questions.map((q, i) => ({ question: q.question, answer: answers[i].trim() })))}>
                    <Send size={15} /> Responder e planejar novamente
                  </button>
                )}
              </>
            )}
          </Tabs.Content>

          <Tabs.Content value="context" className="run-pane"><ContextFiles run={run} /></Tabs.Content>
          <Tabs.Content value="events" className="run-pane"><Events run={run} /></Tabs.Content>
          <Tabs.Content value="tokens" className="run-pane"><UsagePanel budget={run.budget} connection={run.connection} agentLabel="Diretor" /></Tabs.Content>
          <Tabs.Content value="input" className="run-pane"><Input run={run} systemTitle="Instruções (protocolo da fase + ficha do Diretor)" /></Tabs.Content>
        </div>
      </Tabs.Root>

      <div className="dialog-actions">
        {!active && <button className="btn-secondary" onClick={() => onReplan(run)}><RefreshCw size={14} /> Planejar novamente</button>}
      </div>
    </>
  );
}

// ---- Architect analysis ----------------------------------------------------

function ArchitectBody({ run, active, agents, onCancel, onOpenRun, onReview, onAnswerArchitect }: BodyProps) {
  const [tab, setTab] = useState("analysis");
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const snap = run.snapshot as ArchitectSnapshot;
  const a = run.analysis;
  const architect = agents.find(x => x.id === run.agentId);
  const name = (id: string) => agents.find(x => x.id === id)?.name ?? snap.team.find(t => t.id === id)?.name ?? id;
  const readSent = run.context?.kind === "github" ? run.context.files.map(f => f.path) : [];
  const directorNotResent = snap.plan.directorFiles.filter(f => !readSent.includes(f.path));

  return (
    <>
      <DialogHeader>
        <span className="eyebrow">ARQUITETO · TAREFA {snap.task.id} · EXECUÇÃO {run.id.slice(0, 8).toUpperCase()}</span>
        <DialogTitle className="run-title">{snap.task.title}</DialogTitle>
        <DialogDescription asChild>
          <div>
            <Meta run={run} />
            <div className="run-origin">
              {architect && <Avatar look={architect.look} color={architect.color} size={22} />}
              <span>Demanda “{snap.demand.title}” · tarefa {snap.task.id} do plano do Diretor <code>{snap.plan.directorRunId.slice(0, 8)}</code></span>
              <button className="btn-ghost small" onClick={() => onOpenRun(snap.plan.directorRunId)}><ArrowLeft size={13} /> Ver plano do Diretor</button>
            </div>
          </div>
        </DialogDescription>
      </DialogHeader>
      {run.status === "awaiting_approval" && (
        <div className="run-live">Envio preparado e aguardando sua aprovação. Nada foi executado.<button className="btn-primary small" onClick={() => onReview(run.id)}><ShieldCheck size={13} /> Revisar e confirmar</button></div>
      )}
      {active && (
        <div className="run-live"><Loader2 size={15} className="spin" /> {run.status === "queued" ? "Na fila do executor local." : `Arquiteto trabalhando via ${connectionLabel(run.connection)}.`} Esta janela atualiza sozinha.
          <button className="btn-ghost" onClick={() => onCancel(run.id)}>Cancelar</button>
        </div>
      )}
      <ErrorBox run={run} />

      <Tabs.Root value={tab} onValueChange={setTab} className="run-tabs">
        <Tabs.List className="tab-list" aria-label="Detalhes da análise">
          <Tabs.Trigger value="analysis">Análise</Tabs.Trigger>
          <Tabs.Trigger value="questions">Dúvidas {a?.questions.length ? `(${a.questions.length})` : ""}</Tabs.Trigger>
          <Tabs.Trigger value="task">Tarefa</Tabs.Trigger>
          <Tabs.Trigger value="context">Contexto</Tabs.Trigger>
          <Tabs.Trigger value="events">Eventos</Tabs.Trigger>
          <Tabs.Trigger value="tokens">Tokens</Tabs.Trigger>
          <Tabs.Trigger value="input">Entrada</Tabs.Trigger>
        </Tabs.List>
        <div className="dialog-scroll run-scroll">
          <Tabs.Content value="analysis" className="run-pane">
            {!a && <p className="pane-intro">{active ? "A análise aparecerá aqui quando o Arquiteto terminar." : run.status === "awaiting_approval" ? "O Arquiteto ainda não foi acionado." : "Esta execução não produziu uma análise."}</p>}
            {a && (
              <>
                {a.outcome === "needs_clarification" && <div className="notice">O Arquiteto não fez uma recomendação: ele precisa de respostas (aba Dúvidas).</div>}
                <section className="run-sec"><h4>Entendimento técnico</h4><p>{a.technical_understanding}</p></section>
                {a.recommendation.summary && <section className="run-sec"><h4>Solução recomendada</h4><p>{a.recommendation.summary}</p><small>Justificativa: {a.recommendation.rationale}</small></section>}
                {!!a.alternatives.length && <section className="run-sec"><h4>Alternativas consideradas</h4><ul>{a.alternatives.map((x, i) => <li key={i}><b>{x.option}</b> — {x.tradeoff}{x.why_not_chosen ? ` · não escolhida: ${x.why_not_chosen}` : ""}</li>)}</ul></section>}
                <section className="run-sec"><h4>Arquivos, símbolos e contratos examinados</h4>
                  {a.examined.length ? <table className="ctx-table"><thead><tr><th>Referência</th><th>Tipo</th><th>Base</th><th>Nota</th></tr></thead><tbody>{a.examined.map((e, i) => <tr key={i}><td><code>{e.ref}</code></td><td>{e.kind}</td><td><span className={`basis b-${e.basis}`}>{e.basis === "read" ? "lido (conteúdo enviado)" : "inferido"}</span></td><td>{e.note}</td></tr>)}</tbody></table> : <p className="muted">Nenhum.</p>}
                </section>
                <div className="run-cols">
                  <section className="run-sec"><h4>Dependências</h4>{a.dependencies.length ? <ul>{a.dependencies.map((x, i) => <li key={i}>{x}</li>)}</ul> : <p className="muted">—</p>}</section>
                  <section className="run-sec"><h4>Compatibilidade</h4>{a.compatibility.length ? <ul>{a.compatibility.map((x, i) => <li key={i}>{x}</li>)}</ul> : <p className="muted">—</p>}</section>
                </div>
                <section className="run-sec"><h4>Riscos e possíveis regressões</h4>{a.risks.length ? <ul>{a.risks.map((r, i) => <li key={i}><b>{r.risk}</b>{r.regression_area ? ` · área: ${r.regression_area}` : ""}{r.mitigation ? ` · mitigação: ${r.mitigation}` : ""}</li>)}</ul> : <p className="muted">Nenhum.</p>}</section>
                <section className="run-sec"><h4>Orientação ao Desenvolvedor</h4>{a.developer_guidance.length ? <ol>{a.developer_guidance.map((x, i) => <li key={i}>{x}</li>)}</ol> : <p className="muted">—</p>}</section>
                <section className="run-sec"><h4>Checagens recomendadas ao QA (não executadas)</h4>{a.qa_checks.length ? <ul>{a.qa_checks.map((x, i) => <li key={i}>{x}</li>)}</ul> : <p className="muted">—</p>}</section>
                <div className="run-cols">
                  <section className="run-sec"><h4>Suposições</h4>{a.assumptions.length ? <ul>{a.assumptions.map((x, i) => <li key={i}>{x}</li>)}</ul> : <p className="muted">Nenhuma.</p>}</section>
                  <section className="run-sec"><h4>Não verificado</h4>{a.not_verified.length ? <ul>{a.not_verified.map((x, i) => <li key={i}>{x}</li>)}</ul> : <p className="muted">—</p>}</section>
                </div>
                <section className="run-sec limits"><h4>Limitações desta execução</h4><ul>{a.limitations.map((r, i) => <li key={i}>{r}</li>)}</ul></section>
                {run.status === "analysis_ready" && <p className="form-note">Análise registrada para a futura etapa do Desenvolvedor e para o Diretor consolidar. Nenhum colaborador foi acionado a partir dela.</p>}
              </>
            )}
          </Tabs.Content>

          <Tabs.Content value="questions" className="run-pane">
            {!a?.questions.length && <p className="muted">Nenhuma pergunta.</p>}
            {!!a?.questions.length && (
              <>
                <p className="pane-intro">{run.status === "awaiting_clarification" ? "O Arquiteto precisa destas respostas para recomendar com segurança. Responder prepara um novo envio, que você revisa antes de confirmar." : "Perguntas registradas nesta execução."}</p>
                {a.questions.map((q, i) => (
                  <div key={i} className="question">
                    <b>{i + 1}. {q.question}</b>
                    <small>Por que bloqueia: {q.why_it_blocks || "—"}</small>
                    {run.status === "awaiting_clarification" && <textarea rows={2} value={answers[i] ?? ""} onChange={e => setAnswers(s => ({ ...s, [i]: e.target.value }))} placeholder="Sua resposta" aria-label={`Resposta à pergunta ${i + 1}`} />}
                  </div>
                ))}
                {run.status === "awaiting_clarification" && (
                  <button className="btn-primary" disabled={!a.questions.every((_, i) => (answers[i] ?? "").trim())} onClick={() => onAnswerArchitect(run, a.questions.map((q, i) => ({ question: q.question, answer: answers[i].trim() })))}>
                    <Send size={15} /> Responder e revisar novo envio
                  </button>
                )}
              </>
            )}
          </Tabs.Content>

          <Tabs.Content value="task" className="run-pane">
            <section className="run-sec"><h4>Tarefa {snap.task.id} (do Diretor, para {name(snap.task.assignee)})</h4>
              <dl className="kv"><dt>Escopo</dt><dd>{snap.task.scope}</dd><dt>Insumos</dt><dd>{snap.task.inputs || "—"}</dd><dt>Entregável</dt><dd>{snap.task.deliverable}</dd><dt>Critérios</dt><dd><ul>{snap.task.acceptance_criteria.map((c, i) => <li key={i}>{c}</li>)}</ul></dd></dl>
            </section>
            <section className="run-sec"><h4>Ferramentas nesta execução</h4><ul className="tool-grants">{snap.tools.map(t => <li key={t.label} className={t.allowed ? "ok" : "no"}><b>{t.label}: {t.allowed ? "permitida" : "bloqueada"}</b><small>{t.how}</small></li>)}</ul></section>
            {!!snap.plan.dependents.length && <section className="run-sec"><h4>Quem vai usar esta análise</h4><ul>{snap.plan.dependents.map(d => <li key={d.id}>{d.id} · {d.title} → {name(d.assignee)} (não acionado automaticamente)</li>)}</ul></section>}
          </Tabs.Content>

          <Tabs.Content value="context" className="run-pane">
            <ContextFiles run={run} />
            {!!directorNotResent.length && <><h4 className="ctx-h">Lidos pelo Diretor e não reenviados ({directorNotResent.length})</h4><ul className="ctx-skip">{directorNotResent.map(f => <li key={f.path}>{f.path} — não citado pela tarefa; o Arquiteto recebeu só o caminho</li>)}</ul></>}
          </Tabs.Content>
          <Tabs.Content value="events" className="run-pane"><Events run={run} /></Tabs.Content>
          <Tabs.Content value="tokens" className="run-pane"><UsagePanel budget={run.budget} connection={run.connection} agentLabel="Arquiteto" /></Tabs.Content>
          <Tabs.Content value="input" className="run-pane"><Input run={run} systemTitle="Instruções (protocolo do Arquiteto + ficha do Arquiteto)" /></Tabs.Content>
        </div>
      </Tabs.Root>
    </>
  );
}

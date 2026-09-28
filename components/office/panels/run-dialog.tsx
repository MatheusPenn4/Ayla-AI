"use client";

import { useEffect, useState } from "react";
import { Tabs } from "radix-ui";
import { AlertTriangle, ArrowLeft, CheckCircle2, CircleDashed, Clock, FileText, HelpCircle, Loader2, RefreshCw, Send, ShieldCheck, XCircle } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { useRuns } from "@/hooks/use-runs";
import { Avatar } from "../avatar";
import { ClarifyForm } from "./clarify-form";
import { DeveloperPreviewPanel } from "./developer-preview-panel";
import { ComparisonTable, SendForm } from "./send-form";
import { UsagePanel } from "./usage-panel";
import { engineApi, type HandoffFollowUp } from "@/lib/engine/client";
import { ANALYSIS_JSON_SCHEMA } from "@/lib/engine/analysis-schema";
import { DEVELOPER_JSON_SCHEMA } from "@/lib/engine/developer-schema";
import { PLAN_JSON_SCHEMA } from "@/lib/engine/plan-schema";
import { connectionLabel } from "@/lib/engine/connections";
import { TASK_STATE_LABEL, developerBlocker, handoffBlocker, isExecutableAssignee, isHandoffTarget, taskState, type TaskStateKey } from "@/lib/engine/handoff-state";
import { ACTIVE_STATUSES, RUN_STATUS_LABEL, type ArchitectSnapshot, type DeveloperSnapshot, type DirectorSnapshot, type RunDetail, type RunStatus } from "@/lib/engine/types";
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
  onHandoff: (planRunId: string, taskId: string, followUp?: HandoffFollowUp) => void;
  /** “Enviar ao Desenvolvedor” on a task of a Director plan (prepares the hand-off and opens the review). */
  onHandoffDeveloper: (planRunId: string, taskId: string) => void;
  /** Opens the review of a just-prepared Developer hand-off (kind known at the call site, unlike onReview). */
  onReviewDeveloper: (handoffRunId: string) => void;
  /** Reopens the review of a prepared hand-off (Architect or Developer — resolved by the run's kind). */
  onReview: (handoffRunId: string) => void;
  /** Resolution of the Architect's questions (prepares a new hand-off for review). */
  onAnswerArchitect: (run: RunDetail, followUp: HandoffFollowUp) => void;
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
  if (run.kind === "architect_task") return <ArchitectBody {...props} run={run} active={active} />;
  if (run.kind === "developer_task") return <DeveloperBody {...props} run={run} active={active} />;
  return <DirectorBody {...props} run={run} active={active} />;
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

function DirectorBody({ run, active, agents, runs, onReplan, onCancel, onHandoff, onHandoffDeveloper, onReview, onReviewDeveloper, onOpenRun }: BodyProps) {
  const [tab, setTab] = useState("plan");
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const res = run.result;
  const snap = run.snapshot as DirectorSnapshot;
  const who = (id: string) => agents.find(a => a.id === id) ?? null;
  const name = (id: string) => who(id)?.name ?? snap.team.find(t => t.id === id)?.name ?? id;
  const architectTasks = res?.tasks.filter(t => isHandoffTarget(t.assignee)) ?? [];
  const runsOf = (taskId: string) => runs.taskRunsFor(run.id, taskId);
  const [sendFor, setSendFor] = useState<string | null>(null);
  const [previewFor, setPreviewFor] = useState<string | null>(null);

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
            <p className="pane-intro">Propostas de delegação do Diretor. Nesta fase, tarefas do <b>Arquiteto</b> (só leitura) e do <b>Desenvolvedor</b> (escrita numa cópia isolada) podem ser enviadas, uma de cada vez e só depois que você revisar e confirmar. QA e Revisor ainda não executam.</p>
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
                        <button className="btn-primary small" disabled={!!blocker || sending || !runs.status?.executionEnabled || sendFor === t.id} title={blocker ?? runs.status?.disabledReason ?? undefined} onClick={() => setSendFor(t.id)}>
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
                  {canSend && sendFor === t.id && run.status === "plan_ready" && (
                    <SendForm planRunId={run.id} taskId={t.id} sending={sending} disabled={!runs.status?.executionEnabled} onClose={() => setSendFor(null)} onSubmit={f => { setSendFor(null); onHandoff(run.id, t.id, f); }} />
                  )}
                  {!isExecutableAssignee(t.assignee) && <small className="muted">Proposta registrada. {name(t.assignee)} ainda não executa nesta fase; nada foi delegado.</small>}
                  {t.assignee === "developer" && run.status === "plan_ready" && (() => {
                    const devBlocker = developerBlocker(t, res.tasks, runsOf);
                    return (
                      <div className="task-actions">
                        {canSend && (
                          <button className="btn-primary small" disabled={!!devBlocker || sending || !runs.status?.executionEnabled} title={devBlocker ?? runs.status?.disabledReason ?? undefined} onClick={() => onHandoffDeveloper(run.id, t.id)}>
                            {sending ? <><Loader2 size={13} className="spin" /> Preparando o envio…</> : <><Send size={13} /> {st.key === "proposed" ? "Enviar ao Desenvolvedor" : "Enviar ao Desenvolvedor novamente"}</>}
                          </button>
                        )}
                        {st.key === "awaiting_approval" && st.run && <button className="btn-primary small" onClick={() => onReview(st.run!.id)}><ShieldCheck size={13} /> Revisar e confirmar envio</button>}
                        {st.run && st.key !== "awaiting_approval" && <button className="btn-secondary small" onClick={() => onOpenRun(st.run!.id)}>{st.key === "implementation_ready" ? "Ver implementação" : st.key === "awaiting_clarification" ? "Ver dúvidas do Desenvolvedor" : "Ver execução do Desenvolvedor"}</button>}
                        {(st.key === "queued" || st.key === "working") && st.run && <button className="btn-ghost small" onClick={() => onCancel(st.run!.id)}>Cancelar</button>}
                        <button className="btn-secondary small" disabled={previewFor === t.id} onClick={() => setPreviewFor(t.id)}><FileText size={13} /> Ver prévia</button>
                        {devBlocker && <span className="run-hint">{devBlocker}</span>}
                        {tr.length > 1 && <span className="run-history">Histórico: {tr.map(r => <button key={r.id} className="chip" onClick={() => (r.status === "awaiting_approval" ? onReview(r.id) : onOpenRun(r.id))} title={time(r.createdAt)}>{RUN_STATUS_LABEL[r.status]}</button>)}</span>}
                      </div>
                    );
                  })()}
                  {previewFor === t.id && <DeveloperPreviewPanel planRunId={run.id} taskId={t.id} agents={agents} runs={runs} onOpenRun={onOpenRun} onReview={id => { setPreviewFor(null); onReviewDeveloper(id); }} onClose={() => setPreviewFor(null)} />}
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
          <Tabs.Content value="tokens" className="run-pane"><UsagePanel budget={run.budget} connection={run.connection} agentLabel="Diretor" prompt={run.prompt} schemaChars={JSON.stringify(PLAN_JSON_SCHEMA).length} /></Tabs.Content>
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

function ArchitectBody({ run, active, agents, runs, onCancel, onOpenRun, onReview, onAnswerArchitect }: BodyProps) {
  const [tab, setTab] = useState("analysis");
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
                <Coverage run={run} />
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
            {!!a?.questions.length && run.status === "awaiting_clarification" && <ClarifyForm run={run} runs={runs} onSubmit={f => onAnswerArchitect(run, f)} />}
            {!!a?.questions.length && run.status !== "awaiting_clarification" && (
              <>
                <p className="pane-intro">Perguntas registradas nesta execução.</p>
                {a.questions.map((q, i) => <div key={i} className="question"><b>{i + 1}. {q.question}</b><small>Por que bloqueia: {q.why_it_blocks || "—"}</small></div>)}
              </>
            )}
          </Tabs.Content>

          <Tabs.Content value="task" className="run-pane">
            <section className="run-sec"><h4>Tarefa {snap.task.id} (do Diretor, para {name(snap.task.assignee)})</h4>
              <dl className="kv"><dt>Escopo</dt><dd>{snap.task.scope}</dd><dt>Insumos</dt><dd>{snap.task.inputs || "—"}</dd><dt>Entregável</dt><dd>{snap.task.deliverable}</dd><dt>Critérios</dt><dd><ul>{snap.task.acceptance_criteria.map((c, i) => <li key={i}>{c}</li>)}</ul></dd></dl>
            </section>
            <RevisionInfo snap={snap} onOpenRun={onOpenRun} />
            <section className="run-sec"><h4>Ferramentas nesta execução</h4><ul className="tool-grants">{snap.tools.map(t => <li key={t.label} className={t.allowed ? "ok" : "no"}><b>{t.label}: {t.allowed ? "permitida" : "bloqueada"}</b><small>{t.how}</small></li>)}</ul></section>
            {!!snap.plan.dependents.length && <section className="run-sec"><h4>Quem vai usar esta análise</h4><ul>{snap.plan.dependents.map(d => <li key={d.id}>{d.id} · {d.title} → {name(d.assignee)} (não acionado automaticamente)</li>)}</ul></section>}
          </Tabs.Content>

          <Tabs.Content value="context" className="run-pane">
            <ContextFiles run={run} />
            {!!directorNotResent.length && <><h4 className="ctx-h">Lidos pelo Diretor e não reenviados ({directorNotResent.length})</h4><ul className="ctx-skip">{directorNotResent.map(f => <li key={f.path}>{f.path} — não citado pela tarefa; o Arquiteto recebeu só o caminho</li>)}</ul></>}
          </Tabs.Content>
          <Tabs.Content value="events" className="run-pane"><Events run={run} /></Tabs.Content>
          <Tabs.Content value="tokens" className="run-pane"><UsagePanel budget={run.budget} connection={run.connection} agentLabel="Arquiteto" prompt={run.prompt} schemaChars={JSON.stringify(ANALYSIS_JSON_SCHEMA).length} /></Tabs.Content>
          <Tabs.Content value="input" className="run-pane"><Input run={run} systemTitle="Instruções (protocolo do Arquiteto + ficha do Arquiteto)" /></Tabs.Content>
        </div>
      </Tabs.Root>
    </>
  );
}

/** What the analysis says it read, what it only inferred, what was sent but not cited, and what was not examined. */
function Coverage({ run }: { run: RunDetail }) {
  const a = run.analysis;
  const ctx = run.context?.kind === "github" ? run.context : null;
  if (!a || !ctx) return null;
  const path = (ref: string) => ref.trim().replace(/^`|`$/g, "").split(/[#\s(]/)[0];
  const read = a.examined.filter(e => e.basis === "read"), inferred = a.examined.filter(e => e.basis === "inferred");
  const cited = new Set(a.examined.map(e => path(e.ref)));
  const sentNotCited = ctx.files.filter(f => !cited.has(f.path));
  const notExamined = Math.max(0, ctx.structureSample.length - ctx.files.length);
  return (
    <section className="run-sec"><h4>Cobertura da leitura</h4>
      <ul>
        <li><b>Lido</b> (conteúdo enviado e conferido pelo executor): {read.length ? read.map(e => e.ref).join(", ") : "nenhum"}.</li>
        <li><b>Inferido</b> (não lido; deve ser conferido): {inferred.length ? inferred.map(e => e.ref).join(", ") : "nenhum"}.</li>
        <li><b>Enviado e não citado</b>: {sentNotCited.length ? sentNotCited.map(f => f.path).join(", ") : "nenhum"}.</li>
        <li><b>Não examinado</b>: os outros {notExamined} arquivo(s) de texto do repositório foram enviados só pelo nome{ctx.skipped.length ? `; pedidos e não lidos: ${ctx.skipped.map(x => `${x.path} (${x.reason})`).join(", ")}` : ""}.</li>
      </ul>
    </section>
  );
}

// ---- Developer implementation ----------------------------------------------

function DiffTable({ files }: { files: { path: string; status: "added" | "modified" | "deleted"; additions: number | null; deletions: number | null; inScope: boolean }[] }) {
  if (!files.length) return <p className="muted">Nenhum arquivo tocado.</p>;
  return (
    <table className="ctx-table"><thead><tr><th>Arquivo</th><th>Status</th><th>+/-</th><th>Escopo</th></tr></thead>
      <tbody>{files.map((f, i) => (
        <tr key={i} className={f.inScope ? "" : "cmp-row-new"}>
          <td><FileText size={12} /> {f.path}</td>
          <td>{f.status === "added" ? "criado" : f.status === "deleted" ? "removido" : "alterado"}</td>
          <td>{f.additions ?? "—"}/{f.deletions ?? "—"}</td>
          <td>{f.inScope ? "dentro do aprovado" : <b>FORA DO APROVADO</b>}</td>
        </tr>
      ))}</tbody>
    </table>
  );
}

function DeveloperBody({ run, active, agents, onCancel, onOpenRun, onReview }: BodyProps) {
  const [tab, setTab] = useState("implementation");
  const snap = run.snapshot as DeveloperSnapshot;
  const d = run.developer;
  const developer = agents.find(x => x.id === run.agentId);
  const name = (id: string) => agents.find(x => x.id === id)?.name ?? snap.team.find(t => t.id === id)?.name ?? id;
  const editable = snap.editScope.filter(e => e.action !== "consultar");
  const consult = snap.editScope.filter(e => e.action === "consultar");

  return (
    <>
      <DialogHeader>
        <span className="eyebrow">DESENVOLVEDOR · TAREFA {snap.task.id} · EXECUÇÃO {run.id.slice(0, 8).toUpperCase()}</span>
        <DialogTitle className="run-title">{snap.task.title}</DialogTitle>
        <DialogDescription asChild>
          <div>
            <Meta run={run} />
            <div className="run-origin">
              {developer && <Avatar look={developer.look} color={developer.color} size={22} />}
              <span>Demanda “{snap.demand.title}” · tarefa {snap.task.id}</span>
              {run.parentRunId && <button className="btn-ghost small" onClick={() => onOpenRun(run.parentRunId!)}><ArrowLeft size={13} /> Ver plano do Diretor</button>}
            </div>
          </div>
        </DialogDescription>
      </DialogHeader>
      {run.status === "awaiting_approval" && (
        <div className="run-live">Envio preparado e aguardando sua aprovação. Nenhuma cópia de trabalho existe ainda.<button className="btn-primary small" onClick={() => onReview(run.id)}><ShieldCheck size={13} /> Revisar e confirmar</button></div>
      )}
      {active && (
        <div className="run-live"><Loader2 size={15} className="spin" /> {run.status === "queued" ? "Na fila do executor local." : `Desenvolvedor trabalhando via ${connectionLabel(run.connection)} numa cópia isolada.`} Esta janela atualiza sozinha.
          <button className="btn-ghost" onClick={() => onCancel(run.id)}>Cancelar</button>
        </div>
      )}
      <ErrorBox run={run} />

      <Tabs.Root value={tab} onValueChange={setTab} className="run-tabs">
        <Tabs.List className="tab-list" aria-label="Detalhes da implementação">
          <Tabs.Trigger value="implementation">Implementação</Tabs.Trigger>
          <Tabs.Trigger value="diff">Diff {d?.diff?.files.length ? `(${d.diff.files.length})` : ""}</Tabs.Trigger>
          <Tabs.Trigger value="questions">Dúvidas {d?.questions.length ? `(${d.questions.length})` : ""}</Tabs.Trigger>
          <Tabs.Trigger value="task">Tarefa</Tabs.Trigger>
          <Tabs.Trigger value="events">Eventos</Tabs.Trigger>
          <Tabs.Trigger value="tokens">Tokens</Tabs.Trigger>
          <Tabs.Trigger value="input">Entrada</Tabs.Trigger>
        </Tabs.List>
        <div className="dialog-scroll run-scroll">
          <Tabs.Content value="implementation" className="run-pane">
            {!d && <p className="pane-intro">{active ? "O relatório aparecerá aqui quando o Desenvolvedor terminar." : run.status === "awaiting_approval" ? "O Desenvolvedor ainda não foi acionado." : "Esta execução não produziu um relatório."}</p>}
            {d && (
              <>
                {d.outcome === "needs_clarification" && <div className="notice">O Desenvolvedor não concluiu: ele precisa de respostas (aba Dúvidas).</div>}
                {d.diff?.outOfScope.length ? <div className="run-error" role="alert"><AlertTriangle size={16} /><div><b>O diff real tocou arquivo(s) fora do escopo aprovado.</b><small>{d.diff.outOfScope.join(", ")}</small></div></div> : null}
                <section className="run-sec"><h4>Resumo</h4><p>{d.summary || "—"}</p></section>
                <section className="run-sec"><h4>Critérios de aceite</h4>
                  {d.acceptance.length ? <table className="ctx-table"><thead><tr><th>Critério</th><th>Estado</th><th>Nota</th></tr></thead><tbody>{d.acceptance.map((c, i) => <tr key={i}><td>{c.criterion}</td><td><span className={`basis b-${c.status === "met" ? "read" : "inferred"}`}>{c.status === "met" ? "atendido" : c.status === "not_met" ? "não atendido" : "não verificado"}</span></td><td>{c.note}</td></tr>)}</tbody></table> : <p className="muted">—</p>}
                </section>
                <section className="run-sec"><h4>Arquivos relatados pelo Desenvolvedor</h4>{d.changes.length ? <ul>{d.changes.map((c, i) => <li key={i}><code>{c.path}</code> — {c.action === "created" ? "criado" : c.action === "deleted" ? "removido" : "alterado"}: {c.reason}</li>)}</ul> : <p className="muted">Nenhum.</p>}
                  <small>Conferido pelo executor contra o diff real da cópia isolada (aba Diff), não aceito só porque o modelo relatou.</small>
                </section>
                <div className="run-cols">
                  <section className="run-sec"><h4>Suposições</h4>{d.assumptions.length ? <ul>{d.assumptions.map((x, i) => <li key={i}>{x}</li>)}</ul> : <p className="muted">Nenhuma.</p>}</section>
                  <section className="run-sec"><h4>Não verificado</h4>{d.not_verified.length ? <ul>{d.not_verified.map((x, i) => <li key={i}>{x}</li>)}</ul> : <p className="muted">—</p>}</section>
                </div>
                <section className="run-sec limits"><h4>Limitações desta execução</h4><ul>{d.limitations.map((r, i) => <li key={i}>{r}</li>)}</ul></section>
                {run.status === "implementation_ready" && <p className="form-note">Implementação pronta na cópia isolada (já removida). Nada foi aplicado ao projeto original, commitado, publicado ou enviado ao QA a partir daqui.</p>}
              </>
            )}
          </Tabs.Content>

          <Tabs.Content value="diff" className="run-pane">
            {!d?.diff && <p className="muted">Nenhum diff calculado ainda.</p>}
            {d?.diff && (
              <>
                <p className="pane-intro">Calculado pelo executor (git diff dentro da cópia isolada), independente do que o modelo relatou. Commit de base: <code>{d.diff.baseCommit.slice(0, 12)}</code>.</p>
                <DiffTable files={d.diff.files} />
                <details className="raw"><summary>Ver o diff completo{d.diff.diffTruncated ? " (cortado por tamanho)" : ""}</summary><pre className="brief">{d.diff.diffText || "(vazio)"}</pre></details>
              </>
            )}
          </Tabs.Content>

          <Tabs.Content value="questions" className="run-pane">
            {!d?.questions.length && <p className="muted">Nenhuma pergunta.</p>}
            {!!d?.questions.length && (
              <>
                <p className="pane-intro">Perguntas registradas nesta execução. Responder a elas ainda não tem formulário dedicado nesta versão; prepare um novo envio manualmente se precisar prosseguir.</p>
                {d.questions.map((q, i) => <div key={i} className="question"><b>{i + 1}. {q.question}</b><small>Por que bloqueia: {q.why_it_blocks || "—"}</small></div>)}
              </>
            )}
          </Tabs.Content>

          <Tabs.Content value="task" className="run-pane">
            <section className="run-sec"><h4>Tarefa {snap.task.id}</h4>
              <dl className="kv"><dt>Escopo</dt><dd>{snap.task.scope}</dd><dt>Insumos</dt><dd>{snap.task.inputs || "—"}</dd><dt>Entregável</dt><dd>{snap.task.deliverable}</dd><dt>Critérios</dt><dd><ul>{snap.task.acceptance_criteria.map((c, i) => <li key={i}>{c}</li>)}</ul></dd></dl>
            </section>
            <section className="run-sec"><h4>Commit de base</h4><p><code>{snap.base.commit}</code> · cópia local “{snap.base.dirName}” ({snap.base.owner}/{snap.base.repo}) · revisão {snap.revision.number}{snap.revision.changedCommit ? ` · motivo: ${snap.revision.reason}` : ""}</p></section>
            <section className="run-sec"><h4>Escopo de edição aprovado</h4>
              <ul>{editable.map(e => <li key={e.path}><code>{e.path}</code> — {e.action}</li>)}</ul>
              {!!consult.length && <><small>Somente leitura:</small><ul className="ctx-skip">{consult.map(e => <li key={e.path}>{e.path}</li>)}</ul></>}
            </section>
            <section className="run-sec"><h4>Ferramentas nesta execução</h4><ul className="tool-grants">{snap.tools.map(t => <li key={t.label} className={t.allowed ? "ok" : "no"}><b>{t.label}: {t.allowed ? "permitida" : "bloqueada"}</b><small>{t.how}</small></li>)}</ul></section>
            {!!snap.plan.dependents.length && <section className="run-sec"><h4>Quem usa este resultado</h4><ul>{snap.plan.dependents.map(dd => <li key={dd.id}>{dd.id} · {dd.title} → {name(dd.assignee)} (não acionado automaticamente)</li>)}</ul></section>}
          </Tabs.Content>
          <Tabs.Content value="events" className="run-pane"><Events run={run} /></Tabs.Content>
          <Tabs.Content value="tokens" className="run-pane"><UsagePanel budget={run.budget} connection={run.connection} agentLabel="Desenvolvedor" prompt={run.prompt} schemaChars={JSON.stringify(DEVELOPER_JSON_SCHEMA).length} /></Tabs.Content>
          <Tabs.Content value="input" className="run-pane"><Input run={run} systemTitle="Instruções (protocolo do Desenvolvedor + ficha do Desenvolvedor)" /></Tabs.Content>
        </div>
      </Tabs.Root>
    </>
  );
}

/** Context revision and how the earlier questions were resolved (shown in the run and in the review). */
export function RevisionInfo({ snap, onOpenRun }: { snap: ArchitectSnapshot; onOpenRun?: (id: string) => void }) {
  const r = snap.revision;
  const cl = snap.clarifications ?? [];
  if (!r && !cl.length && !snap.decisions?.length) return null;
  return (
    <>
      {r && (
        <section className="run-sec"><h4>Revisão {r.number} do envio desta tarefa</h4>
          <ul>
            <li>Commit usado: <code>{r.commit?.slice(0, 12) ?? "—"}</code> {r.via === "local_git" ? "(cópia local autorizada)" : r.via === "github" ? "(GitHub público)" : ""}</li>
            {r.previousRunId && <li>Envio anterior: {onOpenRun ? <button className="link" onClick={() => onOpenRun(r.previousRunId!)}>{r.previousRunId.slice(0, 8)}</button> : r.previousRunId.slice(0, 8)} · commit <code>{r.previousCommit?.slice(0, 12) ?? "—"}</code> {r.previousVia === "local_git" ? "(cópia local)" : "(GitHub)"} — não foi alterado</li>}
            {!r.previousRunId && r.changedCommit && <li>Primeiro envio desta tarefa. Commit que o Diretor leu: <code>{r.previousCommit?.slice(0, 12) ?? "—"}</code> {r.previousVia === "local_git" ? "(cópia local)" : "(GitHub público)"} — o plano do Diretor não foi alterado.</li>}
            <li>{r.changedCommit ? (r.previousRunId ? "Commit ou fonte trocados nesta revisão." : "Commit ou fonte diferentes do que o Diretor leu.") : "Mesmo commit e fonte do envio anterior."} Motivo: {r.reason}</li>
          </ul>
          {!!r.requestedFiles?.length && <><small>Arquivos confirmados por você para leitura ({r.requestedFiles.length}):</small><ul className="ctx-skip">{r.requestedFiles.map(f => <li key={f.ref}><code>{f.ref}</code> — {f.reason}</li>)}</ul></>}
          {r.comparisons?.map((c, i) => <ComparisonTable key={i} c={c} />)}
        </section>
      )}
      {!!cl.length && (
        <section className="run-sec"><h4>Esclarecimentos entregues ao Arquiteto</h4>
          <ol>{cl.map((c, i) => (
            <li key={i}><b>{c.question}</b>
              {c.resolution.by === "user"
                ? <div className="answer-by user"><span className="tag">resposta sua</span> {c.resolution.answer}</div>
                : <div className="answer-by reading"><span className="tag">resolvida por leitura</span> commit <code>{c.resolution.commit.slice(0, 12)}</code>: {c.resolution.readFiles.join(", ") || "nenhum arquivo encontrado"}{c.resolution.missing.length ? ` · não encontrados/removidos: ${c.resolution.missing.join(", ")}` : ""} <small>(pedidos: {c.resolution.requested.join(", ")})</small></div>}
            </li>
          ))}</ol>
        </section>
      )}
      {!!snap.decisions?.length && <section className="run-sec"><h4>Decisões suas neste envio</h4><ul>{snap.decisions.map((d, i) => <li key={i}><span className="tag">decisão sua</span> <b>{d.topic}:</b> {d.answer}</li>)}</ul></section>}
      {snap.scope && <section className="run-sec"><h4>Escopo pedido ao Arquiteto</h4><ul>{snap.scope.asked.map((x, i) => <li key={i}>{x}</li>)}</ul><small>Fora do escopo:</small><ul>{snap.scope.outOfScope.map((x, i) => <li key={i}>{x}</li>)}</ul></section>}
    </>
  );
}

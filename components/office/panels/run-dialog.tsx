"use client";

import { useEffect, useState } from "react";
import { Tabs } from "radix-ui";
import { AlertTriangle, CheckCircle2, CircleDashed, FileText, HelpCircle, Loader2, RefreshCw, Send, XCircle } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Avatar } from "../avatar";
import { engineApi } from "@/lib/engine/client";
import { connectionLabel } from "@/lib/engine/connections";
import { ACTIVE_STATUSES, RUN_STATUS_LABEL, type RunDetail, type RunStatus } from "@/lib/engine/types";
import type { Agent } from "@/lib/office/types";

const fmt = (n: number | null | undefined) => (n == null ? "—" : n.toLocaleString("pt-BR"));
const time = (iso: string | null) => (iso ? new Date(iso).toLocaleString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit", day: "2-digit", month: "short" }) : "—");

export function StatusBadge({ status }: { status: RunStatus | "prepared" }) {
  const label = status === "prepared" ? "Preparada" : RUN_STATUS_LABEL[status];
  const Icon = status === "prepared" ? CircleDashed : ACTIVE_STATUSES.includes(status as RunStatus) ? Loader2 : status === "plan_ready" ? CheckCircle2 : status === "awaiting_clarification" ? HelpCircle : status === "failed" ? XCircle : CircleDashed;
  return <span className={`run-badge st-${status}`}><Icon size={13} className={ACTIVE_STATUSES.includes(status as RunStatus) ? "spin" : ""} aria-hidden />{label}</span>;
}

export function RunDialog({ runId, agents, onClose, onReplan, onCancel }: {
  runId: string | null;
  agents: Agent[];
  onClose: () => void;
  onReplan: (run: RunDetail, answers?: { question: string; answer: string }[]) => void;
  onCancel: (runId: string) => void;
}) {
  return (
    <Dialog open={!!runId} onOpenChange={v => !v && onClose()}>
      <DialogContent className="game-dialog run-dialog">
        {runId && <RunBody key={runId} runId={runId} agents={agents} onReplan={onReplan} onCancel={onCancel} />}
      </DialogContent>
    </Dialog>
  );
}

function RunBody({ runId, agents, onReplan, onCancel }: { runId: string; agents: Agent[]; onReplan: (run: RunDetail, answers?: { question: string; answer: string }[]) => void; onCancel: (id: string) => void }) {
  const [run, setRun] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState("plan");
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const active = run ? ACTIVE_STATUSES.includes(run.status) : true;

  useEffect(() => {
    let stop = false;
    const load = async () => {
      try { const r = (await engineApi.get(runId)).run; if (!stop) { setRun(r); setError(null); } }
      catch (e) { if (!stop) setError((e as Error).message); }
    };
    void load();
    const t = setInterval(() => { if (active) void load(); }, 2000);
    return () => { stop = true; clearInterval(t); };
  }, [runId, active]);

  if (!run) return <div className="run-loading">{error ?? <><Loader2 size={16} className="spin" /> Carregando execução…</>}</div>;
  const res = run.result;
  const who = (id: string) => agents.find(a => a.id === id) ?? null;
  const name = (id: string) => who(id)?.name ?? run.snapshot.team.find(t => t.id === id)?.name ?? id;
  const b = run.budget;
  const reported = [...new Set(b.calls.map(c => c.model).filter(Boolean))].join(", ");

  return (
    <>
      <DialogHeader>
        <span className="eyebrow">EXECUÇÃO DO DIRETOR · {run.id.slice(0, 8).toUpperCase()}</span>
        <DialogTitle className="run-title">{run.snapshot.demand.title}</DialogTitle>
        <DialogDescription asChild>
          <div className="run-meta">
            <StatusBadge status={run.status} />
            <span>Conexão: <b>{connectionLabel(run.connection)}</b></span>
            <span>Modelo: <b>{run.model || "padrão do cliente"}</b>{reported ? <small> (informado: {reported})</small> : null}</span>
            {run.effort && <span>Esforço: <b>{run.effort}</b></span>}
            <span>Criada {time(run.createdAt)}</span>
            {run.finishedAt && <span>Concluída {time(run.finishedAt)}</span>}
          </div>
        </DialogDescription>
      </DialogHeader>

      {active && (
        <div className="run-live"><Loader2 size={15} className="spin" /> O Diretor está {run.status === "queued" ? "na fila do executor local" : `planejando via ${connectionLabel(run.connection)}`}. Esta janela atualiza sozinha; você pode fechá-la e voltar depois.
          <button className="btn-ghost" onClick={() => onCancel(run.id)}>Cancelar</button>
        </div>
      )}
      {run.error && (
        <div className="run-error" role="alert">
          <AlertTriangle size={16} />
          <div><b>{run.error.message}</b><small>Código: {run.error.code}{run.error.retryable ? " · pode tentar novamente" : ""}</small>{run.error.detail && <pre>{run.error.detail}</pre>}{!!run.error.recovery?.length && <><span className="eyebrow">COMO RESOLVER</span><ol className="conn-steps">{run.error.recovery.map((r, i) => <li key={i}>{r}</li>)}</ol></>}</div>
        </div>
      )}

      <Tabs.Root value={tab} onValueChange={setTab} className="run-tabs">
        <Tabs.List className="tab-list" aria-label="Detalhes da execução">
          <Tabs.Trigger value="plan">Plano</Tabs.Trigger>
          <Tabs.Trigger value="tasks">Tarefas {res ? `(${res.tasks.length})` : ""}</Tabs.Trigger>
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
            <p className="pane-intro">Propostas de delegação. Nenhum colaborador foi acionado: nesta fase só o Diretor executa.</p>
            {res?.tasks.map(t => {
              const a = who(t.assignee);
              return (
                <article key={t.id} className="task-card">
                  <header>{a ? <Avatar look={a.look} color={a.color} size={30} /> : null}<div><b>{t.id} · {t.title}</b><small>{name(t.assignee)} · etapa {t.step_id || "—"}{t.depends_on.length ? ` · depende de ${t.depends_on.join(", ")}` : ""}</small></div><span className="tag">proposta · não delegada</span></header>
                  <dl>
                    <dt>Escopo</dt><dd>{t.scope}</dd>
                    <dt>Insumos</dt><dd>{t.inputs || "—"}</dd>
                    <dt>Entregável</dt><dd>{t.deliverable}</dd>
                    <dt>Critérios de aceite</dt><dd><ul>{t.acceptance_criteria.map((c, i) => <li key={i}>{c}</li>)}</ul></dd>
                  </dl>
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

          <Tabs.Content value="context" className="run-pane">
            {!run.context && <p className="muted">O contexto ainda não foi montado.</p>}
            {run.context?.kind === "none" && <p>Sem fonte: o Diretor usou apenas a descrição e os critérios da demanda.</p>}
            {run.context?.kind === "folder" && (
              <div className="notice"><b>Os arquivos da pasta “{run.context.summary.name}” não foram lidos.</b> Apenas metadados foram enviados: {run.context.summary.fileCount} arquivos, {fmt(run.context.summary.totalBytes)} bytes. O envio real dos arquivos pertence a uma etapa futura.</div>
            )}
            {run.context?.kind === "github" && (
              <>
                <p>Repositório público <b>{run.context.owner}/{run.context.repo}</b>, branch <b>{run.context.branch}</b>, commit <code>{run.context.commit.slice(0, 12)}</code> · leitura em {fmt(run.context.elapsedMs)} ms.</p>
                <h4 className="ctx-h">Arquivos realmente consultados ({run.context.files.length})</h4>
                <table className="ctx-table"><thead><tr><th>Arquivo</th><th>Motivo</th><th>Tamanho</th><th>Enviado</th></tr></thead>
                  <tbody>{run.context.files.map(f => <tr key={f.path}><td><FileText size={12} /> {f.path}</td><td>{f.reason}</td><td>{fmt(f.bytes)} B</td><td>{fmt(f.sentChars)} car.{f.truncated ? " (truncado)" : ""}</td></tr>)}</tbody>
                </table>
                {!!run.context.skipped.length && <><h4 className="ctx-h">Não lidos</h4><ul className="ctx-skip">{run.context.skipped.map(s => <li key={s.path}>{s.path} — {s.reason}</li>)}</ul></>}
                <small className="muted">Limites: {run.context.limits.maxFiles} arquivos, {fmt(run.context.limits.maxFileBytes)} caracteres por arquivo, {fmt(run.context.limits.maxTotalChars)} no total, {run.context.limits.timeoutMs / 1000}s. Conteúdo do repositório tratado como dado não confiável.</small>
              </>
            )}
          </Tabs.Content>

          <Tabs.Content value="events" className="run-pane">
            <ol className="events">{run.events.map(e => <li key={e.seq} className={`ev-${e.kind}`}><time>{time(e.at)}</time><span>{e.message}</span></li>)}</ol>
          </Tabs.Content>

          <Tabs.Content value="tokens" className="run-pane">
            <div className="token-grid">
              <div><span className="eyebrow">ORÇAMENTO DA FICHA</span><b>{fmt(b.sheetTokens)}</b><small>limite do Setor IA</small></div>
              <div><span className="eyebrow">TEXTO ENVIADO</span><b>{b.estimatedInputTokens == null ? "—" : `≈ ${fmt(b.estimatedInputTokens)}`}</b><small>estimativa do Setor IA (o cliente acrescenta instruções próprias)</small></div>
              <div><span className="eyebrow">USO INFORMADO</span><b>{b.reportedTotalTokens == null ? "não informado" : fmt(b.reportedTotalTokens)}</b><small>{b.reportedTotalTokens == null ? "o cliente não informou" : "somado do que o cliente reportou"}</small></div>
              <div className={b.exceeded ? "warn" : ""}><span className="eyebrow">DENTRO DO ORÇAMENTO?</span><b>{b.reportedTotalTokens == null ? "—" : b.exceeded ? "Não" : "Sim"}</b><small>{b.exceeded ? "o cliente não pode ser interrompido no meio da resposta" : "comparado ao uso informado"}</small></div>
            </div>
            {!!b.calls.length && (
              <table className="ctx-table"><thead><tr><th>Chamada</th><th>Entrada</th><th>Cache lido</th><th>Cache gravado</th><th>Saída</th><th>Raciocínio</th><th>Modelo informado</th></tr></thead>
                <tbody>{b.calls.map((c, i) => <tr key={i}><td>{c.label}</td><td>{fmt(c.inputTokens)}</td><td>{fmt(c.cacheReadTokens)}</td><td>{fmt(c.cacheWriteTokens)}</td><td>{fmt(c.outputTokens)}</td><td>{fmt(c.reasoningTokens)}</td><td>{c.model ?? "não informado"}</td></tr>)}</tbody>
              </table>
            )}
            <p className="form-note">Os números acima são apenas os que o cliente oficial informou ao final da chamada. O saldo e os limites da sua assinatura (Claude ou ChatGPT Business) não são expostos ao Setor IA; quando o limite é atingido, o cliente avisa e a execução mostra esse erro. Nada aqui é um teto absoluto garantido.</p>
          </Tabs.Content>

          <Tabs.Content value="input" className="run-pane">
            <p className="pane-intro">Entrada congelada no início da execução (snapshot {run.snapshotHash.slice(0, 12)}). Alterações posteriores na ficha não mudam este registro.</p>
            {run.prompt ? (
              <>
                <h4 className="ctx-h">Instruções (protocolo da fase + ficha do Diretor){run.connection === "codex" ? " — enviadas ao Codex no início da mesma entrada" : " — enviadas ao Claude Code como system prompt"}</h4>
                <pre className="brief">{run.prompt.system}</pre>
                <h4 className="ctx-h">Mensagem (demanda, equipe e fonte)</h4>
                <pre className="brief">{run.prompt.user}</pre>
              </>
            ) : <pre className="brief">{run.snapshot.director.brief}</pre>}
            {run.rawOutput && <><h4 className="ctx-h">Resposta bruta devolvida pelo cliente</h4><pre className="brief">{run.rawOutput}</pre></>}
          </Tabs.Content>
        </div>
      </Tabs.Root>

      <div className="dialog-actions">
        {!active && <button className="btn-secondary" onClick={() => onReplan(run)}><RefreshCw size={14} /> Planejar novamente</button>}
      </div>
    </>
  );
}

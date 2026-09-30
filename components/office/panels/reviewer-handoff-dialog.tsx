"use client";

import { useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, Lock, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { useRuns } from "@/hooks/use-runs";
import { toTeamInput } from "@/lib/engine/client";
import { CONNECTION_STATE_LABEL, connectionLabel, connectionStatusFor } from "@/lib/engine/connections";
import type { ReviewerSnapshot } from "@/lib/engine/types";
import type { Agent } from "@/lib/office/types";
import { useRunDetail } from "./run-dialog";

type RunsApi = ReturnType<typeof useRuns>;
const fmt = (n: number) => n.toLocaleString("pt-BR");
const VERDICT_LABEL: Record<string, string> = { approved: "aprovado", rejected: "reprovado", not_verified: "não verificado" };

/**
 * Review of a prepared hand-off to the Reviewer (status awaiting_approval). Everything shown here comes from
 * the executor's frozen record — the QA parecer and the same real deliverables QA itself had, never a live
 * re-run. No model has been called yet: that only happens after you confirm.
 */
export function ReviewerHandoffDialog({ runId, agents, runs, onClose, onApproved }: {
  runId: string | null; agents: Agent[]; runs: RunsApi; onClose: () => void; onApproved: (runId: string) => void;
}) {
  return (
    <Dialog open={!!runId} onOpenChange={v => !v && onClose()}>
      <DialogContent className="game-dialog run-dialog handoff-dialog">
        {runId && <Review key={runId} runId={runId} agents={agents} runs={runs} onClose={onClose} onApproved={onApproved} />}
      </DialogContent>
    </Dialog>
  );
}

function Review({ runId, agents, runs, onClose, onApproved }: { runId: string; agents: Agent[]; runs: RunsApi; onClose: () => void; onApproved: (runId: string) => void }) {
  const { run, error } = useRunDetail(runId);
  const [busy, setBusy] = useState<"" | "approve" | "discard" | "verify">("");
  const [msg, setMsg] = useState<string | null>(null);
  if (!run) return <div className="run-loading">{error ?? <><Loader2 size={16} className="spin" /> Carregando o envio preparado…</>}</div>;
  const snap = run.snapshot as ReviewerSnapshot;
  const conn = connectionStatusFor(run.connection, runs.status);
  const executorUp = !!runs.status?.executionEnabled;
  const current = agents.find(a => a.id === snap.agent.id);
  const cur = current ? toTeamInput(current, agents) : null;
  const sheetChanged = !!cur && (cur.brief !== snap.agent.brief || cur.connection !== snap.agent.connection || cur.modelName !== snap.agent.modelName || cur.effort !== snap.agent.effort);
  const est = run.budget.estimatedInputTokens ?? 0;
  const overBudget = run.budget.sheetTokens > 0 && est >= run.budget.sheetTokens;
  const pending = run.status === "awaiting_approval";
  const canConfirm = pending && executorUp && conn?.state === "connected" && !sheetChanged;

  const approve = async () => {
    setBusy("approve"); setMsg(null);
    const r = await runs.approve(run.id, run.snapshotHash);
    setBusy("");
    if (r.ok) onApproved(run.id); else setMsg(r.error);
  };
  const discard = async () => { setBusy("discard"); await runs.cancel(run.id); setBusy(""); onClose(); };
  const verify = async () => { setBusy("verify"); await runs.verify(); setBusy(""); };

  return (
    <>
      <DialogHeader>
        <span className="eyebrow">REVISAR ANTES DE ENVIAR · TAREFA {snap.task.id} → REVISOR</span>
        <DialogTitle className="run-title">{snap.task.title}</DialogTitle>
        <DialogDescription>
          {pending ? "Nada foi executado. Nenhuma chamada foi feita ainda — ela só começa se você confirmar. O Revisor não recebe ferramenta alguma; tudo abaixo é o texto exato que ele vai ler, reaproveitado do próprio contexto do QA." : `Este envio não está mais aguardando aprovação (estado atual: ${run.status}).`}
        </DialogDescription>
      </DialogHeader>
      <div className="dialog-scroll run-scroll">
        <section className="run-sec"><h4>1. Demanda e critérios de aceite</h4>
          <p><b>{snap.demand.title}</b>{snap.demand.project ? ` · ${snap.demand.project}` : ""}</p>
          <p className="clamp">{snap.demand.description}</p>
          {!!snap.demand.acceptanceCriteria.length && <ol>{snap.demand.acceptanceCriteria.map((c, i) => <li key={i}>{c}</li>)}</ol>}
        </section>

        <section className="run-sec"><h4>2. Tarefa desta revisão final</h4>
          <dl className="kv"><dt>Escopo</dt><dd>{snap.task.scope}</dd><dt>Entregável</dt><dd>{snap.task.deliverable}</dd></dl>
        </section>

        <section className="run-sec"><h4>3. Parecer do QA (tarefa {snap.qa.taskId})</h4>
          <p className="clamp"><b>Resumo do QA:</b> {snap.qa.result.summary}</p>
          <p className="muted">Recomendação do QA: {snap.qa.result.recommendation}</p>
          <ul className="tool-grants">
            {snap.qa.result.criteria.map((c, i) => (
              <li key={i} className={c.verdict === "approved" ? "ok" : c.verdict === "rejected" ? "no" : "warn"}>
                <b>[{VERDICT_LABEL[c.verdict]}] {c.criterion}</b>
                {c.verdict === "approved" && c.evidence && <small>evidência: {c.evidence}</small>}
                {c.verdict === "rejected" && c.rejected && <small>esperado: {c.rejected.expected} · observado: {c.rejected.observed}</small>}
                {c.verdict === "not_verified" && c.notVerifiedReason && <small>motivo: {c.notVerifiedReason}</small>}
              </li>
            ))}
          </ul>
        </section>

        <section className="run-sec"><h4>4. Análises do Arquiteto no contexto (reaproveitadas do QA)</h4>
          {snap.analyses.length ? snap.analyses.map(a => (
            <div key={a.runId} className="question">
              <b>{a.taskId} · análise concluída {a.runId.slice(0, 8)}, commit <code>{a.commit?.slice(0, 12) ?? "—"}</code></b>
              <small>Recomendação: {a.recommendation.summary}</small>
            </div>
          )) : <p className="muted">Nenhuma análise do Arquiteto na cadeia desta tarefa.</p>}
        </section>

        <section className="run-sec"><h4>5. Entregas reais (reaproveitadas do contexto do QA)</h4>
          {snap.deliverables.length ? snap.deliverables.map(d => (
            <div key={d.taskId} className="question">
              <b>{d.taskId} · {d.title} ({d.assignee})</b>
              <small>{d.note}</small>
              {d.commit && <small>Commit: <code>{d.commit.slice(0, 12)}</code> · {d.files.length} arquivo(s)</small>}
              {d.verification && (
                <ul className="tool-grants">
                  {([["Tipos", d.verification.typecheck], ["Lint", d.verification.lint], ["Testes", d.verification.tests], ["Build", d.verification.build]] as const).map(([label, c]) => (
                    <li key={label} className={c?.ran ? "ok" : "no"}><b>{label}: {c?.ran ? "executado" : "não executado"}</b>{c && <small><code>{c.command}</code> → {c.result}</small>}</li>
                  ))}
                </ul>
              )}
              {d.diffText && <details className="raw"><summary>Ver diff real{d.diffTruncated ? " (cortado por tamanho)" : ""}</summary><pre className="brief">{d.diffText}</pre></details>}
            </div>
          )) : <p className="muted">Nenhuma entrega real registrada ainda.</p>}
        </section>

        <section className="run-sec"><h4>6. Ferramentas desta execução</h4>
          <ul className="tool-grants">{snap.tools.map(t => <li key={t.label} className={t.allowed ? "ok" : "no"}><b>{t.label}: {t.allowed ? "permitida" : "bloqueada"}</b><small>{t.how}</small></li>)}</ul>
          <p className="form-note"><Lock size={13} /> O Revisor roda em modo somente leitura, sem nenhuma ferramenta concedida pelo cliente (igual ao QA) — tudo o que ele sabe está no texto desta revisão.</p>
        </section>

        <section className="run-sec"><h4>7. Consumo de contexto</h4>
          <p className={`form-note ${overBudget ? "warn" : ""}`}>Texto enviado (instruções): cerca de {fmt(est)} tokens (estimativa do Setor IA). Orçamento da ficha do Revisor: {fmt(run.budget.sheetTokens)} tokens (referência/alerta — o cliente não é interrompido no meio da resposta).{overBudget ? " A estimativa já passa do orçamento: ao confirmar, você aceita esse alerta." : ""}</p>
          {!!snap.contextBudget.omitted.length && <><small>Reduzido para caber no orçamento (nada de commit/arquivos/verificação foi omitido, só texto de diff):</small><ul className="ctx-skip">{snap.contextBudget.omitted.map((o, i) => <li key={i}>{o}</li>)}</ul></>}
          <details className="raw"><summary>Ver o texto exato que será enviado</summary>
            <h4 className="ctx-h">Instruções (protocolo do Revisor + ficha salva do Revisor)</h4><pre className="brief">{run.prompt?.system}</pre>
            <h4 className="ctx-h">Mensagem</h4><pre className="brief">{run.prompt?.user}</pre>
          </details>
        </section>

        <section className="run-sec"><h4>8. Conexão e modelo da ficha do Revisor</h4>
          <div className={`conn-card ${conn?.state === "connected" ? "ok" : "bad"}`}>
            <div className="conn-head">
              {conn?.state === "connected" ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
              <b>{connectionLabel(run.connection, runs.status?.apiConnections)}</b>
              <span className={`conn-badge ${conn?.state === "connected" ? "ok" : "bad"}`}>{conn ? CONNECTION_STATE_LABEL[conn.state] : executorUp ? "estado desconhecido" : "executor indisponível"}</span>
              <span className="muted">modelo: {run.model || "escolhido pelo próprio cliente (padrão dele; o modelo usado é registrado ao final)"}{run.effort ? ` · esforço: ${run.effort}` : ""}</span>
              <span className="grow" />
              <button type="button" className="btn-ghost" onClick={verify} disabled={!!busy}>{busy === "verify" ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} Verificar conexão</button>
            </div>
            {!executorUp && <p className="conn-msg">{runs.status?.disabledReason ?? runs.statusError ?? "Executor local indisponível."}</p>}
            {conn && <p className="conn-msg">{conn.message}</p>}
            {conn && conn.state !== "connected" && !!conn.steps.length && <ol className="conn-steps">{conn.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>}
          </div>
        </section>

        {sheetChanged && <div className="run-error" role="alert"><AlertTriangle size={16} /><div><b>A ficha do Revisor mudou depois que este envio foi preparado.</b><small>Descarte e clique em “Enviar ao Revisor” de novo para usar a ficha atual.</small></div></div>}
        {msg && <p className="form-error" role="alert">{msg}</p>}
      </div>
      <div className="dialog-actions">
        {pending && <button className="btn-ghost danger" onClick={discard} disabled={!!busy}><Trash2 size={14} /> Descartar envio</button>}
        <button className="btn-secondary" onClick={onClose}>{pending ? "Decidir depois" : "Fechar"}</button>
        {pending && (
          <button className="btn-primary" onClick={approve} disabled={!canConfirm || !!busy} title={!canConfirm ? (sheetChanged ? "A ficha mudou: prepare de novo." : "A conexão do Revisor precisa estar ativa.") : undefined}>
            {busy === "approve" ? <><Loader2 size={15} className="spin" /> Confirmando…</> : <><ShieldCheck size={15} /> Confirmar e enviar ao Revisor</>}
          </button>
        )}
      </div>
    </>
  );
}

"use client";

import { useState } from "react";
import { AlertTriangle, CheckCircle2, FileText, Loader2, Lock, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { useRuns } from "@/hooks/use-runs";
import { toTeamInput } from "@/lib/engine/client";
import { CONNECTION_STATE_LABEL, connectionLabel, connectionStatusFor } from "@/lib/engine/connections";
import type { DeveloperSnapshot } from "@/lib/engine/types";
import type { Agent } from "@/lib/office/types";
import { useRunDetail } from "./run-dialog";

type RunsApi = ReturnType<typeof useRuns>;
const fmt = (n: number) => n.toLocaleString("pt-BR");

/**
 * Review of a prepared hand-off to the Developer (status awaiting_approval). Everything shown here comes
 * from the executor's frozen record. No working copy exists yet: it is only built after you confirm.
 */
export function DeveloperHandoffDialog({ runId, agents, runs, onClose, onApproved }: {
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
  const snap = run.snapshot as DeveloperSnapshot;
  const conn = connectionStatusFor(run.connection, runs.status);
  const executorUp = !!runs.status?.executionEnabled;
  const current = agents.find(a => a.id === snap.agent.id);
  const cur = current ? toTeamInput(current, agents) : null;
  const sheetChanged = !!cur && (cur.brief !== snap.agent.brief || cur.connection !== snap.agent.connection || cur.modelName !== snap.agent.modelName || cur.effort !== snap.agent.effort);
  const est = run.budget.estimatedInputTokens ?? 0;
  const overBudget = run.budget.sheetTokens > 0 && est >= run.budget.sheetTokens;
  const pending = run.status === "awaiting_approval";
  const canConfirm = pending && executorUp && conn?.state === "connected" && !sheetChanged;
  const editable = snap.editScope.filter(e => e.action !== "consultar");
  const consult = snap.editScope.filter(e => e.action === "consultar");

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
        <span className="eyebrow">REVISAR ANTES DE ENVIAR · TAREFA {snap.task.id} → DESENVOLVEDOR</span>
        <DialogTitle className="run-title">{snap.task.title}</DialogTitle>
        <DialogDescription>
          {pending ? "Nada foi executado. Nenhuma cópia de trabalho existe ainda — ela só é criada se você confirmar, e nunca no lugar do seu projeto." : `Este envio não está mais aguardando aprovação (estado atual: ${run.status}).`}
        </DialogDescription>
      </DialogHeader>
      <div className="dialog-scroll run-scroll">
        <section className="run-sec"><h4>1. Demanda original</h4>
          <p><b>{snap.demand.title}</b>{snap.demand.project ? ` · ${snap.demand.project}` : ""}</p>
          <p className="clamp">{snap.demand.description}</p>
          {!!snap.demand.acceptanceCriteria.length && <><small>Critérios de aceite da demanda:</small><ol>{snap.demand.acceptanceCriteria.map((c, i) => <li key={i}>{c}</li>)}</ol></>}
        </section>

        <section className="run-sec"><h4>2. Tarefa e dependências satisfeitas</h4>
          <dl className="kv"><dt>Escopo</dt><dd>{snap.task.scope}</dd><dt>Insumos</dt><dd>{snap.task.inputs || "—"}</dd><dt>Entregável</dt><dd>{snap.task.deliverable}</dd><dt>Critérios da tarefa</dt><dd><ul>{snap.task.acceptance_criteria.map((c, i) => <li key={i}>{c}</li>)}</ul></dd></dl>
          {snap.dependencies.map(d => (
            <div key={d.runId} className="question">
              <b>{d.taskId} · análise concluída {d.runId.slice(0, 8)}{d.revision ? ` (revisão ${d.revision})` : ""}, commit <code>{d.commit?.slice(0, 12) ?? "—"}</code></b>
              <small>Recomendação: {d.recommendation.summary}</small>
              {!!d.decisions.length && <div className="answer-by user"><span className="tag">decisão sua</span> {d.decisions.map(x => `${x.topic}: ${x.answer}`).join("; ")}</div>}
            </div>
          ))}
        </section>

        <section className={`run-sec ${snap.revision.changedCommit ? "rev-changed" : ""}`}><h4>3. Commit de base{snap.revision.number > 1 ? ` (revisão ${snap.revision.number})` : ""}</h4>
          <p>Commit <code>{snap.base.commit}</code>, cópia local autorizada “{snap.base.dirName}” ({snap.base.owner}/{snap.base.repo}) — {snap.base.treeEntries} arquivo(s) na cópia isolada. Motivo: {snap.revision.reason}</p>
          {snap.revision.previousRunId && <small>Envio anterior desta tarefa: {snap.revision.previousRunId.slice(0, 8)}, commit <code>{snap.revision.previousCommit?.slice(0, 12) ?? "—"}</code> — não foi alterado.</small>}
        </section>

        <section className="run-sec"><h4>4. Onde a edição será permitida (não é uma cópia do seu projeto)</h4>
          <p>Ao confirmar, o executor monta uma <b>cópia isolada</b> do commit acima (git archive; sem histórico do projeto real, sem node_modules, sem alterações não commitadas) numa pasta temporária. O Desenvolvedor só enxerga essa cópia; seu projeto não é tocado.</p>
          <table className="ctx-table"><thead><tr><th>Caminho</th><th>Ação prevista</th><th>Motivo</th></tr></thead>
            <tbody>{editable.map(e => <tr key={e.path}><td><FileText size={12} /> {e.path}</td><td><span className={`cmp-${e.action === "criar" ? "new" : "changed"}`}>{e.action}</span></td><td>{e.from.join("; ")}</td></tr>)}</tbody>
          </table>
          {!!consult.length && <><small>Somente leitura, para contexto (não é editado):</small><ul className="ctx-skip">{consult.map(e => <li key={e.path}>{e.path} — {e.from.join("; ")}</li>)}</ul></>}
          <small>Fora do escopo desta execução: {snap.outOfScope.join(" · ")}</small>
        </section>

        <section className="run-sec"><h4>5. Ferramentas desta execução</h4>
          <ul className="tool-grants">{snap.tools.map(t => <li key={t.label} className={t.allowed ? "ok" : "no"}><b>{t.label}: {t.allowed ? "permitida" : "bloqueada"}</b><small>{t.how}</small></li>)}</ul>
          <p className="form-note"><Lock size={13} /> Isolamento de escrita: baseado no comportamento documentado do próprio cliente (<code>--restricted</code>), ainda não confirmado por uma chamada real nesta versão.</p>
        </section>

        <section className="run-sec"><h4>6. Limites aplicados</h4>
          <ul>
            <li>Tempo por chamada: até {Math.round(snap.limits.timeoutMs / 60000)} min; o cliente é encerrado se passar disso.</li>
            <li>No máximo 1 tentativa de correção automática (2 chamadas ao todo) se a resposta ou o diff vierem inválidos.</li>
            <li>Diff exibido: até {fmt(snap.limits.maxDiffChars)} caracteres (o diff real pode ser maior; o restante fica indicado, não escondido).</li>
            <li>Nenhum comando é executado nesta versão (terminal bloqueado — ver seção 5).</li>
          </ul>
          <p className={`form-note ${overBudget ? "warn" : ""}`}>Texto enviado (instruções): cerca de {fmt(est)} tokens (estimativa do Setor IA). Orçamento da ficha do Desenvolvedor: {fmt(run.budget.sheetTokens)} tokens (referência/alerta).{overBudget ? " A estimativa já passa do orçamento: ao confirmar, você aceita esse alerta." : ""}</p>
          <details className="raw"><summary>Ver o texto exato que será enviado</summary>
            <h4 className="ctx-h">Instruções (protocolo do Desenvolvedor + ficha salva do Desenvolvedor)</h4><pre className="brief">{run.prompt?.system}</pre>
            <h4 className="ctx-h">Mensagem</h4><pre className="brief">{run.prompt?.user}</pre>
          </details>
        </section>

        <section className="run-sec"><h4>7. Conexão e modelo da ficha do Desenvolvedor</h4>
          <div className={`conn-card ${conn?.state === "connected" ? "ok" : "bad"}`}>
            <div className="conn-head">
              {conn?.state === "connected" ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
              <b>{connectionLabel(run.connection)}</b>
              <span className={`conn-badge ${conn?.state === "connected" ? "ok" : "bad"}`}>{conn ? CONNECTION_STATE_LABEL[conn.state] : executorUp ? "estado desconhecido" : "executor indisponível"}</span>
              <span className="muted">modelo: {run.model || "padrão do cliente"}{run.effort ? ` · esforço: ${run.effort}` : ""}</span>
              <span className="grow" />
              <button type="button" className="btn-ghost" onClick={verify} disabled={!!busy}>{busy === "verify" ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} Verificar conexão</button>
            </div>
            {!executorUp && <p className="conn-msg">{runs.status?.disabledReason ?? runs.statusError ?? "Executor local indisponível."}</p>}
            {conn && <p className="conn-msg">{conn.message}</p>}
            {conn && conn.state !== "connected" && !!conn.steps.length && <ol className="conn-steps">{conn.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>}
          </div>
        </section>

        {sheetChanged && <div className="run-error" role="alert"><AlertTriangle size={16} /><div><b>A ficha do Desenvolvedor mudou depois que este envio foi preparado.</b><small>Descarte e clique em “Enviar ao Desenvolvedor” de novo para usar a ficha atual.</small></div></div>}
        {msg && <p className="form-error" role="alert">{msg}</p>}
      </div>
      <div className="dialog-actions">
        {pending && <button className="btn-ghost danger" onClick={discard} disabled={!!busy}><Trash2 size={14} /> Descartar envio</button>}
        <button className="btn-secondary" onClick={onClose}>{pending ? "Decidir depois" : "Fechar"}</button>
        {pending && (
          <button className="btn-primary" onClick={approve} disabled={!canConfirm || !!busy} title={!canConfirm ? (sheetChanged ? "A ficha mudou: prepare de novo." : "A conexão do Desenvolvedor precisa estar ativa.") : undefined}>
            {busy === "approve" ? <><Loader2 size={15} className="spin" /> Confirmando…</> : <><ShieldCheck size={15} /> Confirmar e enviar ao Desenvolvedor</>}
          </button>
        )}
      </div>
    </>
  );
}

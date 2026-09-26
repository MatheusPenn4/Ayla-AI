"use client";

import { useState } from "react";
import { AlertTriangle, CheckCircle2, FileText, Loader2, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { useRuns } from "@/hooks/use-runs";
import { toTeamInput } from "@/lib/engine/client";
import { CONNECTION_STATE_LABEL, connectionLabel } from "@/lib/engine/connections";
import type { ArchitectSnapshot, ConsultedFile, RunDetail } from "@/lib/engine/types";
import type { Agent } from "@/lib/office/types";
import { RevisionInfo, useRunDetail } from "./run-dialog";

type RunsApi = ReturnType<typeof useRuns>;
const fmt = (n: number) => n.toLocaleString("pt-BR");

/**
 * Review of a prepared hand-off (status awaiting_approval). Everything shown
 * here comes from the executor's frozen record; confirming sends its hash, so
 * the Architect receives exactly this content.
 */
export function HandoffDialog({ runId, agents, runs, onClose, onApproved }: {
  runId: string | null;
  agents: Agent[];
  runs: RunsApi;
  onClose: () => void;
  onApproved: (runId: string) => void;
}) {
  return (
    <Dialog open={!!runId} onOpenChange={v => !v && onClose()}>
      <DialogContent className="game-dialog run-dialog handoff-dialog">
        {runId && <Review key={runId} runId={runId} agents={agents} runs={runs} onClose={onClose} onApproved={onApproved} />}
      </DialogContent>
    </Dialog>
  );
}

/** Same content as in the previous hand-off? Compared by Git blob id, content hash, or same commit + path. */
function compareFile(f: ConsultedFile, commit: string, prev: RunDetail | null): { label: string; cls: string } {
  const pc = prev?.context?.kind === "github" ? prev.context : null;
  if (!pc) return { label: "novo (sem envio anterior)", cls: "new" };
  const old = pc.files.find(x => x.path === f.path);
  if (!old) return { label: "novo neste envio", cls: "new" };
  if (old.blob && f.blob) return old.blob === f.blob ? { label: "reaproveitado: mesmo conteúdo do envio anterior (mesmo blob)", cls: "same" } : { label: "atualizado: conteúdo diferente do envio anterior", cls: "changed" };
  if (old.sha256 && f.sha256) return old.sha256 === f.sha256 ? { label: "reaproveitado: mesmo conteúdo do envio anterior", cls: "same" } : { label: "atualizado: conteúdo diferente do envio anterior", cls: "changed" };
  if (pc.commit === commit) return { label: "reaproveitado: mesmo arquivo e commit do envio anterior", cls: "same" };
  return { label: `enviado antes no commit ${pc.commit.slice(0, 12)}; relido no novo commit (o envio anterior não registrou hash para comparar)`, cls: "changed" };
}

function Review({ runId, agents, runs, onClose, onApproved }: { runId: string; agents: Agent[]; runs: RunsApi; onClose: () => void; onApproved: (runId: string) => void }) {
  const { run, error } = useRunDetail(runId);
  const prevId = run ? (run.snapshot as ArchitectSnapshot).revision?.previousRunId ?? null : null;
  const { run: prev } = useRunDetail(prevId);
  const [busy, setBusy] = useState<"" | "approve" | "discard" | "verify">("");
  const [msg, setMsg] = useState<string | null>(null);
  if (!run) return <div className="run-loading">{error ?? <><Loader2 size={16} className="spin" /> Carregando o envio preparado…</>}</div>;
  const snap = run.snapshot as ArchitectSnapshot;
  const ctx = run.context;
  const conn = runs.status?.connections[run.connection];
  const executorUp = !!runs.status?.executionEnabled;
  const current = agents.find(a => a.id === snap.agent.id);
  const cur = current ? toTeamInput(current, agents) : null;
  const sheetChanged = !!cur && (cur.brief !== snap.agent.brief || cur.connection !== snap.agent.connection || cur.modelName !== snap.agent.modelName || cur.effort !== snap.agent.effort);
  const name = (id: string) => agents.find(a => a.id === id)?.name ?? id;
  const files = ctx?.kind === "github" ? ctx.files : [];
  const notResent = snap.plan.directorFiles.filter(f => !files.some(x => x.path === f.path));
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
  const discard = async () => {
    setBusy("discard");
    await runs.cancel(run.id);
    setBusy("");
    onClose();
  };
  const verify = async () => { setBusy("verify"); await runs.verify(); setBusy(""); };

  return (
    <>
      <DialogHeader>
        <span className="eyebrow">REVISAR ANTES DE ENVIAR · TAREFA {snap.task.id} → ARQUITETO</span>
        <DialogTitle className="run-title">{snap.task.title}</DialogTitle>
        <DialogDescription>
          {pending ? "Nada foi executado. Confira abaixo exatamente o que o Arquiteto vai receber. Ele só começa depois que você confirmar." : `Este envio não está mais aguardando aprovação (estado atual: ${run.status}).`}
        </DialogDescription>
      </DialogHeader>
      <div className="dialog-scroll run-scroll">
        <section className="run-sec"><h4>1. Demanda original</h4>
          <p><b>{snap.demand.title}</b>{snap.demand.project ? ` · ${snap.demand.project}` : ""}</p>
          <p className="clamp">{snap.demand.description}</p>
          {!!snap.demand.acceptanceCriteria.length && <><small>Critérios de aceite da demanda:</small><ol>{snap.demand.acceptanceCriteria.map((c, i) => <li key={i}>{c}</li>)}</ol></>}
        </section>

        <section className="run-sec"><h4>2. O que o Diretor pediu nesta tarefa</h4>
          <dl className="kv"><dt>Escopo</dt><dd>{snap.task.scope}</dd><dt>Insumos</dt><dd>{snap.task.inputs || "—"}</dd><dt>Entregável</dt><dd>{snap.task.deliverable}</dd><dt>Critérios da tarefa</dt><dd><ul>{snap.task.acceptance_criteria.map((c, i) => <li key={i}>{c}</li>)}</ul></dd></dl>
          <small>Plano do Diretor <code>{snap.plan.directorRunId.slice(0, 8)}</code> via {connectionLabel(snap.plan.directorConnection)} · etapa {snap.plan.step ? `${snap.plan.step.id} · ${snap.plan.step.title}` : "—"}</small>
        </section>

        <section className="run-sec"><h4>3. Arquivos que o Diretor realmente consultou</h4>
          {snap.plan.directorFiles.length ? <><small>Commit <code>{snap.plan.directorCommit?.slice(0, 12)}</code></small><ul className="ctx-skip">{snap.plan.directorFiles.map(f => <li key={f.path}>{f.path} · {fmt(f.bytes)} B{f.truncated ? " (lido em parte)" : ""}</li>)}</ul></> : <p className="muted">O Diretor não leu arquivos do repositório nesta demanda.</p>}
        </section>

        {(snap.revision?.number ?? 1) > 1 && (
          <section className={`run-sec ${snap.revision?.changedCommit ? "rev-changed" : ""}`}><h4>Revisão {snap.revision?.number}: o que muda em relação ao envio anterior</h4>
            <RevisionInfo snap={snap} />
            {prev?.analysis && <small>Da análise anterior ({prev.id.slice(0, 8)}) vão só um resumo do entendimento e a recomendação provisória; a resposta completa não é reenviada.</small>}
          </section>
        )}

        <section className="run-sec"><h4>4. Contexto que será entregue ao Arquiteto</h4>
          <ul>
            <li>Demanda (título, descrição e critérios) e esta tarefa completa.</li>
            <li>Resumo do plano: objetivo, fluxo, etapa desta tarefa, riscos, suposições e o que o Diretor não verificou.</li>
            {snap.plan.dependsOn.map(d => <li key={d.id}>Análise anterior de {d.id} ({d.title}): resumo da recomendação.</li>)}
            {!!snap.plan.dependents.length && <li>Quem usa o resultado: {snap.plan.dependents.map(d => `${d.id} → ${name(d.assignee)}`).join(", ")} (só como referência; ninguém é acionado).</li>}
            <li>Não vão: as demais tarefas em detalhe e a resposta completa do Diretor.</li>
            {snap.answers?.length ? <li>Suas respostas às perguntas anteriores do Arquiteto ({snap.answers.length}).</li> : null}
          </ul>
          {ctx?.kind === "github" && (
            <>
              <small>
                {ctx.via === "local_git"
                  ? <>Commit exato: <code>{ctx.commit}</code>, lido da <b>cópia local autorizada</b> “{ctx.local?.dirName}” ({ctx.local?.published ? "publicado no GitHub" : "não publicado no GitHub"}; {ctx.local?.isDescendant ? `descende do commit ${ctx.local.descendantOf?.slice(0, 12)} do Diretor` : "relação com o commit do Diretor não confirmada"}).</>
                  : <>Commit exato: <code>{ctx.commit}</code> do repositório público {ctx.owner}/{ctx.repo}{snap.plan.directorCommit === ctx.commit ? " (o mesmo do Diretor)" : ""}.</>}
                {" "}Conteúdo enviado de {files.length} arquivo(s):
              </small>
              <table className="ctx-table"><thead><tr><th>Arquivo</th><th>Motivo</th><th>Enviado</th><th>Em relação ao envio anterior</th></tr></thead>
                <tbody>{files.map(f => { const c = compareFile(f, ctx.commit, prev); return <tr key={f.path}><td><FileText size={12} /> {f.path}</td><td>{f.reason}</td><td>{fmt(f.sentChars)} car.{f.excerpt ? ` (trecho: ${f.excerpt.ranges.map(([a, b]) => `l.${a}-${b}`).join(", ")} de ${f.excerpt.totalLines})` : f.truncated ? " (truncado)" : ""}</td><td><span className={`cmp-${c.cls}`}>{c.label}</span></td></tr>; })}</tbody>
              </table>
              {!!notResent.length && <small>Lidos pelo Diretor e não reenviados (só o caminho vai): {notResent.map(f => f.path).join(", ")}.</small>}
              {!!ctx.skipped.length && <small> Não lidos por limite: {ctx.skipped.map(s => s.path).join(", ")}.</small>}
            </>
          )}
          {ctx && ctx.kind !== "github" && <p>{ctx.kind === "folder" ? "Pasta local: somente metadados; nenhum arquivo será enviado." : ctx.note}</p>}
          <p className={`form-note ${overBudget ? "warn" : ""}`}>Texto enviado: cerca de {fmt(est)} tokens (estimativa do Setor IA; o cliente acrescenta instruções próprias). Orçamento da ficha do Arquiteto: {fmt(run.budget.sheetTokens)} tokens (referência/alerta).{overBudget ? " A estimativa já passa do orçamento: ao confirmar, você aceita esse alerta." : ""}</p>
          <details className="raw"><summary>Ver o texto exato que será enviado</summary>
            <h4 className="ctx-h">Instruções (protocolo do Arquiteto + ficha salva do Arquiteto)</h4><pre className="brief">{run.prompt?.system}</pre>
            <h4 className="ctx-h">Mensagem</h4><pre className="brief">{run.prompt?.user}</pre>
          </details>
        </section>

        <section className="run-sec"><h4>5. Conexão e modelo da ficha do Arquiteto</h4>
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
            {runs.status?.readOnly[run.connection] && <small>Somente leitura garantido por: {runs.status.readOnly[run.connection]!.how}</small>}
          </div>
        </section>

        <section className="run-sec"><h4>6. Ferramentas autorizadas nesta execução</h4>
          <ul className="tool-grants">{snap.tools.map(t => <li key={t.label} className={t.allowed ? "ok" : "no"}><b>{t.label}: {t.allowed ? "permitida" : "bloqueada"}</b><small>{t.how}</small></li>)}</ul>
        </section>

        {sheetChanged && <div className="run-error" role="alert"><AlertTriangle size={16} /><div><b>A ficha do Arquiteto mudou depois que este envio foi preparado.</b><small>Descarte e clique em “Enviar ao Arquiteto” de novo para usar a ficha atual.</small></div></div>}
        {msg && <p className="form-error" role="alert">{msg}</p>}
      </div>
      <div className="dialog-actions">
        {pending && <button className="btn-ghost danger" onClick={discard} disabled={!!busy}><Trash2 size={14} /> Descartar envio</button>}
        <button className="btn-secondary" onClick={onClose}>{pending ? "Decidir depois" : "Fechar"}</button>
        {pending && (
          <button className="btn-primary" onClick={approve} disabled={!canConfirm || !!busy} title={!canConfirm ? (sheetChanged ? "A ficha mudou: prepare de novo." : "A conexão do Arquiteto precisa estar ativa.") : undefined}>
            {busy === "approve" ? <><Loader2 size={15} className="spin" /> Confirmando…</> : <><ShieldCheck size={15} /> Confirmar e enviar ao Arquiteto</>}
          </button>
        )}
      </div>
    </>
  );
}

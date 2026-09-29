"use client";

import { useEffect, useState } from "react";
import { Download, Loader2, Lock, Plus, Send, Trash2, X } from "lucide-react";
import type { useRuns } from "@/hooks/use-runs";
import { EngineApiError, engineApi } from "@/lib/engine/client";
import { developerPreviewMarkdown, type DeveloperPreview } from "@/lib/engine/developer-preview";
import type { Agent } from "@/lib/office/types";
import { TaskStateBadge } from "./run-dialog";

type RunsApi = ReturnType<typeof useRuns>;
type EditAction = "alterar" | "criar" | "consultar";
type EditRow = { path: string; action: EditAction };
const ACTION_LABEL: Record<EditAction, string> = { alterar: "Alterar", criar: "Criar", consultar: "Consultar (só leitura)" };

/** The suggestion ("a confirmar" included) mapped onto a starting choice the user must still confirm. */
const rowsFromSuggestion = (editScope: DeveloperPreview["editScope"]): EditRow[] =>
  editScope.map(e => ({ path: e.path, action: e.action === "a confirmar" ? "alterar" : e.action }));

/**
 * Preview of a FUTURE hand-off to the Developer, plus (when eligible) the real "Enviar ao Desenvolvedor"
 * button. Building the preview itself is a view of the executor's records only: it creates no run, calls
 * no model and grants no write access. Preparing the actual hand-off freezes a review for your
 * confirmation — it does not build a working copy or call a model either (see docs/executor-local.md).
 */
export function DeveloperPreviewPanel({ planRunId, taskId, agents, runs, onOpenRun, onReview, onClose }: {
  planRunId: string; taskId: string; agents: Agent[]; runs: RunsApi; onOpenRun: (id: string) => void; onReview: (handoffRunId: string) => void; onClose: () => void;
}) {
  const [p, setP] = useState<DeveloperPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [rows, setRows] = useState<EditRow[] | null>(null);
  const [newPath, setNewPath] = useState("");
  const [newAction, setNewAction] = useState<EditAction>("alterar");
  const sending = runs.pending.has(`${planRunId}:${taskId}`);
  useEffect(() => {
    let live = true;
    engineApi.developerPreview(planRunId, taskId)
      .then(r => { if (live) { setP(r.preview); setRows(rowsFromSuggestion(r.preview.editScope)); } })
      .catch(e => live && setError(e instanceof EngineApiError ? e.message : "Não foi possível montar a prévia."));
    return () => { live = false; };
  }, [planRunId, taskId]);

  const addRow = () => {
    const path = newPath.trim();
    if (!path) return;
    if (rows?.some(r => r.path === path)) { setSendError(`"${path}" já está na lista.`); return; }
    setRows(rs => [...(rs ?? []), { path, action: newAction }]);
    setNewPath("");
    setSendError(null);
  };
  const removeRow = (path: string) => setRows(rs => (rs ?? []).filter(r => r.path !== path));
  const setRowAction = (path: string, action: EditAction) => setRows(rs => (rs ?? []).map(r => (r.path === path ? { ...r, action } : r)));

  // Local copy of the preview; the generic download helper is left for the Developer's own task (task-4).
  const download = () => {
    if (!p) return;
    const url = URL.createObjectURL(new Blob([developerPreviewMarkdown(p)], { type: "text/markdown;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url; a.download = `previa-desenvolvedor-${p.task.id}-${p.plan.runId.slice(0, 8)}.md`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const editable = (rows ?? []).filter(r => r.action !== "consultar");
  const canSend = p?.eligible && !!rows?.length && editable.length > 0;
  const send = async () => {
    setSendError(null);
    if (!rows?.length) { setSendError("Escolha ao menos um caminho antes de enviar."); return; }
    if (!editable.length) { setSendError("Marque ao menos um caminho para alterar ou criar — só consultar não dá ao Desenvolvedor nada para produzir."); return; }
    const r = await runs.prepareDeveloperHandoff(planRunId, taskId, agents, rows.map(row => ({ path: row.path, action: row.action })));
    if (r.ok) onReview(r.run.id); else setSendError(r.error);
  };

  if (error) return <div className="dev-preview"><p className="form-error">{error}</p><button className="btn-ghost small" onClick={onClose}>Fechar</button></div>;
  if (!p) return <div className="dev-preview"><Loader2 size={14} className="spin" /> Montando a prévia a partir dos registros (nada é executado)…</div>;
  return (
    <div className="dev-preview" aria-label={`Prévia do envio de ${p.task.id} ao Desenvolvedor`}>
      <div className="send-head"><b>Prévia do envio ao Desenvolvedor · {p.task.id}</b><button className="icon-btn" onClick={onClose} aria-label="Fechar prévia"><X size={14} /></button></div>
      <div className="notice lock"><Lock size={14} /><div>{p.notice.map((n, i) => <p key={i}>{n}</p>)}</div></div>
      <p><b>Apta para revisão:</b> {p.eligible ? "sim — todas as dependências têm análise concluída do Arquiteto." : `não — ${p.blockers.join("; ")}.`}</p>

      <section className="run-sec"><h4>Tarefas relevantes (estado real no executor)</h4>
        <table className="ctx-table"><thead><tr><th>Tarefa</th><th>Responsável</th><th>Relação</th><th>Estado</th></tr></thead>
          <tbody>{p.tasks.map(t => <tr key={t.id}><td>{t.id} · {t.title}</td><td>{t.assigneeName}</td><td>{t.relation}</td><td><TaskStateBadge state={t.state} />{t.runId && <button className="link" onClick={() => onOpenRun(t.runId!)}> {t.runId.slice(0, 8)}</button>}</td></tr>)}</tbody>
        </table>
      </section>

      <section className="run-sec"><h4>Análises registradas dos Arquitetos ({p.analyses.length})</h4>
        {p.analyses.map(a => (
          <div key={a.runId} className="question">
            <b>{a.taskId} · {a.title}</b>
            <small>Execução <button className="link" onClick={() => onOpenRun(a.runId)}>{a.runId.slice(0, 8)}</button>{a.revision ? `, revisão ${a.revision}` : ""}, commit <code>{a.commit?.slice(0, 12) ?? "—"}</code>{a.via === "local_git" ? " (cópia local)" : ""} · insumo, não fato verificado</small>
            <p>{a.recommendation.summary}</p>
            {!!a.guidance.length && <ol>{a.guidance.map((g, i) => <li key={i}>{g}</li>)}</ol>}
            {!!a.decisions.length && <ul>{a.decisions.map((d, i) => <li key={i}><span className="tag">decisão sua</span> <b>{d.topic}:</b> {d.answer}</li>)}</ul>}
          </div>
        ))}
      </section>

      <section className="run-sec"><h4>Commit de base proposto</h4>
        {p.base.proposed ? <p><code>{p.base.proposed.commit}</code>{p.base.proposed.via === "local_git" ? " (cópia local, não publicado)" : ""} — {p.base.proposed.why}</p> : <p className="muted">Nenhum.</p>}
        {p.base.head && <small>HEAD da cópia local: <code>{p.base.head.commit.slice(0, 12)}</code> ({p.base.head.subject}){p.base.head.descendsFromProposed === true ? ", descende do proposto" : p.base.head.descendsFromProposed === false ? ", NÃO descende do proposto" : ""}.</small>}
        <ul>{p.base.sinceAnalyses.map(s => <li key={s.taskId}>Desde a análise de {s.taskId} (<code>{s.commit.slice(0, 12)}</code>, {s.relation}): {s.changedTotal ?? "?"} arquivo(s) alterado(s){s.examinedChanged.length ? `; examinados e alterados: ${s.examinedChanged.join(", ")}` : "; nenhum arquivo examinado mudou"}.</li>)}</ul>
        <small>{p.base.note}</small>
      </section>

      <section className="run-sec"><h4>Pontos ainda não verificados ({p.unverified.length})</h4>
        {p.unverified.length ? <ul>{p.unverified.map((u, i) => <li key={i}><span className="tag">{u.source}</span> {u.text}</li>)}</ul> : <p className="muted">Nenhum registrado.</p>}
      </section>

      <section className="run-sec"><h4>Escopo de edição previsto (sugestão do Arquiteto/tarefa — nunca é permissão)</h4>
        {p.editScope.length ? <table className="ctx-table"><thead><tr><th>Arquivo</th><th>Previsão</th><th>Citado em</th></tr></thead><tbody>{p.editScope.map(e => <tr key={e.path}><td>{e.path}</td><td>{e.action}</td><td>{e.from.join(", ")}</td></tr>)}</tbody></table> : <p className="muted">Nenhum arquivo citado.</p>}
        <small>Fora do escopo desta tarefa:</small><ul>{p.outOfScope.map((o, i) => <li key={i}>{o}</li>)}</ul>
      </section>

      <section className="run-sec"><h4>Sua escolha — isto é a permissão real do Desenvolvedor</h4>
        <p className="pane-intro">Marque explicitamente o que o Desenvolvedor pode alterar, criar ou só consultar nesta cópia isolada. A sugestão acima só preenche o ponto de partida; nada aqui vem automaticamente dela. Ao confirmar, cada caminho é conferido contra o commit de base real{p.base.proposed ? <> (<code>{p.base.proposed.commit.slice(0, 12)}</code>{p.base.proposed.via === "local_git" ? ", cópia local" : ""})</> : ""} — &ldquo;alterar&rdquo;/&ldquo;consultar&rdquo; precisam existir lá; &ldquo;criar&rdquo; não precisa.</p>
        {rows && (
          <table className="ctx-table">
            <thead><tr><th>Arquivo</th><th>Ação</th><th /></tr></thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.path}>
                  <td><code>{r.path}</code></td>
                  <td>
                    <select value={r.action} onChange={e => setRowAction(r.path, e.target.value as EditAction)} aria-label={`Ação para ${r.path}`}>
                      {(Object.keys(ACTION_LABEL) as EditAction[]).map(a => <option key={a} value={a}>{ACTION_LABEL[a]}</option>)}
                    </select>
                  </td>
                  <td><button type="button" className="icon-btn danger" onClick={() => removeRow(r.path)} aria-label={`Remover ${r.path}`}><Trash2 size={13} /></button></td>
                </tr>
              ))}
              {!rows.length && <tr><td colSpan={3} className="muted">Nenhum caminho selecionado.</td></tr>}
            </tbody>
          </table>
        )}
        <div className="form-row">
          <input value={newPath} onChange={e => setNewPath(e.target.value)} onKeyDown={e => e.key === "Enter" && (e.preventDefault(), addRow())} placeholder="caminho/do/arquivo.ts" aria-label="Novo caminho" />
          <select value={newAction} onChange={e => setNewAction(e.target.value as EditAction)} aria-label="Ação do novo caminho">
            {(Object.keys(ACTION_LABEL) as EditAction[]).map(a => <option key={a} value={a}>{ACTION_LABEL[a]}</option>)}
          </select>
          <button type="button" className="btn-secondary small" onClick={addRow} disabled={!newPath.trim()}><Plus size={13} /> Adicionar caminho</button>
        </div>
        {p.eligible && (
          <div className="task-actions">
            <button className="btn-primary small" disabled={!canSend || sending || !runs.status?.executionEnabled} onClick={() => void send()}>
              {sending ? <><Loader2 size={13} className="spin" /> Preparando…</> : <><Send size={13} /> Enviar ao Desenvolvedor</>}
            </button>
            <span className="run-hint">Só congela a revisão para você confirmar depois; a cópia de trabalho é montada apenas se você aprovar.</span>
          </div>
        )}
        {sendError && <p className="form-error" role="alert">{sendError}</p>}
      </section>

      <section className="run-sec limits"><h4>O que já está implementado e o que ainda falta</h4><ul>{p.future.map((f, i) => <li key={i}>{f}</li>)}</ul></section>
      <div className="task-actions"><button className="btn-secondary small" onClick={download}><Download size={13} /> Baixar prévia (.md)</button><span className="run-hint">Cópia desta visualização, gerada dos mesmos dados.</span></div>
    </div>
  );
}

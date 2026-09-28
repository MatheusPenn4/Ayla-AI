"use client";

import { useEffect, useState } from "react";
import { Loader2, Send, X } from "lucide-react";
import { EngineApiError, engineApi, type HandoffFollowUp, type SourceOptions } from "@/lib/engine/client";
import { RUN_STATUS_LABEL, type RunStatus, type SourceComparison } from "@/lib/engine/types";

const HEX40 = /^[0-9a-f]{40}$/;
const REF = /^[A-Za-z0-9_.@[\]/-]+(#[A-Za-z0-9_$]+)?$/;

/** Suggestions checked by default, in order, while they fit the reading limits (10 files, 12 references). */
function defaultPick(refs: string[]) {
  const files = new Set<string>(), out: Record<string, boolean> = {};
  for (const r of refs) {
    const p = r.split("#")[0];
    if (Object.keys(out).length >= 12 || (!files.has(p) && files.size >= 10)) break;
    files.add(p); out[r] = true;
  }
  return out;
}

/** File-by-file table of a comparison between two commits (read from the authorized local clone). */
export function ComparisonTable({ c }: { c: SourceComparison }) {
  const yes = (b: boolean) => (b ? "sim" : "não");
  return (
    <>
      <small>
        {c.from.label} <code>{c.from.commit.slice(0, 12)}</code> → {c.to.label} <code>{c.to.commit.slice(0, 12)}</code>:{" "}
        {c.relation === "same" ? "mesmo commit" : c.relation === "descendant" ? "descende (mesma história)" : c.relation === "not_descendant" ? "NÃO descende" : "relação desconhecida"}
        {c.changedTotal != null ? ` · ${c.changedTotal} arquivo(s) do repositório mudaram entre eles` : ""}
      </small>
      {!!c.files.length && (
        <table className="ctx-table"><thead><tr><th>Arquivo</th><th>Existe em {c.from.commit.slice(0, 7)}</th><th>Existe em {c.to.commit.slice(0, 7)}</th><th>Mudou</th></tr></thead>
          <tbody>{c.files.map(f => <tr key={f.path} className={!f.atFrom && f.atTo ? "cmp-row-new" : ""}><td>{f.path}</td><td>{yes(f.atFrom)}</td><td>{yes(f.atTo)}</td><td>{f.changed == null ? "?" : yes(f.changed)}</td></tr>)}</tbody>
        </table>
      )}
    </>
  );
}

/**
 * Before “Enviar ao Arquiteto”: the user chooses the source/commit and confirms the files to read.
 * Loading the options and submitting only ask the executor to read records and prepare an envio for
 * review; no model is called here.
 */
export function SendForm({ planRunId, taskId, sending, disabled, onSubmit, onClose }: {
  planRunId: string; taskId: string; sending: boolean; disabled: boolean;
  onSubmit: (f: HandoffFollowUp) => void; onClose: () => void;
}) {
  const [opts, setOpts] = useState<SourceOptions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<string>("");
  const [other, setOther] = useState("");
  const [otherVia, setOtherVia] = useState<"github" | "local_git">("local_git");
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [extra, setExtra] = useState("");
  const [reason, setReason] = useState("");

  useEffect(() => {
    let live = true;
    engineApi.sourceOptions(planRunId, taskId)
      .then(o => {
        if (!live) return;
        setOpts(o);
        // A retry starts from the previous envio of the task (same commit and files); otherwise from the proposal.
        const prev = o.previous?.commit && o.previous.files.length ? o.previous : null;
        if (prev) {
          setPicked(Object.fromEntries(prev.files.filter(r => o.suggestedFiles.some(f => f.ref === r)).map(r => [r, true])));
          setExtra(prev.files.filter(r => !o.suggestedFiles.some(f => f.ref === r)).join(", "));
          setSource(`${prev.via ?? "github"}:${prev.commit}`);
        } else {
          setPicked(defaultPick(o.suggestedFiles.map(f => f.ref)));
          setSource(o.proposed ? `${o.proposed.via}:${o.proposed.commit}` : "");
        }
      })
      .catch(e => live && setError(e instanceof EngineApiError ? e.message : "Não foi possível carregar as opções de fonte."));
    return () => { live = false; };
  }, [planRunId, taskId]);

  if (error) return <div className="send-form"><p className="form-error">{error}</p><button className="btn-ghost small" onClick={onClose}>Fechar</button></div>;
  if (!opts) return <div className="send-form"><Loader2 size={14} className="spin" /> Lendo os registros e a cópia local (nada é executado)…</div>;

  const choices: { key: string; via: "github" | "local_git"; commit: string; label: string }[] = [];
  const add = (via: "github" | "local_git", commit: string, label: string) => { const key = `${via}:${commit}`; const have = choices.find(c => c.key === key); if (have) have.label += ` · ${label}`; else choices.push({ key, via, commit, label }); };
  if (opts.directorCommit) add("github", opts.directorCommit, "commit que o Diretor leu (GitHub público)");
  for (const d of opts.dependencies) if (d.commit) add(d.via ?? "github", d.commit, `commit da análise de ${d.taskId} (${d.runId.slice(0, 8)}${d.revision ? `, revisão ${d.revision}` : ""})${d.via === "local_git" ? ", cópia local" : ""}`);
  for (const r of opts.localRepos) add("local_git", r.head, `HEAD da cópia local “${r.dirName}”: ${r.headSubject}`);
  const chosen = source === "other" ? (HEX40.test(other) ? { via: otherVia, commit: other } : null) : choices.find(c => c.key === source) ?? null;
  const changed = !!chosen && !!opts.directorCommit && (chosen.commit !== opts.directorCommit || chosen.via !== "github");
  const extraRefs = extra.split(/[\s,;]+/).map(x => x.trim()).filter(Boolean);
  const files = [...new Set([...opts.suggestedFiles.filter(f => picked[f.ref]).map(f => f.ref), ...extraRefs])];
  const problems: string[] = [];
  if (opts.directorCommit && !chosen) problems.push("Escolha a fonte e o commit (hash completo de 40 caracteres).");
  if (changed && !reason.trim()) problems.push("Explique por que o envio não usa o commit do Diretor (fica registrado na revisão).");
  const bad = extraRefs.filter(r => !REF.test(r) || r.includes(".."));
  if (bad.length) problems.push(`Referência inválida: ${bad.join(", ")} (use caminho ou caminho#Símbolo).`);
  if (files.length > 12) problems.push(`No máximo 12 referências (há ${files.length}).`);
  const comparisons = chosen ? opts.comparisons.filter(c => c.to.commit === chosen.commit) : [];

  return (
    <div className="send-form clarify">
      <div className="send-head"><b>Preparar o envio de {taskId} ao Arquiteto</b><button className="icon-btn" onClick={onClose} aria-label="Fechar"><X size={14} /></button></div>
      <p className="pane-intro">Escolha o commit e confirme os arquivos. Preparar <b>não chama o modelo</b>: o executor lê os arquivos e congela o envio para você revisar e confirmar.</p>
      <div className="question">
        <b>Fonte e commit</b>
        {opts.previous && <small>Envio anterior desta tarefa: <code>{opts.previous.runId.slice(0, 8)}</code>{opts.previous.revision ? ` (revisão ${opts.previous.revision})` : ""}, {RUN_STATUS_LABEL[opts.previous.status as RunStatus] ?? opts.previous.status}, commit <code>{opts.previous.commit?.slice(0, 12) ?? "—"}</code>. Ele não é alterado; este será um novo envio{opts.previous.files.length ? ", começando do mesmo commit e dos mesmos arquivos" : ""}.</small>}
        {opts.proposed && <small>Proposto: <code>{opts.proposed.commit.slice(0, 12)}</code> — {opts.proposed.why}</small>}
        {choices.map(c => <label key={c.key} className="radio"><input type="radio" checked={source === c.key} onChange={() => setSource(c.key)} /> <code>{c.commit.slice(0, 12)}</code> {c.label}</label>)}
        <label className="radio"><input type="radio" checked={source === "other"} onChange={() => setSource("other")} /> Outro commit</label>
        {source === "other" && (
          <div className="decision-row">
            <select value={otherVia} onChange={e => setOtherVia(e.target.value as "github" | "local_git")} aria-label="Fonte do commit"><option value="local_git" disabled={!opts.localRepos.length}>Cópia local autorizada</option><option value="github">GitHub público</option></select>
            <input value={other} onChange={e => setOther(e.target.value.trim().toLowerCase())} placeholder="hash completo (40 caracteres)" aria-label="Commit" />
          </div>
        )}
        {comparisons.map((c, i) => <ComparisonTable key={i} c={c} />)}
        {chosen && !comparisons.length && changed && <small>Comparação arquivo a arquivo: aparece na revisão, depois de preparar.</small>}
        {changed && <textarea rows={2} value={reason} onChange={e => setReason(e.target.value)} placeholder="Motivo (ex.: o código que a tarefa usa só existe em commits locais não publicados)" aria-label="Motivo da escolha do commit" />}
      </div>
      <div className="question">
        <b>Arquivos a ler ({files.length})</b>
        <small>Sugeridos a partir das análises das quais esta tarefa depende. Um arquivo grande vai como trecho verificável (lista de declarações + blocos dos símbolos pedidos). Sem nenhum arquivo, o executor escolhe pelo nome, como antes.</small>
        {opts.suggestedFiles.map(f => <label key={f.ref} className="radio"><input type="checkbox" aria-label={f.ref} checked={!!picked[f.ref]} onChange={e => setPicked(s => ({ ...s, [f.ref]: e.target.checked }))} /> <code>{f.ref}</code> <span className="muted">{f.reason}</span></label>)}
        <input value={extra} onChange={e => setExtra(e.target.value)} placeholder="outros arquivos: caminho ou caminho#Símbolo, separados por vírgula" aria-label="Outros arquivos" />
      </div>
      {!!problems.length && <ul className="form-problems">{problems.map((p, i) => <li key={i}>{p}</li>)}</ul>}
      <button className="btn-primary" disabled={!!problems.length || disabled || sending} onClick={() => onSubmit({ ...(chosen ? { source: { via: chosen.via, commit: chosen.commit } } : {}), ...(changed ? { revisionReason: reason.trim() } : {}), ...(files.length ? { files } : {}) })}>
        {sending ? <><Loader2 size={14} className="spin" /> Preparando…</> : <><Send size={14} /> Preparar envio para revisar</>}
      </button>
    </div>
  );
}

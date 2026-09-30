"use client";

// "Revisar alterações → Aplicar ao projeto local" for one finished Developer run, then "Verificar entrega
// aplicada". Everything shown comes from the executor: the persisted diff and its integrity, the scope checks,
// the target's real state (HEAD, local changes, conflicts from a dry run). The browser sends only ids and the
// review token; a confirmation made against a changed target is refused by the executor and the difference shown.
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, ExternalLink, FolderGit2, Loader2, RefreshCw, ShieldAlert, ShieldCheck, Square, XCircle } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { useRuns } from "@/hooks/use-runs";
import { EngineApiError, artifactUrl, engineApi } from "@/lib/engine/client";
import type { ApplicationRecord, ApplyReview } from "@/lib/engine/types";
import { versionText } from "./qa-tooling";

type RunsApi = ReturnType<typeof useRuns>;
const ACTION: Record<string, string> = { added: "criar", modified: "alterar", deleted: "remover" };
const OUTCOME: Record<ApplicationRecord["outcome"], string> = { applied: "aplicado localmente (sem commit)", already_present: "já estava no projeto (nada escrito)", failed_restored: "falhou — arquivos restaurados", failed_unrestored: "falhou — restauração incompleta" };

export function ApplyDialog({ open, planRunId, devRunId, taskLabel, runs, onClose }: { open: boolean; planRunId: string; devRunId: string; taskLabel: string; runs: RunsApi; onClose: () => void }) {
  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent className="game-dialog run-dialog handoff-dialog">
        {open && <Body planRunId={planRunId} devRunId={devRunId} taskLabel={taskLabel} runs={runs} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

function Body({ planRunId, devRunId, taskLabel, runs, onClose }: { planRunId: string; devRunId: string; taskLabel: string; runs: RunsApi; onClose: () => void }) {
  const projects = runs.status?.projects ?? [];
  const [projectId, setProjectId] = useState(() => projects.find(p => !p.problem)?.id ?? "");
  const [review, setReview] = useState<ApplyReview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [changes, setChanges] = useState<string[] | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState<"" | "apply" | "verify" | "cancel">("");
  const [result, setResult] = useState<ApplicationRecord | null>(null);
  const key = useRef(`apply:${crypto.randomUUID()}`);
  const apps = runs.applicationsFor(planRunId, [devRunId]);
  const latest = result ? apps.find(a => a.id === result.id) ?? result : apps[0] ?? null;

  const load = useCallback(async (pid: string) => {
    if (!pid) return;
    setLoading(true); setError(null); setConfirmed(false);
    try { setReview((await engineApi.applyReview(devRunId, pid)).review); key.current = `apply:${crypto.randomUUID()}`; }
    catch (e) { setReview(null); setError(e instanceof EngineApiError ? e.message : "Não foi possível revisar."); }
    finally { setLoading(false); }
  }, [devRunId]);
  useEffect(() => {
    const t = setTimeout(() => { void load(projectId); void runs.loadApplications(planRunId); }, 0);
    return () => clearTimeout(t);
  }, [projectId, load, planRunId, runs]);

  // While a verification runs, follow it (the executor records every step as it goes).
  const verifying = latest?.verification?.status === "running";
  useEffect(() => {
    if (!verifying) return;
    const t = setInterval(() => { void runs.loadApplications(planRunId).then(list => { if (list?.find(a => a.id === latest?.id)?.verification?.status !== "running") void runs.loadCompletions(planRunId); }); }, 2000);
    return () => clearInterval(t);
  }, [verifying, planRunId, runs, latest?.id]);

  const apply = async () => {
    if (!review || busy) return;
    setBusy("apply"); setError(null); setChanges(null);
    try {
      const r = await engineApi.applyDiff({ runId: devRunId, projectId, reviewToken: review.token, idempotencyKey: key.current });
      setResult(r.application);
      await runs.loadApplications(planRunId);
      await load(projectId);
    } catch (e) {
      // The executor answers { changes, review } in details for this refusal (see lib/executor/apply.ts).
      if (e instanceof EngineApiError && e.code === "target_changed") setChanges((e.details as unknown as { changes?: string[] } | undefined)?.changes ?? ["O projeto mudou depois da revisão."]);
      setError(e instanceof EngineApiError ? e.message : "A aplicação falhou.");
    } finally { setBusy(""); }
  };
  const verify = async (id: string) => {
    setBusy("verify");
    try { await engineApi.verifyApplication(id); await runs.loadApplications(planRunId); } catch (e) { setError(e instanceof EngineApiError ? e.message : "Não foi possível iniciar a verificação."); }
    finally { setBusy(""); }
  };
  const cancel = async (id: string) => { setBusy("cancel"); try { await engineApi.cancelVerification(id); await runs.loadApplications(planRunId); } finally { setBusy(""); } };

  const p = review?.project;
  const canApply = !!review && !review.blockers.length && confirmed && !busy && !!runs.status?.executionEnabled;

  return (
    <>
      <DialogHeader>
        <span className="eyebrow">REVISAR ALTERAÇÕES · {taskLabel} · EXECUÇÃO {devRunId.slice(0, 8).toUpperCase()}</span>
        <DialogTitle className="run-title">Aplicar ao projeto local</DialogTitle>
        <DialogDescription>Revise o diff que o Desenvolvedor produziu e o estado real do projeto de destino. Nada foi escrito ainda.</DialogDescription>
      </DialogHeader>
      <div className="dialog-scroll run-scroll">
        <section className="run-sec"><h4>1. Projeto local de destino</h4>
          {!projects.length && <p className="muted">Nenhum projeto autorizado. Cadastre a pasta em Configurações → Conexões de IA → Projetos locais.</p>}
          {!!projects.length && (
            <select value={projectId} onChange={e => setProjectId(e.target.value)} aria-label="Projeto de destino">
              {projects.map(x => <option key={x.id} value={x.id} disabled={!!x.problem}>{x.label} — {x.dir}{x.problem ? ` (${x.problem})` : ""}</option>)}
            </select>
          )}
          {p && <p className="form-note"><FolderGit2 size={13} /> <code>{p.dir}</code> · {p.owner}/{p.repo} · branch {review!.target.branch ?? "—"} · HEAD <code>{review!.target.head.slice(0, 12)}</code> · {review!.target.dirtyTotal ? `${review!.target.dirtyTotal} alteração(ões) local(is) no projeto` : "sem alterações locais"}</p>}
        </section>

        {loading && <p className="muted"><Loader2 size={14} className="spin" /> Conferindo o diff e o projeto…</p>}
        {review && (
          <>
            <section className="run-sec"><h4>2. Execução, plano, tarefa e commit de base</h4>
              <dl className="kv"><dt>Execução</dt><dd><code>{review.run.id}</code></dd><dt>Plano</dt><dd><code>{review.run.planId}</code></dd><dt>Tarefa</dt><dd>{review.run.taskId} · {review.run.taskTitle}</dd><dt>Commit de base</dt><dd><code>{review.run.baseCommit}</code></dd></dl>
            </section>

            <section className="run-sec"><h4>3. Validações do diff e do escopo</h4>
              <ul className="tool-grants">{review.checks.map(c => <li key={c.label} className={c.ok ? "ok" : "no"}><b>{c.ok ? <CheckCircle2 size={12} /> : <XCircle size={12} />} {c.label}</b><small>{c.detail}</small></li>)}</ul>
            </section>

            <section className="run-sec"><h4>4. Arquivos, ações e estado atual no destino</h4>
              <table className="ctx-table"><thead><tr><th>Arquivo</th><th>Ação</th><th>No projeto agora</th></tr></thead>
                <tbody>{review.diff.files.map(f => { const a = review.target.affected.find(x => x.path === f.path); return (
                  <tr key={f.path}><td><code>{f.path}</code></td><td>{ACTION[f.status]} (+{f.additions ?? "?"} −{f.deletions ?? "?"})</td><td>{a ? `${a.exists ? "existe" : "não existe"}${a.localChange ? ` · alteração local não commitada (${a.localChange})` : ""}` : "—"}</td></tr>
                ); })}</tbody>
              </table>
              {!!review.target.dirtyOutside.length && <><small>Outras alterações locais no projeto (preservadas; o diff não as toca):</small><ul className="ctx-skip">{review.target.dirtyOutside.map(x => <li key={x}>{x}</li>)}</ul></>}
            </section>

            <section className="run-sec"><h4>5. Verificação de aplicação (sem alterar arquivos)</h4>
              {review.applyCheck.state === "applies" && <p className="form-note ok"><CheckCircle2 size={13} /> O diff se aplica ao estado atual do projeto (git apply --check).</p>}
              {review.applyCheck.state === "already_present" && <p className="form-note"><CheckCircle2 size={13} /> As alterações deste diff já estão no projeto. Confirmar apenas registra isso; nenhum arquivo é escrito de novo.</p>}
              {review.applyCheck.state === "conflict" && <div className="run-error" role="alert"><AlertTriangle size={16} /><div><b>Conflito: a aplicação é recusada e nada é alterado.</b><ul>{review.applyCheck.conflicts.map(c => <li key={c.path}><code>{c.path}</code> — {c.reason}</li>)}</ul><small>Suas alterações locais são preservadas. Resolva-as você mesmo (ou prepare um novo envio ao Desenvolvedor sobre o commit atual) e revise de novo.</small></div></div>}
              {review.applyCheck.state === "error" && <p className="muted">{review.applyCheck.output}</p>}
            </section>

            <section className="run-sec"><h4>6. Diff persistido completo</h4>
              <p className="muted">SHA-256 <code>{review.diff.sha256}</code>{review.diff.recordedSha256 ? ` · registrado na execução: ${review.diff.recordedSha256 === review.diff.sha256 ? "confere" : "DIFERENTE"}` : " · execução anterior ao registro de hash"}.</p>
              <details className="raw"><summary>Ver o diff ({review.diff.text.length.toLocaleString("pt-BR")} caracteres)</summary><pre className="brief">{review.diff.text}</pre></details>
            </section>

            {!!review.blockers.length && <div className="run-error" role="alert"><ShieldAlert size={16} /><div><b>A aplicação está bloqueada.</b><ul>{review.blockers.map((b, i) => <li key={i}>{b}</li>)}</ul></div></div>}
            {changes && <div className="run-error" role="alert"><AlertTriangle size={16} /><div><b>O projeto mudou depois da revisão; a confirmação foi invalidada.</b><ul>{changes.map((c, i) => <li key={i}>{c}</li>)}</ul><button className="btn-secondary small" onClick={() => void load(projectId)}><RefreshCw size={13} /> Revisar de novo</button></div></div>}

            {!review.blockers.length && (
              <div className="notice warn-box">
                <label className="check-row"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} /> <span><b>Entendo que confirmar altera arquivos locais</b> em <code>{p?.dir}</code> ({review.diff.files.length} arquivo(s)). Nada é commitado, enviado ou publicado; se algo falhar, os arquivos afetados voltam ao estado anterior.</span></label>
              </div>
            )}
          </>
        )}
        {error && !changes && <p className="form-error" role="alert">{error}</p>}

        {latest && <ApplicationCard app={latest} busy={busy} onVerify={verify} onCancel={cancel} />}
        {apps.length > 1 && <details className="raw"><summary>Aplicações anteriores desta execução ({apps.length})</summary><ul>{apps.map(a => <li key={a.id}>{new Date(a.createdAt).toLocaleString("pt-BR")} · {OUTCOME[a.outcome]} · {a.verification ? `verificação: ${a.verification.status}` : "não verificada"}</li>)}</ul></details>}
      </div>
      <div className="dialog-actions">
        <button className="btn-secondary" onClick={onClose}>Fechar</button>
        {review && !review.blockers.length && (
          <button className="btn-primary" disabled={!canApply} onClick={() => void apply()}>
            {busy === "apply" ? <><Loader2 size={15} className="spin" /> Aplicando…</> : <><ShieldCheck size={15} /> {review.applyCheck.state === "already_present" ? "Registrar que já está aplicado" : "Aplicar ao projeto local"}</>}
          </button>
        )}
      </div>
    </>
  );
}

function ApplicationCard({ app, busy, onVerify, onCancel }: { app: ApplicationRecord; busy: string; onVerify: (id: string) => void; onCancel: (id: string) => void }) {
  const v = app.verification;
  const ok = app.outcome === "applied" || app.outcome === "already_present";
  return (
    <section className="run-sec"><h4>Resultado</h4>
      <div className={`conn-card ${ok ? "ok" : "bad"}`}>
        <div className="conn-head">{ok ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}<b>Aplicação: {OUTCOME[app.outcome]}</b><span className="muted">{new Date(app.createdAt).toLocaleString("pt-BR")}</span></div>
        <p className="conn-msg">{app.message}</p>
        <p className="conn-msg">HEAD do projeto: <code>{app.head.slice(0, 12)}</code> · diff <code>{app.diffSha256.slice(0, 12)}</code> · {app.files.map(f => `${f.path} → ${f.afterSha256?.slice(0, 10) ?? "removido"}`).join(", ")}</p>
      </div>
      {ok && (
        <div className={`conn-card ${v?.status === "passed" ? "ok" : v?.status === "failed" || v?.status === "error" ? "bad" : ""}`}>
          <div className="conn-head">
            {v?.status === "running" ? <Loader2 size={16} className="spin" /> : v?.status === "passed" ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
            <b>Verificação: {!v ? "pendente — aplicado não é o mesmo que verificado" : v.status === "running" ? "em andamento" : v.status === "passed" ? "concluída, todas passaram — entrega validada" : v.status === "canceled" ? "cancelada" : v.status === "failed" ? "falhou — entrega NÃO validada" : "não concluída"}</b>
            <span className="grow" />
            {(!v || (v.status !== "running" && v.status !== "passed")) && <button className="btn-secondary small" disabled={!!busy} onClick={() => onVerify(app.id)}>{busy === "verify" ? <Loader2 size={13} className="spin" /> : <ShieldCheck size={13} />} Verificar entrega aplicada</button>}
            {v?.status === "running" && <button className="btn-ghost small" disabled={!!busy} onClick={() => onCancel(app.id)}><Square size={12} /> Cancelar</button>}
          </div>
          <p className="conn-msg">{v ? v.message : "Roda as verificações do próprio projeto (tipos, lint, testes, build) numa cópia isolada desta versão exata — nunca no seu checkout. Só quando todas passam a entrega é registrada como validada."}</p>
          {v?.version && <p className="conn-msg">Versão verificada: {versionText(v.version)}</p>}
          {!!v?.checks.length && (
            <table className="ctx-table"><thead><tr><th>Verificação</th><th>Comando</th><th>Saída</th><th>Duração</th><th>Log</th></tr></thead>
              <tbody>{v.checks.map((c, i) => <tr key={i}><td>{c.label}</td><td><code>{c.command}</code></td><td>{c.exitCode === 0 ? "0 ✓" : c.canceled ? "cancelado" : c.timedOut ? "tempo esgotado" : String(c.exitCode)}</td><td>{Math.round(c.durationMs / 100) / 10} s</td><td>{c.logArtifact && <a href={artifactUrl(app.id, c.logArtifact)} target="_blank" rel="noreferrer">abrir <ExternalLink size={11} /></a>}</td></tr>)}</tbody>
            </table>
          )}
        </div>
      )}
    </section>
  );
}

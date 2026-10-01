"use client";

// "Projeto local autorizado" as the source of a demand:
// - LocalSourcePicker (in the demand form): pick a registered project, a branch/tag/commit, and SEE the full SHA it
//   resolves to — plus what stays out (uncommitted changes) — before the demand is saved;
// - LocalContextReview (before planning and in the run): the files and excerpts the Director receives, the hash of
//   the exact text, what was withheld. A file that was not sent is never listed as read.
// The browser only ever names the project by the id the executor gave it; the executor resolves and reads.
import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, FileText, FolderGit2, GitCommit, Loader2, RefreshCw } from "lucide-react";
import { EngineApiError, engineApi } from "@/lib/engine/client";
import type { LocalProject, ProjectRefs, ResolvedSource, SourceContext } from "@/lib/engine/types";
import type { Demand, LocalSource } from "@/lib/office/types";

const HEAD = "__head__";
const CUSTOM = "__custom__";
const fmt = (n: number) => n.toLocaleString("pt-BR");
// "Rota inexistente" from the executor means the process on the port is older than this interface (started before the
// route existed): say so, with the fix, instead of an opaque error.
const STALE_EXECUTOR = "O executor em execução é de uma versão anterior a esta interface e não conhece esta função. Reinicie-o (feche o terminal do executor e rode pnpm executor) e tente de novo.";
const messageOf = (e: unknown, fallback: string) => (e instanceof EngineApiError ? (e.status === 404 && e.code === "not_found" && /Rota inexistente/i.test(e.message) ? STALE_EXECUTOR : e.message) : fallback);

export const toLocalSource = (r: ResolvedSource): LocalSource => ({
  projectId: r.projectId, projectLabel: r.projectLabel, owner: r.owner, repo: r.repo, ref: r.ref, commit: r.commit, subject: r.subject, resolvedAt: new Date().toISOString(),
});

function DirtyNote({ dirty }: { dirty: ResolvedSource["dirty"] }) {
  if (!dirty) return <p className="muted">Não foi possível conferir se há alterações locais não commitadas.</p>;
  if (!dirty.count) return <p className="muted">Sem alterações locais não commitadas.</p>;
  return (
    <p className="src-warn"><AlertTriangle size={13} aria-hidden /> {fmt(dirty.count)} alteração(ões) local(is) <b>não commitada(s) ficarão fora do contexto</b> (só o que está no commit é lido): {dirty.paths.slice(0, 8).join(", ")}{dirty.count > 8 ? `… (+${fmt(dirty.count - 8)})` : ""}.</p>
  );
}

function CommitBox({ r }: { r: ResolvedSource }) {
  return (
    <div className="src-commit" data-testid="resolved-source">
      <p><GitCommit size={14} aria-hidden /> Commit que será lido: <code className="sha" data-testid="resolved-sha">{r.commit}</code></p>
      <p className="muted">{r.subject || "(sem mensagem)"}{r.committedAt ? ` · ${new Date(r.committedAt).toLocaleString("pt-BR")}` : ""} · referência {r.ref ? <b>{r.ref}</b> : <b>HEAD atual{r.head.branch ? ` (${r.head.branch})` : ""}</b>}{r.refKind !== "head" ? ` (${{ branch: "branch", remote: "branch remoto", tag: "tag", commit: "commit", expression: "expressão Git", head: "" }[r.refKind]})` : ""}</p>
      {r.commit !== r.head.sha && <p className="muted">O commit escolhido não é o HEAD que está em uso no projeto (<code>{r.head.sha.slice(0, 12)}</code>{r.head.branch ? `, ${r.head.branch}` : ""}).</p>}
      <p className="muted">{r.published ? "Este commit também existe nas referências remotas já baixadas deste clone." : "Este commit não aparece nas referências remotas deste clone (pode não ter sido publicado)."} Nada é consultado no GitHub.</p>
      <DirtyNote dirty={r.dirty} />
    </div>
  );
}

export function LocalSourcePicker({ value, onChange, error }: { value: LocalSource | null; onChange: (v: LocalSource | null) => void; error?: string }) {
  const [projects, setProjects] = useState<LocalProject[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [projectId, setProjectId] = useState(value?.projectId ?? "");
  const [refs, setRefs] = useState<ProjectRefs | null>(null);
  const [choice, setChoice] = useState<string>(value ? (value.ref ? value.ref : HEAD) : HEAD);
  const [custom, setCustom] = useState("");
  const [resolved, setResolved] = useState<ResolvedSource | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const seq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; });

  /** Resolves the reference to its SHA (pinned = the SHA saved on the demand, when editing). The latest request wins. */
  const resolve = (pid: string, ref: string, pinned?: string) => {
    const mine = ++seq.current;
    setBusy(true); setProblem("");
    engineApi.resolveSource(pid, ref, pinned).then(({ source }) => {
      if (mine !== seq.current) return;
      setResolved(source); onChangeRef.current(toLocalSource(source));
    }).catch(e => {
      if (mine !== seq.current) return;
      setResolved(null); onChangeRef.current(null); setProblem(messageOf(e, "Não foi possível resolver a referência."));
    }).finally(() => { if (mine === seq.current) setBusy(false); });
  };
  const loadRefs = (pid: string, saved?: string) => {
    engineApi.projectRefs(pid).then(r => {
      setRefs(r);
      // A saved reference that is not a listed branch/tag (a typed SHA, for instance) goes to the free-text field.
      if (saved && !r.refs.some(x => x.name === saved)) { setCustom(saved); setChoice(CUSTOM); }
    }).catch(e => setProblem(messageOf(e, "Não foi possível listar os branches e tags.")));
  };

  // On mount: the project list, and — when editing a demand — its saved project/reference (resolved against the saved SHA).
  useEffect(() => {
    let live = true;
    engineApi.listProjects().then(r => { if (live) setProjects(r.projects); }).catch(e => { if (live) setLoadError(messageOf(e, "Não foi possível listar os projetos locais.")); });
    const t = value ? setTimeout(() => { if (live) { loadRefs(value.projectId, value.ref || undefined); resolve(value.projectId, value.ref, value.commit); } }, 0) : null;
    return () => { live = false; if (t) clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once, for the demand being edited
  }, []);
  const usable = useMemo(() => (projects ?? []).filter(p => !p.problem && p.owner && p.repo), [projects]);

  const pickProject = (pid: string) => {
    if (timer.current) clearTimeout(timer.current);
    seq.current++;
    setProjectId(pid); setChoice(HEAD); setCustom(""); setResolved(null); setProblem(""); setRefs(null); setBusy(false);
    onChange(null);
    if (pid) { loadRefs(pid); resolve(pid, ""); }
  };
  const pickRef = (c: string) => {
    if (timer.current) clearTimeout(timer.current);
    setChoice(c);
    if (c === CUSTOM) { seq.current++; setResolved(null); setBusy(false); setProblem(""); onChange(null); return; }
    resolve(projectId, c === HEAD ? "" : c);
  };
  const typeRef = (text: string) => {
    setCustom(text);
    if (timer.current) clearTimeout(timer.current);
    seq.current++;
    onChange(null); setResolved(null);
    if (text.trim()) timer.current = setTimeout(() => resolve(projectId, text.trim()), 450);
    else { setBusy(false); setProblem(""); }
  };
  const ref = choice === HEAD ? "" : choice === CUSTOM ? custom.trim() : choice;
  const moved = resolved?.refNow && resolved.refNow !== resolved.commit ? resolved.refNow : null;

  return (
    <div className="source-box local-source">
      {loadError && <p className="form-error" role="alert">{loadError}</p>}
      {projects && !usable.length && <p className="notice">Nenhum projeto local autorizado e utilizável. Cadastre a pasta do repositório em Configurações → Conexões de IA → Projetos locais (o repositório precisa ter o remoto “origin” do GitHub, mesmo que privado: nada é consultado lá).</p>}
      <div className="form-row">
        <label className="field"><span>Projeto cadastrado</span>
          <select value={projectId} aria-label="Projeto cadastrado" onChange={e => pickProject(e.target.value)}>
            <option value="">{projects ? "Escolha um projeto…" : "Carregando…"}</option>
            {usable.map(p => <option key={p.id} value={p.id}>{p.label} — {p.owner}/{p.repo}</option>)}
          </select>
        </label>
        <label className="field"><span>Branch, tag ou commit</span>
          <select value={choice} aria-label="Branch, tag ou commit" disabled={!projectId || !refs} onChange={e => pickRef(e.target.value)}>
            <option value={HEAD}>HEAD atual{refs?.head.branch ? ` (${refs.head.branch})` : ""}</option>
            {refs?.refs.filter(r => r.kind === "branch").map(r => <option key={`b-${r.name}`} value={r.name}>branch {r.name}</option>)}
            {refs?.refs.filter(r => r.kind === "tag").map(r => <option key={`t-${r.name}`} value={r.name}>tag {r.name}</option>)}
            {refs?.refs.filter(r => r.kind === "remote").map(r => <option key={`r-${r.name}`} value={r.name}>remoto {r.name}</option>)}
            <option value={CUSTOM}>Outro (SHA ou referência Git)…</option>
          </select>
        </label>
      </div>
      {choice === CUSTOM && (
        <label className="field"><span>SHA ou referência</span>
          <input value={custom} maxLength={200} aria-label="SHA ou referência Git" onChange={e => typeRef(e.target.value)} placeholder="Ex.: a1b2c3d, v1.2.0 ou feature/login" />
        </label>
      )}
      {busy && <p className="muted"><Loader2 size={13} className="spin" aria-hidden /> Resolvendo a referência no projeto…</p>}
      {problem && <p className="form-error" role="alert">{problem}</p>}
      {error && !problem && <p className="form-error" role="alert">{error}</p>}
      {resolved && !busy && <CommitBox r={resolved} />}
      {resolved && !busy && moved && (
        <p className="src-warn" role="status"><AlertTriangle size={13} aria-hidden /> A referência <b>{resolved.ref}</b> agora aponta para <code>{moved.slice(0, 12)}</code>, mas esta demanda está fixada em <code>{resolved.commit.slice(0, 12)}</code>. O plano usará o SHA fixado. <button type="button" className="btn-ghost small" onClick={() => resolve(projectId, ref)}><RefreshCw size={12} /> Usar o SHA atual</button></p>
      )}
      <small>O executor resolve o projeto pelo identificador e lê apenas objetos do Git desse commit: não consulta o GitHub, não usa credenciais do Git e não inclui alterações não commitadas.</small>
    </div>
  );
}

/** The files and excerpts of a local read, from a stored run (what really went to the model) or from a preview. */
export function LocalContextTable({ ctx }: { ctx: Extract<SourceContext, { kind: "github" }> }) {
  const l = ctx.local;
  return (
    <>
      <p data-testid="context-summary"><FolderGit2 size={13} aria-hidden /> Projeto local <b>{l?.projectLabel ?? l?.dirName}</b> ({ctx.owner}/{ctx.repo}) · referência <b>{l?.ref || "HEAD"}</b> · commit <code className="sha">{ctx.commit}</code>{l?.subject ? <> · {l.subject}</> : null}</p>
      {l?.refNow && l.refNow !== ctx.commit && <p className="src-warn"><AlertTriangle size={13} aria-hidden /> A referência já apontava para <code>{l.refNow.slice(0, 12)}</code> quando o plano começou; foi lido o SHA fixado.</p>}
      {l?.dirty && l.dirty.count > 0 && <p className="src-warn"><AlertTriangle size={13} aria-hidden /> {fmt(l.dirty.count)} alteração(ões) local(is) não commitada(s) ficaram <b>fora</b> do contexto: {l.dirty.paths.slice(0, 8).join(", ")}{l.dirty.count > 8 ? "…" : ""}.</p>}
      <h4 className="ctx-h">Arquivos enviados ao Diretor ({ctx.files.length})</h4>
      <table className="ctx-table" data-testid="context-files"><thead><tr><th>Arquivo</th><th>Motivo</th><th>Tamanho</th><th>Enviado</th></tr></thead>
        <tbody>{ctx.files.map(f => <tr key={f.path}><td><FileText size={12} /> {f.path}</td><td>{f.reason}</td><td>{fmt(f.bytes)} B</td><td>{fmt(f.sentChars)} car.{f.excerpt ? ` (trechos: ${f.excerpt.ranges.map(([a, b]) => `l.${a}-${b}`).join(", ")})` : f.truncated ? " (truncado)" : ""}{f.redactions ? ` · ${f.redactions} credencial(is) ocultada(s)` : ""}</td></tr>)}</tbody>
      </table>
      {!ctx.files.length && <p className="muted">Nenhum arquivo foi enviado: o Diretor recebe apenas a demanda.</p>}
      {!!ctx.skipped.length && <><h4 className="ctx-h">Escolhidos mas não enviados</h4><ul className="ctx-skip">{ctx.skipped.map(s => <li key={s.path}>{s.path} — {s.reason}</li>)}</ul></>}
      {ctx.withheld && <p className="muted">{fmt(ctx.withheld.count)} arquivo(s) de configuração pessoal ou credenciais foram omitidos por proteção: {ctx.withheld.examples.join(", ")}{ctx.withheld.count > ctx.withheld.examples.length ? "…" : ""}.</p>}
      <small className="muted">Limites: {ctx.limits.maxFiles} arquivos, {fmt(ctx.limits.maxFileBytes)} caracteres por arquivo, {fmt(ctx.limits.maxTotalChars)} no total. Somente o que aparece na tabela foi enviado; o restante do projeto NÃO foi lido. {l?.textSha256 ? <>Hash do texto enviado: <code className="sha">{l.textSha256.slice(0, 16)}…</code></> : null}</small>
    </>
  );
}

/** Review shown when the user is about to plan a demand with a local source: version, then what the Director would receive. Mount it with a key that changes with the demand's commit. */
export function LocalContextReview({ demand, onState, onUpdateDemand }: { demand: Demand; onState: (s: { ready: boolean }) => void; onUpdateDemand?: (l: LocalSource) => void }) {
  const l = demand.local;
  const [data, setData] = useState<{ source: ResolvedSource; context: Extract<SourceContext, { kind: "github" }>; text: string; textSha256: string | null } | null>(null);
  const [problem, setProblem] = useState("");
  const [showText, setShowText] = useState(false);
  const onStateRef = useRef(onState);
  useEffect(() => { onStateRef.current = onState; });
  useEffect(() => {
    if (!l) return;
    let live = true;
    engineApi.localContextPreview(l.projectId, { ref: l.ref, commit: l.commit, title: demand.title, description: demand.description })
      .then(r => { if (live) { setData(r); onStateRef.current({ ready: true }); } })
      .catch(e => { if (live) { setProblem(messageOf(e, "Não foi possível montar a revisão do contexto.")); onStateRef.current({ ready: false }); } });
    return () => { live = false; };
  }, [l, demand.title, demand.description]);

  if (!l) return <div className="local-review"><p className="form-error" role="alert">Esta demanda não tem projeto local definido. Edite-a e escolha o projeto e a referência.</p></div>;
  if (problem) return <div className="local-review"><p className="form-error" role="alert">{problem}</p></div>;
  if (!data) return <div className="local-review"><p className="muted"><Loader2 size={13} className="spin" aria-hidden /> Montando a revisão do contexto (sem chamar nenhum modelo)…</p></div>;
  const moved = data.source.refNow && data.source.refNow !== data.source.commit ? data.source.refNow : null;
  return (
    <div className="local-review" data-testid="local-review">
      <p className="ok-line"><CheckCircle2 size={13} aria-hidden /> Versão que o Diretor vai ler: <code className="sha" data-testid="review-sha">{data.source.commit}</code> — {data.source.subject || "(sem mensagem)"}</p>
      {moved && (
        <p className="src-warn" role="status"><AlertTriangle size={13} aria-hidden /> A referência <b>{data.source.ref}</b> agora aponta para <code>{moved.slice(0, 12)}</code>; a demanda continua fixada em <code>{data.source.commit.slice(0, 12)}</code>.{onUpdateDemand && <> <button type="button" className="btn-ghost small" onClick={() => void engineApi.resolveSource(l.projectId, l.ref).then(({ source }) => onUpdateDemand(toLocalSource(source)))}><RefreshCw size={12} /> Usar o SHA atual</button></>}</p>
      )}
      <LocalContextTable ctx={data.context} />
      <details onToggle={e => setShowText((e.currentTarget as HTMLDetailsElement).open)}>
        <summary>Ver o texto exato da fonte que será enviado ao Diretor</summary>
        {showText && <pre className="brief" data-testid="context-text">{data.text}</pre>}
      </details>
    </div>
  );
}

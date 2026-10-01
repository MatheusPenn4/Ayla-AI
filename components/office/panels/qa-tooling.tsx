"use client";

// Shared pieces for the tool-equipped QA: what the executor can really provide (vs. the permissions planned in a
// sheet), the exact version tested, and the evidence each verdict rests on — with its logs and artifacts.
import { ExternalLink, FileText, Image as ImageIcon, Terminal, Globe, Search } from "lucide-react";
import { artifactUrl } from "@/lib/engine/client";
import type { ConfiguredTopology, QAEvidence, QAToolingStatus, RunEvent, StackReport, TestedVersion } from "@/lib/engine/types";

export function versionText(v: TestedVersion | null | undefined) {
  if (!v) return "nenhuma versão reproduzível";
  const tree = v.treeHash ? ` · árvore ${v.treeHash.slice(0, 12)}` : "";
  if (v.kind === "commit_plus_patch") return `${v.label} · commit ${v.commit.slice(0, 12)} + diff ${v.patchSha256.slice(0, 12)}${tree}`;
  if (v.kind === "commit_plus_files") return `${v.label} · ${v.files.map(f => `${f.path} ${f.sha256?.slice(0, 10) ?? "removido"}`).join(", ")}${tree}`;
  return `${v.label} · commit ${v.commit.slice(0, 12)}${tree}`;
}

/** The application under test as configured and frozen with the review: processes, ports (dynamic until they start) and where the browser may go. */
export function TopologyView({ t }: { t: ConfiguredTopology }) {
  if (!t.services.length) return null;
  return (
    <section className="run-sec" data-testid="topology">
      <h4>Aplicação em teste (configuração congelada nesta revisão)</h4>
      <ul>
        {t.services.map(s => <li key={s.id}><b>{s.label}</b>{s.main ? " — origem principal" : ""}: <code>{s.command}</code> em <code>{s.dir || "(raiz)"}</code> · {s.port ? `porta fixa ${s.port}` : "porta dinâmica (escolhida ao iniciar)"} · {s.main || s.browser ? "acessível ao navegador" : "fora do alcance do navegador"}{s.install ? <> · instala com <code>{s.install}</code></> : null}</li>)}
        {t.links.map(l => <li key={`${l.name}-${l.to.join()}`}>Variável <code>{l.name}</code> = {l.as === "origin" ? "origem" : l.as === "port" ? "porta" : "host"} do processo <b>{l.service}</b>{l.suffix}, enviada a {l.to.length ? l.to.join(", ") : "todos os processos"} (resolvida ao iniciar e congelada na execução)</li>)}
        {t.extraOrigins.map(o => <li key={o.origin}>Origem adicional: <code>{o.origin}</code>{o.label && o.label !== o.origin ? ` (${o.label})` : ""}{o.external ? " — EXTERNA, autorizada explicitamente na configuração" : " — local"}</li>)}
        <li>Nunca acessíveis ao navegador: as portas do executor e da interface do Setor IA ({t.controlPorts.join(", ")}) e serviços locais sensíveis; redirecionamentos e WebSockets são conferidos.</li>
      </ul>
      <small className="muted">Estes controles limitam o navegador do QA. Não isolam a rede dos comandos e scripts do projeto. Mudar a configuração depois desta preparação exige preparar o envio de novo.</small>
    </section>
  );
}

/** What really ran: the resolved addresses, the origins the browser was allowed, what the guard refused, CORS diagnoses. */
export function StackReportView({ r }: { r: StackReport }) {
  const noise = (t: string) => !r.allowedOrigins.some(a => t.startsWith(a.origin));
  const blockedByOrigin = Object.entries(r.guard?.byOrigin ?? {}).filter(([, c]) => c.blocked > 0);
  return (
    <section className="run-sec" data-testid="stack-report">
      <h4>Aplicação e API usadas nesta revisão</h4>
      <ul>
        {r.services.map(s => <li key={s.id}><b>{s.label}</b>{s.main ? " (principal)" : ""}: <code>{s.origin}</code> · porta {s.portKind} {s.port} · pasta {s.dir || "raiz"} · pronto: {s.ready || "—"} · {s.browser ? "acessível ao navegador" : "fora do alcance do navegador"}</li>)}
        {r.links.map(l => <li key={l.name}>Ligação resolvida: <code>{l.name}={l.value}</code> → {l.to.join(", ")}</li>)}
        <li>Origens autorizadas ao navegador: {r.allowedOrigins.map(a => <span key={a.origin}><code>{a.origin}</code> ({a.why}) </span>)}</li>
        {r.guard && <li>Guarda de rede do navegador: {Object.entries(r.guard.byOrigin).filter(([o]) => r.allowedOrigins.some(a => a.origin === o)).map(([o, c]) => `${o}: ${c.allowed} permitida(s)`).join("; ") || "nenhuma requisição às origens autorizadas"}; {r.guard.blockedTotal} bloqueio(s){blockedByOrigin.length ? ` em ${blockedByOrigin.map(([o, c]) => `${o} (${c.blocked})`).join(", ")}` : ""}.</li>}
        {r.guard?.blocked.filter(b => noise(b.target) && !/\.(microsoft|bing|office)\.com/.test(b.target)).slice(0, 8).map((b, i) => <li key={i} className="bad">Bloqueado: {b.method} {b.target} — {b.reason}</li>)}
        {r.cors.map((c, i) => <li key={i} className="bad">CORS: {c}</li>)}
        <li>Encerramento: {r.stopped || "—"}</li>
      </ul>
      <small className="muted">Os bloqueios de tráfego do próprio navegador (atualizações, serviços da Microsoft) não são listados aqui; estão no log “guarda-de-rede”. O guarda limita o navegador, não a rede dos comandos do projeto.</small>
    </section>
  );
}

/** Operations the executor detected on this computer — independent of the connection chosen (the model itself never gets a tool). */
export function QAToolingList({ tooling, connectionLabel }: { tooling: QAToolingStatus | null | undefined; connectionLabel?: string }) {
  if (!tooling) return <p className="muted">O executor ainda não informou o que pode oferecer ao QA (executor indisponível ou versão anterior).</p>;
  return (
    <>
      <ul className="tool-grants">
        {tooling.operations.map(o => <li key={o.id} className={o.available ? "ok" : "no"}><b>{o.label}: {o.available ? "disponível de fato" : "indisponível"}</b><small>{o.how}</small></li>)}
        <li className="no"><b>Editar o código da entrega: bloqueado</b><small>Não existe operação de escrita; o executor confere ao final que nenhum arquivo versionado mudou.</small></li>
        <li className="no"><b>Publicar, push ou deploy: impossível</b><small>O ambiente isolado não tem remoto nem credenciais.</small></li>
      </ul>
      {tooling.topology && <TopologyView t={tooling.topology} />}
      <p className="form-note">{connectionLabel ? `Com ${connectionLabel}, ` : ""}o modelo do QA não recebe ferramentas próprias: ele pede operações de um catálogo fixo e o executor local as executa num ambiente isolado, igual para Claude Code, Codex CLI ou conexão de API. Verificado em {new Date(tooling.checkedAt).toLocaleString("pt-BR")}: {tooling.packageManager.detail}; {tooling.browser.detail}.</p>
    </>
  );
}

const METHOD: Record<QAEvidence["method"], { label: string; Icon: typeof FileText }> = {
  inspection: { label: "inspeção", Icon: Search },
  command: { label: "comando", Icon: Terminal },
  browser: { label: "navegador", Icon: Globe },
};

export function EvidenceCard({ e, runId, anchor }: { e: QAEvidence; runId: string; anchor?: boolean }) {
  const M = METHOD[e.method];
  return (
    <div className={`question evidence ${e.ok ? "" : "failed"}`} id={anchor ? `ev-${runId}-${e.id}` : undefined}>
      <b><M.Icon size={13} aria-hidden /> {e.id} · {M.label} · {e.purpose}</b>
      <small>{e.origin} Autor: executor local. Versão: {e.version}.{e.ok ? "" : " A OPERAÇÃO FALHOU OU ESTAVA INDISPONÍVEL."}</small>
      {e.command && <small><code>{e.command.command}</code> em <code>{e.command.cwd}</code> · código de saída <b>{e.command.exitCode ?? "—"}</b> · {Math.round(e.command.durationMs / 100) / 10} s{e.command.timedOut ? " · tempo esgotado" : ""}{e.command.canceled ? " · cancelado" : ""}</small>}
      {!e.command && e.steps.length > 0 && <details className="raw"><summary>Passos ({e.steps.length})</summary><ol>{e.steps.map((s, i) => <li key={i}><code>{s}</code></li>)}</ol></details>}
      <details className="raw"><summary>Resultado observado</summary><pre className="brief">{e.observed}</pre></details>
      {!!e.artifacts.length && (
        <div className="artifact-links">
          {e.artifacts.map(a => (
            <a key={a.name} href={artifactUrl(runId, a.name)} target="_blank" rel="noreferrer" className="chip" title={`${a.bytes} bytes · SHA-256 ${a.sha256}`}>
              {a.kind === "screenshot" ? <ImageIcon size={12} /> : <FileText size={12} />} {a.label} <ExternalLink size={11} />
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

/** Append-only audit notes recorded on a run after the fact (e.g. correcting who ran the tests a parecer mentions). */
export function AuditNotes({ events }: { events: RunEvent[] }) {
  const notes = events.filter(e => e.kind === "authorship_correction" || e.kind === "complementary_evidence");
  if (!notes.length) return null;
  return (
    <div className="notice audit-note">
      <b>Registro complementar (auditável) — o parecer abaixo não foi alterado</b>
      {notes.map(n => <p key={n.seq}><small>{new Date(n.at).toLocaleString("pt-BR")} · {n.kind === "complementary_evidence" ? "evidência complementar" : "correção de autoria"}:</small> {n.message}</p>)}
    </div>
  );
}

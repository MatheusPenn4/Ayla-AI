"use client";

// Shared pieces for the tool-equipped QA: what the executor can really provide (vs. the permissions planned in a
// sheet), the exact version tested, and the evidence each verdict rests on — with its logs and artifacts.
import { ExternalLink, FileText, Image as ImageIcon, Terminal, Globe, Search } from "lucide-react";
import { artifactUrl } from "@/lib/engine/client";
import type { QAEvidence, QAToolingStatus, RunEvent, TestedVersion } from "@/lib/engine/types";

export function versionText(v: TestedVersion | null | undefined) {
  if (!v) return "nenhuma versão reproduzível";
  const tree = v.treeHash ? ` · árvore ${v.treeHash.slice(0, 12)}` : "";
  if (v.kind === "commit_plus_patch") return `${v.label} · commit ${v.commit.slice(0, 12)} + diff ${v.patchSha256.slice(0, 12)}${tree}`;
  if (v.kind === "commit_plus_files") return `${v.label} · ${v.files.map(f => `${f.path} ${f.sha256?.slice(0, 10) ?? "removido"}`).join(", ")}${tree}`;
  return `${v.label} · commit ${v.commit.slice(0, 12)}${tree}`;
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

"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, ArrowRight, BriefcaseBusiness, CheckCircle2, ClipboardList, Code2, FolderOpen, GitBranch, Loader2, Plus, RefreshCw, Sparkles, Trash2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Avatar } from "../avatar";
import { TOOL_INFO, ZONE_LABEL } from "@/lib/office/defaults";
import { CAPACITY, WORK_ZONES, zoneCapacity } from "@/lib/office/layout";
import { buildDemandPayload, formatBytes } from "@/lib/integration/contracts";
import { CONNECTION_STATE_LABEL, connectionLabel } from "@/lib/engine/connections";
import { ACTIVE_STATUSES, RUN_STATUS_LABEL, type EngineStatus } from "@/lib/engine/types";
import type { useRuns } from "@/hooks/use-runs";
import { StatusBadge } from "./run-dialog";
import { isHandoffTarget, taskState } from "@/lib/engine/handoff-state";

type RunsApi = ReturnType<typeof useRuns>;
import { presetUpdate } from "@/lib/office/profile";
import type { Agent, Demand } from "@/lib/office/types";

const when = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("pt-BR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
};

export function TeamScreen({ agents, connections, onOpen, onReview, onHire }: { agents: Agent[]; connections?: EngineStatus["connections"]; onOpen: (a: Agent) => void; onReview: (a: Agent) => void; onHire: () => void }) {
  const connected = agents.filter(a => a.connection !== "none" && connections?.[a.connection]?.state === "connected").length;
  const updates = agents.filter(a => presetUpdate(a));
  const pending = updates.filter(a => !presetUpdate(a)!.dismissed);
  return (
    <div className="work-screen">
      <div className="screen-heading">
        <div><span className="eyebrow">EQUIPE / FUNCIONÁRIOS</span><h2>Quem trabalha aqui</h2><p>Configure instruções, ferramentas, limites e encaminhamentos de cada personagem.</p></div>
        <button className="btn-primary" onClick={onHire} disabled={agents.length >= CAPACITY}><Plus size={16} /> Contratar</button>
      </div>
      {!!pending.length && (
        <div className="preset-banner wide" role="status">
          <Sparkles size={16} aria-hidden />
          <p><b>Novas instruções padrão para {pending.length} {pending.length === 1 ? "colaborador" : "colaboradores"}.</b> Suas fichas atuais continuam valendo; compare e aplique só o que quiser. Nome, visual, estação e demandas não mudam.</p>
          <div className="banner-actions">{pending.map(a => <button key={a.id} className="btn-secondary" onClick={() => onReview(a)}>Revisar {a.name}</button>)}</div>
        </div>
      )}
      <div className="capacity">
        {WORK_ZONES.map(z => {
          const n = agents.filter(a => a.zone === z).length, cap = zoneCapacity(z);
          return (
            <div key={z} className={`cap zone-${z}`}>
              <span>{ZONE_LABEL[z]}</span>
              <b>{n}<small>/{cap}</small></b>
              <div className="cap-bar"><i style={{ width: `${(n / cap) * 100}%` }} /></div>
            </div>
          );
        })}
        <div className="cap" title="Colaboradores cuja conexão escolhida na ficha está ativa neste computador. Nesta fase só o Diretor executa."><span>Com conexão ativa</span><b>{connected}<small>/{agents.length}</small></b><div className="cap-bar"><i style={{ width: `${agents.length ? (connected / agents.length) * 100 : 0}%` }} /></div></div>
      </div>
      <div className="team-grid">
        {agents.map((a, i) => (
          <button key={a.id} className="team-tile" style={{ "--accent": a.color } as React.CSSProperties} onClick={() => onOpen(a)}>
            <span className="tile-index">Nº {String(i + 1).padStart(2, "0")} · {ZONE_LABEL[a.zone]}{presetUpdate(a) && !presetUpdate(a)!.dismissed ? <em className="tile-flag">atualização disponível</em> : null}</span>
            <Avatar look={a.look} color={a.color} size={64} />
            <span className="tile-role">{a.role}</span>
            <h3>{a.name}</h3>
            <p>{a.description}</p>
            <span className="tile-tools" title="Permissões planejadas">{TOOL_INFO.filter(t => a.tools[t.key]).map(t => <i key={t.key}>{t.label}</i>)}</span>
            <span className="tile-bottom">{connectionLabel(a.connection)}{a.modelName ? ` · ${a.modelName}` : ""}{a.connection !== "none" && connections?.[a.connection] ? ` · ${CONNECTION_STATE_LABEL[connections[a.connection]!.state].toLowerCase()}` : ""}<ArrowRight size={16} /></span>
          </button>
        ))}
      </div>
    </div>
  );
}

function EngineBanner({ runs, director, onOpenDirector }: { runs: RunsApi; director: Agent | undefined; onOpenDirector: () => void }) {
  const st = runs.status;
  const conn = director && director.connection !== "none" ? st?.connections[director.connection] : undefined;
  const items: { ok: boolean; label: string; hint?: string; steps?: string[] }[] = st
    ? [
        { ok: st.executor.reachable, label: st.executor.reachable ? `Executor local ativo${st.executor.version ? ` (v${st.executor.version})` : ""}` : "Executor local indisponível", hint: st.executor.reachable ? undefined : st.executor.message ?? st.disabledReason ?? undefined },
        ...(st.executor.reachable ? [{ ok: st.store.ok, label: st.store.ok ? "Registro durável das execuções (arquivo SQLite local)" : "Registro de execuções indisponível", hint: st.store.message ?? undefined }] : []),
        {
          ok: !!director && director.connection !== "none",
          label: director?.connection && director.connection !== "none" ? `Conexão do Diretor: ${connectionLabel(director.connection)}${director.modelName ? ` · ${director.modelName}` : " · modelo padrão do cliente"}` : "Conexão do Diretor não escolhida",
          hint: director?.connection === "none" ? "Escolha na ficha do Diretor (aba Perfil): Claude via Claude Code ou ChatGPT Business via Codex." : undefined,
        },
        ...(conn ? [{ ok: conn.state === "connected", label: `${conn.client}: ${CONNECTION_STATE_LABEL[conn.state]}${conn.account ? ` · ${conn.account}` : ""}`, hint: conn.message, steps: conn.state === "connected" ? undefined : conn.steps }] : []),
      ]
    : [];
  const blocking = items.filter(i => !i.ok).length;
  return (
    <div className={`engine-banner ${blocking ? "has-issues" : "is-ready"}`}>
      <div className="engine-head">
        <span className={`led ${blocking ? "amber" : "green"}`} />
        <b>Motor do Diretor · fase 1</b>
        <span className="muted">somente planejamento · especialistas ainda não executam · GitHub: só repositórios públicos, leitura limitada</span>
        <button className="btn-ghost" disabled={runs.checking} onClick={() => { void runs.verify(); void runs.refresh(); }}>{runs.checking ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} Verificar conexão</button>
        <button className="btn-ghost" onClick={onOpenDirector}>Ficha do Diretor</button>
      </div>
      {runs.statusError && <p className="form-error">{runs.statusError}</p>}
      {!st && !runs.statusError && <p className="engine-foot">Consultando o executor local…</p>}
      {!!items.length && (
        <ul className="engine-checks">
          {items.map((i, k) => (
            <li key={k} className={i.ok ? "ok" : "bad"}>
              {i.ok ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
              <span>{i.label}{i.hint && <small>{i.hint}</small>}{i.steps?.length ? <ol className="conn-steps">{i.steps.map((s, n) => <li key={n}>{s}</li>)}</ol> : null}</span>
            </li>
          ))}
        </ul>
      )}
      {blocking > 0 && st && <p className="engine-foot">Enquanto houver pendências, “Planejar com o Diretor” registra a execução como falha com o motivo exato. Nenhum plano de exemplo é exibido.</p>}
    </div>
  );
}

export function DemandQueue({ demands, agents, runs, onNew, onRemove, onOpenAgent, onPlan, onOpenRun }: {
  demands: Demand[];
  agents: Agent[];
  runs: RunsApi;
  onNew: () => void;
  onRemove: (id: string) => void;
  onOpenAgent: (id: string) => void;
  onPlan: (d: Demand) => void;
  onOpenRun: (runId: string) => void;
}) {
  const [filter, setFilter] = useState<string>("all");
  const [payloadFor, setPayloadFor] = useState<Demand | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const list = useMemo(() => (filter === "all" ? demands : demands.filter(d => d.recipient === filter)), [demands, filter]);
  const recipients = [...new Set(demands.map(d => d.recipient))];
  const director = agents.find(a => a.id === "director");
  return (
    <div className="work-screen">
      <div className="screen-heading">
        <div><span className="eyebrow">QUADRO / FILA DE DEMANDAS</span><h2>Missões</h2><p>Criar uma demanda apenas a prepara. “Planejar com o Diretor” executa de verdade, pelo executor local e pelo cliente oficial escolhido na ficha do Diretor.</p></div>
        <button className="btn-primary" onClick={onNew}><Plus size={16} /> Nova demanda</button>
      </div>
      <EngineBanner runs={runs} director={director} onOpenDirector={() => onOpenAgent("director")} />
      {!!recipients.length && (
        <div className="chips filter" role="radiogroup" aria-label="Filtrar por responsável">
          <button className="chip" role="radio" aria-checked={filter === "all"} onClick={() => setFilter("all")}>Todas <b>{demands.length}</b></button>
          {recipients.map(id => { const a = agents.find(x => x.id === id); return <button key={id} className="chip" role="radio" aria-checked={filter === id} onClick={() => setFilter(id)}>{a?.name ?? "Removido"} <b>{demands.filter(d => d.recipient === id).length}</b></button>; })}
        </div>
      )}
      <div className="demand-list">
        {list.length ? list.map(d => {
          const a = agents.find(x => x.id === d.recipient);
          const latest = runs.latestFor(d.id);
          const history = runs.historyFor(d.id);
          const active = latest ? ACTIVE_STATUSES.includes(latest.status) : false;
          const sending = runs.pending.has(d.id);
          const startError = runs.startErrors[d.id];
          return (
            <article className="demand-card" key={d.id}>
              <div className="demand-top">
                <span className="code">MISSÃO {d.id.slice(0, 6).toUpperCase()}</span>
                <span className={`prio prio-${d.priority}`}>{d.priority}</span>
                <StatusBadge status={latest?.status ?? "prepared"} />
                <time dateTime={d.createdAt}>{when(d.createdAt)}</time>
              </div>
              <h3>{d.title}</h3>
              {d.description && <p className="demand-desc">{d.description}</p>}
              {!!d.acceptanceCriteria.length && (
                <div className="demand-criteria"><span className="eyebrow">CRITÉRIOS DE ACEITE</span><ol>{d.acceptanceCriteria.map((c, i) => <li key={i}>{c}</li>)}</ol></div>
              )}
              <div className="demand-footer">
                <button className="who" onClick={() => a && onOpenAgent(a.id)} disabled={!a}>{a ? <Avatar look={a.look} color={a.color} size={24} /> : null}{a?.name ?? "Funcionário removido"}</button>
                <span><BriefcaseBusiness size={14} />{d.project || "Sem projeto"}</span>
                {d.source === "github" && d.repo && <a href={d.repo.url} target="_blank" rel="noopener noreferrer"><GitBranch size={14} />{d.repo.owner}/{d.repo.repo}{d.repo.branch ? ` · ${d.repo.branch}` : ""}</a>}
                {d.source === "github" && !d.repo && d.sourceLabel && <span><GitBranch size={14} />{d.sourceLabel}</span>}
                {d.source === "folder" && <span title="O Diretor recebe só os metadados; os arquivos não são lidos nesta fase"><FolderOpen size={14} />{d.folder?.name ?? d.sourceLabel} · {(d.folder?.fileCount ?? d.fileCount).toLocaleString("pt-BR")} arquivos{d.folder?.totalBytes ? ` · ${formatBytes(d.folder.totalBytes)}` : ""} · arquivos não serão lidos</span>}
                {d.source === "none" && <span>Sem fonte</span>}
                <span className="grow" />
                <button className="btn-ghost" onClick={() => setPayloadFor(d)}><Code2 size={14} /> Payload</button>
                <button className="btn-ghost danger" onClick={() => setConfirm(d.id)} aria-label={`Remover ${d.title}`}><Trash2 size={14} /></button>
              </div>
              <div className="run-row">
                <button className="btn-primary small" disabled={active || sending || !runs.status?.executionEnabled} onClick={() => onPlan(d)} title={!runs.status?.executionEnabled ? runs.status?.disabledReason ?? "Executor local indisponível" : undefined}>
                  {sending ? <><Loader2 size={14} className="spin" /> Enviando…</> : active ? <><Loader2 size={14} className="spin" /> {latest?.status === "queued" ? "Na fila do executor…" : "Diretor planejando…"}</> : <><Sparkles size={14} /> {latest ? "Planejar novamente" : "Planejar com o Diretor"}</>}
                </button>
                {latest && <button className="btn-secondary small" onClick={() => onOpenRun(latest.id)}>Ver execução</button>}
                {active && latest && <button className="btn-ghost small" onClick={() => void runs.cancel(latest.id)}>Cancelar</button>}
                {startError && <span className="run-hint bad">{startError}</span>}
                {latest?.status === "awaiting_clarification" && <span className="run-hint">O Diretor fez perguntas: abra a execução para responder.</span>}
                {latest?.status === "failed" && latest.error && <span className="run-hint bad">{latest.error.message}</span>}
                {latest?.status === "plan_ready" && latest.result && <span className="run-hint ok">{latest.result.tasks.length} tarefa(s) proposta(s) · {connectionLabel(latest.connection)}{latest.budget.reportedTotalTokens !== null ? ` · ${latest.budget.reportedTotalTokens.toLocaleString("pt-BR")} tokens informados pelo cliente` : " · uso não informado pelo cliente"}</span>}
                {(() => {
                  // Hand-offs belong to the most recent finished plan (a later canceled/failed run does not hide them).
                  const lp = history.find(r => r.status === "plan_ready" && r.result);
                  if (!lp?.result) return null;
                  const archTasks = lp.result.tasks.filter(t => isHandoffTarget(t.assignee));
                  if (!archTasks.length) return <span className="run-hint">Sem tarefa para o Arquiteto no último plano.</span>;
                  const states = archTasks.map(t => taskState(t, runs.taskRunsFor(lp.id, t.id)).key);
                  const count = (k: string) => states.filter(x => x === k).length;
                  const parts = [
                    count("analysis_ready") && `${count("analysis_ready")} análise(s) concluída(s)`,
                    count("awaiting_approval") && `${count("awaiting_approval")} aguardando sua aprovação`,
                    (count("working") + count("queued")) && `${count("working") + count("queued")} em execução`,
                    count("awaiting_clarification") && `${count("awaiting_clarification")} aguardando esclarecimento`,
                    (count("failed") + count("canceled")) && `${count("failed") + count("canceled")} com falha/cancelada`,
                    count("proposed") && `${count("proposed")} proposta(s) para enviar`,
                  ].filter(Boolean);
                  return <button className="chip arch-chip" onClick={() => onOpenRun(lp.id)} title="Abrir as tarefas do último plano pronto">Arquiteto: {parts.join(" · ")}</button>;
                })()}
                {history.length > 1 && (
                  <span className="run-history">Histórico: {history.slice(0, 5).map(r => <button key={r.id} className="chip" onClick={() => onOpenRun(r.id)} title={new Date(r.createdAt).toLocaleString("pt-BR")}>{RUN_STATUS_LABEL[r.status]}</button>)}</span>
                )}
              </div>
              {confirm === d.id && (
                <div className="inline-confirm" role="alert">
                  Remover esta demanda da fila local? O registro das execuções continua no executor local.
                  <button className="btn-secondary" onClick={() => setConfirm(null)}>Manter</button>
                  <button className="btn-danger" onClick={() => { onRemove(d.id); setConfirm(null); }}>Remover</button>
                </div>
              )}
            </article>
          );
        }) : (
          <div className="empty-board">
            <ClipboardList size={34} />
            <h3>Nenhuma missão por enquanto</h3>
            <p>Clique no Diretor no escritório ou crie uma demanda para iniciar a fila.</p>
            <button className="btn-primary" onClick={onNew}>Criar primeira demanda <ArrowRight size={16} /></button>
          </div>
        )}
      </div>
      <Dialog open={!!payloadFor} onOpenChange={v => !v && setPayloadFor(null)}>
        <DialogContent className="game-dialog payload-dialog">
          <DialogHeader>
            <span className="eyebrow">INTEGRAÇÃO / CONTRATO</span>
            <DialogTitle>Contrato completo da demanda</DialogTitle>
            <DialogDescription>Formato de integração (<code>lib/integration/contracts.ts</code>) com a equipe inteira. O planejamento real usa a ficha do Diretor e envia exatamente o que aparece na aba “Entrada” da execução.</DialogDescription>
          </DialogHeader>
          <pre className="payload">{payloadFor ? JSON.stringify(buildDemandPayload(payloadFor, agents), null, 2) : ""}</pre>
        </DialogContent>
      </Dialog>
    </div>
  );
}

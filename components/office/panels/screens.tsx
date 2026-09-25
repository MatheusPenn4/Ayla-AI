"use client";

import { useMemo, useState } from "react";
import { ArrowRight, BriefcaseBusiness, ClipboardList, Code2, FolderOpen, GitBranch, Plus, Sparkles, Trash2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Avatar } from "../avatar";
import { TOOL_INFO, ZONE_LABEL } from "@/lib/office/defaults";
import { CAPACITY, WORK_ZONES, zoneCapacity } from "@/lib/office/layout";
import { buildDemandPayload, formatBytes, orchestrator } from "@/lib/integration/contracts";
import { presetUpdate } from "@/lib/office/profile";
import type { Agent, Demand } from "@/lib/office/types";

const when = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("pt-BR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
};

export function TeamScreen({ agents, onOpen, onReview, onHire }: { agents: Agent[]; onOpen: (a: Agent) => void; onReview: (a: Agent) => void; onHire: () => void }) {
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
        <div className="cap"><span>Agentes conectados</span><b>0<small>/{agents.length}</small></b><div className="cap-bar"><i style={{ width: 0 }} /></div></div>
      </div>
      <div className="team-grid">
        {agents.map((a, i) => (
          <button key={a.id} className="team-tile" style={{ "--accent": a.color } as React.CSSProperties} onClick={() => onOpen(a)}>
            <span className="tile-index">Nº {String(i + 1).padStart(2, "0")} · {ZONE_LABEL[a.zone]}{presetUpdate(a) && !presetUpdate(a)!.dismissed ? <em className="tile-flag">atualização disponível</em> : null}</span>
            <Avatar look={a.look} color={a.color} size={64} />
            <span className="tile-role">{a.role}</span>
            <h3>{a.name}</h3>
            <p>{a.description}</p>
            <span className="tile-tools" title="Permissões planejadas (nenhuma conectada)">{TOOL_INFO.filter(t => a.tools[t.key]).map(t => <i key={t.key}>{t.label}</i>)}</span>
            <span className="tile-bottom">{a.model === "A definir" ? "Provedor a definir" : String(a.model)}{a.modelName ? ` · ${a.modelName}` : ""}<ArrowRight size={16} /></span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function DemandQueue({ demands, agents, onNew, onRemove, onOpenAgent }: { demands: Demand[]; agents: Agent[]; onNew: () => void; onRemove: (id: string) => void; onOpenAgent: (id: string) => void }) {
  const [filter, setFilter] = useState<string>("all");
  const [payloadFor, setPayloadFor] = useState<Demand | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const list = useMemo(() => (filter === "all" ? demands : demands.filter(d => d.recipient === filter)), [demands, filter]);
  const recipients = [...new Set(demands.map(d => d.recipient))];
  return (
    <div className="work-screen">
      <div className="screen-heading">
        <div><span className="eyebrow">QUADRO / FILA DE DEMANDAS</span><h2>Missões preparadas</h2><p>Tudo aqui está salvo neste navegador e aguarda a integração do motor de agentes.</p></div>
        <button className="btn-primary" onClick={onNew}><Plus size={16} /> Nova demanda</button>
      </div>
      <div className="queue-status">
        <span className="led amber" /> Motor de execução: <b>{orchestrator.status === "not_connected" ? "não conectado" : "conectado"}</b>
        <span className="sep" /> {demands.length} {demands.length === 1 ? "demanda preparada" : "demandas preparadas"}
      </div>
      {!!recipients.length && (
        <div className="chips filter" role="radiogroup" aria-label="Filtrar por responsável">
          <button className="chip" role="radio" aria-checked={filter === "all"} onClick={() => setFilter("all")}>Todas <b>{demands.length}</b></button>
          {recipients.map(id => { const a = agents.find(x => x.id === id); return <button key={id} className="chip" role="radio" aria-checked={filter === id} onClick={() => setFilter(id)}>{a?.name ?? "Removido"} <b>{demands.filter(d => d.recipient === id).length}</b></button>; })}
        </div>
      )}
      <div className="demand-list">
        {list.length ? list.map(d => {
          const a = agents.find(x => x.id === d.recipient);
          return (
            <article className="demand-card" key={d.id}>
              <div className="demand-top">
                <span className="code">MISSÃO {d.id.slice(0, 6).toUpperCase()}</span>
                <span className={`prio prio-${d.priority}`}>{d.priority}</span>
                <span className="tag-prepared">Preparada · aguardando integração</span>
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
                {d.source === "folder" && <span><FolderOpen size={14} />{d.folder?.name ?? d.sourceLabel} · {(d.folder?.fileCount ?? d.fileCount).toLocaleString("pt-BR")} arquivos{d.folder?.totalBytes ? ` · ${formatBytes(d.folder.totalBytes)}` : ""}</span>}
                {d.source === "none" && <span>Sem fonte</span>}
                <span className="grow" />
                <button className="btn-ghost" onClick={() => setPayloadFor(d)}><Code2 size={14} /> Payload</button>
                <button className="btn-ghost danger" onClick={() => setConfirm(d.id)} aria-label={`Remover ${d.title}`}><Trash2 size={14} /></button>
              </div>
              {confirm === d.id && (
                <div className="inline-confirm" role="alert">
                  Remover esta demanda da fila local?
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
            <DialogTitle>Payload para o motor</DialogTitle>
            <DialogDescription>É isto que o backend receberá quando existir (<code>lib/integration/contracts.ts</code>). Nada foi enviado.</DialogDescription>
          </DialogHeader>
          <pre className="payload">{payloadFor ? JSON.stringify(buildDemandPayload(payloadFor, agents), null, 2) : ""}</pre>
        </DialogContent>
      </Dialog>
    </div>
  );
}

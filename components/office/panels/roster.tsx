"use client";

import { useRef } from "react";
import { Send, Settings2, X } from "lucide-react";
import { Avatar } from "../avatar";
import { TOOL_INFO, ZONE_LABEL } from "@/lib/office/defaults";
import type { Agent } from "@/lib/office/types";

/** Team list outside the canvas: Tab enters, ↑/↓/Home/End move, Enter/Space selects. */
export function Roster({ agents, selectedId, demandCounts, onSelect, onHover }: {
  agents: Agent[];
  selectedId: string | null;
  demandCounts: Record<string, number>;
  onSelect: (id: string) => void;
  onHover: (id: string | null) => void;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const focusIndex = Math.max(0, agents.findIndex(a => a.id === selectedId));
  const onKey = (e: React.KeyboardEvent, i: number) => {
    const next = e.key === "ArrowDown" ? i + 1 : e.key === "ArrowUp" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? agents.length - 1 : null;
    if (next === null) return;
    e.preventDefault();
    const j = (next + agents.length) % agents.length;
    refs.current[j]?.focus();
  };
  return (
    <ul className="roster" aria-label="Funcionários no escritório">
      {agents.map((a, i) => (
        <li key={a.id}>
          <button
            ref={el => { refs.current[i] = el; }}
            className={`roster-item ${selectedId === a.id ? "is-current" : ""}`}
            style={{ "--accent": a.color } as React.CSSProperties}
            tabIndex={i === focusIndex ? 0 : -1}
            aria-current={selectedId === a.id ? "true" : undefined}
            aria-label={`${a.name}, ${a.role}, ${ZONE_LABEL[a.zone]}`}
            onClick={() => onSelect(a.id)}
            onKeyDown={e => onKey(e, i)}
            onMouseEnter={() => onHover(a.id)}
            onMouseLeave={() => onHover(null)}
            onFocus={() => onHover(a.id)}
            onBlur={() => onHover(null)}
          >
            <Avatar look={a.look} color={a.color} size={34} />
            <span className="roster-text"><b>{a.name}</b><small>{a.role}</small></span>
            {!!demandCounts[a.id] && <em className="badge" aria-label={`${demandCounts[a.id]} demandas`}>{demandCounts[a.id]}</em>}
            <i className="roster-zone" data-zone={a.zone} aria-hidden />
          </button>
        </li>
      ))}
    </ul>
  );
}

export function CharacterCard({ agent, demandCount, onClose, onConfigure, onDemand }: { agent: Agent; demandCount: number; onClose: () => void; onConfigure: () => void; onDemand: () => void }) {
  const tools = TOOL_INFO.filter(t => agent.tools[t.key]);
  const isDirector = agent.zone === "director" && agent.id === "director";
  return (
    <section className="character-card" data-scene-blocker style={{ "--accent": agent.color } as React.CSSProperties} aria-label={`Funcionário selecionado: ${agent.name}`}>
      <button className="icon-btn card-dismiss" onClick={onClose} aria-label="Fechar"><X size={16} /></button>
      <div className="card-head">
        <Avatar look={agent.look} color={agent.color} size={58} />
        <div>
          <span className="eyebrow">{ZONE_LABEL[agent.zone]}</span>
          <h3>{agent.name}</h3>
          <p>{agent.role}</p>
        </div>
      </div>
      <p className="card-desc">{agent.description}</p>
      <dl className="card-stats">
        <div><dt>Provedor</dt><dd>{String(agent.model)}</dd></div>
        <div><dt>Tokens</dt><dd>{agent.budget.toLocaleString("pt-BR")}</dd></div>
        <div><dt>Na fila</dt><dd>{demandCount}</dd></div>
      </dl>
      <div className="card-tools">{tools.length ? tools.map(t => <span key={t.key}>{t.label}</span>) : <span className="muted">Sem ferramentas</span>}</div>
      <div className="card-actions">
        {isDirector ? (
          <>
            <button className="btn-primary" onClick={onDemand}><Send size={15} /> Enviar demanda</button>
            <button className="btn-secondary" onClick={onConfigure}><Settings2 size={15} /> Ficha</button>
          </>
        ) : (
          <>
            <button className="btn-primary" onClick={onConfigure}><Settings2 size={15} /> Abrir ficha</button>
            <button className="btn-secondary" onClick={onDemand}><Send size={15} /> Demanda</button>
          </>
        )}
      </div>
    </section>
  );
}

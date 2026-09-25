"use client";

import { useMemo, useState } from "react";
import { Check } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { TOOL_INFO } from "@/lib/office/defaults";
import { PRESET_VERSION, type ProfileField } from "@/lib/office/presets";
import { TARGET_LABEL_USER, comparePreset, type FieldDiff } from "@/lib/office/profile";
import type { Agent, ToolKey } from "@/lib/office/types";
import { USER_TARGET } from "@/lib/office/types";

function format(d: FieldDiff, value: unknown, team: Agent[]) {
  if (value === null || value === undefined || value === "" || (Array.isArray(value) && !value.length)) return <em className="cmp-empty">vazio</em>;
  if (d.key === "tools") {
    const on = TOOL_INFO.filter(t => (value as Record<ToolKey, boolean>)[t.key]).map(t => t.label);
    return on.length ? on.join(", ") : <em className="cmp-empty">nenhuma</em>;
  }
  if (d.key === "handoffTo" || d.key === "returnTo") return (value as string[]).map(id => (id === USER_TARGET ? TARGET_LABEL_USER : team.find(a => a.id === id)?.name ?? id)).join(", ");
  if (d.key === "budget") return `${Number(value).toLocaleString("pt-BR")} tokens`;
  return String(value);
}

/**
 * Field-by-field comparison with the newest default profile. Untouched fields
 * are pre-selected; customised ones stay unchecked unless the user opts in.
 * Applying only changes the sheet draft: the user still has to save.
 */
export function PresetCompareDialog({ open, agent, team, onCancel, onApply }: {
  open: boolean;
  agent: Agent;
  team: Agent[];
  onCancel: () => void;
  onApply: (keys: ProfileField[]) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={v => !v && onCancel()}>
      <DialogContent className="game-dialog compare-dialog">
        {open && <CompareBody agent={agent} team={team} onCancel={onCancel} onApply={onApply} />}
      </DialogContent>
    </Dialog>
  );
}

function CompareBody({ agent, team, onCancel, onApply }: { agent: Agent; team: Agent[]; onCancel: () => void; onApply: (keys: ProfileField[]) => void }) {
  const diffs = useMemo(() => comparePreset(agent, team.map(a => a.id)), [agent, team]);
  const [chosen, setChosen] = useState<Set<ProfileField>>(() => new Set(diffs.filter(d => d.suggested).map(d => d.key)));
  const changed = diffs.filter(d => !d.equal);
  const groups = [...new Set(diffs.map(d => d.group))];
  const toggle = (k: ProfileField, on: boolean) => setChosen(s => { const n = new Set(s); if (on) n.add(k); else n.delete(k); return n; });
  const outdated = agent.preset.version < PRESET_VERSION;

  return (
    <>
      <DialogHeader>
        <span className="eyebrow">FICHA · {agent.name.toUpperCase()}</span>
        <DialogTitle>{outdated ? "Atualizar para as novas instruções padrão" : "Comparar com a ficha padrão"}</DialogTitle>
        <DialogDescription>
          {outdated
            ? `Sua ficha foi criada com a versão ${agent.preset.version} dos padrões; a versão atual é ${PRESET_VERSION}. `
            : "A ficha já está na versão atual; você pode restaurar campos específicos. "}
          Campos vazios ou nunca editados vêm marcados; campos que você personalizou ficam desmarcados. Nome, visual, estação, provedor e demandas nunca mudam.
        </DialogDescription>
      </DialogHeader>
      <div className="cmp-toolbar">
        <span>{changed.length} de {diffs.length} campos diferem do padrão · {chosen.size} selecionados</span>
        <button type="button" className="btn-ghost" onClick={() => setChosen(new Set(diffs.filter(d => d.suggested).map(d => d.key)))}>Só sugeridos</button>
        <button type="button" className="btn-ghost" onClick={() => setChosen(new Set(changed.map(d => d.key)))}>Todos os diferentes</button>
        <button type="button" className="btn-ghost" onClick={() => setChosen(new Set())}>Nenhum</button>
      </div>
      <div className="dialog-scroll cmp-list">
        {groups.map(g => (
          <section key={g} className="cmp-group">
            <h4>{g}</h4>
            {diffs.filter(d => d.group === g).map(d => (
              <div key={d.key} className={`cmp-row ${d.equal ? "is-equal" : ""} ${chosen.has(d.key) ? "is-chosen" : ""}`}>
                <label className="cmp-head">
                  <input type="checkbox" disabled={d.equal} checked={chosen.has(d.key)} onChange={e => toggle(d.key, e.target.checked)} aria-label={`Aplicar padrão em ${d.label}`} />
                  <b>{d.label}</b>
                  {d.equal ? <span className="tag">igual ao padrão</span> : d.customized ? <span className="tag warn">personalizado</span> : <span className="tag ok">sugerido</span>}
                </label>
                {!d.equal && (
                  <div className="cmp-cols">
                    <div><span className="eyebrow">ATUAL</span><div className="cmp-text">{format(d, d.current, team)}</div></div>
                    <div><span className="eyebrow">NOVO PADRÃO</span><div className="cmp-text">{format(d, d.next, team)}</div></div>
                  </div>
                )}
              </div>
            ))}
          </section>
        ))}
      </div>
      <div className="dialog-actions">
        <span className="cmp-foot">Aplicar altera apenas o rascunho da ficha. Revise e clique em Salvar.</span>
        <button className="btn-secondary" onClick={onCancel}>Cancelar e manter a ficha</button>
        <button className="btn-primary" disabled={!chosen.size} onClick={() => onApply([...chosen])}><Check size={15} /> Aplicar {chosen.size} {chosen.size === 1 ? "campo" : "campos"}</button>
      </div>
    </>
  );
}

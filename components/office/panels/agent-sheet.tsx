"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Tabs } from "radix-ui";
import { ArrowRight, Check, Send, Trash2, X } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Switch } from "@/components/ui/switch";
import { Avatar } from "../avatar";
import { AppearanceEditor } from "./appearance-editor";
import { Field } from "./field";
import { PROVIDERS, TOOL_INFO, ZONE_LABEL } from "@/lib/office/defaults";
import { WORK_ZONES, zoneCapacity } from "@/lib/office/layout";
import type { Agent } from "@/lib/office/types";

const BUDGET_PRESETS = [8000, 16000, 32000, 64000, 128000];
const fmt = (n: number) => n.toLocaleString("pt-BR");

type Props = {
  open: boolean;
  agent: Agent | null;
  agents: Agent[];
  onClose: () => void;
  onSave: (draft: Agent) => string | null;
  onDemand: (id: string) => void;
  onRemove: (id: string) => void;
  tab: string;
  onTab: (t: string) => void;
  /** Live preview of unsaved edits in the 3D office (null when closed). */
  onDraft?: (draft: Agent | null) => void;
};

export function AgentSheet(props: Props) {
  const { open, agent, onClose, onRemove } = props;
  const dirtyRef = useRef(false);
  const [confirm, setConfirm] = useState<null | "discard" | "remove">(null);
  // Bumped after a successful save so the form remounts from the saved agent.
  const [version, setVersion] = useState(0);
  const requestClose = () => (dirtyRef.current ? setConfirm("discard") : onClose());

  return (
    <>
      <Sheet open={open} onOpenChange={v => (v ? null : requestClose())}>
        <SheetContent side="right" className="agent-sheet" showCloseButton={false} onOpenAutoFocus={e => e.preventDefault()} aria-describedby={undefined}>
          {agent && <SheetBody key={`${agent.id}:${version}`} {...props} agent={agent} dirtyRef={dirtyRef} onSaved={() => setVersion(v => v + 1)} requestClose={requestClose} onAskRemove={() => setConfirm("remove")} />}
        </SheetContent>
      </Sheet>
      <AlertDialog open={!!confirm} onOpenChange={v => !v && setConfirm(null)}>
        <AlertDialogContent className="game-dialog confirm-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm === "remove" ? `Dispensar ${agent?.name}?` : "Descartar alterações?"}</AlertDialogTitle>
            <AlertDialogDescription>{confirm === "remove" ? "O personagem sai do escritório e a estação fica livre. As demandas já preparadas continuam na fila." : "As mudanças desta ficha ainda não foram salvas."}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="btn-secondary">Voltar</AlertDialogCancel>
            <AlertDialogAction className="btn-danger" onClick={() => { if (confirm === "remove" && agent) onRemove(agent.id); dirtyRef.current = false; setConfirm(null); onClose(); }}>{confirm === "remove" ? "Dispensar" : "Descartar"}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function SheetBody({ agent, agents, onSave, onDemand, tab, onTab, onDraft, dirtyRef, onSaved, requestClose, onAskRemove }: Props & {
  agent: Agent;
  dirtyRef: React.RefObject<boolean>;
  onSaved: () => void;
  requestClose: () => void;
  onAskRemove: () => void;
}) {
  const [draft, setDraft] = useState<Agent>(() => structuredClone(agent));
  const [error, setError] = useState("");
  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(agent), [draft, agent]);
  useEffect(() => { dirtyRef.current = dirty; }, [dirty, dirtyRef]);
  useEffect(() => { onDraft?.(draft); return () => onDraft?.(null); }, [draft, onDraft]);
  const update = (part: Partial<Agent>) => setDraft(d => ({ ...d, ...part }));
  const save = () => {
    const err = onSave(draft);
    setError(err ?? "");
    if (!err) onSaved();
  };
  const others = agents.filter(a => a.id !== draft.id);
  const zoneUsed = (z: string) => agents.filter(a => a.zone === z && a.id !== draft.id).length;

  return (
    <>
          <header className="sheet-hero" style={{ "--accent": draft.color } as React.CSSProperties}>
            <button className="icon-btn sheet-close" onClick={requestClose} aria-label="Fechar ficha"><X size={18} /></button>
            <Avatar look={draft.look} color={draft.color} size={76} className="sheet-portrait" />
            <div className="sheet-id">
              <span className="eyebrow">FICHA DO FUNCIONÁRIO · {ZONE_LABEL[draft.zone].toUpperCase()}</span>
              <SheetTitle className="sheet-title">{draft.name || "Sem nome"}</SheetTitle>
              <SheetDescription className="sheet-sub">{draft.role || "Sem função"} · {String(draft.model)}{draft.modelName ? ` / ${draft.modelName}` : ""}</SheetDescription>
            </div>
            <dl className="sheet-stats">
              <div><dt>Ferramentas</dt><dd>{Object.values(draft.tools).filter(Boolean).length}/{TOOL_INFO.length}</dd></div>
              <div><dt>Orçamento</dt><dd>{fmt(draft.budget)}</dd></div>
              <div><dt>Encaminha</dt><dd>{draft.handoffTo.length}</dd></div>
            </dl>
          </header>
          <Tabs.Root value={tab} onValueChange={onTab} className="sheet-tabs">
            <Tabs.List className="tab-list" aria-label="Seções da ficha">
              <Tabs.Trigger value="profile">Perfil</Tabs.Trigger>
              <Tabs.Trigger value="look">Visual</Tabs.Trigger>
              <Tabs.Trigger value="instructions">Instruções</Tabs.Trigger>
              <Tabs.Trigger value="tools">Ferramentas</Tabs.Trigger>
              <Tabs.Trigger value="flow">Fluxo</Tabs.Trigger>
            </Tabs.List>
            <div className="tab-scroll">
              <Tabs.Content value="profile" className="tab-pane">
                <div className="form-row">
                  <Field label="Nome"><input value={draft.name} maxLength={40} onChange={e => update({ name: e.target.value })} /></Field>
                  <Field label="Função"><input value={draft.role} maxLength={50} onChange={e => update({ role: e.target.value })} /></Field>
                </div>
                <Field label="Descrição"><textarea rows={3} value={draft.description} onChange={e => update({ description: e.target.value })} /></Field>
                <div className="field">
                  <span>Área e estação</span>
                  <div className="segmented" role="radiogroup" aria-label="Área">
                    {WORK_ZONES.map(z => (
                      <button key={z} type="button" role="radio" aria-checked={draft.zone === z} className={`seg zone-${z}`} disabled={draft.zone !== z && zoneUsed(z) >= zoneCapacity(z)} onClick={() => update({ zone: z })}>
                        {ZONE_LABEL[z]}<small>{zoneUsed(z) + (draft.zone === z ? 1 : 0)}/{zoneCapacity(z)}</small>
                      </button>
                    ))}
                  </div>
                  {agent && draft.zone !== agent.zone && <small>Ao salvar, o personagem muda para uma estação livre em {ZONE_LABEL[draft.zone]}.</small>}
                </div>
                <div className="form-row">
                  <Field label="Provedor planejado">
                    <select value={String(draft.model)} onChange={e => update({ model: e.target.value })}>
                      {PROVIDERS.map(p => <option key={p}>{p}</option>)}
                      {!PROVIDERS.includes(draft.model as (typeof PROVIDERS)[number]) && <option>{String(draft.model)}</option>}
                    </select>
                  </Field>
                  <Field label="Modelo planejado"><input value={draft.modelName} maxLength={60} placeholder="Ex.: claude-sonnet-5" onChange={e => update({ modelName: e.target.value })} /></Field>
                </div>
                <p className="form-note">Provedor e modelo são apenas planejamento. Nenhuma API é chamada pelo navegador; credenciais ficarão no servidor quando o motor for conectado.</p>
              </Tabs.Content>
              <Tabs.Content value="look" className="tab-pane">
                <AppearanceEditor look={draft.look} color={draft.color} onLook={look => update({ look })} onColor={color => update({ color })} />
              </Tabs.Content>
              <Tabs.Content value="instructions" className="tab-pane">
                <Field label="Instruções principais" hint="Comportamento, critérios de qualidade e forma de comunicação."><textarea rows={7} value={draft.instructions} onChange={e => update({ instructions: e.target.value })} /></Field>
                <Field label="Limites e restrições" hint="O que este funcionário nunca deve fazer."><textarea rows={4} value={draft.limits} onChange={e => update({ limits: e.target.value })} /></Field>
                <Field label="Formato de entrega" hint="Como o resultado deve chegar para você ou para o próximo da fila."><textarea rows={3} value={draft.deliverable} onChange={e => update({ deliverable: e.target.value })} /></Field>
              </Tabs.Content>
              <Tabs.Content value="tools" className="tab-pane">
                <p className="pane-intro">Capacidades planejadas para quando a execução for conectada.</p>
                <div className="tool-list">
                  {TOOL_INFO.map(t => (
                    <label className="tool-row" key={t.key}>
                      <span><b>{t.label}</b><small>{t.description}</small></span>
                      <Switch checked={draft.tools[t.key]} onCheckedChange={v => update({ tools: { ...draft.tools, [t.key]: v } })} aria-label={`Permitir ${t.label}`} />
                    </label>
                  ))}
                </div>
                <div className="field">
                  <span>Orçamento estimado de tokens por tarefa</span>
                  <div className="budget">
                    <input type="range" min={1000} max={200000} step={1000} value={Math.min(200000, draft.budget)} onChange={e => update({ budget: Number(e.target.value) })} aria-label="Orçamento de tokens" />
                    <input type="number" min={1000} max={1000000} step={1000} value={draft.budget} onChange={e => update({ budget: Number(e.target.value) })} aria-label="Orçamento de tokens (número)" />
                  </div>
                  <div className="chips">{BUDGET_PRESETS.map(b => <button type="button" key={b} className="chip" aria-pressed={draft.budget === b} onClick={() => update({ budget: b })}>{fmt(b / 1000)}k</button>)}</div>
                  <small>Limite a ser aplicado pelo motor de execução (entre 1.000 e 1.000.000).</small>
                </div>
              </Tabs.Content>
              <Tabs.Content value="flow" className="tab-pane">
                <div className="field">
                  <span>Encaminhar o trabalho para</span>
                  <div className="handoff-list">
                    {others.map(o => {
                      const on = draft.handoffTo.includes(o.id);
                      return (
                        <label key={o.id} className={`handoff ${on ? "is-on" : ""}`}>
                          <input type="checkbox" checked={on} onChange={e => update({ handoffTo: e.target.checked ? [...draft.handoffTo, o.id] : draft.handoffTo.filter(x => x !== o.id) })} />
                          <Avatar look={o.look} color={o.color} size={30} />
                          <span><b>{o.name}</b><small>{o.role}</small></span>
                        </label>
                      );
                    })}
                  </div>
                </div>
                <Field label="Regras de encaminhamento" hint="Quando encaminhar, o que anexar, quando voltar ao Diretor."><textarea rows={3} value={draft.handoff} onChange={e => update({ handoff: e.target.value })} /></Field>
                <div className="flow-preview">
                  <span className="eyebrow">FLUXO PREVISTO</span>
                  <div className="flow-chain">
                    <span className="flow-node" style={{ "--accent": draft.color } as React.CSSProperties}>{draft.name || "?"}</span>
                    <ArrowRight size={14} />
                    {draft.handoffTo.length ? draft.handoffTo.map(id => { const t = agents.find(a => a.id === id); return t ? <span key={id} className="flow-node" style={{ "--accent": t.color } as React.CSSProperties}>{t.name}</span> : null; }) : <span className="flow-empty">sem encaminhamento</span>}
                  </div>
                  <small>A delegação automática será implementada junto com o motor de agentes.</small>
                </div>
              </Tabs.Content>
            </div>
          </Tabs.Root>
          {error && <p className="form-error sheet-error" role="alert">{error}</p>}
          <footer className="sheet-actions">
            {draft.custom && <button className="icon-btn danger" onClick={onAskRemove} aria-label="Dispensar funcionário" title="Dispensar funcionário"><Trash2 size={16} /></button>}
            <span className={`dirty ${dirty ? "is-dirty" : ""}`}>{dirty ? "Alterações não salvas" : "Tudo salvo"}</span>
            <button className="btn-secondary" onClick={() => onDemand(draft.id)}><Send size={15} /> Demanda</button>
            <button className="btn-primary" onClick={save} disabled={!dirty}><Check size={16} /> Salvar</button>
          </footer>
    </>
  );
}

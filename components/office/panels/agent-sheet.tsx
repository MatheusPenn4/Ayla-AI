"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Tabs } from "radix-ui";
import { ArrowRight, Check, Copy, CornerDownLeft, GitCompare, Send, Sparkles, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Switch } from "@/components/ui/switch";
import { Avatar } from "../avatar";
import { AppearanceEditor } from "./appearance-editor";
import { AutoTextarea } from "./auto-textarea";
import { Field } from "./field";
import { PresetCompareDialog } from "./preset-compare-dialog";
import { TOOL_INFO, ZONE_LABEL } from "@/lib/office/defaults";
import { connectionLabel } from "@/lib/engine/connections";
import { ConnectionPanel, type EngineControls } from "./connection-panel";
import { WORK_ZONES, zoneCapacity } from "@/lib/office/layout";
import { PRESET_VERSION } from "@/lib/office/presets";
import { TARGET_LABEL_USER, applyPreset, dismissPreset, presetProfile, presetUpdate } from "@/lib/office/profile";
import { agentBrief } from "@/lib/integration/contracts";
import type { Agent, Playbook } from "@/lib/office/types";
import { USER_TARGET } from "@/lib/office/types";

const BUDGET_PRESETS = [8000, 12000, 16000, 24000, 32000, 48000, 96000];
const fmt = (n: number) => n.toLocaleString("pt-BR");

const PLAYBOOK_FIELDS: { key: keyof Playbook; label: string; hint: string; rows: number }[] = [
  { key: "mission", label: "Missão", hint: "Pelo que este colaborador responde, em uma ou duas frases.", rows: 2 },
  { key: "inputs", label: "Insumos necessários", hint: "O que precisa receber antes de começar.", rows: 3 },
  { key: "method", label: "Método de trabalho", hint: "Passos na ordem em que devem acontecer.", rows: 6 },
  { key: "quality", label: "Critérios de qualidade", hint: "Como saber, de forma verificável, que a entrega está boa.", rows: 3 },
  { key: "clarify", label: "Quando pedir esclarecimento", hint: "Situações em que deve parar e perguntar, e a quem.", rows: 3 },
  { key: "evidence", label: "Como apresentar evidências", hint: "O que precisa acompanhar cada afirmação.", rows: 3 },
];

type Props = {
  open: boolean;
  agent: Agent | null;
  agents: Agent[];
  onClose: () => void;
  onSave: (draft: Agent) => string | null;
  onDemand: (id: string) => void;
  onRemove: (id: string) => void;
  /** Persists "keep my current sheet" for the newest preset version. */
  onDismissPreset: (id: string) => void;
  tab: string;
  onTab: (t: string) => void;
  /** Opens the comparison dialog right away (used from the team screen). */
  compareOnOpen?: boolean;
  /** Live preview of unsaved edits in the 3D office (null when closed). */
  onDraft?: (draft: Agent | null) => void;
  /** Connection status and actions from the local executor. */
  engine?: EngineControls;
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

function TargetPicker({ label, hint, value, options, onChange, includeUser }: {
  label: string;
  hint: string;
  value: string[];
  options: Agent[];
  onChange: (v: string[]) => void;
  includeUser?: boolean;
}) {
  const toggle = (id: string, on: boolean) => onChange(on ? [...value, id] : value.filter(x => x !== id));
  return (
    <div className="field">
      <span>{label}</span>
      <div className="handoff-list">
        {includeUser && (
          <label className={`handoff ${value.includes(USER_TARGET) ? "is-on" : ""}`}>
            <input type="checkbox" checked={value.includes(USER_TARGET)} onChange={e => toggle(USER_TARGET, e.target.checked)} />
            <span className="user-dot" aria-hidden>?</span>
            <span><b>{TARGET_LABEL_USER}</b><small>quem criou a demanda</small></span>
          </label>
        )}
        {options.map(o => {
          const on = value.includes(o.id);
          return (
            <label key={o.id} className={`handoff ${on ? "is-on" : ""}`}>
              <input type="checkbox" checked={on} onChange={e => toggle(o.id, e.target.checked)} />
              <Avatar look={o.look} color={o.color} size={30} />
              <span><b>{o.name}</b><small>{o.role}</small></span>
            </label>
          );
        })}
      </div>
      <small>{hint}</small>
    </div>
  );
}

function SheetBody({ agent, agents, onSave, onDemand, onDismissPreset, tab, onTab, compareOnOpen, onDraft, engine, dirtyRef, onSaved, requestClose, onAskRemove }: Props & {
  agent: Agent;
  dirtyRef: React.RefObject<boolean>;
  onSaved: () => void;
  requestClose: () => void;
  onAskRemove: () => void;
}) {
  const [draft, setDraft] = useState<Agent>(() => structuredClone(agent));
  const [error, setError] = useState("");
  const [comparing, setComparing] = useState(!!compareOnOpen && !!presetProfile(agent.preset.id));
  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(agent), [draft, agent]);
  useEffect(() => { dirtyRef.current = dirty; }, [dirty, dirtyRef]);
  useEffect(() => { onDraft?.(draft); return () => onDraft?.(null); }, [draft, onDraft]);
  const update = (part: Partial<Agent>) => setDraft(d => ({ ...d, ...part }));
  const updatePlaybook = (key: keyof Playbook, v: string) => setDraft(d => ({ ...d, playbook: { ...d.playbook, [key]: v } }));
  const save = () => {
    const err = onSave(draft);
    setError(err ?? "");
    if (!err) onSaved();
  };
  const others = agents.filter(a => a.id !== draft.id);
  const zoneUsed = (z: string) => agents.filter(a => a.zone === z && a.id !== draft.id).length;
  const update_ = presetUpdate(draft);
  const hasPreset = !!presetProfile(draft.preset.id);
  const brief = useMemo(() => agentBrief(draft, agents), [draft, agents]);
  const plannedTools = Object.values(draft.tools).filter(Boolean).length;
  const name = (id: string) => (id === USER_TARGET ? TARGET_LABEL_USER : agents.find(a => a.id === id)?.name ?? id);

  const keepCurrent = () => {
    setDraft(d => dismissPreset(d));
    onDismissPreset(draft.id);
    toast.success("Ficha mantida. Você pode comparar com o padrão a qualquer momento na aba Instruções.");
  };

  return (
    <>
      <header className="sheet-hero" style={{ "--accent": draft.color } as React.CSSProperties}>
        <button className="icon-btn sheet-close" onClick={requestClose} aria-label="Fechar ficha"><X size={18} /></button>
        <Avatar look={draft.look} color={draft.color} size={76} className="sheet-portrait" />
        <div className="sheet-id">
          <span className="eyebrow">FICHA DO COLABORADOR · {ZONE_LABEL[draft.zone].toUpperCase()}</span>
          <SheetTitle className="sheet-title">{draft.name || "Sem nome"}</SheetTitle>
          <SheetDescription className="sheet-sub">{draft.role || "Sem função"} · {connectionLabel(draft.connection)}{draft.modelName ? ` / ${draft.modelName}` : ""}</SheetDescription>
        </div>
        <dl className="sheet-stats">
          <div><dt>Permissões planejadas</dt><dd>{plannedTools}/{TOOL_INFO.length}</dd></div>
          <div><dt>Orçamento (tokens)</dt><dd>{fmt(draft.budget)}</dd></div>
          <div><dt>Encaminha</dt><dd>{draft.handoffTo.length}</dd></div>
          <div><dt>Devolve</dt><dd>{draft.returnTo.length}</dd></div>
        </dl>
      </header>
      {update_ && !update_.dismissed && (
        <div className="preset-banner" role="status">
          <Sparkles size={16} aria-hidden />
          <p><b>Novas instruções padrão disponíveis (versão {update_.to}).</b> Nada muda sem sua confirmação: compare campo a campo e aplique só o que quiser.</p>
          <button className="btn-secondary" onClick={() => setComparing(true)}><GitCompare size={14} /> Comparar</button>
          <button className="btn-ghost" onClick={keepCurrent}>Manter a ficha atual</button>
        </div>
      )}
      <Tabs.Root value={tab} onValueChange={onTab} className="sheet-tabs">
        <Tabs.List className="tab-list" aria-label="Seções da ficha">
          <Tabs.Trigger value="profile">Perfil</Tabs.Trigger>
          <Tabs.Trigger value="look">Visual</Tabs.Trigger>
          <Tabs.Trigger value="instructions">Instruções</Tabs.Trigger>
          <Tabs.Trigger value="limits">Limites</Tabs.Trigger>
          <Tabs.Trigger value="tools">Ferramentas</Tabs.Trigger>
          <Tabs.Trigger value="flow">Fluxo</Tabs.Trigger>
          <Tabs.Trigger value="brief">Prévia</Tabs.Trigger>
        </Tabs.List>
        <div className="tab-scroll">
          <Tabs.Content value="profile" className="tab-pane">
            <div className="form-row">
              <Field label="Nome"><input value={draft.name} maxLength={40} onChange={e => update({ name: e.target.value })} /></Field>
              <Field label="Função"><input value={draft.role} maxLength={50} onChange={e => update({ role: e.target.value })} /></Field>
            </div>
            <Field label="Especialidade" hint="Uma frase que diferencie este colaborador dos demais."><AutoTextarea minRows={2} value={draft.description} onChange={v => update({ description: v })} /></Field>
            <div className="field">
              <span>Área e estação</span>
              <div className="segmented" role="radiogroup" aria-label="Área">
                {WORK_ZONES.map(z => (
                  <button key={z} type="button" role="radio" aria-checked={draft.zone === z} className={`seg zone-${z}`} disabled={draft.zone !== z && zoneUsed(z) >= zoneCapacity(z)} onClick={() => update({ zone: z })}>
                    {ZONE_LABEL[z]}<small>{zoneUsed(z) + (draft.zone === z ? 1 : 0)}/{zoneCapacity(z)}</small>
                  </button>
                ))}
              </div>
              {draft.zone !== agent.zone && <small>Ao salvar, o personagem muda para uma estação livre em {ZONE_LABEL[draft.zone]}.</small>}
            </div>
            <ConnectionPanel
              connection={draft.connection} modelName={draft.modelName} effort={draft.effort} legacyProvider={String(draft.model)}
              executable={(engine?.status?.executableAgents ?? ["director"]).includes(draft.id) ? "starts" : (engine?.status?.handoffTargets ?? ["architect"]).includes(draft.id) ? "handoff" : "none"}
              engine={engine}
              onChange={part => update(part)}
            />
          </Tabs.Content>

          <Tabs.Content value="look" className="tab-pane">
            <AppearanceEditor look={draft.look} color={draft.color} onLook={look => update({ look })} onColor={color => update({ color })} />
          </Tabs.Content>

          <Tabs.Content value="instructions" className="tab-pane">
            <div className="pane-head">
              <p className="pane-intro">Procedimento de trabalho. As instruções deste colaborador são montadas somente a partir destes campos (veja a aba Prévia).</p>
              {hasPreset && <button type="button" className="btn-ghost" onClick={() => setComparing(true)}><GitCompare size={14} /> Comparar com padrão</button>}
            </div>
            {PLAYBOOK_FIELDS.map((f, i) => (
              <div key={f.key} className="section-card">
                <label className="section-label" htmlFor={`pb-${f.key}`}><i>{String(i + 1).padStart(2, "0")}</i>{f.label}<small>{draft.playbook[f.key].length} caracteres</small></label>
                <p className="section-hint">{f.hint}</p>
                <AutoTextarea id={`pb-${f.key}`} minRows={f.rows} value={draft.playbook[f.key]} onChange={v => updatePlaybook(f.key, v)} />
              </div>
            ))}
            <div className="section-card muted">
              <label className="section-label" htmlFor="pb-extra"><i>+</i>Instruções complementares<small>opcional</small></label>
              <p className="section-hint">Texto livre adicional. Instruções de versões anteriores da ficha ficam preservadas aqui.</p>
              <AutoTextarea id="pb-extra" minRows={3} value={draft.instructions} onChange={v => update({ instructions: v })} />
            </div>
          </Tabs.Content>

          <Tabs.Content value="limits" className="tab-pane">
            <div className="section-card">
              <label className="section-label" htmlFor="lim"><i>!</i>Limites e restrições</label>
              <p className="section-hint">O que este colaborador nunca deve fazer. Uma regra por linha.</p>
              <AutoTextarea id="lim" minRows={5} value={draft.limits} onChange={v => update({ limits: v })} />
            </div>
            <div className="section-card">
              <label className="section-label" htmlFor="deliv"><i>→</i>Formato de entrega</label>
              <p className="section-hint">Estrutura do resultado que chega ao próximo colaborador ou ao usuário.</p>
              <AutoTextarea id="deliv" minRows={4} value={draft.deliverable} onChange={v => update({ deliverable: v })} />
            </div>
          </Tabs.Content>

          <Tabs.Content value="tools" className="tab-pane">
            <div className="notice">Permissões <b>planejadas</b> para as próximas etapas. Nesta fase só uma tem efeito real: <b>GitHub</b> na ficha do Diretor autoriza a leitura limitada de repositórios <b>públicos</b> durante o planejamento. Nas execuções, as ferramentas dos clientes oficiais (terminal, edição, navegador, busca) ficam sempre desligadas.</div>
            <div className="tool-list">
              {TOOL_INFO.map(t => (
                <label className="tool-row" key={t.key}>
                  <span><b>{t.label}</b><small>{t.description}</small></span>
                  <em className="tool-state">{draft.tools[t.key] ? "planejada" : "não planejada"} · {t.key === "github" && draft.id === "director" ? "aplicada ao planejamento (só leitura pública)" : "não conectada"}</em>
                  <Switch checked={draft.tools[t.key]} onCheckedChange={v => update({ tools: { ...draft.tools, [t.key]: v } })} aria-label={`Planejar permissão: ${t.label}`} />
                </label>
              ))}
            </div>
            <div className="field">
              <span>Orçamento de tokens por execução (limite do Setor IA)</span>
              <div className="budget">
                <input type="range" min={1000} max={200000} step={1000} value={Math.min(200000, draft.budget)} onChange={e => update({ budget: Number(e.target.value) })} aria-label="Orçamento de tokens" />
                <input type="number" min={1000} max={1000000} step={1000} value={draft.budget} onChange={e => update({ budget: Number(e.target.value) })} aria-label="Orçamento de tokens (número)" />
              </div>
              <div className="chips">{BUDGET_PRESETS.map(b => <button type="button" key={b} className="chip" aria-pressed={draft.budget === b} onClick={() => update({ budget: b })}>{fmt(b / 1000)}k</button>)}</div>
              <small>Não é o limite da sua assinatura. Antes de chamar o cliente, o executor estima o texto enviado e não chama se passar deste valor; depois compara com o uso que o cliente informar. O cliente não pode ser interrompido no meio de uma resposta, então o uso real pode passar um pouco, e isso fica registrado (entre 1.000 e 1.000.000).</small>
            </div>
          </Tabs.Content>

          <Tabs.Content value="flow" className="tab-pane">
            <TargetPicker label="Encaminha para" hint="Quem recebe o trabalho quando esta etapa termina. As regras abaixo dizem quando usar cada um." value={draft.handoffTo} options={others} onChange={v => update({ handoffTo: v })} />
            <TargetPicker label="Devolve pendências para" hint="Quem recebe uma falha, bloqueio ou pergunta vinda desta etapa." value={draft.returnTo} options={others} onChange={v => update({ returnTo: v })} includeUser />
            <Field label="Máximo de devoluções por demanda" hint="Impede ciclos sem fim: ao atingir o limite, a demanda sobe para quem decide (normalmente o Diretor). Em branco = não definido.">
              <input type="number" min={1} max={10} step={1} value={draft.maxCycles ?? ""} placeholder="não definido" onChange={e => update({ maxCycles: e.target.value === "" ? null : Number(e.target.value) })} className="short-input" />
            </Field>
            <div className="section-card">
              <label className="section-label" htmlFor="rules"><i>⇄</i>Regras de encaminhamento</label>
              <p className="section-hint">Quando encaminhar, quando dispensar uma etapa, quando devolver e o que anexar.</p>
              <AutoTextarea id="rules" minRows={4} value={draft.handoff} onChange={v => update({ handoff: v })} />
            </div>
            <div className="flow-preview">
              <span className="eyebrow">FLUXO PREVISTO</span>
              <div className="flow-chain">
                <span className="flow-node" style={{ "--accent": draft.color } as React.CSSProperties}>{draft.name || "?"}</span>
                <ArrowRight size={14} aria-label="encaminha para" />
                {draft.handoffTo.length ? draft.handoffTo.map(id => { const t = agents.find(a => a.id === id); return t ? <span key={id} className="flow-node" style={{ "--accent": t.color } as React.CSSProperties}>{t.name}</span> : null; }) : <span className="flow-empty">sem encaminhamento</span>}
              </div>
              <div className="flow-chain">
                <span className="flow-node" style={{ "--accent": draft.color } as React.CSSProperties}>{draft.name || "?"}</span>
                <CornerDownLeft size={14} aria-label="devolve para" />
                {draft.returnTo.length ? draft.returnTo.map(id => <span key={id} className="flow-node ghost">{name(id)}</span>) : <span className="flow-empty">sem destino para pendências</span>}
                {draft.maxCycles !== null && <span className="flow-empty">· até {draft.maxCycles}×</span>}
              </div>
              <small>Nesta fase o Diretor apenas propõe tarefas para estes colaboradores; nada é delegado nem executado automaticamente.</small>
            </div>
          </Tabs.Content>

          <Tabs.Content value="brief" className="tab-pane">
            <div className="pane-head">
              <p className="pane-intro">É isto que o executor envia desta ficha, montado apenas a partir dos campos salvos. Na execução do Diretor, ela vai junto do protocolo da fase, que aparece na aba “Entrada” da execução. Não existe outro prompt escondido.</p>
              <button type="button" className="btn-ghost" onClick={() => { navigator.clipboard?.writeText(brief).then(() => toast.success("Prévia copiada."), () => toast.error("Não foi possível copiar.")); }}><Copy size={14} /> Copiar</button>
            </div>
            <pre className="brief">{brief}</pre>
            {dirty && <small className="brief-note">A prévia inclui alterações ainda não salvas.</small>}
          </Tabs.Content>
        </div>
      </Tabs.Root>
      {error && <p className="form-error sheet-error" role="alert">{error}</p>}
      <footer className="sheet-actions">
        {draft.custom && <button className="icon-btn danger" onClick={onAskRemove} aria-label="Dispensar colaborador" title="Dispensar colaborador"><Trash2 size={16} /></button>}
        <span className={`dirty ${dirty ? "is-dirty" : ""}`}>{dirty ? "Alterações não salvas" : "Tudo salvo"}</span>
        <button className="btn-secondary" onClick={() => onDemand(draft.id)}><Send size={15} /> Demanda</button>
        <button className="btn-primary" onClick={save} disabled={!dirty}><Check size={16} /> Salvar</button>
      </footer>
      {hasPreset && (
        <PresetCompareDialog
          open={comparing}
          agent={draft}
          team={agents}
          onCancel={() => setComparing(false)}
          onApply={keys => {
            setDraft(d => applyPreset(d, keys, agents.map(a => a.id)));
            setComparing(false);
            toast.success(`${keys.length} ${keys.length === 1 ? "campo aplicado" : "campos aplicados"} ao rascunho (padrão v${PRESET_VERSION}). Revise e clique em Salvar.`);
          }}
        />
      )}
    </>
  );
}

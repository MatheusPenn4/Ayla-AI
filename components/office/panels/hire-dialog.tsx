"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AppearanceEditor } from "./appearance-editor";
import { Field } from "./field";
import { TOOL_INFO, ZONE_LABEL, lookFromSeed, newId } from "@/lib/office/defaults";
import { HIRE_TEMPLATES } from "@/lib/office/presets";
import { WORK_ZONES, zoneCapacity } from "@/lib/office/layout";
import type { Agent, WorkZoneId } from "@/lib/office/types";
import type { NewWorkerInput } from "@/hooks/use-office";

const blank = (zone: WorkZoneId) => ({ name: "", role: "", description: "", color: "#5fb7d9", zone, look: lookFromSeed(newId()), templateId: null as string | null });

function HireForm({ onOpenChange, agents, presetZone, presetStation, onCreate }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  agents: Agent[];
  presetZone: WorkZoneId;
  presetStation?: string;
  onCreate: (input: NewWorkerInput) => string | null;
}) {
  const [form, setForm] = useState(() => blank(presetZone));
  const [error, setError] = useState("");
  const used = (z: WorkZoneId) => agents.filter(a => a.zone === z).length;
  const full = used(form.zone) >= zoneCapacity(form.zone);
  const tpl = HIRE_TEMPLATES.find(t => t.id === form.templateId) ?? null;

  const submit = () => {
    if (!form.name.trim() || !form.role.trim()) { setError("Preencha nome e função."); return; }
    const err = onCreate({ ...form, stationId: form.zone === presetZone ? presetStation : undefined });
    if (err) setError(err);
  };

  return (
    <>
        <DialogHeader>
          <span className="eyebrow">EQUIPE / CONTRATAÇÃO</span>
          <DialogTitle>Contratar funcionário</DialogTitle>
          <DialogDescription>Crie um personagem, escolha a área e ele ocupará uma estação livre no escritório.</DialogDescription>
        </DialogHeader>
        <div className="dialog-scroll">
          <div className="templates" role="radiogroup" aria-label="Modelos rápidos">
            {HIRE_TEMPLATES.map(t => (
              <button key={t.id} type="button" role="radio" aria-checked={form.templateId === t.id} className="template" onClick={() => setForm(f => ({ ...f, templateId: t.id, name: f.name || t.label, role: t.role, description: t.profile.description, zone: t.zone, color: t.color, look: { ...f.look, ...t.look } }))}>
                <b>{t.label}</b><small>{ZONE_LABEL[t.zone]}</small>
              </button>
            ))}
            <button type="button" role="radio" aria-checked={form.templateId === null} className="template" onClick={() => setForm(f => ({ ...f, templateId: null }))}>
              <b>Sem modelo</b><small>ficha em branco</small>
            </button>
          </div>
          <p className="form-note">
            {tpl
              ? <>O modelo <b>{tpl.label}</b> inclui uma ficha inicial: missão, método, critérios, limites, entregável, permissões planejadas ({TOOL_INFO.filter(t => tpl.profile.tools[t.key]).map(t => t.label).join(", ")}), orçamento de {tpl.profile.budget.toLocaleString("pt-BR")} tokens e encaminhamentos. Tudo pode ser editado na ficha depois.</>
              : <>Sem modelo, o colaborador começa com a ficha em branco (apenas leitura de arquivos planejada) e encaminha ao Diretor. Configure tudo na ficha depois da contratação.</>}
          </p>
          <div className="form-row">
            <Field label="Nome"><input autoFocus value={form.name} maxLength={40} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Ex.: Ana, Analista de dados" /></Field>
            <Field label="Função"><input value={form.role} maxLength={50} onChange={e => setForm(f => ({ ...f, role: e.target.value }))} placeholder="Ex.: Banco de dados" /></Field>
          </div>
          <Field label="Especialidade"><textarea rows={2} value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder="Resumo das responsabilidades" /></Field>
          <div className="field">
            <span>Área de trabalho</span>
            <div className="segmented" role="radiogroup" aria-label="Área de trabalho">
              {WORK_ZONES.map(z => {
                const n = used(z), cap = zoneCapacity(z);
                return (
                  <button key={z} type="button" role="radio" aria-checked={form.zone === z} className={`seg zone-${z}`} disabled={n >= cap} onClick={() => setForm(f => ({ ...f, zone: z }))}>
                    {ZONE_LABEL[z]}<small>{n}/{cap} estações</small>
                  </button>
                );
              })}
            </div>
          </div>
          <AppearanceEditor compact look={form.look} color={form.color} onLook={look => setForm(f => ({ ...f, look }))} onColor={color => setForm(f => ({ ...f, color }))} />
          {error && <p className="form-error" role="alert">{error}</p>}
        </div>
        <div className="dialog-actions">
          <button className="btn-secondary" onClick={() => onOpenChange(false)}>Cancelar</button>
          <button className="btn-primary" onClick={submit} disabled={full}><Plus size={16} /> Contratar</button>
        </div>
    </>
  );
}

/** The form lives inside the dialog content, so it starts fresh every time the dialog opens. */
export function HireDialog(props: React.ComponentProps<typeof HireForm>) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="game-dialog hire-dialog">
        <HireForm {...props} />
      </DialogContent>
    </Dialog>
  );
}

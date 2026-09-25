"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AppearanceEditor } from "./appearance-editor";
import { Field } from "./field";
import { ZONE_LABEL, lookFromSeed, newId } from "@/lib/office/defaults";
import { WORK_ZONES, zoneCapacity } from "@/lib/office/layout";
import type { Agent, Appearance, WorkZoneId } from "@/lib/office/types";
import type { NewWorkerInput } from "@/hooks/use-office";

const TEMPLATES: { label: string; role: string; description: string; zone: WorkZoneId; color: string; look: Partial<Appearance> }[] = [
  { label: "Front-end", role: "Interfaces e acessibilidade", description: "Implementa telas, estados e acessibilidade seguindo o design do projeto.", zone: "dev", color: "#e86f8f", look: { hair: "ponytail", outfit: "tee", accessory: "glasses" } },
  { label: "Back-end", role: "APIs e dados", description: "Cuida de rotas, contratos, banco de dados e desempenho do servidor.", zone: "dev", color: "#5fb7d9", look: { hair: "short", outfit: "hoodie", accessory: "headphones" } },
  { label: "DevOps", role: "Infraestrutura e CI", description: "Mantém pipelines, ambientes e observabilidade.", zone: "dev", color: "#7fcf6a", look: { hair: "mohawk", outfit: "vest", accessory: "beanie" } },
  { label: "Testes E2E", role: "Automação de testes", description: "Escreve e mantém testes ponta a ponta com evidências.", zone: "qa", color: "#c07ce0", look: { hair: "curly", outfit: "labcoat", accessory: "none" } },
];

const blank = (zone: WorkZoneId) => ({ name: "", role: "", description: "", color: "#5fb7d9", zone, look: lookFromSeed(newId()) });

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
          <div className="templates" aria-label="Modelos rápidos">
            {TEMPLATES.map(t => (
              <button key={t.label} type="button" className="template" onClick={() => setForm(f => ({ ...f, name: f.name || t.label, role: t.role, description: t.description, zone: t.zone, color: t.color, look: { ...f.look, ...t.look } }))}>
                <b>{t.label}</b><small>{ZONE_LABEL[t.zone]}</small>
              </button>
            ))}
          </div>
          <div className="form-row">
            <Field label="Nome"><input autoFocus value={form.name} maxLength={40} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Ex.: Ana, Analista de dados" /></Field>
            <Field label="Função"><input value={form.role} maxLength={50} onChange={e => setForm(f => ({ ...f, role: e.target.value }))} placeholder="Ex.: Banco de dados" /></Field>
          </div>
          <Field label="O que faz"><textarea rows={2} value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder="Resumo das responsabilidades" /></Field>
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

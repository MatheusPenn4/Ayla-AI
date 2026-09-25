"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { DEFAULT_AGENTS, newId } from "@/lib/office/defaults";
import { dismissPreset as dismissPresetOf, filterTargets, profileForHire } from "@/lib/office/profile";
import { STATION_BY_ID, freeStation } from "@/lib/office/layout";
import { STORAGE_V2, assignStations, loadOffice, saveOffice } from "@/lib/office/storage";
import type { Agent, Appearance, Demand, WorkZoneId } from "@/lib/office/types";

/** templateId: hire template whose profile is copied into the new collaborator (null = start from scratch). */
export type NewWorkerInput = { name: string; role: string; description: string; color: string; zone: WorkZoneId; look: Appearance; stationId?: string; templateId?: string | null };
type Result = { ok: true; id: string } | { ok: false; error: string };

export function useOffice() {
  const [agents, setAgents] = useState<Agent[]>(() => assignStations(DEFAULT_AGENTS));
  const [demands, setDemands] = useState<Demand[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [migratedFrom, setMigratedFrom] = useState<number | null>(null);
  const skipSave = useRef(false);

  // localStorage only exists in the browser, so the saved office is loaded right
  // after hydration (the server render uses the defaults).
  useEffect(() => {
    const d = loadOffice();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAgents(d.agents);
    setDemands(d.demands);
    setMigratedFrom(d.migratedFrom ?? null);
    setHydrated(true);
    // Keep several tabs consistent.
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_V2 || !e.newValue) return;
      const next = loadOffice();
      skipSave.current = true;
      setAgents(next.agents);
      setDemands(next.demands);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    if (skipSave.current) { skipSave.current = false; return; }
    try { saveOffice({ agents, demands }); } catch { toast.error("Não foi possível salvar neste navegador (armazenamento cheio ou bloqueado).", { id: "save-error" }); }
  }, [agents, demands, hydrated]);

  const saveAgent = useCallback((draft: Agent): Result => {
    const name = draft.name.trim(), role = draft.role.trim();
    if (!name || !role) return { ok: false, error: "Preencha nome e função." };
    if (!Number.isFinite(draft.budget) || draft.budget < 1000 || draft.budget > 1_000_000) return { ok: false, error: "O orçamento deve ficar entre 1.000 e 1.000.000 tokens." };
    if (draft.maxCycles !== null && (!Number.isInteger(draft.maxCycles) || draft.maxCycles < 1 || draft.maxCycles > 10)) return { ok: false, error: "O máximo de devoluções deve ser um número inteiro entre 1 e 10 (ou ficar em branco)." };
    const current = agents.find(a => a.id === draft.id);
    if (!current) return { ok: false, error: "Funcionário não encontrado." };
    let stationId = current.stationId;
    if (draft.zone !== current.zone) {
      const free = freeStation(draft.zone, agents.filter(a => a.id !== draft.id).map(a => a.stationId));
      if (!free) return { ok: false, error: "Não há estação livre nessa área." };
      stationId = free;
    }
    const ids = agents.map(a => a.id);
    setAgents(list => list.map(a => (a.id === draft.id ? { ...draft, name, role, stationId, handoffTo: filterTargets(draft.handoffTo, ids, draft.id).filter(t => t !== "user"), returnTo: filterTargets(draft.returnTo, ids, draft.id) } : a)));
    return { ok: true, id: draft.id };
  }, [agents]);

  const addAgent = useCallback((input: NewWorkerInput): Result => {
    const name = input.name.trim(), role = input.role.trim();
    if (!name || !role) return { ok: false, error: "Preencha nome e função." };
    const taken = agents.map(a => a.stationId);
    const requested = input.stationId && STATION_BY_ID.get(input.stationId)?.zone === input.zone && !taken.includes(input.stationId) ? input.stationId : null;
    const stationId = requested ?? freeStation(input.zone, taken);
    if (!stationId) return { ok: false, error: "Todas as estações desta área estão ocupadas. Escolha outra área." };
    const id = newId();
    const profile = profileForHire(input.templateId ?? null, agents.map(a => a.id));
    const agent: Agent = {
      ...profile,
      id, name, role, color: input.color, description: input.description.trim() || profile.description || `Especialista em ${role}.`,
      model: "A definir", modelName: "", custom: true, zone: input.zone, stationId, look: input.look,
    };
    setAgents(list => [...list, agent]);
    return { ok: true, id };
  }, [agents]);

  const removeAgent = useCallback((id: string) => {
    setAgents(list => list.filter(a => a.id !== id || !a.custom).map(a => ({ ...a, handoffTo: a.handoffTo.filter(h => h !== id), returnTo: a.returnTo.filter(h => h !== id) })));
  }, []);

  /** "Keep my current sheet": stops suggesting the newest preset version for this collaborator. */
  const dismissPreset = useCallback((id: string) => {
    setAgents(list => list.map(a => (a.id === id ? dismissPresetOf(a) : a)));
  }, []);

  const addDemand = useCallback((d: Demand) => setDemands(list => [d, ...list]), []);
  const removeDemand = useCallback((id: string) => setDemands(list => list.filter(d => d.id !== id)), []);

  return { agents, demands, hydrated, migratedFrom, saveAgent, addAgent, removeAgent, dismissPreset, addDemand, removeDemand };
}

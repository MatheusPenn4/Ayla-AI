"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { ClipboardList, Download, Gauge, Home as HomeIcon, LayoutGrid, Menu, Minus, Plus, RotateCcw, RotateCw, Send, Users, UsersRound, X } from "lucide-react";
import { toast, Toaster } from "sonner";
import type { SceneControls } from "@/components/office/office-scene";
import { AgentSheet } from "@/components/office/panels/agent-sheet";
import { DemandDialog } from "@/components/office/panels/demand-dialog";
import { HireDialog } from "@/components/office/panels/hire-dialog";
import { CharacterCard, Roster } from "@/components/office/panels/roster";
import { DeveloperHandoffDialog } from "@/components/office/panels/developer-handoff-dialog";
import { HandoffDialog } from "@/components/office/panels/handoff-dialog";
import { RunDialog } from "@/components/office/panels/run-dialog";
import { DemandQueue, TeamScreen } from "@/components/office/panels/screens";
import { TIER_LABEL, type Tier } from "@/components/office/scene/quality";
import { useOffice } from "@/hooks/use-office";
import { useRuns } from "@/hooks/use-runs";
import { ZONE_LABEL } from "@/lib/office/defaults";
import { presetUpdate } from "@/lib/office/profile";
import { CAPACITY, STATION_BY_ID, ZONES } from "@/lib/office/layout";
import { loadPrefs, savePrefs, serializeOffice, type QualityPref } from "@/lib/office/storage";
import type { HandoffFollowUp } from "@/lib/engine/client";
import type { RunDetail } from "@/lib/engine/types";
import type { Agent, Demand, WorkZoneId, ZoneId } from "@/lib/office/types";

const OfficeScene = dynamic(() => import("@/components/office/office-scene"), {
  ssr: false,
  loading: () => <div className="scene-loading"><span className="loader-mark" aria-hidden /> Montando o escritório…</div>,
});

type Screen = "office" | "team" | "demands";
const JUMPS: ZoneId[] = ["director", "dev", "qa", "meeting"];

function useViewport() {
  const [w, setW] = useState(1366);
  useEffect(() => {
    const on = () => setW(window.innerWidth);
    on();
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return w;
}

export default function Home() {
  const office = useOffice();
  const { agents, demands } = office;
  const runs = useRuns(demands, office.hydrated);
  const [runId, setRunId] = useState<string | null>(null);
  // Prepared hand-off being reviewed (status awaiting_approval): Architect or Developer, kept apart.
  const [handoffId, setHandoffId] = useState<string | null>(null);
  const [devHandoffId, setDevHandoffId] = useState<string | null>(null);
  const vw = useViewport();
  const [screen, setScreen] = useState<Screen>("office");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [railOpen, setRailOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetTab, setSheetTab] = useState("profile");
  const [compareOnOpen, setCompareOnOpen] = useState(false);
  const [hire, setHire] = useState<{ open: boolean; zone: WorkZoneId; station?: string }>({ open: false, zone: "dev" });
  const [demandOpen, setDemandOpen] = useState(false);
  const [recipient, setRecipient] = useState("director");
  const [meeting, setMeeting] = useState(false);
  const [quality, setQuality] = useState<QualityPref>("auto");
  const [tier, setTier] = useState<{ tier: Tier; auto: boolean } | null>(null);
  const [preview, setPreview] = useState<Agent | null>(null);
  const [fallback, setFallback] = useState(false);
  const controls = useRef<SceneControls | null>(null);
  // Selection is derived: a removed worker simply stops being selected.
  const selected = agents.find(a => a.id === selectedId) ?? null;
  const selectedIdLive = selected?.id ?? null;

  // Preferences live in localStorage, which only exists after hydration.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setQuality(loadPrefs().quality); }, []);
  // One notice per session when newer default instructions exist for saved sheets.
  const updateNotice = useRef(false);
  useEffect(() => {
    if (!office.hydrated || updateNotice.current) return;
    const n = office.agents.filter(a => { const u = presetUpdate(a); return u && !u.dismissed; }).length;
    if (!n) return;
    updateNotice.current = true;
    toast.info(`Há novas instruções padrão para ${n} ${n === 1 ? "colaborador" : "colaboradores"}. Nada foi alterado.`, { action: { label: "Revisar", onClick: () => setScreen("team") }, duration: 9000 });
  }, [office.hydrated, office.agents]);
  useEffect(() => { if (office.migratedFrom === 1) toast.info("Configurações da versão anterior foram migradas. O registro antigo foi mantido como cópia de segurança."); }, [office.migratedFrom]);

  const plan = async (d: Demand) => {
    const r = await runs.start(d, agents);
    if (r.ok) toast.success("Planejamento enviado ao executor local.", { action: { label: "Ver", onClick: () => setRunId(r.run.id) } });
    else toast.error(r.error);
  };
  // Which review dialog to open depends on the run's kind (Architect vs. Developer).
  const openReview = (id: string) => {
    setRunId(null);
    const kind = runs.runs.find(r => r.id === id)?.kind;
    if (kind === "developer_task") setDevHandoffId(id); else setHandoffId(id);
  };
  const handoff = async (planRunId: string, taskId: string, followUp?: HandoffFollowUp) => {
    const r = await runs.prepareHandoff(planRunId, taskId, agents, followUp);
    // Known kind at this call site: set it directly (runs.runs may not have re-rendered with the new row yet).
    if (r.ok) { setRunId(null); setHandoffId(r.run.id); }
    else toast.error(r.error, { duration: 9000 });
  };
  const handoffDeveloper = async (planRunId: string, taskId: string) => {
    const r = await runs.prepareDeveloperHandoff(planRunId, taskId, agents);
    if (r.ok) { setRunId(null); setDevHandoffId(r.run.id); }
    else toast.error(r.error, { duration: 9000 });
  };
  const replan = async (run: RunDetail, answers?: { question: string; answer: string }[]) => {
    const d = demands.find(x => x.id === run.demandId);
    if (!d) { toast.error("A demanda desta execução não está mais na fila local."); return; }
    const r = await runs.start(d, agents, answers ? { previousRunId: run.id, answers } : undefined);
    if (r.ok) setRunId(r.run.id);
    else toast.error(r.error);
  };
  const demandCounts = useMemo(() => demands.reduce<Record<string, number>>((m, d) => ((m[d.recipient] = (m[d.recipient] ?? 0) + 1), m), {}), [demands]);
  const dashboard = useMemo(() => ({
    demandCount: demands.length,
    demands: demands.slice(0, 4).map(d => ({ title: d.title, recipient: agents.find(a => a.id === d.recipient)?.name ?? "—", priority: d.priority })),
    team: agents.map(a => ({ name: a.name, zone: ZONE_LABEL[a.zone], color: a.color })),
    meeting,
  }), [demands, agents, meeting]);

  // Unsaved sheet edits (name, colour, look) are previewed live on the 3D character.
  const sceneAgents = useMemo(() => (preview ? agents.map(a => (a.id === preview.id ? { ...a, name: preview.name || a.name, role: preview.role || a.role, color: preview.color, look: preview.look } : a)) : agents), [agents, preview]);
  const mobile = vw < 760;
  const cardOpen = !!selected && screen === "office";
  const sheetWidth = vw >= 1280 ? 680 : Math.min(600, vw);
  const insets = sheetOpen && !mobile ? { right: sheetWidth, bottom: 0 } : cardOpen ? (mobile ? { right: 0, bottom: 236 } : { right: 360, bottom: 0 }) : { right: 0, bottom: 0 };

  const nav = (s: Screen) => { setScreen(s); setRailOpen(false); };
  const select = (id: string) => { setSelectedId(id); setScreen("office"); setRailOpen(false); };
  const openSheet = (id: string, tab = "profile", compare = false) => { setSelectedId(id); setSheetTab(tab); setCompareOnOpen(compare); setSheetOpen(true); setRailOpen(false); };
  const openDemand = (id = "director") => { setRecipient(agents.some(a => a.id === id) ? id : "director"); setDemandOpen(true); setSheetOpen(false); setRailOpen(false); };
  const openHire = (zone: WorkZoneId = "dev", station?: string) => {
    if (agents.length >= CAPACITY) { toast.error(`O escritório comporta ${CAPACITY} funcionários. Dispense alguém para liberar uma estação.`); return; }
    setHire({ open: true, zone, station });
    setRailOpen(false);
  };
  const onStation = (stationId: string) => { const st = STATION_BY_ID.get(stationId); if (st) openHire(st.zone, stationId); };
  const setQualityPref = (q: QualityPref) => { setQuality(q); savePrefs({ quality: q }); };

  const exportData = () => {
    const blob = new Blob([JSON.stringify({ ...serializeOffice({ agents, demands }), exportedAt: new Date().toISOString() }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url; a.download = "setor-ia-configuracoes.json"; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  };

  const title = screen === "office" ? "Escritório" : screen === "team" ? "Funcionários" : "Fila de demandas";
  const overlayOpen = sheetOpen || hire.open || demandOpen;

  return (
    <div className="game-app">
      <a className="skip-link" href="#roster">Pular para a lista de funcionários</a>
      {railOpen && <button className="rail-scrim" aria-label="Fechar menu" onClick={() => setRailOpen(false)} />}
      <aside className={`side-rail ${railOpen ? "open" : ""}`} aria-label="Navegação">
        <div className="brand">
          <span className="brand-mark" aria-hidden>S<i>.</i></span>
          <span className="brand-copy"><b>SETOR IA</b><small>Estúdio de desenvolvimento</small></span>
          <button className="icon-btn rail-close" onClick={() => setRailOpen(false)} aria-label="Fechar menu"><X size={18} /></button>
        </div>
        <nav className="rail-nav">
          <button className={`rail-link ${screen === "office" ? "selected" : ""}`} aria-current={screen === "office" ? "page" : undefined} onClick={() => nav("office")}><LayoutGrid size={17} />Escritório</button>
          <button className={`rail-link ${screen === "team" ? "selected" : ""}`} aria-current={screen === "team" ? "page" : undefined} onClick={() => nav("team")}><Users size={17} />Funcionários<span className="count">{agents.length}/{CAPACITY}</span></button>
          <button className={`rail-link ${screen === "demands" ? "selected" : ""}`} aria-current={screen === "demands" ? "page" : undefined} onClick={() => nav("demands")}><ClipboardList size={17} />Demandas<span className="count">{demands.length}</span></button>
        </nav>
        <div className="rail-section" id="roster">EQUIPE <small>↑ ↓ para navegar</small></div>
        <Roster agents={agents} selectedId={selectedIdLive} demandCounts={demandCounts} onSelect={select} onHover={setHoveredId} />
        <button className="add-rail" onClick={() => openHire()} disabled={agents.length >= CAPACITY}><Plus size={15} /> Contratar funcionário</button>
        <div className="rail-spacer" />
        <div className="phase-card"><b><span className={`led ${runs.status?.executor.reachable ? "green" : "amber"}`} /> FASE 01 · DIRETOR</b><p>O Diretor planeja de verdade pelo executor local (Claude Code ou Codex). O Arquiteto analisa só as tarefas que você aprovar; os demais ainda não executam.</p></div>
      </aside>

      <div className="stage-shell">
        <header className="hud">
          <div className="hud-title">
            <button className="icon-btn mobile-menu" onClick={() => setRailOpen(true)} aria-label="Abrir menu"><Menu size={20} /></button>
            <div><span className="eyebrow">SETOR DE DESENVOLVIMENTO</span><h1>{title}</h1></div>
          </div>
          {screen === "office" && (
            <div className="zone-jumps" role="toolbar" aria-label="Ir para área">
              {JUMPS.map(z => <button key={z} style={{ "--accent": ZONES[z].accent } as React.CSSProperties} onClick={() => controls.current?.focusZone(z)}><i />{z === "meeting" ? "Reunião" : ZONE_LABEL[z as WorkZoneId]}</button>)}
            </div>
          )}
          <div className="hud-actions">
            <span className="status-pill"><span className="led amber" /> Preparação</span>
            <button className="btn-primary" onClick={() => openDemand("director")}><Send size={15} /> <span className="hide-sm">Enviar demanda</span></button>
          </div>
        </header>

        <main className="main-stage">
          <div className={`office-view ${screen === "office" ? "" : "is-hidden"} ${fallback ? "is-fallback" : ""}`} aria-hidden={screen !== "office"}>
            <OfficeScene
              agents={sceneAgents}
              selectedId={selectedIdLive}
              hoveredId={hoveredId}
              demandCounts={demandCounts}
              dashboard={dashboard}
              meeting={meeting}
              active={screen === "office"}
              throttled={overlayOpen && (mobile || !sheetOpen)}
              insets={insets}
              quality={quality}
              layoutKey={`${cardOpen}-${selectedId}-${vw}`}
              controlsRef={controls}
              onSelect={select}
              onStation={onStation}
              onTier={(t, auto) => setTier({ tier: t, auto })}
              onFallback={setFallback}
            />
            <div className="scene-dock" data-scene-blocker role="toolbar" aria-label="Câmera e cena">
              <button className="icon-btn" onClick={() => controls.current?.rotate(-1)} aria-label="Girar para a esquerda" title="Girar (Q)"><RotateCcw size={17} /></button>
              <button className="icon-btn" onClick={() => controls.current?.rotate(1)} aria-label="Girar para a direita" title="Girar (E)"><RotateCw size={17} /></button>
              <button className="icon-btn" onClick={() => controls.current?.zoom(1)} aria-label="Aproximar" title="Aproximar (+)"><Plus size={17} /></button>
              <button className="icon-btn" onClick={() => controls.current?.zoom(-1)} aria-label="Afastar" title="Afastar (−)"><Minus size={17} /></button>
              <button className="icon-btn" onClick={() => controls.current?.home()} aria-label="Recentralizar" title="Recentralizar (R)"><HomeIcon size={17} /></button>
              <span className="dock-sep" />
              <button className={`dock-toggle ${meeting ? "on" : ""}`} aria-pressed={meeting} onClick={() => setMeeting(m => !m)}><UsersRound size={16} /> <span>{meeting ? "Voltar às mesas" : "Reunir equipe"}</span></button>
            </div>
            <div className="scene-meta" data-scene-blocker>
              <label className="quality">
                <Gauge size={14} aria-hidden />
                <span className="sr-only">Qualidade gráfica</span>
                <select value={quality} onChange={e => setQualityPref(e.target.value as QualityPref)} aria-label="Qualidade gráfica">
                  <option value="auto">Auto{tier?.auto ? ` · ${TIER_LABEL[tier.tier]}` : ""}</option>
                  <option value="high">Alta</option>
                  <option value="balanced">Equilibrada</option>
                  <option value="low">Leve</option>
                </select>
              </label>
              <span className="hint">Arraste para girar · botão direito desloca · role para zoom</span>
            </div>
            {selected && screen === "office" && (
              <CharacterCard
                agent={selected}
                demandCount={demandCounts[selected.id] ?? 0}
                onClose={() => setSelectedId(null)}
                onConfigure={() => openSheet(selected.id)}
                onDemand={() => openDemand(selected.id)}
              />
            )}
          </div>
          {screen === "team" && <TeamScreen agents={agents} connections={runs.status?.connections} onOpen={(a: Agent) => openSheet(a.id)} onReview={(a: Agent) => openSheet(a.id, "instructions", true)} onHire={() => openHire()} />}
          {screen === "demands" && <DemandQueue demands={demands} agents={agents} runs={runs} onNew={() => openDemand("director")} onRemove={id => { office.removeDemand(id); toast.success("Demanda removida da fila local."); }} onOpenAgent={id => openSheet(id)} onPlan={d => void plan(d)} onOpenRun={setRunId} />}
        </main>

        <footer className="stage-footer">
          <span>SETOR IA · v0.2 interface</span>
          <span className="footer-mid"><span className={`led ${runs.status?.executor.reachable ? "green" : "amber"}`} /> Fichas e demandas neste navegador · {runs.status?.executor.reachable ? "executor local ativo" : "executor local indisponível"}</span>
          <button onClick={exportData}><Download size={13} /> Exportar dados locais</button>
        </footer>
      </div>

      <AgentSheet
        open={sheetOpen}
        agent={selected}
        agents={agents}
        tab={sheetTab}
        onTab={setSheetTab}
        onDraft={setPreview}
        compareOnOpen={compareOnOpen}
        onDismissPreset={office.dismissPreset}
        onClose={() => { setSheetOpen(false); setCompareOnOpen(false); }}
        onSave={draft => { const r = office.saveAgent(draft); if (r.ok) toast.success("Ficha salva neste navegador."); return r.ok ? null : r.error; }}
        onDemand={id => openDemand(id)}
        engine={{ status: runs.status, statusError: runs.statusError, verify: runs.verify, probe: runs.probe }}
        onRemove={id => { office.removeAgent(id); setSelectedId(null); toast.success("Funcionário dispensado. A estação ficou livre."); }}
      />
      <HireDialog
        open={hire.open}
        onOpenChange={v => setHire(h => ({ ...h, open: v }))}
        agents={agents}
        presetZone={hire.zone}
        presetStation={hire.station}
        onCreate={input => {
          const r = office.addAgent(input);
          if (!r.ok) return r.error;
          setHire(h => ({ ...h, open: false }));
          setScreen("office");
          setMeeting(false);
          setSelectedId(r.id);
          toast.success(`${input.name.trim()} chegou ao escritório.`);
          return null;
        }}
      />
      <DemandDialog
        open={demandOpen}
        onOpenChange={setDemandOpen}
        agents={agents}
        recipient={recipient}
        onRecipient={setRecipient}
        onSubmit={d => { office.addDemand(d); setDemandOpen(false); toast.success("Demanda adicionada à fila como preparada. Use “Planejar com o Diretor” na fila para executá-la."); }}
      />
      <RunDialog
        runId={runId} agents={agents} runs={runs} onClose={() => setRunId(null)} onOpenRun={setRunId}
        onCancel={id => void runs.cancel(id)} onReplan={(run, answers) => void replan(run, answers)}
        onHandoff={(planRunId, taskId, followUp) => void handoff(planRunId, taskId, followUp)} onReview={openReview}
        onHandoffDeveloper={(planRunId, taskId) => void handoffDeveloper(planRunId, taskId)}
        onReviewDeveloper={id => { setRunId(null); setDevHandoffId(id); }}
        onAnswerArchitect={(run, followUp) => { if (run.parentRunId && run.taskId) void handoff(run.parentRunId, run.taskId, { ...followUp, previousRunId: run.id }); }}
      />
      <HandoffDialog
        runId={handoffId} agents={agents} runs={runs} onClose={() => setHandoffId(null)}
        onApproved={id => { setHandoffId(null); setRunId(id); toast.success("Envio confirmado. O Arquiteto entrou na fila do executor local."); }}
      />
      <DeveloperHandoffDialog
        runId={devHandoffId} agents={agents} runs={runs} onClose={() => setDevHandoffId(null)}
        onApproved={id => { setDevHandoffId(null); setRunId(id); toast.success("Envio confirmado. O Desenvolvedor entrou na fila do executor local; a cópia de trabalho isolada será montada agora."); }}
      />
      <Toaster position="top-center" offset={78} theme="dark" toastOptions={{ className: "game-toast" }} />
    </div>
  );
}

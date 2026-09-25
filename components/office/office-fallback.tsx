"use client";

import { Avatar } from "./avatar";
import { FLOOR, STATIONS, ZONES } from "@/lib/office/layout";
import { ZONE_LABEL } from "@/lib/office/defaults";
import type { Agent, ZoneId } from "@/lib/office/types";

// Interactive 2D floor plan used when WebGL2 is unavailable (or ?webgl=0).
// It reuses the exact station layout, so positions match the 3D office.

const px = (x: number) => `${((x - FLOOR.x0) / (FLOOR.x1 - FLOOR.x0)) * 100}%`;
const pz = (z: number) => `${((z - FLOOR.z0) / (FLOOR.z1 - FLOOR.z0)) * 100}%`;

export function OfficeFallback({ reason, agents, selectedId, onSelect, onStation, demandCounts }: {
  reason: "unsupported" | "lost";
  agents: Agent[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onStation: (stationId: string) => void;
  demandCounts: Record<string, number>;
}) {
  const byStation = new Map(agents.map(a => [a.stationId, a]));
  return (
    <div className="office-fallback">
      <div className="plan" role="group" aria-label="Planta do escritório">
        {(Object.keys(ZONES) as ZoneId[]).map(z => {
          const r = ZONES[z].rect;
          return (
            <div key={z} className="plan-zone" style={{ left: px(r.x0), top: pz(r.z0), width: `${((r.x1 - r.x0) / 28) * 100}%`, height: `${((r.z1 - r.z0) / 20) * 100}%`, "--accent": ZONES[z].accent } as React.CSSProperties}>
              <span>{z === "director" || z === "dev" || z === "qa" ? ZONE_LABEL[z] : ZONES[z].name}</span>
            </div>
          );
        })}
        {STATIONS.map(st => {
          const a = byStation.get(st.id);
          const style = { left: px(st.x), top: pz(st.z) } as React.CSSProperties;
          if (!a) return <button key={st.id} className="plan-free" style={style} onClick={() => onStation(st.id)} aria-label={`Estação livre em ${ZONE_LABEL[st.zone]}: contratar`}>+</button>;
          return (
            <button key={st.id} className={`plan-worker ${selectedId === a.id ? "is-selected" : ""}`} style={{ ...style, "--accent": a.color } as React.CSSProperties} onClick={() => onSelect(a.id)} aria-pressed={selectedId === a.id} aria-label={`${a.name}, ${a.role}`}>
              <Avatar look={a.look} color={a.color} size={34} />
              <b>{a.name}</b>
              {!!demandCounts[a.id] && <em>{demandCounts[a.id]}</em>}
            </button>
          );
        })}
      </div>
      <p className="fallback-note">{reason === "lost" ? "O contexto gráfico foi interrompido. Recarregue a página para voltar ao 3D." : "Visualização 2D interativa: WebGL 2 indisponível neste navegador."}</p>
    </div>
  );
}

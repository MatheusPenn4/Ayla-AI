"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { OfficeEngine, EngineWorker, HoverTarget, QualityPref } from "./scene/engine";
import type { DashboardData } from "./scene/textures";
import type { Tier } from "./scene/quality";
import { OfficeFallback } from "./office-fallback";
import { STATION_BY_ID, ZONES } from "@/lib/office/layout";
import { ZONE_LABEL } from "@/lib/office/defaults";
import type { Agent, ZoneId } from "@/lib/office/types";

export type SceneControls = {
  rotate: (dir: 1 | -1) => void;
  zoom: (dir: 1 | -1) => void;
  home: () => void;
  focusZone: (zone: ZoneId) => void;
};

type Props = {
  agents: Agent[];
  selectedId: string | null;
  hoveredId: string | null;
  demandCounts: Record<string, number>;
  dashboard: DashboardData;
  meeting: boolean;
  active: boolean;
  throttled: boolean;
  insets: { right: number; bottom: number };
  quality: QualityPref;
  layoutKey: string;
  controlsRef: React.RefObject<SceneControls | null>;
  onSelect: (id: string) => void;
  onStation: (stationId: string) => void;
  onTier: (tier: Tier, auto: boolean) => void;
  onFallback?: (on: boolean) => void;
};

const ZONE_ORDER: ZoneId[] = ["director", "lounge", "meeting", "dev", "qa"];

function webglForcedOff() {
  try { return new URLSearchParams(window.location.search).get("webgl") === "0"; } catch { return false; }
}

export default function OfficeScene(props: Props) {
  const { agents, selectedId, hoveredId, demandCounts, dashboard, meeting, active, throttled, insets, quality, layoutKey, controlsRef } = props;
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<OfficeEngine | null>(null);
  const cbRef = useRef(props);
  const [fallback, setFallback] = useState<null | "unsupported" | "lost">(() => (webglForcedOff() ? "unsupported" : null));
  const [ready, setReady] = useState(false);
  const [hover, setHover] = useState<{ target: HoverTarget; x: number; y: number }>({ target: null, x: 0, y: 0 });
  useLayoutEffect(() => { cbRef.current = props; });
  useEffect(() => { cbRef.current.onFallback?.(!!fallback); }, [fallback]);

  // Mount the engine once; everything else is pushed through setters.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (webglForcedOff()) return;
    let engine: OfficeEngine | null = null;
    let cancelled = false;
    import("./scene/engine").then(({ OfficeEngine }) => {
      if (cancelled) return;
      try {
        const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        engine = new OfficeEngine(host, {
          onSelect: id => cbRef.current.onSelect(id),
          onStation: id => cbRef.current.onStation(id),
          onHover: (target, cx, cy) => {
            const r = host.getBoundingClientRect();
            const x = cx - r.left, y = cy - r.top;
            setHover(h => (h.target?.id === target?.id && h.target?.type === target?.type && (target?.type !== "station" || (h.x === x && h.y === y)) ? h : { target, x, y }));
          },
          onTier: (tier, auto) => cbRef.current.onTier(tier, auto),
          onContextLost: () => { setFallback("lost"); engine?.dispose(); engineRef.current = null; },
        }, { quality: cbRef.current.quality, reducedMotion: reduced });
        engineRef.current = engine;
        (window as unknown as { __setorOffice?: unknown }).__setorOffice = engine;
        setReady(true);
      } catch (err) {
        console.warn("[office] WebGL indisponível, usando visualização 2D.", err);
        setFallback("unsupported");
      }
    });
    return () => {
      cancelled = true;
      engine?.dispose();
      engineRef.current = null;
      delete (window as unknown as { __setorOffice?: unknown }).__setorOffice;
    };
  }, []);

  useEffect(() => {
    controlsRef.current = {
      rotate: d => engineRef.current?.rotate(d),
      zoom: d => engineRef.current?.zoom(d),
      home: () => engineRef.current?.home(),
      focusZone: z => engineRef.current?.focusZone(z),
    };
  }, [controlsRef, ready]);

  const workerKey = agents.map(a => `${a.id}|${a.name}|${a.color}|${a.stationId}|${JSON.stringify(a.look)}`).join(";");
  useEffect(() => {
    const workers: EngineWorker[] = agents.map(a => ({ id: a.id, name: a.name, color: a.color, look: a.look, stationId: a.stationId }));
    engineRef.current?.setWorkers(workers);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workerKey, ready]);
  useEffect(() => { engineRef.current?.setSelected(selectedId, true); }, [selectedId, ready]);
  useEffect(() => { engineRef.current?.setExternalHover(hoveredId); }, [hoveredId, ready]);
  useEffect(() => { engineRef.current?.setMeeting(meeting); }, [meeting, ready]);
  useEffect(() => { engineRef.current?.setActive(active); }, [active, ready]);
  useEffect(() => { engineRef.current?.setThrottled(throttled); }, [throttled, ready]);
  useEffect(() => { engineRef.current?.setInsets(insets.right, insets.bottom); }, [insets.right, insets.bottom, ready]);
  useEffect(() => { if (ready) engineRef.current?.setQuality(quality); }, [quality, ready]);
  const dashKey = JSON.stringify(dashboard);
  useEffect(() => {
    if (!ready) return;
    const draw = () => engineRef.current?.setDashboard(JSON.parse(dashKey));
    draw();
    // Canvas text needs the web fonts; redraw once they are ready.
    document.fonts?.ready.then(draw).catch(() => {});
  }, [dashKey, ready]);

  // Labels re-measure after content changes; blockers are HUD panels over the scene.
  useLayoutEffect(() => { engineRef.current?.measureLabels(); }, [workerKey, demandCounts, ready]);
  useEffect(() => {
    const view = viewRef.current?.closest(".office-view");
    const host = hostRef.current;
    if (!view || !host || !ready) return;
    const update = () => {
      const base = host.getBoundingClientRect();
      const rects = [...view.querySelectorAll<HTMLElement>("[data-scene-blocker]")].filter(el => el.offsetParent).map(el => {
        const r = el.getBoundingClientRect();
        return { l: r.left - base.left, t: r.top - base.top, r: r.right - base.left, b: r.bottom - base.top };
      });
      engineRef.current?.setBlocked(rects);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(host);
    view.querySelectorAll<HTMLElement>("[data-scene-blocker]").forEach(el => ro.observe(el));
    const timer = window.setInterval(update, 1200);
    document.fonts?.ready.then(() => { engineRef.current?.measureLabels(); update(); }).catch(() => {});
    return () => { ro.disconnect(); window.clearInterval(timer); };
  }, [ready, layoutKey]);

  if (fallback) return <OfficeFallback reason={fallback} agents={agents} selectedId={selectedId} onSelect={props.onSelect} onStation={props.onStation} demandCounts={demandCounts} />;

  const hoverStation = hover.target?.type === "station" ? STATION_BY_ID.get(hover.target.id) : null;
  return (
    <div ref={viewRef} className="office-canvas-wrap">
      <div ref={hostRef} className="office-canvas" />
      {!ready && <div className="scene-loading"><span className="loader-mark" aria-hidden /> Montando o escritório…</div>}
      <div className="label-layer" aria-hidden="true">
        {ZONE_ORDER.map(z => (
          <div key={z} className="zone-label" data-zone={z} style={{ "--accent": ZONES[z].accent } as React.CSSProperties} ref={el => engineRef.current?.registerLabel(`zone:${z}`, el, "zone")}>
            <div className="pill"><i />{z === "director" || z === "dev" || z === "qa" ? ZONE_LABEL[z] : ZONES[z].name}</div>
          </div>
        ))}
        {ready && agents.map(a => (
          <button key={a.id} tabIndex={-1} className="worker-label" style={{ "--accent": a.color } as React.CSSProperties} ref={el => engineRef.current?.registerLabel(a.id, el, "worker")} onClick={() => props.onSelect(a.id)}>
            <span className="pill">
              <b>{a.name}</b>
              <small>{a.role}</small>
              {!!demandCounts[a.id] && <em title="Demandas preparadas">{demandCounts[a.id]}</em>}
            </span>
            <span className="dot">{a.name.slice(0, 1).toUpperCase()}</span>
            <span className="stem" />
          </button>
        ))}
      </div>
      {hoverStation && (
        <div className="station-tip" style={{ left: hover.x + 14, top: hover.y + 12 }}>
          <b>Estação livre</b>
          <span>{ZONE_LABEL[hoverStation.zone]} · clique para contratar</span>
        </div>
      )}
    </div>
  );
}

// Local persistence with a safe, non-destructive migration.
// v1 (`setor-ia-game-v1`) is read but never deleted, so older builds keep working
// and the user can always roll back. v2 is written under its own key.
import { CAPACITY, STATION_BY_ID, freeStation } from "./layout";
import { DEFAULT_AGENTS, DEFAULT_IDS, baseTools, lookFromSeed } from "./defaults";
import { EMPTY_PLAYBOOK, HIRE_TEMPLATES, PRESET_VERSION } from "./presets";
import { connectionFromLegacyProvider, isApiConnectionRef } from "@/lib/engine/connections";
import { filterTargets } from "./profile";
import type { Agent, Appearance, Demand, DemandPriority, FolderSummary, LocalSource, Playbook, PresetRef, RepoRef, ToolKey, WorkZoneId } from "./types";

export const STORAGE_V1 = "setor-ia-game-v1";
export const STORAGE_V2 = "setor-ia-office-v2";
export const PREFS_KEY = "setor-ia-prefs";

export type OfficeData = { version: 2; agents: Agent[]; demands: Demand[]; migratedFrom?: 1 };

type Loose = Record<string, unknown>;
const str = (v: unknown, fallback = "") => (typeof v === "string" ? v : fallback);
const isObj = (v: unknown): v is Loose => typeof v === "object" && v !== null && !Array.isArray(v);
const HEX = /^#[0-9a-f]{6}$/i;

function readJson(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function normalizeLook(v: unknown, seed: string, fallback?: Appearance): Appearance {
  const base = fallback ?? lookFromSeed(seed);
  if (!isObj(v)) return base;
  return {
    skin: HEX.test(str(v.skin)) ? str(v.skin) : base.skin,
    hair: (str(v.hair) || base.hair) as Appearance["hair"],
    hairColor: HEX.test(str(v.hairColor)) ? str(v.hairColor) : base.hairColor,
    outfit: (str(v.outfit) || base.outfit) as Appearance["outfit"],
    accessory: (str(v.accessory) || base.accessory) as Appearance["accessory"],
    pants: HEX.test(str(v.pants)) ? str(v.pants) : base.pants,
  };
}

/** Maps v1 free-text hand-offs ("Arquiteto, Desenvolvedor e QA") to agent ids. */
function handoffIdsFromText(text: string, agents: { id: string; name: string }[], self: string) {
  const lower = text.toLowerCase();
  return agents.filter(a => a.id !== self && a.name && lower.includes(a.name.toLowerCase())).map(a => a.id);
}

function normalizePlaybook(v: unknown): Playbook {
  const out = { ...EMPTY_PLAYBOOK };
  if (isObj(v)) for (const k of Object.keys(out) as (keyof Playbook)[]) out[k] = str(v[k]);
  return out;
}

const KNOWN_PRESETS = new Set([...DEFAULT_IDS, ...HIRE_TEMPLATES.map(t => t.id)]);

/**
 * Saved data without a preset reference predates the structured profiles:
 * default collaborators are marked as based on version 1 (so an update can be
 * offered, never applied automatically) and custom ones as created from scratch.
 */
function normalizePreset(v: unknown, id: string, isDefault: boolean): PresetRef {
  if (isObj(v)) {
    const pid = typeof v.id === "string" && KNOWN_PRESETS.has(v.id) ? v.id : null;
    const version = Number(v.version);
    const dismissed = Number(v.dismissedVersion);
    return { id: pid, version: Number.isFinite(version) && version >= 1 ? Math.floor(version) : 1, ...(Number.isFinite(dismissed) && dismissed >= 1 ? { dismissedVersion: Math.floor(dismissed) } : {}) };
  }
  return { id: isDefault ? id : null, version: 1 };
}

/**
 * @param fallback default agent (for default ids) or undefined (custom agents).
 * Fields that did not exist when the data was saved are left empty on purpose:
 * new default texts are only applied through the comparison dialog.
 */
function normalizeAgent(raw: Loose, fallback: Agent | undefined): Agent {
  const id = str(raw.id, fallback?.id);
  const tools = { ...(fallback?.tools ?? baseTools) } as Record<ToolKey, boolean>;
  if (isObj(raw.tools)) for (const k of Object.keys(tools) as ToolKey[]) if (typeof raw.tools[k] === "boolean") tools[k] = raw.tools[k] as boolean;
  const zone = (["director", "dev", "qa"].includes(str(raw.zone)) ? raw.zone : fallback?.zone ?? "dev") as WorkZoneId;
  const budget = Number(raw.budget);
  return {
    id,
    name: str(raw.name, fallback?.name ?? "Funcionário").slice(0, 40),
    role: str(raw.role, fallback?.role ?? "Especialista").slice(0, 50),
    color: HEX.test(str(raw.color)) ? str(raw.color) : fallback?.color ?? "#68a8e0",
    description: str(raw.description, fallback?.description),
    model: str(raw.model, fallback?.model ?? "A definir"),
    // Older sheets had only a planned provider: keep that choice by mapping it onto its official client.
    connection: raw.connection === "claude_code" || raw.connection === "codex" || raw.connection === "none" || isApiConnectionRef(raw.connection) ? raw.connection : connectionFromLegacyProvider(raw.model ?? fallback?.model),
    modelName: str(raw.modelName, fallback?.modelName).slice(0, 80),
    effort: /^[a-z]{0,12}$/.test(str(raw.effort)) ? str(raw.effort) : "",
    instructions: str(raw.instructions, fallback?.instructions),
    limits: str(raw.limits, fallback?.limits),
    deliverable: str(raw.deliverable, fallback?.deliverable),
    handoff: str(raw.handoff, fallback?.handoff),
    handoffTo: Array.isArray(raw.handoffTo) ? raw.handoffTo.filter((x): x is string => typeof x === "string") : fallback?.handoffTo ?? [],
    playbook: normalizePlaybook(raw.playbook),
    returnTo: Array.isArray(raw.returnTo) ? raw.returnTo.filter((x): x is string => typeof x === "string") : [],
    maxCycles: typeof raw.maxCycles === "number" && Number.isFinite(raw.maxCycles) && raw.maxCycles >= 1 ? Math.min(10, Math.floor(raw.maxCycles)) : null,
    budget: Number.isFinite(budget) && budget > 0 ? Math.round(budget) : fallback?.budget ?? 10000,
    tools,
    custom: fallback ? false : raw.custom !== false,
    zone,
    stationId: str(raw.stationId, fallback?.stationId),
    look: normalizeLook(raw.look, id, fallback?.look),
    preset: normalizePreset(raw.preset, id, !!fallback),
  };
}

function parseRepo(url: string): RepoRef | undefined {
  const m = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s#?]+)/i.exec(url.trim());
  return m ? { url: url.trim(), owner: m[1], repo: m[2].replace(/\.git$/i, ""), branch: "" } : undefined;
}

function normalizeDemand(raw: Loose): Demand | null {
  const id = str(raw.id);
  if (!id || !str(raw.title)) return null;
  const local: LocalSource | undefined = isObj(raw.local) && /^[0-9a-f]{40}$/.test(str(raw.local.commit)) && str(raw.local.projectId)
    ? { projectId: str(raw.local.projectId), projectLabel: str(raw.local.projectLabel), owner: str(raw.local.owner), repo: str(raw.local.repo), ref: str(raw.local.ref), commit: str(raw.local.commit), subject: str(raw.local.subject), resolvedAt: str(raw.local.resolvedAt) }
    : undefined;
  const declared = (["github", "folder", "none", "local"].includes(str(raw.source)) ? raw.source : "none") as Demand["source"];
  // A local source without a valid project/commit is not kept as local (it would only fail at planning time).
  const source: Demand["source"] = declared === "local" && !local ? "none" : declared;
  const criteria = Array.isArray(raw.acceptanceCriteria) ? raw.acceptanceCriteria.filter((x): x is string => typeof x === "string" && !!x.trim()) : [];
  const repo = isObj(raw.repo) ? { url: str(raw.repo.url), owner: str(raw.repo.owner), repo: str(raw.repo.repo), branch: str(raw.repo.branch) } : source === "github" ? parseRepo(str(raw.sourceLabel)) : undefined;
  const folder: FolderSummary | undefined = isObj(raw.folder)
    ? { name: str(raw.folder.name), fileCount: Number(raw.folder.fileCount) || 0, totalBytes: Number(raw.folder.totalBytes) || 0, topExtensions: Array.isArray(raw.folder.topExtensions) ? (raw.folder.topExtensions as [string, number][]) : [], hasPackageJson: !!raw.folder.hasPackageJson, hasGitDir: !!raw.folder.hasGitDir }
    : source === "folder" ? { name: str(raw.sourceLabel, "Pasta selecionada"), fileCount: Number(raw.fileCount) || 0, totalBytes: 0, topExtensions: [], hasPackageJson: false, hasGitDir: false } : undefined;
  return {
    id,
    title: str(raw.title),
    description: str(raw.description),
    acceptanceCriteria: criteria,
    project: str(raw.project),
    priority: (["baixa", "normal", "alta"].includes(str(raw.priority)) ? raw.priority : "normal") as DemandPriority,
    recipient: str(raw.recipient, "director"),
    source,
    sourceLabel: str(raw.sourceLabel),
    fileCount: Number(raw.fileCount) || folder?.fileCount || 0,
    repo,
    folder,
    ...(source === "local" && local ? { local } : {}),
    status: "prepared",
    createdAt: str(raw.createdAt, new Date().toISOString()),
  };
}

/** Gives every agent a unique, valid station, keeping existing ones where possible. */
export function assignStations(agents: Agent[]): Agent[] {
  const taken = new Set<string>();
  const out = agents.map(a => ({ ...a }));
  for (const a of out) {
    const st = STATION_BY_ID.get(a.stationId);
    if (st && st.zone === a.zone && !taken.has(a.stationId)) taken.add(a.stationId);
    else a.stationId = "";
  }
  for (const a of out) {
    if (a.stationId) continue;
    const zones: WorkZoneId[] = [a.zone, "dev", "qa", "director"];
    for (const z of zones) {
      const free = freeStation(z, taken);
      if (free) { a.stationId = free; a.zone = z; taken.add(free); break; }
    }
  }
  return out.filter(a => a.stationId).slice(0, CAPACITY);
}

export function normalizeData(input: unknown): Omit<OfficeData, "version"> {
  const src = isObj(input) ? input : {};
  const saved = Array.isArray(src.agents) ? src.agents.filter(isObj) : [];
  const defaults = DEFAULT_AGENTS.map(d => {
    const raw = saved.find(x => x.id === d.id);
    return raw ? normalizeAgent(raw, d) : d;
  });
  const customs = saved.filter(x => typeof x.id === "string" && !DEFAULT_IDS.has(x.id as string)).map(x => normalizeAgent({ ...x, custom: true }, undefined));
  let agents = [...defaults, ...customs];
  // Legacy hand-off text becomes structured targets when it names known agents.
  agents = agents.map(a => {
    const raw = saved.find(x => x.id === a.id);
    if (raw && !Array.isArray(raw.handoffTo) && a.handoff) return { ...a, handoffTo: handoffIdsFromText(a.handoff, agents, a.id) };
    return a;
  });
  const placed = assignStations(agents);
  // Hand-offs may only point to collaborators that exist (or to the requester).
  const ids = placed.map(a => a.id);
  const cleaned = placed.map(a => ({ ...a, handoffTo: filterTargets(a.handoffTo, ids, a.id).filter(t => t !== "user"), returnTo: filterTargets(a.returnTo, ids, a.id) }));
  const demands = (Array.isArray(src.demands) ? src.demands.filter(isObj) : []).map(normalizeDemand).filter((d): d is Demand => !!d);
  return { agents: cleaned, demands };
}

export function loadOffice(): OfficeData {
  const v2 = readJson(STORAGE_V2);
  if (isObj(v2) && v2.version === 2) return { version: 2, ...normalizeData(v2) };
  const v1 = readJson(STORAGE_V1);
  if (isObj(v1)) return { version: 2, ...normalizeData(v1), migratedFrom: 1 };
  return { version: 2, ...normalizeData(null) };
}

export function saveOffice(data: { agents: Agent[]; demands: Demand[] }) {
  localStorage.setItem(STORAGE_V2, JSON.stringify(serializeOffice(data)));
}

/** Storage and export format (same shape, so an export can be re-imported by the engine). */
export function serializeOffice(data: { agents: Agent[]; demands: Demand[] }) {
  return { version: 2, schema: "setor-ia.office/v2", presetVersion: PRESET_VERSION, savedAt: new Date().toISOString(), agents: data.agents, demands: data.demands };
}

export type QualityPref = "auto" | "high" | "balanced" | "low";
export type Prefs = { quality: QualityPref };
export function loadPrefs(): Prefs {
  const p = readJson(PREFS_KEY);
  const q = isObj(p) ? str(p.quality) : "";
  return { quality: (["auto", "high", "balanced", "low"].includes(q) ? q : "auto") as QualityPref };
}
export function savePrefs(p: Prefs) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* preferences are optional */ }
}

export { parseRepo };

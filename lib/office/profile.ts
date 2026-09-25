// Pure helpers around collaborator profiles: comparison with the default
// preset, field-by-field application that preserves customisations, and
// hire-template instantiation. No React, no storage: covered by unit tests.
import { DEFAULT_PROFILES, EMPTY_PLAYBOOK, HIRE_TEMPLATES, LEGACY_V1_PROFILES, PRESET_VERSION, PROFILE_FIELDS, type Profile, type ProfileField } from "./presets";
import type { Agent, Playbook } from "./types";
import { USER_TARGET } from "./types";

type ProfileSource = Pick<Agent, keyof Profile>;

export function presetProfile(id: string | null | undefined): Profile | null {
  if (!id) return null;
  if (id in DEFAULT_PROFILES) return DEFAULT_PROFILES[id as keyof typeof DEFAULT_PROFILES];
  return HIRE_TEMPLATES.find(t => t.id === id)?.profile ?? null;
}

/** Texts a saved agent is known to be based on, per preset version (only v1 differs today). */
function baselineProfile(id: string, version: number): Partial<Profile> | null {
  if (version >= PRESET_VERSION) return presetProfile(id);
  if (version === 1 && id in LEGACY_V1_PROFILES) return LEGACY_V1_PROFILES[id as keyof typeof LEGACY_V1_PROFILES];
  return null;
}

export function getField(src: Partial<ProfileSource>, key: ProfileField): unknown {
  if (key.startsWith("playbook.")) return src.playbook?.[key.slice(9) as keyof Playbook];
  return src[key as keyof Profile];
}

function setField<T extends ProfileSource>(target: T, key: ProfileField, value: unknown): T {
  if (key.startsWith("playbook.")) return { ...target, playbook: { ...target.playbook, [key.slice(9)]: value } };
  return { ...target, [key]: value };
}

const canon = (v: unknown) => JSON.stringify(v ?? null);
const isEmpty = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

/** Keeps only hand-off targets that exist (plus the demand's requester, "user"). */
export function filterTargets(ids: string[], existingIds: Iterable<string>, self?: string) {
  const ok = new Set(existingIds);
  return [...new Set(ids)].filter(id => id !== self && (id === USER_TARGET || ok.has(id)));
}

export type PresetStatus = { presetId: string; from: number; to: number; dismissed: boolean };

/** Returns update information when a newer default exists for this agent's preset. */
export function presetUpdate(agent: Agent): PresetStatus | null {
  const { id, version, dismissedVersion } = agent.preset;
  if (!id || !presetProfile(id) || version >= PRESET_VERSION) return null;
  return { presetId: id, from: version, to: PRESET_VERSION, dismissed: (dismissedVersion ?? 0) >= PRESET_VERSION };
}

export type FieldDiff = {
  key: ProfileField;
  label: string;
  group: string;
  current: unknown;
  next: unknown;
  /** Same content already: nothing to apply. */
  equal: boolean;
  /** The user changed this field (it differs from the text it was based on). */
  customized: boolean;
  /** Pre-selected for application: only fields that are empty or still untouched. */
  suggested: boolean;
};

/**
 * Field-by-field comparison between an agent and the latest version of its preset.
 * Hand-off targets in the preset are resolved against the existing team.
 */
export function comparePreset(agent: Agent, existingIds: string[]): FieldDiff[] {
  const latest = presetProfile(agent.preset.id);
  if (!latest) return [];
  const base = agent.preset.id ? baselineProfile(agent.preset.id, agent.preset.version) : null;
  return PROFILE_FIELDS.map(({ key, label, group }) => {
    const current = getField(agent, key);
    let next = getField(latest, key);
    if (key === "handoffTo" || key === "returnTo") next = filterTargets(next as string[], existingIds, agent.id);
    const equal = canon(current) === canon(next);
    const baseValue = base ? getField(base, key) : undefined;
    // Untouched = empty, or identical to the text it was based on. Fields that did
    // not exist in the base version (baseValue undefined) only count as untouched when empty.
    const untouched = isEmpty(current) || (baseValue !== undefined && canon(current) === canon(baseValue));
    return { key, label, group, current, next, equal, customized: !untouched, suggested: !equal && untouched };
  });
}

/** Applies the chosen fields of the latest preset. Name, look, station, zone, provider and demands are never touched. */
export function applyPreset(agent: Agent, keys: ProfileField[], existingIds: string[]): Agent {
  const diffs = comparePreset(agent, existingIds);
  let out: Agent = { ...agent, playbook: { ...agent.playbook } };
  for (const d of diffs) if (keys.includes(d.key) && !d.equal) out = setField(out, d.key, structuredClone(d.next));
  return { ...out, preset: { id: agent.preset.id, version: PRESET_VERSION } };
}

/** Keeps the current texts and stops suggesting this preset version. */
export function dismissPreset(agent: Agent): Agent {
  return { ...agent, preset: { ...agent.preset, dismissedVersion: PRESET_VERSION } };
}

/** Profile for a newly hired collaborator: template texts, or an empty but valid profile. */
export function profileForHire(templateId: string | null, existingIds: string[]): Profile & { preset: Agent["preset"] } {
  const tpl = templateId ? HIRE_TEMPLATES.find(t => t.id === templateId) : null;
  if (!tpl) {
    return {
      description: "", playbook: { ...EMPTY_PLAYBOOK }, instructions: "", limits: "", deliverable: "", handoff: "",
      handoffTo: filterTargets(["director"], existingIds), returnTo: filterTargets(["director"], existingIds), maxCycles: null, budget: 16000,
      tools: { read: true, edit: false, terminal: false, github: false, browser: false },
      preset: { id: null, version: PRESET_VERSION },
    };
  }
  const p = structuredClone(tpl.profile);
  return { ...p, handoffTo: filterTargets(p.handoffTo, existingIds), returnTo: filterTargets(p.returnTo, existingIds), preset: { id: tpl.id, version: PRESET_VERSION } };
}

export const TARGET_LABEL_USER = "Solicitante (usuário)";

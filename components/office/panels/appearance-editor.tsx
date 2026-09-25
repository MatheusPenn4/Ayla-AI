"use client";

import { Avatar } from "../avatar";
import { ACCESSORY_OPTIONS, HAIR_COLORS, HAIR_OPTIONS, OUTFIT_OPTIONS, PANTS_COLORS, SKIN_TONES } from "@/lib/office/defaults";
import type { Appearance } from "@/lib/office/types";

export const ACCENT_SWATCHES = ["#669adf", "#56c9bd", "#ad95d9", "#e6a07f", "#d0b26f", "#e86f8f", "#7fcf6a", "#f0bd5e", "#5fb7d9", "#c07ce0"];

function Swatches({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (v: string) => void }) {
  return (
    <div className="field" role="radiogroup" aria-label={label}>
      <span>{label}</span>
      <div className="swatches">
        {options.map(c => (
          <button key={c} type="button" role="radio" aria-checked={value.toLowerCase() === c.toLowerCase()} aria-label={c} className="swatch" style={{ background: c }} onClick={() => onChange(c)} />
        ))}
      </div>
    </div>
  );
}

function Chips<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="field" role="radiogroup" aria-label={label}>
      <span>{label}</span>
      <div className="chips">
        {options.map(o => (
          <button key={o.value} type="button" role="radio" aria-checked={value === o.value} className="chip" onClick={() => onChange(o.value)}>{o.label}</button>
        ))}
      </div>
    </div>
  );
}

export function AppearanceEditor({ look, color, onLook, onColor, compact }: { look: Appearance; color: string; onLook: (l: Appearance) => void; onColor: (c: string) => void; compact?: boolean }) {
  const set = (part: Partial<Appearance>) => onLook({ ...look, ...part });
  return (
    <div className={`appearance ${compact ? "is-compact" : ""}`}>
      <div className="appearance-preview">
        <Avatar look={look} color={color} size={compact ? 76 : 96} />
        <small>Prévia do personagem</small>
      </div>
      <div className="appearance-fields">
        <Swatches label="Cor principal" value={color} options={ACCENT_SWATCHES} onChange={onColor} />
        <Chips label="Cabelo" value={look.hair} options={HAIR_OPTIONS} onChange={v => set({ hair: v })} />
        <Swatches label="Cor do cabelo" value={look.hairColor} options={HAIR_COLORS} onChange={v => set({ hairColor: v })} />
        <Swatches label="Tom de pele" value={look.skin} options={SKIN_TONES} onChange={v => set({ skin: v })} />
        <Chips label="Roupa" value={look.outfit} options={OUTFIT_OPTIONS} onChange={v => set({ outfit: v })} />
        <Chips label="Acessório" value={look.accessory} options={ACCESSORY_OPTIONS} onChange={v => set({ accessory: v })} />
        {!compact && <Swatches label="Calça" value={look.pants} options={PANTS_COLORS} onChange={v => set({ pants: v })} />}
      </div>
    </div>
  );
}

import type { Appearance } from "@/lib/office/types";

// 2D portrait drawn from the same Appearance data as the 3D character, so a
// worker is recognisable in the roster, the sheet and the no-WebGL view.

function shade(hex: string, amt: number) {
  const n = parseInt(hex.slice(1), 16);
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v + amt * 255)));
  return `rgb(${c(n >> 16)}, ${c((n >> 8) & 255)}, ${c(n & 255)})`;
}

export function Avatar({ look, color, size = 40, className, title }: { look: Appearance; color: string; size?: number; className?: string; title?: string }) {
  const hair = look.hairColor, skin = look.skin;
  const outfit = look.outfit === "labcoat" ? "#eef0f4" : look.outfit === "vest" ? "#eef0f4" : color;
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 64 64" role={title ? "img" : undefined} aria-label={title} aria-hidden={title ? undefined : true}>
      <rect x="1" y="1" width="62" height="62" rx="16" fill={shade(color, -0.42)} />
      <rect x="1" y="1" width="62" height="62" rx="16" fill="none" stroke={color} strokeOpacity=".7" strokeWidth="2" />
      {/* back hair */}
      {(look.hair === "long") && <rect x="15" y="16" width="34" height="34" rx="8" fill={shade(hair, -0.06)} />}
      {look.hair === "ponytail" && <rect x="40" y="22" width="9" height="20" rx="4" fill={hair} transform="rotate(20 44 30)" />}
      {/* shoulders */}
      <path d="M10 64 C10 50 18 45 32 45 C46 45 54 50 54 64 Z" fill={outfit} />
      {look.outfit === "vest" && <><path d="M14 64 C14 52 20 47 27 46 L28 64 Z" fill={color} /><path d="M50 64 C50 52 44 47 37 46 L36 64 Z" fill={color} /></>}
      {look.outfit === "blazer" && <><path d="M28 45 L32 56 L36 45 Z" fill="#f3f1ea" /><path d="M31 48 h2 l1 9 h-4 Z" fill="#b8324a" /></>}
      {look.outfit === "hoodie" && <path d="M20 47 C24 43 40 43 44 47 C40 50 24 50 20 47 Z" fill={shade(color, -0.1)} />}
      {look.outfit === "sweater" && <rect x="26" y="41" width="12" height="7" rx="3" fill={shade(color, -0.08)} />}
      {look.outfit === "labcoat" && <path d="M28 45 L32 54 L36 45 Z" fill={color} />}
      <rect x="28" y="38" width="8" height="8" fill={skin} />
      {/* head */}
      <rect x="17" y="14" width="30" height="28" rx="8" fill={skin} />
      <rect x="14.5" y="25" width="4" height="7" rx="2" fill={skin} />
      <rect x="45.5" y="25" width="4" height="7" rx="2" fill={skin} />
      {/* hair */}
      {["short", "slick", "bun", "long", "ponytail", "spiky"].includes(look.hair) && <path d="M16 26 C15 14 22 10 32 10 C42 10 49 14 48 26 L45 21 C40 17 24 17 19 21 Z" fill={hair} />}
      {look.hair === "slick" && <path d="M26 12 C34 8 44 11 45 18 C38 14 30 14 26 12 Z" fill={shade(hair, 0.08)} />}
      {look.hair === "spiky" && <path d="M18 18 L21 7 L26 14 L30 5 L34 13 L39 5 L41 14 L46 8 L46 20 Z" fill={hair} />}
      {look.hair === "curly" && [[20, 16], [27, 12], [35, 11], [42, 15], [46, 21], [17, 22], [31, 14]].map(([x, y], i) => <circle key={i} cx={x} cy={y} r="6" fill={hair} />)}
      {look.hair === "bun" && <circle cx="32" cy="8" r="6" fill={hair} />}
      {look.hair === "mohawk" && <rect x="29" y="6" width="6" height="14" rx="3" fill={hair} />}
      {look.hair === "bald" && <ellipse cx="27" cy="18" rx="5" ry="2" fill="#fff" opacity=".25" />}
      {/* face */}
      <rect x="23" y="26" width="4" height="5" rx="1.2" fill="#1d1b26" />
      <rect x="37" y="26" width="4" height="5" rx="1.2" fill="#1d1b26" />
      <rect x="24" y="26.5" width="1.4" height="1.4" fill="#fff" />
      <rect x="38" y="26.5" width="1.4" height="1.4" fill="#fff" />
      <rect x="22" y="22.5" width="6" height="1.6" rx=".8" fill={shade(hair, -0.05)} />
      <rect x="36" y="22.5" width="6" height="1.6" rx=".8" fill={shade(hair, -0.05)} />
      <rect x="20" y="32" width="4" height="2" rx="1" fill="#ff7a8a" opacity=".45" />
      <rect x="40" y="32" width="4" height="2" rx="1" fill="#ff7a8a" opacity=".45" />
      <rect x="29" y="35" width="6" height="1.8" rx=".9" fill="#8a4a45" />
      {look.accessory === "beard" && <><path d="M18 30 C18 42 24 45 32 45 C40 45 46 42 46 30 C44 36 40 38 32 38 C24 38 20 36 18 30 Z" fill={hair} /><rect x="27" y="33" width="10" height="2.4" rx="1.2" fill={hair} /></>}
      {look.accessory === "glasses" && <g fill="#bfe6ff" fillOpacity=".55" stroke="#20202c" strokeWidth="1.6"><rect x="20.5" y="24" width="9" height="8" rx="2" /><rect x="34.5" y="24" width="9" height="8" rx="2" /><path d="M29.5 27 h5" fill="none" /></g>}
      {look.accessory === "headphones" && <g><path d="M15 26 C15 9 49 9 49 26" fill="none" stroke="#20202c" strokeWidth="3" /><rect x="11" y="23" width="7" height="11" rx="3" fill={color} stroke="#20202c" strokeWidth="1" /><rect x="46" y="23" width="7" height="11" rx="3" fill={color} stroke="#20202c" strokeWidth="1" /></g>}
      {look.accessory === "headset" && <g><path d="M16 24 C16 10 48 10 48 24" fill="none" stroke="#20202c" strokeWidth="2" /><rect x="45" y="23" width="6" height="9" rx="2.5" fill="#20202c" /><path d="M47 32 C45 38 40 38 36 37" fill="none" stroke="#20202c" strokeWidth="1.6" /><circle cx="35.5" cy="37" r="1.8" fill="#ff7a76" /></g>}
      {look.accessory === "cap" && <g><path d="M16 22 C16 10 48 10 48 22 Z" fill={color} /><rect x="14" y="20" width="30" height="4" rx="2" fill={shade(color, -0.15)} /></g>}
      {look.accessory === "beanie" && <g><path d="M16 22 C16 8 48 8 48 22 Z" fill={color} /><rect x="15" y="19" width="34" height="5" rx="2" fill={shade(color, -0.15)} /><circle cx="32" cy="7" r="3" fill="#f3f1ea" /></g>}
    </svg>
  );
}

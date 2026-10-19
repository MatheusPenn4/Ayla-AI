// Default choices of an Architect hand-off (source/commit and files to read), shared by the "Enviar ao
// Arquiteto" form and the autopilot supervisor, so a hand-off the supervisor prepares is exactly what the user
// would have sent by accepting the form as it opens. Pure: no I/O.
import type { SourceOptions } from "./client";

/** Suggestions checked by default, in order, while they fit the reading limits (10 files, 12 references). */
export function defaultPick(refs: string[]): Record<string, boolean> {
  const files = new Set<string>(), out: Record<string, boolean> = {};
  for (const r of refs) {
    const p = r.split("#")[0];
    if (Object.keys(out).length >= 12 || (!files.has(p) && files.size >= 10)) break;
    files.add(p); out[r] = true;
  }
  return out;
}

export type ArchitectDefaults = {
  /** Source to send; null when the Director read no commit (no choice to make). */
  source: { via: "github" | "local_git"; commit: string } | null;
  /** Files checked by default (from the previous hand-off of the task, or the suggestions). */
  files: string[];
  /** The chosen source is not the commit the Director read: a reason is required. */
  changedFromDirector: boolean;
  /** Why this source was proposed (from the executor). */
  why: string | null;
};

/**
 * What the form starts with: a retry starts from the previous hand-off of the task (same commit and files);
 * otherwise from the executor's proposal (the commit of the most recent dependency analysis, else the
 * Director's) and the suggested files that fit the limits.
 */
export function architectDefaults(o: SourceOptions): ArchitectDefaults {
  const prev = o.previous?.commit && o.previous.files.length ? o.previous : null;
  const source = prev
    ? { via: prev.via ?? "github", commit: prev.commit! }
    : o.proposed ? { via: o.proposed.via, commit: o.proposed.commit } : null;
  const files = prev
    ? [...new Set(prev.files)]
    : Object.keys(defaultPick(o.suggestedFiles.map(f => f.ref)));
  const changedFromDirector = !!source && !!o.directorCommit && (source.commit !== o.directorCommit || source.via !== "github");
  return { source, files, changedFromDirector, why: prev ? `Mesmo commit do envio anterior desta tarefa (${prev.runId.slice(0, 8)}).` : o.proposed?.why ?? null };
}

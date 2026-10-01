import { json, readGate } from "@/lib/server/access";
import { callExecutor } from "@/lib/server/executor-client";

export const dynamic = "force-dynamic";

/** The commit a reference points to (full SHA, subject, uncommitted entries that stay out) — shown before planning. */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = readGate(request);
  if (!gate.ok) return json({ error: { code: "forbidden", message: gate.reason } }, gate.status);
  const { id } = await ctx.params;
  if (!/^[A-Za-z0-9-]{4,64}$/.test(id)) return json({ error: { code: "not_found", message: "Projeto não encontrado." } }, 404);
  const q = new URL(request.url).searchParams;
  const ref = q.get("ref") ?? "", commit = q.get("commit") ?? "";
  if (ref.length > 200 || commit.length > 64) return json({ error: { code: "invalid_request", message: "Referência inválida." } }, 400);
  const qs = new URLSearchParams();
  if (ref) qs.set("ref", ref);
  if (commit) qs.set("commit", commit);
  const r = await callExecutor(`/v1/projects/${id}/resolve${qs.size ? `?${qs}` : ""}`, { timeoutMs: 30_000 });
  return json(r.body, r.status);
}

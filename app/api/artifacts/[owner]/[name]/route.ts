import { json, readGate } from "@/lib/server/access";
import { callExecutorRaw } from "@/lib/server/executor-client";

export const dynamic = "force-dynamic";

/** A log, screenshot, downloaded file or comparison the executor produced for a run or an application — served as plain data, never as HTML. */
export async function GET(request: Request, ctx: { params: Promise<{ owner: string; name: string }> }) {
  const gate = readGate(request);
  if (!gate.ok) return json({ error: { code: "forbidden", message: gate.reason } }, gate.status);
  const { owner, name } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/.test(owner) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) return json({ error: { code: "not_found", message: "Artefato não encontrado." } }, 404);
  const r = await callExecutorRaw(`/v1/artifacts/${owner}/${name}`);
  if (!r.ok) return json(r.body, r.status);
  return new Response(new Uint8Array(r.data), { status: 200, headers: { "content-type": r.contentType, "cache-control": "no-store", "x-content-type-options": "nosniff", "content-disposition": `inline; filename="${name}"` } });
}

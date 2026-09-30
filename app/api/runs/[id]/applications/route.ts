import { json, readGate } from "@/lib/server/access";
import { callExecutor } from "@/lib/server/executor-client";

export const dynamic = "force-dynamic";

/** Every application (and its verification) of the Developer runs of one plan. */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = readGate(request);
  if (!gate.ok) return json({ error: { code: "forbidden", message: gate.reason } }, gate.status);
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return json({ error: { code: "not_found", message: "Plano não encontrado." } }, 404);
  const r = await callExecutor(`/v1/runs/${id}/applications`);
  return json(r.body, r.status);
}

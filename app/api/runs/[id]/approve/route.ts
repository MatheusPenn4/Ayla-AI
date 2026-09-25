import { executionGate, json } from "@/lib/server/access";
import { callExecutor } from "@/lib/server/executor-client";

export const dynamic = "force-dynamic";

/** “Enviar ao Arquiteto”, step 2: the user's confirmation of the reviewed content (by its hash). */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = executionGate(request);
  if (!gate.ok) return json({ error: { code: "forbidden", message: gate.reason } }, gate.status);
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return json({ error: { code: "not_found", message: "Execução não encontrada." } }, 404);
  let body: { snapshotHash?: unknown } = {};
  try { body = ((await request.json()) as typeof body) ?? {}; } catch { body = {}; }
  const r = await callExecutor(`/v1/runs/${id}/approve`, { method: "POST", body: { snapshotHash: typeof body.snapshotHash === "string" ? body.snapshotHash : "" } });
  return json(r.body, r.status);
}

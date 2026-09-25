import { executionGate, json } from "@/lib/server/access";
import { callExecutor } from "@/lib/server/executor-client";

export const dynamic = "force-dynamic";

/** Cancels a run: the executor stops the official client's process. Usage already consumed may still count. */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = executionGate(request);
  if (!gate.ok) return json({ error: { code: "forbidden", message: gate.reason } }, gate.status);
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return json({ error: { code: "not_found", message: "Execução não encontrada." } }, 404);
  const r = await callExecutor(`/v1/runs/${id}/cancel`, { method: "POST", body: {} });
  return json(r.body, r.status);
}

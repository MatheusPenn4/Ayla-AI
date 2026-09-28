import { executionGate, json } from "@/lib/server/access";
import { callExecutor } from "@/lib/server/executor-client";

export const dynamic = "force-dynamic";

/** "Testar sessão" for an API connection: a real minimal call through the stored key (uses a little of the API's own paid usage). */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = executionGate(request);
  if (!gate.ok) return json({ error: { code: "forbidden", message: gate.reason } }, gate.status);
  const { id } = await ctx.params;
  const r = await callExecutor(`/v1/api-connections/${encodeURIComponent(id)}/verify`, { method: "POST", body: {}, timeoutMs: 65_000 });
  return json(r.body, r.status);
}

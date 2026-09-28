import { executionGate, json } from "@/lib/server/access";
import { callExecutor } from "@/lib/server/executor-client";

export const dynamic = "force-dynamic";

/** Removes a configured API-key connection. Sheets that still reference it fail with a clear message at run time. */
export async function DELETE(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = executionGate(request);
  if (!gate.ok) return json({ error: { code: "forbidden", message: gate.reason } }, gate.status);
  const { id } = await ctx.params;
  const r = await callExecutor(`/v1/api-connections/${encodeURIComponent(id)}`, { method: "DELETE" });
  return json(r.body, r.status);
}

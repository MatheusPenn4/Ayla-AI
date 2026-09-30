import { executionGate, json } from "@/lib/server/access";
import { callExecutor } from "@/lib/server/executor-client";

export const dynamic = "force-dynamic";

/** Starts the project's own checks on the applied version, in an isolated environment (background, cancellable). */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = executionGate(request);
  if (!gate.ok) return json({ error: { code: "forbidden", message: gate.reason } }, gate.status);
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return json({ error: { code: "not_found", message: "Aplicação não encontrada." } }, 404);
  const r = await callExecutor(`/v1/applications/${id}/verify`, { method: "POST", body: {} });
  return json(r.body, r.status);
}

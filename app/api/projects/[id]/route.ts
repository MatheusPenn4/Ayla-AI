import { executionGate, json } from "@/lib/server/access";
import { callExecutor } from "@/lib/server/executor-client";

export const dynamic = "force-dynamic";

/** Removes a project registered in the interface (AYLA_LOCAL_REPOS entries are edited in .dev.vars). */
export async function DELETE(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = executionGate(request);
  if (!gate.ok) return json({ error: { code: "forbidden", message: gate.reason } }, gate.status);
  const { id } = await ctx.params;
  if (!/^[A-Za-z0-9-]{4,64}$/.test(id)) return json({ error: { code: "not_found", message: "Projeto não encontrado." } }, 404);
  const r = await callExecutor(`/v1/projects/${id}`, { method: "DELETE" });
  return json(r.body, r.status);
}

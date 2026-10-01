import { json, readGate } from "@/lib/server/access";
import { callExecutor } from "@/lib/server/executor-client";

export const dynamic = "force-dynamic";

/** Branches and tags of an authorized project (the project is named by its id; the executor does the Git reading). */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = readGate(request);
  if (!gate.ok) return json({ error: { code: "forbidden", message: gate.reason } }, gate.status);
  const { id } = await ctx.params;
  if (!/^[A-Za-z0-9-]{4,64}$/.test(id)) return json({ error: { code: "not_found", message: "Projeto não encontrado." } }, 404);
  const r = await callExecutor(`/v1/projects/${id}/refs`, { timeoutMs: 30_000 });
  return json(r.body, r.status);
}

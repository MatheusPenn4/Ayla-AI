import { executionGate, json } from "@/lib/server/access";
import { callExecutor } from "@/lib/server/executor-client";

export const dynamic = "force-dynamic";

/** The review before planning: the files and excerpts the Director would receive. No model is called, nothing is recorded. */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = executionGate(request);
  if (!gate.ok) return json({ error: { code: "forbidden", message: gate.reason } }, gate.status);
  const { id } = await ctx.params;
  if (!/^[A-Za-z0-9-]{4,64}$/.test(id)) return json({ error: { code: "not_found", message: "Projeto não encontrado." } }, 404);
  const text = await request.text();
  if (text.length > 100_000) return json({ error: { code: "too_large", message: "Dados grandes demais." } }, 413);
  let body: unknown;
  try { body = JSON.parse(text || "{}"); } catch { return json({ error: { code: "invalid_body", message: "Corpo da requisição inválido." } }, 400); }
  const r = await callExecutor(`/v1/projects/${id}/context-preview`, { method: "POST", body, timeoutMs: 60_000 });
  return json(r.body, r.status);
}

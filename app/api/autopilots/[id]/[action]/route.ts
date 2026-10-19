import { executionGate, json } from "@/lib/server/access";
import { callExecutor } from "@/lib/server/executor-client";

export const dynamic = "force-dynamic";

const ACTIONS = new Set(["approve", "pause", "resume", "cancel"]);

/**
 * Piloto automático: confirm (approve, by the policy hash), pause, resume (by the same hash) or end (cancel) a
 * policy. Only the policy hash is forwarded; nothing else from the browser can change what the policy allows.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string; action: string }> }) {
  const gate = executionGate(request);
  if (!gate.ok) return json({ error: { code: "forbidden", message: gate.reason } }, gate.status);
  const { id, action } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/.test(id) || !ACTIONS.has(action)) return json({ error: { code: "not_found", message: "Piloto automático não encontrado." } }, 404);
  let body: { policyHash?: unknown } = {};
  try { body = ((await request.json()) as typeof body) ?? {}; } catch { body = {}; }
  const r = await callExecutor(`/v1/autopilots/${id}/${action}`, { method: "POST", body: { policyHash: typeof body.policyHash === "string" ? body.policyHash : "" }, timeoutMs: 30_000 });
  return json(r.body, r.status);
}

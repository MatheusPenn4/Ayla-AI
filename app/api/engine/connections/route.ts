import { executionGate, json } from "@/lib/server/access";
import { callExecutor } from "@/lib/server/executor-client";

export const dynamic = "force-dynamic";

/**
 * “Verificar conexão”: asks the executor to re-run the official clients' status
 * commands. With { id, probe: true } it makes one minimal real call to confirm
 * the session (uses a little of the subscription; only on explicit request).
 */
export async function POST(request: Request) {
  const gate = executionGate(request);
  if (!gate.ok) return json({ error: { code: "forbidden", message: gate.reason } }, gate.status);
  let body: { id?: unknown; probe?: unknown } = {};
  try { body = ((await request.json()) as typeof body) ?? {}; } catch { body = {}; }
  const probe = body.probe === true;
  const r = await callExecutor("/v1/connections/check", { method: "POST", body: probe ? { id: body.id, probe: true } : {}, timeoutMs: probe ? 150_000 : 60_000 });
  return json(r.body, r.status);
}

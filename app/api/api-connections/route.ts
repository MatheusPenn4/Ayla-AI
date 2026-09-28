import { executionGate, json, readGate } from "@/lib/server/access";
import { callExecutor } from "@/lib/server/executor-client";

export const dynamic = "force-dynamic";

/** List of configured API-key connections (masked; the key itself never leaves the executor). */
export async function GET(request: Request) {
  const gate = readGate(request);
  if (!gate.ok) return json({ error: { code: "forbidden", message: gate.reason } }, gate.status);
  const r = await callExecutor("/v1/api-connections");
  return json(r.body, r.status);
}

/** Registers a new API-key connection. The key is encrypted at rest in the executor; only the masked record comes back. */
export async function POST(request: Request) {
  const gate = executionGate(request);
  if (!gate.ok) return json({ error: { code: "forbidden", message: gate.reason } }, gate.status);
  const text = await request.text();
  if (text.length > 2_000) return json({ error: { code: "too_large", message: "Dados grandes demais." } }, 413);
  let body: unknown;
  try { body = JSON.parse(text); } catch { return json({ error: { code: "invalid_body", message: "Corpo da requisição inválido." } }, 400); }
  const r = await callExecutor("/v1/api-connections", { method: "POST", body, timeoutMs: 15_000 });
  return json(r.body, r.status);
}

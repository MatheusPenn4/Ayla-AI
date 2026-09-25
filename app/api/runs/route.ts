import { executionGate, json, readGate } from "@/lib/server/access";
import { callExecutor } from "@/lib/server/executor-client";

export const dynamic = "force-dynamic";

/**
 * Starts "Planejar com o Diretor" for a demand. The executor validates the
 * input, deduplicates repeated clicks, stores the run and processes it in its
 * own process; this request returns immediately (202) and the page polls.
 */
export async function POST(request: Request) {
  const gate = executionGate(request);
  if (!gate.ok) return json({ error: { code: "forbidden", message: gate.reason } }, gate.status);
  const text = await request.text();
  if (text.length > 900_000) return json({ error: { code: "too_large", message: "Dados grandes demais." } }, 413);
  let body: unknown;
  try { body = JSON.parse(text); } catch { return json({ error: { code: "invalid_body", message: "Corpo da requisição inválido." } }, 400); }
  const r = await callExecutor("/v1/runs", { method: "POST", body });
  return json(r.body, r.status);
}

/** Runs of the given demands (?demands=a,b), newest first. */
export async function GET(request: Request) {
  const gate = readGate(request);
  if (!gate.ok) return json({ error: { code: "forbidden", message: gate.reason } }, gate.status);
  const ids = (new URL(request.url).searchParams.get("demands") ?? "").split(",").map(s => s.trim()).filter(s => /^[A-Za-z0-9_-]{1,64}$/.test(s)).slice(0, 200);
  const r = await callExecutor(`/v1/runs?demands=${ids.join(",")}`);
  return json(r.body, r.status);
}

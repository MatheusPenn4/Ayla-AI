import { environmentGate, json } from "@/lib/server/access";
import { EXECUTOR_OFFLINE, callExecutor } from "@/lib/server/executor-client";
import type { EngineStatus } from "@/lib/engine/types";

export const dynamic = "force-dynamic";

/** Engine status: web gate + what the local executor reports (connections, store, limits). Never returns secrets. */
export async function GET(request: Request) {
  const gate = environmentGate(request);
  const refresh = new URL(request.url).searchParams.get("refresh") === "1";
  const ex = gate.ok ? await callExecutor(`/v1/status${refresh ? "?refresh=1" : ""}`, { timeoutMs: 60_000 }) : null;
  const ok = !!ex && ex.status === 200;
  const exErr = ex && !ok ? ((ex.body as { error?: { message?: string } }).error?.message ?? EXECUTOR_OFFLINE) : null;
  const fromExecutor = ok ? (ex!.body as Omit<EngineStatus, "executionEnabled" | "disabledReason">) : null;
  const body: EngineStatus = {
    executor: fromExecutor?.executor ?? { reachable: false, message: gate.ok ? exErr : gate.reason, version: null },
    executionEnabled: gate.ok && ok,
    disabledReason: !gate.ok ? gate.reason : ok ? null : exErr,
    store: fromExecutor?.store ?? { ok: false, kind: "none", path: null, message: exErr },
    connections: fromExecutor?.connections ?? {},
    github: fromExecutor?.github ?? { mode: "public-only", tokenConfigured: false },
    limits: fromExecutor?.limits ?? { maxRunsPerHour: 0, maxConcurrentRuns: 0, callTimeoutMs: 0 },
    executableAgents: fromExecutor?.executableAgents ?? ["director"],
  };
  return json(body);
}

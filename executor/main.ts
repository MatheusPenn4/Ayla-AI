// Setor IA — local executor.
// Start with: pnpm executor   (see docs/executor-local.md)
//
// Runs on this computer only. It uses the official clients (Claude Code and
// Codex CLI) with the logins they keep themselves; it never reads, copies or
// stores account credentials.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createExecutorServer } from "@/lib/executor/http";
import { runProcess } from "@/lib/executor/proc";
import { ExecutorService } from "@/lib/executor/service";
import { sqliteDriver } from "@/lib/executor/sqlite";
import { RunStore } from "@/lib/executor/store";

const VERSION = "0.1.0";
const root = process.cwd();
const devVarsPath = path.join(root, ".dev.vars");

function readDevVars(): Record<string, string> {
  if (!existsSync(devVarsPath)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(devVarsPath, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
  }
  return out;
}

const num = (v: string | undefined, fallback: number, min: number, max: number) => {
  const n = Number(v);
  return v && Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback;
};

const vars = { ...readDevVars(), ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("AYLA_")) as [string, string][]) };
const port = num(vars.AYLA_EXECUTOR_PORT, 4317, 1024, 65535);
let token = vars.AYLA_EXECUTOR_TOKEN ?? "";
let createdToken = false;
if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) {
  // Local secret shared only between the Next server and this executor (.dev.vars is gitignored).
  token = randomBytes(32).toString("base64url");
  const url = `http://127.0.0.1:${port}`;
  const current = existsSync(devVarsPath) ? readFileSync(devVarsPath, "utf8") : "";
  const kept = current.split(/\r?\n/).filter(l => !/^\s*AYLA_EXECUTOR_(TOKEN|URL)\s*=/.test(l)).join("\n").trim();
  writeFileSync(devVarsPath, `${kept ? kept + "\n" : ""}# Executor local do Setor IA (gerado automaticamente; não versionar)\nAYLA_EXECUTOR_URL=${url}\nAYLA_EXECUTOR_TOKEN=${token}\n`, { encoding: "utf8", mode: 0o600 });
  createdToken = true;
}

const dataDir = path.join(root, ".ayla");
const storePath = path.join(dataDir, "runs.sqlite");
const driver = sqliteDriver(storePath);
const store = new RunStore(driver);
const service = new ExecutorService(
  {
    version: VERSION, dataDir, storePath,
    workRoot: path.join(os.tmpdir(), "ayla-executor"),
    limits: {
      maxRunsPerHour: num(vars.AYLA_MAX_RUNS_PER_HOUR, 20, 1, 500),
      maxConcurrentRuns: num(vars.AYLA_MAX_CONCURRENT_RUNS, 1, 1, 4),
      callTimeoutMs: num(vars.AYLA_CALL_TIMEOUT_MS, 300_000, 30_000, 900_000),
      leaseMs: 90_000,
      statusCacheMs: 20_000,
    },
    github: {
      token: process.env.GITHUB_TOKEN?.trim() || vars.GITHUB_TOKEN || undefined,
      apiBase: vars.AYLA_GITHUB_API_BASE || undefined,
      rawBase: vars.AYLA_GITHUB_RAW_BASE || undefined,
    },
  },
  { store, runner: runProcess, env: process.env },
);

await service.boot();
const server = createExecutorServer(service, { token, port });
server.on("error", e => {
  console.error(`[executor] não foi possível escutar em 127.0.0.1:${port}: ${(e as Error).message}`);
  process.exit(1);
});
server.listen(port, "127.0.0.1", () => {
  console.log(`[executor] Setor IA executor ${VERSION} em http://127.0.0.1:${port} (somente este computador)`);
  console.log(`[executor] registros: ${storePath}`);
  if (createdToken) console.log("[executor] token local criado em .dev.vars. Se o `pnpm dev` já estava aberto, reinicie-o para ele ler o token.");
  void service.status(true).then(st => {
    for (const c of Object.values(st.connections)) if (c) console.log(`[executor] ${c.client}: ${c.state}${c.version ? ` (${c.version})` : ""} — ${c.message}`);
  });
});

const shutdown = () => {
  console.log("[executor] encerrando: execuções em andamento serão marcadas como interrompidas no próximo início.");
  service.abortAll();
  server.close();
  setTimeout(() => { driver.close(); process.exit(0); }, 1500).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

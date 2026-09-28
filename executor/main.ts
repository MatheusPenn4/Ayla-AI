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
import { randomMachineKeyB64 } from "@/lib/executor/secret-store";
import { ExecutorService } from "@/lib/executor/service";
import { sqliteDriver } from "@/lib/executor/sqlite";
import { RunStore, SCHEMA_VERSION } from "@/lib/executor/store";

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

// Machine key that encrypts API-connection secrets at rest (see lib/executor/secret-store.ts). Same
// gitignored, mode-0600 file as the executor token above; generated once and kept across restarts.
let secretKeyB64 = vars.AYLA_SECRET_KEY ?? "";
if (!/^[A-Za-z0-9+/]{40,50}=*$/.test(secretKeyB64)) {
  secretKeyB64 = randomMachineKeyB64();
  const current = existsSync(devVarsPath) ? readFileSync(devVarsPath, "utf8") : "";
  const kept = current.split(/\r?\n/).filter(l => !/^\s*AYLA_SECRET_KEY\s*=/.test(l)).join("\n").trim();
  writeFileSync(devVarsPath, `${kept ? kept + "\n" : ""}AYLA_SECRET_KEY=${secretKeyB64}\n`, { encoding: "utf8", mode: 0o600 });
  console.log("[executor] chave local de criptografia das conexões de API criada em .dev.vars.");
}

const dataDir = path.join(root, ".ayla");
const storePath = path.join(dataDir, "runs.sqlite");
const driver = sqliteDriver(storePath);
const store = new RunStore(driver);
// Schema upgrade keeps every existing row; a full copy is taken first anyway.
if (await store.needsMigration()) {
  const backup = path.join(dataDir, `runs.backup-before-v${SCHEMA_VERSION}-${new Date().toISOString().replace(/[:.]/g, "-")}.sqlite`);
  await store.backupTo(backup);
  console.log(`[executor] registro atualizado para a versão ${SCHEMA_VERSION}; cópia de segurança da versão anterior: ${backup}`);
}
const service = new ExecutorService(
  {
    version: VERSION, dataDir, storePath,
    workRoot: path.join(os.tmpdir(), "ayla-executor"),
    limits: {
      maxRunsPerHour: num(vars.AYLA_MAX_RUNS_PER_HOUR, 20, 1, 500),
      maxConcurrentRuns: num(vars.AYLA_MAX_CONCURRENT_RUNS, 1, 1, 4),
      // 10 minutes: a structured analysis with a large context took more than 5 minutes in a real run (26/09/2026).
      callTimeoutMs: num(vars.AYLA_CALL_TIMEOUT_MS, 600_000, 30_000, 1_800_000),
      leaseMs: 90_000,
      statusCacheMs: 20_000,
    },
    // Read-only access to local clones must be granted explicitly, one absolute folder per entry (";"-separated).
    localRepos: (vars.AYLA_LOCAL_REPOS ?? "").split(";").map(x => x.trim()).filter(x => path.isAbsolute(x)),
    secretKeyB64,
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

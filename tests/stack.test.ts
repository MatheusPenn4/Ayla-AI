// Frontend and API on different ports: configuration rules, processes started with real addresses resolved BEFORE
// they start, the browser limited to exact authorized origins (redirects and WebSockets included), CORS diagnosis,
// cancellation. Real processes, real sockets and — when installed — the real Edge/Chrome. No model anywhere.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectRunConfig } from "@/lib/engine/types";
import { inspectOrigin, startGuardProxy, whyBlocked } from "@/lib/executor/net-guard";
import { mainServiceOf, servicesOf, validateConfig } from "@/lib/executor/project-config";
import { runProcess, spawnBackground, type BackgroundProcess, type BackgroundSpawner } from "@/lib/executor/proc";
import { findBrowser, runScenario, type BrowserStep } from "@/lib/executor/qa-browser";
import { prepareDependencies, type EnvDeps, type ExecPlan, type QAEnv } from "@/lib/executor/qa-env";
import { startStack } from "@/lib/executor/qa-stack";

let work: string;
beforeEach(() => { work = mkdtempSync(path.join(os.tmpdir(), "ayla-stk-")); });
afterEach(() => { rmSync(work, { recursive: true, force: true, maxRetries: 3 }); });

const CONTROL = [4317, 5173];
const w = (rel: string, text: string) => { const f = path.join(work, "repo", ...rel.split("/")); mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, text); };
const LOCK = JSON.stringify({ name: "x", version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "x", version: "1.0.0" } } });

const WEB = `import http from "node:http";
const API = process.env.API_URL || "", THIRD = process.env.THIRD_URL || "";
console.log("web iniciada com API_URL=" + API);
http.createServer((req, res) => {
  if (req.url === "/health") return res.end("ok");
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(\`<!doctype html><title>Web</title><body><h1>Painel</h1><p id=c>Contagem: ...</p>
<button onclick="inc()">Incrementar</button><button onclick="reset()">Zerar</button><button onclick="third()">Chamar terceiro</button><button onclick="redir()">Redirecionar</button><button onclick="sock()">Abrir socket</button><p id=s></p>
<script>
const API=\${JSON.stringify(API)}, THIRD=\${JSON.stringify(THIRD)};
function s(t){document.getElementById("s").textContent=t}
async function load(){try{const r=await fetch(API+"/count");const j=await r.json();document.getElementById("c").textContent="Contagem: "+j.count}catch(e){document.getElementById("c").textContent="Contagem: erro "+e.message}}
async function inc(){await fetch(API+"/inc",{method:"POST"});load()}
async function reset(){await fetch(API+"/reset",{method:"POST"});load()}
async function third(){try{await fetch(THIRD+"/dados");s("terceiro respondeu")}catch(e){s("terceiro bloqueado")}}
async function redir(){try{const r=await fetch(API+"/redir");s("redirecionamento passou: "+await r.text())}catch(e){s("redirecionamento bloqueado")}}
function sock(){const x=new WebSocket(THIRD.replace("http","ws")+"/ws");x.onopen=()=>s("socket aberto");x.onerror=()=>s("socket bloqueado");x.onclose=()=>s("socket bloqueado")}
load();
</script></body>\`);
}).listen(Number(process.env.PORT), "127.0.0.1");
`;
const API = `import http from "node:http";
let count = Number(process.env.COUNT_START || 0);
const allow = process.env.CORS_ORIGIN || "";
console.log("api iniciada; segredo de teste = " + (process.env.API_SECRET || ""));
http.createServer((req, res) => {
  if (allow) { res.setHeader("access-control-allow-origin", allow); res.setHeader("access-control-allow-methods", "GET,POST"); }
  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
  if (req.url === "/health") return res.end("ok");
  if (req.url === "/count") { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ count })); }
  if (req.url === "/inc" && req.method === "POST") { count++; return res.end("ok"); }
  if (req.url === "/reset" && req.method === "POST") { count = 0; return res.end("ok"); }
  if (req.url === "/redir") { res.statusCode = 302; res.setHeader("location", (process.env.THIRD_URL || "") + "/dados"); return res.end(); }
  res.statusCode = 404; res.end("nao");
}).listen(Number(process.env.PORT), "127.0.0.1");
`;
function makeRepo() {
  w("web/package.json", '{"name":"web","private":true}'); w("web/package-lock.json", LOCK); w("web/server.mjs", WEB);
  w("api/package.json", '{"name":"api","private":true}'); w("api/package-lock.json", LOCK); w("api/server.mjs", API);
  return path.join(work, "repo");
}

/** A third party the stack never lists: it records every request, so "blocked" can be proven by silence. */
async function thirdParty() {
  const hits: string[] = [];
  const s = http.createServer((q, r) => { hits.push(`${q.method} ${q.url}`); r.setHeader("access-control-allow-origin", "*"); r.end("SEGREDO_DO_TERCEIRO"); });
  s.on("upgrade", (q, socket) => {
    hits.push(`UPGRADE ${q.url}`);
    const accept = crypto.createHash("sha1").update(String(q.headers["sec-websocket-key"]) + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  });
  await new Promise<void>(r => s.listen(0, "127.0.0.1", r));
  return { hits, url: `http://127.0.0.1:${(s.address() as net.AddressInfo).port}`, close: () => s.close() };
}

const baseConfig = (over: Partial<ProjectRunConfig> = {}): ProjectRunConfig => ({
  workDir: "web", packageManager: "npm",
  commands: { install: "npm ci", typecheck: "", lint: "", test: "", build: "", dev: "node server.mjs", seed: "" },
  app: { host: "127.0.0.1", port: null, readyPath: "/health", readyText: "ok", timeoutSec: 30 },
  browserData: "app", env: [], acknowledgedAt: "x", updatedAt: "x",
  services: [
    { id: "api", label: "API", dir: "api", install: "npm ci", command: "node server.mjs", host: "127.0.0.1", port: null, readyPath: "/health", readyText: "ok", timeoutSec: 30, browser: true },
    { id: "web", label: "Frontend", dir: "web", install: "", command: "node server.mjs", host: "127.0.0.1", port: null, readyPath: "/health", readyText: "ok", timeoutSec: 30, browser: true },
  ],
  mainService: "web",
  links: [{ name: "API_URL", service: "api", as: "origin", suffix: "", to: ["web"] }, { name: "CORS_ORIGIN", service: "web", as: "origin", suffix: "", to: ["api"] }],
  ...over,
});

function envFor(repo: string): QAEnv {
  const tmp = path.join(work, "env-tmp"), art = path.join(work, "art");
  mkdirSync(tmp, { recursive: true }); mkdirSync(art, { recursive: true });
  return { root: work, srcDir: repo, hooksDir: "", tmpDir: tmp, artifactsDir: art, sourceDir: repo, version: { kind: "commit", projectId: "p", dirName: "repo", commit: "c".repeat(40), treeHash: "t", label: "teste" }, fileCount: 0 };
}
/** Spawner that remembers every pid, to prove nothing is left running. */
function trackedSpawner() {
  const pids: number[] = [];
  const spawnBg: BackgroundSpawner = spec => { const p: BackgroundProcess = spawnBackground(spec); if (p.pid) pids.push(p.pid); return p; };
  return { spawnBg, pids };
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const portOpen = (port: number) => new Promise<boolean>(r => { const c = net.connect(port, "127.0.0.1"); c.once("connect", () => { c.destroy(); r(true); }); c.once("error", () => r(false)); });
const step = (o: Partial<BrowserStep>): BrowserStep => ({ action: "wait", target: "", url_path: "", save_as: "", first: "", second: "", ignore_line_regex: "", setting: "", timeout_ms: 0, ...o });
const gone = async (pids: number[]) => { for (let i = 0; i < 30 && pids.some(alive); i++) await new Promise(r => setTimeout(r, 200)); return pids.filter(alive); };

const browser = findBrowser();

describe("origens: o que nunca pode ser autorizado e o que exige autorização explícita", { timeout: 30_000 }, () => {
  it("normaliza, classifica e recusa com motivo", () => {
    expect(inspectOrigin("http://localhost:3000", CONTROL)).toMatchObject({ ok: true, scope: "local", origin: "http://localhost:3000" });
    expect(inspectOrigin("https://sandbox.exemplo.com", CONTROL)).toMatchObject({ ok: true, scope: "external", port: 443 });
    const err = (o: string) => { const r = inspectOrigin(o, CONTROL); return r.ok ? "" : r.error; };
    expect(err("http://127.0.0.1:4317")).toContain("próprio Setor IA");
    expect(err("http://localhost:5173")).toContain("próprio Setor IA");
    expect(err("http://[::1]:4317")).toContain("próprio Setor IA");
    expect(err("http://localhost:5432")).toContain("PostgreSQL");
    expect(err("http://127.0.0.1:2375")).toContain("Docker");
    expect(err("http://169.254.169.254")).toContain("metadados");
    expect(err("ftp://localhost:3000")).toContain("só http e https");
    expect(err("http://localhost:3000/api")).toContain("sem caminho");
    expect(err("http://user:senha@localhost:3000")).toContain("usuário ou senha");
    expect(err("localhost:3000")).toContain("falta o protocolo");
    // a different port of a controlled host is fine; the same port on another (external) host is not our executor
    expect(inspectOrigin("http://127.0.0.1:4318", CONTROL).ok).toBe(true);
    expect(inspectOrigin("https://api.exemplo.com:4317", CONTROL).ok).toBe(true);
    expect(whyBlocked("http://127.0.0.1:9", [{ origin: "http://127.0.0.1:8", label: "app" }], CONTROL)).toContain("não é uma das origens autorizadas");
  });
});

describe("configuração de vários processos", { timeout: 30_000 }, () => {
  const run = (cfg: unknown, over: { names?: string[] } = {}) => validateConfig(cfg, makeRepo(), over.names ?? [], () => null, { controlPorts: CONTROL });
  const errors = (cfg: unknown) => { const r = run(cfg); return r.ok ? [] : r.errors; };

  it("aceita frontend + API, espelha o principal nos campos antigos e guarda ligações e origens", () => {
    const c = baseConfig();
    const r = run({ ...c, extraOrigins: [{ origin: "http://127.0.0.1:9100", label: "Mock de pagamento", external: false }] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.services?.map(s => s.id)).toEqual(["api", "web"]);
    expect(r.config.mainService).toBe("web");
    expect(r.config.commands.dev).toBe("node server.mjs"); // mirror for readers that only know the old fields
    expect(r.config.app.readyPath).toBe("/health");
    expect(r.config.extraOrigins).toEqual([{ origin: "http://127.0.0.1:9100", label: "Mock de pagamento", external: false }]);
    expect(r.config.links?.map(l => l.name)).toEqual(["API_URL", "CORS_ORIGIN"]);
  });

  it("recusa portas do Setor IA e de serviços sensíveis, comandos com shell e referências quebradas", () => {
    const c = baseConfig();
    const svc = (patch: object) => ({ ...c, services: c.services!.map((s, i) => (i === 0 ? { ...s, ...patch } : s)) });
    expect(errors(svc({ port: 4317 })).join(" ")).toContain("próprio Setor IA");
    expect(errors(svc({ port: 5173 })).join(" ")).toContain("próprio Setor IA");
    expect(errors(svc({ port: 5432 })).join(" ")).toContain("PostgreSQL");
    expect(errors(svc({ command: "node server.mjs && node outro.mjs" })).join(" ")).toContain("sem shell");
    expect(errors(svc({ command: "python app.py" })).join(" ")).toContain("deve começar com");
    expect(errors(svc({ dir: "nao-existe" })).join(" ")).toContain("não existe no repositório");
    expect(errors(svc({ dir: "../fora" })).join(" ")).toContain("pasta");
    expect(errors(svc({ id: "API Grande" })).join(" ")).toContain("identificador inválido");
    expect(errors(svc({ install: "npm ci", dir: "" })).join(" ")).toContain("lockfile");
    expect(errors({ ...c, services: [c.services![0], { ...c.services![1], port: 41000 }, { ...c.services![0], id: "api2", port: 41000 }] }).join(" ")).toContain("já é de outro processo");
    expect(errors({ ...c, links: [{ name: "X", service: "nao-existe", as: "origin", suffix: "", to: [] }] }).join(" ")).toContain("não existe");
    expect(errors({ ...c, links: [{ name: "PATH", service: "api", as: "origin", suffix: "", to: [] }] }).join(" ")).toContain("reservado");
    expect(errors({ ...c, mainService: "fantasma" }).join(" ")).toContain("Origem principal");
  });

  it("origens adicionais: locais por padrão; externas só com autorização explícita; nunca o executor", () => {
    const c = baseConfig();
    expect(errors({ ...c, extraOrigins: [{ origin: "https://sandbox.exemplo.com", label: "x", external: false }] }).join(" ")).toContain("exige autorização explícita");
    const ok = run({ ...c, extraOrigins: [{ origin: "https://sandbox.exemplo.com", label: "Sandbox", external: true }] });
    expect(ok.ok && ok.config.extraOrigins?.[0]).toMatchObject({ origin: "https://sandbox.exemplo.com", external: true });
    expect(errors({ ...c, extraOrigins: [{ origin: "http://127.0.0.1:4317", label: "x", external: true }] }).join(" ")).toContain("próprio Setor IA");
    expect(errors({ ...c, extraOrigins: [{ origin: "http://localhost:3000/rota", label: "x", external: false }] }).join(" ")).toContain("sem caminho");
  });

  it("configuração antiga (um servidor, sem services) continua válida e vira um processo só", () => {
    const old = { workDir: "web", packageManager: "npm", commands: { install: "npm ci", typecheck: "", lint: "", test: "", build: "", dev: "node server.mjs", seed: "" }, app: { host: "localhost", port: null, readyPath: "/health", readyText: "", timeoutSec: 60 }, browserData: "app", env: [] };
    const r = run(old);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.services).toBeUndefined(); // stored exactly as before: nothing to migrate
    const list = servicesOf({ ...r.config, services: r.config.services });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: "app", dir: "web", command: "node server.mjs", readyPath: "/health", browser: true });
    expect(mainServiceOf(r.config)?.id).toBe("app");
    expect(servicesOf({ ...r.config, commands: { ...r.config.commands, dev: "" } })).toEqual([]);
  });
});

describe("guarda de rede do navegador (sem navegador)", { timeout: 30_000 }, () => {
  it("só passam origens exatas; o resto recebe 403 com o motivo, e é contado", async () => {
    const ok = http.createServer((q, r) => r.end("ok-app")); await new Promise<void>(r => ok.listen(0, "127.0.0.1", r));
    const no = http.createServer((q, r) => r.end("nao-deveria")); await new Promise<void>(r => no.listen(0, "127.0.0.1", r));
    const okPort = (ok.address() as net.AddressInfo).port, noPort = (no.address() as net.AddressInfo).port;
    const guard = await startGuardProxy({ allowed: [{ origin: `http://127.0.0.1:${okPort}`, label: "app" }], controlPorts: CONTROL });
    const viaProxy = (target: string) => new Promise<{ status: number; body: string }>(resolve => {
      const u = new URL(target);
      http.get({ host: "127.0.0.1", port: guard.port, path: target, headers: { host: u.host } }, res => { let b = ""; res.on("data", d => (b += d)); res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b })); });
    });
    expect(await viaProxy(`http://127.0.0.1:${okPort}/x`)).toEqual({ status: 200, body: "ok-app" });
    const blocked = await viaProxy(`http://127.0.0.1:${noPort}/segredo`);
    expect(blocked.status).toBe(403);
    expect(blocked.body).toContain("não é uma das origens autorizadas");
    expect((await viaProxy("http://127.0.0.1:4317/v1/status")).status).toBe(403); // the executor's own port: never
    const st = guard.stats();
    expect(st.byOrigin[`http://127.0.0.1:${okPort}`]).toEqual({ allowed: 1, blocked: 0 });
    expect(st.byOrigin[`http://127.0.0.1:${noPort}`]).toEqual({ allowed: 0, blocked: 1 });
    expect(st.blocked[0]).toMatchObject({ method: "GET", target: `http://127.0.0.1:${noPort}/segredo` });
    await guard.close(); ok.close(); no.close();
  });
});

describe("vários processos de verdade", { timeout: 180_000 }, () => {
  const deps = (spawnBg: BackgroundSpawner, signal?: AbortSignal): EnvDeps => ({ git: { runner: runProcess, env: process.env }, spawnBg, nodePath: process.execPath, signal, controlPorts: CONTROL });
  const planFor = (cfg: ProjectRunConfig, vars: Record<string, string> = {}): ExecPlan => ({ config: cfg, vars });

  it("portas resolvidas antes, ligações congeladas, frontend fala com a API autorizada, estado de teste, recarga, terceira origem e redirecionamento bloqueados, nada sobra", async () => {
    if (!browser) return;
    const repo = makeRepo();
    const third = await thirdParty();
    const t = trackedSpawner();
    const env = envFor(repo);
    const plan = planFor(baseConfig(), { THIRD_URL: third.url, COUNT_START: "5", API_SECRET: "segredo-de-teste-xyz-123" });
    const d = deps(t.spawnBg);
    // The API folder has its own package: installed in its own folder, before anything starts.
    const prep = await prepareDependencies(env, plan, d);
    expect(prep.evidence.exitCode).toBe(0);
    expect(prep.network).toContain("API");
    expect(existsSync(path.join(env.artifactsDir, "deps-api.log"))).toBe(true);

    const stack = await startStack(env, plan, d, { controlPorts: CONTROL });
    const rep0 = stack.report();
    const [api, web] = [rep0.services.find(s => s.id === "api")!, rep0.services.find(s => s.id === "web")!];
    expect(api.port).not.toBe(web.port);
    expect(api.portKind).toBe("dinâmica");
    expect(rep0.main).toBe(web.origin);
    expect(rep0.links).toEqual([{ name: "API_URL", value: api.origin, to: ["web"] }, { name: "CORS_ORIGIN", value: web.origin, to: ["api"] }]);
    expect(rep0.allowedOrigins.map(a => a.origin).sort()).toEqual([api.origin, web.origin].sort());
    // Dynamic ports reached the frontend's variable: its own log says which API it was given.
    const art = env.artifactsDir;

    const res = await runScenario({
      appUrl: stack.url, policy: stack.policy, name: "painel", evidenceId: "E1", executable: browser.executable, artifactsDir: art, fixture: null, steps: [
        step({ action: "open", url_path: "/" }), step({ action: "wait_for_text", target: "Contagem: 5" }),
        step({ action: "click", target: "Incrementar" }), step({ action: "wait_for_text", target: "Contagem: 6" }),
        step({ action: "reload" }), step({ action: "wait_for_text", target: "Contagem: 6" }),
        step({ action: "click", target: "Chamar terceiro" }), step({ action: "wait_for_text", target: "terceiro bloqueado" }),
        step({ action: "click", target: "Redirecionar" }), step({ action: "wait_for_text", target: "redirecionamento bloqueado" }),
        step({ action: "click", target: "Abrir socket" }), step({ action: "wait_for_text", target: "socket bloqueado" }),
        step({ action: "click", target: "Zerar" }), step({ action: "wait_for_text", target: "Contagem: 0" }),
      ],
    });
    expect(res.ok, res.observed).toBe(true);
    expect(res.cors).toEqual([]);
    expect(res.api.passedToApp).toBeGreaterThan(3); // the API on its own origin counts as the test application's process
    // The third party never heard from the browser: no request, no redirect hop, no WebSocket handshake.
    expect(third.hits).toEqual([]);
    const g = stack.report().guard!;
    // Two layers, each with its reason: the direct call is refused by the page-level check (requests log); the hop
    // the browser followed after the API's redirect only exists at the network level, and the guard refused it.
    const thirdHost = third.url.replace("http://", "");
    const hops = g.blocked.filter(b => b.target.includes(thirdHost));
    expect(hops).toHaveLength(1);
    // The browser's own background traffic is refused too, but counted apart: it is not what the page did.
    expect(typeof g.browserBackground).toBe("number");
    expect(g.blocked.some(b => /bing|microsoft|office/i.test(b.target))).toBe(false);
    expect(hops[0]).toMatchObject({ method: "GET", target: `${third.url}/dados` });
    expect(hops[0].reason).toContain("não é uma das origens autorizadas");
    expect(g.byOrigin[api.origin].allowed).toBeGreaterThan(3);
    const requests = readFileSync(path.join(art, readdirSync(art).find(n => n.endsWith("requisicoes.log"))!), "utf8");
    expect(requests).toMatch(/BLOQUEADO \(origem não autorizada\) GET .*\/dados — .*não é uma das origens autorizadas/);
    expect(requests).toMatch(/BLOQUEADO \(WebSocket\)/);
    expect(requests).toMatch(/APLICAÇÃO EM TESTE \(API\) GET .*\/count/);

    const stopped = await stack.stop();
    expect(stopped).toContain("Frontend");
    expect(stopped).toContain("API");
    expect(await gone(t.pids)).toEqual([]);
    expect(await portOpen(api.port)).toBe(false);
    expect(await portOpen(web.port)).toBe(false);
    // Logs exist per process, the guard log lists the refusals, and no configured value leaked into any of them or into the report.
    const logs = readdirSync(art).filter(n => /^(servico-|guarda-)/.test(n));
    expect(logs).toEqual(expect.arrayContaining(["servico-api.log", "servico-web.log", "guarda-de-rede.log"]));
    const everything = logs.map(n => readFileSync(path.join(art, n), "utf8")).join("\n") + JSON.stringify(stack.report());
    expect(everything).not.toContain("segredo-de-teste-xyz-123");
    expect(readFileSync(path.join(art, "servico-api.log"), "utf8")).toContain("[valor de variável configurada omitido]");
    expect(readFileSync(path.join(art, "servico-web.log"), "utf8")).toContain(`API_URL=${api.origin}`);
    third.close();
  });

  it("CORS: sem a ligação, o diagnóstico aparece e nada é alterado no projeto", async () => {
    if (!browser) return;
    const repo = makeRepo();
    const t = trackedSpawner();
    const env = envFor(repo);
    const cfg = baseConfig({ links: [{ name: "API_URL", service: "api", as: "origin", suffix: "", to: ["web"] }] }); // no CORS_ORIGIN for the API
    const before = readFileSync(path.join(repo, "api", "server.mjs"), "utf8");
    const stack = await startStack(env, planFor(cfg), deps(t.spawnBg), { controlPorts: CONTROL });
    const res = await runScenario({ appUrl: stack.url, policy: stack.policy, name: "cors", evidenceId: "E2", executable: browser.executable, artifactsDir: env.artifactsDir, fixture: null, steps: [step({ action: "open", url_path: "/" }), step({ action: "wait_for_text", target: "Contagem: erro" })] });
    stack.addCors(res.cors);
    expect(res.cors.length).toBeGreaterThan(0);
    expect(res.cors[0]).toContain("NÃO altera o CORS do projeto");
    expect(res.cors[0]).toContain(stack.report().main);
    expect(stack.report().cors).toEqual(res.cors);
    await stack.stop();
    expect(readFileSync(path.join(repo, "api", "server.mjs"), "utf8")).toBe(before);
    expect(await gone(t.pids)).toEqual([]);
  });

  it("porta fixa ocupada recusa antes de iniciar qualquer processo; processo que não fica pronto encerra os já iniciados", async () => {
    const repo = makeRepo();
    const t = trackedSpawner();
    const env = envFor(repo);
    const busy = net.createServer(); await new Promise<void>(r => busy.listen(0, "127.0.0.1", r));
    const busyPort = (busy.address() as net.AddressInfo).port;
    const cfg = baseConfig(); cfg.services = cfg.services!.map(s => (s.id === "web" ? { ...s, port: busyPort } : s));
    await expect(startStack(env, planFor(cfg), deps(t.spawnBg))).rejects.toThrow(/já está em uso/);
    expect(t.pids).toEqual([]); // nothing started
    busy.close();
    // The web never gets ready (wrong ready text): the API that was already up is stopped too.
    const cfg2 = baseConfig(); cfg2.services = cfg2.services!.map(s => (s.id === "web" ? { ...s, readyText: "texto-que-nunca-aparece", timeoutSec: 10 } : s));
    await expect(startStack(env, planFor(cfg2), deps(t.spawnBg))).rejects.toThrow(/Frontend não ficou pronto/);
    expect(t.pids.length).toBe(2);
    expect(await gone(t.pids)).toEqual([]);
  });

  it("cancelar durante a subida encerra tudo o que já tinha sido iniciado", async () => {
    const repo = makeRepo();
    const t = trackedSpawner();
    const env = envFor(repo);
    const ac = new AbortController();
    const cfg = baseConfig(); cfg.services = cfg.services!.map(s => (s.id === "web" ? { ...s, readyText: "nunca", timeoutSec: 60 } : s));
    const starting = startStack(env, planFor(cfg), deps(t.spawnBg, ac.signal));
    const failed = starting.then(() => "subiu", e => (e as Error).message);
    for (let i = 0; i < 100 && t.pids.length < 2; i++) await new Promise(r => setTimeout(r, 100));
    expect(t.pids.length).toBe(2);
    ac.abort();
    expect(await failed).toMatch(/Cancelado/);
    expect(await gone(t.pids)).toEqual([]);
  });

  it("configuração de um servidor só (formato antigo) segue funcionando", async () => {
    const repo = makeRepo();
    const t = trackedSpawner();
    const env = envFor(repo);
    const old: ProjectRunConfig = { workDir: "api", packageManager: "npm", commands: { install: "npm ci", typecheck: "", lint: "", test: "", build: "", dev: "node server.mjs", seed: "" }, app: { host: "127.0.0.1", port: null, readyPath: "/health", readyText: "ok", timeoutSec: 30 }, browserData: "app", env: [], acknowledgedAt: "x", updatedAt: "x" };
    const stack = await startStack(env, planFor(old), deps(t.spawnBg));
    const r = stack.report();
    expect(r.services).toHaveLength(1);
    expect(r.services[0]).toMatchObject({ id: "app", main: true, dir: "api" });
    expect(r.allowedOrigins).toHaveLength(1);
    const body = await fetch(`${stack.url}/health`).then(x => x.text());
    expect(body).toBe("ok");
    await stack.stop();
    expect(await gone(t.pids)).toEqual([]);
  });
});

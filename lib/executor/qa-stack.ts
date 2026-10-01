// The application under test as a STACK of processes (a frontend and an API on different ports, or just one).
// - Every port is allocated BEFORE anything starts, so the addresses of all processes are known up front; the
//   variables that connect them (links: e.g. VITE_API_URL = origin of "api") are resolved from those addresses
//   and frozen for this run (recorded in the report). Fixed ports are used as configured (refused when busy).
// - Processes start in the configured order, each one only after the previous is ready (HTTP < 400 on its
//   ready path, plus the text when asked), with the same sandboxed environment, encrypted test variables and
//   cancellation as every other command; everything started here is stopped by stop() (reverse order).
// - The browser gets its own network guard (net-guard.ts): the main origin, the processes flagged for the
//   browser and the extra origins of the settings — exact origins; nothing else.
// - The executor never edits the project's CORS: when the page reports a CORS failure, the diagnosis says what
//   to set in the TEST environment (a link or a test variable).
import path from "node:path";
import type { StackReport } from "@/lib/engine/types";
import { inspectOrigin, startGuardProxy, DEFAULT_CONTROL_PORTS, SENSITIVE_PORTS, type GuardOrigin, type GuardProxy } from "./net-guard";
import { mainServiceOf, parseCommandLine, servicesOf } from "./project-config";
import type { BackgroundProcess } from "./proc";
import { freePort, portInUse, redactVars, resolveTool, sandboxEnv, writeArtifact, type EnvDeps, type ExecPlan, type QAEnv, type ToolName } from "./qa-env";

export type RunningStack = {
  /** Main origin (what the browser opens). */
  url: string;
  policy: { main: string; allowed: GuardOrigin[]; controlPorts: number[]; guardPort: number };
  /** Frozen topology plus what the guard has refused so far. */
  report: () => StackReport;
  /** Adds CORS diagnoses seen by the page (deduplicated). */
  addCors: (lines: string[]) => void;
  stop: () => Promise<string>;
};

const origin = (host: string, port: number) => `http://${host}:${port}`;
const reserved = (port: number, control: number[]) => control.includes(port) || !!SENSITIVE_PORTS[port];

async function pickPort(taken: Set<number>, control: number[]): Promise<number> {
  for (let i = 0; i < 30; i++) {
    const p = await freePort();
    if (!taken.has(p) && !reserved(p, control)) return p;
  }
  throw new Error("Não foi possível reservar uma porta livre para a aplicação em teste.");
}

export async function startStack(env: QAEnv, plan: ExecPlan, deps: EnvDeps, o: { controlPorts?: number[] } = {}): Promise<RunningStack> {
  const control = o.controlPorts?.length ? o.controlPorts : DEFAULT_CONTROL_PORTS;
  const services = servicesOf(plan.config);
  if (!services.length) throw new Error("O projeto não tem servidor de desenvolvimento configurado.");
  const main = mainServiceOf(plan.config)!;

  // 1. Addresses first: all ports before any process.
  const taken = new Set<number>();
  const resolved: { s: (typeof services)[number]; port: number; fixed: boolean }[] = [];
  for (const s of services) {
    if (s.port !== null) {
      if (reserved(s.port, control)) throw new Error(`${s.label}: a porta ${s.port} não pode ser usada (${control.includes(s.port) ? "é do próprio Setor IA" : `serviço local sensível: ${SENSITIVE_PORTS[s.port]}`}).`);
      if (taken.has(s.port)) throw new Error(`${s.label}: a porta ${s.port} está repetida na configuração.`);
      if (await portInUse(s.port)) throw new Error(`${s.label}: a porta configurada ${s.port} já está em uso neste computador; nada foi iniciado (feche o que a usa ou deixe a porta vazia para uma porta livre).`);
      taken.add(s.port); resolved.push({ s, port: s.port, fixed: true });
    } else {
      const port = await pickPort(taken, control);
      taken.add(port); resolved.push({ s, port, fixed: false });
    }
  }
  const byId = new Map(resolved.map(r => [r.s.id, r]));
  // 2. Links, resolved from those addresses (frozen for this run).
  const links = (plan.config.links ?? []).map(l => {
    const t = byId.get(l.service);
    if (!t) throw new Error(`A variável ${l.name} aponta para o processo “${l.service}”, que não existe na configuração.`);
    const value = l.as === "port" ? String(t.port) : l.as === "host" ? t.s.host : `${origin(t.s.host, t.port)}${l.suffix}`;
    return { name: l.name, value, to: l.to.length ? l.to : services.map(s => s.id) };
  });
  // 3. Where the browser may go.
  const allowed: GuardOrigin[] = [{ origin: origin(main.host, byId.get(main.id)!.port), label: `${main.label} (aplicação principal)` }];
  for (const r of resolved) if (r.s.id !== main.id && r.s.browser) allowed.push({ origin: origin(r.s.host, r.port), label: r.s.label });
  const authorized: StackReport["allowedOrigins"] = allowed.map((a, i) => ({ origin: a.origin, label: a.label, why: i === 0 ? "origem principal da aplicação" : "processo da aplicação liberado ao navegador", external: false }));
  for (const x of plan.config.extraOrigins ?? []) {
    const info = inspectOrigin(x.origin, control);
    if (!info.ok) throw new Error(`Origem adicional recusada: ${info.error}.`);
    if (info.scope === "external" && !x.external) throw new Error(`A origem ${info.origin} é externa a este computador e a configuração não a autoriza explicitamente.`);
    if (!allowed.some(a => a.origin === info.origin)) { allowed.push({ origin: info.origin, label: x.label || info.origin }); authorized.push({ origin: info.origin, label: x.label || info.origin, why: info.scope === "external" ? "origem EXTERNA autorizada explicitamente na configuração" : "origem local adicional da configuração", external: info.scope === "external" }); }
  }

  // 4. Start in order, each one ready before the next.
  const started: { r: (typeof resolved)[number]; proc: BackgroundProcess; readyNote: string }[] = [];
  const stopAll = async () => {
    const notes: string[] = [];
    for (const x of [...started].reverse()) {
      try {
        writeArtifact(env.artifactsDir, `servico-${x.r.s.id}.log`, redactVars(x.proc.output(), plan.vars), "log", `Saída do processo “${x.r.s.label}” (porta ${x.r.port})`);
        await x.proc.stop();
        notes.push(`${x.r.s.label} (porta ${x.r.port}) encerrado`);
      } catch { notes.push(`falha ao encerrar ${x.r.s.label}`); }
    }
    return notes.join("; ") || "nenhum processo iniciado";
  };
  try {
    for (const r of resolved) {
      const s = r.s;
      if (deps.signal?.aborted) throw new Error("Cancelado.");
      const parsed = parseCommandLine(s.command, { manager: plan.config.packageManager, allowPort: true });
      if (!parsed.ok) throw new Error(`${s.label}: comando inválido (${parsed.error}).`);
      const argv = parsed.argv.map(a => a.replaceAll("{port}", String(r.port)));
      const tool = resolveTool(argv[0] as ToolName, deps);
      if (!tool.ok) throw new Error(`${s.label}: ${tool.detail}`);
      const linkVars: Record<string, string> = {};
      for (const l of links) if (l.to.includes(s.id)) linkVars[l.name] = l.value;
      const cwd = path.join(env.srcDir, ...s.dir.split("/").filter(Boolean));
      const proc = deps.spawnBg({ command: tool.command, args: [...tool.prefix, ...argv.slice(1)], cwd, env: { ...sandboxEnv(deps.git.env, env, { ...plan.vars, ...linkVars }), PORT: String(r.port) }, signal: deps.signal });
      const entry = { r, proc, readyNote: "" };
      started.push(entry);
      const url = origin(s.host, r.port);
      const t0 = Date.now();
      const limit = s.timeoutSec * 1000;
      let exited = false, last = "sem resposta";
      void proc.exited.then(() => { exited = true; });
      let ok = false;
      while (Date.now() - t0 < limit) {
        if (deps.signal?.aborted) throw new Error("Cancelado.");
        if (exited) break;
        try {
          const res = await fetch(url + s.readyPath, { signal: AbortSignal.timeout(20_000), redirect: "manual" });
          const body = s.readyText ? await res.text() : "";
          last = `HTTP ${res.status}${s.readyText && !body.includes(s.readyText) ? ` sem o texto “${s.readyText}”` : ""}`;
          if (res.status < 400 && (!s.readyText || body.includes(s.readyText))) { ok = true; entry.readyNote = `${last} em ${Date.now() - t0} ms`; break; }
        } catch { /* not up yet */ }
        await new Promise(res => setTimeout(res, 500));
      }
      if (!ok) {
        const out = redactVars(proc.output(), plan.vars);
        throw new Error(`${s.label} não ficou pronto em ${url}${s.readyPath} (${exited ? "o processo terminou" : `tempo esgotado em ${s.timeoutSec} s`}; última resposta: ${last}). Saída: ${out.slice(-600)}`);
      }
    }
  } catch (e) {
    await stopAll();
    throw e;
  }

  // 5. The browser's guard.
  let guard: GuardProxy;
  try { guard = await startGuardProxy({ allowed, controlPorts: control }); }
  catch (e) { await stopAll(); throw new Error(`Não foi possível iniciar o guarda de rede do navegador: ${(e as Error).message}`); }

  const cors = new Set<string>();
  const frozen: Omit<StackReport, "guard" | "cors" | "stopped"> = {
    main: allowed[0].origin,
    services: resolved.map(r => ({ id: r.s.id, label: r.s.label, dir: r.s.dir, command: r.s.command, origin: origin(r.s.host, r.port), port: r.port, portKind: r.fixed ? "fixa" : "dinâmica", ready: started.find(x => x.r === r)?.readyNote ?? "", main: r.s.id === main.id, browser: r.s.id === main.id || r.s.browser })),
    allowedOrigins: authorized,
    links: links.map(l => ({ name: l.name, value: l.value, to: l.to })),
  };
  let stopped = "";
  return {
    url: allowed[0].origin,
    policy: { main: allowed[0].origin, allowed, controlPorts: control, guardPort: guard.port },
    report: () => ({ ...frozen, guard: guard.stats(), cors: [...cors], stopped }),
    addCors: lines => { for (const l of lines) cors.add(l); },
    stop: async () => {
      const g = guard.stats();
      await guard.close();
      writeArtifact(env.artifactsDir, "guarda-de-rede.log", [
        "Guarda de rede do navegador de teste (limita o NAVEGADOR; não isola a rede dos comandos do projeto).",
        `Origens autorizadas: ${allowed.map(a => `${a.origin} [${a.label}]`).join(", ")}`,
        ...Object.entries(g.byOrigin).map(([o, c]) => `${o}: ${c.allowed} permitida(s), ${c.blocked} bloqueada(s)`),
        "", `Bloqueios (${g.blockedTotal}):`, ...g.blocked.map(b => `${b.at} ${b.method} ${b.target} — ${b.reason}`),
      ].join("\n"), "log", "Origens permitidas e bloqueadas no navegador");
      stopped = await stopAll();
      return stopped;
    },
  };
}

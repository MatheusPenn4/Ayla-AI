// Execution settings of a local project (Configurações → Projetos locais → Configurar execução): which package
// manager, which commands, which folder, how the app under test starts and when it is ready, and the variables
// its test environment needs. The executor detects what the project already has and SUGGESTS it; nothing runs
// until the user saved the settings acknowledging that these commands execute the project's own code.
// Rules enforced here (never left to the interface):
// - a command is a command line run WITHOUT a shell: no pipes, redirections or command chaining; it starts
//   with the project's own package manager (the one its lockfile belongs to), npx (npm projects) or node; no
//   absolute paths and no ".." — it only reaches files of the isolated copy;
// - "" = not configured: shown as such, never counted as a passing check;
// - the working folder is relative to the authorized root (for repositories with the package in a subfolder);
// - variables are for the test environment only, stored encrypted by the service and never returned; a value
//   pointing to an address outside this computer is refused unless the user explicitly allowed it (so tests do
//   not reach real data by default).
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { ProjectExtraOrigin, ProjectLink, ProjectRunConfig, ProjectRunDetection, ProjectService, SupportedPackageManager } from "@/lib/engine/types";
import { relPathProblem } from "./apply";
import { DEFAULT_CONTROL_PORTS, SENSITIVE_PORTS, inspectOrigin } from "./net-guard";

export const SUPPORTED_MANAGERS: SupportedPackageManager[] = ["npm", "pnpm"];
export const COMMAND_KEYS = ["install", "typecheck", "lint", "test", "build", "dev", "seed"] as const;
export type CommandKey = (typeof COMMAND_KEYS)[number];
export const COMMAND_LABEL: Record<CommandKey, string> = { install: "Instalação", typecheck: "Tipos", lint: "Lint", test: "Testes", build: "Build", dev: "Servidor de desenvolvimento", seed: "Dados de teste" };

const LOCKFILES: { file: string; manager: string; supported: boolean }[] = [
  { file: "pnpm-lock.yaml", manager: "pnpm", supported: true },
  { file: "package-lock.json", manager: "npm", supported: true },
  { file: "npm-shrinkwrap.json", manager: "npm", supported: true },
  { file: "yarn.lock", manager: "yarn", supported: false },
  { file: "bun.lock", manager: "bun", supported: false },
  { file: "bun.lockb", manager: "bun", supported: false },
];
const OTHER_ECOSYSTEMS: [string, string][] = [["requirements.txt", "Python (requirements.txt)"], ["pyproject.toml", "Python (pyproject.toml)"], ["go.mod", "Go"], ["Cargo.toml", "Rust (Cargo)"], ["composer.json", "PHP (Composer)"]];

// ---- command lines ----------------------------------------------------------------------------------------

/** Splits a command line (double quotes group words); refuses shell syntax, since nothing runs through a shell. */
export function parseCommandLine(text: string, o: { manager: SupportedPackageManager; allowPort?: boolean }): { ok: true; argv: string[] } | { ok: false; error: string } {
  const t = text.trim();
  if (!t) return { ok: false, error: "comando vazio" };
  if (t.length > 300 || /[\r\n\0]/.test(t)) return { ok: false, error: "comando longo demais ou com quebra de linha" };
  const argv: string[] = [];
  let cur = "", inQ = false, had = false;
  for (const ch of t) {
    if (ch === '"') { inQ = !inQ; had = true; continue; }
    if (!inQ && /\s/.test(ch)) { if (cur || had) argv.push(cur); cur = ""; had = false; continue; }
    if (!inQ && /[|&;<>`]/.test(ch)) return { ok: false, error: `o caractere “${ch}” não é aceito: o executor roda o comando sem shell (sem pipes, redirecionamentos ou encadeamento com && ;)` };
    cur += ch;
  }
  if (inQ) return { ok: false, error: "aspas sem fechamento" };
  if (cur || had) argv.push(cur);
  if (argv.length > 40) return { ok: false, error: "argumentos demais" };
  const head = argv[0];
  const allowed = [o.manager, ...(o.manager === "npm" ? ["npx"] : []), "node"];
  if (!allowed.includes(head)) return { ok: false, error: `o comando deve começar com ${allowed.join(", ")} (o gerenciador do lockfile deste projeto${o.manager === "npm" ? ", npx" : ""} ou node); “${head}” não é aceito` };
  for (const a of argv.slice(1)) {
    if (/\$\(|\$\{/.test(a)) return { ok: false, error: `“${a}”: substituição de shell não é aceita` };
    const absolute = /^([A-Za-z]:[\\/]|[\\/])/.test(a) || /=([A-Za-z]:[\\/]|[\\/])/.test(a);
    const climbs = /(^|[\\/=])\.\.([\\/]|$)/.test(a);
    if (absolute || climbs) return { ok: false, error: `“${a}”: caminhos absolutos ou com “..” não são aceitos (o comando só alcança a cópia isolada do projeto)` };
    if (a.includes("{port}") && !o.allowPort) return { ok: false, error: "{port} só vale no comando do servidor de desenvolvimento" };
  }
  return { ok: true, argv };
}

/** Test files appended to the configured test command (npm needs "--" to pass them to the script). */
export function withTestFiles(argv: string[], files: string[]): string[] {
  if (!files.length) return argv;
  const npmScript = argv[0] === "npm" && (argv[1] === "test" || argv[1] === "t" || argv[1] === "run" || argv[1] === "run-script");
  return npmScript && !argv.includes("--") ? [...argv, "--", ...files] : [...argv, ...files];
}

// The processes of the application (servicesOf / mainServiceOf) live in lib/engine/services.ts so the editor can use them too.
export { mainServiceOf, servicesOf } from "@/lib/engine/services";

// ---- detection --------------------------------------------------------------------------------------------

type Pkg = { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
const readPkg = (dir: string): Pkg | null => { try { return JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as Pkg; } catch { return null; } };

/** Setor IA itself (the only app with ready-made read-only records for its QA browser). */
export function hasSetorIaFixture(dir: string) {
  const f = path.join(dir, "lib", "office", "storage.ts");
  return existsSync(f) && /STORAGE_V2\s*=/.test(readFileSync(f, "utf8"));
}

function lockfilesIn(dir: string) { return LOCKFILES.filter(l => existsSync(path.join(dir, l.file))); }

/** The root and its first-level subfolders that have a package.json (node_modules, dot folders skipped). */
function candidateDirs(root: string): string[] {
  const out = [""];
  try {
    for (const e of readdirSync(root, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith(".") || e.name === "node_modules") continue;
      if (existsSync(path.join(root, e.name, "package.json"))) out.push(e.name);
    }
  } catch { /* unreadable root: only "" */ }
  return out.slice(0, 20);
}

export function suggestFor(root: string, workDir: string): { suggestion: ProjectRunConfig | null; manager: ProjectRunDetection["manager"]; notes: string[] } {
  const dir = path.join(root, ...workDir.split("/").filter(Boolean));
  const notes: string[] = [];
  const locks = lockfilesIn(dir);
  const pkg = readPkg(dir);
  if (!pkg) return { suggestion: null, manager: { name: null, supported: false, detail: `Nenhum package.json em ${workDir || "(raiz)"}.` }, notes };
  const supported = locks.filter(l => l.supported);
  const managers = [...new Set(supported.map(l => l.manager))];
  if (!locks.length) return { suggestion: null, manager: { name: null, supported: false, detail: "Sem lockfile: sem ele a instalação não é reproduzível. Gere e commite o lockfile do gerenciador que o projeto usa (package-lock.json ou pnpm-lock.yaml)." }, notes };
  if (!supported.length) return { suggestion: null, manager: { name: locks[0].manager, supported: false, detail: `${locks[0].file}: ${locks[0].manager} ainda não é suportado pelo executor (suportados: npm e pnpm).` }, notes };
  if (managers.length > 1) notes.push(`Há lockfiles de ${managers.join(" e ")}; a sugestão usa ${managers[0]}. Confira qual o projeto realmente usa.`);
  const unsupportedToo = locks.filter(l => !l.supported);
  if (unsupportedToo.length) notes.push(`Também há ${unsupportedToo.map(l => l.file).join(", ")} (${unsupportedToo[0].manager}, não suportado); a sugestão usa ${managers[0]}.`);
  const pm = managers[0] as SupportedPackageManager;
  const s = pkg.scripts ?? {};
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const run = (script: string) => (pm === "npm" ? (script === "test" ? "npm test" : `npm run ${script}`) : `pnpm run ${script}`);
  const typecheck = s.typecheck ? run("typecheck") : s["type-check"] ? run("type-check") : existsSync(path.join(dir, "tsconfig.json")) && deps.typescript ? (pm === "npm" ? "npx tsc --noEmit" : "pnpm exec tsc --noEmit") : "";
  const knowsPortFlag = ["next", "vite", "vinext", "astro", "nuxt", "@sveltejs/kit"].some(d => deps[d]);
  const devScript = s.dev ? "dev" : s.start ? "start" : "";
  const dev = devScript ? (knowsPortFlag ? (pm === "npm" ? `npm run ${devScript} -- --port {port}` : `pnpm run ${devScript} --port {port}`) : run(devScript)) : "";
  if (devScript && !knowsPortFlag) notes.push(`O servidor “${devScript}” recebe a porta pela variável PORT; confira se o projeto a respeita (senão, informe a porta fixa que ele usa).`);
  if (s.test && /no test specified/.test(s.test)) notes.push("O script test é o padrão do npm (“no test specified”): deixado como não configurado.");
  if (s.seed || s["db:seed"]) notes.push(`Há um script de dados (${s.seed ? "seed" : "db:seed"}); configure-o em “Dados de teste” se ele só usa dados locais de teste.`);
  const fixture = hasSetorIaFixture(dir);
  return {
    manager: { name: pm, supported: true, detail: `${supported.find(l => l.manager === pm)!.file} → ${pm}` },
    notes,
    suggestion: {
      workDir, packageManager: pm,
      commands: {
        install: pm === "npm" ? "npm ci" : "pnpm install --frozen-lockfile",
        typecheck, lint: s.lint ? run("lint") : "", test: s.test && !/no test specified/.test(s.test) ? run("test") : "", build: s.build ? run("build") : "", dev, seed: "",
      },
      app: { host: "localhost", port: null, readyPath: "/", readyText: "", timeoutSec: 120 },
      browserData: fixture ? "setor_ia_fixture" : "app",
      env: [], acknowledgedAt: null, updatedAt: null,
    },
  };
}

export function detectProject(root: string, preferred?: string): ProjectRunDetection {
  const dirs = candidateDirs(root).map(dir => {
    const abs = path.join(root, ...dir.split("/").filter(Boolean));
    const locks = lockfilesIn(abs);
    const pkg = readPkg(abs);
    const sup = locks.find(l => l.supported);
    return { dir, lockfiles: locks.map(l => l.file), manager: sup?.manager ?? locks[0]?.manager ?? null, supported: !!sup && !!pkg, scripts: Object.keys(pkg?.scripts ?? {}).slice(0, 30) };
  }).filter(d => d.dir === "" || d.lockfiles.length || d.scripts.length);
  const chosen = preferred !== undefined && dirs.some(d => d.dir === preferred) ? preferred : (dirs.find(d => d.supported)?.dir ?? "");
  const s = suggestFor(root, chosen);
  const unsupported = [
    ...dirs.flatMap(d => d.lockfiles.map(f => LOCKFILES.find(l => l.file === f)!).filter(l => !l.supported).map(l => `${d.dir ? `${d.dir}/` : ""}${l.file} (${l.manager})`)),
    ...OTHER_ECOSYSTEMS.filter(([f]) => existsSync(path.join(root, f)) || dirs.some(d => d.dir && existsSync(path.join(root, d.dir, f)))).map(([, label]) => label),
  ];
  if (unsupported.length) s.notes.push(`Não suportado nesta versão: ${unsupported.join(", ")}.`);
  return { workDirs: dirs, chosen, manager: s.manager, suggestion: s.suggestion, notes: s.notes, fixtureAvailable: hasSetorIaFixture(path.join(root, ...chosen.split("/").filter(Boolean))), unsupported };
}

// ---- validation of what the user saves ---------------------------------------------------------------------

const RESERVED_ENV = /^(PATH|PATHEXT|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|TEMP|TMP|TMPDIR|SYSTEMROOT|COMSPEC|PORT|CI|NODE_OPTIONS|NPM_CONFIG_.*|PNPM_.*|GIT_.*|AYLA_.*|CLAUDE_.*|CODEX_.*|ANTHROPIC_.*|OPENAI_.*)$/i;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

/** Hosts other than this computer found in a value (URLs, or "host:port" connection strings). */
export function externalHosts(value: string): string[] {
  const hosts = new Set<string>();
  for (const m of value.matchAll(/[a-z][a-z0-9+.-]*:\/\/(?:[^@/\s]*@)?(\[[^\]]+\]|[^:/?#\s]+)/gi)) hosts.add(m[1].toLowerCase());
  return [...hosts].filter(h => !LOCAL_HOSTS.has(h) && !h.endsWith(".localhost"));
}

export type EnvChange = { name: string; value?: string; external: boolean; remove?: boolean };
export type ConfigInput = Omit<ProjectRunConfig, "env" | "acknowledgedAt" | "updatedAt"> & { env: EnvChange[] };

export function validateConfig(raw: unknown, root: string, existingNames: string[], existingValue: (name: string) => string | null, opts: { controlPorts?: number[] } = {}): { ok: true; config: Omit<ProjectRunConfig, "acknowledgedAt" | "updatedAt">; setValues: Record<string, string>; removed: string[] } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const b = (raw ?? {}) as Partial<ConfigInput>;
  const workDir = typeof b.workDir === "string" ? b.workDir.trim().replace(/\\/g, "/").replace(/^\.\/?/, "").replace(/\/+$/, "") : "";
  if (workDir) {
    const bad = relPathProblem(workDir);
    if (bad) errors.push(`Diretório de execução: ${bad}.`);
    else if (!existsSync(path.join(root, ...workDir.split("/"))) || !statSync(path.join(root, ...workDir.split("/"))).isDirectory()) errors.push(`Diretório de execução “${workDir}” não existe na pasta do projeto.`);
  }
  const pm = b.packageManager;
  if (pm !== "npm" && pm !== "pnpm") errors.push("Gerenciador de pacotes: escolha npm ou pnpm (os suportados nesta versão).");
  const dir = path.join(root, ...workDir.split("/").filter(Boolean));
  if (pm && (pm === "npm" || pm === "pnpm")) {
    const has = lockfilesIn(dir).filter(l => l.manager === pm);
    if (!has.length) errors.push(`Não há lockfile de ${pm} em ${workDir || "(raiz)"}: a instalação não seria reproduzível.`);
  }
  const commands = {} as ProjectRunConfig["commands"];
  for (const k of COMMAND_KEYS) {
    const v = typeof b.commands?.[k] === "string" ? b.commands[k].trim() : "";
    commands[k] = v;
    if (v && (pm === "npm" || pm === "pnpm")) { const p = parseCommandLine(v, { manager: pm, allowPort: k === "dev" }); if (!p.ok) errors.push(`${COMMAND_LABEL[k]}: ${p.error}.`); }
  }
  if (!commands.install) errors.push("Instalação: informe o comando (ex.: npm ci ou pnpm install --frozen-lockfile).");
  const a = (b.app ?? {}) as Partial<ProjectRunConfig["app"]>;
  const host = a.host === "127.0.0.1" ? "127.0.0.1" : "localhost";
  const port = a.port === null || a.port === undefined || (a.port as unknown) === "" ? null : Number(a.port);
  if (port !== null && (!Number.isInteger(port) || port < 1024 || port > 65535)) errors.push("Porta: use um número entre 1024 e 65535, ou deixe vazio para o executor escolher uma porta livre ({port}).");
  const control = opts.controlPorts?.length ? opts.controlPorts : DEFAULT_CONTROL_PORTS;
  const portProblem = (p: number) => (control.includes(p) ? `a porta ${p} é do próprio Setor IA (executor ou interface web)` : SENSITIVE_PORTS[p] ? `a porta ${p} é de um serviço local sensível (${SENSITIVE_PORTS[p]})` : null);
  if (port !== null && Number.isInteger(port) && portProblem(port)) errors.push(`Porta: ${portProblem(port)}.`);
  const readyPath = typeof a.readyPath === "string" && a.readyPath.trim() ? a.readyPath.trim() : "/";
  if (!readyPath.startsWith("/") || readyPath.length > 200 || /\s/.test(readyPath)) errors.push("Caminho de prontidão: comece com / (ex.: / ou /api/health).");
  const readyText = typeof a.readyText === "string" ? a.readyText.slice(0, 200) : "";
  const timeoutSec = Number(a.timeoutSec ?? 120);
  if (!Number.isInteger(timeoutSec) || timeoutSec < 10 || timeoutSec > 600) errors.push("Tempo para o servidor ficar pronto: de 10 a 600 segundos.");
  const browserData = b.browserData === "setor_ia_fixture" ? "setor_ia_fixture" : "app";
  if (browserData === "setor_ia_fixture" && !hasSetorIaFixture(dir)) errors.push("Dados simulados do Setor IA só existem para o próprio Setor IA.");
  // ---- processes, origins and links (frontend + API...) ----
  const readyPathOk = (p: string) => p.startsWith("/") && p.length <= 200 && !/\s/.test(p);
  const legacyMain: ProjectService | null = commands.dev ? { id: "app", label: "Aplicação", dir: workDir, install: "", command: commands.dev, host, port, readyPath, readyText, timeoutSec, browser: true } : null;
  const wantsMulti = Array.isArray(b.services) || (b.extraOrigins?.length ?? 0) > 0 || (b.links?.length ?? 0) > 0;
  let services: ProjectService[] | undefined, mainService: string | undefined, extraOrigins: ProjectExtraOrigin[] | undefined, links: ProjectLink[] | undefined;
  if (wantsMulti) {
    const input: Partial<ProjectService>[] = Array.isArray(b.services) ? b.services : legacyMain ? [legacyMain] : [];
    if (input.length > 6) errors.push("Processos: no máximo 6.");
    services = [];
    for (const [i, x] of input.slice(0, 6).entries()) {
      const id = typeof x?.id === "string" ? x.id.trim() : "";
      const tag = `Processo ${i + 1}${id ? ` (${id})` : ""}`;
      if (!/^[a-z][a-z0-9-]{0,23}$/.test(id)) { errors.push(`${tag}: identificador inválido (minúsculas, números e hífen; começa com letra; até 24 caracteres).`); continue; }
      if (services.some(y => y.id === id)) { errors.push(`${tag}: identificador repetido.`); continue; }
      const label = (typeof x.label === "string" && x.label.trim() ? x.label.trim() : id).slice(0, 60);
      const dir = typeof x.dir === "string" ? x.dir.trim().replace(/\\/g, "/").replace(/^\.\/?/, "").replace(/\/+$/, "") : "";
      if (dir) {
        const bad = relPathProblem(dir);
        if (bad) errors.push(`${label}: pasta ${bad}.`);
        else if (!existsSync(path.join(root, ...dir.split("/"))) || !statSync(path.join(root, ...dir.split("/"))).isDirectory()) errors.push(`${label}: a pasta “${dir}” não existe no repositório.`);
      }
      const command = typeof x.command === "string" ? x.command.trim() : "";
      const install = typeof x.install === "string" ? x.install.trim() : "";
      if (!command) errors.push(`${label}: informe o comando que inicia o processo.`);
      if (pm === "npm" || pm === "pnpm") {
        if (command) { const p = parseCommandLine(command, { manager: pm, allowPort: true }); if (!p.ok) errors.push(`${label}: comando — ${p.error}.`); }
        if (install) {
          const p = parseCommandLine(install, { manager: pm }); if (!p.ok) errors.push(`${label}: instalação — ${p.error}.`);
          else if (!lockfilesIn(path.join(root, ...dir.split("/").filter(Boolean))).some(l => l.manager === pm)) errors.push(`${label}: não há lockfile de ${pm} na pasta ${dir || "(raiz)"}; a instalação não seria reproduzível.`);
        }
      }
      const sHost = x.host === "127.0.0.1" ? "127.0.0.1" : "localhost";
      const sPort = x.port === null || x.port === undefined || (x.port as unknown) === "" ? null : Number(x.port);
      if (sPort !== null && (!Number.isInteger(sPort) || sPort < 1024 || sPort > 65535)) errors.push(`${label}: porta de 1024 a 65535, ou vazia para uma porta livre escolhida pelo executor.`);
      else if (sPort !== null && portProblem(sPort)) errors.push(`${label}: ${portProblem(sPort)}.`);
      else if (sPort !== null && services.some(y => y.port === sPort)) errors.push(`${label}: a porta ${sPort} já é de outro processo.`);
      const sReady = typeof x.readyPath === "string" && x.readyPath.trim() ? x.readyPath.trim() : "/";
      if (!readyPathOk(sReady)) errors.push(`${label}: caminho de prontidão — comece com / (ex.: / ou /health).`);
      const sTimeout = Number(x.timeoutSec ?? 120);
      if (!Number.isInteger(sTimeout) || sTimeout < 10 || sTimeout > 600) errors.push(`${label}: tempo para ficar pronto de 10 a 600 segundos.`);
      services.push({ id, label, dir, install, command, host: sHost, port: sPort, readyPath: sReady, readyText: typeof x.readyText === "string" ? x.readyText.slice(0, 200) : "", timeoutSec: sTimeout, browser: x.browser !== false });
    }
    mainService = services.find(x => x.id === b.mainService)?.id ?? services[0]?.id;
    if (b.mainService && services.length && !services.some(x => x.id === b.mainService)) errors.push(`Origem principal: o processo “${String(b.mainService)}” não existe.`);
    extraOrigins = [];
    for (const x of Array.isArray(b.extraOrigins) ? b.extraOrigins.slice(0, 10) : []) {
      const info = inspectOrigin(typeof x?.origin === "string" ? x.origin : "", control);
      if (!info.ok) { errors.push(`Origem adicional: ${info.error}.`); continue; }
      if (info.scope === "external" && !x.external) { errors.push(`Origem adicional ${info.origin}: fica fora deste computador. Acesso externo exige autorização explícita (marque “origem externa autorizada”) — por padrão só endereços locais.`); continue; }
      if (extraOrigins.some(y => y.origin === info.origin)) { errors.push(`Origem adicional ${info.origin} repetida.`); continue; }
      extraOrigins.push({ origin: info.origin, label: (typeof x.label === "string" && x.label.trim() ? x.label.trim() : info.origin).slice(0, 60), external: info.scope === "external" });
    }
    links = [];
    for (const x of Array.isArray(b.links) ? b.links.slice(0, 20) : []) {
      const name = typeof x?.name === "string" ? x.name.trim() : "";
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) { errors.push(`Variável de ligação “${name}”: nome inválido.`); continue; }
      if (RESERVED_ENV.test(name)) { errors.push(`Variável de ligação ${name}: nome reservado ao executor ou ao sistema.`); continue; }
      if (links.some(y => y.name === name && y.to.some(t => (x.to ?? []).includes(t) || !(x.to?.length) || !y.to.length))) { errors.push(`Variável de ligação ${name} repetida para o mesmo processo.`); continue; }
      if (!services.some(y => y.id === x.service)) { errors.push(`Variável de ligação ${name}: o processo de origem “${String(x.service)}” não existe.`); continue; }
      const to = Array.isArray(x.to) ? x.to.filter((t): t is string => typeof t === "string") : [];
      const missingTo = to.filter(t => !services!.some(y => y.id === t));
      if (missingTo.length) { errors.push(`Variável de ligação ${name}: processo(s) de destino inexistente(s): ${missingTo.join(", ")}.`); continue; }
      const as = x.as === "port" || x.as === "host" ? x.as : "origin";
      const suffix = as === "origin" && typeof x.suffix === "string" ? x.suffix.trim() : "";
      if (suffix && (!suffix.startsWith("/") || /\s/.test(suffix) || suffix.length > 100)) { errors.push(`Variável de ligação ${name}: o complemento deve começar com / (ex.: /api) e não ter espaços.`); continue; }
      links.push({ name, service: x.service, as, suffix, to });
    }
    // The first process mirrors into the older fields, so every reader that only knows commands.dev + app keeps working.
    const m = services.find(x => x.id === mainService);
    commands.dev = m?.command ?? "";
  }
  const env: ProjectRunConfig["env"] = [];
  const setValues: Record<string, string> = {};
  const removed: string[] = [];
  for (const e of Array.isArray(b.env) ? b.env.slice(0, 40) : []) {
    const name = typeof e?.name === "string" ? e.name.trim() : "";
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) { errors.push(`Variável “${name}”: nome inválido.`); continue; }
    if (RESERVED_ENV.test(name)) { errors.push(`Variável ${name}: nome reservado ao executor ou ao sistema.`); continue; }
    if (env.some(x => x.name === name)) { errors.push(`Variável ${name} repetida.`); continue; }
    if (e.remove) { removed.push(name); continue; }
    const value = typeof e.value === "string" ? e.value : null;
    if (value !== null && value.length > 4000) { errors.push(`Variável ${name}: valor longo demais.`); continue; }
    const effective = value ?? existingValue(name);
    if (effective === null) { errors.push(`Variável ${name}: informe o valor.`); continue; }
    const ext = externalHosts(effective);
    if (ext.length && !e.external) { errors.push(`Variável ${name} aponta para fora deste computador (${ext.join(", ")}). Testes não usam dados reais por padrão: use um endereço local de teste, ou marque “permitir endereço externo” se for mesmo um ambiente de teste.`); continue; }
    if (value !== null) setValues[name] = value;
    env.push({ name, set: true, external: !!e.external && ext.length > 0 });
  }
  for (const n of existingNames) if (!env.some(x => x.name === n) && !removed.includes(n)) removed.push(n);
  for (const l of links ?? []) if (env.some(e => e.name === l.name)) errors.push(`A variável ${l.name} está definida como variável de teste e como ligação entre processos; use só uma.`);
  if (errors.length) return { ok: false, errors };
  const main = services?.find(x => x.id === mainService);
  const appOut = main ? { host: main.host, port: main.port, readyPath: main.readyPath, readyText: main.readyText, timeoutSec: main.timeoutSec } : { host: host as "localhost" | "127.0.0.1", port, readyPath, readyText, timeoutSec };
  return { ok: true, config: { workDir, packageManager: pm as SupportedPackageManager, commands, app: appOut, browserData, env, ...(services ? { services, mainService, extraOrigins, links } : {}) }, setValues, removed };
}

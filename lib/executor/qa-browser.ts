// Controlled browser for the tool-equipped QA: the installed Edge/Chrome driven by playwright-core (no browser
// download), always headless, always a fresh temporary profile (never the user's own profile, cookies or
// sessions), and limited to the application under test:
// - every request to another origin is aborted;
// - the application's own API (/api/*) never reaches a real server: GETs are answered from a fixture frozen
//   by the executor (read-only records of this demand), and every other method gets a 403 — so no click in
//   the QA browser can start, approve or pay for any agent call;
// - scenario steps come from a fixed catalog (open, click, wait, read the real clipboard, download, compare…);
//   there is no free-form JavaScript;
// - the headless browser keeps its own clipboard (checked on this machine: the user's system clipboard is not
//   touched), and it is read back for real (navigator.clipboard.readText in a separate reader page), never
//   taken from the page handler's own return value.
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ArtifactRef } from "@/lib/engine/types";
import { writeArtifact } from "./qa-env";

export type BrowserStep = {
  action: "open" | "click" | "wait_for_text" | "expect_text" | "read_text" | "reload" | "clipboard_permission" | "disable_clipboard_api" | "read_clipboard" | "download" | "compare" | "screenshot" | "wait";
  target: string; url_path: string; save_as: string; first: string; second: string; ignore_line_regex: string; setting: string; timeout_ms: number;
};
export const BROWSER_ACTIONS: BrowserStep["action"][] = ["open", "click", "wait_for_text", "expect_text", "read_text", "reload", "clipboard_permission", "disable_clipboard_api", "read_clipboard", "download", "compare", "screenshot", "wait"];

export type AppFixture = { localStorage: Record<string, string>; api: Record<string, unknown>; note: string };
export type StepLog = { index: number; action: string; args: string; ok: boolean; observed: string; ms: number };
export type ScenarioResult = {
  ok: boolean; steps: StepLog[]; artifacts: ArtifactRef[]; consoleErrors: string[];
  api: { blocked: number; servedFromFixture: number; notFound: number; externalBlocked: number };
  browserVersion: string; observed: string;
};

/** Installed Chromium-based browser this executor can drive (checked on disk, never assumed). */
export function findBrowser(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): { executable: string; name: string } | null {
  const pf86 = env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", pf = env.ProgramFiles ?? "C:\\Program Files", local = env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  const candidates: [string, string][] = process.platform === "win32"
    ? [[path.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"), "Microsoft Edge"], [path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"), "Microsoft Edge"], [path.join(pf, "Google", "Chrome", "Application", "chrome.exe"), "Google Chrome"], [path.join(local, "Google", "Chrome", "Application", "chrome.exe"), "Google Chrome"]]
    : process.platform === "darwin"
      ? [["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "Microsoft Edge"], ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "Google Chrome"]]
      : [["/usr/bin/microsoft-edge", "Microsoft Edge"], ["/usr/bin/google-chrome", "Google Chrome"], ["/usr/bin/chromium", "Chromium"]];
  for (const [p, name] of candidates) if (existsSync(p)) return { executable: p, name };
  return null;
}

/** playwright-core, resolved from the executor's own dependencies (a devDependency of this project). */
export async function loadPlaywright(): Promise<{ chromium: typeof import("playwright-core").chromium; version: string } | null> {
  try {
    const pw = await import("playwright-core");
    let version = "?";
    try { version = JSON.parse(readFileSync(path.join(process.cwd(), "node_modules", "playwright-core", "package.json"), "utf8")).version; } catch { /* informative only */ }
    return { chromium: pw.chromium, version };
  } catch { return null; }
}

const clip = (s: string, n = 600) => (s.length > n ? `${s.slice(0, n)}… (+${s.length - n} caracteres)` : s);

/** Compares two saved texts: only line endings are normalized, plus — when asked — lines matching ONE pattern in both texts (e.g. a generation timestamp), at most 3 of them. */
export function compareTexts(a: string, b: string, ignoreLineRegex: string) {
  const norm = (s: string) => s.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  const A = norm(a), B = norm(b);
  let re: RegExp | null = null;
  if (ignoreLineRegex) {
    if (ignoreLineRegex.length > 200) throw new Error("Padrão de linha ignorada longo demais.");
    re = new RegExp(ignoreLineRegex);
  }
  const ignored: { line: number; first: string; second: string }[] = [];
  const differences: { line: number; first: string; second: string }[] = [];
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const x = A[i] ?? "(ausente)", y = B[i] ?? "(ausente)";
    if (x === y) continue;
    if (re && re.test(x) && re.test(y) && ignored.length < 3) ignored.push({ line: i + 1, first: x, second: y });
    else differences.push({ line: i + 1, first: x, second: y });
  }
  return { equal: differences.length === 0, linesFirst: A.length, linesSecond: B.length, crlfFirst: (a.match(/\r\n/g) ?? []).length, crlfSecond: (b.match(/\r\n/g) ?? []).length, ignored, differences: differences.slice(0, 8), differencesTotal: differences.length };
}

export async function runScenario(o: {
  appUrl: string; name: string; steps: BrowserStep[]; fixture: AppFixture; artifactsDir: string; executable: string;
  signal?: AbortSignal; evidenceId: string;
}): Promise<ScenarioResult> {
  const pw = await loadPlaywright();
  if (!pw) throw new Error("playwright-core não está disponível para o executor.");
  const origin = new URL(o.appUrl).origin;
  const artifacts: ArtifactRef[] = [];
  const steps: StepLog[] = [];
  const consoleErrors: string[] = [];
  const api = { blocked: 0, servedFromFixture: 0, notFound: 0, externalBlocked: 0 };
  const apiLog: string[] = [];
  const saved = new Map<string, { text: string; source: string }>();
  const prefix = `${o.evidenceId}-${o.name}`.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 60);

  const browser = await pw.chromium.launch({ executablePath: o.executable, headless: true, args: ["--no-first-run", "--no-default-browser-check", "--disable-sync", "--disable-extensions"] });
  const onAbort = () => { void browser.close().catch(() => {}); };
  o.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1400, height: 900 }, locale: "pt-BR", serviceWorkers: "block" });
    await ctx.route("**/*", async route => {
      const req = route.request();
      let u: URL;
      try { u = new URL(req.url()); } catch { api.externalBlocked++; return route.abort("blockedbyclient"); }
      if (u.origin !== origin) { api.externalBlocked++; apiLog.push(`BLOQUEADO (outra origem) ${req.method()} ${u.origin}${u.pathname}`); return route.abort("blockedbyclient"); }
      if (!u.pathname.startsWith("/api/")) return route.continue();
      if (req.method() !== "GET") {
        api.blocked++; apiLog.push(`BLOQUEADO (ambiente de QA) ${req.method()} ${u.pathname}`);
        return route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: { code: "qa_environment", message: o.fixture.note } }) });
      }
      const key = `GET ${u.pathname}`;
      if (key in o.fixture.api) { api.servedFromFixture++; apiLog.push(`FIXTURE ${key}${u.search}`); return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(o.fixture.api[key]) }); }
      api.notFound++; apiLog.push(`SEM FIXTURE ${key}${u.search}`);
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "qa_fixture_missing", message: "Ambiente de QA: sem dado simulado para esta leitura." } }) });
    });
    // Seeds the fixture only when absent, so a reload keeps whatever the page itself saved meanwhile.
    await ctx.addInitScript({ content: `(function () { if (location.origin !== ${JSON.stringify(origin)}) return; var d = ${JSON.stringify(o.fixture.localStorage)}; for (var k in d) { if (localStorage.getItem(k) === null) localStorage.setItem(k, d[k]); } })();` });
    const page = await ctx.newPage();
    page.on("console", m => { if (m.type() === "error") consoleErrors.push(clip(m.text(), 300)); });
    page.on("pageerror", e => consoleErrors.push(clip(`pageerror: ${e.message}`, 300)));
    const cdp = await ctx.newCDPSession(page);
    const { targetInfo } = await cdp.send("Target.getTargetInfo") as { targetInfo: { browserContextId?: string } };
    const setPermission = (name: string, setting: "granted" | "denied" | "prompt") => cdp.send("Browser.setPermission", { permission: { name }, setting, origin, browserContextId: targetInfo.browserContextId });
    let writePermission: "granted" | "denied" = "granted";
    await setPermission("clipboard-write", "granted");
    await setPermission("clipboard-read", "denied");
    // The real clipboard of this headless browser, read from a separate page of a separate context (shared browser clipboard), so the page under test keeps its own permission state.
    const readerCtx = await browser.newContext();
    await readerCtx.route("**/*", r => r.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>leitor</title>" }));
    const reader = await readerCtx.newPage();
    await reader.goto(origin + "/__leitor_area_de_transferencia__");
    const rcdp = await readerCtx.newCDPSession(reader);
    const { targetInfo: rinfo } = await rcdp.send("Target.getTargetInfo") as { targetInfo: { browserContextId?: string } };
    await rcdp.send("Browser.setPermission", { permission: { name: "clipboard-read" }, setting: "granted", origin, browserContextId: rinfo.browserContextId });
    await rcdp.send("Browser.setPermission", { permission: { name: "clipboard-write" }, setting: "granted", origin, browserContextId: rinfo.browserContextId });
    await reader.evaluate(() => navigator.clipboard.writeText("")).catch(() => {});

    const locate = async (text: string) => {
      for (const role of ["button", "link", "tab", "menuitem"] as const) {
        const l = page.getByRole(role, { name: text, exact: true });
        if (await l.count()) return l.first();
      }
      const l = page.getByText(text, { exact: true });
      if (await l.count()) return l.first();
      const b = page.getByRole("button", { name: text });
      if (await b.count()) return b.first();
      return null;
    };
    const visibleButtons = async () => (await page.getByRole("button").allInnerTexts()).map(t => t.trim().replace(/\s+/g, " ")).filter(Boolean).slice(0, 40).join(" | ");
    const shot = async (label: string) => { artifacts.push(writeArtifact(o.artifactsDir, `${prefix}-${label}.png`, await page.screenshot({ fullPage: false }), "screenshot", `Captura: ${label}`)); };

    let ok = true;
    for (let i = 0; i < o.steps.length && ok; i++) {
      if (o.signal?.aborted) throw new Error("Cancelado.");
      const s = o.steps[i];
      const started = Date.now();
      const args = [s.target && `alvo="${s.target}"`, s.url_path && `caminho="${s.url_path}"`, s.save_as && `salvar_como="${s.save_as}"`, s.first && `primeiro="${s.first}"`, s.second && `segundo="${s.second}"`, s.ignore_line_regex && `ignorar_linha=/${s.ignore_line_regex}/`, s.setting && `valor="${s.setting}"`].filter(Boolean).join(" ");
      let observed = "";
      try {
        const timeout = Math.min(Math.max(s.timeout_ms || 8000, 500), 30_000);
        switch (s.action) {
          case "open": {
            const p = s.url_path && s.url_path.startsWith("/") ? s.url_path : "/";
            const r = await page.goto(origin + p, { waitUntil: "load", timeout: 60_000 });
            await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
            observed = `Página ${p} carregada (HTTP ${r?.status() ?? "?"}).`;
            break;
          }
          case "click": {
            const l = await locate(s.target);
            if (!l) throw new Error(`Nenhum elemento visível com o texto “${s.target}”. Botões visíveis: ${await visibleButtons()}`);
            await l.scrollIntoViewIfNeeded({ timeout });
            await l.click({ timeout });
            await page.waitForTimeout(250);
            observed = `Clique real (mouse) em “${s.target}”.`;
            break;
          }
          case "wait_for_text": {
            await page.getByText(s.target, { exact: false }).first().waitFor({ state: "visible", timeout });
            observed = `Texto visível na tela: “${s.target}”.`;
            break;
          }
          case "expect_text": {
            const n = await page.getByText(s.target, { exact: false }).count();
            const vis = n ? await page.getByText(s.target, { exact: false }).first().isVisible() : false;
            observed = vis ? `Presente e visível: “${s.target}”.` : `AUSENTE (ou invisível): “${s.target}”.`;
            break;
          }
          case "read_text": {
            const dialog = page.getByRole("dialog");
            const t = (await dialog.count()) ? await dialog.last().innerText() : await page.locator("body").innerText();
            observed = `Texto da tela${(await dialog.count()) ? " (diálogo aberto)" : ""}: ${clip(t.replace(/\s+/g, " "), 1500)}`;
            break;
          }
          case "reload": {
            await page.reload({ waitUntil: "load", timeout: 60_000 });
            await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
            observed = "Página recarregada (navegação completa; o estado da página em memória foi descartado).";
            break;
          }
          case "clipboard_permission": {
            const v = s.setting === "deny" || s.setting === "denied" ? "denied" : "granted";
            await setPermission("clipboard-write", v);
            writePermission = v;
            const st = await page.evaluate(() => navigator.permissions?.query({ name: "clipboard-write" as PermissionName }).then(r => r.state).catch(e => `erro: ${e}`) ?? "sem API de permissões");
            observed = `Permissão de escrita na área de transferência definida no navegador: ${v}; a página consulta e recebe: ${st}.`;
            break;
          }
          case "disable_clipboard_api": {
            // Plain source text (not a function): bundlers may inject helpers (e.g. __name) into serialized functions.
            const disable = "Object.defineProperty(Navigator.prototype, 'clipboard', { get: function () { return undefined; }, configurable: true });";
            await ctx.addInitScript({ content: disable });
            await page.evaluate(disable);
            observed = `navigator.clipboard agora é ${await page.evaluate(() => typeof navigator.clipboard)} nesta página (e nas próximas cargas deste teste).`;
            break;
          }
          case "read_clipboard": {
            const text = await reader.evaluate(() => navigator.clipboard.readText());
            const name = s.save_as || `area-${i + 1}`;
            saved.set(name, { text, source: "área de transferência real do navegador" });
            artifacts.push(writeArtifact(o.artifactsDir, `${prefix}-${name}.txt`, text, "clipboard", `Conteúdo real da área de transferência (“${name}”)`));
            observed = text ? `Área de transferência contém ${text.length} caracteres; início: ${JSON.stringify(text.slice(0, 120))}.` : "Área de transferência VAZIA.";
            break;
          }
          case "download": {
            const l = await locate(s.target);
            if (!l) throw new Error(`Nenhum elemento visível com o texto “${s.target}”. Botões visíveis: ${await visibleButtons()}`);
            const [dl] = await Promise.all([page.waitForEvent("download", { timeout: Math.max(timeout, 10_000) }), l.click({ timeout })]);
            const tmp = path.join(os.tmpdir(), `ayla-dl-${Date.now()}-${Math.random().toString(36).slice(2)}`);
            await dl.saveAs(tmp);
            const buf = readFileSync(tmp);
            const name = s.save_as || `download-${i + 1}`;
            saved.set(name, { text: buf.toString("utf8"), source: `arquivo baixado “${dl.suggestedFilename()}”` });
            artifacts.push(writeArtifact(o.artifactsDir, `${prefix}-${name}-${dl.suggestedFilename()}`, buf, "download", `Arquivo realmente baixado: ${dl.suggestedFilename()}`));
            try { (await import("node:fs")).rmSync(tmp, { force: true }); } catch { /* best effort */ }
            observed = `Download real: “${dl.suggestedFilename()}”, ${buf.length} bytes.`;
            break;
          }
          case "compare": {
            const a = saved.get(s.first), b = saved.get(s.second);
            if (!a || !b) throw new Error(`Textos para comparar não encontrados (salvos: ${[...saved.keys()].join(", ") || "nenhum"}).`);
            const c = compareTexts(a.text, b.text, s.ignore_line_regex);
            const report = JSON.stringify({ first: { name: s.first, source: a.source }, second: { name: s.second, source: b.source }, ignoreLineRegex: s.ignore_line_regex || null, normalization: "somente quebras de linha (CRLF→LF) e uma quebra final", ...c }, null, 1);
            artifacts.push(writeArtifact(o.artifactsDir, `${prefix}-comparacao-${s.first}-${s.second}.json`, report, "comparison", `Comparação ${s.first} × ${s.second}`));
            observed = c.equal
              ? `IGUAIS após normalizar só quebras de linha${c.ignored.length ? ` e ignorar ${c.ignored.length} linha(s) pelo padrão /${s.ignore_line_regex}/ (linha ${c.ignored.map(x => x.line).join(", ")}: ${JSON.stringify(c.ignored[0].first)} × ${JSON.stringify(c.ignored[0].second)})` : ""}; ${c.linesFirst} linhas (CRLF: ${c.crlfFirst} × ${c.crlfSecond}).`
              : `DIFERENTES em ${c.differencesTotal} linha(s): ${c.differences.slice(0, 3).map(d => `linha ${d.line}: ${JSON.stringify(d.first.slice(0, 80))} × ${JSON.stringify(d.second.slice(0, 80))}`).join("; ")}.`;
            break;
          }
          case "screenshot": {
            await shot(s.save_as || `passo-${i + 1}`);
            observed = "Captura de tela salva.";
            break;
          }
          case "wait": {
            await page.waitForTimeout(Math.min(s.timeout_ms || 500, 5000));
            observed = `Espera de ${Math.min(s.timeout_ms || 500, 5000)} ms.`;
            break;
          }
          default: throw new Error(`Ação desconhecida: ${String((s as { action: string }).action)}`);
        }
        steps.push({ index: i + 1, action: s.action, args, ok: true, observed, ms: Date.now() - started });
      } catch (e) {
        ok = false;
        steps.push({ index: i + 1, action: s.action, args, ok: false, observed: clip((e as Error).message.split("\n")[0], 700), ms: Date.now() - started });
        try { await shot(`falha-passo-${i + 1}`); } catch { /* page may be gone */ }
      }
    }
    try { await shot("final"); } catch { /* ignore */ }
    artifacts.push(writeArtifact(o.artifactsDir, `${prefix}-requisicoes.log`, [
      `Requisições da página ao servidor da aplicação em teste (/api/*) e a outras origens:`, ...apiLog,
      "", `Bloqueadas (escrita/execução): ${api.blocked} · atendidas por fixture: ${api.servedFromFixture} · sem fixture: ${api.notFound} · outras origens bloqueadas: ${api.externalBlocked}`,
      `Permissão de escrita ao final: ${writePermission}`,
    ].join("\n"), "log", "Requisições interceptadas (nenhuma chegou a um executor real)"));
    artifacts.push(writeArtifact(o.artifactsDir, `${prefix}-passos.log`, steps.map(s => `${s.index}. ${s.ok ? "OK " : "FALHOU "} ${s.action} ${s.args} — ${s.observed} (${s.ms} ms)`).join("\n") + (consoleErrors.length ? `\n\nErros de console:\n${consoleErrors.join("\n")}` : ""), "log", "Passos executados no navegador"));
    const version = browser.version();
    await readerCtx.close();
    await ctx.close();
    return { ok, steps, artifacts, consoleErrors, api, browserVersion: version, observed: steps.map(s => `${s.index}. ${s.ok ? "" : "[FALHOU] "}${s.action}${s.args ? ` (${s.args})` : ""}: ${s.observed}`).join("\n") };
  } finally {
    o.signal?.removeEventListener("abort", onAbort);
    await browser.close().catch(() => {});
  }
}

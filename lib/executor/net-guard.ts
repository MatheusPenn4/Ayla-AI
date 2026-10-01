// What the QA browser may talk to — enforced OUTSIDE the page, at the network level.
// - Origins are authorized exactly (scheme + host + port). The application's own processes are authorized by the
//   executor from the addresses it just allocated; anything else the user adds is listed in the settings.
// - Local addresses are the default. An origin outside this computer needs an explicit flag in the settings.
// - Some destinations can never be authorized, whatever the settings say: the executor's own control port, the
//   Setor IA web UI, link-local/metadata addresses and well-known sensitive local services (databases, remote
//   desktop, Docker...).
// - The browser is started behind this small proxy (loopback NOT exempted), so every hop is checked — including
//   redirects followed by the browser, WebSocket handshakes and event streams, which the page-level request
//   interception of the automation library does not see (measured: a fetch redirected from an allowed origin to
//   another loopback port was answered by that port; behind this proxy it gets a 403 with the reason).
// This limits the BROWSER only. It does not isolate the network of the commands or scripts the project runs.
import http from "node:http";
import net from "node:net";

export type GuardOrigin = { origin: string; label: string };
export type GuardEntry = { at: string; method: string; target: string; reason: string };
export type GuardStats = { byOrigin: Record<string, { allowed: number; blocked: number }>; blocked: GuardEntry[]; blockedTotal: number };

/** Ports of well-known local services that a test browser has no business reaching. */
export const SENSITIVE_PORTS: Record<number, string> = {
  22: "SSH", 23: "Telnet", 25: "SMTP", 53: "DNS", 110: "POP3", 135: "RPC do Windows", 139: "NetBIOS", 143: "IMAP", 445: "SMB (compartilhamento de arquivos)",
  1433: "SQL Server", 1521: "Oracle", 2049: "NFS", 2375: "API do Docker", 2376: "API do Docker (TLS)", 3306: "MySQL", 3389: "Área de Trabalho Remota", 5432: "PostgreSQL",
  5900: "VNC", 5985: "WinRM", 5986: "WinRM (TLS)", 6379: "Redis", 9200: "Elasticsearch", 11211: "Memcached", 27017: "MongoDB",
};
/** Default ports of the Setor IA itself (executor and web UI); the executor adds the ones it was really started with. */
export const DEFAULT_CONTROL_PORTS = [4317, 5173];

const isLoopbackHost = (h: string) => {
  const x = h.toLowerCase().replace(/^\[|\]$/g, "");
  return x === "localhost" || x.endsWith(".localhost") || x === "::1" || x === "0.0.0.0" || /^127\.\d+\.\d+\.\d+$/.test(x);
};
const isLinkLocal = (h: string) => /^169\.254\.\d+\.\d+$/.test(h) || h.toLowerCase().replace(/^\[|\]$/g, "").startsWith("fe80:");

export type OriginInfo = { ok: true; origin: string; scope: "local" | "external"; host: string; port: number } | { ok: false; error: string };

/** Normalizes an origin typed in the settings and classifies it. `error` is always an understandable reason. */
export function inspectOrigin(raw: string, controlPorts: number[] = DEFAULT_CONTROL_PORTS): OriginInfo {
  const text = raw.trim();
  let u: URL;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return { ok: false, error: `“${text.slice(0, 80)}” não é uma origem válida (falta o protocolo: use, por exemplo, http://localhost:3000)` };
  try { u = new URL(text); } catch { return { ok: false, error: `“${text.slice(0, 80)}” não é uma origem válida (use protocolo, host e porta, por exemplo http://localhost:3000)` }; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, error: `“${text.slice(0, 80)}”: só http e https são aceitos` };
  if (u.username || u.password) return { ok: false, error: `“${text.slice(0, 80)}”: não coloque usuário ou senha na origem` };
  if ((u.pathname !== "/" && u.pathname !== "") || u.search || u.hash) return { ok: false, error: `“${text.slice(0, 80)}”: informe só a origem (protocolo, host e porta), sem caminho` };
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
  if (isLinkLocal(host)) return { ok: false, error: `${u.origin}: endereços link-local e de metadados (169.254.x.x) nunca são autorizados` };
  const local = isLoopbackHost(host);
  if (local && controlPorts.includes(port)) return { ok: false, error: `${u.origin}: a porta ${port} é do próprio Setor IA (executor ou interface web); a aplicação em teste não pode apontar para ela` };
  if (local && SENSITIVE_PORTS[port]) return { ok: false, error: `${u.origin}: a porta ${port} é de um serviço local sensível (${SENSITIVE_PORTS[port]}) e nunca é autorizada ao navegador de teste` };
  return { ok: true, origin: u.origin, scope: local ? "local" : "external", host, port };
}

/** The reason a request to `origin` is refused, or null when it is allowed. Used by the proxy and by the page-level checks. */
export function whyBlocked(origin: string, allowed: GuardOrigin[], controlPorts: number[]): string | null {
  const info = inspectOrigin(origin, controlPorts);
  if (!info.ok) return info.error;
  if (!allowed.some(a => a.origin === info.origin)) return `${info.origin} não é uma das origens autorizadas para o navegador (${allowed.map(a => a.origin).join(", ") || "nenhuma"})`;
  return null;
}

export type GuardProxy = { port: number; stats: () => GuardStats; close: () => Promise<void> };

/** Starts the proxy on 127.0.0.1 (ephemeral port). Only `allowed` origins pass; everything else gets a 403 and is recorded with the reason. */
export async function startGuardProxy(policy: { allowed: GuardOrigin[]; controlPorts: number[] }): Promise<GuardProxy> {
  const byOrigin: GuardStats["byOrigin"] = {};
  const blocked: GuardEntry[] = [];
  let blockedTotal = 0;
  const count = (origin: string, kind: "allowed" | "blocked") => { (byOrigin[origin] ??= { allowed: 0, blocked: 0 })[kind]++; };
  const refuse = (method: string, target: string, origin: string, reason: string) => {
    count(origin, "blocked"); blockedTotal++;
    if (blocked.length < 200) blocked.push({ at: new Date().toISOString(), method, target: target.slice(0, 200), reason });
  };
  const sockets = new Set<net.Socket>();

  const server = http.createServer((req, res) => {
    let u: URL;
    try { u = new URL(req.url ?? ""); } catch { res.writeHead(400, { "content-type": "text/plain" }); res.end("Setor IA: requisição de proxy inválida."); return; }
    const reason = whyBlocked(u.origin, policy.allowed, policy.controlPorts);
    if (reason) {
      refuse(req.method ?? "GET", `${u.origin}${u.pathname}`, u.origin, reason);
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      res.end(`Setor IA: destino bloqueado no navegador de teste. ${reason}.`);
      return;
    }
    count(u.origin, "allowed");
    const headers = { ...req.headers };
    delete headers["proxy-connection"]; delete headers["proxy-authorization"];
    const up = http.request({ host: u.hostname.replace(/^\[|\]$/g, ""), port: u.port || 80, method: req.method, path: u.pathname + u.search, headers, agent: false }, r => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); });
    up.on("error", e => { if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" }); res.end(`Setor IA: a origem autorizada não respondeu (${e.message}).`); });
    res.on("close", () => up.destroy());
    req.pipe(up);
  });
  // CONNECT carries https and also ws:// / wss:// handshakes: only host:port is visible, so it must match an authorized origin's host and port
  // (the exact scheme of a WebSocket is checked again at page level).
  server.on("connect", (req, client: net.Socket) => {
    const target = req.url ?? "";
    const m = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(target);
    const host = m ? m[1].replace(/^\[|\]$/g, "").toLowerCase() : "", port = m ? Number(m[2]) : 0;
    const match = policy.allowed.find(a => { const i = inspectOrigin(a.origin, policy.controlPorts); return i.ok && i.host.toLowerCase() === host && i.port === port; });
    const asOrigin = `${port === 443 ? "https" : "http"}://${host}${port === 80 || port === 443 ? "" : `:${port}`}`;
    const reason = !m ? "destino de túnel inválido" : match ? (inspectOrigin(match.origin, policy.controlPorts).ok ? null : "origem recusada") : `${target} não corresponde a nenhuma origem autorizada para o navegador (${policy.allowed.map(a => a.origin).join(", ") || "nenhuma"})`;
    if (reason) {
      refuse("CONNECT", target, asOrigin, reason);
      client.end("HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\nSetor IA: destino bloqueado no navegador de teste.");
      return;
    }
    count(match!.origin, "allowed");
    const upstream = net.connect(port, host, () => { client.write("HTTP/1.1 200 Connection Established\r\n\r\n"); upstream.pipe(client); client.pipe(upstream); });
    sockets.add(client); sockets.add(upstream);
    const done = () => { client.destroy(); upstream.destroy(); sockets.delete(client); sockets.delete(upstream); };
    upstream.on("error", done); client.on("error", done); upstream.on("close", done); client.on("close", done);
  });
  server.on("clientError", (_e, socket) => { socket.destroy(); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    stats: () => ({ byOrigin: structuredClone(byOrigin), blocked: [...blocked], blockedTotal }),
    close: () => new Promise<void>(resolve => {
      for (const s of sockets) s.destroy();
      server.closeAllConnections?.();
      server.close(() => resolve());
      setTimeout(resolve, 2000).unref();
    }),
  };
}

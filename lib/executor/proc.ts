// Controlled execution of the official clients.
// - never through a shell: executable + argument array, no string interpolation;
// - prompt text goes through stdin, never through the command line;
// - fixed working directory, time limit, output caps, cancellation;
// - environment filtered so only the client's own stored login is used.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/** Environment variables passed to a client (plain map; no NODE_ENV requirement). */
export type EnvVars = Record<string, string | undefined>;

export type ProcSpec = {
  command: string;
  args: string[];
  cwd: string;
  stdin?: string;
  env: EnvVars;
  timeoutMs: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  signal?: AbortSignal;
  /** Called for every complete line of stdout while the process runs (progress of streaming clients). */
  onStdoutLine?: (line: string) => void;
};

export type ProcResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  truncated: boolean;
  /** Set when the process could not be started at all (e.g. ENOENT). */
  spawnError: string | null;
};

export type Runner = (spec: ProcSpec) => Promise<ProcResult>;

/**
 * Variables that would make a client use something other than the user's own
 * subscription login (API keys, gateways, cloud providers) or leak our token.
 */
const STRIPPED_ENV = [
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_PROFILE",
  "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
  "OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL", "OPENAI_ORG_ID", "OPENAI_PROJECT_ID",
  "AYLA_EXECUTOR_TOKEN", "GITHUB_TOKEN",
];

export function clientEnv(base: EnvVars = process.env): EnvVars {
  const env: EnvVars = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (STRIPPED_ENV.includes(k.toUpperCase())) continue;
    env[k] = v;
  }
  env.NO_COLOR = "1";
  env.CI = env.CI ?? "1";
  return env;
}

function killTree(pid: number | undefined) {
  if (!pid) return;
  if (process.platform === "win32") {
    // Structured arguments; the pid is a number we own.
    const k = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", shell: false });
    k.on("error", () => {});
  } else {
    try { process.kill(-pid, "SIGTERM"); } catch { try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ } }
  }
}

const LINE_BREAK = /\r?\n/;

/** A long-running process (e.g. the app under test) the executor starts, watches and always stops itself. */
export type BackgroundProcess = {
  pid: number | undefined;
  /** Last output lines (stdout and stderr interleaved), capped. */
  output: () => string;
  /** Resolves when the process exits (by itself or after stop()). */
  exited: Promise<number | null>;
  /** Kills the whole process tree; resolves once it exited (or after a short grace period). */
  stop: () => Promise<void>;
};

export type BackgroundSpawner = (spec: Omit<ProcSpec, "timeoutMs" | "stdin" | "onStdoutLine" | "maxStdoutBytes" | "maxStderrBytes">) => BackgroundProcess;

export const spawnBackground: BackgroundSpawner = spec => {
  let out = "";
  const keep = (d: string) => { out = (out + d).slice(-60_000); };
  let child: ChildProcessWithoutNullStreams | null = null;
  try {
    child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env as NodeJS.ProcessEnv, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
  } catch (err) {
    keep(`Não foi possível iniciar: ${(err as Error).message}`);
    return { pid: undefined, output: () => out, exited: Promise.resolve(null), stop: async () => {} };
  }
  const c = child;
  c.stdout.setEncoding("utf8"); c.stderr.setEncoding("utf8");
  c.stdout.on("data", keep); c.stderr.on("data", keep);
  c.stdin.end();
  const exited = new Promise<number | null>(resolve => { c.on("close", code => resolve(code)); c.on("error", e => { keep(`\n${e.message}`); resolve(null); }); });
  let done = false;
  void exited.then(() => { done = true; });
  const stop = async () => {
    if (done) return;
    killTree(c.pid);
    await Promise.race([exited, new Promise(r => setTimeout(r, 5000))]);
  };
  spec.signal?.addEventListener("abort", () => { void stop(); }, { once: true });
  return { pid: c.pid, output: () => out, exited, stop };
};

export const runProcess: Runner = spec =>
  new Promise(resolve => {
    if (/\.(cmd|bat)$/i.test(spec.command)) {
      resolve({ code: null, stdout: "", stderr: "", timedOut: false, aborted: false, truncated: false, spawnError: "Scripts .cmd/.bat não são executados (exigiriam um shell)." });
      return;
    }
    const maxOut = spec.maxStdoutBytes ?? 4_000_000;
    const maxErr = spec.maxStderrBytes ?? 200_000;
    let stdout = "", stderr = "", truncated = false, timedOut = false, aborted = false, settled = false;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(spec.command, spec.args, {
        cwd: spec.cwd, env: spec.env as NodeJS.ProcessEnv, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
    } catch (err) {
      resolve({ code: null, stdout: "", stderr: "", timedOut: false, aborted: false, truncated: false, spawnError: (err as Error).message });
      return;
    }
    const finish = (code: number | null, spawnError: string | null = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      spec.signal?.removeEventListener("abort", onAbort);
      resolve({ code, stdout, stderr, timedOut, aborted, truncated, spawnError });
    };
    const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, spec.timeoutMs);
    const onAbort = () => { aborted = true; killTree(child.pid); };
    if (spec.signal?.aborted) onAbort(); else spec.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let pending = "";
    child.stdout.on("data", (d: string) => {
      if (stdout.length + d.length > maxOut) { truncated = true; stdout += d.slice(0, Math.max(0, maxOut - stdout.length)); killTree(child.pid); } else stdout += d;
      if (spec.onStdoutLine) {
        pending += d;
        const parts = pending.split(LINE_BREAK);
        pending = parts.pop() ?? "";
        for (const line of parts) { try { spec.onStdoutLine(line); } catch { /* a progress callback never breaks the run */ } }
      }
    });
    child.stderr.on("data", (d: string) => { if (stderr.length < maxErr) stderr += d.slice(0, maxErr - stderr.length); });
    child.on("error", err => finish(null, (err as NodeJS.ErrnoException).code === "ENOENT" ? "Executável não encontrado." : err.message));
    child.on("close", code => finish(code));
    child.stdin.on("error", () => { /* the client may exit before reading everything */ });
    child.stdin.end(spec.stdin ?? "");
  });

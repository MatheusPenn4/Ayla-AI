// Shared by worktree.ts and local-git.ts (kept separate from both so neither has to import the other just
// for this — worktree.ts already imports from local-git.ts, and a cycle back would be fragile).
//
// Defense in depth: a diff comes from a git-archived commit (never .env/.dev.vars/node_modules) plus the
// model's own edits, so a real credential should not normally appear — but a diff is kept even when the run
// that produced it is rejected, so anything that looks like one is redacted before it is ever persisted or shown.
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bBearer\s+[A-Za-z0-9._-]{10,}/g,
];
// "API_KEY = \"...\"" style assignments: keep the name and quotes, redact only the value.
const ASSIGNMENT_PATTERN = /\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Za-z0-9_]*\s*[:=]\s*)(['"]?)([^\s'"]{6,})\2/gi;
export function redactSecrets(text: string): string {
  let out = SECRET_PATTERNS.reduce((t, re) => t.replace(re, "[REDACTED]"), text);
  out = out.replace(ASSIGNMENT_PATTERN, "$1$2[REDACTED]$2");
  return out;
}

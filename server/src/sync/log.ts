/**
 * Minimal structured logger for the long-running sync/controller processes
 * (not request paths). One JSON object per line on stdout/stderr so
 * journald / `docker logs` can ship it. Callers must pass only safe fields:
 * never connection strings, tokens, row payloads or password hashes.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

export function logEvent(level: LogLevel, event: string, data: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...data }) + "\n";
  (level === "error" || level === "warn" ? process.stderr : process.stdout).write(line);
}

/** Best-effort message from an unknown thrown value, never including stack/URLs. */
export function errorMessage(err: unknown): string {
  const e = err as { message?: unknown; cause?: { message?: unknown } };
  const msg = typeof e?.message === "string" ? e.message : String(err);
  const cause = typeof e?.cause?.message === "string" ? ` (${e.cause.message})` : "";
  return (msg + cause).slice(0, 500);
}

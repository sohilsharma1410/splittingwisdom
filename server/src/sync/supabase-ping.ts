import { logEvent, errorMessage } from "./log.js";

export interface PingOptions {
  /** e.g. https://abcd.supabase.co — no trailing slash needed. */
  url: string;
  anonKey: string;
  intervalMs: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * One cheap authenticated GET to Supabase's REST root. Hosted Supabase counts
 * API traffic (not just direct Postgres sessions) as activity for free-tier
 * auto-pause; this is the plan's S1.6 belt-and-braces ping. Never throws.
 */
export async function pingSupabase(opts: Pick<PingOptions, "url" | "anonKey" | "fetchImpl" | "timeoutMs">): Promise<boolean> {
  const doFetch = opts.fetchImpl ?? fetch;
  try {
    const res = await doFetch(`${opts.url.replace(/\/+$/, "")}/rest/v1/`, {
      method: "GET",
      headers: { apikey: opts.anonKey, Authorization: `Bearer ${opts.anonKey}` },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
    logEvent(res.ok ? "info" : "warn", "supabase_ping", { status: res.status });
    return res.ok;
  } catch (err) {
    logEvent("warn", "supabase_ping_failed", { error: errorMessage(err) });
    return false;
  }
}

/** Pings now and then every `intervalMs`. Returns a stop function. */
export function startSupabasePing(opts: PingOptions): () => void {
  void pingSupabase(opts);
  const timer = setInterval(() => void pingSupabase(opts), opts.intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

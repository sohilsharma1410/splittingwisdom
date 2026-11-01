// Decisions for switching between the primary (Pi) and standby (Vercel/Render)
// copies of the app. Pure and dependency-free so every edge case is unit
// tested; the React side only wires these to timers and the DOM.

export type NodeRole = "primary" | "standby" | "unknown";

export interface FailoverConfig {
  primaryUrl?: string;
  standbyUrl?: string;
}

/** Consecutive failed probes before the primary is treated as down. */
export const FAIL_THRESHOLD = 2;
/** Consecutive healthy probes before offering to switch back. */
export const RECOVER_THRESHOLD = 3;
/** Never auto-switch twice within this window — stops redirect ping-pong. */
export const MIN_SWITCH_GAP_MS = 5 * 60 * 1000;
export const PROBE_TIMEOUT_MS = 4000;

function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Which copy of the app is this page running from? "unknown" = failover off. */
export function detectRole(config: FailoverConfig, currentOrigin: string): NodeRole {
  const primary = originOf(config.primaryUrl);
  const standby = originOf(config.standbyUrl);
  if (!primary || !standby) return "unknown";
  if (currentOrigin === primary) return "primary";
  if (currentOrigin === standby) return "standby";
  return "unknown";
}

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

interface ProbeOptions {
  fetchFn?: FetchFn;
  timeoutMs?: number;
}

async function getWithTimeout(url: string, { fetchFn = fetch, timeoutMs = PROBE_TIMEOUT_MS }: ProbeOptions) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // No credentials: these are cross-origin reachability checks, not API calls.
    return await fetchFn(url, { signal: controller.signal, credentials: "omit", cache: "no-store" });
  } finally {
    clearTimeout(timer);
  }
}

/** Is this server reachable and answering? Never throws. */
export async function probeHealth(baseUrl: string, options: ProbeOptions = {}): Promise<boolean> {
  try {
    const res = await getWithTimeout(`${baseUrl.replace(/\/$/, "")}/api/health`, options);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Is the primary reachable AND safe to go back to? Reachable alone isn't
 * enough: after an outage the Pi must finish copying the standby's changes
 * back before it is writable again, or users would land on stale data.
 * Servers without the role endpoint (404) are judged on plain health.
 */
export async function probePrimaryReady(baseUrl: string, options: ProbeOptions = {}): Promise<boolean> {
  const base = baseUrl.replace(/\/$/, "");
  try {
    const res = await getWithTimeout(`${base}/api/health/role`, options);
    if (res.status === 404) return probeHealth(base, options);
    if (!res.ok) return false;
    // Contract (server/src/routes/health.ts): `writable` is true only when THIS node
    // is the one currently allowed to take writes — i.e. it is the active primary and
    // not mid-cutover or still catching up. `role` is "primary" | "standby" | "standalone".
    const body = (await res.json()) as { data?: { writable?: boolean; role?: string } };
    return body?.data?.writable === true && body?.data?.role !== "standby";
  } catch {
    return false;
  }
}

/** Same page, other origin: keeps the path so people land where they were. */
export function buildRedirectUrl(targetBase: string, location: { pathname: string; search: string; hash: string }): string {
  return `${targetBase.replace(/\/$/, "")}${location.pathname}${location.search}${location.hash}`;
}

/**
 * localStorage is per-origin, so the "I just switched" guard can't live there
 * alone: the origin we leave records it where nobody else can read it, and
 * the one we arrive at would bounce straight back. The timestamp rides along
 * in the redirect URL instead and is consumed on arrival.
 */
export const SWITCH_PARAM = "_sw";

export function stampRedirectUrl(url: string, now: number): string {
  const u = new URL(url);
  u.searchParams.set(SWITCH_PARAM, String(now));
  return u.toString();
}

export function extractSwitchStamp(href: string): { stamp: number | null; cleanedHref: string } {
  const u = new URL(href);
  const raw = u.searchParams.get(SWITCH_PARAM);
  if (raw === null) return { stamp: null, cleanedHref: href };
  u.searchParams.delete(SWITCH_PARAM);
  const stamp = /^\d{1,15}$/.test(raw) ? Number(raw) : null;
  return { stamp, cleanedHref: u.toString() };
}

export function canAutoSwitch(lastSwitchAt: number | null, now: number): boolean {
  return lastSwitchAt === null || now - lastSwitchAt >= MIN_SWITCH_GAP_MS;
}

/** Counts consecutive probe results; one outcome resets the other streak. */
export class ProbeTracker {
  failures = 0;
  successes = 0;
  record(ok: boolean) {
    if (ok) {
      this.successes++;
      this.failures = 0;
    } else {
      this.failures++;
      this.successes = 0;
    }
  }
}

/**
 * Probe up to `attempts` times, recording EVERY result in the tracker, and
 * stop at the first success. Recording each attempt (not just the final
 * outcome) is what lets a cold launch reach the failure threshold in one go.
 */
export async function probeRecording(probe: () => Promise<boolean>, tracker: ProbeTracker, attempts: number): Promise<boolean> {
  let ok = false;
  for (let i = 0; i < attempts && !ok; i++) {
    ok = await probe();
    tracker.record(ok);
  }
  return ok;
}

export interface PrimaryDownInput {
  role: NodeRole;
  failures: number;
  online: boolean;
}

/**
 * The primary looks down — but only blame the server when the phone itself
 * has a connection; offline, the backup would be just as unreachable.
 */
export function isPrimaryDown({ role, failures, online }: PrimaryDownInput): boolean {
  return role === "primary" && online && failures >= FAIL_THRESHOLD;
}

export interface PrimaryBackInput {
  role: NodeRole;
  successes: number;
}

export function isPrimaryBack({ role, successes }: PrimaryBackInput): boolean {
  return role === "standby" && successes >= RECOVER_THRESHOLD;
}

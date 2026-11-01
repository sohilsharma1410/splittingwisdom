import type { ActivePrimary } from "@splittingwisdom/shared";
import type { AppRole } from "./config.js";
import type { SystemStateRow } from "./state-store.js";

export interface RoleVerdict {
  /** This node may accept writes right now. */
  writable: boolean;
  role: AppRole | undefined;
  activePrimary: ActivePrimary | null;
  epoch: number | null;
  /** Why not writable (for logs / health output). */
  reason: string | null;
  /** The verdict comes from a cached read that could not be refreshed. */
  stale: boolean;
}

export interface RoleGuardOptions {
  role: AppRole | undefined;
  readState: () => Promise<SystemStateRow>;
  cacheMs: number;
  staleGraceMs: number;
  now?: () => number;
}

/** Which active_primary value makes a node of this role the writer. */
export function isActiveFor(role: AppRole, activePrimary: ActivePrimary): boolean {
  return role === "primary" ? activePrimary === "pi" : activePrimary === "standby";
}

/**
 * Fencing (plan S3.3). A node is writable only if the authoritative
 * system_state names it. The verdict is cached for `cacheMs`; concurrent
 * callers share one read.
 *
 * Failure policy (an owner-visible decision, see report):
 *   - cold start (nothing ever read) and authority unreachable -> NOT writable.
 *     A rebooted Pi must read the flag before it writes, so it can never
 *     resurrect itself as primary while the standby is active.
 *   - authority unreachable after a successful read -> the last verdict keeps
 *     applying for `staleGraceMs`; after that -> NOT writable. This keeps a
 *     healthy Pi writable through a short Supabase hiccup/pause instead of
 *     turning a standby problem into a primary outage.
 */
export class RoleGuard {
  private cached: { state: SystemStateRow; at: number } | null = null;
  private inflight: Promise<void> | null = null;
  private lastError: string | null = null;
  private readonly now: () => number;

  constructor(private readonly opts: RoleGuardOptions) {
    this.now = opts.now ?? Date.now;
  }

  get role(): AppRole | undefined {
    return this.opts.role;
  }

  private async refresh(): Promise<void> {
    try {
      const state = await this.opts.readState();
      this.cached = { state, at: this.now() };
      this.lastError = null;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message.slice(0, 200) : "authority unreachable";
    }
  }

  /** Never throws. */
  async check(): Promise<RoleVerdict> {
    const { role } = this.opts;
    if (!role) {
      return { writable: true, role, activePrimary: null, epoch: null, reason: null, stale: false };
    }

    const fresh = this.cached !== null && this.now() - this.cached.at < this.opts.cacheMs;
    if (!fresh) {
      this.inflight ??= this.refresh().finally(() => {
        this.inflight = null;
      });
      await this.inflight;
    }

    const c = this.cached;
    if (!c) {
      return {
        writable: false,
        role,
        activePrimary: null,
        epoch: null,
        reason: `role unverified: ${this.lastError ?? "no state"}`,
        stale: false,
      };
    }
    const age = this.now() - c.at;
    const stale = age >= this.opts.cacheMs; // refresh failed, serving the last read
    if (stale && age > this.opts.staleGraceMs) {
      return {
        writable: false,
        role,
        activePrimary: c.state.activePrimary,
        epoch: c.state.epoch,
        reason: "role unverified: authority unreachable too long",
        stale: true,
      };
    }
    const writable = isActiveFor(role, c.state.activePrimary);
    return {
      writable,
      role,
      activePrimary: c.state.activePrimary,
      epoch: c.state.epoch,
      reason: writable ? null : `active primary is "${c.state.activePrimary}"`,
      stale,
    };
  }

  /** Test/ops seam: forget the cached read. */
  invalidate(): void {
    this.cached = null;
  }
}

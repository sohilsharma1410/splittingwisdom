import type { RoleConfig } from "../roles/config.js";
import { makeSql, type Sql } from "../sync/client.js";
import { logEvent, errorMessage } from "../sync/log.js";
import { readSystemState, transitionSystemState } from "../roles/state-store.js";
import { runReverseSync, type ReverseSyncResult } from "./reverse-sync.js";

/**
 * Runs inside the Pi's API process (plan S4.1-S4.5). When the controller
 * (Render) opens a cutover window (`system_state = cutover`), this:
 *
 *   1. waits for writes on the standby to drain (the standby's cached role
 *      verdict lives up to ROLE_CACHE_SECONDS, so we wait that long + margin),
 *   2. runs the reverse sync (all-or-nothing, see reverse-sync.ts),
 *   3. on success flips system_state cutover -> pi with a compare-and-set on
 *      the epoch, marks the standby's own outbox delivered, and the forward
 *      sync resumes by itself because its fence now reads `pi`;
 *   4. on a permanent failure flips cutover -> standby: the Pi stays
 *      unchanged, the standby keeps serving, the owner gets an alert.
 */

export interface FailbackWorkerDeps {
  config: Pick<RoleConfig, "cacheMs">;
  /** Standby/authority database. */
  authority: Sql;
  /** The Pi's own database. */
  local: Sql;
  intervalMs?: number;
  /** How long a cutover must have lasted before the Pi acts (default cacheMs + 5 s). */
  settleMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  /** Test seam to observe results. */
  onResult?: (result: ReverseSyncResult) => void;
}

/** One cutover handled from start to finish. Exposed for tests. */
export async function handleCutover(deps: FailbackWorkerDeps): Promise<"completed" | "aborted" | "not-cutover" | "settling" | "lost-race"> {
  const state = await readSystemState(deps.authority);
  if (state.activePrimary !== "cutover") return "not-cutover";

  const settleMs = deps.settleMs ?? deps.config.cacheMs + 5_000;
  const [age] = await deps.authority<{ ms: number }[]>`
    SELECT (EXTRACT(EPOCH FROM (clock_timestamp() - updated_at)) * 1000)::float8 AS ms FROM system_state WHERE id = 1`;
  if (age.ms < settleMs) return "settling";

  const maxAttempts = deps.maxAttempts ?? 3;
  let last: ReverseSyncResult | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    last = await runReverseSync({ pi: deps.local, standby: deps.authority });
    deps.onResult?.(last);
    if (last.ok || !last.retryable) break;
    logEvent("warn", "failback_retry", { attempt, reason: last.reason });
    await new Promise((r) => setTimeout(r, deps.retryDelayMs ?? 5_000));
  }

  if (last?.ok) {
    const flipped = await transitionSystemState(deps.authority, state.epoch, "pi");
    if (!flipped) {
      logEvent("error", "failback_state_changed", { message: "reverse sync committed but system_state moved; it will be merged again next time" });
      return "lost-race";
    }
    // The standby's own change feed has been absorbed by the Pi: nothing left to forward from there.
    await deps.authority`UPDATE sync_outbox SET sent_at = now() WHERE sent_at IS NULL`;
    logEvent("info", "failback_completed", { epoch: flipped.epoch, ...last.applied });
    return "completed";
  }

  logEvent("error", "failback_aborted", { reason: last?.reason ?? "unknown" });
  await transitionSystemState(deps.authority, state.epoch, "standby");
  return "aborted";
}

/** Polls system_state; returns a stop function. */
export function startFailbackWorker(deps: { config: RoleConfig; authority: Sql; localUrl: string; localSsl: boolean }): () => void {
  const local = makeSql(deps.localUrl, deps.localSsl, 2);
  let running = false;
  let stopped = false;

  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      await handleCutover({ config: deps.config, authority: deps.authority, local });
    } catch (err) {
      logEvent("warn", "failback_poll_failed", { error: errorMessage(err) });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), 5_000);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
    void local.end({ timeout: 5 });
  };
}

import type { Sql } from "./client.js";
import type { GuardResult } from "./agent.js";
import { readSystemState } from "../roles/state-store.js";

/**
 * Fencing for the forward sync (plan S3.3): the Pi may copy changes to the
 * standby only while system_state says the Pi is the active primary. During a
 * standby outage / cutover the standby holds writes of its own, and a Pi that
 * has just come back must not push stale rows over them; it waits (events stay
 * queued, nothing is lost) until failback completes and the state is `pi` again.
 *
 * `target` is the standby database, which holds the authoritative state. If it
 * can't be read the call throws, which the agent treats as a transient failure
 * (back off, ship nothing).
 */
export async function systemStateGuard(target: Sql): Promise<GuardResult> {
  const state = await readSystemState(target);
  return state.activePrimary === "pi"
    ? { ok: true }
    : { ok: false, reason: `active primary is "${state.activePrimary}" (epoch ${state.epoch})` };
}

import type { ActivePrimary } from "@splittingwisdom/shared";

/**
 * Pure decision logic of the failover controller (plan S3.2-S3.5). No I/O, no
 * clock: feed it one observation per probe interval and it says whether to
 * change `system_state`. Everything that makes the controller safe lives here
 * so it can be unit-tested exhaustively.
 *
 *   pi --(3 consecutive ticks where BOTH the HTTP probe AND the heartbeat fail)--> standby
 *   standby --(5 consecutive fully-healthy ticks, after the dwell time)--------> cutover
 *   cutover --(Pi's failback worker finishes + verifies)-----------------------> pi      [done by the Pi, not here]
 *   cutover --(Pi dies again, or failback takes too long)----------------------> standby  (abort)
 *
 * Anti-flap rules:
 *   - every transition bumps the epoch and restarts counters and the dwell clock;
 *   - no transition (except aborting a cutover) before `minDwellTicks` have
 *     passed since the previous one;
 *   - every aborted cutover lengthens the dwell for the next attempt.
 */

export interface ControllerState {
  active: ActivePrimary;
  epoch: number;
  consecutiveFailures: number;
  consecutiveHealthy: number;
  ticksSinceTransition: number;
  abortedCutovers: number;
}

export interface Observation {
  /** Render -> Pi HTTP probe (GET /api/health/db) succeeded. */
  probeOk: boolean;
  /** The Pi's API has written a node_heartbeat row recently. */
  heartbeatFresh: boolean;
}

export interface DecisionConfig {
  failThreshold: number;
  healthyThreshold: number;
  /** Minimum ticks between transitions (hysteresis). */
  minDwellTicks: number;
  /** A cutover that lasts this many ticks is aborted (Pi's failback worker is stuck). */
  cutoverTimeoutTicks: number;
}

export const DEFAULT_DECISION_CONFIG: DecisionConfig = {
  failThreshold: 3,
  healthyThreshold: 5,
  minDwellTicks: 10,
  cutoverTimeoutTicks: 20,
};

export type Decision =
  | { kind: "none" }
  | { kind: "failover"; to: "standby" }
  | { kind: "begin_cutover"; to: "cutover" }
  | { kind: "abort_cutover"; to: "standby"; reason: "pi_down" | "timeout" };

export function initialState(active: ActivePrimary = "pi", epoch = 1): ControllerState {
  return {
    active,
    epoch,
    consecutiveFailures: 0,
    consecutiveHealthy: 0,
    // A freshly started controller (Render wakes up!) must be able to act on
    // what it sees: it assumes the current state has held for a long time.
    // The consecutive-probe thresholds still protect against acting on one blip.
    // (A cutover of unknown age gets a full timeout window instead.)
    ticksSinceTransition: active === "cutover" ? 0 : Number.MAX_SAFE_INTEGER,
    abortedCutovers: 0,
  };
}

function transition(state: ControllerState, to: ActivePrimary, abort = false): ControllerState {
  return {
    active: to,
    epoch: state.epoch + 1,
    consecutiveFailures: 0,
    consecutiveHealthy: 0,
    ticksSinceTransition: 0,
    abortedCutovers: abort ? state.abortedCutovers + 1 : to === "pi" ? 0 : state.abortedCutovers,
  };
}

/** Dwell grows 1x, 2x, 3x ... (max 6x) with each aborted cutover. */
export function requiredDwell(state: ControllerState, cfg: DecisionConfig): number {
  return cfg.minDwellTicks * Math.min(6, 1 + state.abortedCutovers);
}

/** One probe interval. Returns the next state (already reflecting any transition) and what to persist. */
export function step(
  state: ControllerState,
  obs: Observation,
  cfg: DecisionConfig = DEFAULT_DECISION_CONFIG,
): { state: ControllerState; decision: Decision } {
  const bothFail = !obs.probeOk && !obs.heartbeatFresh;
  const fullyHealthy = obs.probeOk && obs.heartbeatFresh;
  const counted: ControllerState = {
    ...state,
    ticksSinceTransition: state.ticksSinceTransition + 1,
    consecutiveFailures: bothFail ? state.consecutiveFailures + 1 : 0,
    consecutiveHealthy: fullyHealthy ? state.consecutiveHealthy + 1 : 0,
  };
  const dwelled = counted.ticksSinceTransition >= requiredDwell(counted, cfg);

  switch (state.active) {
    case "pi":
      if (counted.consecutiveFailures >= cfg.failThreshold && dwelled) {
        return { state: transition(counted, "standby"), decision: { kind: "failover", to: "standby" } };
      }
      return { state: counted, decision: { kind: "none" } };

    case "standby":
      if (counted.consecutiveHealthy >= cfg.healthyThreshold && dwelled) {
        return { state: transition(counted, "cutover"), decision: { kind: "begin_cutover", to: "cutover" } };
      }
      return { state: counted, decision: { kind: "none" } };

    case "cutover":
      // Aborting is a safety valve and is never delayed by the dwell rule.
      if (counted.consecutiveFailures >= cfg.failThreshold) {
        return {
          state: transition(counted, "standby", true),
          decision: { kind: "abort_cutover", to: "standby", reason: "pi_down" },
        };
      }
      if (counted.ticksSinceTransition >= cfg.cutoverTimeoutTicks) {
        return {
          state: transition(counted, "standby", true),
          decision: { kind: "abort_cutover", to: "standby", reason: "timeout" },
        };
      }
      return { state: counted, decision: { kind: "none" } };
  }
}

/**
 * Adopt a state that someone else wrote (the Pi's failback worker finishing a
 * cutover, a manual change, another controller instance): counters restart.
 */
export function adoptExternal(state: ControllerState, active: ActivePrimary, epoch: number): ControllerState {
  if (state.active === active && state.epoch === epoch) return state;
  return {
    active,
    epoch,
    consecutiveFailures: 0,
    consecutiveHealthy: 0,
    ticksSinceTransition: 0,
    abortedCutovers: active === "pi" ? 0 : state.abortedCutovers,
  };
}

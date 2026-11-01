import { describe, it, expect } from "vitest";
import {
  step,
  initialState,
  adoptExternal,
  requiredDwell,
  DEFAULT_DECISION_CONFIG,
  type ControllerState,
  type Observation,
  type Decision,
} from "./decide.js";

const UP: Observation = { probeOk: true, heartbeatFresh: true };
const DOWN: Observation = { probeOk: false, heartbeatFresh: false };
const PROBE_ONLY_FAILS: Observation = { probeOk: false, heartbeatFresh: true };
const BEAT_ONLY_FAILS: Observation = { probeOk: true, heartbeatFresh: false };

function run(start: ControllerState, observations: Observation[]) {
  let state = start;
  const decisions: Decision[] = [];
  for (const o of observations) {
    const r = step(state, o);
    state = r.state;
    decisions.push(r.decision);
  }
  return { state, decisions, kinds: decisions.map((d) => d.kind) };
}
const repeat = (o: Observation, n: number) => Array.from({ length: n }, () => o);

describe("failover (pi -> standby)", () => {
  it("fails over on the 3rd consecutive tick where BOTH probes fail, and bumps the epoch", () => {
    const { state, kinds } = run(initialState("pi", 7), repeat(DOWN, 3));
    expect(kinds).toEqual(["none", "none", "failover"]);
    expect(state.active).toBe("standby");
    expect(state.epoch).toBe(8);
  });

  it("does NOT fail over when only the HTTP probe fails (Pi heartbeat still fresh)", () => {
    const { state, kinds } = run(initialState(), repeat(PROBE_ONLY_FAILS, 20));
    expect(kinds.every((k) => k === "none")).toBe(true);
    expect(state.active).toBe("pi");
  });

  it("does NOT fail over when only the heartbeat is stale (HTTP probe fine)", () => {
    const { state } = run(initialState(), repeat(BEAT_ONLY_FAILS, 20));
    expect(state.active).toBe("pi");
  });

  it("any healthy-enough tick resets the failure count (needs 3 CONSECUTIVE failures)", () => {
    const { state } = run(initialState(), [DOWN, DOWN, PROBE_ONLY_FAILS, DOWN, DOWN]);
    expect(state.active).toBe("pi");
    expect(state.consecutiveFailures).toBe(2);
  });

  it("a freshly started controller can act immediately (no inherited dwell)", () => {
    const { kinds } = run(initialState(), repeat(DOWN, 3));
    expect(kinds[2]).toBe("failover");
  });

  it("is idempotent: once on standby, more failures decide nothing", () => {
    const { kinds } = run(initialState(), repeat(DOWN, 10));
    expect(kinds.filter((k) => k !== "none")).toEqual(["failover"]);
  });
});

describe("failback (standby -> cutover) and hysteresis", () => {
  const onStandby = () => run(initialState(), repeat(DOWN, 3)).state;

  it("needs 5 consecutive fully-healthy ticks AND the dwell time since the failover", () => {
    // Failover just happened: dwell is 10 ticks, so 5 healthy ticks are not enough...
    const early = run(onStandby(), repeat(UP, 5));
    expect(early.kinds.every((k) => k === "none")).toBe(true);
    expect(early.state.active).toBe("standby");

    // ...but by tick 10 since the failover (and still 5+ healthy in a row) it begins the cutover.
    const later = run(onStandby(), repeat(UP, 10));
    expect(later.kinds.filter((k) => k !== "none")).toEqual(["begin_cutover"]);
    expect(later.kinds.indexOf("begin_cutover")).toBe(9);
    expect(later.state.active).toBe("cutover");
  });

  it("one unhealthy tick restarts the healthy streak", () => {
    const { state, kinds } = run(onStandby(), [...repeat(UP, 9), PROBE_ONLY_FAILS, ...repeat(UP, 4)]);
    expect(kinds.every((k) => k === "none")).toBe(true);
    expect(state.consecutiveHealthy).toBe(4);
    const next = run(state, [UP]);
    expect(next.kinds).toEqual(["begin_cutover"]);
  });

  it("requires the heartbeat as well as the HTTP probe to count as healthy", () => {
    const { state } = run(onStandby(), repeat(BEAT_ONLY_FAILS, 40));
    expect(state.active).toBe("standby");
    const { state: s2 } = run(onStandby(), repeat(PROBE_ONLY_FAILS, 40));
    expect(s2.active).toBe("standby");
  });

  it("never flaps: a Pi that alternates up/down never triggers any transition", () => {
    const start = onStandby();
    const alternating = Array.from({ length: 100 }, (_, i) => (i % 2 ? UP : DOWN));
    const { state, kinds } = run(start, alternating);
    expect(kinds.every((k) => k === "none")).toBe(true);
    expect(state.active).toBe("standby");
    expect(state.epoch).toBe(start.epoch);
  });

  it("after the Pi takes the cutover back to 'pi' the dwell prevents an immediate re-failover", () => {
    const afterReturn = adoptExternal(initialState("cutover", 9), "pi", 10);
    expect(afterReturn.ticksSinceTransition).toBe(0);
    const { kinds, state } = run(afterReturn, repeat(DOWN, 5));
    expect(kinds.every((k) => k === "none")).toBe(true);
    expect(state.active).toBe("pi");
    // ...but a Pi that stays down is failed over as soon as the dwell has passed.
    const sustained = run(afterReturn, repeat(DOWN, DEFAULT_DECISION_CONFIG.minDwellTicks));
    expect(sustained.state.active).toBe("standby");
  });
});

describe("cutover aborts", () => {
  const inCutover = () => run(run(initialState(), repeat(DOWN, 3)).state, repeat(UP, 10)).state;

  it("starts in cutover (sanity)", () => {
    expect(inCutover().active).toBe("cutover");
  });

  it("holds while the Pi is healthy and the failback worker is still running", () => {
    const { state, kinds } = run(inCutover(), repeat(UP, 15));
    expect(kinds.every((k) => k === "none")).toBe(true);
    expect(state.active).toBe("cutover");
  });

  it("aborts back to standby when the Pi dies mid-failback (3 consecutive failures), bumping the epoch", () => {
    const start = inCutover();
    const { state, decisions } = run(start, repeat(DOWN, 3));
    expect(decisions[2]).toEqual({ kind: "abort_cutover", to: "standby", reason: "pi_down" });
    expect(state.active).toBe("standby");
    expect(state.epoch).toBe(start.epoch + 1);
    expect(state.abortedCutovers).toBe(1);
  });

  it("aborts on timeout if the failback worker never finishes", () => {
    const { decisions, state } = run(inCutover(), repeat(UP, DEFAULT_DECISION_CONFIG.cutoverTimeoutTicks));
    expect(decisions[decisions.length - 1]).toEqual({ kind: "abort_cutover", to: "standby", reason: "timeout" });
    expect(state.active).toBe("standby");
  });

  it("each aborted cutover lengthens the dwell before the next attempt (capped at 6x)", () => {
    let s: ControllerState = { ...initialState(), abortedCutovers: 0 };
    expect(requiredDwell(s, DEFAULT_DECISION_CONFIG)).toBe(10);
    s = { ...s, abortedCutovers: 2 };
    expect(requiredDwell(s, DEFAULT_DECISION_CONFIG)).toBe(30);
    s = { ...s, abortedCutovers: 50 };
    expect(requiredDwell(s, DEFAULT_DECISION_CONFIG)).toBe(60);
  });

  it("a completed failback (state adopted as 'pi') clears the abort penalty", () => {
    const penalised: ControllerState = { ...initialState("cutover", 4), abortedCutovers: 3 };
    expect(adoptExternal(penalised, "pi", 5).abortedCutovers).toBe(0);
  });
});

describe("initialState", () => {
  it("a controller that wakes up in the middle of a cutover gets a full timeout window, not an instant abort", () => {
    const { decisions } = run(initialState("cutover", 4), repeat(UP, 3));
    expect(decisions.every((d) => d.kind === "none")).toBe(true);
  });
});

describe("adoptExternal", () => {
  it("keeps state untouched when nothing changed, restarts counters when something did", () => {
    const s = { ...initialState("pi", 3), consecutiveFailures: 2 };
    expect(adoptExternal(s, "pi", 3)).toBe(s);
    const changed = adoptExternal(s, "standby", 4);
    expect(changed).toMatchObject({ active: "standby", epoch: 4, consecutiveFailures: 0, ticksSinceTransition: 0 });
  });
});

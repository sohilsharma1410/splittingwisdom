import type { Sql } from "../sync/client.js";
import type { RoleConfig } from "../roles/config.js";
import { readSystemState, transitionSystemState, readHeartbeat } from "../roles/state-store.js";
import { logEvent, errorMessage } from "../sync/log.js";
import {
  step,
  initialState,
  adoptExternal,
  type ControllerState,
  type Decision,
  type DecisionConfig,
} from "./decide.js";

export interface ControllerDeps {
  /** The standby/Supabase database: system_state + node_heartbeat live here. */
  authority: Sql;
  /** GET <pi>/api/health/db from outside; true iff it answered 200 in time. */
  probePi: () => Promise<boolean>;
  /** Alerting hook (P7); defaults to a structured log line. */
  alert?: (event: string, data: Record<string, unknown>) => void;
}

export interface TickResult {
  decision: Decision;
  state: ControllerState;
  probeOk: boolean;
  heartbeatFresh: boolean;
}

/**
 * Runs on the standby (Render). Every probe interval it observes the Pi twice
 * (HTTP probe from outside + the heartbeat the Pi's API writes into this DB),
 * feeds the pure state machine in decide.ts, and persists any transition with
 * a compare-and-set on the epoch, so two controller instances (or a controller
 * and the Pi's failback worker) can never both win.
 *
 * It does NOT perform the failback itself: the reverse sync has to run next to
 * the Pi's database, which Render cannot reach. The controller only opens the
 * window (`cutover`); the Pi's failback worker does the work and flips the
 * state to `pi` (or back to `standby` if verification fails). See
 * server/src/failback/worker.ts.
 */
export class Controller {
  private state: ControllerState | null = null;
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopped = false;

  constructor(
    private readonly cfg: Pick<RoleConfig, "probeIntervalMs" | "heartbeatStaleMs" | "failThreshold" | "healthyThreshold">,
    private readonly deps: ControllerDeps,
    private readonly decisionCfg: Partial<DecisionConfig> = {},
  ) {}

  private alert(event: string, data: Record<string, unknown> = {}) {
    (this.deps.alert ?? ((e, d) => logEvent("warn", `controller_${e}`, d)))(event, data);
  }

  private decisionConfig(): DecisionConfig {
    return {
      failThreshold: this.cfg.failThreshold,
      healthyThreshold: this.cfg.healthyThreshold,
      minDwellTicks: 10,
      cutoverTimeoutTicks: 20,
      ...this.decisionCfg,
    };
  }

  /** One observe-decide-persist cycle. Exposed for tests; start() calls it on a timer. */
  async tick(): Promise<TickResult> {
    const row = await readSystemState(this.deps.authority);
    this.state =
      this.state === null
        ? initialState(row.activePrimary, row.epoch)
        : adoptExternal(this.state, row.activePrimary, row.epoch);

    const [probeOk, beat] = await Promise.all([
      this.deps.probePi().catch(() => false),
      readHeartbeat(this.deps.authority, "pi"),
    ]);
    const heartbeatFresh = beat !== null && beat.ageMs <= this.cfg.heartbeatStaleMs;

    const next = step(this.state, { probeOk, heartbeatFresh }, this.decisionConfig());
    if (next.decision.kind === "none") {
      this.state = next.state;
      return { decision: next.decision, state: this.state, probeOk, heartbeatFresh };
    }

    const written = await transitionSystemState(this.deps.authority, this.state.epoch, next.decision.to);
    if (!written) {
      // Someone else (the Pi's failback worker, another controller) moved first. Re-adopt next tick.
      this.state = null;
      this.alert("transition_lost_race", { wanted: next.decision.kind });
      return { decision: { kind: "none" }, state: initialState(row.activePrimary, row.epoch), probeOk, heartbeatFresh };
    }
    this.state = { ...next.state, epoch: written.epoch };
    this.alert(next.decision.kind, {
      to: written.activePrimary,
      epoch: written.epoch,
      probeOk,
      heartbeatFresh,
      ...("reason" in next.decision ? { reason: next.decision.reason } : {}),
    });
    return { decision: next.decision, state: this.state, probeOk, heartbeatFresh };
  }

  start(): void {
    this.stopped = false;
    const loop = async () => {
      if (this.running || this.stopped) return;
      this.running = true;
      try {
        await this.tick();
      } catch (err) {
        logEvent("error", "controller_tick_failed", { error: errorMessage(err) });
      } finally {
        this.running = false;
      }
    };
    void loop();
    this.timer = setInterval(() => void loop(), this.cfg.probeIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }
}

/** The real probe: Render -> Pi via the public Funnel URL. */
export function makeHttpProbe(baseUrl: string, timeoutMs: number, fetchImpl: typeof fetch = fetch): () => Promise<boolean> {
  return async () => {
    try {
      const res = await fetchImpl(`${baseUrl}/api/health/db`, { signal: AbortSignal.timeout(timeoutMs) });
      return res.status === 200;
    } catch {
      return false;
    }
  };
}

/**
 * Forward sync agent: Pi (primary) -> standby Postgres, one way (plan S2.2).
 *
 *   npm run sync:agent --workspace=server          (tsx, dev / Pi with dev deps)
 *   node dist/sync/agent.js                        (compiled)
 *   ... --resync                                   queue a full copy first
 *
 * How it stays correct:
 *   - Triggers (migration 0006) append every change to `sync_outbox` in the
 *     same transaction as the change, so a committed write can never be
 *     missed, whatever the agent is doing.
 *   - A batch of unsent events is applied to the target in ONE transaction,
 *     idempotently (ON CONFLICT (id) DO UPDATE guarded by updated_at,
 *     tombstone-aware, see apply.ts).
 *   - Events are marked sent on the source ONLY after the target COMMITted.
 *     Crash anywhere => at worst the batch is re-applied, which is a no-op.
 *   - All state lives in Postgres, so a restart resumes where it left off.
 *   - Failures back off exponentially (max 60 s) and never drop events;
 *     `lagSeconds` (age of the oldest unsent event) grows until it recovers.
 */
import { pathToFileURL } from "node:url";
import { loadSyncConfig, type SyncConfig } from "./config.js";
import { makeSql, type Sql } from "./client.js";
import { applyEvents, loadColumns, type ApplyHooks, type ColumnsByTable } from "./apply.js";
import {
  fetchUnsent,
  markSent,
  purgeSent,
  readLag,
  recordFailure,
  recordSuccess,
  enqueueFullResync,
} from "./outbox.js";
import { syncSessions } from "./sessions.js";
import { startSupabasePing } from "./supabase-ping.js";
import { logEvent, errorMessage } from "./log.js";

export interface AgentHooks extends ApplyHooks {
  /** Test seam: after the target COMMIT, before the source marks events sent. */
  afterCommit?: () => void | Promise<void>;
}

export interface GuardResult {
  ok: boolean;
  reason?: string;
}

export interface AgentOptions {
  hooks?: AgentHooks;
  /**
   * Fencing: consulted before every batch; when `ok` is false nothing is
   * shipped (e.g. the standby has taken over writes). Defaults to allow.
   */
  guard?: (target: Sql) => Promise<GuardResult>;
}

export interface AgentStatus {
  pending: number;
  lagSeconds: number;
  lastSyncAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  pausedReason: string | null;
}

const MAX_BACKOFF_MS = 60_000;

export function backoffMs(consecutiveFailures: number, random: () => number = Math.random): number {
  const base = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.max(0, consecutiveFailures - 1));
  return Math.round(base * (0.75 + random() * 0.5)); // +/-25 % jitter
}

export class SyncAgent {
  readonly source: Sql;
  readonly target: Sql;
  private columns?: ColumnsByTable;
  private stopping = false;
  private wake?: () => void;
  private loop?: Promise<void>;
  private failures = 0;
  private pausedReason: string | null = null;
  private lastError: string | null = null;

  constructor(
    private readonly cfg: SyncConfig,
    private readonly opts: AgentOptions = {},
  ) {
    this.source = makeSql(cfg.sourceUrl, cfg.sourceSsl, 3);
    this.target = makeSql(cfg.targetUrl, cfg.targetSsl, 2);
  }

  private async ensureColumns(): Promise<ColumnsByTable> {
    this.columns ??= await loadColumns(this.target);
    return this.columns;
  }

  /** Ships one batch. Returns how many events were delivered (0 = idle or paused). */
  async shipBatch(): Promise<number> {
    if (this.opts.guard) {
      const verdict = await this.opts.guard(this.target);
      this.pausedReason = verdict.ok ? null : (verdict.reason ?? "paused by guard");
      if (!verdict.ok) return 0;
    }
    const events = await fetchUnsent(this.source, this.cfg.batchSize);
    if (events.length === 0) return 0;

    const columns = await this.ensureColumns();
    await applyEvents(this.target, events, columns, this.opts.hooks);
    await this.opts.hooks?.afterCommit?.();
    await markSent(this.source, events.map((e) => e.id));
    return events.length;
  }

  /** Ships batches until nothing is left (or a guard pauses it). */
  async drain(): Promise<number> {
    let total = 0;
    for (;;) {
      const n = await this.shipBatch();
      if (n === 0) return total;
      total += n;
    }
  }

  async status(): Promise<AgentStatus> {
    const lag = await readLag(this.source);
    const [row] = await this.source<{ last_success_at: Date | null; last_error: string | null }[]>`
      SELECT last_success_at, last_error FROM sync_status WHERE id = 1`;
    return {
      ...lag,
      lastSyncAt: row?.last_success_at ? row.last_success_at.toISOString() : null,
      lastError: this.lastError ?? row?.last_error ?? null,
      consecutiveFailures: this.failures,
      pausedReason: this.pausedReason,
    };
  }

  /** Runs until stop() is called. Resolves when the loop has fully exited. */
  start(): Promise<void> {
    this.stopping = false;
    this.loop = this.run();
    return this.loop;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.wake?.();
    await this.loop?.catch(() => undefined);
  }

  async close(): Promise<void> {
    await this.stop();
    await Promise.allSettled([this.source.end({ timeout: 5 }), this.target.end({ timeout: 5 })]);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      const self = this;
      function done() {
        clearTimeout(timer);
        self.wake = undefined;
        resolve();
      }
      this.wake = done;
    });
  }

  private async run(): Promise<void> {
    let lastBeat = 0;
    let lastSessions = 0;
    let lastPurge = 0;
    logEvent("info", "sync_agent_started", { batchSize: this.cfg.batchSize, pollMs: this.cfg.pollMs });

    while (!this.stopping) {
      try {
        const shipped = await this.shipBatch();
        if (this.failures > 0) logEvent("info", "sync_recovered", { afterFailures: this.failures });
        this.failures = 0;
        this.lastError = null;
        const now = Date.now();

        if (shipped > 0) {
          await recordSuccess(this.source);
          lastBeat = now;
          logEvent("debug", "sync_batch_sent", { events: shipped });
          continue; // more may be waiting; don't sleep
        }
        if (this.pausedReason === null && now - lastBeat >= this.cfg.heartbeatMs) {
          await recordSuccess(this.source);
          lastBeat = now;
        }
        if (this.pausedReason === null && this.cfg.sessionSyncMs > 0 && now - lastSessions >= this.cfg.sessionSyncMs) {
          lastSessions = now;
          try {
            await syncSessions(this.source, this.target);
          } catch (err) {
            logEvent("warn", "session_sync_failed", { error: errorMessage(err) });
          }
        }
        if (now - lastPurge >= 60_000) {
          lastPurge = now;
          await purgeSent(this.source, this.cfg.purgeSentAfterMinutes).catch(() => undefined);
        }
      } catch (err) {
        this.failures += 1;
        this.lastError = errorMessage(err);
        const delay = backoffMs(this.failures);
        logEvent("error", "sync_batch_failed", { error: this.lastError, failures: this.failures, retryInMs: delay });
        await recordFailure(this.source, this.lastError).catch(() => undefined);
        if (!this.stopping) await this.sleep(delay);
        continue;
      }
      if (!this.stopping) await this.sleep(this.cfg.pollMs);
    }
    logEvent("info", "sync_agent_stopped");
  }
}

async function main(): Promise<void> {
  await import("dotenv/config");
  const cfg = loadSyncConfig();
  const agent = new SyncAgent(cfg);

  if (process.argv.includes("--resync")) {
    const queued = await enqueueFullResync(agent.source);
    logEvent("info", "full_resync_queued", { events: queued });
  }

  const stopPing = cfg.supabase ? startSupabasePing({ url: cfg.supabase.url, anonKey: cfg.supabase.anonKey, intervalMs: cfg.supabase.pingIntervalMs }) : undefined;

  const shutdown = (signal: string) => {
    logEvent("info", "sync_agent_signal", { signal });
    stopPing?.();
    void agent.close().then(() => process.exit(0));
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));

  await agent.start();
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main().catch((err) => {
    logEvent("error", "sync_agent_fatal", { error: errorMessage(err) });
    process.exit(1);
  });
}

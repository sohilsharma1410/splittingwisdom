import { expect } from "vitest";
import type postgres from "postgres";
import { SYNCED_TABLES } from "@splittingwisdom/shared";
import type { SyncConfig } from "../../src/sync/config.js";
import { requireTestDatabaseUrl, requireStandbyDatabaseUrl } from "./env.js";

export function testSyncConfig(overrides: Partial<SyncConfig> = {}): SyncConfig {
  return {
    sourceUrl: requireTestDatabaseUrl(),
    sourceSsl: false,
    targetUrl: requireStandbyDatabaseUrl(),
    targetSsl: false,
    batchSize: 100,
    pollMs: 30,
    sessionSyncMs: 0,
    purgeSentAfterMinutes: 60,
    heartbeatMs: 1000,
    ...overrides,
  };
}

/** Every row of every synced table as JSON (all columns, incl. updated_at/origin), by id. */
export async function snapshot(sql: postgres.Sql): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const table of SYNCED_TABLES) {
    const rows = await sql.unsafe(`SELECT to_jsonb(t) AS row FROM "${table}" t ORDER BY id`);
    out[table] = rows.map((r) => r.row);
  }
  return out;
}

export async function expectIdentical(a: postgres.Sql, b: postgres.Sql, label = ""): Promise<void> {
  const [sa, sb] = [await snapshot(a), await snapshot(b)];
  for (const table of SYNCED_TABLES) {
    expect(sb[table], `${label} table ${table}`).toEqual(sa[table]);
  }
}

export async function rowCounts(sql: postgres.Sql): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of SYNCED_TABLES) {
    const [r] = await sql.unsafe(`SELECT count(*)::int AS n FROM "${table}"`);
    out[table] = r.n;
  }
  return out;
}

export async function waitFor(check: () => Promise<boolean>, timeoutMs = 20_000, everyMs = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`waitFor timed out after ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

/** Deterministic PRNG (mulberry32) so a failing fuzz run can be replayed from its seed. */
export function makeRng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n: number) => Math.floor(next() * n),
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)],
    chance: (p: number) => next() < p,
  };
}
export type Rng = ReturnType<typeof makeRng>;

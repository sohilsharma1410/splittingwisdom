import { describe, it, expect, vi } from "vitest";
import { loadSyncConfig } from "./config.js";
import { backoffMs } from "./agent.js";
import { upsertSql, deleteSql } from "./apply.js";
import { pingSupabase } from "./supabase-ping.js";

describe("loadSyncConfig", () => {
  const base = {
    DATABASE_URL: "postgres://pi/db",
    SYNC_TARGET_DATABASE_URL: "postgres://supabase/db",
  };

  it("applies defaults: source ssl off, target ssl on", () => {
    const cfg = loadSyncConfig(base);
    expect(cfg.sourceUrl).toBe("postgres://pi/db");
    expect(cfg.sourceSsl).toBe(false);
    expect(cfg.targetSsl).toBe(true);
    expect(cfg.batchSize).toBe(500);
    expect(cfg.supabase).toBeUndefined();
  });

  it("reads SYNC_TARGET_SSL=off and SYNC_SOURCE_DATABASE_URL", () => {
    const cfg = loadSyncConfig({ ...base, SYNC_SOURCE_DATABASE_URL: "postgres://other/db", SYNC_TARGET_SSL: "off" });
    expect(cfg.sourceUrl).toBe("postgres://other/db");
    expect(cfg.targetSsl).toBe(false);
  });

  it("requires a target and refuses source == target", () => {
    expect(() => loadSyncConfig({ DATABASE_URL: "postgres://pi/db" })).toThrow(/SYNC_TARGET_DATABASE_URL/);
    expect(() => loadSyncConfig({ DATABASE_URL: "postgres://x/db", SYNC_TARGET_DATABASE_URL: "postgres://x/db" })).toThrow(
      /differ/,
    );
  });

  it("rejects junk values loudly", () => {
    expect(() => loadSyncConfig({ ...base, SYNC_TARGET_SSL: "maybe" })).toThrow(/on" or "off/);
    expect(() => loadSyncConfig({ ...base, SYNC_BATCH_SIZE: "0" })).toThrow(/positive/);
  });

  it("enables the Supabase ping only when both URL and anon key are present", () => {
    expect(loadSyncConfig({ ...base, SUPABASE_URL: "https://x.supabase.co" }).supabase).toBeUndefined();
    const cfg = loadSyncConfig({ ...base, SUPABASE_URL: "https://x.supabase.co/", SUPABASE_ANON_KEY: "k" });
    expect(cfg.supabase).toEqual({ url: "https://x.supabase.co", anonKey: "k", pingIntervalMs: 21_600_000 });
  });
});

describe("backoffMs", () => {
  it("grows exponentially, is capped at ~60 s, and jitters +/-25 %", () => {
    const mid = () => 0.5; // jitter factor 1.0
    expect(backoffMs(1, mid)).toBe(1000);
    expect(backoffMs(2, mid)).toBe(2000);
    expect(backoffMs(4, mid)).toBe(8000);
    expect(backoffMs(20, mid)).toBe(60_000);
    expect(backoffMs(20, () => 0)).toBe(45_000);
    expect(backoffMs(20, () => 1)).toBe(75_000);
  });
});

describe("apply SQL shape", () => {
  it("upsert is id-keyed, LWW-guarded, tombstone-aware and never writes `id` in SET", () => {
    const sql = upsertSql("bills", ["id", "description", "updated_at", "origin"]);
    expect(sql).toContain('ON CONFLICT (id) DO UPDATE SET "description" = EXCLUDED."description"');
    expect(sql).not.toContain('"id" = EXCLUDED');
    expect(sql).toContain('WHERE "bills".updated_at <= EXCLUDED.updated_at');
    expect(sql).toContain("deletion_log");
  });

  it("delete never removes a row edited after the delete", () => {
    expect(deleteSql("users")).toContain("updated_at <= $2::timestamptz");
  });
});

describe("pingSupabase", () => {
  it("GETs {url}/rest/v1/ with the anon key and reports success", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const ok = await pingSupabase({ url: "https://x.supabase.co/", anonKey: "anon", fetchImpl: fetchImpl as never });
    expect(ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://x.supabase.co/rest/v1/");
    expect((init.headers as Record<string, string>).apikey).toBe("anon");
  });

  it("returns false (never throws) on network errors and non-2xx", async () => {
    const boom = vi.fn(async () => {
      throw new Error("network down");
    });
    expect(await pingSupabase({ url: "https://x", anonKey: "k", fetchImpl: boom as never })).toBe(false);
    const nope = vi.fn(async () => new Response("no", { status: 401 }));
    expect(await pingSupabase({ url: "https://x", anonKey: "k", fetchImpl: nope as never })).toBe(false);
  });
});

import { describe, it, expect, vi } from "vitest";
import { RoleGuard, isActiveFor } from "./guard.js";
import type { SystemStateRow } from "./state-store.js";

const state = (activePrimary: SystemStateRow["activePrimary"], epoch = 1): SystemStateRow => ({
  activePrimary,
  epoch,
  updatedAt: new Date(0),
});

function setup(role: "primary" | "standby" | undefined, initial: SystemStateRow | Error) {
  let clock = 1_000_000;
  let current: SystemStateRow | Error = initial;
  const readState = vi.fn(async () => {
    if (current instanceof Error) throw current;
    return current;
  });
  const guard = new RoleGuard({ role, readState, cacheMs: 10_000, staleGraceMs: 600_000, now: () => clock });
  return {
    guard,
    readState,
    advance: (ms: number) => (clock += ms),
    set: (s: SystemStateRow | Error) => (current = s),
  };
}

describe("isActiveFor", () => {
  it("primary is active only on 'pi'; standby only on 'standby'; nobody during 'cutover'", () => {
    expect(isActiveFor("primary", "pi")).toBe(true);
    expect(isActiveFor("primary", "standby")).toBe(false);
    expect(isActiveFor("primary", "cutover")).toBe(false);
    expect(isActiveFor("standby", "standby")).toBe(true);
    expect(isActiveFor("standby", "pi")).toBe(false);
    expect(isActiveFor("standby", "cutover")).toBe(false);
  });
});

describe("RoleGuard", () => {
  it("with no APP_ROLE everything is writable and the authority is never read", async () => {
    const { guard, readState } = setup(undefined, new Error("never read"));
    expect((await guard.check()).writable).toBe(true);
    expect(readState).not.toHaveBeenCalled();
  });

  it("caches the verdict for 10 s and then re-reads", async () => {
    const { guard, readState, advance, set } = setup("primary", state("pi"));
    expect((await guard.check()).writable).toBe(true);
    await guard.check();
    advance(9_000);
    await guard.check();
    expect(readState).toHaveBeenCalledTimes(1);

    set(state("standby", 2));
    advance(2_000); // 11 s since the read
    const v = await guard.check();
    expect(readState).toHaveBeenCalledTimes(2);
    expect(v).toMatchObject({ writable: false, activePrimary: "standby", epoch: 2 });
  });

  it("concurrent callers share one in-flight read", async () => {
    const { guard, readState } = setup("standby", state("standby"));
    await Promise.all(Array.from({ length: 25 }, () => guard.check()));
    expect(readState).toHaveBeenCalledTimes(1);
  });

  it("a Pi that boots while the standby is active (or cutting over) refuses writes", async () => {
    for (const active of ["standby", "cutover"] as const) {
      const { guard } = setup("primary", state(active, 5));
      const v = await guard.check();
      expect(v.writable).toBe(false);
      expect(v.reason).toContain(active);
    }
  });

  it("COLD START with the authority unreachable: not writable (fail closed)", async () => {
    const { guard } = setup("primary", new Error("connect ETIMEDOUT"));
    const v = await guard.check();
    expect(v.writable).toBe(false);
    expect(v.reason).toMatch(/unverified/);
  });

  it("authority goes away AFTER a good read: last verdict holds for the grace period, then fails closed", async () => {
    const { guard, advance, set } = setup("primary", state("pi"));
    expect((await guard.check()).writable).toBe(true);
    set(new Error("supabase paused"));

    advance(30_000);
    const during = await guard.check();
    expect(during).toMatchObject({ writable: true, stale: true });

    advance(580_000); // 610 s since the last good read
    const after = await guard.check();
    expect(after.writable).toBe(false);
    expect(after.reason).toMatch(/too long/);
  });

  it("a stale 'not writable' verdict never turns into 'writable'", async () => {
    const { guard, advance, set } = setup("primary", state("standby"));
    await guard.check();
    set(new Error("down"));
    advance(60_000);
    expect((await guard.check()).writable).toBe(false);
  });

  it("recovers on the next successful read", async () => {
    const { guard, advance, set } = setup("standby", new Error("down"));
    expect((await guard.check()).writable).toBe(false);
    set(state("standby", 3));
    advance(10_001);
    expect(await guard.check()).toMatchObject({ writable: true, epoch: 3 });
  });
});

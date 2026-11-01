import { describe, expect, it, vi } from "vitest";
import {
  FAIL_THRESHOLD,
  MIN_SWITCH_GAP_MS,
  RECOVER_THRESHOLD,
  ProbeTracker,
  buildRedirectUrl,
  canAutoSwitch,
  detectRole,
  extractSwitchStamp,
  isPrimaryBack,
  isPrimaryDown,
  probeHealth,
  probePrimaryReady,
  probeRecording,
  stampRedirectUrl,
} from "./failover";

const config = {
  primaryUrl: "https://pi.tail1234.ts.net/",
  standbyUrl: "https://splittingwisdom-client.vercel.app",
};

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status });

describe("detectRole", () => {
  it("recognises each copy of the app by origin", () => {
    expect(detectRole(config, "https://pi.tail1234.ts.net")).toBe("primary");
    expect(detectRole(config, "https://splittingwisdom-client.vercel.app")).toBe("standby");
  });
  it("is off when either URL is missing, malformed, or the origin is unknown", () => {
    expect(detectRole({}, "https://pi.tail1234.ts.net")).toBe("unknown");
    expect(detectRole({ primaryUrl: config.primaryUrl }, "https://pi.tail1234.ts.net")).toBe("unknown");
    expect(detectRole({ primaryUrl: "not a url", standbyUrl: config.standbyUrl }, "x")).toBe("unknown");
    expect(detectRole(config, "http://localhost:5173")).toBe("unknown");
  });
});

describe("probeHealth", () => {
  it("is true only for an ok response", async () => {
    expect(await probeHealth("https://x", { fetchFn: async () => json(200, {}) })).toBe(true);
    expect(await probeHealth("https://x", { fetchFn: async () => json(503) })).toBe(false);
  });
  it("is false on network failure and never throws", async () => {
    expect(await probeHealth("https://x", { fetchFn: async () => { throw new TypeError("Failed to fetch"); } })).toBe(false);
  });
  it("gives up after the timeout", async () => {
    const hang = (_u: string, init?: RequestInit) =>
      new Promise<Response>((_res, rej) => init?.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))));
    expect(await probeHealth("https://x", { fetchFn: hang, timeoutMs: 20 })).toBe(false);
  });
  it("calls /api/health without credentials and tolerates a trailing slash", async () => {
    const fetchFn = vi.fn(async () => json(200));
    await probeHealth("https://x/", { fetchFn });
    expect(fetchFn).toHaveBeenCalledWith("https://x/api/health", expect.objectContaining({ credentials: "omit" }));
  });
});

describe("probePrimaryReady", () => {
  it("is ready only once the node is the active primary and writable", async () => {
    expect(await probePrimaryReady("https://x", { fetchFn: async () => json(200, { data: { role: "primary", writable: true, activePrimary: "pi" } }) })).toBe(true);
    expect(await probePrimaryReady("https://x", { fetchFn: async () => json(200, { data: { role: "standalone", writable: true } }) })).toBe(true);
  });
  it("is NOT ready while recovering, mid-cutover, read-only, or while the standby is the active one", async () => {
    expect(await probePrimaryReady("https://x", { fetchFn: async () => json(200, { data: { role: "primary", writable: false, activePrimary: "cutover" } }) })).toBe(false);
    expect(await probePrimaryReady("https://x", { fetchFn: async () => json(200, { data: { role: "primary", writable: false, activePrimary: "standby" } }) })).toBe(false);
    expect(await probePrimaryReady("https://x", { fetchFn: async () => json(200, { data: { role: "standby", writable: true } }) })).toBe(false);
    expect(await probePrimaryReady("https://x", { fetchFn: async () => json(200, { data: {} }) })).toBe(false);
  });
  it("falls back to plain health when the role endpoint doesn't exist yet (404)", async () => {
    const fetchFn = vi.fn(async (url: string) => (url.endsWith("/role") ? json(404) : json(200, {})));
    expect(await probePrimaryReady("https://x", { fetchFn })).toBe(true);
    const down = vi.fn(async (url: string) => (url.endsWith("/role") ? json(404) : json(503)));
    expect(await probePrimaryReady("https://x", { fetchFn: down })).toBe(false);
  });
  it("is false on errors, bad JSON or 5xx", async () => {
    expect(await probePrimaryReady("https://x", { fetchFn: async () => json(500) })).toBe(false);
    expect(await probePrimaryReady("https://x", { fetchFn: async () => new Response("not json", { status: 200 }) })).toBe(false);
    expect(await probePrimaryReady("https://x", { fetchFn: async () => { throw new Error("net"); } })).toBe(false);
  });
});

describe("buildRedirectUrl", () => {
  it("keeps path, query and hash on the other origin", () => {
    expect(buildRedirectUrl("https://v.app/", { pathname: "/group/3", search: "?tab=bills", hash: "#x" })).toBe("https://v.app/group/3?tab=bills#x");
  });
});

describe("canAutoSwitch", () => {
  it("blocks a second automatic switch inside the gap (no redirect loops)", () => {
    expect(canAutoSwitch(null, 1000)).toBe(true);
    expect(canAutoSwitch(1000, 1000 + MIN_SWITCH_GAP_MS - 1)).toBe(false);
    expect(canAutoSwitch(1000, 1000 + MIN_SWITCH_GAP_MS)).toBe(true);
  });
});

describe("ProbeTracker + thresholds", () => {
  it("one blip never fails over; a streak does", () => {
    const t = new ProbeTracker();
    t.record(false);
    expect(isPrimaryDown({ role: "primary", failures: t.failures, online: true })).toBe(false);
    t.record(true);
    t.record(false);
    expect(t.failures).toBe(1);
    for (let i = 1; i < FAIL_THRESHOLD; i++) t.record(false);
    expect(isPrimaryDown({ role: "primary", failures: t.failures, online: true })).toBe(true);
  });
  it("is never 'down' when the phone itself is offline, or on the wrong role", () => {
    expect(isPrimaryDown({ role: "primary", failures: 9, online: false })).toBe(false);
    expect(isPrimaryDown({ role: "standby", failures: 9, online: true })).toBe(false);
    expect(isPrimaryDown({ role: "unknown", failures: 9, online: true })).toBe(false);
  });
  it("offers switching back only after a healthy streak, and a failure resets it", () => {
    const t = new ProbeTracker();
    for (let i = 0; i < RECOVER_THRESHOLD - 1; i++) t.record(true);
    expect(isPrimaryBack({ role: "standby", successes: t.successes })).toBe(false);
    t.record(false);
    t.record(true);
    expect(isPrimaryBack({ role: "standby", successes: t.successes })).toBe(false);
    for (let i = 0; i < RECOVER_THRESHOLD; i++) t.record(true);
    expect(isPrimaryBack({ role: "standby", successes: t.successes })).toBe(true);
    expect(isPrimaryBack({ role: "primary", successes: 99 })).toBe(false);
  });
});

describe("probeRecording (cold-launch probing)", () => {
  it("two failed attempts on a cold launch reach the failover threshold", async () => {
    const t = new ProbeTracker();
    const ok = await probeRecording(async () => false, t, 2);
    expect(ok).toBe(false);
    expect(t.failures).toBe(2);
    expect(isPrimaryDown({ role: "primary", failures: t.failures, online: true })).toBe(true);
  });
  it("a recovery on the second attempt is a success and clears the streak", async () => {
    const t = new ProbeTracker();
    const results = [false, true];
    const ok = await probeRecording(async () => results.shift()!, t, 2);
    expect(ok).toBe(true);
    expect(t.failures).toBe(0);
  });
  it("a normal (non-cold) check makes exactly one attempt", async () => {
    const t = new ProbeTracker();
    const probe = vi.fn(async () => false);
    await probeRecording(probe, t, 1);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(isPrimaryDown({ role: "primary", failures: t.failures, online: true })).toBe(false);
  });
});

describe("switch stamp travels with the redirect (guard works across origins)", () => {
  it("adds the timestamp and keeps path, existing query and hash", () => {
    const url = stampRedirectUrl("https://v.app/group/3?tab=bills#x", 1700000000000);
    expect(url).toBe("https://v.app/group/3?tab=bills&_sw=1700000000000#x");
  });
  it("is read back and removed, leaving the original URL", () => {
    const { stamp, cleanedHref } = extractSwitchStamp("https://v.app/group/3?tab=bills&_sw=1700000000000#x");
    expect(stamp).toBe(1700000000000);
    expect(cleanedHref).toBe("https://v.app/group/3?tab=bills#x");
  });
  it("round-trips, and the guard then blocks an immediate bounce back", () => {
    const now = 1_700_000_000_000;
    const { stamp } = extractSwitchStamp(stampRedirectUrl(buildRedirectUrl("https://v.app", { pathname: "/", search: "", hash: "" }), now));
    expect(canAutoSwitch(stamp, now + 1000)).toBe(false);
    expect(canAutoSwitch(stamp, now + MIN_SWITCH_GAP_MS)).toBe(true);
  });
  it("ignores garbage stamps but still strips them", () => {
    expect(extractSwitchStamp("https://v.app/?_sw=abc").stamp).toBeNull();
    expect(extractSwitchStamp("https://v.app/?_sw=abc").cleanedHref).toBe("https://v.app/");
    expect(extractSwitchStamp("https://v.app/?_sw=-5").stamp).toBeNull();
  });
  it("does nothing when there is no stamp", () => {
    expect(extractSwitchStamp("https://v.app/a?b=1")).toEqual({ stamp: null, cleanedHref: "https://v.app/a?b=1" });
  });
});

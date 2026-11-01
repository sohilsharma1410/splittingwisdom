import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import postgres from "postgres";
import { requireTestDatabaseUrl, requireStandbyDatabaseUrl } from "./helpers/env.js";
import { connect, truncateAll } from "./helpers/db.js";
import { waitFor } from "./helpers/sync.js";
import { installRoleFencing, startHeartbeat, type RoleRuntime } from "../src/roles/install.js";
import { readSystemState, transitionSystemState, writeHeartbeat, readHeartbeat } from "../src/roles/state-store.js";
import { Controller } from "../src/controller/controller.js";
import { makeSql } from "../src/sync/client.js";

let pi: postgres.Sql; // the Pi's local database (also what src/db.ts points at in this process)
let standby: postgres.Sql; // authority: system_state + heartbeats
const runtimes: RoleRuntime[] = [];

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const CACHE_WAIT = 90;

async function setState(active: "pi" | "standby" | "cutover") {
  await standby`UPDATE system_state SET active_primary = ${active}, epoch = epoch + 1, updated_at = now() WHERE id = 1`;
}

function node(role: "primary" | "standby", env: Record<string, string> = {}) {
  const app = express();
  app.use(express.json());
  const runtime = installRoleFencing(app, {
    APP_ROLE: role,
    ROLE_STATE_DATABASE_URL: requireStandbyDatabaseUrl(),
    ROLE_STATE_SSL: "off",
    ROLE_CACHE_SECONDS: "0.05",
    HEARTBEAT_INTERVAL_SECONDS: "3600",
    ...env,
  });
  runtimes.push(runtime);
  app.get("/api/echo", (_req, res) => res.json({ data: { ok: true } }));
  app.post("/api/echo", (_req, res) => res.status(201).json({ data: { ok: true } }));
  app.patch("/api/echo", (_req, res) => res.json({ data: { ok: true } }));
  app.delete("/api/echo", (_req, res) => res.json({ data: { ok: true } }));
  app.post("/api/auth/login", (_req, res) => res.json({ data: { loggedIn: true } }));
  app.post("/api/auth/logout", (_req, res) => res.json({ data: { loggedOut: true } }));
  return app;
}

beforeAll(() => {
  pi = connect(requireTestDatabaseUrl());
  standby = connect(requireStandbyDatabaseUrl());
});
afterAll(async () => {
  await Promise.all([pi.end(), standby.end()]);
});
beforeEach(async () => {
  await truncateAll(pi);
  await truncateAll(standby);
});
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((r) => r.stop()));
});

describe("requireWritable + GET /api/health/role", () => {
  it("while the Pi is active: Pi writes pass, standby writes get 503 {error:{message}}, reads always pass", async () => {
    const piApp = node("primary");
    const standbyApp = node("standby");

    expect((await request(piApp).post("/api/echo").send({})).status).toBe(201);
    const blocked = await request(standbyApp).post("/api/echo").send({});
    expect(blocked.status).toBe(503);
    expect(blocked.body).toEqual({ error: { message: "Read-only: backup mode switching" } });
    expect(blocked.headers["retry-after"]).toBe("5");

    for (const method of ["patch", "delete"] as const) {
      expect((await request(standbyApp)[method]("/api/echo").send({})).status).toBe(503);
    }
    expect((await request(standbyApp).get("/api/echo")).status).toBe(200);
  });

  it("after a failover the roles swap within the cache window; during cutover NOBODY can write", async () => {
    const piApp = node("primary");
    const standbyApp = node("standby");
    await request(piApp).get("/api/health/role"); // warm both caches
    await request(standbyApp).get("/api/health/role");

    await setState("standby");
    await wait(CACHE_WAIT);
    expect((await request(piApp).post("/api/echo").send({})).status).toBe(503);
    expect((await request(standbyApp).post("/api/echo").send({})).status).toBe(201);

    await setState("cutover");
    await wait(CACHE_WAIT);
    expect((await request(piApp).post("/api/echo").send({})).status).toBe(503);
    expect((await request(standbyApp).post("/api/echo").send({})).status).toBe(503);
    expect((await request(standbyApp).get("/api/echo")).status).toBe(200); // still readable

    await setState("pi");
    await wait(CACHE_WAIT);
    expect((await request(piApp).post("/api/echo").send({})).status).toBe(201);
    expect((await request(standbyApp).post("/api/echo").send({})).status).toBe(503);
  });

  it("sign-in/out stay available on a read-only node", async () => {
    const standbyApp = node("standby");
    expect((await request(standbyApp).post("/api/auth/login").send({})).status).toBe(200);
    expect((await request(standbyApp).post("/api/auth/logout").send({})).status).toBe(200);
  });

  it("a Pi that boots while it cannot reach the authority refuses writes (fail closed), reads still work", async () => {
    const lonelyPi = node("primary", { ROLE_STATE_DATABASE_URL: "postgres://postgres@127.0.0.1:1/none" });
    const res = await request(lonelyPi).post("/api/echo").send({});
    expect(res.status).toBe(503);
    expect((await request(lonelyPi).get("/api/echo")).status).toBe(200);
    const role = await request(lonelyPi).get("/api/health/role");
    expect(role.body.data).toMatchObject({ role: "primary", active: false, writable: false, epoch: null });
  });

  it("no APP_ROLE = standalone: nothing is blocked and /api/health/role says so", async () => {
    const app = express();
    app.use(express.json());
    runtimes.push(installRoleFencing(app, {}));
    app.post("/api/echo", (_req, res) => res.status(201).json({ data: { ok: true } }));
    expect((await request(app).post("/api/echo").send({})).status).toBe(201);
    const role = await request(app).get("/api/health/role");
    expect(role.body.data).toMatchObject({ role: "standalone", active: true, epoch: null });
  });

  it("GET /api/health/role reports role, active, epoch, lastSyncAt and lagSeconds (primary: local outbox)", async () => {
    // Queue an old unsent event on the Pi and record a sync success.
    await pi`INSERT INTO users (email, password_hash, display_name) VALUES ('h@x.test', 'h', 'H')`;
    await pi`UPDATE sync_outbox SET "at" = now() - interval '42 seconds'`;
    await pi`UPDATE sync_status SET last_success_at = '2026-11-01T10:00:00Z'`;

    const res = await request(node("primary")).get("/api/health/role");
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      role: "primary",
      active: true,
      activePrimary: "pi",
      epoch: 1,
      writable: true,
      lastSyncAt: "2026-11-01T10:00:00.000Z",
    });
    expect(res.body.data.lagSeconds).toBeGreaterThanOrEqual(42);
    expect(res.body.data.lagSeconds).toBeLessThan(60);
  });

  it("standby reports the Pi's sync position from the heartbeat row", async () => {
    await writeHeartbeat(makeSql(requireStandbyDatabaseUrl(), false, 1), "pi", {
      lastSyncAt: new Date("2026-11-01T09:59:00Z"),
      lagSeconds: 3.5,
    });
    const res = await request(node("standby")).get("/api/health/role");
    expect(res.body.data).toMatchObject({
      role: "standby",
      active: false,
      activePrimary: "pi",
      lastSyncAt: "2026-11-01T09:59:00.000Z",
      lagSeconds: 3.5,
    });
  });
});

describe("heartbeat", () => {
  it("beats into the authority with the Pi's sync position, and does NOT beat when the local DB is unhealthy", async () => {
    const authority = makeSql(requireStandbyDatabaseUrl(), false, 1);
    try {
      let healthy = true;
      const stop = startHeartbeat(authority, 40, async () => {
        if (!healthy) throw new Error("local db down");
        return { lastSyncAt: new Date("2026-11-01T08:00:00Z"), lagSeconds: 1.25 };
      });
      await waitFor(async () => (await readHeartbeat(authority, "pi")) !== null, 5000);
      const first = await readHeartbeat(authority, "pi");
      expect(first).toMatchObject({ lagSeconds: 1.25 });

      await wait(120);
      expect((await readHeartbeat(authority, "pi"))!.beatAt.getTime()).toBeGreaterThan(first!.beatAt.getTime());

      healthy = false;
      await wait(60); // let an in-flight beat finish
      const frozen = (await readHeartbeat(authority, "pi"))!.beatAt.getTime();
      await wait(200);
      expect((await readHeartbeat(authority, "pi"))!.beatAt.getTime()).toBe(frozen);
      stop();
    } finally {
      await authority.end();
    }
  });
});

describe("controller against a real authority database", () => {
  const cfg = { probeIntervalMs: 10, heartbeatStaleMs: 45_000, failThreshold: 3, healthyThreshold: 5 };

  function makeController(probe: { ok: boolean }, dwell = 2, cutoverTimeout = 50) {
    const authority = makeSql(requireStandbyDatabaseUrl(), false, 2);
    const alerts: string[] = [];
    const controller = new Controller(
      cfg,
      { authority, probePi: async () => probe.ok, alert: (e) => alerts.push(e) },
      { minDwellTicks: dwell, cutoverTimeoutTicks: cutoverTimeout },
    );
    return { controller, authority, alerts };
  }
  const beat = (a: ReturnType<typeof makeSql>) => writeHeartbeat(a, "pi", { lastSyncAt: null, lagSeconds: 0 });

  it("fails over after 3 ticks where the probe AND the heartbeat both fail; epoch++", async () => {
    const probe = { ok: false };
    const { controller, authority, alerts } = makeController(probe);
    try {
      await controller.tick();
      await controller.tick();
      expect((await readSystemState(authority)).activePrimary).toBe("pi");
      await controller.tick();
      const after = await readSystemState(authority);
      expect(after).toMatchObject({ activePrimary: "standby", epoch: 2 });
      expect(alerts).toContain("failover");
    } finally {
      await authority.end();
    }
  });

  it("does not fail over while the Pi's heartbeat is fresh, even if Render's HTTP probe cannot reach it", async () => {
    const probe = { ok: false };
    const { controller, authority } = makeController(probe);
    try {
      for (let i = 0; i < 8; i++) {
        await beat(authority);
        await controller.tick();
      }
      expect(await readSystemState(authority)).toMatchObject({ activePrimary: "pi", epoch: 1 });
    } finally {
      await authority.end();
    }
  });

  it("full cycle: failover -> Pi recovers -> cutover -> (Pi's worker) back to pi, never flapping", async () => {
    const probe = { ok: false };
    const { controller, authority } = makeController(probe);
    try {
      for (let i = 0; i < 3; i++) await controller.tick();
      expect((await readSystemState(authority)).activePrimary).toBe("standby");

      probe.ok = true;
      const seen: string[] = [];
      for (let i = 0; i < 12; i++) {
        await beat(authority);
        seen.push((await controller.tick()).decision.kind);
      }
      expect(seen.filter((k) => k !== "none")).toEqual(["begin_cutover"]);
      expect(await readSystemState(authority)).toMatchObject({ activePrimary: "cutover", epoch: 3 });

      // The Pi's failback worker finishes and flips the state (compare-and-set on the epoch).
      expect(await transitionSystemState(authority, 3, "pi")).toMatchObject({ activePrimary: "pi", epoch: 4 });
      await beat(authority);
      expect((await controller.tick()).decision.kind).toBe("none"); // adopts the Pi's change
      expect(await readSystemState(authority)).toMatchObject({ activePrimary: "pi", epoch: 4 });
    } finally {
      await authority.end();
    }
  });

  it("aborts a stuck cutover back to standby", async () => {
    const probe = { ok: true };
    const { controller, authority } = makeController(probe, 1, 6);
    try {
      await standby`UPDATE system_state SET active_primary = 'cutover', epoch = 5`;
      for (let i = 0; i < 6; i++) {
        await beat(authority);
        await controller.tick();
      }
      expect(await readSystemState(authority)).toMatchObject({ activePrimary: "standby", epoch: 6 });
    } finally {
      await authority.end();
    }
  });

  it("transitions are compare-and-set: a stale writer loses the race and changes nothing", async () => {
    const authority = makeSql(requireStandbyDatabaseUrl(), false, 1);
    try {
      expect(await transitionSystemState(authority, 99, "standby")).toBeNull();
      expect(await readSystemState(authority)).toMatchObject({ activePrimary: "pi", epoch: 1 });
      expect(await transitionSystemState(authority, 1, "standby")).toMatchObject({ epoch: 2 });
      expect(await transitionSystemState(authority, 1, "pi")).toBeNull();
    } finally {
      await authority.end();
    }
  });
});

describe("forward sync is fenced by system_state", () => {
  it("ships nothing while the standby/cutover is in charge, keeps the events queued, and resumes when the state is 'pi'", async () => {
    const { SyncAgent } = await import("../src/sync/agent.js");
    const { systemStateGuard } = await import("../src/sync/fence.js");
    const { testSyncConfig } = await import("./helpers/sync.js");
    const { readLag } = await import("../src/sync/outbox.js");
    await pi`INSERT INTO users (email, password_hash, display_name) VALUES ('f@x.test', 'h', 'F')`;

    const agent = new SyncAgent(testSyncConfig(), { guard: systemStateGuard });
    try {
      for (const active of ["standby", "cutover"] as const) {
        await setState(active);
        expect(await agent.drain()).toBe(0);
        expect((await agent.status()).pausedReason).toContain(active);
        expect((await readLag(pi)).pending).toBe(1);
        expect(await standby`SELECT 1 FROM users`).toHaveLength(0);
      }
      await setState("pi");
      expect(await agent.drain()).toBe(1);
      expect((await agent.status()).pausedReason).toBeNull();
      expect(await standby`SELECT email FROM users`).toEqual([{ email: "f@x.test" }]);
    } finally {
      await agent.close();
    }
  });
});

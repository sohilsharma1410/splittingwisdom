import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { Express } from "express";
import postgres from "postgres";
import { requireTestDatabaseUrl } from "./helpers/env.js";
import { connect, truncateAll } from "./helpers/db.js";
import { getApp, httpServer, registerUser, createGroup, billBody, type TestUser } from "./helpers/app.js";
import { fingerprintRequest } from "../src/lib/request-fingerprint.js";

let app: Express;
let sql: postgres.Sql;
let alice: TestUser;
let bob: TestUser;
let aliceGroup: { groupId: number; memberId: number };

const count = async (table: string) =>
  Number((await sql.unsafe(`SELECT count(*)::int AS n FROM ${table}`))[0].n);

beforeAll(async () => {
  sql = connect(requireTestDatabaseUrl());
  app = await getApp();
});

afterAll(async () => {
  await sql.end();
});

beforeEach(async () => {
  await truncateAll(sql);
  alice = await registerUser(app, "Alice");
  bob = await registerUser(app, "Bob");
  aliceGroup = await createGroup(alice, "Alice's trip");
});

const body = (description = "Dinner") =>
  billBody({
    groupId: aliceGroup.groupId,
    paidByMemberId: aliceGroup.memberId,
    memberIds: [aliceGroup.memberId],
    description,
  });

describe("Idempotency-Key on POST /api/bills", () => {
  it("replays the stored response for the same key + same request", async () => {
    const first = await alice.agent.post("/api/bills").set("Idempotency-Key", "k-1").send(body());
    expect(first.status).toBe(201);
    expect(first.headers["idempotent-replay"]).toBeUndefined();

    const second = await alice.agent.post("/api/bills").set("Idempotency-Key", "k-1").send(body());
    expect(second.status).toBe(201);
    expect(second.headers["idempotent-replay"]).toBe("true");
    expect(second.body).toEqual(first.body);

    expect(await count("bills")).toBe(1);
    expect(await count("bill_items")).toBe(1);
  });

  it("treats key order inside the body as irrelevant (canonical fingerprint)", async () => {
    const b = body();
    const reordered = Object.fromEntries(Object.entries(b).reverse());
    const first = await alice.agent.post("/api/bills").set("Idempotency-Key", "k-order").send(b);
    const second = await alice.agent.post("/api/bills").set("Idempotency-Key", "k-order").send(reordered);
    expect(first.status).toBe(201);
    expect(second.headers["idempotent-replay"]).toBe("true");
    expect(await count("bills")).toBe(1);
  });

  it("returns 422 when the key is reused with a different request, and creates nothing", async () => {
    await alice.agent.post("/api/bills").set("Idempotency-Key", "k-2").send(body("Dinner"));
    const res = await alice.agent.post("/api/bills").set("Idempotency-Key", "k-2").send(body("Lunch"));
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/different request/i);
    expect(await count("bills")).toBe(1);
  });

  it("race: 20 parallel identical requests create exactly one bill", async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        alice.agent.post("/api/bills").set("Idempotency-Key", "k-race").send(body()),
      ),
    );

    expect(await count("bills")).toBe(1);
    const originals = results.filter((r) => r.headers["idempotent-replay"] !== "true");
    expect(originals).toHaveLength(1);
    // Duplicates are serialized: they wait for the original and replay it.
    for (const r of results) {
      expect(r.status).toBe(201);
      expect(r.body.data.bill.id).toBe(originals[0].body.data.bill.id);
    }
  });

  it("without the header behaves as before: two identical posts make two bills", async () => {
    const a = await alice.agent.post("/api/bills").send(body());
    const b = await alice.agent.post("/api/bills").send(body());
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.headers["idempotent-replay"]).toBeUndefined();
    expect(a.body.data.bill.id).not.toBe(b.body.data.bill.id);
    expect(await count("bills")).toBe(2);
    expect(await count("idempotency_keys")).toBe(0);
  });

  it("is isolated per user: bob cannot replay (or collide with) alice's key", async () => {
    const first = await alice.agent.post("/api/bills").set("Idempotency-Key", "shared-key").send(body());
    expect(first.status).toBe(201);

    // Bob replaying Alice's exact request: not a member of her group -> 404,
    // never alice's stored response.
    const intruder = await bob.agent.post("/api/bills").set("Idempotency-Key", "shared-key").send(body());
    expect(intruder.status).toBe(404);
    expect(intruder.headers["idempotent-replay"]).toBeUndefined();
    expect(JSON.stringify(intruder.body)).not.toContain(String(first.body.data.bill.id));

    // Bob using the same key string for his own bill gets his own execution.
    const bobGroup = await createGroup(bob, "Bob's trip");
    const bobBill = await bob.agent
      .post("/api/bills")
      .set("Idempotency-Key", "shared-key")
      .send(billBody({ ...bobGroup, paidByMemberId: bobGroup.memberId, memberIds: [bobGroup.memberId] }));
    expect(bobBill.status).toBe(201);
    expect(bobBill.headers["idempotent-replay"]).toBeUndefined();
    expect(bobBill.body.data.bill.id).not.toBe(first.body.data.bill.id);

    const again = await alice.agent.post("/api/bills").set("Idempotency-Key", "shared-key").send(body());
    expect(again.headers["idempotent-replay"]).toBe("true");
    expect(again.body.data.bill.id).toBe(first.body.data.bill.id);
    expect(await count("bills")).toBe(2);
  });

  it("does not cache failures: a 400 releases the key so a corrected retry works", async () => {
    const bad = await alice.agent
      .post("/api/bills")
      .set("Idempotency-Key", "k-fix")
      .send({ ...body(), description: "" });
    expect(bad.status).toBe(400);
    expect(await count("idempotency_keys")).toBe(0);

    const good = await alice.agent.post("/api/bills").set("Idempotency-Key", "k-fix").send(body());
    expect(good.status).toBe(201);
    expect(good.headers["idempotent-replay"]).toBeUndefined();
  });

  it("rejects malformed keys with 400", async () => {
    const res = await alice.agent.post("/api/bills").set("Idempotency-Key", "has spaces").send(body());
    expect(res.status).toBe(400);
    const long = await alice.agent.post("/api/bills").set("Idempotency-Key", "x".repeat(256)).send(body());
    expect(long.status).toBe(400);
    expect(await count("bills")).toBe(0);
  });

  it("returns 409 + Retry-After when an identical request is still in flight past the wait timeout", async () => {
    const fp = fingerprintRequest("POST", "/api/bills", body());
    await sql`
      INSERT INTO idempotency_keys (user_id, key, fingerprint, status)
      VALUES (${alice.id}, 'k-stuck', ${fp}, 'in_progress')`;
    const res = await alice.agent.post("/api/bills").set("Idempotency-Key", "k-stuck").send(body());
    expect(res.status).toBe(409);
    expect(res.headers["retry-after"]).toBe("1");
    expect(await count("bills")).toBe(0);
  });

  it("takes over a stale in-progress claim left by a crashed process", async () => {
    const fp = fingerprintRequest("POST", "/api/bills", body());
    await sql`
      INSERT INTO idempotency_keys (user_id, key, fingerprint, status, created_at)
      VALUES (${alice.id}, 'k-crash', ${fp}, 'in_progress', now() - interval '10 minutes')`;
    const res = await alice.agent.post("/api/bills").set("Idempotency-Key", "k-crash").send(body());
    expect(res.status).toBe(201);
    expect(await count("bills")).toBe(1);
  });

  it("expires keys after 24 h: the same key then executes again", async () => {
    const first = await alice.agent.post("/api/bills").set("Idempotency-Key", "k-old").send(body());
    expect(first.status).toBe(201);
    await sql`UPDATE idempotency_keys SET created_at = now() - interval '25 hours' WHERE key = 'k-old'`;

    const second = await alice.agent.post("/api/bills").set("Idempotency-Key", "k-old").send(body());
    expect(second.status).toBe(201);
    expect(second.headers["idempotent-replay"]).toBeUndefined();
    expect(second.body.data.bill.id).not.toBe(first.body.data.bill.id);
    expect(await count("bills")).toBe(2);
  });
});

describe("Idempotency-Key on the other creating POSTs", () => {
  it("POST /api/groups: replay returns the same group, one row", async () => {
    const a = await alice.agent.post("/api/groups").set("Idempotency-Key", "g-1").send({ name: "Flat" });
    const b = await alice.agent.post("/api/groups").set("Idempotency-Key", "g-1").send({ name: "Flat" });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.headers["idempotent-replay"]).toBe("true");
    expect(b.body.data.group.id).toBe(a.body.data.group.id);
    // beforeEach made one group already ("Alice's trip"), plus this one.
    expect(await count("groups")).toBe(2);
  });

  it("POST /api/groups/:id/members: replay returns the same member, one row", async () => {
    const path = `/api/groups/${aliceGroup.groupId}/members`;
    const a = await alice.agent.post(path).set("Idempotency-Key", "m-1").send({ userId: bob.id });
    const b = await alice.agent.post(path).set("Idempotency-Key", "m-1").send({ userId: bob.id });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.headers["idempotent-replay"]).toBe("true");
    expect(b.body.data.member.id).toBe(a.body.data.member.id);
    expect(await count("group_members")).toBe(2);

    // Same key, different target path/body -> 422.
    const carol = await registerUser(app, "Carol");
    const c = await alice.agent.post(path).set("Idempotency-Key", "m-1").send({ userId: carol.id });
    expect(c.status).toBe(422);
  });

  it("requires membership before touching the key store", async () => {
    const path = `/api/groups/${aliceGroup.groupId}/members`;
    const res = await bob.agent.post(path).set("Idempotency-Key", "m-x").send({ userId: bob.id });
    expect(res.status).toBe(404);
    expect(await count("idempotency_keys")).toBe(0);
  });

  it("unauthenticated requests are rejected before any key is stored", async () => {
    const { default: request } = await import("supertest");
    const res = await request(httpServer(app)).post("/api/bills").set("Idempotency-Key", "anon").send(body());
    expect(res.status).toBe(401);
    expect(await count("idempotency_keys")).toBe(0);
  });
});

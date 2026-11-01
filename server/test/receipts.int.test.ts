import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { Express } from "express";
import postgres from "postgres";
import request from "supertest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { requireTestDatabaseUrl } from "./helpers/env.js";
import { connect, truncateAll } from "./helpers/db.js";
import { billBody, createGroup, getApp, httpServer, registerUser, type TestUser } from "./helpers/app.js";

// Plan P3.2: the Pi's local receipt storage, through the real routes.
const IMAGE = Buffer.from("not really a png, but the route only checks the declared type");

let app: Express;
let sql: postgres.Sql;
let dir: string;
let alice: TestUser;
let bob: TestUser;
let billId: number;
const savedEnv = { driver: process.env.STORAGE_DRIVER, dir: process.env.RECEIPTS_DIR };

beforeAll(async () => {
  sql = connect(requireTestDatabaseUrl());
  app = await getApp();
  dir = await mkdtemp(path.join(tmpdir(), "receipts-int-"));
  process.env.RECEIPTS_DIR = dir;
});

afterAll(async () => {
  process.env.STORAGE_DRIVER = savedEnv.driver;
  process.env.RECEIPTS_DIR = savedEnv.dir;
  await sql.end();
  await rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  process.env.STORAGE_DRIVER = "local";
  await truncateAll(sql);
  alice = await registerUser(app, "Alice");
  bob = await registerUser(app, "Bob");
  const group = await createGroup(alice);
  const res = await alice.agent
    .post("/api/bills")
    .send(billBody({ groupId: group.groupId, paidByMemberId: group.memberId, memberIds: [group.memberId] }));
  expect(res.status).toBe(201);
  billId = res.body.data.bill?.id ?? res.body.data.id;
});

async function uploadReceipt(user: TestUser = alice) {
  return user.agent
    .post(`/api/bills/${billId}/receipt`)
    .attach("image", IMAGE, { filename: "receipt.png", contentType: "image/png" });
}

async function receiptUrl(): Promise<string> {
  const res = await alice.agent.get(`/api/bills/${billId}/receipt-url`);
  expect(res.status).toBe(200);
  return res.body.data.url;
}

describe("receipts on the local storage driver", () => {
  it("stores an upload and serves it back to a group member, uncached", async () => {
    expect((await uploadReceipt()).status).toBe(201);

    const url = await receiptUrl();
    expect(url).toMatch(/^\/api\/receipts\//);

    const res = await alice.agent.get(url).buffer(true).parse((r, done) => {
      const chunks: Buffer[] = [];
      r.on("data", (c: Buffer) => chunks.push(c));
      r.on("end", () => done(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("image/png");
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(Buffer.compare(res.body, IMAGE)).toBe(0);
  });

  it("keeps the file under the uploader's folder, not a public path", async () => {
    await uploadReceipt();
    expect(await readdir(dir)).toContain(String(alice.id));
  });

  it("doesn't issue a receipt URL to someone outside the group", async () => {
    await uploadReceipt();
    expect((await bob.agent.get(`/api/bills/${billId}/receipt-url`)).status).toBe(404);
  });

  it("doesn't accept an upload from someone outside the group", async () => {
    expect((await uploadReceipt(bob)).status).toBe(404);
    expect(await sql`SELECT 1 FROM bills WHERE id = ${billId} AND receipt_image_url IS NOT NULL`).toHaveLength(0);
  });

  it("needs a login even with a valid URL", async () => {
    await uploadReceipt();
    const url = await receiptUrl();
    expect((await request(httpServer(app)).get(url)).status).toBe(401);
  });

  it("answers 404 for a forged or altered token", async () => {
    await uploadReceipt();
    const url = await receiptUrl();
    for (const bad of ["/api/receipts/nonsense", `${url.slice(0, -2)}xx`, "/api/receipts/a.1.b"]) {
      const res = await alice.agent.get(bad);
      expect(res.status).toBe(404);
      expect(res.body.error.message).toBe("Receipt not found.");
    }
  });

  it("answers 404, not 500, when the file has gone from disk", async () => {
    await uploadReceipt();
    const url = await receiptUrl();
    await rm(path.join(dir, String(alice.id)), { recursive: true });
    const res = await alice.agent.get(url);
    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe("Receipt not found.");
  });

  it("keeps the route closed under the Supabase driver", async () => {
    await uploadReceipt();
    const url = await receiptUrl();
    process.env.STORAGE_DRIVER = "supabase";
    expect((await alice.agent.get(url)).status).toBe(404);
  });
});

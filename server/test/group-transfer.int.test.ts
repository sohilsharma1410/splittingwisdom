import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { Express } from "express";
import postgres from "postgres";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { requireTestDatabaseUrl } from "./helpers/env.js";
import { connect, truncateAll } from "./helpers/db.js";
import { billBody, createGroup, getApp, registerUser, type TestUser } from "./helpers/app.js";

// Export and import of whole groups, through the real routes.
const IMAGE = Buffer.from("not really a png, but the route only checks the declared type");

let app: Express;
let sql: postgres.Sql;
let dir: string;
let alice: TestUser;
let bob: TestUser;
let groupId: number;
const savedEnv = { driver: process.env.STORAGE_DRIVER, dir: process.env.RECEIPTS_DIR };

beforeAll(async () => {
  sql = connect(requireTestDatabaseUrl());
  app = await getApp();
  dir = await mkdtemp(path.join(tmpdir(), "transfer-int-"));
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
  const group = await createGroup(alice, "Goa");
  groupId = group.groupId;
  // Ravi never signed up: a name-only member.
  const [ravi] = await sql`insert into group_members (group_id, display_name) values (${groupId}, 'Ravi') returning id`;
  const bill = await alice.agent
    .post("/api/bills")
    .send(billBody({ groupId, paidByMemberId: group.memberId, memberIds: [group.memberId, ravi.id], price: 10001 }));
  expect(bill.status).toBe(201);
  const billId = bill.body.data.bill?.id ?? bill.body.data.id;
  const receipt = await alice.agent.post(`/api/bills/${billId}/receipt`).attach("image", IMAGE, { filename: "r.png", contentType: "image/png" });
  expect(receipt.status).toBeLessThan(300);
  await sql`insert into settlements (group_id, payer_member_id, recipient_member_id, amount, settlement_date) values (${groupId}, ${ravi.id}, ${group.memberId}, 2000, now())`;
});

async function exportFile(user: TestUser, ids: number[], receipts = false) {
  return user.agent.get(`/api/groups/export?ids=${ids.join(",")}&receipts=${receipts}`);
}

async function importFile(user: TestUser, file: unknown, you: number[]) {
  return user.agent
    .post("/api/groups/import")
    .field("you", JSON.stringify(you))
    .attach("file", Buffer.from(JSON.stringify(file)), { filename: "export.json", contentType: "application/json" });
}

describe("exporting groups", () => {
  it("exports a member's group with balances that add to zero, and photos only when asked", async () => {
    const plain = await exportFile(alice, [groupId]);
    expect(plain.status).toBe(200);
    const group = plain.body.data.groups[0];
    expect(group.members.map((m: { displayName: string }) => m.displayName)).toEqual(["Alice", "Ravi"]);
    expect(group.bills[0].receipt).toBeNull();
    expect(group.nets.reduce((sum: number, n: { net: number }) => sum + n.net, 0)).toBe(0);
    const withPhotos = await exportFile(alice, [groupId], true);
    expect(Buffer.from(withPhotos.body.data.groups[0].bills[0].receipt.base64, "base64")).toEqual(IMAGE);
  });

  it("refuses someone else's group with a 404, even mixed in with their own", async () => {
    expect((await exportFile(bob, [groupId])).status).toBe(404);
    const bobs = await createGroup(bob, "Bob's flat");
    expect((await exportFile(bob, [bobs.groupId, groupId])).status).toBe(404);
  });
});

describe("importing groups", () => {
  it("creates a new group with the same bills and balances, and leaves the original alone", async () => {
    const file = (await exportFile(alice, [groupId], true)).body.data;
    const before = await sql`select count(*)::int as n from bills where group_id = ${groupId}`;

    const res = await importFile(bob, file, [2]); // Bob takes over Ravi's place
    expect(res.status).toBe(201);
    const [newId] = res.body.data.groupIds;
    expect(newId).not.toBe(groupId);

    const after = await sql`select count(*)::int as n from bills where group_id = ${groupId}`;
    expect(after[0].n).toBe(before[0].n);

    const again = (await exportFile(bob, [newId], true)).body.data.groups[0];
    expect(again.nets).toEqual(file.groups[0].nets);
    expect(again.bills.map((b: { items: unknown }) => b.items)).toEqual(file.groups[0].bills.map((b: { items: unknown }) => b.items));
    expect(again.members.map((m: { displayName: string }) => m.displayName)).toEqual(["Alice", "Bob"]);
    expect(again.bills[0].receipt.base64).toBe(file.groups[0].bills[0].receipt.base64);
    // Alice in the copy is a name only: she isn't let in to the imported group.
    expect((await alice.agent.get(`/api/groups/${newId}`)).status).toBe(404);
  });

  it("saves nothing at all when the file was edited", async () => {
    const file = (await exportFile(alice, [groupId], true)).body.data;
    file.groups[0].bills[0].items[0].price += 100;
    const groupsBefore = await sql`select count(*)::int as n from groups`;
    const res = await importFile(bob, file, [1]);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/don't match its own bills/);
    const groupsAfter = await sql`select count(*)::int as n from groups`;
    expect(groupsAfter[0].n).toBe(groupsBefore[0].n);
  });

  it("rejects a file that isn't an export, and an unknown 'you'", async () => {
    expect((await importFile(bob, { hello: 1 }, [1])).status).toBe(400);
    const file = (await exportFile(alice, [groupId])).body.data;
    expect((await importFile(bob, file, [9])).status).toBe(400);
  });

  it("needs a login", async () => {
    const { default: request } = await import("supertest");
    expect((await request(app).get(`/api/groups/export?ids=${groupId}`)).status).toBe(401);
  });
});

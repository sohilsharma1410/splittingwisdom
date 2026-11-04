import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Express } from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import postgres from "postgres";
import { requireTestDatabaseUrl } from "./helpers/env.js";
import { connect, truncateAll } from "./helpers/db.js";
import { createGroup, getApp, registerUser, type TestUser } from "./helpers/app.js";

// Plan D4.10-D4.12: /api/speech with a stand-in speech service.
const AUDIO = Buffer.alloc(2000, 1);

let app: Express;
let sql: postgres.Sql;
let stt: Server;
let said: { status: number; text: string };
let lastPrompt: string;
let lastBytes: number;
let alice: TestUser;
let bob: TestUser;
let groupId: number;
const savedUrl = process.env.STT_URL;

beforeAll(async () => {
  sql = connect(requireTestDatabaseUrl());
  app = await getApp();
  stt = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200).end("{}");
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      lastPrompt = decodeURIComponent(String(req.headers["x-prompt"] ?? ""));
      lastBytes = Buffer.concat(chunks).length;
      res.writeHead(said.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ text: said.text }));
    });
  });
  await new Promise<void>((resolve) => stt.listen(0, "127.0.0.1", resolve));
  process.env.STT_URL = `http://127.0.0.1:${(stt.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (savedUrl === undefined) delete process.env.STT_URL;
  else process.env.STT_URL = savedUrl;
  await new Promise((resolve) => stt.close(resolve));
  await sql.end();
});

beforeEach(async () => {
  await truncateAll(sql);
  said = { status: 200, text: "karen had the biryani" };
  lastPrompt = "";
  lastBytes = 0;
  alice = await registerUser(app, "Alice");
  bob = await registerUser(app, "Bob");
  ({ groupId } = await createGroup(alice, "Dinner"));
});

const record = (user: TestUser, fields: Record<string, string> = {}) => {
  let req = user.agent.post("/api/speech/transcribe").attach("audio", AUDIO, { filename: "a.webm", contentType: "audio/webm" });
  for (const [key, value] of Object.entries(fields)) req = req.field(key, value);
  return req;
};

describe("GET /api/speech/status", () => {
  it("needs a login", async () => {
    const res = await (await import("supertest")).default(app).get("/api/speech/status");
    expect(res.status).toBe(401);
  });
  it("says speech is available when the service is up, and not when it's off", async () => {
    expect((await alice.agent.get("/api/speech/status")).body.data.available).toBe(true);
    const url = process.env.STT_URL;
    delete process.env.STT_URL;
    expect((await alice.agent.get("/api/speech/status")).body.data.available).toBe(false);
    process.env.STT_URL = url;
  });
});

describe("POST /api/speech/transcribe", () => {
  it("returns the text and passes the group's people and the items to the model as its prompt", async () => {
    const res = await record(alice, { groupId: String(groupId), items: JSON.stringify(["Veg Biryani", "Butter Naan"]) });
    expect(res.status).toBe(200);
    expect(res.body.data.text).toBe("karen had the biryani");
    expect(lastPrompt).toContain("Alice");
    expect(lastPrompt).toContain("Veg Biryani");
    expect(lastBytes).toBe(AUDIO.length);
  });

  it("won't use someone else's group", async () => {
    const res = await record(bob, { groupId: String(groupId) });
    expect(res.status).toBe(404);
    expect(lastPrompt).toBe("");
  });

  it("rejects an empty recording and a malformed item list", async () => {
    const empty = await alice.agent.post("/api/speech/transcribe").attach("audio", Buffer.alloc(10), { filename: "a.webm", contentType: "audio/webm" });
    expect(empty.status).toBe(400);
    expect((await record(alice, { items: "not json" })).status).toBe(400);
  });

  it("rejects a recording that is too big", async () => {
    const big = await alice.agent.post("/api/speech/transcribe").attach("audio", Buffer.alloc(3 * 1024 * 1024 + 10), { filename: "a.webm", contentType: "audio/webm" });
    expect(big.status).toBe(413);
  });

  it("says speech is unavailable, with a way forward, when the service is down", async () => {
    const url = process.env.STT_URL;
    process.env.STT_URL = "http://127.0.0.1:1";
    const res = await record(alice);
    process.env.STT_URL = url;
    expect(res.status).toBe(503);
    expect(res.body.error.message).toMatch(/type it in/);
  });

  it("maps the service's own refusals", async () => {
    said = { status: 413, text: "" };
    expect((await record(alice)).status).toBe(413);
    said = { status: 422, text: "" };
    expect((await record(alice)).status).toBe(422);
  });
});

describe("POST /api/speech/interpret", () => {
  const items = [
    { index: 0, name: "Paneer Butter Masala", quantity: 1 },
    { index: 1, name: "Veg Biryani", quantity: 1 },
  ];

  it("assigns a misspelled name to the one person who sounds like it", async () => {
    const carol = await registerUser(app, "Karan");
    await alice.agent.post(`/api/groups/${groupId}/members`).send({ userId: carol.id });
    const res = await alice.agent.post("/api/speech/interpret").send({ mode: "assign", groupId, text: "karen had the biryani", items });
    expect(res.status).toBe(200);
    expect(res.body.data.assignments).toHaveLength(1);
    expect(res.body.data.assignments[0].itemIndex).toBe(1);
    expect(res.body.data.assignments[0].shares).toHaveLength(1);
  });

  it("per item, 'me' means the person speaking", async () => {
    const res = await alice.agent.post("/api/speech/interpret").send({ mode: "assign", groupId, text: "me", items, itemIndex: 0 });
    expect(res.body.data.assignments).toEqual([{ itemIndex: 0, shares: [{ memberId: expect.any(Number), units: 1 }] }]);
  });

  it("won't read another group's people", async () => {
    const res = await bob.agent.post("/api/speech/interpret").send({ mode: "assign", groupId, text: "me", items });
    expect(res.status).toBe(404);
  });

  it("reads bill details into the same shape a receipt scan returns", async () => {
    const res = await alice.agent.post("/api/speech/interpret").send({ mode: "bill", text: "two naan 80 each, paneer 300, gst 5 percent, total 507" });
    expect(res.status).toBe(200);
    const bill = res.body.data.extraction;
    expect(bill.items.map((i: { name: string; quantity: number; price: number }) => [i.name, i.quantity, i.price])).toEqual([["Naan", 2, 16000], ["Paneer", 1, 30000]]);
    expect(bill.taxAmount).toBe(2300);
    expect(bill.totalAmount).toBe(50700);
  });

  it("also says who had each dish when the bill is spoken for a group, and won't for someone else's group", async () => {
    const text = "Naan 80 only me, paneer 300 shared by everyone";
    const res = await alice.agent.post("/api/speech/interpret").send({ mode: "bill", text, groupId });
    expect(res.status).toBe(200);
    expect(res.body.data.extraction.items.map((i: { name: string }) => i.name)).toEqual(["Naan", "Paneer"]);
    expect(res.body.data.assignments).toHaveLength(2);
    expect(res.body.data.assignments[0].shares).toHaveLength(1);
    expect(res.body.data.assignments[1].shares.length).toBeGreaterThanOrEqual(1);
    expect((await bob.agent.post("/api/speech/interpret").send({ mode: "bill", text, groupId })).status).toBe(404);
  });

  it("rejects nonsense input", async () => {
    expect((await alice.agent.post("/api/speech/interpret").send({ mode: "nope" })).status).toBe(400);
    expect((await alice.agent.post("/api/speech/interpret").send({ mode: "bill", text: "x".repeat(4000) })).status).toBe(400);
  });
});

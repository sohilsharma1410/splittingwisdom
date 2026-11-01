import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Express } from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import postgres from "postgres";
import request from "supertest";
import { requireTestDatabaseUrl } from "./helpers/env.js";
import { connect, truncateAll } from "./helpers/db.js";
import { getApp, registerUser, type TestUser } from "./helpers/app.js";

// Plan D18: POST /api/bills/extract with local OCR, using a stand-in OCR service.
const IMAGE = Buffer.from("made-up image");

function box(text: string, row: number, column = 0) {
  const left = 50 + column * 300;
  const top = 40 + row * 40;
  return { text, confidence: 0.97, box: [[left, top], [left + 280, top], [left + 280, top + 26], [left, top + 26]] };
}

let app: Express;
let sql: postgres.Sql;
let dir: string;
let ocr: Server;
let alice: TestUser;
let ocrAnswer: { status: number; body: unknown };
let received: Buffer[];
const savedEnv = { ...process.env };

beforeAll(async () => {
  sql = connect(requireTestDatabaseUrl());
  app = await getApp();
  dir = await mkdtemp(path.join(tmpdir(), "extract-int-"));
  ocr = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      received.push(Buffer.concat(chunks));
      res.writeHead(ocrAnswer.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(ocrAnswer.body));
    });
  });
  await new Promise<void>((resolve) => ocr.listen(0, "127.0.0.1", resolve));
  process.env.RECEIPTS_DIR = dir;
  process.env.STORAGE_DRIVER = "local";
  process.env.OCR_DRIVER = "local";
  process.env.OCR_URL = `http://127.0.0.1:${(ocr.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const key of ["RECEIPTS_DIR", "STORAGE_DRIVER", "OCR_DRIVER", "OCR_URL"]) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  await new Promise((resolve) => ocr.close(resolve));
  await sql.end();
  await rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await truncateAll(sql);
  received = [];
  ocrAnswer = {
    status: 200,
    body: { boxes: [box("Tea", 0), box("2", 0, 1), box("80.00", 0, 2), box("Total", 1), box("80.00", 1, 2)] },
  };
  alice = await registerUser(app, "Alice");
});

const upload = (user: TestUser) =>
  user.agent.post("/api/bills/extract").attach("image", IMAGE, { filename: "r.jpg", contentType: "image/jpeg" });

describe("POST /api/bills/extract with local OCR", () => {
  it("returns the parsed bill and keeps the photo", async () => {
    const res = await upload(alice);
    expect(res.status).toBe(200);
    expect(res.body.data.extractionFailed).toBe(false);
    expect(res.body.data.extraction.items).toEqual([{ name: "Tea", price: 8000, quantity: 2, confidence: "high" }]);
    expect(res.body.data.extraction.totalAmount).toBe(8000);
    expect(res.body.data.imagePath).toBeTruthy();
    expect(received[0].equals(IMAGE)).toBe(true);
  });

  it("falls back to manual entry with the photo kept when the OCR service fails", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    ocrAnswer = { status: 500, body: { error: "ocr failed" } };
    const res = await upload(alice);
    errors.mockRestore();
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ extraction: null, extractionFailed: true });
    expect(res.body.data.imagePath).toBeTruthy();
    const folders = await readdir(dir);
    expect(folders.length).toBeGreaterThan(0);
  });

  it("falls back the same way when the photo has no bill on it", async () => {
    ocrAnswer = { status: 200, body: { boxes: [] } };
    const res = await upload(alice);
    expect(res.status).toBe(200);
    expect(res.body.data.extractionFailed).toBe(true);
    expect(res.body.data.imagePath).toBeTruthy();
  });

  it("needs a login, and never calls the OCR service without one", async () => {
    const res = await request(app).post("/api/bills/extract").attach("image", IMAGE, { filename: "r.jpg", contentType: "image/jpeg" });
    expect(res.status).toBe(401);
    expect(received).toEqual([]);
  });

  it("refuses other file types before calling the OCR service", async () => {
    const res = await alice.agent
      .post("/api/bills/extract")
      .attach("image", Buffer.from("x"), { filename: "r.txt", contentType: "text/plain" });
    expect(res.status).toBe(400);
    expect(received).toEqual([]);
  });
});

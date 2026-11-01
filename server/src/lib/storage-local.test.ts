import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createReceiptToken,
  deleteReceiptFile,
  isValidReceiptPath,
  listReceiptFiles,
  verifyReceiptToken,
  writeReceiptFile,
} from "./storage-local.js";

const SECRET = "test-secret";
const RECEIPT = "42/abcdefghijklmnop.jpg";
const NOW = 1_000_000;

describe("receipt tokens", () => {
  it("round-trips a valid token", () => {
    const token = createReceiptToken(RECEIPT, NOW + 1000, SECRET);
    expect(verifyReceiptToken(token, SECRET, NOW)).toBe(RECEIPT);
  });

  it("rejects an expired token, including at the exact expiry", () => {
    const token = createReceiptToken(RECEIPT, NOW, SECRET);
    expect(verifyReceiptToken(token, SECRET, NOW)).toBeNull();
    expect(verifyReceiptToken(token, SECRET, NOW + 1)).toBeNull();
  });

  it("rejects a token signed with another secret", () => {
    const token = createReceiptToken(RECEIPT, NOW + 1000, "other-secret");
    expect(verifyReceiptToken(token, SECRET, NOW)).toBeNull();
  });

  it("rejects a later expiry or another file spliced into a real token", () => {
    const token = createReceiptToken(RECEIPT, NOW + 1000, SECRET);
    const [encoded, expires, signature] = token.split(".");
    expect(verifyReceiptToken(`${encoded}.${NOW + 999_999}.${signature}`, SECRET, NOW)).toBeNull();
    const other = Buffer.from("43/abcdefghijklmnop.jpg").toString("base64url");
    expect(verifyReceiptToken(`${other}.${expires}.${signature}`, SECRET, NOW)).toBeNull();
  });

  it("rejects malformed tokens without throwing", () => {
    for (const bad of ["", "a", "a.b", "a.b.c", "a.b.c.d", "...", "%%%.1.x"]) {
      expect(verifyReceiptToken(bad, SECRET, NOW)).toBeNull();
    }
  });

  it("rejects a correctly signed token for a path outside the receipt shape", () => {
    const token = createReceiptToken("../../etc/passwd", NOW + 1000, SECRET);
    expect(verifyReceiptToken(token, SECRET, NOW)).toBeNull();
  });
});

describe("receipt paths", () => {
  it("accepts only the generated shape", () => {
    expect(isValidReceiptPath(RECEIPT)).toBe(true);
    expect(isValidReceiptPath("1/AbC-_0123456789x.webp")).toBe(true);
    for (const bad of [
      "../1/abcdefghijklmnop.jpg",
      "1/../../abcdefghijklmn.jpg",
      "/1/abcdefghijklmnop.jpg",
      "a/abcdefghijklmnop.jpg",
      "1/short.jpg",
      "1/abcdefghijklmnop.exe",
      "1/abcdefghijklmnop.jpg/x",
    ]) {
      expect(isValidReceiptPath(bad)).toBe(false);
    }
  });
});

describe("receipt files", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "receipts-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes a private file and leaves no temp file behind", async () => {
    await writeReceiptFile(dir, RECEIPT, Buffer.from("image"));
    expect(await readFile(path.join(dir, RECEIPT), "utf8")).toBe("image");
    expect(await readdir(path.join(dir, "42"))).toEqual(["abcdefghijklmnop.jpg"]);
    expect((await stat(path.join(dir, RECEIPT))).mode & 0o777).toBe(0o600);
  });

  it("refuses to write outside the receipt shape", async () => {
    await expect(writeReceiptFile(dir, "../escape.jpg", Buffer.from("x"))).rejects.toThrow(/invalid receipt path/);
    await expect(readdir(path.dirname(dir))).resolves.not.toContain("escape.jpg");
  });

  it("lists stored receipts and skips anything else in the folder", async () => {
    await writeReceiptFile(dir, RECEIPT, Buffer.from("image"));
    await writeFile(path.join(dir, "42", "abcdefghijklmnop.jpg.123.tmp"), "partial");
    await writeFile(path.join(dir, "not-a-user-folder"), "x");
    const files = await listReceiptFiles(dir);
    expect(files.map((f) => f.path)).toEqual([RECEIPT]);
    expect(Number.isNaN(new Date(files[0].createdAt).getTime())).toBe(false);
  });

  it("lists nothing when the folder doesn't exist yet", async () => {
    await expect(listReceiptFiles(path.join(dir, "missing"))).resolves.toEqual([]);
  });

  it("deletes a file, and deleting a missing one is not an error", async () => {
    await writeReceiptFile(dir, RECEIPT, Buffer.from("image"));
    await deleteReceiptFile(dir, RECEIPT);
    await deleteReceiptFile(dir, RECEIPT);
    await expect(listReceiptFiles(dir)).resolves.toEqual([]);
  });
});

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

/**
 * Receipt images on the Pi's own disk (plan P3.2). There is no public path to
 * them: a "signed URL" is a route on this API carrying an HMAC-signed, expiring
 * token, and that route also requires a logged-in session.
 */

/** `<uploader id>/<16-char nanoid>.<ext>`, the same shape as the Supabase bucket paths. */
const RECEIPT_PATH = /^\d+\/[A-Za-z0-9_-]{16}\.(jpg|png|webp)$/;

export function isValidReceiptPath(receiptPath: string): boolean {
  return RECEIPT_PATH.test(receiptPath);
}

function signingKey(secret: string): Buffer {
  // Derived so a receipt token can never be mistaken for a session signature.
  return createHmac("sha256", secret).update("receipt-url:v1").digest();
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", signingKey(secret)).update(payload).digest("base64url");
}

export function createReceiptToken(receiptPath: string, expiresAtMs: number, secret: string): string {
  const payload = `${Buffer.from(receiptPath).toString("base64url")}.${expiresAtMs}`;
  return `${payload}.${sign(payload, secret)}`;
}

/** The receipt path a token grants, or null if it is forged, expired or malformed. */
export function verifyReceiptToken(token: string, secret: string, nowMs: number = Date.now()): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [encodedPath, expires, signature] = parts;

  const expected = Buffer.from(sign(`${encodedPath}.${expires}`, secret));
  const actual = Buffer.from(signature);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;

  if (!/^\d+$/.test(expires) || Number(expires) <= nowMs) return null;
  const receiptPath = Buffer.from(encodedPath, "base64url").toString();
  return isValidReceiptPath(receiptPath) ? receiptPath : null;
}

function absolutePath(dir: string, receiptPath: string): string {
  if (!isValidReceiptPath(receiptPath)) {
    throw new Error("Refusing an invalid receipt path.");
  }
  return path.join(dir, receiptPath);
}

/**
 * Written to a temp file, flushed and renamed, so a power cut can't leave a
 * half-written image under the real name.
 */
export async function writeReceiptFile(dir: string, receiptPath: string, data: Buffer): Promise<void> {
  const target = absolutePath(dir, receiptPath);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    const file = await open(temp, "wx", 0o600);
    try {
      await file.writeFile(data);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temp, target);
  } catch (err) {
    await rm(temp, { force: true });
    throw err;
  }
}

export async function deleteReceiptFile(dir: string, receiptPath: string): Promise<void> {
  await rm(absolutePath(dir, receiptPath), { force: true });
}

/** Every stored receipt. Leftover temp files don't match the path shape, so they're skipped. */
export async function listReceiptFiles(dir: string): Promise<{ path: string; createdAt: string }[]> {
  let folders: string[];
  try {
    folders = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const results: { path: string; createdAt: string }[] = [];
  for (const folder of folders) {
    if (!/^\d+$/.test(folder)) continue;
    for (const name of await readdir(path.join(dir, folder))) {
      const receiptPath = `${folder}/${name}`;
      if (!isValidReceiptPath(receiptPath)) continue;
      const info = await stat(path.join(dir, receiptPath));
      results.push({ path: receiptPath, createdAt: info.mtime.toISOString() });
    }
  }
  return results;
}

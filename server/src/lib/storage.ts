import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { nanoid } from "nanoid";
import {
  createReceiptToken,
  deleteReceiptFile,
  listReceiptFiles,
  readReceiptFile,
  writeReceiptFile,
} from "./storage-local.js";

const RECEIPTS_BUCKET = "receipts";
const SIGNED_URL_TTL_SECONDS = 10 * 60;

/**
 * STORAGE_DRIVER picks where receipt images live (plan P3.2):
 *   supabase (default)  private Supabase Storage bucket (Render standby)
 *   local               files under RECEIPTS_DIR (the Pi)
 *
 * Everything is resolved on first actual use, not at import time: this module
 * is imported by bills.ts regardless of whether anyone ever uploads a receipt,
 * so a missing setting here must never crash the whole server on boot.
 */
export function storageDriver(env: NodeJS.ProcessEnv = process.env): "supabase" | "local" {
  const driver = env.STORAGE_DRIVER?.trim().toLowerCase() || "supabase";
  if (driver !== "supabase" && driver !== "local") {
    throw new Error(`STORAGE_DRIVER must be "supabase" or "local" (got "${env.STORAGE_DRIVER}").`);
  }
  return driver;
}

/** The folder holding receipts under the local driver. */
export function receiptsDir(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.RECEIPTS_DIR;
  if (!dir) throw new Error("STORAGE_DRIVER=local needs RECEIPTS_DIR to be set.");
  return dir;
}

/** The secret behind local receipt tokens. Shared with the session cookie, under a derived key. */
export function receiptSigningSecret(env: NodeJS.ProcessEnv = process.env): string {
  const secret = env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is not set.");
  return secret;
}

let supabase: SupabaseClient | null = null;
function getSupabaseClient(): SupabaseClient {
  if (supabase) return supabase;
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error("SUPABASE_URL / SUPABASE_SERVICE_KEY are not set. Copy server/.env.example to server/.env and fill it in.");
  }
  // Server-only client using the service key — this must never reach the
  // client bundle. The `receipts` bucket must be private in the Supabase
  // dashboard; we only ever hand out short-lived signed URLs, never a
  // public one, per CLAUDE.md's storage rule.
  supabase = createClient(supabaseUrl, supabaseServiceKey);
  return supabase;
}

const EXTENSION_BY_MIME_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export function isSupportedReceiptMimeType(mimeType: string): boolean {
  return mimeType in EXTENSION_BY_MIME_TYPE;
}

/** Uploads a receipt image and returns the storage-relative path — not a
 * URL. Callers store this path (e.g. in `bills.receiptImageUrl`, despite
 * the column's name) and resolve it to a fresh signed URL on every read. */
export async function uploadReceiptImage(
  buffer: Buffer,
  mimeType: string,
  userId: number,
): Promise<string> {
  const extension = EXTENSION_BY_MIME_TYPE[mimeType];
  if (!extension) {
    throw new Error(`Unsupported receipt image type: ${mimeType}`);
  }
  const path = `${userId}/${nanoid(16)}.${extension}`;

  if (storageDriver() === "local") {
    await writeReceiptFile(receiptsDir(), path, buffer);
    return path;
  }

  const { error } = await getSupabaseClient()
    .storage.from(RECEIPTS_BUCKET)
    .upload(path, buffer, { contentType: mimeType, upsert: false });
  if (error) throw error;

  return path;
}

export async function getReceiptSignedUrl(path: string): Promise<string> {
  if (storageDriver() === "local") {
    const expiresAt = Date.now() + SIGNED_URL_TTL_SECONDS * 1000;
    return `/api/receipts/${createReceiptToken(path, expiresAt, receiptSigningSecret())}`;
  }

  const { data, error } = await getSupabaseClient()
    .storage.from(RECEIPTS_BUCKET)
    .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
  if (error) throw error;
  return data.signedUrl;
}

/** Reads a stored receipt image back, with its type taken from the file extension. */
export async function readReceiptImage(path: string): Promise<{ buffer: Buffer; mimeType: string }> {
  const extension = path.split(".").pop() ?? "";
  const mimeType = Object.entries(EXTENSION_BY_MIME_TYPE).find(([, ext]) => ext === extension)?.[0];
  if (!mimeType) throw new Error(`Unknown receipt image type for ${path}`);

  if (storageDriver() === "local") return { buffer: await readReceiptFile(receiptsDir(), path), mimeType };

  const { data, error } = await getSupabaseClient().storage.from(RECEIPTS_BUCKET).download(path);
  if (error) throw error;
  return { buffer: Buffer.from(await data.arrayBuffer()), mimeType };
}

export async function deleteReceiptImage(path: string): Promise<void> {
  if (storageDriver() === "local") {
    await deleteReceiptFile(receiptsDir(), path);
    return;
  }

  const { error } = await getSupabaseClient().storage.from(RECEIPTS_BUCKET).remove([path]);
  if (error) throw error;
}

export async function listReceiptImagePaths(): Promise<{ path: string; createdAt: string }[]> {
  // Used only by the orphan-cleanup script — walks every uploader's folder.
  if (storageDriver() === "local") return listReceiptFiles(receiptsDir());

  const client = getSupabaseClient();
  const { data: userFolders, error } = await client.storage.from(RECEIPTS_BUCKET).list();
  if (error) throw error;

  const results: { path: string; createdAt: string }[] = [];
  for (const folder of userFolders ?? []) {
    if (!folder.name) continue;
    const { data: files, error: listError } = await client.storage
      .from(RECEIPTS_BUCKET)
      .list(folder.name);
    if (listError) throw listError;
    for (const file of files ?? []) {
      results.push({
        path: `${folder.name}/${file.name}`,
        createdAt: file.created_at ?? new Date(0).toISOString(),
      });
    }
  }
  return results;
}

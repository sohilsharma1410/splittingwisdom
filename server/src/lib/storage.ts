import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { nanoid } from "nanoid";

const RECEIPTS_BUCKET = "receipts";
const SIGNED_URL_TTL_SECONDS = 10 * 60;

// Lazily created on first actual use, not at import time — this module is
// imported by bills.ts regardless of whether anyone ever uploads a receipt,
// so a missing key here must never crash the whole server on boot. Every
// exported function below goes through this, so Phases 1-4 (which never
// call any of them) work fine even before Storage is configured.
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

/** Uploads a receipt image and returns the bucket-relative path — not a
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

  const { error } = await getSupabaseClient()
    .storage.from(RECEIPTS_BUCKET)
    .upload(path, buffer, { contentType: mimeType, upsert: false });
  if (error) throw error;

  return path;
}

export async function getReceiptSignedUrl(path: string): Promise<string> {
  const { data, error } = await getSupabaseClient()
    .storage.from(RECEIPTS_BUCKET)
    .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
  if (error) throw error;
  return data.signedUrl;
}

export async function deleteReceiptImage(path: string): Promise<void> {
  const { error } = await getSupabaseClient().storage.from(RECEIPTS_BUCKET).remove([path]);
  if (error) throw error;
}

export async function listReceiptImagePaths(): Promise<{ path: string; createdAt: string }[]> {
  // Used only by the orphan-cleanup script — walks every uploader's folder.
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

import { z } from "zod";
import { extractReceipt as extractWithGemini, type ExtractionResult } from "./gemini.js";
import { parseReceipt } from "./receipt-parser.js";

// Plan D18. The Pi reads receipts itself with OCR_DRIVER=local. The default keeps
// Render working without any new env vars.
export type OcrDriver = "gemini" | "local" | "invalid";

const TIMEOUT_MS = 30_000;

/** An unknown value is "invalid", never Gemini, so a typo can't send photos to Google. */
export function ocrDriver(env: NodeJS.ProcessEnv = process.env): OcrDriver {
  const driver = env.OCR_DRIVER?.trim().toLowerCase() || "gemini";
  return driver === "local" || driver === "gemini" ? driver : "invalid";
}

const ocrResponseSchema = z.object({
  boxes: z.array(
    z.object({
      text: z.string(),
      confidence: z.number(),
      box: z.array(z.array(z.number()).length(2)).length(4),
    }),
  ),
});

interface LocalDeps {
  url?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Asks the OCR container to read the image, then parses the text. Returns null on any
 * failure and never throws, so the app falls back to manual entry with the photo kept.
 * Logs the message only, never the image or what it read.
 */
export async function extractLocally(buffer: Buffer, mimeType: string, deps: LocalDeps = {}): Promise<ExtractionResult | null> {
  const url = deps.url ?? process.env.OCR_URL ?? "http://ocr:8000";
  const fetchFn = deps.fetchFn ?? fetch;
  try {
    const response = await fetchFn(`${url.replace(/\/$/, "")}/ocr`, {
      method: "POST",
      headers: { "Content-Type": mimeType },
      body: new Uint8Array(buffer),
      signal: AbortSignal.timeout(deps.timeoutMs ?? TIMEOUT_MS),
    });
    // 422 just means the file wasn't a readable image, which isn't a fault here.
    if (response.status === 422) return null;
    if (!response.ok) throw new Error(`OCR service answered ${response.status}`);
    return parseReceipt(ocrResponseSchema.parse(await response.json()).boxes);
  } catch (err) {
    console.error("Local OCR failed:", err instanceof Error ? err.message : "unknown error");
    return null;
  }
}

export async function extractReceipt(buffer: Buffer, mimeType: string): Promise<ExtractionResult | null> {
  const driver = ocrDriver();
  if (driver === "local") return extractLocally(buffer, mimeType);
  if (driver === "gemini") return extractWithGemini(buffer, mimeType);
  console.error('OCR_DRIVER must be "local" or "gemini", so this scan was skipped.');
  return null;
}

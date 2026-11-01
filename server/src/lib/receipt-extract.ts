import { z } from "zod";
import { extractReceipt as extractWithVisionModel, ocrInfo as visionModelInfo, type ExtractionResult } from "./receipt-ocr.js";
import { parseReceipt } from "./receipt-parser.js";

// Plan D18: local OCR on the Pi is the primary reader, and Gemini is the secondary.
// OCR_PROVIDER=rapidocr uses the Pi's ocr container. Anything else goes to receipt-ocr.ts
// unchanged, including an unknown value, which it refuses rather than sending anywhere.
const RAPIDOCR = "rapidocr";
const TIMEOUT_MS = 30_000;

export function usesLocalOcr(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OCR_PROVIDER?.trim().toLowerCase() === RAPIDOCR;
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

export function extractReceipt(buffer: Buffer, mimeType: string): Promise<ExtractionResult | null> {
  return usesLocalOcr() ? extractLocally(buffer, mimeType) : extractWithVisionModel(buffer, mimeType);
}

/** What read the receipt, shown on the review screen. A bad setting must not fail the request. */
export function ocrInfo(env: NodeJS.ProcessEnv = process.env): { provider: string; model: string } {
  if (usesLocalOcr(env)) return { provider: RAPIDOCR, model: "local OCR" };
  try {
    return visionModelInfo(env);
  } catch {
    return { provider: "unknown", model: "the receipt reader" };
  }
}

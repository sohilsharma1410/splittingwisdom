import { z } from "zod";
import { RECEIPT_PROMPT } from "./ocr/prompt.js";
import { buildProvider, readOcrConfig, type VisionProvider } from "./ocr/providers.js";

// Whole numbers of paise, tolerant of what weaker models emit (659.0, "659", " 659 ").
const paise = z.preprocess((v) => (typeof v === "string" && v.trim() !== "" ? Number(v) : v), z.number().finite().transform((n) => Math.round(n)));

const extractedItemSchema = z.object({
  name: z.string().trim().min(1).catch("Item"),
  price: paise.pipe(z.number().int().nonnegative()),
  quantity: paise.pipe(z.number().int().positive()).catch(1),
  confidence: z.enum(["high", "low"]).catch("low"),
});

const optionalPaise = (signed = false) =>
  paise.pipe(signed ? z.number().int() : z.number().int().nonnegative()).nullable().catch(null);

const rawExtractionSchema = z.object({
  merchant: z.string().nullable().catch(null),
  date: z.string().nullable().catch(null),
  // Validated one by one below, so a single unreadable line doesn't throw away the rest.
  items: z.array(z.unknown()).catch([]),
  subtotal: optionalPaise(),
  tax: optionalPaise(),
  tax_included: optionalPaise(),
  tip: optionalPaise(),
  service_fee: optionalPaise(),
  discount: optionalPaise(),
  round_off: optionalPaise(true),
  total: optionalPaise(),
  overall_confidence: z.enum(["high", "low"]).catch("low"),
});

export interface ExtractedItem {
  name: string;
  price: number;
  quantity: number;
  confidence: "high" | "low";
}

export interface TotalsMismatch {
  itemsSum: number;
  extractedTotal: number;
  delta: number;
}

export interface ExtractionResult {
  merchant: string | null;
  billDate: string | null;
  items: ExtractedItem[];
  subtotalAmount: number | null;
  /** Tax added on top of the item prices. */
  taxAmount: number | null;
  /** Tax already inside the item prices (informational — never added again). */
  taxIncludedAmount: number | null;
  tipAmount: number | null;
  serviceFeeAmount: number | null;
  discountAmount: number | null;
  /** Signed: a printed "Round off -0.18" is -18. */
  roundOffAmount: number | null;
  totalAmount: number | null;
  overallConfidence: "high" | "low";
  totalsMismatch: TotalsMismatch | null;
}

/** Pulls the JSON object out of whatever the model said: bare JSON, ```json fences, or JSON wrapped in prose. */
export function extractJsonText(text: string): string {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(trimmed);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  if (candidate.startsWith("{")) return candidate;
  const first = candidate.indexOf("{");
  const last = candidate.lastIndexOf("}");
  return first >= 0 && last > first ? candidate.slice(first, last + 1) : candidate;
}

/** Never trust the model's own total — recompute from items + charges and
 * flag a mismatch in code, per CLAUDE.md's money rules and SPEC §2.7. */
export function computeTotalsMismatch(
  items: ExtractedItem[],
  charges: { tax: number | null; tip: number | null; serviceFee: number | null; discount: number | null; roundOff?: number | null },
  extractedTotal: number | null,
): TotalsMismatch | null {
  if (extractedTotal === null) return null;
  const itemsSum =
    // `price` is the line total (the amount printed for that line), exactly as the rest of the
    // app uses it — "4 naan   60.00" is ₹60 for all four, so never multiply by quantity.
    items.reduce((sum, item) => sum + item.price, 0) +
    (charges.tax ?? 0) +
    (charges.tip ?? 0) +
    (charges.serviceFee ?? 0) +
    (charges.roundOff ?? 0) -
    (charges.discount ?? 0);
  const delta = itemsSum - extractedTotal;
  // Under 50 paise is rounding noise (a printed round-off the model missed, or a half-rupee shave), not a mistake worth flagging.
  if (Math.abs(delta) < 50) return null;
  return { itemsSum, extractedTotal, delta };
}

/** Raw model text -> validated result, or null if it isn't a usable receipt reading. */
export function parseExtraction(text: string): ExtractionResult | null {
  let json: unknown;
  try {
    json = JSON.parse(extractJsonText(text));
  } catch {
    return null;
  }
  const parsed = rawExtractionSchema.safeParse(json);
  if (!parsed.success) return null;
  const raw = parsed.data;

  const items: ExtractedItem[] = [];
  for (const candidate of raw.items) {
    const item = extractedItemSchema.safeParse(candidate);
    if (item.success) items.push(item.data);
  }

  // Safety net for a model that mislabels tax: if the items and the other charges ALREADY add up to the
  // printed total, a "tax" on top can't be right — it's the tax inside the prices. Adding it again would
  // charge everyone the tax twice.
  let tax = raw.tax;
  let taxIncluded = raw.tax_included;
  if (tax && tax > 0 && raw.total !== null) {
    const withoutTax = items.reduce((sum, i) => sum + i.price, 0) + (raw.tip ?? 0) + (raw.service_fee ?? 0) + (raw.round_off ?? 0) - (raw.discount ?? 0);
    if (Math.abs(withoutTax - raw.total) < 50) {
      taxIncluded = taxIncluded ?? tax;
      tax = null;
    }
  }

  return {
    merchant: raw.merchant,
    billDate: raw.date,
    items,
    subtotalAmount: raw.subtotal,
    taxAmount: tax,
    taxIncludedAmount: taxIncluded,
    tipAmount: raw.tip,
    serviceFeeAmount: raw.service_fee,
    discountAmount: raw.discount,
    roundOffAmount: raw.round_off,
    totalAmount: raw.total,
    overallConfidence: raw.overall_confidence,
    totalsMismatch: computeTotalsMismatch(
      items,
      { tax, tip: raw.tip, serviceFee: raw.service_fee, discount: raw.discount, roundOff: raw.round_off },
      raw.total,
    ),
  };
}

/** Which model is doing the reading — safe to show users and logs (no secrets). */
export function ocrInfo(env: NodeJS.ProcessEnv = process.env): { provider: string; model: string } {
  const c = readOcrConfig(env);
  return { provider: c.provider, model: c.model || "(not set)" };
}

/** Runs `call`, retrying only transient failures, waiting the given milliseconds before each retry. */
export async function withRetries(call: () => Promise<string>, waits: number[]): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (err) {
      if (attempt >= waits.length || !isTransient(err instanceof Error ? err.message : "")) throw err;
      await new Promise((resolve) => setTimeout(resolve, waits[attempt]));
    }
  }
}

const isTransient = (message: string) => /\b(503|429)\b|UNAVAILABLE|RESOURCE_EXHAUSTED/.test(message);

/**
 * Reads a receipt photo with the configured model. Returns null on ANY failure
 * (timeout, bad key, unreachable local server, unparseable answer) — never
 * throws — so the caller can fall back to manual entry with the photo kept.
 * `providerOverride` is for tests.
 */
export async function extractReceipt(
  buffer: Buffer,
  mimeType: string,
  providerOverride?: VisionProvider,
): Promise<ExtractionResult | null> {
  let label = "unconfigured";
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const config = readOcrConfig();
    label = `${config.provider}:${config.model}`;
    timer = setTimeout(() => controller.abort(), config.timeoutMs);
    const provider = providerOverride ?? buildProvider(config);
    const ask = (p: VisionProvider) => () => p({ buffer, mimeType, prompt: RECEIPT_PROMPT, signal: controller.signal });

    let text: string;
    try {
      // "High demand" (503) and rate limits (429) are usually over in seconds: wait a little and try again.
      text = await withRetries(ask(provider), [2000, 4000]);
    } catch (err) {
      // Still overloaded after that: one try on the fallback model rather than failing the scan.
      const message = err instanceof Error ? err.message : "";
      if (!isTransient(message) || !config.fallbackModel || providerOverride) throw err;
      console.error(`OCR (${label}) is overloaded; trying ${config.fallbackModel} instead.`);
      label = `${config.provider}:${config.fallbackModel}`;
      text = await withRetries(ask(buildProvider({ ...config, model: config.fallbackModel })), [2000]);
    }
    if (!text) return null;
    const result = parseExtraction(text);
    if (!result) console.error(`OCR (${label}) answered, but not with usable receipt JSON.`);
    return result;
  } catch (err) {
    // The caller turns null into "couldn't read this receipt", so without this a retired model,
    // bad key or stopped local server is indistinguishable from an unreadable photo.
    // Message only — never the image or the model's raw output.
    console.error(`OCR extraction failed (${label}):`, err instanceof Error ? err.message : "unknown error");
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

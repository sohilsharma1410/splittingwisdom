import { GoogleGenAI, createPartFromBase64 } from "@google/genai";
import { z } from "zod";

const MODEL = "gemini-2.0-flash";
const TIMEOUT_MS = 30_000;

// Lazily created on first actual use, not at import time — a missing key
// must never crash the whole server on boot. extractReceipt's own
// try/catch already turns any failure here into a graceful null result.
let ai: GoogleGenAI | null = null;
function getClient(): GoogleGenAI {
  if (ai) return ai;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not set. Copy server/.env.example to server/.env and fill it in.");
  }
  ai = new GoogleGenAI({ apiKey });
  return ai;
}

const PROMPT = `You are reading a photo of a purchase receipt. Extract structured data as STRICT JSON matching exactly this shape, and nothing else — no markdown, no commentary, no code fences:
{
  "merchant": string | null,
  "date": string | null,
  "items": [ { "name": string, "price": number, "quantity": number, "confidence": "high" | "low" } ],
  "subtotal": number | null,
  "tax": number | null,
  "tip": number | null,
  "service_fee": number | null,
  "discount": number | null,
  "total": number | null,
  "overall_confidence": "high" | "low"
}

Rules:
- All money amounts are integers in paise (INR minor units) — e.g. an item priced at ₹12.50 is 1250. Never output decimals or currency symbols.
- "date", if determinable, is ISO format yyyy-mm-dd.
- If a field isn't visible on the receipt or you're not confident about it, use null rather than guessing. Never invent an item that isn't actually on the receipt.
- An item's own "confidence" is "low" if its name, price, or quantity was hard to read clearly.
- "overall_confidence" is "low" if the receipt is blurry, cropped, handwritten, or otherwise hard to read as a whole.
- "quantity" defaults to 1 if the receipt doesn't show one.
Return ONLY the JSON object described above.`;

const extractedItemSchema = z.object({
  name: z.string().min(1).catch("Item"),
  price: z.number().int().nonnegative(),
  quantity: z.number().int().positive().catch(1),
  confidence: z.enum(["high", "low"]).catch("low"),
});

const rawExtractionSchema = z.object({
  merchant: z.string().nullable().catch(null),
  date: z.string().nullable().catch(null),
  items: z.array(extractedItemSchema).catch([]),
  subtotal: z.number().int().nonnegative().nullable().catch(null),
  tax: z.number().int().nonnegative().nullable().catch(null),
  tip: z.number().int().nonnegative().nullable().catch(null),
  service_fee: z.number().int().nonnegative().nullable().catch(null),
  discount: z.number().int().nonnegative().nullable().catch(null),
  total: z.number().int().nonnegative().nullable().catch(null),
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
  taxAmount: number | null;
  tipAmount: number | null;
  serviceFeeAmount: number | null;
  discountAmount: number | null;
  totalAmount: number | null;
  overallConfidence: "high" | "low";
  totalsMismatch: TotalsMismatch | null;
}

function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fenced ? fenced[1].trim() : trimmed;
}

/** Never trust the model's own total — recompute from items + charges and
 * flag a mismatch in code, per CLAUDE.md's money rules and SPEC §2.7. */
function computeTotalsMismatch(
  items: ExtractedItem[],
  charges: { tax: number | null; tip: number | null; serviceFee: number | null; discount: number | null },
  extractedTotal: number | null,
): TotalsMismatch | null {
  if (extractedTotal === null) return null;
  const itemsSum =
    items.reduce((sum, item) => sum + item.price * item.quantity, 0) +
    (charges.tax ?? 0) +
    (charges.tip ?? 0) +
    (charges.serviceFee ?? 0) -
    (charges.discount ?? 0);
  const delta = itemsSum - extractedTotal;
  if (delta === 0) return null;
  return { itemsSum, extractedTotal, delta };
}

/** Calls Gemini to extract receipt data. Returns null on any failure —
 * timeout, API error, or a response that doesn't parse into the expected
 * shape — never throws. The image itself is uploaded to Storage by the
 * caller *before* this runs, so a null result here never loses the photo. */
export async function extractReceipt(buffer: Buffer, mimeType: string): Promise<ExtractionResult | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await getClient().models.generateContent({
      model: MODEL,
      contents: [PROMPT, createPartFromBase64(buffer.toString("base64"), mimeType)],
      config: {
        responseMimeType: "application/json",
        abortSignal: controller.signal,
      },
    });

    const text = response.text;
    if (!text) return null;

    const json = JSON.parse(stripCodeFences(text));
    const parsed = rawExtractionSchema.safeParse(json);
    if (!parsed.success) return null;
    const raw = parsed.data;

    const items: ExtractedItem[] = raw.items.map((item) => ({
      name: item.name,
      price: item.price,
      quantity: item.quantity,
      confidence: item.confidence,
    }));

    return {
      merchant: raw.merchant,
      billDate: raw.date,
      items,
      subtotalAmount: raw.subtotal,
      taxAmount: raw.tax,
      tipAmount: raw.tip,
      serviceFeeAmount: raw.service_fee,
      discountAmount: raw.discount,
      totalAmount: raw.total,
      overallConfidence: raw.overall_confidence,
      totalsMismatch: computeTotalsMismatch(
        items,
        { tax: raw.tax, tip: raw.tip, serviceFee: raw.service_fee, discount: raw.discount },
        raw.total,
      ),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

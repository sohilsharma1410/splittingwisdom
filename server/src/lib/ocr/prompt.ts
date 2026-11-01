// The instructions every vision model gets. Provider-independent on purpose.
export const RECEIPT_PROMPT = `You are reading a photo of a purchase receipt. Extract structured data as STRICT JSON matching exactly this shape, and nothing else — no markdown, no commentary, no code fences:
{
  "merchant": string | null,
  "date": string | null,
  "items": [ { "name": string, "price": number, "quantity": number, "confidence": "high" | "low" } ],
  "subtotal": number | null,
  "tax": number | null,
  "tax_included": number | null,
  "tip": number | null,
  "service_fee": number | null,
  "discount": number | null,
  "round_off": number | null,
  "total": number | null,
  "overall_confidence": "high" | "low"
}

Rules:
- All money amounts are integers in paise (INR minor units) — e.g. an item priced at ₹12.50 is 1250. Never output decimals or currency symbols.
- An item's "price" is the LINE TOTAL: the amount printed for that line in the amount column, for the whole quantity. Do NOT divide it by the quantity and do NOT multiply it. Example: "Butter Naan  4  60.00" -> quantity 4, price 6000 (the whole line costs ₹60).
- "date", if determinable, is ISO format yyyy-mm-dd.
- "round_off" is the small rounding adjustment some receipts print ("Round off -0.18"), as SIGNED paise: negative if the receipt shows a minus, positive otherwise. Use null if there is none. It is NOT a discount and NOT part of tax.
- "tax" is tax ADDED ON TOP of the item prices. If the receipt says the prices already include tax ("TOTAL INCL. OF ALL TAX", "inclusive of GST", a taxable value + tax adding up to the gross amount), that tax is NOT added: put its amount in "tax_included" and set "tax" to null. Never report the same tax in both.
- If a field isn't visible on the receipt or you're not confident about it, use null rather than guessing. Never invent an item that isn't actually on the receipt.
- An item's own "confidence" is "low" if its name, price, or quantity was hard to read clearly.
- "overall_confidence" is "low" if the receipt is blurry, cropped, handwritten, or otherwise hard to read as a whole.
- "quantity" defaults to 1 if the receipt doesn't show one.
Return ONLY the JSON object described above.`;

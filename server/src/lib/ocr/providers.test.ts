import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { extractReceipt, ocrInfo, parseExtraction, withRetries } from "../receipt-ocr.js";
import { readOcrConfig } from "./providers.js";

const GOOD = {
  merchant: "Spice Garden", date: "2026-10-28",
  items: [{ name: "Paneer Tikka", price: 25000, quantity: 1, confidence: "high" }, { name: "Butter Naan", price: 6000, quantity: 4, confidence: "high" }],
  subtotal: 31000, tax: 1550, tip: null, service_fee: null, discount: null, round_off: null, total: 32550, overall_confidence: "high",
};

describe("readOcrConfig", () => {
  it("defaults to Gemini and honours the old GEMINI_MODEL", () => {
    expect(readOcrConfig({})).toMatchObject({ provider: "gemini", model: "gemini-3.5-flash", timeoutMs: 60000 });
    expect(readOcrConfig({ GEMINI_MODEL: "gemini-x" }).model).toBe("gemini-x");
    expect(readOcrConfig({ GEMINI_MODEL: "old", OCR_MODEL: "new" }).model).toBe("new");
  });
  it("treats ollama / lmstudio / local / openai as one OpenAI-compatible provider, Ollama's address by default", () => {
    for (const name of ["openai", "ollama", "LM-Studio", "local", "llamacpp"]) {
      expect(readOcrConfig({ OCR_PROVIDER: name, OCR_MODEL: "m" })).toMatchObject({ provider: "openai", model: "m", baseUrl: "http://localhost:11434/v1" });
    }
    expect(readOcrConfig({ OCR_PROVIDER: "ollama", OCR_BASE_URL: "http://127.0.0.1:1234/v1/", OCR_TIMEOUT_MS: "180000" })).toMatchObject({ baseUrl: "http://127.0.0.1:1234/v1", timeoutMs: 180000 });
  });
  it("rejects an unknown provider loudly", () => {
    expect(() => readOcrConfig({ OCR_PROVIDER: "carrier-pigeon" })).toThrow(/OCR_PROVIDER/);
  });
  it("ocrInfo exposes provider and model but nothing secret", () => {
    const info = ocrInfo({ OCR_PROVIDER: "ollama", OCR_MODEL: "qwen2.5vl:7b", OCR_API_KEY: "sekret" } as NodeJS.ProcessEnv);
    expect(info).toEqual({ provider: "openai", model: "qwen2.5vl:7b" });
    expect(JSON.stringify(info)).not.toContain("sekret");
  });
});

describe("overload handling", () => {
  const busy = () => new Error('{"error":{"code":503,"message":"high demand","status":"UNAVAILABLE"}}');
  it("retries 'high demand' and rate-limit errors, then succeeds", async () => {
    let calls = 0;
    const result = await withRetries(async () => { if (++calls < 3) throw busy(); return "ok"; }, [1, 1]);
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });
  it("gives up after the allowed retries and reports the overload", async () => {
    let calls = 0;
    await expect(withRetries(async () => { calls++; throw busy(); }, [1, 1])).rejects.toThrow(/503/);
    expect(calls).toBe(3);
  });
  it("does not retry real errors (bad key, missing model)", async () => {
    let calls = 0;
    await expect(withRetries(async () => { calls++; throw new Error("404 model not found"); }, [1, 1])).rejects.toThrow(/404/);
    expect(calls).toBe(1);
  });
  it("uses gemini-3.5-flash-lite as the Gemini fallback unless told otherwise", () => {
    expect(readOcrConfig({}).fallbackModel).toBe("gemini-3.5-flash-lite");
    expect(readOcrConfig({ OCR_FALLBACK_MODEL: "gemini-x" }).fallbackModel).toBe("gemini-x");
    expect(readOcrConfig({ OCR_FALLBACK_MODEL: "none" }).fallbackModel).toBeNull();
    expect(readOcrConfig({ OCR_FALLBACK_MODEL: "" }).fallbackModel).toBeNull();
    expect(readOcrConfig({ OCR_PROVIDER: "ollama", OCR_MODEL: "m" }).fallbackModel).toBeNull();
  });
});

describe("parseExtraction — forgiving of weaker models", () => {
  it("accepts clean JSON", () => {
    const r = parseExtraction(JSON.stringify(GOOD))!;
    expect(r.items).toHaveLength(2);
    expect(r.totalsMismatch).toBeNull(); // 25000+6000+1550 = 32550
  });
  it("accepts code fences and chatter around the JSON", () => {
    expect(parseExtraction("```json\n" + JSON.stringify(GOOD) + "\n```")!.items).toHaveLength(2);
    expect(parseExtraction("Sure! Here is the receipt:\n" + JSON.stringify(GOOD) + "\nHope that helps.")!.items).toHaveLength(2);
  });
  it("rounds floats and numeric strings to whole paise", () => {
    const r = parseExtraction(JSON.stringify({ ...GOOD, items: [{ name: "A", price: "25000", quantity: "2", confidence: "high" }, { name: "B", price: 6000.4, quantity: 1 }] }))!;
    expect(r.items.map((i) => [i.price, i.quantity])).toEqual([[25000, 2], [6000, 1]]);
  });
  it("drops one unreadable line instead of losing the whole receipt", () => {
    const r = parseExtraction(JSON.stringify({ ...GOOD, items: [GOOD.items[0], { name: "???", price: "n/a" }, GOOD.items[1]] }))!;
    expect(r.items.map((i) => i.name)).toEqual(["Paneer Tikka", "Butter Naan"]);
  });
  it("keeps a negative round-off, and rejects negative prices", () => {
    expect(parseExtraction(JSON.stringify({ ...GOOD, round_off: -18 }))!.roundOffAmount).toBe(-18);
    expect(parseExtraction(JSON.stringify({ ...GOOD, items: [{ name: "x", price: -5 }] }))!.items).toEqual([]);
  });
  it("AIRR TOAST receipt: tax that is already inside the prices is not added again", () => {
    // Items 450+370+340 = ₹1,160 = the printed total; "GST 55.24" is inside that. The model reported it as added tax.
    const r = parseExtraction(JSON.stringify({ merchant: "AIRR TOAST", date: "2026-10-11", items: [
      { name: "Affogato", price: 45000, quantity: 1, confidence: "low" }, { name: "Mochaccino", price: 37000, quantity: 1, confidence: "high" }, { name: "Iced Latte", price: 34000, quantity: 1, confidence: "high" }],
      tax: 5524, total: 116000, overall_confidence: "high" }))!;
    expect(r.taxAmount).toBeNull();
    expect(r.taxIncludedAmount).toBe(5524);
    expect(r.totalsMismatch).toBeNull();
  });
  it("keeps tax that really is added on top (items + tax = total)", () => {
    const r = parseExtraction(JSON.stringify({ ...GOOD, tax: 1550, total: 32550 }))!;
    expect(r.taxAmount).toBe(1550);
    expect(r.taxIncludedAmount).toBeNull();
  });
  it("trusts the model when it reports included tax itself", () => {
    const r = parseExtraction(JSON.stringify({ ...GOOD, tax: null, tax_included: 1550, total: 31000 }))!;
    expect(r).toMatchObject({ taxAmount: null, taxIncludedAmount: 1550 });
  });
  it("returns null for non-JSON", () => {
    expect(parseExtraction("I cannot read this image.")).toBeNull();
    expect(parseExtraction("")).toBeNull();
  });
});

// A stand-in for Ollama / LM Studio / llama.cpp: speaks POST /v1/chat/completions.
let server: Server | undefined;
afterEach(() => { server?.close(); server = undefined; for (const k of ["OCR_PROVIDER", "OCR_MODEL", "OCR_BASE_URL", "OCR_API_KEY", "OCR_TIMEOUT_MS"]) delete process.env[k]; });

async function fakeLocalModel(handler: (req: IncomingMessage, body: any, n: number) => { status: number; body: unknown }) {
  let calls = 0;
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const { status, body } = handler(req, JSON.parse(Buffer.concat(chunks).toString() || "{}"), ++calls);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/v1`;
}
const reply = (content: string) => ({ status: 200, body: { choices: [{ message: { content } }] } });
const IMAGE = Buffer.from("not-really-a-jpeg");

describe("extractReceipt with a local OpenAI-compatible model", () => {
  it("sends the image and prompt to /chat/completions and parses the answer", async () => {
    let seen: any;
    let auth: string | undefined;
    process.env.OCR_BASE_URL = await fakeLocalModel((req, body) => { seen = body; auth = req.headers.authorization; return reply(JSON.stringify(GOOD)); });
    Object.assign(process.env, { OCR_PROVIDER: "ollama", OCR_MODEL: "qwen2.5vl:7b", OCR_API_KEY: "tok" });

    const r = await extractReceipt(IMAGE, "image/jpeg");

    expect(r?.merchant).toBe("Spice Garden");
    expect(seen.model).toBe("qwen2.5vl:7b");
    expect(seen.messages[0].content[0].text).toMatch(/LINE TOTAL/);
    expect(seen.messages[0].content[1].image_url.url).toBe(`data:image/jpeg;base64,${IMAGE.toString("base64")}`);
    expect(auth).toBe("Bearer tok");
  });
  it("retries without response_format when the server rejects it", async () => {
    const formats: boolean[] = [];
    process.env.OCR_BASE_URL = await fakeLocalModel((_r, body) => {
      formats.push("response_format" in body);
      return "response_format" in body ? { status: 400, body: { error: "unsupported" } } : reply(JSON.stringify(GOOD));
    });
    Object.assign(process.env, { OCR_PROVIDER: "local", OCR_MODEL: "m" });
    expect((await extractReceipt(IMAGE, "image/png"))?.items).toHaveLength(2);
    expect(formats).toEqual([true, false]);
  });
  it("returns null (never throws) when the local server is down, the model is missing, or it talks nonsense", async () => {
    Object.assign(process.env, { OCR_PROVIDER: "ollama", OCR_MODEL: "m", OCR_BASE_URL: "http://127.0.0.1:1/v1" });
    expect(await extractReceipt(IMAGE, "image/jpeg")).toBeNull(); // connection refused

    process.env.OCR_BASE_URL = await fakeLocalModel(() => ({ status: 404, body: { error: "model not found" } }));
    expect(await extractReceipt(IMAGE, "image/jpeg")).toBeNull();

    server?.close();
    process.env.OCR_BASE_URL = await fakeLocalModel(() => reply("I'm sorry, I can't help with that."));
    expect(await extractReceipt(IMAGE, "image/jpeg")).toBeNull();

    delete process.env.OCR_MODEL; // misconfigured: no model named
    expect(await extractReceipt(IMAGE, "image/jpeg")).toBeNull();
  });
  it("gives up after OCR_TIMEOUT_MS", async () => {
    process.env.OCR_BASE_URL = await new Promise<string>((resolve) => {
      server = createServer(() => { /* never answers */ });
      server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server!.address() as AddressInfo).port}/v1`));
    });
    Object.assign(process.env, { OCR_PROVIDER: "ollama", OCR_MODEL: "m", OCR_TIMEOUT_MS: "300" });
    const started = Date.now();
    expect(await extractReceipt(IMAGE, "image/jpeg")).toBeNull();
    expect(Date.now() - started).toBeLessThan(3000);
    server?.closeAllConnections?.();
  });
});

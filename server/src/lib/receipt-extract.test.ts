import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractLocally, extractReceipt, ocrInfo, usesLocalOcr } from "./receipt-extract.js";

const IMAGE = Buffer.from("made-up image");

function box(text: string, row: number, column = 0) {
  const left = 50 + column * 300;
  const top = 40 + row * 40;
  return { text, confidence: 0.97, box: [[left, top], [left + 280, top], [left + 280, top + 26], [left, top + 26]] };
}

const answer = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("choosing the reader", () => {
  it("only uses local OCR when asked, so Render needs no new env vars", () => {
    expect(usesLocalOcr({})).toBe(false);
    expect(usesLocalOcr({ OCR_PROVIDER: "gemini" })).toBe(false);
    expect(usesLocalOcr({ OCR_PROVIDER: "rapidocr" })).toBe(true);
    expect(usesLocalOcr({ OCR_PROVIDER: " RapidOCR " })).toBe(true);
  });

  it("doesn't confuse local OCR with a local model server", () => {
    expect(usesLocalOcr({ OCR_PROVIDER: "local" })).toBe(false);
  });

  it("names the reader for the review screen", () => {
    expect(ocrInfo({ OCR_PROVIDER: "rapidocr" })).toEqual({ provider: "rapidocr", model: "local OCR" });
    expect(ocrInfo({ OCR_PROVIDER: "gemini", OCR_MODEL: "some-model" })).toEqual({ provider: "gemini", model: "some-model" });
  });

  it("doesn't fail the request over a mistyped setting", () => {
    expect(ocrInfo({ OCR_PROVIDER: "rapidcr" })).toEqual({ provider: "unknown", model: "the receipt reader" });
  });

  it("treats a typo as a failed scan, so it can't send photos to Google", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const realFetch = vi.spyOn(globalThis, "fetch");
    vi.stubEnv("OCR_PROVIDER", "rapidcr");
    vi.stubEnv("GEMINI_API_KEY", "not-a-real-key");
    expect(await extractReceipt(IMAGE, "image/jpeg")).toBeNull();
    expect(realFetch).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
    realFetch.mockRestore();
    errors.mockRestore();
  });
});

describe("extractLocally", () => {
  let errors: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errors = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    errors.mockRestore();
  });

  it("sends the image to the OCR service and parses what it read", async () => {
    const fetchFn = answer(200, { boxes: [box("Tea", 0), box("80.00", 0, 1), box("Total", 1), box("80.00", 1, 1)] });
    const result = await extractLocally(IMAGE, "image/jpeg", { url: "http://ocr.test/", fetchFn });
    expect(result?.items).toEqual([{ name: "Tea", price: 8000, quantity: 1, confidence: "high" }]);
    expect(result?.totalAmount).toBe(8000);

    const [url, init] = vi.mocked(fetchFn).mock.calls[0];
    expect(url).toBe("http://ocr.test/ocr");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({ "Content-Type": "image/jpeg" });
    expect(Buffer.from(init?.body as Uint8Array).equals(IMAGE)).toBe(true);
  });

  it("returns null when the photo has no bill on it", async () => {
    expect(await extractLocally(IMAGE, "image/jpeg", { fetchFn: answer(200, { boxes: [] }) })).toBeNull();
    expect(errors).not.toHaveBeenCalled();
  });

  it("returns null without logging a fault when the image is unreadable", async () => {
    expect(await extractLocally(IMAGE, "image/jpeg", { fetchFn: answer(422, { error: "x" }) })).toBeNull();
    expect(errors).not.toHaveBeenCalled();
  });

  it("returns null and logs when the service fails", async () => {
    expect(await extractLocally(IMAGE, "image/jpeg", { fetchFn: answer(500, { error: "x" }) })).toBeNull();
    expect(errors).toHaveBeenCalledOnce();
  });

  it("returns null when the service is down", async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await extractLocally(IMAGE, "image/jpeg", { fetchFn })).toBeNull();
  });

  it("returns null when the service answers nonsense", async () => {
    for (const body of [{ boxes: "nope" }, { boxes: [{ text: "x" }] }, {}]) {
      expect(await extractLocally(IMAGE, "image/jpeg", { fetchFn: answer(200, body) })).toBeNull();
    }
  });

  it("gives up after the timeout", async () => {
    const fetchFn = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    ) as unknown as typeof fetch;
    expect(await extractLocally(IMAGE, "image/jpeg", { fetchFn, timeoutMs: 20 })).toBeNull();
    expect(errors).toHaveBeenCalledOnce();
  });

  it("never logs what the receipt said", async () => {
    const fetchFn = answer(200, { boxes: [box("Secret Item", 0), { text: "bad" }] });
    await extractLocally(IMAGE, "image/jpeg", { fetchFn });
    expect(JSON.stringify(errors.mock.calls)).not.toContain("Secret Item");
  });
});

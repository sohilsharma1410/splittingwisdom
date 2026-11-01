#!/usr/bin/env node
// A stand-in for a local vision model (Ollama / LM Studio / llama.cpp): serves the OpenAI-style
// POST /v1/chat/completions that the app's "openai" OCR provider speaks. For tests and demos —
// no model, no key, no network. It "reads" the real Ganbei receipt used during OCR testing, with
// one line marked low-confidence so the review screen has something to flag. An image under 100
// bytes plays an unreadable photo: the model answers with prose instead of JSON.
//   node scripts/fake-vision-model.mjs [port]      (default 4290)
import { createServer } from "node:http";

const items = [
  ["Vodka Prawns", 65900], ["Mac N Cheese Bites", 34900], ["Pothu Karuthu Irunthathu (Pothu Dry Fry)", 47900],
  ["Harissa Chicken Wings", 47900], ["Pahadi Mushroom Tikka", 47900], ["Wheat Scandal (60ml)", 10000], ["Mango Tango (60ml)", 10000],
  ["Mango Tango (1500ml)", 130000], ["Wheat Scandal (500ml)", 44000], ["Mango Tango (500ml)", 44000], ["Appam (1pcs)", 55000],
  ["Veg Stew", 35900], ["Chicken Pal Curry", 44900], ["Chemmeen Mangaacharil Chadiyathu", 69900], ["Kerala Porotta- 1pcs", 5000],
  ["Chicken Alfredo Pasta (Penne)", 51500],
].map(([name, price]) => ({ name, price, quantity: name.startsWith("Appam") ? 11 : 1, confidence: name.startsWith("Chicken Pal") ? "low" : "high" }));

const receipt = {
  merchant: "Ganbei Restaurant Pvt Ltd", date: "2026-10-31", items, subtotal: 744700, tax: 25336, tip: null,
  service_fee: 44682, discount: null, round_off: -18, total: 814700, overall_confidence: "high",
};

const port = Number(process.argv[2]) || 4290;
createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    if (req.method !== "POST" || !req.url.endsWith("/chat/completions")) { res.writeHead(404).end(); return; }
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    const url = body.messages?.[0]?.content?.find?.((p) => p.type === "image_url")?.image_url?.url ?? "";
    const bytes = Buffer.from(url.split(",")[1] ?? "", "base64").length;
    const content = bytes < 100 ? "Sorry, I can't make out anything on this image." : JSON.stringify(receipt);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
}).listen(port, "127.0.0.1", () => console.log(`fake vision model on http://127.0.0.1:${port}/v1`));

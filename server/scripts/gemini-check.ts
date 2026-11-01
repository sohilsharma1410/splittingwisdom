/**
 * Checks that GEMINI_API_KEY works and that the configured model still exists.
 * Reads the key from the environment (server/.env or the shell) and never prints it.
 *
 * Run from server/:  npx tsx scripts/gemini-check.ts
 */
import "dotenv/config";
import { GoogleGenAI } from "@google/genai";

const key = process.env.GEMINI_API_KEY;
const model = process.env.GEMINI_MODEL || "gemini-3.5-flash";

async function main() {
  if (!key || key === "change-me") {
    console.error("GEMINI_API_KEY is not set (put it in server/.env). Nothing was sent anywhere.");
    process.exit(1);
  }
  const ai = new GoogleGenAI({ apiKey: key });

  const available: string[] = [];
  try {
    for await (const m of await ai.models.list()) {
      const actions = (m as { supportedActions?: string[] }).supportedActions ?? [];
      if (m.name && actions.includes("generateContent")) available.push(m.name.replace(/^models\//, ""));
    }
  } catch (err) {
    console.error("Could not list models — the key is probably invalid or blocked:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
  console.log(`Key accepted. ${available.length} models support generateContent.`);
  const flash = available.filter((n) => /flash/i.test(n) && !/(image|tts|live|thinking|embedding)/i.test(n)).sort();
  console.log("Flash models available to this key:\n  " + (flash.join("\n  ") || "(none found)"));

  console.log(`\nConfigured model: ${model}`);
  if (!available.includes(model)) {
    console.error(`  NOT FOUND for this key. Set GEMINI_MODEL to one of the flash models above (a recent stable one) and re-run.`);
    process.exit(2);
  }
  try {
    const res = await ai.models.generateContent({ model, contents: "Reply with the single word OK." });
    console.log(`  Test call succeeded: "${(res.text ?? "").trim().slice(0, 40)}"`);
  } catch (err) {
    console.error("  Test call failed:", err instanceof Error ? err.message : err);
    process.exit(3);
  }
}
main();

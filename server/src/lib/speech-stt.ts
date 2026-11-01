// Talks to the speech-to-text container (plan D4.10, deploy/pi/stt). Like local OCR it never
// throws: a missing or failing service means "speech isn't available right now", and the app
// carries on with hand entry. Audio and what it said are never logged.

const TIMEOUT_MS = 30_000;
const HEALTH_TIMEOUT_MS = 2_000;
const HEALTH_CACHE_MS = 10_000;

/** STT_URL turns speech on. Unset (as on Render and Vercel, which can't run it) means off. */
export function sttUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const url = env.STT_URL?.trim();
  return url ? url.replace(/\/$/, "") : null;
}

interface Deps {
  url?: string;
  fetchFn?: typeof fetch;
}

let healthCache: { at: number; ok: boolean } | null = null;

export async function sttAvailable(deps: Deps = {}): Promise<boolean> {
  const url = deps.url ?? sttUrl();
  if (!url) return false;
  if (!deps.fetchFn && healthCache && Date.now() - healthCache.at < HEALTH_CACHE_MS) return healthCache.ok;
  let ok = false;
  try {
    const res = await (deps.fetchFn ?? fetch)(`${url}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    ok = res.ok;
  } catch {
    ok = false;
  }
  if (!deps.fetchFn) healthCache = { at: Date.now(), ok };
  return ok;
}

export type TranscribeResult = { ok: true; text: string } | { ok: false; reason: "unavailable" | "too-long" | "unreadable" };

/** Sends audio to the service. `prompt` is the group's names and the bill's items, which the model uses to spell them. */
export async function transcribe(audio: Buffer, mimeType: string, prompt: string, deps: Deps = {}): Promise<TranscribeResult> {
  const url = deps.url ?? sttUrl();
  if (!url) return { ok: false, reason: "unavailable" };
  try {
    const res = await (deps.fetchFn ?? fetch)(`${url}/transcribe`, {
      method: "POST",
      headers: { "Content-Type": mimeType || "application/octet-stream", "X-Prompt": encodeURIComponent(prompt) },
      body: new Uint8Array(audio),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 413) return { ok: false, reason: "too-long" };
    if (res.status === 422) return { ok: false, reason: "unreadable" };
    if (!res.ok) throw new Error(`speech service answered ${res.status}`);
    const body = (await res.json()) as { text?: unknown };
    return { ok: true, text: typeof body.text === "string" ? body.text.trim() : "" };
  } catch (err) {
    console.error("Speech service failed:", err instanceof Error ? err.message : "unknown error");
    return { ok: false, reason: "unavailable" };
  }
}

const MAX_PROMPT_CHARS = 600;

/**
 * The words the recogniser should expect, built on the server from the database so a client
 * can't put anything else in it. Names first, because they're the hardest to spell by ear.
 */
export function buildPrompt(memberNames: string[], itemNames: string[]): string {
  const clean = (s: string) => s.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  const names = [...new Set(memberNames.map(clean).filter(Boolean))];
  const items = [...new Set(itemNames.map(clean).filter(Boolean))];
  let prompt = names.length > 0 ? `People: ${names.join(", ")}.` : "";
  if (items.length > 0) prompt += `${prompt ? " " : ""}Items: ${items.join(", ")}.`;
  return prompt.slice(0, MAX_PROMPT_CHARS);
}

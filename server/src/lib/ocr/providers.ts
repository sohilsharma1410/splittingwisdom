import { GoogleGenAI, createPartFromBase64 } from "@google/genai";

/**
 * A vision provider turns (image + instructions) into the model's raw text
 * answer. Everything else — the prompt, JSON repair, validation, the totals
 * check — is shared, so adding a model is configuration, not code.
 *
 *   OCR_PROVIDER   gemini (default) | openai
 *                  "openai" means ANY server that speaks the OpenAI chat-completions API with
 *                  image input: Ollama, LM Studio, llama.cpp's server, vLLM, OpenAI itself…
 *   OCR_MODEL      model id. gemini default: GEMINI_MODEL or gemini-3.5-flash. openai: required.
 *   OCR_BASE_URL   openai only. Default http://localhost:11434/v1 (Ollama)
 *   OCR_API_KEY    openai only, optional (local servers ignore it)
 *   OCR_TIMEOUT_MS default 60000; local models on a laptop may need 180000+
 *   GEMINI_API_KEY gemini only
 */
export interface VisionRequest {
  buffer: Buffer;
  mimeType: string;
  prompt: string;
  signal: AbortSignal;
}
export type VisionProvider = (req: VisionRequest) => Promise<string>;

export interface OcrConfig {
  provider: "gemini" | "openai";
  model: string;
  baseUrl: string | null;
  timeoutMs: number;
}

const OPENAI_ALIASES = new Set(["openai", "ollama", "lmstudio", "lm-studio", "llamacpp", "llama.cpp", "vllm", "local"]);

export function readOcrConfig(env: NodeJS.ProcessEnv = process.env): OcrConfig {
  const raw = (env.OCR_PROVIDER || "gemini").trim().toLowerCase();
  const timeoutMs = Number(env.OCR_TIMEOUT_MS) > 0 ? Number(env.OCR_TIMEOUT_MS) : 60_000;
  if (OPENAI_ALIASES.has(raw)) {
    return {
      provider: "openai",
      model: env.OCR_MODEL?.trim() || "",
      baseUrl: (env.OCR_BASE_URL?.trim() || "http://localhost:11434/v1").replace(/\/$/, ""),
      timeoutMs,
    };
  }
  if (raw !== "gemini") throw new Error(`OCR_PROVIDER must be "gemini" or "openai" (got "${env.OCR_PROVIDER}").`);
  return {
    provider: "gemini",
    // Google retires model ids (2.0 is gone, 2.5 is closed to new users), hence configurable.
    model: env.OCR_MODEL?.trim() || env.GEMINI_MODEL?.trim() || "gemini-3.5-flash",
    baseUrl: null,
    timeoutMs,
  };
}

let geminiClient: GoogleGenAI | null = null;
function gemini(): GoogleGenAI {
  if (geminiClient) return geminiClient;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set. Copy server/.env.example to server/.env and fill it in.");
  geminiClient = new GoogleGenAI({ apiKey });
  return geminiClient;
}

export function geminiProvider(model: string): VisionProvider {
  return async ({ buffer, mimeType, prompt, signal }) => {
    const response = await gemini().models.generateContent({
      model,
      contents: [prompt, createPartFromBase64(buffer.toString("base64"), mimeType)],
      config: { responseMimeType: "application/json", abortSignal: signal },
    });
    return response.text ?? "";
  };
}

export function openAICompatibleProvider(config: { model: string; baseUrl: string }, env: NodeJS.ProcessEnv = process.env): VisionProvider {
  if (!config.model) {
    throw new Error('OCR_MODEL is required when OCR_PROVIDER=openai (e.g. "qwen2.5vl:7b" on Ollama).');
  }
  return async ({ buffer, mimeType, prompt, signal }) => {
    const body = (withJsonMode: boolean) =>
      JSON.stringify({
        model: config.model,
        temperature: 0,
        ...(withJsonMode ? { response_format: { type: "json_object" } } : {}),
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: `data:${mimeType};base64,${buffer.toString("base64")}` } },
            ],
          },
        ],
      });
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (env.OCR_API_KEY) headers.Authorization = `Bearer ${env.OCR_API_KEY}`;

    const call = (withJsonMode: boolean) => fetch(`${config.baseUrl}/chat/completions`, { method: "POST", headers, body: body(withJsonMode), signal });
    let res = await call(true);
    // Some servers reject response_format; the prompt already demands JSON-only, so retry without it.
    if (res.status === 400 || res.status === 422) res = await call(false);
    if (!res.ok) throw new Error(`${res.status} from ${config.baseUrl}: ${(await res.text()).slice(0, 200)}`);
    const json = (await res.json()) as { choices?: { message?: { content?: string | null } }[] };
    return json.choices?.[0]?.message?.content ?? "";
  };
}

export function buildProvider(config: OcrConfig, env: NodeJS.ProcessEnv = process.env): VisionProvider {
  return config.provider === "gemini" ? geminiProvider(config.model) : openAICompatibleProvider({ model: config.model, baseUrl: config.baseUrl! }, env);
}

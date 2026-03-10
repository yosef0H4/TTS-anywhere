import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type {
  ProviderAudioResult,
  ProviderLlmConfig,
  ProviderModelsRequest,
  ProviderOption,
  ProviderTextResult,
  ProviderTtsConfig,
  ProviderVoicesRequest
} from "./provider-ipc.js";

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

function requireBaseUrl(baseUrl: string | undefined): string {
  const normalized = baseUrl?.trim() ?? "";
  if (!normalized) {
    throw new Error("OpenAI-compatible provider requires a base URL");
  }
  return normalized;
}

function createClient(baseUrl: string, apiKey: string): OpenAI {
  return new OpenAI({
    baseURL: normalizeBaseUrl(baseUrl),
    apiKey
  });
}

function buildMessages(dataUrl: string, config: ProviderLlmConfig): ChatCompletionMessageParam[] {
  return [
    {
      role: "user",
      content: [
        { type: "text", text: config.promptTemplate },
        { type: "image_url", image_url: { url: dataUrl, detail: config.imageDetail } as { url: string; detail: "low" | "high" } }
      ]
    }
  ];
}

function extractErrorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const record = error as Record<string, unknown>;
    const status = typeof record.status === "number" ? `status=${record.status} ` : "";
    const message = typeof record.message === "string" ? record.message : JSON.stringify(record);
    return `${status}${message}`.trim();
  }
  return String(error);
}

function authHeaders(apiKey: string): HeadersInit {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

function joinApiPath(baseUrl: string, path: string, query: Record<string, string | undefined> = {}): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  const safePath = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(`${normalized}${safePath}`);
  Object.entries(query).forEach(([key, value]) => {
    const trimmed = value?.trim();
    if (trimmed) {
      url.searchParams.set(key, trimmed);
    }
  });
  return url.toString();
}

function parseOptions(payload: unknown): ProviderOption[] {
  if (!payload || typeof payload !== "object") return [];
  const obj = payload as Record<string, unknown>;

  if (Array.isArray(obj.data)) {
    return obj.data
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        const record = item as Record<string, unknown>;
        const id = typeof record.id === "string" ? record.id.trim() : "";
        return id ? { value: id, label: id } : null;
      })
      .filter((item): item is ProviderOption => item !== null);
  }

  if (Array.isArray(obj.voices)) {
    return obj.voices
      .map((entry) => {
        if (typeof entry === "string") {
          const value = entry.trim();
          return value ? { value, label: value } : null;
        }
        if (!entry || typeof entry !== "object") return null;
        const record = entry as Record<string, unknown>;
        const id = typeof record.id === "string" ? record.id.trim() : "";
        const name = typeof record.name === "string" ? record.name.trim() : id;
        return id ? { value: id, label: name || id } : null;
      })
      .filter((item): item is ProviderOption => item !== null);
  }

  return [];
}

function resolveReasoningEffort(
  model: string,
  thinkingMode: "provider_default" | "low" | "off" | undefined
): "none" | "low" | null {
  const normalized = model.trim().toLowerCase();
  if (thinkingMode === "off") {
    return normalized.includes("gemini-3") ? "low" : "none";
  }
  if (thinkingMode === "low") {
    return "low";
  }
  if (thinkingMode === "provider_default") {
    return null;
  }
  if (normalized.includes("gemini-2.5")) {
    return "none";
  }
  if (normalized.includes("gemini-3")) {
    return "low";
  }
  return null;
}

export class ElectronProviderLlmService {
  async extractTextFromImage(
    dataUrl: string,
    config: ProviderLlmConfig,
    options?: { signal?: AbortSignal }
  ): Promise<ProviderTextResult> {
    const baseUrl = requireBaseUrl(config.baseUrl);
    const reasoningEffort = resolveReasoningEffort(config.model, config.thinkingMode);
    const response = await createClient(baseUrl, config.apiKey).chat.completions.create({
      model: config.model,
      messages: buildMessages(dataUrl, config),
      max_tokens: config.maxTokens,
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {})
    }, options?.signal ? { signal: options.signal } : undefined);

    const text = response.choices?.[0]?.message?.content?.trim() ?? "";
    if (!text) {
      throw new Error("OCR produced empty text");
    }
    return { text };
  }

  async extractTextFromImageStream(
    dataUrl: string,
    config: ProviderLlmConfig,
    options?: { signal?: AbortSignal; onToken?: (token: string) => void }
  ): Promise<ProviderTextResult> {
    let fullText = "";
    const baseUrl = requireBaseUrl(config.baseUrl);
    const reasoningEffort = resolveReasoningEffort(config.model, config.thinkingMode);
    const stream = await createClient(baseUrl, config.apiKey).chat.completions.create({
      model: config.model,
      messages: buildMessages(dataUrl, config),
      stream: true,
      max_tokens: config.maxTokens,
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {})
    }, options?.signal ? { signal: options.signal } : undefined);

    for await (const chunk of stream as AsyncIterable<{ choices?: Array<{ delta?: { content?: string | null } }> }>) {
      const token = chunk.choices?.[0]?.delta?.content;
      if (typeof token === "string" && token.length > 0) {
        fullText += token;
        options?.onToken?.(token);
      }
    }

    const text = fullText.trim();
    if (!text) {
      throw new Error("OCR produced empty text");
    }
    return { text };
  }
}

export class ElectronProviderTtsService {
  async synthesize(
    text: string,
    config: ProviderTtsConfig,
    options?: { signal?: AbortSignal; timeoutMs?: number }
  ): Promise<ProviderAudioResult> {
    const baseUrl = requireBaseUrl(config.baseUrl);
    const timeoutMs = Math.max(1000, options?.timeoutMs ?? 30000);
    const timeoutController = new AbortController();
    const mergedController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(), timeoutMs);
    const onAbort = (): void => {
      mergedController.abort();
    };

    timeoutController.signal.addEventListener("abort", onAbort);
    options?.signal?.addEventListener("abort", onAbort);

    try {
      const response = await createClient(baseUrl, config.apiKey).audio.speech.create({
        model: config.model,
        input: text,
        voice: config.voice,
        speed: config.speed,
        response_format: config.format
      }, { signal: mergedController.signal });
      const audioBytes = new Uint8Array(await response.arrayBuffer());
      const mimeType = config.format === "wav"
        ? "audio/wav"
        : config.format === "opus"
          ? "audio/ogg; codecs=opus"
          : "audio/mpeg";
      return { audioBytes, mimeType };
    } finally {
      clearTimeout(timeout);
      timeoutController.signal.removeEventListener("abort", onAbort);
      options?.signal?.removeEventListener("abort", onAbort);
    }
  }
}

export async function fetchProviderModels(request: ProviderModelsRequest): Promise<ProviderOption[]> {
  const response = await fetch(joinApiPath(requireBaseUrl(request.baseUrl), "/models"), {
    headers: authHeaders(request.apiKey)
  });
  if (!response.ok) {
    throw new Error(`status=${response.status}`);
  }
  const payload = await response.json();
  return parseOptions(payload);
}

export async function fetchProviderVoices(request: ProviderVoicesRequest): Promise<ProviderOption[]> {
  const baseUrl = requireBaseUrl(request.baseUrl);
  const candidates = ["/voices", "/audio/voices", "/models"];
  for (const path of candidates) {
    try {
      const response = await fetch(joinApiPath(baseUrl, path, { model: request.model }), {
        headers: authHeaders(request.apiKey)
      });
      if (!response.ok) continue;
      const payload = await response.json();
      const options = parseOptions(payload);
      if (options.length > 0) {
        return options;
      }
    } catch {
      // Try the next candidate.
    }
  }
  return [];
}

export { extractErrorMessage, normalizeBaseUrl };

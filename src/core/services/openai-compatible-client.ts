import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { loggers } from "../logging";
import type { LlmConfig, OcrResult, TtsAudioResult, TtsConfig } from "../models/types";

interface LlmClient {
  chat: {
    completions: {
      create: (params: {
        model: string;
        messages: ChatCompletionMessageParam[];
      }, requestOptions?: { signal?: AbortSignal }) => Promise<{ choices?: Array<{ message?: { content?: string | null } }> }>;
    };
  };
}

interface TtsClient {
  audio: {
    speech: {
      create: (params: {
        model: string;
        input: string;
        voice: string;
        speed: number;
        response_format: "mp3" | "wav" | "opus";
      }, requestOptions?: { signal?: AbortSignal }) => Promise<{ arrayBuffer: () => Promise<ArrayBuffer> }>;
    };
  };
}

function createClient(baseUrl: string, apiKey: string): OpenAI {
  const normalizedBaseUrl = normalizeOpenAiBaseUrl(baseUrl);
  return new OpenAI({
    baseURL: normalizedBaseUrl,
    apiKey,
    dangerouslyAllowBrowser: true
  });
}

function normalizeOpenAiBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed.endsWith("/v1")) {
    return trimmed;
  }
  return `${trimmed}/v1`;
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

function isAbortError(error: unknown): boolean {
  const text = extractErrorMessage(error).toLowerCase();
  return text.includes("abort") || text.includes("cancel");
}

export class OpenAiCompatibleLlmService {
  constructor(private readonly clientFactory: (config: LlmConfig) => LlmClient = (config) => createClient(config.baseUrl, config.apiKey)) {}

  async extractTextFromImage(dataUrl: string, config: LlmConfig, options?: { signal?: AbortSignal }): Promise<OcrResult> {
    const messages: ChatCompletionMessageParam[] = [
      {
        role: "user",
        content: [
          { type: "text", text: config.promptTemplate },
          { type: "image_url", image_url: { url: dataUrl, detail: config.imageDetail } as { url: string; detail: "low" | "high" } }
        ]
      }
    ];

    const endpoint = normalizeOpenAiBaseUrl(config.baseUrl);
    const done = loggers.api.time("ocr.request");
    try {
      loggers.api.info("OCR request started", { endpoint, model: config.model, imageBytes: dataUrl.length });
      const response = await this.clientFactory(config).chat.completions.create({
        model: config.model,
        messages
      }, options?.signal ? { signal: options.signal } : undefined);

      const text = response.choices?.[0]?.message?.content?.trim() ?? "";
      if (!text) {
        throw new Error("OCR produced empty text");
      }
      done();
      loggers.api.info("OCR request completed", { textLength: text.length });

      return { text };
    } catch (error) {
      const message = extractErrorMessage(error);
      if (isAbortError(error)) {
        loggers.api.info("OCR request cancelled", { endpoint, model: config.model });
        throw new Error("Cancelled");
      }
      loggers.api.error("OCR request failed", { error: message, endpoint, model: config.model });
      throw new Error(`OCR request failed (${endpoint}/chat/completions): ${message}`);
    }
  }
}

export class OpenAiCompatibleTtsService {
  constructor(private readonly clientFactory: (config: TtsConfig) => TtsClient = (config) => createClient(config.baseUrl, config.apiKey)) {}

  async synthesize(text: string, config: TtsConfig, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<TtsAudioResult> {
    const endpoint = normalizeOpenAiBaseUrl(config.baseUrl);
    const done = loggers.api.time("tts.request");
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
      loggers.api.info("TTS request started", { endpoint, model: config.model, voice: config.voice, textLength: text.length });
      const response = await this.clientFactory(config).audio.speech.create({
        model: config.model,
        input: text,
        voice: config.voice,
        speed: config.speed,
        response_format: config.format
      }, { signal: mergedController.signal });

      const audioArrayBuffer = await response.arrayBuffer();
      done();
      loggers.api.info("TTS request completed", { bytes: audioArrayBuffer.byteLength });
      return { audioBlob: new Blob([audioArrayBuffer]) };
    } catch (error) {
      const message = extractErrorMessage(error);
      if (isAbortError(error)) {
        loggers.api.info("TTS request cancelled", { endpoint, model: config.model, voice: config.voice });
        throw new Error("Cancelled");
      }
      loggers.api.error("TTS request failed", { error: message, endpoint, model: config.model });
      throw new Error(`TTS request failed (${endpoint}/audio/speech): ${message}`);
    } finally {
      clearTimeout(timeout);
      timeoutController.signal.removeEventListener("abort", onAbort);
      options?.signal?.removeEventListener("abort", onAbort);
    }
  }
}

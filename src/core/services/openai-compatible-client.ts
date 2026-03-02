import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { LlmConfig, OcrResult, TtsAudioResult, TtsConfig } from "../models/types";

interface LlmClient {
  chat: {
    completions: {
      create: (params: {
        model: string;
        messages: ChatCompletionMessageParam[];
      }) => Promise<{ choices?: Array<{ message?: { content?: string | null } }> }>;
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

export class OpenAiCompatibleLlmService {
  constructor(private readonly clientFactory: (config: LlmConfig) => LlmClient = (config) => createClient(config.baseUrl, config.apiKey)) {}

  async extractTextFromImage(dataUrl: string, config: LlmConfig): Promise<OcrResult> {
    const messages: ChatCompletionMessageParam[] = [
      {
        role: "user",
        content: [
          { type: "text", text: config.promptTemplate },
          { type: "image_url", image_url: { url: dataUrl } }
        ]
      }
    ];

    const endpoint = normalizeOpenAiBaseUrl(config.baseUrl);
    try {
      const response = await this.clientFactory(config).chat.completions.create({
        model: config.model,
        messages
      });

      const text = response.choices?.[0]?.message?.content?.trim() ?? "";
      if (!text) {
        throw new Error("OCR produced empty text");
      }

      return { text };
    } catch (error) {
      throw new Error(`OCR request failed (${endpoint}/chat/completions): ${extractErrorMessage(error)}`);
    }
  }
}

export class OpenAiCompatibleTtsService {
  constructor(private readonly clientFactory: (config: TtsConfig) => TtsClient = (config) => createClient(config.baseUrl, config.apiKey)) {}

  async synthesize(text: string, config: TtsConfig, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<TtsAudioResult> {
    const endpoint = normalizeOpenAiBaseUrl(config.baseUrl);
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
      const response = await this.clientFactory(config).audio.speech.create({
        model: config.model,
        input: text,
        voice: config.voice,
        speed: config.speed,
        response_format: config.format
      }, { signal: mergedController.signal });

      const audioArrayBuffer = await response.arrayBuffer();
      return { audioBlob: new Blob([audioArrayBuffer]) };
    } catch (error) {
      throw new Error(`TTS request failed (${endpoint}/audio/speech): ${extractErrorMessage(error)}`);
    } finally {
      clearTimeout(timeout);
      timeoutController.signal.removeEventListener("abort", onAbort);
      options?.signal?.removeEventListener("abort", onAbort);
    }
  }
}

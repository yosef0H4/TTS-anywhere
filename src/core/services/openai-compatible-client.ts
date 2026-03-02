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
      }) => Promise<{ arrayBuffer: () => Promise<ArrayBuffer> }>;
    };
  };
}

function createClient(baseUrl: string, apiKey: string): OpenAI {
  return new OpenAI({
    baseURL: baseUrl,
    apiKey,
    dangerouslyAllowBrowser: true
  });
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

    const response = await this.clientFactory(config).chat.completions.create({
      model: config.model,
      messages
    });

    const text = response.choices?.[0]?.message?.content?.trim() ?? "";
    if (!text) {
      throw new Error("OCR produced empty text");
    }

    return { text };
  }
}

export class OpenAiCompatibleTtsService {
  constructor(private readonly clientFactory: (config: TtsConfig) => TtsClient = (config) => createClient(config.baseUrl, config.apiKey)) {}

  async synthesize(text: string, config: TtsConfig): Promise<TtsAudioResult> {
    const response = await this.clientFactory(config).audio.speech.create({
      model: config.model,
      input: text,
      voice: config.voice,
      speed: config.speed,
      response_format: config.format
    });

    const audioArrayBuffer = await response.arrayBuffer();
    return { audioBlob: new Blob([audioArrayBuffer]) };
  }
}

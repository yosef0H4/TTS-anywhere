import { describe, expect, it, vi } from "vitest";
import { OpenAiCompatibleLlmService, OpenAiCompatibleTtsService } from "../core/services/openai-compatible-client";

function makeLlmConfig(overrides: Record<string, unknown> = {}) {
  return {
    provider: "openai_compatible" as const,
    baseUrl: "https://example.com/v1",
    apiKey: "k",
    model: "m",
    promptTemplate: "Extract",
    imageDetail: "low" as const,
    ocrStreamingEnabled: true,
    ocrStreamingFallbackToNonStream: true,
    maxTokens: 4096,
    thinkingMode: "off" as const,
    openaiCompatible: {
      baseUrl: "https://example.com/v1",
      apiKey: "k",
      model: "m",
      promptTemplate: "Extract",
      imageDetail: "low" as const,
      ocrStreamingEnabled: true,
      ocrStreamingFallbackToNonStream: true,
      maxTokens: 4096,
      thinkingMode: "off" as const
    },
    geminiSdk: {
      apiKey: "k",
      model: "models/gemini-2.5-flash-lite",
      promptTemplate: "Extract",
      imageDetail: "low" as const,
      ocrStreamingEnabled: true,
      ocrStreamingFallbackToNonStream: true,
      maxTokens: 4096,
      thinkingMode: "off" as const
    },
    ...overrides
  };
}

function makeTtsConfig(overrides: Record<string, unknown> = {}) {
  return {
    provider: "openai_compatible" as const,
    baseUrl: "https://example.com/v1",
    apiKey: "k",
    model: "tts-model",
    voice: "alloy",
    format: "mp3" as const,
    speed: 1,
    thinkingMode: "off" as const,
    openaiCompatible: {
      baseUrl: "https://example.com/v1",
      apiKey: "k",
      model: "tts-model",
      voice: "alloy",
      format: "mp3" as const,
      speed: 1,
      thinkingMode: "off" as const
    },
    geminiSdk: {
      apiKey: "k",
      model: "gemini-2.5-flash-preview-tts",
      voice: "Kore",
      format: "wav" as const,
      speed: 1,
      thinkingMode: "off" as const
    },
    ...overrides
  };
}

describe("openai compatible clients", () => {
  it("calls chat/completions for OCR", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: "hello world" } }]
    });

    const service = new OpenAiCompatibleLlmService(() => ({
      chat: {
        completions: {
          create
        }
      }
    }));

    const result = await service.extractTextFromImage("data:image/png;base64,abc", makeLlmConfig());

    expect(create).toHaveBeenCalledOnce();
    const [firstCallParams] = create.mock.calls[0] ?? [];
    expect(firstCallParams).toEqual(expect.objectContaining({
      messages: expect.arrayContaining([
        expect.objectContaining({
          content: expect.arrayContaining([
            expect.objectContaining({
              type: "image_url",
              image_url: expect.objectContaining({ detail: "low" })
            })
          ])
        })
      ])
    }));
    expect(result.text).toBe("hello world");
  });

  it("calls audio/speech for TTS", async () => {
    const create = vi.fn().mockResolvedValue({
      arrayBuffer: async () => new TextEncoder().encode("audio").buffer
    });

    const service = new OpenAiCompatibleTtsService(() => ({
      audio: {
        speech: {
          create
        }
      }
    }));

    const result = await service.synthesize("text", makeTtsConfig());

    expect(create).toHaveBeenCalledOnce();
    expect(result.audioBlob.size).toBeGreaterThan(0);
  });

  it("maps OCR stream abort errors to Cancelled", async () => {
    const create = vi.fn().mockRejectedValue(new Error("request was aborted"));
    const service = new OpenAiCompatibleLlmService(() => ({
      chat: {
        completions: {
          create
        }
      }
    }));

    await expect(
      service.extractTextFromImageStream("data:image/png;base64,abc", makeLlmConfig({ maxTokens: 256 }))
    ).rejects.toThrow("Cancelled");
  });

  it("keeps OCR error endpoints exact when baseUrl has no /v1", async () => {
    const create = vi.fn().mockRejectedValue(new Error("Connection error."));
    const service = new OpenAiCompatibleLlmService(() => ({
      chat: {
        completions: {
          create
        }
      }
    }));

    await expect(
      service.extractTextFromImage("data:image/png;base64,abc", makeLlmConfig({
        baseUrl: "https://example.com/openai",
        openaiCompatible: {
          baseUrl: "https://example.com/openai",
          apiKey: "k",
          model: "m",
          promptTemplate: "Extract",
          imageDetail: "low" as const,
          ocrStreamingEnabled: true,
          ocrStreamingFallbackToNonStream: true,
          maxTokens: 4096,
          thinkingMode: "off" as const
        }
      }))
    ).rejects.toThrow("OCR request failed (https://example.com/openai/chat/completions): Connection error.");
  });
});

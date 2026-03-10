import { describe, expect, it, vi } from "vitest";
import { OpenAiCompatibleLlmService, OpenAiCompatibleTtsService } from "../core/services/openai-compatible-client";

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

    const result = await service.extractTextFromImage("data:image/png;base64,abc", {
      baseUrl: "https://example.com/v1",
      apiKey: "k",
      model: "m",
      promptTemplate: "Extract",
      imageDetail: "low",
      ocrStreamingEnabled: true,
      ocrStreamingFallbackToNonStream: true,
      maxTokens: 4096
    });

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

    const result = await service.synthesize("text", {
      baseUrl: "https://example.com/v1",
      apiKey: "k",
      model: "tts-model",
      voice: "alloy",
      format: "mp3",
      speed: 1
    });

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
      service.extractTextFromImageStream("data:image/png;base64,abc", {
        baseUrl: "https://example.com/v1",
        apiKey: "k",
        model: "m",
        promptTemplate: "Extract",
        maxTokens: 256,
        imageDetail: "low",
        ocrStreamingEnabled: true,
        ocrStreamingFallbackToNonStream: true
      })
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
      service.extractTextFromImage("data:image/png;base64,abc", {
        baseUrl: "https://example.com/openai",
        apiKey: "k",
        model: "m",
        promptTemplate: "Extract",
        imageDetail: "low",
        ocrStreamingEnabled: true,
        ocrStreamingFallbackToNonStream: true,
        maxTokens: 4096
      })
    ).rejects.toThrow("OCR request failed (https://example.com/openai/chat/completions): Connection error.");
  });
});

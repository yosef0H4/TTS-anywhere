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
      promptTemplate: "Extract"
    });

    expect(create).toHaveBeenCalledOnce();
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
});

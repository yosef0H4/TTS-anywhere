import type { AppConfig, ReadingTimeline } from "../models/types";
import { buildReadingTimeline } from "../utils/chunking";
import { OpenAiCompatibleLlmService, OpenAiCompatibleTtsService } from "../services/openai-compatible-client";

export interface PipelineResult {
  text: string;
  timeline: ReadingTimeline;
}

export class AppPipeline {
  constructor(
    private readonly llm = new OpenAiCompatibleLlmService(),
    private readonly tts = new OpenAiCompatibleTtsService()
  ) {}

  async run(imageDataUrl: string, config: AppConfig): Promise<PipelineResult> {
    const ocr = await this.llm.extractTextFromImage(imageDataUrl, config.llm);
    const timeline = buildReadingTimeline(
      ocr.text,
      config.reading.minWordsPerChunk,
      config.reading.maxWordsPerChunk,
      config.reading.wpmBase
    );
    return { text: ocr.text, timeline };
  }

  async synthesizeText(text: string, config: AppConfig, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<Blob> {
    const tts = await this.tts.synthesize(text, config.tts, options);
    return tts.audioBlob;
  }
}

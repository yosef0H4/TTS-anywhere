import type { AppConfig, ReadingTimeline } from "../models/types";
import { loggers } from "../logging";
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
    const done = loggers.pipeline.time("pipeline.ocr.chunking");
    const ocr = await this.llm.extractTextFromImage(imageDataUrl, config.llm);
    const timeline = buildReadingTimeline(
      ocr.text,
      config.reading.minWordsPerChunk,
      config.reading.maxWordsPerChunk,
      config.reading.wpmBase
    );
    done();
    loggers.pipeline.info("Pipeline run result", { chunkCount: timeline.chunks.length, textLength: ocr.text.length });
    return { text: ocr.text, timeline };
  }

  async synthesizeText(text: string, config: AppConfig, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<Blob> {
    loggers.tts.debug("Synthesize text called", { textLength: text.length, model: config.tts.model });
    const tts = await this.tts.synthesize(text, config.tts, options);
    return tts.audioBlob;
  }
}

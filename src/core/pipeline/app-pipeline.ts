import type { AppConfig, ReadingTimeline } from "../models/types";
import { buildReadingTimeline } from "../utils/chunking";
import { OpenAiCompatibleLlmService, OpenAiCompatibleTtsService } from "../services/openai-compatible-client";

export interface PipelineResult {
  text: string;
  timeline: ReadingTimeline;
  audioBlob: Blob;
}

export class AppPipeline {
  constructor(
    private readonly llm = new OpenAiCompatibleLlmService(),
    private readonly tts = new OpenAiCompatibleTtsService()
  ) {}

  async run(imageDataUrl: string, config: AppConfig): Promise<PipelineResult> {
    const ocr = await this.llm.extractTextFromImage(imageDataUrl, config.llm);
    const timeline = buildReadingTimeline(ocr.text, config.reading.chunkSize, config.reading.wpmBase);
    const tts = await this.tts.synthesize(ocr.text, config.tts);
    return { text: ocr.text, timeline, audioBlob: tts.audioBlob };
  }
}

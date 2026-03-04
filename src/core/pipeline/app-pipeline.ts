import type { AppConfig, ReadingTimeline } from "../models/types";
import { loggers } from "../logging";
import { buildReadingTimeline } from "../utils/chunking";
import { dataUrlToBlob } from "../utils/data-url";
import { OpenAiCompatibleLlmService, OpenAiCompatibleTtsService } from "../services/openai-compatible-client";

export interface PipelineResult {
  text: string;
  timeline: ReadingTimeline;
}

export interface OcrRegion {
  id: string;
  nx: number;
  ny: number;
  nw: number;
  nh: number;
}

export class AppPipeline {
  constructor(
    private readonly llm = new OpenAiCompatibleLlmService(),
    private readonly tts = new OpenAiCompatibleTtsService()
  ) {}

  async run(imageDataUrl: string, config: AppConfig, options?: { regions?: OcrRegion[] }): Promise<PipelineResult> {
    const done = loggers.pipeline.time("pipeline.ocr.chunking");
    const text = await this.extractText(imageDataUrl, config, options?.regions ?? []);
    const timeline = buildReadingTimeline(
      text,
      config.reading.minWordsPerChunk,
      config.reading.maxWordsPerChunk,
      config.reading.wpmBase
    );
    done();
    loggers.pipeline.info("Pipeline run result", { chunkCount: timeline.chunks.length, textLength: text.length });
    return { text, timeline };
  }

  async synthesizeText(text: string, config: AppConfig, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<Blob> {
    loggers.tts.debug("Synthesize text called", { textLength: text.length, model: config.tts.model });
    const tts = await this.tts.synthesize(text, config.tts, options);
    return tts.audioBlob;
  }

  private async extractText(imageDataUrl: string, config: AppConfig, regions: OcrRegion[]): Promise<string> {
    if (!regions.length) {
      const ocr = await this.llm.extractTextFromImage(imageDataUrl, config.llm);
      return ocr.text;
    }
    const parts: string[] = [];
    for (const region of regions) {
      try {
        const cropped = await this.cropDataUrl(imageDataUrl, region);
        const ocr = await this.llm.extractTextFromImage(cropped, config.llm);
        if (ocr.text.trim()) parts.push(ocr.text.trim());
      } catch (error) {
        loggers.pipeline.warn("Per-box OCR failed", { regionId: region.id, error: String(error) });
      }
    }
    if (!parts.length) {
      const ocr = await this.llm.extractTextFromImage(imageDataUrl, config.llm);
      return ocr.text;
    }
    return parts.join("\n");
  }

  private async cropDataUrl(dataUrl: string, region: OcrRegion): Promise<string> {
    const blob = dataUrlToBlob(dataUrl);
    const bitmap = await createImageBitmap(blob);
    const x = Math.max(0, Math.floor(region.nx * bitmap.width));
    const y = Math.max(0, Math.floor(region.ny * bitmap.height));
    const w = Math.max(1, Math.floor(region.nw * bitmap.width));
    const h = Math.max(1, Math.floor(region.nh * bitmap.height));
    const cw = Math.min(w, Math.max(1, bitmap.width - x));
    const ch = Math.min(h, Math.max(1, bitmap.height - y));
    const canvas = document.createElement("canvas");
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bitmap.close();
      throw new Error("Canvas context unavailable");
    }
    ctx.drawImage(bitmap, x, y, cw, ch, 0, 0, cw, ch);
    bitmap.close();
    return canvas.toDataURL("image/png");
  }
}

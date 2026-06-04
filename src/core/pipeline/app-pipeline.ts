import type { AppConfig } from "../models/types";
import { loggers } from "../logging";
import { OpenAiCompatibleLlmService, OpenAiCompatibleTtsService } from "../services/openai-compatible-client";
import { cropNormalizedDataUrl } from "../utils/image-data";

export interface PipelineResult {
  text: string;
}

export interface OcrRegion {
  id: string;
  nx: number;
  ny: number;
  nw: number;
  nh: number;
}

interface LlmServiceLike {
  extractTextFromImage: (
    dataUrl: string,
    config: AppConfig["llm"],
    options?: { signal?: AbortSignal }
  ) => Promise<{ text: string }>;
  extractTextFromImageStream: (
    dataUrl: string,
    config: AppConfig["llm"],
    options?: { signal?: AbortSignal; onToken?: (token: string) => void }
  ) => Promise<{ text: string }>;
}

interface TtsServiceLike {
  synthesize: (
    text: string,
    config: AppConfig["tts"],
    options?: { signal?: AbortSignal; timeoutMs?: number }
  ) => Promise<{ audioBlob: Blob }>;
}

interface StreamOcrOptions {
  signal?: AbortSignal;
  onToken: (token: string) => void;
  onOcrRequestStart?: () => void;
  onOcrRequestEnd?: () => void;
}

export class AppPipeline {
  constructor(
    private readonly llm: LlmServiceLike = new OpenAiCompatibleLlmService(),
    private readonly tts: TtsServiceLike = new OpenAiCompatibleTtsService()
  ) {}

  async run(
    imageDataUrl: string,
    config: AppConfig,
    options?: { regions?: OcrRegion[]; signal?: AbortSignal }
  ): Promise<PipelineResult> {
    const done = loggers.pipeline.time("pipeline.ocr.chunking");
    const text = await this.extractText(imageDataUrl, config, options?.regions ?? [], options?.signal);
    done();
    loggers.pipeline.info("Pipeline run result", { textLength: text.length });
    return { text };
  }

  async streamOcrText(
    imageDataUrl: string,
    config: AppConfig,
    options: {
      regions?: OcrRegion[];
      signal?: AbortSignal;
      onToken: (token: string) => void;
      onRegionStart?: (index: number, total: number) => void;
      onOcrRequestStart?: () => void;
      onOcrRequestEnd?: () => void;
    }
  ): Promise<PipelineResult> {
    const regions = options.regions ?? [];
    const done = loggers.pipeline.time("pipeline.ocr.stream.chunking");
    let text = "";

    if (!regions.length) {
      text = await this.streamOcrRequest(imageDataUrl, config, options, (token) => {
        text += token;
      });
    } else {
      const parts: string[] = [];
      for (let i = 0; i < regions.length; i += 1) {
        const region = regions[i];
        if (!region) continue;
        this.throwIfAborted(options.signal);
        options.onRegionStart?.(i, regions.length);
        try {
          if (i > 0) {
            text += "\n";
            options.onToken("\n");
          }
          const cropped = await this.cropDataUrl(imageDataUrl, region);
          this.throwIfAborted(options.signal);
          const startLen = text.length;
          const streamedText = await this.streamOcrRequest(cropped, config, options, (token) => {
            text += token;
          });
          if (streamedText.trim()) {
            parts.push(streamedText.trim());
          } else {
            // Revert separator if this region produced no text.
            text = text.slice(0, startLen);
          }
        } catch (error) {
          if (this.isAbortError(error)) throw error;
          loggers.pipeline.warn("Per-box OCR stream failed", { regionId: region.id, error: String(error) });
        }
      }
      if (!parts.length) {
        text = "";
        text = await this.streamOcrRequest(imageDataUrl, config, options, (token) => {
          text += token;
        });
      }
    }

    done();
    loggers.pipeline.info("Pipeline OCR stream result", { textLength: text.length });
    return { text };
  }

  async synthesizeText(text: string, config: AppConfig, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<Blob> {
    loggers.tts.debug("Synthesize text called", { textLength: text.length, model: config.tts.model });
    const tts = await this.tts.synthesize(text, config.tts, options);
    return tts.audioBlob;
  }

  private async extractText(
    imageDataUrl: string,
    config: AppConfig,
    regions: OcrRegion[],
    signal?: AbortSignal
  ): Promise<string> {
    this.throwIfAborted(signal);
    if (!regions.length) {
      const ocr = await this.llm.extractTextFromImage(imageDataUrl, config.llm, signal ? { signal } : undefined);
      return ocr.text;
    }
    const parts: string[] = [];
    for (const region of regions) {
      this.throwIfAborted(signal);
      try {
        const cropped = await this.cropDataUrl(imageDataUrl, region);
        this.throwIfAborted(signal);
        const ocr = await this.llm.extractTextFromImage(cropped, config.llm, signal ? { signal } : undefined);
        if (ocr.text.trim()) parts.push(ocr.text.trim());
      } catch (error) {
        if (this.isAbortError(error)) {
          throw error;
        }
        loggers.pipeline.warn("Per-box OCR failed", { regionId: region.id, error: String(error) });
      }
    }
    if (!parts.length) {
      this.throwIfAborted(signal);
      const ocr = await this.llm.extractTextFromImage(imageDataUrl, config.llm, signal ? { signal } : undefined);
      return ocr.text;
    }
    return parts.join("\n");
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw new Error("Cancelled");
    }
  }

  private isAbortError(error: unknown): boolean {
    const text = String((error as { message?: unknown })?.message ?? error).toLowerCase();
    return text.includes("abort") || text.includes("cancel");
  }

  private async streamOcrRequest(
    imageDataUrl: string,
    config: AppConfig,
    options: StreamOcrOptions,
    onTextToken: (token: string) => void
  ): Promise<string> {
    options.onOcrRequestStart?.();
    const streamed = await this.llm.extractTextFromImageStream(
      imageDataUrl,
      config.llm,
      {
        ...(options.signal ? { signal: options.signal } : {}),
        onToken: (token) => {
          onTextToken(token);
          options.onToken(token);
        }
      }
    ).finally(() => {
      options.onOcrRequestEnd?.();
    });
    return streamed.text;
  }

  private async cropDataUrl(dataUrl: string, region: OcrRegion): Promise<string> {
    return cropNormalizedDataUrl(dataUrl, region);
  }
}

import type { OcrResult, TtsAudioResult } from "../core/models/types";
import type {
  ElectronApi,
  ProviderLlmConfig,
  ProviderModelsRequest,
  ProviderOcrRequest,
  ProviderOcrStreamEvent,
  ProviderOption,
  ProviderTextResult,
  ProviderTtsConfig,
  ProviderTtsRequest,
  ProviderVoicesRequest
} from "../core/services/platform";

function createRequestId(prefix: string): string {
  return `${prefix}:${globalThis.crypto.randomUUID()}`;
}

function bindAbort(
  api: ElectronApi,
  requestId: string,
  signal?: AbortSignal
): (() => void) | undefined {
  if (!signal) return undefined;
  const onAbort = (): void => {
    void api.cancelProviderRequest(requestId);
  };
  if (signal.aborted) {
    onAbort();
    return undefined;
  }
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

function asCancelled(error: unknown): Error {
  const message = String((error as { message?: unknown })?.message ?? error);
  const normalized = message.toLowerCase();
  if (normalized.includes("abort") || normalized.includes("cancel")) {
    return new Error("Cancelled");
  }
  return new Error(message);
}

export class ElectronBackedLlmService {
  constructor(private readonly api: ElectronApi) {}

  async extractTextFromImage(
    dataUrl: string,
    config: ProviderLlmConfig,
    options?: { signal?: AbortSignal }
  ): Promise<OcrResult> {
    const requestId = createRequestId("ocr");
    const cleanupAbort = bindAbort(this.api, requestId, options?.signal);
    const request: ProviderOcrRequest = { requestId, imageDataUrl: dataUrl, config };
    try {
      if (options?.signal?.aborted) {
        throw new Error("Cancelled");
      }
      return await this.api.extractProviderText(request);
    } catch (error) {
      throw asCancelled(error);
    } finally {
      cleanupAbort?.();
    }
  }

  async extractTextFromImageStream(
    dataUrl: string,
    config: ProviderLlmConfig,
    options?: { signal?: AbortSignal; onToken?: (token: string) => void }
  ): Promise<ProviderTextResult> {
    const requestId = createRequestId("ocr-stream");
    const cleanupAbort = bindAbort(this.api, requestId, options?.signal);
    const unsubscribe = this.api.onProviderOcrStreamEvent((event: ProviderOcrStreamEvent) => {
      if (event.requestId !== requestId || event.type !== "token" || typeof event.token !== "string") {
        return;
      }
      options?.onToken?.(event.token);
    });
    const request: ProviderOcrRequest = { requestId, imageDataUrl: dataUrl, config };
    try {
      if (options?.signal?.aborted) {
        throw new Error("Cancelled");
      }
      return await this.api.startProviderOcrStream(request);
    } catch (error) {
      throw asCancelled(error);
    } finally {
      unsubscribe();
      cleanupAbort?.();
    }
  }
}

export class ElectronBackedTtsService {
  constructor(private readonly api: ElectronApi) {}

  async synthesize(
    text: string,
    config: ProviderTtsConfig,
    options?: { signal?: AbortSignal; timeoutMs?: number }
  ): Promise<TtsAudioResult> {
    const requestId = createRequestId("tts");
    const cleanupAbort = bindAbort(this.api, requestId, options?.signal);
    const request: ProviderTtsRequest = options?.timeoutMs === undefined
      ? { requestId, text, config }
      : { requestId, text, config, timeoutMs: options.timeoutMs };
    try {
      if (options?.signal?.aborted) {
        throw new Error("Cancelled");
      }
      const result = await this.api.synthesizeProviderText(request);
      const copiedBytes = new Uint8Array(result.audioBytes.byteLength);
      copiedBytes.set(result.audioBytes);
      return { audioBlob: new Blob([copiedBytes.buffer], { type: result.mimeType }) };
    } catch (error) {
      throw asCancelled(error);
    } finally {
      cleanupAbort?.();
    }
  }
}

export class ElectronBackedProviderCatalog {
  constructor(private readonly api: ElectronApi) {}

  fetchModels(request: ProviderModelsRequest): Promise<ProviderOption[]> {
    return this.api.fetchProviderModels(request);
  }

  fetchVoices(request: ProviderVoicesRequest): Promise<ProviderOption[]> {
    return this.api.fetchProviderVoices(request);
  }
}

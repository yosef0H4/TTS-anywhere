export interface ProviderLlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  promptTemplate: string;
  imageDetail: "low" | "high";
  ocrStreamingEnabled: boolean;
  ocrStreamingFallbackToNonStream: boolean;
  maxTokens: number;
}

export interface ProviderTtsConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  voice: string;
  format: "mp3" | "wav" | "opus";
  speed: number;
}

export interface ProviderOption {
  value: string;
  label: string;
}

export interface ProviderOcrRequest {
  requestId: string;
  imageDataUrl: string;
  config: ProviderLlmConfig;
}

export interface ProviderTtsRequest {
  requestId: string;
  text: string;
  config: ProviderTtsConfig;
  timeoutMs?: number;
}

export interface ProviderModelsRequest {
  baseUrl: string;
  apiKey: string;
}

export interface ProviderVoicesRequest extends ProviderModelsRequest {
  model?: string;
}

export interface ProviderTextResult {
  text: string;
}

export interface ProviderAudioResult {
  audioBytes: Uint8Array;
  mimeType: string;
}

export interface ProviderOcrStreamEvent {
  requestId: string;
  type: "token" | "done" | "error";
  token?: string;
  text?: string;
  error?: string;
}

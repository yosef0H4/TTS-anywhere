export type ProviderKind = "openai_compatible" | "gemini_sdk";

export interface ProviderLlmConfig {
  baseUrl?: string;
  apiKey: string;
  model: string;
  promptTemplate: string;
  imageDetail: "low" | "high";
  ocrStreamingEnabled: boolean;
  ocrStreamingFallbackToNonStream: boolean;
  maxTokens: number;
  thinkingMode?: "provider_default" | "low" | "off";
}

export interface ProviderTtsConfig {
  baseUrl?: string;
  apiKey: string;
  model: string;
  voice: string;
  format: "mp3" | "wav" | "opus";
  speed: number;
  thinkingMode?: "provider_default" | "low" | "off";
}

export interface ProviderOption {
  value: string;
  label: string;
}

export interface ProviderOcrRequest {
  requestId: string;
  provider: ProviderKind;
  imageDataUrl: string;
  config: ProviderLlmConfig;
}

export interface ProviderTtsRequest {
  requestId: string;
  provider: ProviderKind;
  text: string;
  config: ProviderTtsConfig;
  timeoutMs?: number;
}

export interface ProviderModelsRequest {
  provider: ProviderKind;
  kind: "ocr" | "tts";
  baseUrl?: string;
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

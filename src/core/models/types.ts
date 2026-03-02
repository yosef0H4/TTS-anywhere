export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  promptTemplate: string;
}

export interface TtsConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  voice: string;
  format: "mp3" | "wav" | "opus";
  speed: number;
}

export interface ReadingConfig {
  minWordsPerChunk: number;
  maxWordsPerChunk: number;
  wpmBase: number;
  punctuationPauseMode: "off" | "low" | "medium" | "high";
  streamWindowSize: number;
  chunkRequestConcurrency: number;
  chunkRetryCount: number;
  chunkTimeoutMs: number;
  largeEditResetRatio: number;
  failureCooldownMs: number;
  sessionChunkCacheLimit: number;
  sessionAudioByteLimit: number;
}

export interface UiConfig {
  volume: number;
  playbackRate: number;
  theme: "zen" | "pink";
  settingsDrawerOpen: boolean;
  showChunkDiagnostics: boolean;
}

export interface SystemConfig {
  diagnosticsEnabled: boolean;
  lastImportAt: string;
}

export interface AppConfig {
  llm: LlmConfig;
  tts: TtsConfig;
  reading: ReadingConfig;
  ui: UiConfig;
  system: SystemConfig;
}

export interface Chunk {
  index: number;
  text: string;
  startMs: number;
  endMs: number;
}

export interface ReadingTimeline {
  chunks: Chunk[];
  durationMs: number;
}

export interface OcrResult {
  text: string;
}

export interface TtsAudioResult {
  audioBlob: Blob;
}

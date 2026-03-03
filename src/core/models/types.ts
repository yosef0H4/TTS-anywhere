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
  cleanTextBeforeTts: boolean;
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
  panels: PanelConfig;
  volume: number;
  playbackRate: number;
  theme: "zen" | "pink";
  settingsDrawerOpen: boolean;
  showChunkDiagnostics: boolean;
}

export interface PanelConfig {
  desktop: DesktopPanelConfig;
  mobile: MobilePanelConfig;
}

export interface DesktopPanelConfig {
  leftPanePercent: number;
  rightTopPercent: number;
}

export interface MobilePanelConfig {
  imageHeightPercent: number;
  editorHeightPercent: number;
  previewHeightPercent: number;
  collapsed: {
    image: boolean;
    editor: boolean;
    preview: boolean;
  };
}

export interface LoggingConfig {
  level: "debug" | "info" | "warn" | "error";
  enableFileLogging: boolean;
  enableConsoleLogging: boolean;
}

export interface SystemConfig {
  diagnosticsEnabled: boolean;
  lastImportAt: string;
  captureHotkey: string;
}

export interface AppConfig {
  llm: LlmConfig;
  tts: TtsConfig;
  reading: ReadingConfig;
  ui: UiConfig;
  system: SystemConfig;
  logging: LoggingConfig;
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

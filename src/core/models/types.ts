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
  chunkSize: number;
  wpmBase: number;
}

export interface AppConfig {
  llm: LlmConfig;
  tts: TtsConfig;
  reading: ReadingConfig;
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

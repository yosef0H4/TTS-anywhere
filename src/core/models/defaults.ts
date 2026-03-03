import type { AppConfig } from "./types";

export const DEFAULT_CONFIG: AppConfig = {
  llm: {
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    model: "gpt-4.1-mini",
    promptTemplate: "Extract text exactly as shown."
  },
  tts: {
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    model: "gpt-4o-mini-tts",
    voice: "alloy",
    format: "mp3",
    speed: 1
  },
  reading: {
    cleanTextBeforeTts: false,
    minWordsPerChunk: 6,
    maxWordsPerChunk: 25,
    wpmBase: 180,
    punctuationPauseMode: "low",
    streamWindowSize: 3,
    chunkRequestConcurrency: 2,
    chunkRetryCount: 2,
    chunkTimeoutMs: 30000,
    largeEditResetRatio: 0.35,
    failureCooldownMs: 5000,
    sessionChunkCacheLimit: 300,
    sessionAudioByteLimit: 120000000
  },
  ui: {
    volume: 80,
    playbackRate: 1,
    theme: "zen",
    settingsDrawerOpen: false,
    showChunkDiagnostics: true
  },
  system: {
    diagnosticsEnabled: true,
    lastImportAt: ""
  }
};

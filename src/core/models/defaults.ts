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
    minWordsPerChunk: 3,
    maxWordsPerChunk: 8,
    wpmBase: 180,
    punctuationPauseMode: "low",
    streamWindowSize: 3,
    chunkRequestConcurrency: 2,
    chunkRetryCount: 2,
    chunkTimeoutMs: 30000
  },
  ui: {
    volume: 80,
    playbackRate: 1,
    theme: "zen",
    settingsDensity: "comfortable",
    showAdvancedHints: true,
    settingsDrawerOpen: false
  },
  system: {
    diagnosticsEnabled: true,
    lastImportAt: ""
  }
};

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
    chunkSize: 6,
    wpmBase: 180
  },
  ui: {
    volume: 80,
    playbackRate: 1,
    theme: "zen"
  }
};

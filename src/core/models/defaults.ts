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
    panels: {
      desktop: {
        leftPanePercent: 38,
        rightTopPercent: 55
      },
      mobile: {
        imageHeightPercent: 34,
        editorHeightPercent: 33,
        previewHeightPercent: 33,
        collapsed: {
          image: false,
          editor: false,
          preview: false
        }
      }
    },
    volume: 80,
    playbackRate: 1,
    theme: "zen",
    settingsDrawerOpen: false,
    showChunkDiagnostics: true
  },
  system: {
    diagnosticsEnabled: true,
    lastImportAt: "",
    captureHotkey: "ctrl+shift+alt+s",
    copyPlayHotkey: "ctrl+shift+alt+x",
    captureDrawRectangle: true
  },
  logging: {
    level: "info",
    enableFileLogging: true,
    enableConsoleLogging: true
  },
  textProcessing: {
    rapidEnabled: false,
    rapidBaseUrl: "http://127.0.0.1:8091"
  },
  preprocessing: {
    maxImageDimension: 1080,
    binaryThreshold: 0,
    contrast: 1,
    brightness: 0,
    dilation: 0,
    invert: false,
    detectionFilter: {
      minWidthRatio: 0,
      minHeightRatio: 0,
      medianHeightFraction: 0.45
    },
    merge: {
      mergeVerticalRatio: 0.07,
      mergeHorizontalRatio: 0.37,
      mergeWidthRatioThreshold: 0.75
    },
    sorting: {
      direction: "horizontal_ltr",
      groupTolerance: 0.5
    },
    selection: {
      baseState: true,
      ops: [],
      manualBoxes: []
    }
  }
};

import type { AppConfig } from "./types";
import { resolveUiLanguage } from "./locale";

export const DEFAULT_CONFIG: AppConfig = {
  llm: {
    provider: "gemini_sdk",
    baseUrl: "",
    apiKey: "",
    model: "models/gemini-2.5-flash-lite",
    promptTemplate: "Extract all text from this image. Return only the extracted text, no additional commentary.",
    imageDetail: "low",
    ocrStreamingEnabled: true,
    ocrStreamingFallbackToNonStream: true,
    maxTokens: 4096,
    thinkingMode: "off",
    openaiCompatible: {
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      apiKey: "",
      model: "models/gemini-2.5-flash-lite",
      promptTemplate: "Extract all text from this image. Return only the extracted text, no additional commentary.",
      imageDetail: "low",
      ocrStreamingEnabled: true,
      ocrStreamingFallbackToNonStream: true,
      maxTokens: 4096,
      thinkingMode: "off"
    },
    geminiSdk: {
      apiKey: "",
      model: "models/gemini-2.5-flash-lite",
      promptTemplate: "Extract all text from this image. Return only the extracted text, no additional commentary.",
      imageDetail: "low",
      ocrStreamingEnabled: true,
      ocrStreamingFallbackToNonStream: true,
      maxTokens: 4096,
      thinkingMode: "off"
    }
  },
  tts: {
    provider: "gemini_sdk",
    baseUrl: "",
    apiKey: "",
    model: "gemini-2.5-flash-preview-tts",
    voice: "Kore",
    format: "wav",
    speed: 1,
    thinkingMode: "off",
    openaiCompatible: {
      baseUrl: "https://api.openai.com/v1",
      apiKey: "",
      model: "gpt-4o-mini-tts",
      voice: "alloy",
      format: "mp3",
      speed: 1,
      thinkingMode: "off"
    },
    geminiSdk: {
      apiKey: "",
      model: "gemini-2.5-flash-preview-tts",
      voice: "Kore",
      format: "wav",
      speed: 1,
      thinkingMode: "off"
    }
  },
  reading: {
    cleanTextBeforeTts: false,
    typingIdleMs: 600,
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
    language: resolveUiLanguage(),
    theme: "zen",
    settingsDrawerOpen: false,
    showChunkDiagnostics: true
  },
  system: {
    diagnosticsEnabled: true,
    lastImportAt: "",
    captureHotkey: "ctrl+shift+alt+s",
    ocrClipboardHotkey: "ctrl+shift+alt+c",
    fullCaptureHotkey: "ctrl+shift+alt+a",
    activeWindowCaptureHotkey: "ctrl+shift+alt+w",
    copyPlayHotkey: "ctrl+shift+alt+x",
    abortHotkey: "ctrl+shift+alt+z",
    playPauseHotkey: "ctrl+shift+alt+space",
    nextChunkHotkey: "ctrl+shift+alt+right",
    previousChunkHotkey: "ctrl+shift+alt+left",
    volumeUpHotkey: "ctrl+shift+alt+up",
    volumeDownHotkey: "ctrl+shift+alt+down",
    replayCaptureHotkey: "ctrl+shift+alt+d",
    captureDrawRectangle: true
  },
  logging: {
    level: "info",
    enableFileLogging: true,
    enableConsoleLogging: true
  },
  textProcessing: {
    detectionMode: "fullscreen_and_window",
    detectorBaseUrl: "http://127.0.0.1:8091"
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

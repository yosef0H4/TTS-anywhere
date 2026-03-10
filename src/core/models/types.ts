export type OcrProvider = "openai_compatible" | "gemini_sdk";
export type TtsProvider = "openai_compatible" | "gemini_sdk";
export type ThinkingMode = "provider_default" | "low" | "off";
export type ConfigurableHotkeyKey =
  | "capture"
  | "ocrClipboard"
  | "fullCapture"
  | "activeWindowCapture"
  | "copyPlay"
  | "abort"
  | "playPause"
  | "nextChunk"
  | "previousChunk"
  | "volumeUp"
  | "volumeDown"
  | "replayCapture";
export type HotkeySoundId =
  | "capture_start_soft"
  | "clipboard_capture_soft"
  | "capture_full_chime"
  | "capture_window_focus"
  | "copy_play_confirm"
  | "abort_soft_thud"
  | "play_pause_toggle"
  | "seek_next_tick"
  | "seek_previous_tick"
  | "volume_up_rise"
  | "volume_down_fall"
  | "replay_capture_echo"
  | "error_double_buzz";
export type HotkeyFeedbackPhase = "start" | "success" | "error";

export interface HotkeySoundConfig {
  soundId: HotkeySoundId;
  volume: number;
}

export interface FeedbackSoundsConfig {
  byHotkey: Record<ConfigurableHotkeyKey, HotkeySoundConfig>;
  globalError: HotkeySoundConfig;
}

export interface HotkeyFeedbackEvent {
  hotkey: ConfigurableHotkeyKey;
  phase: HotkeyFeedbackPhase;
  message?: string;
}

export interface OpenAiCompatibleLlmSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
  promptTemplate: string;
  imageDetail: "low" | "high";
  ocrStreamingEnabled: boolean;
  ocrStreamingFallbackToNonStream: boolean;
  maxTokens: number;
  thinkingMode: ThinkingMode;
}

export interface GeminiSdkLlmSettings {
  apiKey: string;
  model: string;
  promptTemplate: string;
  imageDetail: "low" | "high";
  ocrStreamingEnabled: boolean;
  ocrStreamingFallbackToNonStream: boolean;
  maxTokens: number;
  thinkingMode: ThinkingMode;
}

export interface LlmConfig extends OpenAiCompatibleLlmSettings {
  provider: OcrProvider;
  openaiCompatible: OpenAiCompatibleLlmSettings;
  geminiSdk: GeminiSdkLlmSettings;
}

export interface OpenAiCompatibleTtsSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
  voice: string;
  format: "mp3" | "wav" | "opus";
  speed: number;
  thinkingMode: ThinkingMode;
}

export interface GeminiSdkTtsSettings {
  apiKey: string;
  model: string;
  voice: string;
  format: "mp3" | "wav" | "opus";
  speed: number;
  thinkingMode: ThinkingMode;
}

export interface TtsConfig extends OpenAiCompatibleTtsSettings {
  provider: TtsProvider;
  openaiCompatible: OpenAiCompatibleTtsSettings;
  geminiSdk: GeminiSdkTtsSettings;
}

export interface ReadingConfig {
  cleanTextBeforeTts: boolean;
  typingIdleMs: number;
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
  language: "en" | "ar";
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
  ocrClipboardHotkey: string;
  fullCaptureHotkey: string;
  activeWindowCaptureHotkey: string;
  copyPlayHotkey: string;
  abortHotkey: string;
  playPauseHotkey: string;
  nextChunkHotkey: string;
  previousChunkHotkey: string;
  volumeUpHotkey: string;
  volumeDownHotkey: string;
  replayCaptureHotkey: string;
  captureDrawRectangle: boolean;
  feedbackSounds: FeedbackSoundsConfig;
}

export interface TextProcessingConfig {
  detectionMode: "off" | "fullscreen_only" | "fullscreen_and_window" | "all";
  detectorBaseUrl: string;
}

export interface PreprocessingSelectionConfig {
  baseState: boolean;
  ops: Array<{ id: string; op: "add" | "sub"; nx: number; ny: number; nw: number; nh: number }>;
  manualBoxes: Array<{ id: string; nx: number; ny: number; nw: number; nh: number }>;
}

export interface PreprocessingConfig {
  maxImageDimension: number;
  binaryThreshold: number;
  contrast: number;
  brightness: number;
  dilation: number;
  invert: boolean;
  detectionFilter: {
    minWidthRatio: number;
    minHeightRatio: number;
    medianHeightFraction: number;
  };
  merge: {
    mergeVerticalRatio: number;
    mergeHorizontalRatio: number;
    mergeWidthRatioThreshold: number;
  };
  sorting: {
    direction: "horizontal_ltr" | "horizontal_rtl" | "vertical_ltr" | "vertical_rtl";
    groupTolerance: number;
  };
  selection: PreprocessingSelectionConfig;
}

export interface AppConfig {
  llm: LlmConfig;
  tts: TtsConfig;
  reading: ReadingConfig;
  ui: UiConfig;
  system: SystemConfig;
  logging: LoggingConfig;
  textProcessing: TextProcessingConfig;
  preprocessing: PreprocessingConfig;
}

export interface Chunk {
  id?: string;
  index: number;
  text: string;
  startChar: number;
  endChar: number;
  isCompleted?: boolean;
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

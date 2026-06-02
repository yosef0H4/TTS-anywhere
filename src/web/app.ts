import TomSelect from "tom-select";
import "tom-select/dist/css/tom-select.css";
import { createIcons } from "lucide";
import {
  addTransport,
  ConsoleTransport,
  initializeLogger,
  IpcTransport,
  loggers,
  removeTransport,
  setLogLevel
} from "../core/logging";
import { DEFAULT_CONFIG } from "../core/models/defaults";
import type {
  AppConfig,
  BaseUiTheme,
  ConfigurableHotkeyKey,
  HotkeyFeedbackEvent,
  HotkeySoundId,
  OcrProvider,
  ReadingTimeline,
  TtsProvider
} from "../core/models/types";
import {
  createChunkRecords,
  getPrefetchTargets,
  reconcileChunks,
  toReadingTimeline,
  type ChunkRecord,
  type ChunkStatus
} from "../core/playback/chunking";
import { canResumePlayback } from "../core/playback/session";
import { AppPipeline } from "../core/pipeline/app-pipeline";
import {
  LEGACY_SETTINGS_KEYS,
  MAX_PLAYBACK_RATE,
  MIN_PLAYBACK_RATE,
  sanitizePlaybackRate,
  SettingsStore,
  SETTINGS_KEY
} from "../core/services/settings-store";
import type {
  DiscoveredServiceCapability,
  DiscoveredServiceCatalogItem,
  DiscoveredServicePreset,
  DiscoveredServiceSlot,
  DiscoveredServiceRunStatus,
  DiscoveredServiceSelector,
  DiscoveredServicesSnapshot,
  ManagedServiceId,
  ManagedServiceStatus,
  ManagedServicesStatus,
  UiTheme
} from "../core/services/platform";
import { WorkspaceResizer } from "../ui/workspace-resizer";
import { cleanTextForTts, findChunkIndexByTime } from "../core/utils/chunking";
import { RequestPreemptor } from "../core/utils/request-preemptor";
import { APP_TEMPLATE } from "../ui/template";
import { PreprocessModalController, type DrawRect } from "../features/preprocessing";
import { applyPreprocessToDataUrl, normalizeImageDataUrl, scaleDataUrlMaxDimension } from "../features/preprocessing/image";
import { checkTextProcessingHealth, detectRawBoxes } from "../features/preprocessing/text-processing-client";
import { adjustBoxPadding, filterBySize, finalizeOcrBoxes, manualToRaw, mergeCloseBoxes, selectionKeepRatio, sortByReadingOrder } from "../features/preprocessing/logic";
import { PreprocPreviewRenderer } from "../features/preprocessing/preview-renderer";
import type { FilteredBox, MergeGroup, RawBox } from "../features/preprocessing/types";
import { APP_ICONS } from "../ui/lucide-icons";
import { makeOptionCacheKey, resolveVoiceSelection } from "./tts-option-utils";
import { ElectronBackedLlmService, ElectronBackedProviderCatalog, ElectronBackedTtsService } from "./electron-provider-client";
import { HOTKEY_SOUND_OPTIONS, HOTKEY_SOUND_URLS } from "./hotkey-sounds";
import { applyTranslationsToElement, translate, type TranslationKey } from "./i18n";
import "../ui/styles.css";

interface NamedOption {
  value: string;
  label: string;
}

const SERVICE_NONE_OPTION = "__none__";
const MAX_AUTO_READER_NO_TEXT_RETRY_COUNT = 1_000_000;

type RequestLane = "ocr" | "detect_main" | "detect_modal";

interface PlaybackMetrics {
  sessionStarts: number;
  playChunkRequests: number;
  ttsStartsBySessionAndHash: Record<string, number>;
}

type PlaybackHotkeyAction = "toggle_play_pause" | "next_chunk" | "previous_chunk" | "volume_up" | "volume_down";

interface HotkeyBindingConfig {
  systemKey:
    | "captureHotkey"
    | "ocrClipboardHotkey"
    | "fullCaptureHotkey"
    | "activeWindowCaptureHotkey"
    | "copyPlayHotkey"
    | "autoReaderHotkey"
    | "clipboardWatcherHotkey"
    | "abortHotkey"
    | "playPauseHotkey"
    | "nextChunkHotkey"
    | "previousChunkHotkey"
    | "volumeUpHotkey"
    | "volumeDownHotkey"
    | "replayCaptureHotkey";
  inputId: string;
  statusId: string;
  recordButtonId: string;
  clearButtonId: string;
  resetButtonId: string;
  applyButtonId: string;
  cancelButtonId: string;
  beginEdit: (() => Promise<string>) | undefined;
  apply: ((hotkey: string) => Promise<string>) | undefined;
  clear: (() => Promise<string>) | undefined;
  cancelEdit: (() => Promise<string>) | undefined;
}

type CaptureContext = {
  source: "hotkey" | "clipboard" | "upload" | "paste" | "drop" | "clipboard_watch";
  captureKind?: "selection" | "fullscreen" | "window";
  resultMode?: "editor" | "clipboard";
  automation?: { kind: "auto_reader"; runId: number; phase: "initial" | "replay" };
};

type E2eCaptureTextOptions = {
  autoReader?: boolean;
  startPlayback?: boolean;
  imageDataUrl?: string;
};

interface AutoReaderBufferedPage {
  text: string;
  imageDataUrl: string;
  regions: DrawRect[];
  detectedRawBoxes: RawBox[];
  filterResults: FilteredBox[];
  mergedGroups: MergeGroup[];
  filterStats: { widthRemoved: number; heightRemoved: number; medianRemoved: number; medianHeightPx: number };
  firstChunkId: string | null;
  readyReported: boolean;
}

const rendererBootAt = performance.now();
const ELECTRON_ONLY_ERROR = "Available in Electron only.";

class ElectronOnlyLlmService {
  async extractTextFromImage(): Promise<never> {
    throw new Error(ELECTRON_ONLY_ERROR);
  }

  async extractTextFromImageStream(): Promise<never> {
    throw new Error(ELECTRON_ONLY_ERROR);
  }
}

class ElectronOnlyTtsService {
  async synthesize(): Promise<never> {
    throw new Error(ELECTRON_ONLY_ERROR);
  }
}

function dismissBootScreen(): void {
  const boot = document.getElementById("boot-screen");
  if (!boot) return;
  boot.setAttribute("data-hidden", "true");
  window.setTimeout(() => boot.remove(), 220);
}

export class WebApp {
  private readonly store = new SettingsStore();
  private readonly pipeline = window.electronAPI
    ? new AppPipeline(
        new ElectronBackedLlmService(window.electronAPI),
        new ElectronBackedTtsService(window.electronAPI)
      )
    : new AppPipeline(new ElectronOnlyLlmService(), new ElectronOnlyTtsService());
  private readonly providerCatalog = window.electronAPI ? new ElectronBackedProviderCatalog(window.electronAPI) : null;
  private readonly config: AppConfig = this.store.load();
  private readonly audio = new Audio();
  private readonly activeHotkeyAudios = new Set<HTMLAudioElement>();
  private readonly lastHotkeyFeedbackAt: Partial<Record<ConfigurableHotkeyKey, number>> = {};
  private lastPlaybackText = "";
  private playbackDocumentGeneration = 0;
  private timeline: ReadingTimeline = { chunks: [], durationMs: 0 };
  private activeChunkId: string | null = null;
  private activeChunkIndex = 0;
  private speakingChunkId: string | null = null;
  private speakingRevision: number | null = null;
  private readonly optionCache = new Map<string, NamedOption[]>();
  private llmModelSelect: TomSelect | null = null;
  private ttsModelSelect: TomSelect | null = null;
  private ttsVoiceSelect: TomSelect | null = null;
  private detectServiceSelect: TomSelect | null = null;
  private ocrServiceSelect: TomSelect | null = null;
  private ttsServicePresetSelect: TomSelect | null = null;
  private settingsPeekOpen = false;
  private chunkPlaybackMode = false;
  private chunkPlaybackSession = 0;
  private readonly chunkInFlightById = new Map<string, Promise<string>>();
  private readonly chunkAbortControllersById = new Map<string, AbortController>();
  private workspaceResizer: WorkspaceResizer | null = null;
  private ipcTransport: IpcTransport | null = null;
  private consoleTransport: ConsoleTransport | null = null;
  private hotkeyRecordingState: Record<ConfigurableHotkeyKey, boolean> = {
    capture: false,
    ocrClipboard: false,
    fullCapture: false,
    activeWindowCapture: false,
    copyPlay: false,
    autoReader: false,
    clipboardWatcher: false,
    abort: false,
    playPause: false,
    nextChunk: false,
    previousChunk: false,
    volumeUp: false,
    volumeDown: false,
    replayCapture: false
  };
  private pendingHotkeys: Record<ConfigurableHotkeyKey, string | null> = {
    capture: null,
    ocrClipboard: null,
    fullCapture: null,
    activeWindowCapture: null,
    copyPlay: null,
    autoReader: null,
    clipboardWatcher: null,
    abort: null,
    playPause: null,
    nextChunk: null,
    previousChunk: null,
    volumeUp: null,
    volumeDown: null,
    replayCapture: null
  };
  private hotkeyKeydownHandlers: Record<ConfigurableHotkeyKey, ((event: KeyboardEvent) => void) | null> = {
    capture: null,
    ocrClipboard: null,
    fullCapture: null,
    activeWindowCapture: null,
    copyPlay: null,
    autoReader: null,
    clipboardWatcher: null,
    abort: null,
    playPause: null,
    nextChunk: null,
    previousChunk: null,
    volumeUp: null,
    volumeDown: null,
    replayCapture: null
  };
  private preprocessModal: PreprocessModalController | null = null;
  private mainPreviewRenderer: PreprocPreviewRenderer | null = null;
  private lastOriginalImageDataUrl: string | null = null;
  private currentOcrImageDataUrl: string | null = null;
  private currentOcrRegions: DrawRect[] = [];
  private currentDetectedRawBoxes: RawBox[] = [];
  private currentFilterResults: FilteredBox[] = [];
  private currentMergedGroups: MergeGroup[] = [];
  private currentFilterStats = { widthRemoved: 0, heightRemoved: 0, medianRemoved: 0, medianHeightPx: 0 };
  private activeRunId = 0;
  private activeRunAbortController: AbortController | null = null;
  private autoReaderSessionRunId: number | null = null;
  private e2eAutoReaderRunCounter = 0;
  private activeAutoReaderPage: AutoReaderBufferedPage | null = null;
  private prefetchedAutoReaderPage: AutoReaderBufferedPage | null = null;
  private autoReaderHasTranscript = false;
  private modalAbortController: AbortController | null = null;
  private runInProgress = false;
  private readonly requestPreemptor = new RequestPreemptor<RequestLane>();
  private ocrStreaming = false;
  private ocrStreamDone = false;
  private ocrStreamSession = 0;
  private activeOcrRequests = 0;
  private programmaticPauseActive = false;
  private programmaticPauseReason = "";
  private isUserTyping = false;
  private userTypingLastAt = 0;
  private userTypingIdleTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingFullDocumentReplace = false;
  private playbackStartInFlight = false;
  private playbackStartPromise: Promise<void> | null = null;
  private readonly playbackMetrics: PlaybackMetrics = {
    sessionStarts: 0,
    playChunkRequests: 0,
    ttsStartsBySessionAndHash: {}
  };
  private detectorHealthy = false;
  private managedServicesStatus: ManagedServicesStatus | null = null;
  private discoveredServices: DiscoveredServicesSnapshot | null = null;
  private discoveredServiceStatuses: DiscoveredServiceRunStatus[] = [];
  private serviceDashboardLoading = false;
  private serviceSlotAliases: Partial<Record<DiscoveredServiceSlot, DiscoveredServiceSlot>> = {};
  private serviceLogViews: Partial<Record<DiscoveredServiceSlot, boolean>> = {};
  private serviceStatusPollTimer: number | null = null;
  private lastRenderedActiveChunkId: string | null = null;
  private alwaysOnTopEnabled = false;
  private currentLanguage(): AppConfig["ui"]["language"] {
    return this.config.ui.language;
  }

  private t(key: TranslationKey, params?: Record<string, string | number>): string {
    return translate(this.currentLanguage(), key, params);
  }

  private currentOcrProvider(): OcrProvider {
    return this.config.llm.provider;
  }

  private currentTtsProvider(): TtsProvider {
    return this.config.tts.provider;
  }

  private saveActiveLlmToSelectedProvider(): void {
    if (this.currentOcrProvider() === "gemini_sdk") {
      this.config.llm.geminiSdk = {
        apiKey: this.config.llm.apiKey,
        model: this.config.llm.model,
        promptTemplate: this.config.llm.promptTemplate,
        imageDetail: this.config.llm.imageDetail,
        ocrStreamingEnabled: this.config.llm.ocrStreamingEnabled,
        ocrStreamingFallbackToNonStream: this.config.llm.ocrStreamingFallbackToNonStream,
        maxTokens: this.config.llm.maxTokens,
        thinkingMode: this.config.llm.thinkingMode
      };
      return;
    }
    this.config.llm.openaiCompatible = {
      baseUrl: this.config.llm.baseUrl,
      apiKey: this.config.llm.apiKey,
      model: this.config.llm.model,
      promptTemplate: this.config.llm.promptTemplate,
      imageDetail: this.config.llm.imageDetail,
      ocrStreamingEnabled: this.config.llm.ocrStreamingEnabled,
      ocrStreamingFallbackToNonStream: this.config.llm.ocrStreamingFallbackToNonStream,
      maxTokens: this.config.llm.maxTokens,
      thinkingMode: this.config.llm.thinkingMode
    };
  }

  private applySelectedLlmProviderSettings(): void {
    if (this.currentOcrProvider() === "gemini_sdk") {
      const settings = this.config.llm.geminiSdk;
      this.config.llm.baseUrl = "";
      this.config.llm.apiKey = settings.apiKey;
      this.config.llm.model = settings.model;
      this.config.llm.promptTemplate = settings.promptTemplate;
      this.config.llm.imageDetail = settings.imageDetail;
      this.config.llm.ocrStreamingEnabled = settings.ocrStreamingEnabled;
      this.config.llm.ocrStreamingFallbackToNonStream = settings.ocrStreamingFallbackToNonStream;
      this.config.llm.maxTokens = settings.maxTokens;
      this.config.llm.thinkingMode = settings.thinkingMode;
      return;
    }
    const settings = this.config.llm.openaiCompatible;
    this.config.llm.baseUrl = settings.baseUrl;
    this.config.llm.apiKey = settings.apiKey;
    this.config.llm.model = settings.model;
    this.config.llm.promptTemplate = settings.promptTemplate;
    this.config.llm.imageDetail = settings.imageDetail;
    this.config.llm.ocrStreamingEnabled = settings.ocrStreamingEnabled;
    this.config.llm.ocrStreamingFallbackToNonStream = settings.ocrStreamingFallbackToNonStream;
    this.config.llm.maxTokens = settings.maxTokens;
    this.config.llm.thinkingMode = settings.thinkingMode;
  }

  private saveActiveTtsToSelectedProvider(): void {
    if (this.currentTtsProvider() === "gemini_sdk") {
      this.config.tts.geminiSdk = {
        apiKey: this.config.tts.apiKey,
        model: this.config.tts.model,
        voice: this.config.tts.voice,
        format: this.config.tts.format,
        speed: this.config.tts.speed,
        thinkingMode: this.config.tts.thinkingMode
      };
      return;
    }
    this.config.tts.openaiCompatible = {
      baseUrl: this.config.tts.baseUrl,
      apiKey: this.config.tts.apiKey,
      model: this.config.tts.model,
      voice: this.config.tts.voice,
      format: this.config.tts.format,
      speed: this.config.tts.speed,
      thinkingMode: this.config.tts.thinkingMode
    };
  }

  private applySelectedTtsProviderSettings(): void {
    if (this.currentTtsProvider() === "gemini_sdk") {
      const settings = this.config.tts.geminiSdk;
      this.config.tts.baseUrl = "";
      this.config.tts.apiKey = settings.apiKey;
      this.config.tts.model = settings.model;
      this.config.tts.voice = settings.voice;
      this.config.tts.format = settings.format;
      this.config.tts.speed = settings.speed;
      this.config.tts.thinkingMode = settings.thinkingMode;
      return;
    }
    const settings = this.config.tts.openaiCompatible;
    this.config.tts.baseUrl = settings.baseUrl;
    this.config.tts.apiKey = settings.apiKey;
    this.config.tts.model = settings.model;
    this.config.tts.voice = settings.voice;
    this.config.tts.format = settings.format;
    this.config.tts.speed = settings.speed;
    this.config.tts.thinkingMode = settings.thinkingMode;
  }

  private renderProviderVisibility(): void {
    this.must<HTMLElement>("llm-url-group").hidden = this.currentOcrProvider() === "gemini_sdk";
    this.must<HTMLElement>("tts-url-group").hidden = this.currentTtsProvider() === "gemini_sdk";
  }

  private switchOcrProvider(provider: OcrProvider): void {
    this.syncLlmInputsToActiveConfig();
    this.saveActiveLlmToSelectedProvider();
    this.config.llm.provider = provider;
    this.applySelectedLlmProviderSettings();
    this.renderConfig();
    this.store.save(this.config);
  }

  private switchTtsProvider(provider: TtsProvider): void {
    this.syncTtsInputsToActiveConfig();
    this.saveActiveTtsToSelectedProvider();
    this.config.tts.provider = provider;
    this.applySelectedTtsProviderSettings();
    this.renderConfig();
    this.store.save(this.config);
  }

  private getHotkeyBindingConfig(key: ConfigurableHotkeyKey): HotkeyBindingConfig {
    const api = window.electronAPI;
    switch (key) {
      case "capture":
        return {
          systemKey: "captureHotkey",
          inputId: "capture-hotkey",
          statusId: "hotkey-recording-status",
          recordButtonId: "btn-hotkey-record",
          clearButtonId: "btn-hotkey-clear",
          resetButtonId: "btn-hotkey-reset",
          applyButtonId: "btn-hotkey-apply",
          cancelButtonId: "btn-hotkey-cancel",
          beginEdit: api?.beginCaptureHotkeyEdit,
          apply: api?.applyCaptureHotkey,
          clear: api?.clearCaptureHotkey,
          cancelEdit: api?.cancelCaptureHotkeyEdit
        };
      case "ocrClipboard":
        return {
          systemKey: "ocrClipboardHotkey",
          inputId: "ocr-clipboard-hotkey",
          statusId: "ocr-clipboard-hotkey-recording-status",
          recordButtonId: "btn-ocr-clipboard-hotkey-record",
          clearButtonId: "btn-ocr-clipboard-hotkey-clear",
          resetButtonId: "btn-ocr-clipboard-hotkey-reset",
          applyButtonId: "btn-ocr-clipboard-hotkey-apply",
          cancelButtonId: "btn-ocr-clipboard-hotkey-cancel",
          beginEdit: api?.beginOcrClipboardHotkeyEdit,
          apply: api?.applyOcrClipboardHotkey,
          clear: api?.clearOcrClipboardHotkey,
          cancelEdit: api?.cancelOcrClipboardHotkeyEdit
        };
      case "fullCapture":
        return {
          systemKey: "fullCaptureHotkey",
          inputId: "full-capture-hotkey",
          statusId: "full-capture-hotkey-recording-status",
          recordButtonId: "btn-full-capture-hotkey-record",
          clearButtonId: "btn-full-capture-hotkey-clear",
          resetButtonId: "btn-full-capture-hotkey-reset",
          applyButtonId: "btn-full-capture-hotkey-apply",
          cancelButtonId: "btn-full-capture-hotkey-cancel",
          beginEdit: api?.beginFullCaptureHotkeyEdit,
          apply: api?.applyFullCaptureHotkey,
          clear: api?.clearFullCaptureHotkey,
          cancelEdit: api?.cancelFullCaptureHotkeyEdit
        };
      case "activeWindowCapture":
        return {
          systemKey: "activeWindowCaptureHotkey",
          inputId: "active-window-capture-hotkey",
          statusId: "active-window-capture-hotkey-recording-status",
          recordButtonId: "btn-active-window-capture-hotkey-record",
          clearButtonId: "btn-active-window-capture-hotkey-clear",
          resetButtonId: "btn-active-window-capture-hotkey-reset",
          applyButtonId: "btn-active-window-capture-hotkey-apply",
          cancelButtonId: "btn-active-window-capture-hotkey-cancel",
          beginEdit: api?.beginActiveWindowCaptureHotkeyEdit,
          apply: api?.applyActiveWindowCaptureHotkey,
          clear: api?.clearActiveWindowCaptureHotkey,
          cancelEdit: api?.cancelActiveWindowCaptureHotkeyEdit
        };
      case "copyPlay":
        return {
          systemKey: "copyPlayHotkey",
          inputId: "copy-play-hotkey",
          statusId: "copy-hotkey-recording-status",
          recordButtonId: "btn-copy-hotkey-record",
          clearButtonId: "btn-copy-hotkey-clear",
          resetButtonId: "btn-copy-hotkey-reset",
          applyButtonId: "btn-copy-hotkey-apply",
          cancelButtonId: "btn-copy-hotkey-cancel",
          beginEdit: api?.beginCopyHotkeyEdit,
          apply: api?.applyCopyHotkey,
          clear: api?.clearCopyHotkey,
          cancelEdit: api?.cancelCopyHotkeyEdit
        };
      case "autoReader":
        return {
          systemKey: "autoReaderHotkey",
          inputId: "auto-reader-hotkey",
          statusId: "auto-reader-hotkey-recording-status",
          recordButtonId: "btn-auto-reader-hotkey-record",
          clearButtonId: "btn-auto-reader-hotkey-clear",
          resetButtonId: "btn-auto-reader-hotkey-reset",
          applyButtonId: "btn-auto-reader-hotkey-apply",
          cancelButtonId: "btn-auto-reader-hotkey-cancel",
          beginEdit: api?.beginAutoReaderHotkeyEdit,
          apply: api?.applyAutoReaderHotkey,
          clear: api?.clearAutoReaderHotkey,
          cancelEdit: api?.cancelAutoReaderHotkeyEdit
        };
      case "clipboardWatcher":
        return {
          systemKey: "clipboardWatcherHotkey",
          inputId: "clipboard-watcher-hotkey",
          statusId: "clipboard-watcher-hotkey-recording-status",
          recordButtonId: "btn-clipboard-watcher-hotkey-record",
          clearButtonId: "btn-clipboard-watcher-hotkey-clear",
          resetButtonId: "btn-clipboard-watcher-hotkey-reset",
          applyButtonId: "btn-clipboard-watcher-hotkey-apply",
          cancelButtonId: "btn-clipboard-watcher-hotkey-cancel",
          beginEdit: api?.beginClipboardWatcherHotkeyEdit,
          apply: api?.applyClipboardWatcherHotkey,
          clear: api?.clearClipboardWatcherHotkey,
          cancelEdit: api?.cancelClipboardWatcherHotkeyEdit
        };
      case "abort":
        return {
          systemKey: "abortHotkey",
          inputId: "abort-hotkey",
          statusId: "abort-hotkey-recording-status",
          recordButtonId: "btn-abort-hotkey-record",
          clearButtonId: "btn-abort-hotkey-clear",
          resetButtonId: "btn-abort-hotkey-reset",
          applyButtonId: "btn-abort-hotkey-apply",
          cancelButtonId: "btn-abort-hotkey-cancel",
          beginEdit: api?.beginAbortHotkeyEdit,
          apply: api?.applyAbortHotkey,
          clear: api?.clearAbortHotkey,
          cancelEdit: api?.cancelAbortHotkeyEdit
        };
      case "playPause":
        return {
          systemKey: "playPauseHotkey",
          inputId: "play-pause-hotkey",
          statusId: "play-pause-hotkey-recording-status",
          recordButtonId: "btn-play-pause-hotkey-record",
          clearButtonId: "btn-play-pause-hotkey-clear",
          resetButtonId: "btn-play-pause-hotkey-reset",
          applyButtonId: "btn-play-pause-hotkey-apply",
          cancelButtonId: "btn-play-pause-hotkey-cancel",
          beginEdit: api?.beginPlayPauseHotkeyEdit,
          apply: api?.applyPlayPauseHotkey,
          clear: api?.clearPlayPauseHotkey,
          cancelEdit: api?.cancelPlayPauseHotkeyEdit
        };
      case "nextChunk":
        return {
          systemKey: "nextChunkHotkey",
          inputId: "next-chunk-hotkey",
          statusId: "next-chunk-hotkey-recording-status",
          recordButtonId: "btn-next-chunk-hotkey-record",
          clearButtonId: "btn-next-chunk-hotkey-clear",
          resetButtonId: "btn-next-chunk-hotkey-reset",
          applyButtonId: "btn-next-chunk-hotkey-apply",
          cancelButtonId: "btn-next-chunk-hotkey-cancel",
          beginEdit: api?.beginNextChunkHotkeyEdit,
          apply: api?.applyNextChunkHotkey,
          clear: api?.clearNextChunkHotkey,
          cancelEdit: api?.cancelNextChunkHotkeyEdit
        };
      case "previousChunk":
        return {
          systemKey: "previousChunkHotkey",
          inputId: "previous-chunk-hotkey",
          statusId: "previous-chunk-hotkey-recording-status",
          recordButtonId: "btn-previous-chunk-hotkey-record",
          clearButtonId: "btn-previous-chunk-hotkey-clear",
          resetButtonId: "btn-previous-chunk-hotkey-reset",
          applyButtonId: "btn-previous-chunk-hotkey-apply",
          cancelButtonId: "btn-previous-chunk-hotkey-cancel",
          beginEdit: api?.beginPreviousChunkHotkeyEdit,
          apply: api?.applyPreviousChunkHotkey,
          clear: api?.clearPreviousChunkHotkey,
          cancelEdit: api?.cancelPreviousChunkHotkeyEdit
        };
      case "volumeUp":
        return {
          systemKey: "volumeUpHotkey",
          inputId: "volume-up-hotkey",
          statusId: "volume-up-hotkey-recording-status",
          recordButtonId: "btn-volume-up-hotkey-record",
          clearButtonId: "btn-volume-up-hotkey-clear",
          resetButtonId: "btn-volume-up-hotkey-reset",
          applyButtonId: "btn-volume-up-hotkey-apply",
          cancelButtonId: "btn-volume-up-hotkey-cancel",
          beginEdit: api?.beginVolumeUpHotkeyEdit,
          apply: api?.applyVolumeUpHotkey,
          clear: api?.clearVolumeUpHotkey,
          cancelEdit: api?.cancelVolumeUpHotkeyEdit
        };
      case "volumeDown":
        return {
          systemKey: "volumeDownHotkey",
          inputId: "volume-down-hotkey",
          statusId: "volume-down-hotkey-recording-status",
          recordButtonId: "btn-volume-down-hotkey-record",
          clearButtonId: "btn-volume-down-hotkey-clear",
          resetButtonId: "btn-volume-down-hotkey-reset",
          applyButtonId: "btn-volume-down-hotkey-apply",
          cancelButtonId: "btn-volume-down-hotkey-cancel",
          beginEdit: api?.beginVolumeDownHotkeyEdit,
          apply: api?.applyVolumeDownHotkey,
          clear: api?.clearVolumeDownHotkey,
          cancelEdit: api?.cancelVolumeDownHotkeyEdit
        };
      case "replayCapture":
        return {
          systemKey: "replayCaptureHotkey",
          inputId: "replay-capture-hotkey",
          statusId: "replay-capture-hotkey-recording-status",
          recordButtonId: "btn-replay-capture-hotkey-record",
          clearButtonId: "btn-replay-capture-hotkey-clear",
          resetButtonId: "btn-replay-capture-hotkey-reset",
          applyButtonId: "btn-replay-capture-hotkey-apply",
          cancelButtonId: "btn-replay-capture-hotkey-cancel",
          beginEdit: api?.beginReplayCaptureHotkeyEdit,
          apply: api?.applyReplayCaptureHotkey,
          clear: api?.clearReplayCaptureHotkey,
          cancelEdit: api?.cancelReplayCaptureHotkeyEdit
        };
    }
  }

  private getHotkeySoundSelectId(key: ConfigurableHotkeyKey): string {
    return `${key}-sound-id`;
  }

  private getHotkeySoundVolumeId(key: ConfigurableHotkeyKey): string {
    return `${key}-sound-volume`;
  }

  private getHotkeySoundVolumeValueId(key: ConfigurableHotkeyKey): string {
    return `${key}-sound-volume-value`;
  }

  private getHotkeySoundPreviewButtonId(key: ConfigurableHotkeyKey): string {
    return `btn-${key}-sound-preview`;
  }

  mount(root: HTMLElement): void {
    this.logBootstrapStep("mount.begin");
    this.initializeLogging();
    this.logBootstrapStep("logging.initialized");
    root.innerHTML = APP_TEMPLATE;
    this.logBootstrapStep("template.rendered");
    this.applyUiState();
    this.logBootstrapStep("ui.state.applied");
    this.renderIcons();
    this.logBootstrapStep("icons.rendered");
    this.bindModelSelectors();
    this.logBootstrapStep("model.selectors.bound");
    this.bindSettings();
    this.logBootstrapStep("settings.bound");
    this.bindCapture();
    this.logBootstrapStep("capture.bound");
    this.bindBreak();
    this.logBootstrapStep("break.bound");
    this.bindExit();
    this.logBootstrapStep("exit.bound");
    this.bindMainPreviewRenderer();
    this.logBootstrapStep("main.preview.bound");
    this.bindPreprocessModal();
    this.logBootstrapStep("preprocess.modal.bound");
    this.bindPlayback();
    this.logBootstrapStep("playback.bound");
    this.bindWorkspaceResizer();
    this.logBootstrapStep("workspace.resizer.bound");
    this.bindMobilePaneToggles();
    this.logBootstrapStep("mobile.toggles.bound");
    this.bindLoggingSettings();
    this.logBootstrapStep("logging.settings.bound");
    this.renderConfig();
    this.logBootstrapStep("config.rendered");
    void this.checkDetectorHealth(false);
    void this.refreshDiscoveredServicesDashboard();
    this.startServiceStatusPolling();
    void this.syncClipboardWatcherStateFromElectron();
    void this.syncAllElectronHotkeysFromSettings();
    void this.applyAutoReaderSettings();
    void this.syncElectronCaptureRectangleSetting();
    this.logBootstrapStep("electron.settings.sync.started");
    this.installE2eHooks();
    this.logBootstrapStep("e2e.hooks.installed");
    window.addEventListener("beforeunload", () => {
      this.stopServiceStatusPolling();
      this.logLifecycle("window.beforeunload");
    });
    window.addEventListener("unload", () => {
      this.stopServiceStatusPolling();
      this.logLifecycle("window.unload");
    });
    loggers.app.info("App mounted");
    this.logBootstrapStep("mount.end");
  }

  private installE2eHooks(): void {
    const host = window as unknown as {
      __e2e?: {
        getState: () => unknown;
        setRawText: (text: string) => void;
        dispatchEngine: (event: unknown) => void;
        startPlayback: () => Promise<void>;
        simulateCapturedText: (text: string, options?: E2eCaptureTextOptions) => Promise<unknown>;
        dispatchPlaybackHotkey: (action: PlaybackHotkeyAction) => Promise<unknown>;
        getReadingPreviewState: () => unknown;
        getRecentUiState: () => unknown;
        setTypingState: (typing: { userTyping?: boolean; ocrStreaming?: boolean; activeOcrRequests?: number }) => void;
        getPlaybackMetrics: () => PlaybackMetrics;
        clearPlaybackMetrics: () => void;
      };
    };
    host.__e2e = {
      getState: () => ({
        activeChunkIndex: this.activeChunkIndex,
        chunkCount: this.timeline.chunks.length,
        chunkPlaybackMode: this.chunkPlaybackMode,
        isTypingActive: this.isTypingActive(),
        ocrStreaming: this.ocrStreaming,
        ocrStreamDone: this.ocrStreamDone,
        activeOcrRequests: this.activeOcrRequests,
        chunks: this.timeline.chunks.map((c) => ({
          index: c.index,
          text: c.text,
          startChar: c.startChar,
          endChar: c.endChar,
          isCompleted: c.isCompleted ?? true
        }))
      }),
      setRawText: (text: string) => {
        const raw = this.must<HTMLTextAreaElement>("raw-text");
        raw.value = text;
        raw.dispatchEvent(new Event("input", { bubbles: true }));
      },
      dispatchEngine: (event: unknown) => {
        this.dispatchPlaybackEvent(event as { type: string; [key: string]: unknown });
      },
      startPlayback: async () => {
        await this.startOrResumePlayback();
      },
      simulateCapturedText: async (text, options = {}) => {
        return this.simulateCapturedTextForE2e(text, options);
      },
      dispatchPlaybackHotkey: async (action) => {
        await this.handlePlaybackHotkey(action);
        return this.getRecentUiStateForE2e();
      },
      getReadingPreviewState: () => this.getReadingPreviewStateForE2e(),
      getRecentUiState: () => this.getRecentUiStateForE2e(),
      setTypingState: (typing) => {
        if (typeof typing.userTyping === "boolean") {
          this.isUserTyping = typing.userTyping;
        }
        if (typeof typing.ocrStreaming === "boolean") {
          this.ocrStreaming = typing.ocrStreaming;
          if (!typing.ocrStreaming) {
            this.ocrStreamDone = true;
          }
        }
        if (typeof typing.activeOcrRequests === "number") {
          this.activeOcrRequests = Math.max(0, Math.floor(typing.activeOcrRequests));
        }
        this.renderReadingPreview();
      },
      getPlaybackMetrics: () => ({
        ...this.getPlaybackMetricsSnapshot()
      }),
      clearPlaybackMetrics: () => {
        this.playbackMetrics.sessionStarts = 0;
        this.playbackMetrics.playChunkRequests = 0;
        this.playbackMetrics.ttsStartsBySessionAndHash = {};
      }
    };
  }

  private getPlaybackMetricsSnapshot(): PlaybackMetrics {
    return {
      sessionStarts: this.playbackMetrics.sessionStarts,
      playChunkRequests: this.playbackMetrics.playChunkRequests,
      ttsStartsBySessionAndHash: { ...this.playbackMetrics.ttsStartsBySessionAndHash }
    };
  }

  private getReadingPreviewStateForE2e(): unknown {
    const spans = Array.from(this.must<HTMLDivElement>("reading-preview").querySelectorAll("span"));
    return {
      activeChunkIndex: this.activeChunkIndex,
      activeChunkId: this.activeChunkId,
      chunkPlaybackMode: this.chunkPlaybackMode,
      audioPaused: this.audio.paused,
      chunks: this.getChunkRecords().map((chunk, index) => {
        const span = spans[index];
        const classes = span ? Array.from(span.classList) : [];
        return {
          id: chunk.id,
          index: chunk.index,
          text: chunk.text,
          status: chunk.status,
          finalized: chunk.finalized,
          isActive: classes.includes("active-chunk"),
          classes
        };
      })
    };
  }

  private getRecentUiStateForE2e(): unknown {
    return {
      statusText: this.must<HTMLDivElement>("status-text").textContent,
      rawText: this.must<HTMLTextAreaElement>("raw-text").value,
      serviceChips: {
        detect: document.getElementById("service-detect-status-chip")?.textContent?.trim() ?? null,
        ocr: document.getElementById("service-ocr-status-chip")?.textContent?.trim() ?? null,
        tts: document.getElementById("service-tts-status-chip")?.textContent?.trim() ?? null
      },
      playback: this.getPlaybackMetricsSnapshot(),
      readingPreview: this.getReadingPreviewStateForE2e()
    };
  }

  private blankImageDataUrl(): string {
    return "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAALSURBVBhXY2AAAgAABQABqtXIUQAAAABJRU5ErkJggg==";
  }

  private async simulateCapturedTextForE2e(text: string, options: E2eCaptureTextOptions = {}): Promise<unknown> {
    const nextText = text.trim();
    if (!nextText) {
      throw new Error("simulateCapturedText requires non-empty text");
    }
    loggers.capture.info("E2E captured text simulated", {
      length: nextText.length,
      autoReader: Boolean(options.autoReader),
      startPlayback: options.startPlayback !== false
    });
    await this.abortVisionWork("new_image", options.autoReader ? { preserveAutoReaderSession: true, preservePlayback: true } : undefined);
    if (options.autoReader) {
      const runId = ++this.e2eAutoReaderRunCounter;
      this.autoReaderSessionRunId = runId;
      const page = this.snapshotAutoReaderBufferedPage(nextText, options.imageDataUrl ?? this.blankImageDataUrl(), []);
      this.updateAutoReaderTranscript(page);
      if (options.startPlayback === false) {
        this.activeAutoReaderPage = page;
        this.restoreAutoReaderBufferedPage(page, { restoreText: false });
        this.renderReadingPreview();
        return this.getRecentUiStateForE2e();
      }
      await this.startAutoReaderPage(page, runId);
      return this.getRecentUiStateForE2e();
    }
    this.setRawTextValuePreservingScroll(nextText);
    this.reconcileText(this.getPlaybackText(), { source: "llm", finalizeTail: true, treatAsNewDocument: true });
    this.renderReadingPreview();
    if (options.startPlayback !== false) {
      await this.startOrResumePlayback();
    }
    return this.getRecentUiStateForE2e();
  }

  private getChunkRecords(): ChunkRecord[] {
    return this.timeline.chunks as ChunkRecord[];
  }

  private getChunkById(chunkId: string | null | undefined): ChunkRecord | undefined {
    if (!chunkId) return undefined;
    return this.getChunkRecords().find((chunk) => chunk.id === chunkId);
  }

  private syncActiveChunkIndex(): void {
    const chunks = this.getChunkRecords();
    if (!chunks.length) {
      this.activeChunkId = null;
      this.activeChunkIndex = 0;
      return;
    }
    const active = this.getChunkById(this.activeChunkId) ?? chunks.find((chunk) => chunk.finalized) ?? chunks[0];
    this.activeChunkId = active?.id ?? null;
    this.activeChunkIndex = active?.index ?? 0;
  }

  private buildChunkOptions(finalizeTail = false): { minWordsPerChunk: number; maxWordsPerChunk: number; wpmBase: number; finalizeTail?: boolean } {
    return {
      minWordsPerChunk: this.config.reading.minWordsPerChunk,
      maxWordsPerChunk: this.config.reading.maxWordsPerChunk,
      wpmBase: this.config.reading.wpmBase,
      finalizeTail
    };
  }

  private replaceTimelineWithChunks(chunks: ChunkRecord[], activeChunkId?: string): void {
    this.timeline = toReadingTimeline(chunks);
    this.activeChunkId = activeChunkId ?? this.activeChunkId;
    this.syncActiveChunkIndex();
  }

  private reconcileText(nextText: string, options?: { finalizeTail?: boolean; source?: "user" | "llm"; treatAsNewDocument?: boolean }): void {
    const previousChunks = this.getChunkRecords();
    const previousText = this.lastPlaybackText;
    const treatAsNewDocument = this.shouldTreatAsNewDocument(previousText, nextText, options);
    if (treatAsNewDocument) {
      this.playbackDocumentGeneration += 1;
      this.abortPlaybackAndSynthesis();
      this.activeChunkId = null;
      this.activeChunkIndex = 0;
      this.speakingChunkId = null;
      this.speakingRevision = null;
    }
    const nextState = previousChunks.length === 0
      ? {
          chunks: createChunkRecords(nextText, this.buildChunkOptions(options?.finalizeTail)),
          activeChunkId: undefined,
          dirtyChunkIds: [] as string[]
        }
      : reconcileChunks({
          nextText,
          previousChunks,
          ...this.buildChunkOptions(options?.finalizeTail),
          ...(this.activeChunkId && !treatAsNewDocument ? { activeChunkId: this.activeChunkId } : {}),
          ...(this.speakingChunkId ? { speakingChunkId: this.speakingChunkId } : {}),
          ...(typeof this.speakingRevision === "number" ? { speakingRevision: this.speakingRevision } : {})
        });

    const nextChunks = nextState.chunks;
    const speakingChunk = this.getChunkById(this.speakingChunkId);
    const nextSpeakingChunk = nextChunks.find((chunk) => chunk.id === this.speakingChunkId);
    const speakingInvalidated = Boolean(
      speakingChunk &&
      (!nextSpeakingChunk || nextSpeakingChunk.revision !== speakingChunk.revision || nextSpeakingChunk.status === "stale")
    );

    this.cleanupRemovedChunks(previousChunks, nextChunks);
    this.cancelStaleInflight(previousChunks, nextChunks);
    this.replaceTimelineWithChunks(nextChunks, nextState.activeChunkId);
    this.lastPlaybackText = nextText;

    if (speakingInvalidated) {
      this.abortPlaybackAndSynthesis();
      this.setStatus(options?.source === "llm" ? this.t("status.textUpdatedByStream") : this.t("status.textUpdatedByEdit"));
    }

    this.renderReadingPreview();
    this.maybeStartPlaybackFromStream();

    if (previousText !== nextText && !speakingInvalidated && options?.source === "user") {
      this.setStatus(treatAsNewDocument ? this.t("status.textReplaced") : this.t("status.textUpdated"));
    }
  }

  private shouldTreatAsNewDocument(
    previousText: string,
    nextText: string,
    options?: { source?: "user" | "llm"; treatAsNewDocument?: boolean }
  ): boolean {
    if (options?.treatAsNewDocument) return true;
    const previousNormalized = this.normalizePlaybackText(previousText);
    const nextNormalized = this.normalizePlaybackText(nextText);
    if (!previousNormalized || !nextNormalized) {
      return false;
    }
    if (previousNormalized === nextNormalized) {
      return false;
    }

    if (options?.source === "user" && this.pendingFullDocumentReplace) {
      return true;
    }

    const commonPrefixLength = this.countCommonPrefix(previousNormalized, nextNormalized);
    const commonSuffixLength = this.countCommonSuffix(previousNormalized, nextNormalized, commonPrefixLength);
    const retainedRatio = (commonPrefixLength + commonSuffixLength) / Math.max(previousNormalized.length, nextNormalized.length);
    if (retainedRatio <= 0.1) {
      return true;
    }

    const overlapRatio = this.calculateWordOverlapRatio(previousNormalized, nextNormalized);
    return overlapRatio < 0.2;
  }

  private normalizePlaybackText(text: string): string {
    return text.replace(/\s+/g, " ").trim().toLowerCase();
  }

  private countCommonPrefix(left: string, right: string): number {
    const limit = Math.min(left.length, right.length);
    let index = 0;
    while (index < limit && left[index] === right[index]) {
      index += 1;
    }
    return index;
  }

  private countCommonSuffix(left: string, right: string, consumedPrefix: number): number {
    const limit = Math.min(left.length, right.length) - consumedPrefix;
    let index = 0;
    while (index < limit && left[left.length - 1 - index] === right[right.length - 1 - index]) {
      index += 1;
    }
    return index;
  }

  private calculateWordOverlapRatio(previousText: string, nextText: string): number {
    const previousWords = new Set(previousText.split(/\s+/).filter(Boolean));
    const nextWords = new Set(nextText.split(/\s+/).filter(Boolean));
    if (previousWords.size === 0 || nextWords.size === 0) {
      return 0;
    }
    let overlap = 0;
    for (const word of previousWords) {
      if (nextWords.has(word)) {
        overlap += 1;
      }
    }
    return overlap / Math.max(previousWords.size, nextWords.size);
  }

  private cleanupRemovedChunks(previousChunks: ChunkRecord[], nextChunks: ChunkRecord[]): void {
    const nextIds = new Set(nextChunks.map((chunk) => chunk.id));
    for (const chunk of previousChunks) {
      const nextChunk = nextChunks.find((candidate) => candidate.id === chunk.id);
      if ((!nextChunk || nextChunk.revision !== chunk.revision) && chunk.audioUrl?.startsWith("blob:")) {
        URL.revokeObjectURL(chunk.audioUrl);
      }
      if (!nextIds.has(chunk.id)) {
        const controller = this.chunkAbortControllersById.get(chunk.id);
        controller?.abort();
        this.chunkAbortControllersById.delete(chunk.id);
        this.chunkInFlightById.delete(chunk.id);
      }
    }
  }

  private cancelStaleInflight(previousChunks: ChunkRecord[], nextChunks: ChunkRecord[]): void {
    for (const previousChunk of previousChunks) {
      const nextChunk = nextChunks.find((candidate) => candidate.id === previousChunk.id);
      if (nextChunk && nextChunk.revision !== previousChunk.revision) {
        const controller = this.chunkAbortControllersById.get(previousChunk.id);
        controller?.abort();
        this.chunkAbortControllersById.delete(previousChunk.id);
        this.chunkInFlightById.delete(previousChunk.id);
      }
    }
  }

  private dispatchPlaybackEvent(event: { type: string; [key: string]: unknown }): void {
    const raw = this.must<HTMLTextAreaElement>("raw-text");
    switch (event.type) {
      case "STREAM_START":
        raw.value = "";
        this.lastPlaybackText = "";
        this.activeChunkId = null;
        this.replaceTimelineWithChunks([]);
        this.ocrStreaming = true;
        this.ocrStreamDone = false;
        this.renderReadingPreview();
        break;
      case "OCR_DELTA":
        if (typeof event.token === "string" && event.token.length > 0) {
          raw.value = `${raw.value}${event.token}`;
          this.reconcileText(this.getPlaybackText(), { source: "llm" });
        }
        break;
      case "STREAM_DONE":
        this.ocrStreaming = false;
        this.ocrStreamDone = true;
        this.reconcileText(this.getPlaybackText(), { finalizeTail: true, source: "llm" });
        break;
      case "TEXT_SYNC":
        if (typeof event.text === "string") {
          raw.value = event.text;
          this.reconcileText(this.getPlaybackText(), { source: event.source === "llm" ? "llm" : "user" });
        }
        break;
      case "RESET":
        raw.value = "";
        this.lastPlaybackText = "";
        this.activeChunkId = null;
        this.replaceTimelineWithChunks([]);
        this.renderReadingPreview();
        break;
      default:
        break;
    }
  }

  private initializeLogging(): void {
    const cfg = this.config.logging ?? DEFAULT_CONFIG.logging;
    initializeLogger({ source: "frontend", level: cfg.level });
    if (cfg.enableConsoleLogging) {
      this.consoleTransport = new ConsoleTransport();
      addTransport(this.consoleTransport);
    }
    if (cfg.enableFileLogging && window.electronAPI?.sendLogEntries) {
      this.ipcTransport = new IpcTransport();
      addTransport(this.ipcTransport);
    }
    setLogLevel(cfg.level);
  }

  private logBootstrapStep(step: string, context?: Record<string, unknown>): void {
    this.logLifecycle(`bootstrap.${step}`, context);
  }

  private logLifecycle(step: string, context?: Record<string, unknown>): void {
    loggers.app.info(step, {
      sinceRendererBootMs: Number((performance.now() - rendererBootAt).toFixed(2)),
      ...context
    });
  }

  private bindModelSelectors(): void {
    this.llmModelSelect = new TomSelect(this.must<HTMLSelectElement>("llm-model"), {
      create: true,
      persist: false,
      maxOptions: 500,
      placeholder: this.t("ocr.model")
    });

    this.ttsModelSelect = new TomSelect(this.must<HTMLSelectElement>("tts-model"), {
      create: true,
      persist: false,
      maxOptions: 500,
      placeholder: this.t("tts.model")
    });

    this.ttsVoiceSelect = new TomSelect(this.must<HTMLSelectElement>("tts-voice"), {
      create: true,
      persist: false,
      maxOptions: 500,
      placeholder: this.t("tts.voice")
    });

    this.detectServiceSelect = new TomSelect(this.must<HTMLSelectElement>("service-detect-select"), {
      create: false,
      persist: false,
      maxOptions: 500,
      placeholder: "Text Processing"
    });

    this.ocrServiceSelect = new TomSelect(this.must<HTMLSelectElement>("service-ocr-select"), {
      create: false,
      persist: false,
      maxOptions: 500,
      placeholder: "OCR"
    });

    this.ttsServicePresetSelect = new TomSelect(this.must<HTMLSelectElement>("service-tts-select"), {
      create: false,
      persist: false,
      maxOptions: 500,
      placeholder: "Text to Speech"
    });

    this.bindSelectorFetchBehavior(this.llmModelSelect, "llm-model", () => this.fetchLlmModels(false));
    this.bindSelectorFetchBehavior(this.ttsModelSelect, "tts-model", () => this.fetchTtsModels(false));
    this.bindSelectorFetchBehavior(this.ttsVoiceSelect, "tts-voice", () => this.fetchTtsVoices(false));
    this.updateTomSelectPlaceholders();

    this.must<HTMLButtonElement>("llm-refetch").addEventListener("click", () => {
      void this.fetchLlmModels(true);
    });
    this.must<HTMLButtonElement>("llm-prompt-reset").addEventListener("click", () => {
      this.must<HTMLInputElement>("llm-prompt").value = this.currentOcrProvider() === "gemini_sdk"
        ? DEFAULT_CONFIG.llm.geminiSdk.promptTemplate
        : DEFAULT_CONFIG.llm.openaiCompatible.promptTemplate;
      this.syncConfigFromInputs();
    });

    this.must<HTMLButtonElement>("tts-refetch").addEventListener("click", async () => {
      await this.fetchTtsModels(true);
      await this.fetchTtsVoices(true);
    });
    this.must<HTMLButtonElement>("tts-voice-refetch").addEventListener("click", () => {
      void this.fetchTtsVoices(true);
    });

    this.llmModelSelect.on("change", (value: string) => {
      this.config.llm.model = value;
      this.saveActiveLlmToSelectedProvider();
      this.store.save(this.config);
    });

    this.ttsModelSelect.on("change", (value: string) => {
      this.config.tts.model = value;
      this.saveActiveTtsToSelectedProvider();
      this.store.save(this.config);
      void this.handleTtsModelChange(value);
    });

    this.ttsVoiceSelect.on("change", (value: string) => {
      this.config.tts.voice = value;
      this.saveActiveTtsToSelectedProvider();
      this.store.save(this.config);
    });

    this.detectServiceSelect.on("change", (value: string) => {
      this.handleServiceSlotSelectionChange("detect", value);
    });
    this.ocrServiceSelect.on("change", (value: string) => {
      this.handleServiceSlotSelectionChange("ocr", value);
    });
    this.ttsServicePresetSelect.on("change", (value: string) => {
      this.handleServiceSlotSelectionChange("tts", value);
    });
  }

  private bindSelectorFetchBehavior(select: TomSelect, id: string, fetcher: () => Promise<void>): void {
    const el = this.must<HTMLElement>(id);
    const trigger = () => {
      void fetcher();
    };
    select.control_input.addEventListener("focus", trigger);
    el.addEventListener("focus", trigger);
  }

  private async fetchLlmModels(force: boolean): Promise<void> {
    const options = await this.fetchOptionsFromElectron(
      this.currentOcrProvider(),
      "ocr",
      this.currentOcrProvider() === "openai_compatible" ? this.config.llm.baseUrl : undefined,
      this.config.llm.apiKey,
      force,
      "llm-models"
    );
    this.applyOptions(this.llmModelSelect, options, this.config.llm.model);
  }

  private async fetchTtsModels(force: boolean): Promise<void> {
    const options = await this.fetchOptionsFromElectron(
      this.currentTtsProvider(),
      "tts",
      this.currentTtsProvider() === "openai_compatible" ? this.config.tts.baseUrl : undefined,
      this.config.tts.apiKey,
      force,
      "tts-models"
    );
    this.applyOptions(this.ttsModelSelect, options, this.config.tts.model);
  }

  private async fetchTtsVoices(force: boolean): Promise<void> {
    if (!this.providerCatalog) {
      this.updateStatusChip("tts-status-chip", this.t("stack.electronOnly"), "idle");
      this.setStatus(this.t("stack.electronOnly"));
      return;
    }
    const base = this.currentTtsProvider() === "openai_compatible" ? this.config.tts.baseUrl : undefined;
    const key = this.config.tts.apiKey;
    const model = this.config.tts.model;
    const cacheKey = this.makeCacheKey(`tts-voices:${this.currentTtsProvider()}`, base, key, model);

    if (!force && this.optionCache.has(cacheKey)) {
      this.applyOptions(this.ttsVoiceSelect, this.optionCache.get(cacheKey) ?? [], this.config.tts.voice);
      return;
    }

    const voices = await this.fetchTtsVoicesFromElectron(this.currentTtsProvider(), base, key, model);
    this.optionCache.set(cacheKey, voices);
    this.applyOptions(this.ttsVoiceSelect, voices, this.config.tts.voice);
  }

  private async handleTtsModelChange(value: string): Promise<void> {
    const currentVoice = this.config.tts.voice;
    await this.fetchTtsVoices(true);

    const selectedVoice = this.resolveVoiceSelectionForModel(value, currentVoice);
    if (selectedVoice !== this.config.tts.voice) {
      this.config.tts.voice = selectedVoice;
      this.saveActiveTtsToSelectedProvider();
      this.store.save(this.config);
    }
    this.applyOptions(
      this.ttsVoiceSelect,
      this.currentCachedTtsVoices(),
      this.config.tts.voice
    );
  }

  private async checkDetectorHealth(showStatus = true): Promise<void> {
    const base = this.getDetectorBaseUrl();
    try {
      const payload = await checkTextProcessingHealth(base);
      const detectAvailable = payload.ok && payload.features?.detect !== false;
      if (!detectAvailable) {
        this.detectorHealthy = false;
        this.applyDetectorHealthGate();
        this.updateStatusChip(
          "detector-status-chip",
          payload.ok ? this.t("statuschip.detectUnavailable") : this.t("statuschip.unhealthy"),
          "error"
        );
        if (showStatus) {
          this.setStatus(
            payload.ok
              ? this.t("status.detectorMissingFeature")
              : this.t("status.detectorHealthFailedUnhealthy")
          );
        }
        return;
      }
      this.detectorHealthy = true;
      this.applyDetectorHealthGate();
      this.updateStatusChip("detector-status-chip", `Healthy (${payload.detector ?? "detector"})`, "ok");
      if (showStatus) this.setStatus(this.t("status.detectorHealthy"));
    } catch (error) {
      const message = String(error);
      this.detectorHealthy = false;
      this.applyDetectorHealthGate();
      this.updateStatusChip("detector-status-chip", this.t("statuschip.unreachable"), "error");
      if (showStatus) this.setStatus(this.t("status.detectorHealthFailed", { message }));
    }
  }

  private getManagedServiceLabelKey(serviceId: ManagedServiceId): TranslationKey {
    return serviceId === "paddle" ? "stack.paddle" : "stack.edge";
  }

  private renderManagedServiceControl(
    serviceId: ManagedServiceId,
    control: {
      launchButtonId: string;
      stopButtonId: string;
      statusChipId: string;
      footnoteId: string;
      detailPrefix: "stack.detail.paddle" | "stack.detail.edge";
      runningLabel: TranslationKey;
    }
  ): void {
    const launchButton = this.must<HTMLButtonElement>(control.launchButtonId);
    const stopButton = this.must<HTMLButtonElement>(control.stopButtonId);
    const footnote = this.must<HTMLDivElement>(control.footnoteId);

    if (!window.electronAPI?.getManagedServicesStatus) {
      launchButton.disabled = true;
      stopButton.disabled = true;
      this.updateStatusChip(control.statusChipId, this.t("stack.electronOnly"), "idle");
      footnote.textContent = this.t("stack.electronOnly");
      return;
    }

    const status = this.managedServicesStatus?.[serviceId];
    const state = status?.state ?? "stopped";
    launchButton.disabled = state === "starting" || state === "running";
    stopButton.disabled = state === "stopped" || state === "failed";

    if (state === "running" && status) {
      this.updateStatusChip(control.statusChipId, this.t("stack.status.running"), "ok");
      footnote.textContent = serviceId === "paddle"
        ? this.t(control.runningLabel, { detectionUrl: status.urls?.detectionBaseUrl ?? status.url ?? "", ocrUrl: status.urls?.ocrBaseUrl ?? status.url ?? "" })
        : this.t("stack.detail.edge.running", { ttsUrl: status.url ?? "" });
      return;
    }

    if (state === "starting") {
      this.updateStatusChip(control.statusChipId, this.t("stack.status.starting"), "idle");
      footnote.textContent = this.t(`${control.detailPrefix}.starting` as TranslationKey);
      return;
    }

    if (state === "failed") {
      this.updateStatusChip(control.statusChipId, this.t("stack.status.failed"), "error");
      footnote.textContent = this.t(`${control.detailPrefix}.failed` as TranslationKey, { error: status?.error ?? "unknown error" });
      return;
    }

    this.updateStatusChip(control.statusChipId, this.t("stack.status.stopped"), "idle");
    footnote.textContent = this.t(`${control.detailPrefix}.stopped` as TranslationKey);
  }

  private renderManagedServicesStatus(): void {
    this.must<HTMLButtonElement>("btn-open-runtime-services").disabled = !window.electronAPI?.openRuntimeServicesFolder;
    this.renderManagedServiceControl("paddle", {
      launchButtonId: "btn-launch-paddle-service",
      stopButtonId: "btn-stop-paddle-service",
      statusChipId: "paddle-service-status-chip",
      footnoteId: "paddle-service-footnote",
      detailPrefix: "stack.detail.paddle",
      runningLabel: "stack.detail.paddle.running"
    });
    this.renderManagedServiceControl("edge", {
      launchButtonId: "btn-launch-edge-service",
      stopButtonId: "btn-stop-edge-service",
      statusChipId: "edge-service-status-chip",
      footnoteId: "edge-service-footnote",
      detailPrefix: "stack.detail.edge",
      runningLabel: "stack.detail.edge.running"
    });
  }

  private async refreshManagedServicesStatus(): Promise<void> {
    if (!window.electronAPI?.getManagedServicesStatus) {
      this.managedServicesStatus = null;
      this.renderManagedServicesStatus();
      return;
    }
    this.managedServicesStatus = await window.electronAPI.getManagedServicesStatus();
    this.renderManagedServicesStatus();
  }

  private applyManagedServiceUrls(serviceId: ManagedServiceId, status: ManagedServiceStatus): void {
    if (serviceId === "paddle" && status.urls) {
      this.config.textProcessing.detectorBaseUrl = status.urls.detectionBaseUrl;
      this.config.llm.openaiCompatible.baseUrl = status.urls.ocrBaseUrl;
      this.config.llm.provider = "openai_compatible";
      this.applySelectedLlmProviderSettings();
    }
    if (serviceId === "edge" && status.url) {
      this.config.tts.openaiCompatible.baseUrl = status.url;
      this.config.tts.provider = "openai_compatible";
      this.applySelectedTtsProviderSettings();
    }
    this.store.save(this.config);
    this.renderConfig();
    this.renderManagedServicesStatus();
    if (serviceId === "paddle") {
      void this.checkDetectorHealth(false);
    }
  }

  private async launchManagedService(serviceId: ManagedServiceId): Promise<void> {
    if (!window.electronAPI?.launchManagedService) {
      this.setStatus(this.t("stack.electronOnly"));
      return;
    }
    const current = this.managedServicesStatus ?? {
      paddle: { state: "stopped", managed: false, url: null, urls: null, error: null },
      edge: { state: "stopped", managed: false, url: null, urls: null, error: null }
    };
    this.managedServicesStatus = {
      ...current,
      [serviceId]: {
        ...current[serviceId],
        state: "starting",
        managed: false,
        error: null
      }
    };
    this.renderManagedServicesStatus();
    const status = await window.electronAPI.launchManagedService(serviceId);
    this.managedServicesStatus = {
      ...(this.managedServicesStatus ?? current),
      [serviceId]: status
    };
    this.renderManagedServicesStatus();
    if (status.state === "running") {
      this.applyManagedServiceUrls(serviceId, status);
      this.setStatus(this.t("status.serviceLaunched", { service: this.t(this.getManagedServiceLabelKey(serviceId)) }));
      return;
    }
    this.setStatus(this.t("status.serviceLaunchFailed", {
      service: this.t(this.getManagedServiceLabelKey(serviceId)),
      error: status.error ?? "unknown error"
    }));
  }

  private async stopManagedService(serviceId: ManagedServiceId): Promise<void> {
    if (!window.electronAPI?.stopManagedService) {
      this.setStatus(this.t("stack.electronOnly"));
      return;
    }
    const status = await window.electronAPI.stopManagedService(serviceId);
    this.managedServicesStatus = {
      ...(this.managedServicesStatus ?? {
        paddle: { state: "stopped", managed: false, url: null, urls: null, error: null },
        edge: { state: "stopped", managed: false, url: null, urls: null, error: null }
      }),
      [serviceId]: status
    };
    this.renderManagedServicesStatus();
    this.setStatus(this.t("status.serviceStopped", { service: this.t(this.getManagedServiceLabelKey(serviceId)) }));
  }

  private async openRuntimeServicesFolder(): Promise<void> {
    if (!window.electronAPI?.openRuntimeServicesFolder) {
      this.setStatus(this.t("stack.electronOnly"));
      return;
    }
    const error = await window.electronAPI.openRuntimeServicesFolder(this.config.services.externalRoot);
    if (error) {
      this.setStatus(this.t("status.runtimeServicesOpenFailed", { error }));
      return;
    }
    this.setStatus(this.t("status.runtimeServicesOpened"));
  }

  private setLooseStatusChip(chip: HTMLElement, text: string, state: "ok" | "error" | "idle"): void {
    chip.textContent = text;
    chip.classList.remove("ok", "error");
    if (state !== "idle") {
      chip.classList.add(state);
    }
  }

  private getServiceSlotSelect(slot: DiscoveredServiceSlot): TomSelect | null {
    return slot === "detect"
      ? this.detectServiceSelect
      : slot === "ocr"
        ? this.ocrServiceSelect
        : this.ttsServicePresetSelect;
  }

  private getServiceSlotStatusChipId(slot: DiscoveredServiceSlot): string {
    return slot === "detect"
      ? "service-detect-status-chip"
      : slot === "ocr"
        ? "service-ocr-status-chip"
        : "service-tts-status-chip";
  }

  private getServiceSlotViewButtonId(slot: DiscoveredServiceSlot): string {
    return slot === "detect"
      ? "btn-view-service-detect-log"
      : slot === "ocr"
        ? "btn-view-service-ocr-log"
        : "btn-view-service-tts-log";
  }

  private getServiceSlotViewPanelId(slot: DiscoveredServiceSlot): string {
    return slot === "detect"
      ? "service-detect-view"
      : slot === "ocr"
        ? "service-ocr-view"
        : "service-tts-view";
  }

  private getServiceSlotLaunchId(slot: DiscoveredServiceSlot): string {
    return slot === "detect"
      ? "service-detect-launch"
      : slot === "ocr"
        ? "service-ocr-launch"
        : "service-tts-launch";
  }

  private getServiceSlotLogId(slot: DiscoveredServiceSlot): string {
    return slot === "detect"
      ? "service-detect-log"
      : slot === "ocr"
        ? "service-ocr-log"
        : "service-tts-log";
  }

  private getServiceSlotLabel(slot: DiscoveredServiceSlot): string {
    return slot === "detect"
      ? "Text Processing"
      : slot === "ocr"
        ? "OCR"
        : "Text to Speech";
  }

  private getServiceSlotCapability(slot: DiscoveredServiceSlot): "detect" | "ocr" | "speech" {
    return slot === "detect"
      ? "detect"
      : slot === "ocr"
        ? "ocr"
        : "speech";
  }

  private encodeServiceOptionValue(value: { servicePath: string; selectorId?: string; presetId?: string }): string {
    return JSON.stringify(value);
  }

  private decodeServiceOptionValue(value: string): { servicePath: string; selectorId?: string; presetId?: string } | null {
    if (!value || value === SERVICE_NONE_OPTION) return null;
    try {
      const parsed = JSON.parse(value) as { servicePath?: unknown; selectorId?: unknown; presetId?: unknown };
      if (typeof parsed.servicePath !== "string") {
        return null;
      }
      const selectorId = typeof parsed.selectorId === "string" ? parsed.selectorId : undefined;
      const presetId = typeof parsed.presetId === "string" ? parsed.presetId : undefined;
      if (!selectorId && !presetId) {
        return null;
      }
      return { servicePath: parsed.servicePath, ...(selectorId ? { selectorId } : {}), ...(presetId ? { presetId } : {}) };
    } catch {
      return null;
    }
  }

  private formatServicePresetLabel(label: string): string {
    return label.replace(/\bGPU\b/g, "NVIDIA").replace(/\bgpu\b/g, "NVIDIA");
  }

  private resolveServiceOption(slot: DiscoveredServiceSlot, value: string): {
    service: DiscoveredServiceCatalogItem;
    storedId: string;
    label: string;
    key: string;
    selector?: DiscoveredServiceSelector;
    preset?: DiscoveredServicePreset;
  } | null {
    const parsed = this.decodeServiceOptionValue(value);
    if (!parsed) {
      return null;
    }
    const service = (this.discoveredServices?.services ?? []).find((entry) => entry.servicePath === parsed.servicePath);
    if (!service) {
      return null;
    }
    const capability = this.getServiceSlotCapability(slot);
    if (parsed.selectorId) {
      const selector = service.selectors?.find((entry) => entry.id === parsed.selectorId && entry.capabilities.includes(capability));
      if (!selector) {
        return null;
      }
      return {
        service,
        storedId: selector.id,
        label: selector.name,
        key: `${service.servicePath}::selector::${selector.id}`,
        selector
      };
    }
    const preset = service.presets.find((entry) => entry.id === parsed.presetId && entry.capabilities.includes(capability));
    if (!preset) {
      return null;
    }
    return {
      service,
      storedId: preset.id,
      label: `${service.name} - ${this.formatServicePresetLabel(preset.name)}`,
      key: `${service.servicePath}::preset::${preset.id}`,
      preset
    };
  }

  private capabilitiesForSlots(slots: DiscoveredServiceSlot[]): DiscoveredServiceCapability[] {
    return Array.from(new Set(slots.map((slot) => this.getServiceSlotCapability(slot))));
  }

  private resolveSelectorPreset(
    service: DiscoveredServiceCatalogItem,
    selector: DiscoveredServiceSelector,
    slots: DiscoveredServiceSlot[]
  ): DiscoveredServicePreset | null {
    const requiredCapabilities = this.capabilitiesForSlots(slots);
    if (selector.presetId) {
      const preset = service.presets.find((entry) => entry.id === selector.presetId) ?? null;
      return preset && requiredCapabilities.every((capability) => preset.capabilities.includes(capability)) ? preset : null;
    }
    const candidates = service.presets.filter((preset) => requiredCapabilities.every((capability) => preset.capabilities.includes(capability)));
    if (candidates.length === 0) {
      return null;
    }
    const runtimeMatched = selector.runtime
      ? candidates.filter((preset) => requiredCapabilities.every((capability) => {
          const expected = selector.runtime?.[capability];
          return !expected || preset.runtime?.[capability] === expected;
        }))
      : candidates;
    const pool = runtimeMatched.length > 0 ? runtimeMatched : candidates;
    return pool.slice().sort((left, right) => {
      const leftExtra = left.capabilities.length - requiredCapabilities.length;
      const rightExtra = right.capabilities.length - requiredCapabilities.length;
      if (leftExtra !== rightExtra) {
        return leftExtra - rightExtra;
      }
      return left.defaultPort - right.defaultPort;
    })[0] ?? null;
  }

  private buildServiceSlotOptions(slot: DiscoveredServiceSlot): NamedOption[] {
    const capability = this.getServiceSlotCapability(slot);
    const services = this.discoveredServices?.services ?? [];
    const options = services.flatMap((service) => {
      const selectors = service.selectors?.filter((selector) => selector.capabilities.includes(capability)) ?? [];
      if (selectors.length > 0) {
        return selectors.map((selector) => ({
          value: this.encodeServiceOptionValue({ servicePath: service.servicePath, selectorId: selector.id }),
          label: selector.name
        }));
      }
      return service.presets
        .filter((preset) => preset.capabilities.includes(capability))
        .map((preset) => ({
          value: this.encodeServiceOptionValue({ servicePath: service.servicePath, presetId: preset.id }),
          label: `${service.name} - ${this.formatServicePresetLabel(preset.name)}`
        }));
    });
    return [
      { value: SERVICE_NONE_OPTION, label: "None" },
      ...options.sort((left, right) => left.label.localeCompare(right.label))
    ];
  }

  private getConfigServiceSelection(slot: DiscoveredServiceSlot): { serviceId: string; presetId: string } {
    if (slot === "detect") {
      return {
        serviceId: this.config.services.activeDetectServiceId,
        presetId: this.config.services.activeDetectPresetId
      };
    }
    if (slot === "ocr") {
      return {
        serviceId: this.config.services.activeOcrServiceId,
        presetId: this.config.services.activeOcrPresetId
      };
    }
    return {
      serviceId: this.config.services.activeTtsServiceId,
      presetId: this.config.services.activeTtsPresetId
    };
  }

  private setConfigServiceSelection(slot: DiscoveredServiceSlot, service: DiscoveredServiceCatalogItem | null, presetId: string): void {
    const serviceId = service?.id ?? "";
    const nextPresetId = service ? presetId : "";
    if (slot === "detect") {
      this.config.services.activeDetectServiceId = serviceId;
      this.config.services.activeDetectPresetId = nextPresetId;
    } else if (slot === "ocr") {
      this.config.services.activeOcrServiceId = serviceId;
      this.config.services.activeOcrPresetId = nextPresetId;
    } else {
      this.config.services.activeTtsServiceId = serviceId;
      this.config.services.activeTtsPresetId = nextPresetId;
    }
  }

  private getSelectedServiceOptionValue(slot: DiscoveredServiceSlot): string {
    const current = this.getConfigServiceSelection(slot);
    if (!current.serviceId || !current.presetId) {
      return SERVICE_NONE_OPTION;
    }
    const service = (this.discoveredServices?.services ?? []).find((entry) => entry.id === current.serviceId);
    if (!service) {
      return SERVICE_NONE_OPTION;
    }
    const capability = this.getServiceSlotCapability(slot);
    const selector = service.selectors?.find((entry) => entry.id === current.presetId && entry.capabilities.includes(capability));
    if (selector) {
      return this.encodeServiceOptionValue({ servicePath: service.servicePath, selectorId: selector.id });
    }
    const migratedSelector = service.selectors?.find((entry) => entry.presetId === current.presetId && entry.capabilities.includes(capability));
    if (migratedSelector) {
      return this.encodeServiceOptionValue({ servicePath: service.servicePath, selectorId: migratedSelector.id });
    }
    const preset = service.presets.find((entry) => entry.id === current.presetId && entry.capabilities.includes(capability));
    return preset ? this.encodeServiceOptionValue({ servicePath: service.servicePath, presetId: preset.id }) : SERVICE_NONE_OPTION;
  }

  private handleServiceSlotSelectionChange(slot: DiscoveredServiceSlot, value: string): void {
    delete this.serviceSlotAliases[slot];
    const selection = this.resolveServiceOption(slot, value);
    if (!selection) {
      this.setConfigServiceSelection(slot, null, "");
      this.store.save(this.config);
      this.renderDiscoveredServicesDashboard();
      return;
    }
    this.setConfigServiceSelection(slot, selection.service, selection.storedId);
    this.store.save(this.config);
    this.renderDiscoveredServicesDashboard();
  }

  private getDiscoveredServiceStatus(slot: DiscoveredServiceSlot): DiscoveredServiceRunStatus | null {
    const direct = this.discoveredServiceStatuses.find((status) => status.slot === slot) ?? null;
    if (direct) return direct;
    const aliased = this.serviceSlotAliases[slot];
    if (!aliased) return null;
    const current = this.discoveredServiceStatuses.find((status) => status.slot === aliased) ?? null;
    return current ? { ...current, slot, logLines: [...current.logLines] } : null;
  }

  private updateDiscoveredServiceStatus(status: DiscoveredServiceRunStatus): void {
    const next = this.discoveredServiceStatuses.filter((entry) => entry.slot !== status.slot);
    next.push(status);
    next.sort((left, right) => left.slot.localeCompare(right.slot));
    this.discoveredServiceStatuses = next;
  }

  private hasActiveDiscoveredService(): boolean {
    return this.discoveredServiceStatuses.some((status) => status.state === "starting" || status.state === "running");
  }

  private startServiceStatusPolling(): void {
    if (this.serviceStatusPollTimer !== null) {
      return;
    }
    this.serviceStatusPollTimer = window.setInterval(() => {
      if (this.serviceDashboardLoading) {
        return;
      }
      const viewingLogs = Object.values(this.serviceLogViews).some(Boolean);
      if (!viewingLogs && !this.hasActiveDiscoveredService()) {
        return;
      }
      void this.refreshDiscoveredServiceStatuses();
    }, 1000);
  }

  private stopServiceStatusPolling(): void {
    if (this.serviceStatusPollTimer === null) {
      return;
    }
    window.clearInterval(this.serviceStatusPollTimer);
    this.serviceStatusPollTimer = null;
  }

  private async refreshDiscoveredServiceStatuses(): Promise<void> {
    if (!window.electronAPI?.getDiscoveredServiceStatuses) {
      return;
    }
    try {
      this.discoveredServiceStatuses = await window.electronAPI.getDiscoveredServiceStatuses();
      this.renderDiscoveredServicesDashboard();
    } catch {
      // Ignore transient poll failures.
    }
  }

  private toggleServiceLogView(slot: DiscoveredServiceSlot): void {
    this.serviceLogViews[slot] = !this.serviceLogViews[slot];
    this.renderDiscoveredServicesDashboard();
  }

  private applyDiscoveredServiceUrls(status: DiscoveredServiceRunStatus): void {
    if (status.urls?.detectionBaseUrl) {
      this.config.textProcessing.detectorBaseUrl = status.urls.detectionBaseUrl;
    }
    if (status.urls?.ocrBaseUrl) {
      this.config.llm.openaiCompatible.baseUrl = status.urls.ocrBaseUrl;
      this.config.llm.provider = "openai_compatible";
      this.applySelectedLlmProviderSettings();
    }
    if (status.urls?.ttsBaseUrl) {
      this.config.tts.openaiCompatible.baseUrl = status.urls.ttsBaseUrl;
      this.config.tts.provider = "openai_compatible";
      this.applySelectedTtsProviderSettings();
    }
    this.store.save(this.config);
    this.renderConfig();
    if (status.urls?.detectionBaseUrl) {
      void this.checkDetectorHealth(false);
    }
  }

  private renderDiscoveredServicesDashboard(): void {
    const footnote = this.must<HTMLDivElement>("services-dashboard-footnote");
    const errors = this.must<HTMLDivElement>("services-dashboard-errors");
    const openButton = this.must<HTMLButtonElement>("btn-open-runtime-services");
    const refreshButton = this.must<HTMLButtonElement>("btn-refresh-services-dashboard");
    const launchButton = this.must<HTMLButtonElement>("btn-launch-selected-services");
    const stopButton = this.must<HTMLButtonElement>("btn-stop-selected-services");
    this.must<HTMLDivElement>("services-dashboard").setAttribute("aria-busy", this.serviceDashboardLoading ? "true" : "false");
    openButton.disabled = !window.electronAPI?.openRuntimeServicesFolder;
    refreshButton.disabled = this.serviceDashboardLoading;
    launchButton.disabled = this.serviceDashboardLoading;
    stopButton.disabled = this.serviceDashboardLoading;

    if (!window.electronAPI?.getDiscoveredServices || !window.electronAPI?.launchDiscoveredService || !window.electronAPI?.stopDiscoveredService) {
      launchButton.disabled = true;
      stopButton.disabled = true;
      footnote.textContent = this.t("stack.electronOnly");
      errors.textContent = "";
      return;
    }

    if (this.serviceDashboardLoading) {
      footnote.textContent = "Refreshing services...";
    } else {
      const count = this.discoveredServices?.services.length ?? 0;
      footnote.textContent = this.config.services.externalRoot.trim().length > 0
        ? `Detected ${count} service${count === 1 ? "" : "s"} from the selected folder. Launching a service applies its local URLs automatically.`
        : `Detected ${count} bundled service${count === 1 ? "" : "s"}. Launching a service applies its local URLs automatically.`;
    }

    const snapshot = this.discoveredServices;
    for (const slot of ["detect", "ocr", "tts"] as const) {
      const select = this.getServiceSlotSelect(slot);
      const options = snapshot ? this.buildServiceSlotOptions(slot) : [];
      this.applyOptions(select, options, this.getSelectedServiceOptionValue(slot));
      const chip = this.must<HTMLSpanElement>(this.getServiceSlotStatusChipId(slot));
      const viewButton = this.must<HTMLButtonElement>(this.getServiceSlotViewButtonId(slot));
      const viewPanel = this.must<HTMLDivElement>(this.getServiceSlotViewPanelId(slot));
      const launchText = this.must<HTMLDivElement>(this.getServiceSlotLaunchId(slot));
      const logText = this.must<HTMLPreElement>(this.getServiceSlotLogId(slot));
      const status = this.getDiscoveredServiceStatus(slot);
      if (status?.state === "running") {
        this.setLooseStatusChip(chip, "Running", "ok");
      } else if (status?.state === "starting") {
        this.setLooseStatusChip(chip, "Starting", "idle");
      } else if (status?.state === "failed") {
        this.setLooseStatusChip(chip, "Failed", "error");
      } else {
        this.setLooseStatusChip(chip, "Stopped", "idle");
      }
      const canView = Boolean(status?.launchCommand) || Boolean(status?.logLines.length);
      viewButton.disabled = !canView;
      viewButton.textContent = this.serviceLogViews[slot] ? "Hide" : "View";
      viewButton.setAttribute("aria-expanded", this.serviceLogViews[slot] ? "true" : "false");
      viewPanel.hidden = !this.serviceLogViews[slot];
      const launchParts = [
        status?.pid ? `PID ${status.pid}` : "",
        status?.launchCwd ? `cd /d "${status.launchCwd}"` : "",
        status?.launchCommand ?? ""
      ].filter((part) => part.length > 0);
      launchText.textContent = launchParts.length > 0 ? launchParts.join("\n") : "No launch recorded.";
      logText.textContent = status?.logLines.length
        ? status.logLines.join("\n")
        : status?.state === "starting"
          ? "Waiting for output..."
          : "No output yet.";
    }

    errors.textContent = snapshot && snapshot.errors.length > 0
      ? `${snapshot.errors.length} manifest error${snapshot.errors.length === 1 ? "" : "s"}. ${snapshot.errors.map((error) => error.manifestPath).join(" | ")}`
      : snapshot || this.serviceDashboardLoading
        ? ""
        : this.config.services.externalRoot.trim().length > 0
          ? "No services detected in the selected folder."
          : "No bundled services detected.";
  }

  private async refreshDiscoveredServicesDashboard(): Promise<void> {
    if (!window.electronAPI?.getDiscoveredServices) {
      this.discoveredServices = null;
      this.discoveredServiceStatuses = [];
      this.renderDiscoveredServicesDashboard();
      return;
    }
    this.serviceDashboardLoading = true;
    this.renderDiscoveredServicesDashboard();
    try {
      this.discoveredServices = await window.electronAPI.getDiscoveredServices(this.config.services.externalRoot);
      this.discoveredServiceStatuses = window.electronAPI.getDiscoveredServiceStatuses
        ? await window.electronAPI.getDiscoveredServiceStatuses()
        : [];
    } catch (error) {
      this.discoveredServices = { services: [], errors: [{ manifestPath: "services-dashboard", message: String(error) }] };
      this.discoveredServiceStatuses = [];
      this.setStatus(`Failed to refresh services: ${String(error)}`);
    } finally {
      this.serviceDashboardLoading = false;
      this.renderDiscoveredServicesDashboard();
    }
  }

  private async launchSelectedServices(): Promise<void> {
    if (!window.electronAPI?.launchDiscoveredService) {
      this.setStatus(this.t("stack.electronOnly"));
      return;
    }
    const launches: Array<{ slot: DiscoveredServiceSlot; service: DiscoveredServiceCatalogItem; presetId: string; label: string; key: string }> = [];
    const seen = new Map<string, DiscoveredServiceSlot>();
    const groupedSelections = new Map<string, {
      slot: DiscoveredServiceSlot;
      slots: DiscoveredServiceSlot[];
      selection: {
        service: DiscoveredServiceCatalogItem;
        storedId: string;
        label: string;
        key: string;
        selector?: DiscoveredServiceSelector;
        preset?: DiscoveredServicePreset;
      };
    }>();
    this.serviceSlotAliases = {};
    for (const slot of ["detect", "ocr", "tts"] as const) {
      const rawValue = this.getServiceSlotSelect(slot)?.getValue() ?? "";
      const value = typeof rawValue === "string" ? rawValue : rawValue[0] ?? "";
      const selection = this.resolveServiceOption(slot, value);
      if (!selection) continue;
      const primarySlot = seen.get(selection.key);
      if (primarySlot) {
        this.serviceSlotAliases[slot] = primarySlot;
        groupedSelections.get(selection.key)?.slots.push(slot);
        continue;
      }
      seen.set(selection.key, slot);
      groupedSelections.set(selection.key, {
        slot,
        slots: [slot],
        selection
      });
    }
    for (const group of groupedSelections.values()) {
      const preset = group.selection.preset ?? (group.selection.selector
        ? this.resolveSelectorPreset(group.selection.service, group.selection.selector, group.slots)
        : null);
      if (!preset) {
        this.setStatus(`Failed to resolve a launch preset for ${group.selection.label}.`);
        return;
      }
      launches.push({
        slot: group.slot,
        service: group.selection.service,
        presetId: preset.id,
        label: group.selection.label,
        key: group.selection.key
      });
    }
    if (launches.length === 0) {
      this.setStatus("Select at least one service preset first.");
      return;
    }
    for (const launch of launches) {
      this.updateDiscoveredServiceStatus({
        slot: launch.slot,
        servicePath: launch.service.servicePath,
        serviceId: launch.service.id,
        family: launch.service.family,
        presetId: launch.presetId,
        pid: null,
        state: "starting",
        managed: false,
        url: null,
        urls: null,
        launchCwd: null,
        launchCommand: null,
        logLines: [],
        error: null
      });
    }
    this.renderDiscoveredServicesDashboard();
    const startedLabels: string[] = [];
    for (const launch of launches) {
      const status = await window.electronAPI.launchDiscoveredService({
        slot: launch.slot,
        servicePath: launch.service.servicePath,
        presetId: launch.presetId,
        externalRoot: this.config.services.externalRoot
      });
      this.updateDiscoveredServiceStatus(status);
      this.applyDiscoveredServiceUrls(status);
      startedLabels.push(`${this.getServiceSlotLabel(launch.slot)}: ${launch.label}`);
      for (const aliasSlot of ["detect", "ocr", "tts"] as const) {
        if (this.serviceSlotAliases[aliasSlot] === launch.slot) {
          this.updateDiscoveredServiceStatus({ ...status, slot: aliasSlot });
        }
      }
    }
    this.renderDiscoveredServicesDashboard();
    const failed = launches.find((launch) => this.getDiscoveredServiceStatus(launch.slot)?.state === "failed");
    if (failed) {
      const status = this.getDiscoveredServiceStatus(failed.slot);
      this.setStatus(`Failed to launch ${failed.label}: ${status?.error ?? "unknown error"}`);
      return;
    }
    this.setStatus(`Launched ${startedLabels.join(" | ")}.`);
  }

  private async stopSelectedServices(): Promise<void> {
    if (!window.electronAPI?.stopDiscoveredService) {
      this.setStatus(this.t("stack.electronOnly"));
      return;
    }
    const aliases = { ...this.serviceSlotAliases };
    const stops = new Set<DiscoveredServiceSlot>();
    for (const slot of ["detect", "ocr", "tts"] as const) {
      const alias = aliases[slot];
      stops.add(alias ?? slot);
    }
    for (const slot of stops) {
      const status = await window.electronAPI.stopDiscoveredService(slot);
      this.updateDiscoveredServiceStatus(status);
      for (const aliasSlot of ["detect", "ocr", "tts"] as const) {
        if (aliases[aliasSlot] === slot) {
          this.updateDiscoveredServiceStatus({ ...status, slot: aliasSlot });
        }
      }
    }
    this.serviceSlotAliases = {};
    this.renderDiscoveredServicesDashboard();
    this.setStatus("Stopped selected services.");
  }

  private async fetchTtsVoicesFromElectron(provider: TtsProvider, baseUrl: string | undefined, apiKey: string, model: string): Promise<NamedOption[]> {
    if (!this.providerCatalog) {
      return this.config.tts.voice ? [{ value: this.config.tts.voice, label: this.config.tts.voice }] : [];
    }
    try {
      const options = await this.providerCatalog.fetchVoices({
        provider,
        kind: "tts",
        apiKey,
        model,
        ...(baseUrl ? { baseUrl } : {})
      });
      if (options.length > 0) {
        this.updateStatusChip("tts-status-chip", this.t("statuschip.voicesLoaded"), "ok");
        return options;
      }
    } catch (error) {
      this.setStatus(this.withApiBaseUrlHint(this.t("status.fetchFailed", { namespace: "tts-voices", reason: String(error) }), "tts", baseUrl));
      this.updateStatusChip("tts-status-chip", this.t("statuschip.networkError"), "error");
      return this.config.tts.voice ? [{ value: this.config.tts.voice, label: this.config.tts.voice }] : [];
    }
    this.updateStatusChip("tts-status-chip", this.t("statuschip.voiceListUnavailable"), "error");
    this.setStatus(this.withApiBaseUrlHint(this.t("status.voiceListUnavailable"), "tts", baseUrl));
    return this.config.tts.voice ? [{ value: this.config.tts.voice, label: this.config.tts.voice }] : [];
  }

  private async fetchOptionsFromElectron(
    provider: OcrProvider | TtsProvider,
    kind: "ocr" | "tts",
    baseUrl: string | undefined,
    apiKey: string,
    force: boolean,
    namespace: string
  ): Promise<NamedOption[]> {
    if (!this.providerCatalog) {
      this.setStatus(this.t("stack.electronOnly"));
      if (namespace.startsWith("llm")) this.updateStatusChip("llm-status-chip", this.t("stack.electronOnly"), "idle");
      if (namespace.startsWith("tts")) this.updateStatusChip("tts-status-chip", this.t("stack.electronOnly"), "idle");
      return [];
    }
    const cacheKey = this.makeCacheKey(`${namespace}:${provider}`, baseUrl, apiKey);
    if (!force && this.optionCache.has(cacheKey)) {
      return this.optionCache.get(cacheKey) ?? [];
    }

    try {
      const options = await this.providerCatalog.fetchModels({
        provider,
        kind,
        apiKey,
        ...(baseUrl ? { baseUrl } : {})
      });
      this.optionCache.set(cacheKey, options);
      if (force) {
        this.setStatus(this.t("status.refetched", { namespace }));
      }
      if (namespace.startsWith("llm")) this.updateStatusChip("llm-status-chip", this.t("statuschip.loadedCount", { count: options.length }), "ok");
      if (namespace.startsWith("tts")) this.updateStatusChip("tts-status-chip", this.t("statuschip.loadedCount", { count: options.length }), "ok");
      return options;
    } catch (error) {
      this.setStatus(this.withApiBaseUrlHint(
        this.t("status.fetchFailed", { namespace, reason: String(error) }),
        namespace.startsWith("llm") ? "ocr" : "tts",
        baseUrl
      ));
      if (namespace.startsWith("llm")) this.updateStatusChip("llm-status-chip", this.t("statuschip.networkError"), "error");
      if (namespace.startsWith("tts")) this.updateStatusChip("tts-status-chip", this.t("statuschip.networkError"), "error");
      return [];
    }
  }

  private applyOptions(select: TomSelect | null, options: NamedOption[], current: string): void {
    if (!select) return;
    select.clearOptions();
    options.forEach((option) => {
      select.addOption({ value: option.value, text: option.label });
    });

    if (current) {
      if (!options.some((option) => option.value === current)) {
        select.addOption({ value: current, text: current });
      }
      select.setValue(current, true);
    }

    select.refreshOptions(false);
  }

  private resolveVoiceSelectionForModel(model: string, preferredVoice: string): string {
    const voices = this.currentCachedTtsVoices(model);
    return resolveVoiceSelection(preferredVoice, voices);
  }

  private currentCachedTtsVoices(model: string = this.config.tts.model): NamedOption[] {
    const baseUrl = this.currentTtsProvider() === "openai_compatible" ? this.config.tts.baseUrl : undefined;
    return this.optionCache.get(this.makeCacheKey(`tts-voices:${this.currentTtsProvider()}`, baseUrl, this.config.tts.apiKey, model)) ?? [];
  }

  private makeCacheKey(namespace: string, baseUrl: string | undefined, apiKey: string, discriminator = ""): string {
    return makeOptionCacheKey(namespace, baseUrl, apiKey, discriminator);
  }

  private withApiBaseUrlHint(message: string, kind: "ocr" | "tts", baseUrl: string | undefined): string {
    const provider = kind === "ocr" ? this.currentOcrProvider() : this.currentTtsProvider();
    if (provider !== "openai_compatible") {
      return message;
    }
    const normalized = baseUrl?.trim().replace(/\/+$/, "") ?? "";
    if (!normalized || normalized.endsWith("/v1")) {
      return message;
    }
    const service = kind === "ocr" ? this.t("ocr.title") : this.t("tts.title");
    return `${message} ${this.t("status.apiBaseUrlHint", { service })}`;
  }

  private setStatus(text: string): void {
    const el = this.must<HTMLSpanElement>("status-text");
    el.textContent = text;
  }

  private setRawTextValuePreservingScroll(value: string): void {
    const raw = this.must<HTMLTextAreaElement>("raw-text");
    const scrollTop = raw.scrollTop;
    const scrollLeft = raw.scrollLeft;
    const selectionStart = raw.selectionStart;
    const selectionEnd = raw.selectionEnd;
    raw.value = value;
    raw.scrollTop = scrollTop;
    raw.scrollLeft = scrollLeft;
    try {
      raw.setSelectionRange(selectionStart, selectionEnd);
    } catch {
      // Ignore when the textarea is not focusable or selection is invalid.
    }
  }

  private applyStaticTranslations(): void {
    applyTranslationsToElement(document, this.currentLanguage());
  }

  private updateTomSelectPlaceholders(): void {
    const pairs: Array<[TomSelect | null, string]> = [
      [this.llmModelSelect, this.t("ocr.model")],
      [this.ttsModelSelect, this.t("tts.model")],
      [this.ttsVoiceSelect, this.t("tts.voice")],
      [this.detectServiceSelect, "Text Processing"],
      [this.ocrServiceSelect, "OCR"],
      [this.ttsServicePresetSelect, "Text to Speech"]
    ];
    for (const [select, placeholder] of pairs) {
      if (!select) continue;
      select.settings.placeholder = placeholder;
      select.control_input.placeholder = placeholder;
      select.input.setAttribute("placeholder", placeholder);
    }
  }

  private applyLanguage(): void {
    document.documentElement.lang = this.currentLanguage();
    document.documentElement.dir = this.currentLanguage() === "ar" ? "rtl" : "ltr";
    this.applyStaticTranslations();
    this.updateTomSelectPlaceholders();
    this.renderPlayState();
    this.renderAlwaysOnTopButton();
  }

  private bindSettings(): void {
    const sidebar = this.must<HTMLElement>("sidebar");
    const drawer = this.must<HTMLElement>("settings-drawer");

    sidebar.addEventListener("mouseenter", () => {
      if (this.config.ui.settingsDrawerOpen) return;
      this.settingsPeekOpen = true;
      this.applyUiState();
    });

    drawer.addEventListener("mouseenter", () => {
      if (this.config.ui.settingsDrawerOpen) return;
      this.settingsPeekOpen = true;
      this.applyUiState();
    });

    drawer.addEventListener("mouseleave", () => {
      if (this.config.ui.settingsDrawerOpen) return;
      this.settingsPeekOpen = false;
      this.applyUiState();
    });

    this.must<HTMLButtonElement>("btn-settings-toggle").addEventListener("click", () => {
      this.config.ui.settingsDrawerOpen = !this.config.ui.settingsDrawerOpen;
      if (this.config.ui.settingsDrawerOpen) {
        this.settingsPeekOpen = false;
      }
      this.applyUiState();
      this.store.save(this.config);
    });
    this.must<HTMLButtonElement>("btn-settings-close").addEventListener("click", () => {
      this.config.ui.settingsDrawerOpen = false;
      this.settingsPeekOpen = false;
      this.applyUiState();
      this.store.save(this.config);
    });

    this.must<HTMLButtonElement>("theme-zen").addEventListener("click", () => this.setTheme("zen"));
    this.must<HTMLButtonElement>("theme-pink").addEventListener("click", () => this.setTheme("pink"));
    this.must<HTMLInputElement>("ui-dark-mode").addEventListener("change", () => {
      this.config.ui.darkMode = this.must<HTMLInputElement>("ui-dark-mode").checked;
      this.applyUiState();
      this.store.save(this.config);
      void this.syncElectronOverlayTheme();
    });
    this.must<HTMLSelectElement>("ui-language").addEventListener("change", () => {
      const value = this.must<HTMLSelectElement>("ui-language").value;
      this.config.ui.language = value === "ar" ? "ar" : "en";
      this.renderConfig();
      this.store.save(this.config);
    });
    this.must<HTMLSelectElement>("llm-provider").addEventListener("change", () => {
      const value = this.must<HTMLSelectElement>("llm-provider").value;
      this.switchOcrProvider(value === "gemini_sdk" ? "gemini_sdk" : "openai_compatible");
    });
    this.must<HTMLSelectElement>("tts-provider").addEventListener("change", () => {
      const value = this.must<HTMLSelectElement>("tts-provider").value;
      this.switchTtsProvider(value === "gemini_sdk" ? "gemini_sdk" : "openai_compatible");
    });

    const basicIds = [
      "llm-url",
      "llm-key",
      "llm-prompt",
      "llm-image-detail",
      "llm-max-tokens",
      "llm-thinking-mode",
      "detector-url",
      "tts-url",
      "tts-key",
      "tts-thinking-mode",
      "chunk-min",
      "chunk-max",
      "clean-text-before-tts",
      "lowercase-text-before-tts",
      "wpm",
      "stream-window-size",
      "chunk-concurrency",
      "chunk-retry-count",
      "chunk-timeout-ms",
      "large-edit-reset-ratio",
      "failure-cooldown-ms",
      "session-chunk-cache-limit",
      "session-audio-byte-limit",
      "show-chunk-diagnostics",
      "punctuation-pause"
    ];
    basicIds.forEach((id) => {
      this.must<HTMLInputElement>(id).addEventListener("change", () => {
        this.syncConfigFromInputs();
      });
    });

    this.must<HTMLInputElement>("detector-url").addEventListener("change", () => {
      this.detectorHealthy = false;
      this.applyDetectorHealthGate();
      this.updateStatusChip("detector-status-chip", this.t("statuschip.unreachable"), "error");
    });

    this.must<HTMLInputElement>("diagnostics-enabled").addEventListener("change", () => this.syncConfigFromInputs());
    this.must<HTMLInputElement>("clipboard-watcher-enabled").addEventListener("change", () => {
      this.config.system.clipboardWatcherEnabled = this.must<HTMLInputElement>("clipboard-watcher-enabled").checked;
      this.store.save(this.config);
      void this.applyClipboardWatcherEnabledSetting();
    });
    this.must<HTMLInputElement>("auto-reader-advance-hotkey").addEventListener("change", () => {
      this.syncConfigFromInputs();
      void this.applyAutoReaderSettings();
    });
    this.must<HTMLInputElement>("auto-reader-advance-delay-ms").addEventListener("change", () => {
      this.syncConfigFromInputs();
      void this.applyAutoReaderSettings();
    });
    this.must<HTMLInputElement>("auto-reader-no-text-retry-count").addEventListener("change", () => {
      this.syncConfigFromInputs();
      void this.applyAutoReaderSettings();
    });
    this.must<HTMLSelectElement>("detector-mode").addEventListener("change", () => this.syncConfigFromInputs());
    this.must<HTMLButtonElement>("detector-health").addEventListener("click", async () => {
      await this.checkDetectorHealth();
    });
    this.must<HTMLInputElement>("services-external-root").addEventListener("change", () => {
      this.syncConfigFromInputs();
      void this.refreshDiscoveredServicesDashboard();
    });
    this.must<HTMLButtonElement>("btn-refresh-services-dashboard").addEventListener("click", () => {
      this.syncConfigFromInputs();
      void this.refreshDiscoveredServicesDashboard();
    });
    this.must<HTMLButtonElement>("btn-open-runtime-services").addEventListener("click", () => {
      void this.openRuntimeServicesFolder();
    });
    this.must<HTMLButtonElement>("btn-launch-selected-services").addEventListener("click", () => {
      void this.launchSelectedServices();
    });
    this.must<HTMLButtonElement>("btn-stop-selected-services").addEventListener("click", () => {
      void this.stopSelectedServices();
    });
    this.must<HTMLButtonElement>("btn-view-service-detect-log").addEventListener("click", () => {
      this.toggleServiceLogView("detect");
    });
    this.must<HTMLButtonElement>("btn-view-service-ocr-log").addEventListener("click", () => {
      this.toggleServiceLogView("ocr");
    });
    this.must<HTMLButtonElement>("btn-view-service-tts-log").addEventListener("click", () => {
      this.toggleServiceLogView("tts");
    });
    this.must<HTMLInputElement>("capture-draw-rectangle").addEventListener("change", () => {
      this.syncConfigFromInputs();
      void this.syncElectronCaptureRectangleSetting();
    });
    for (const key of this.getConfigurableHotkeyKeys()) {
      this.must<HTMLSelectElement>(this.getHotkeySoundSelectId(key)).addEventListener("change", () => this.syncFeedbackSoundsOnly());
      this.must<HTMLInputElement>(this.getHotkeySoundVolumeId(key)).addEventListener("input", () => this.syncFeedbackSoundsOnly());
      this.must<HTMLButtonElement>(this.getHotkeySoundPreviewButtonId(key)).addEventListener("click", () => {
        void this.previewHotkeySound(key);
      });
    }
    this.must<HTMLSelectElement>("global-error-sound-id").addEventListener("change", () => this.syncFeedbackSoundsOnly());
    this.must<HTMLInputElement>("global-error-sound-volume").addEventListener("input", () => this.syncFeedbackSoundsOnly());
    this.must<HTMLButtonElement>("btn-global-error-sound-preview").addEventListener("click", () => {
      void this.playHotkeySound(this.config.system.feedbackSounds.globalError.soundId, this.config.system.feedbackSounds.globalError.volume);
    });

    this.must<HTMLButtonElement>("btn-export-settings").addEventListener("click", () => this.exportSettings());
    this.must<HTMLButtonElement>("btn-import-settings").addEventListener("click", () => {
      this.must<HTMLInputElement>("import-settings-file").click();
    });
    this.must<HTMLInputElement>("import-settings-file").addEventListener("change", (event) => {
      void this.importSettings(event);
    });
    this.must<HTMLButtonElement>("btn-reset-settings").addEventListener("click", () => {
      Object.assign(this.config, JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as AppConfig);
      this.applySelectedLlmProviderSettings();
      this.applySelectedTtsProviderSettings();
      this.renderConfig();
      this.store.save(this.config);
      this.updateTimelineFromRawText();
      void this.syncAllElectronHotkeysFromSettings();
      void this.applyAutoReaderSettings();
      void this.syncElectronOverlayTheme();
      void this.applyClipboardWatcherEnabledSetting();
      void this.syncElectronCaptureRectangleSetting();
      this.setStatus(this.t("status.settingsReset"));
    });

    for (const key of this.getConfigurableHotkeyKeys()) {
      this.bindHotkeyButtons(key);
    }

    const rawTextEl = this.must<HTMLTextAreaElement>("raw-text");
    rawTextEl.addEventListener("beforeinput", (event) => {
      const inputEvent = event as InputEvent;
      const inputType = inputEvent.inputType ?? "";
      const fullSelection = rawTextEl.selectionStart === 0 && rawTextEl.selectionEnd === rawTextEl.value.length;
      const isReplacementInput = inputType.startsWith("insert") || inputType.startsWith("delete");
      this.pendingFullDocumentReplace = fullSelection && rawTextEl.value.length > 0 && isReplacementInput;
    });
    rawTextEl.addEventListener("input", () => {
      this.markUserTyping();
      const treatAsNewDocument = this.pendingFullDocumentReplace;
      this.pendingFullDocumentReplace = false;
      this.reconcileText(this.getPlaybackText(), { source: "user", treatAsNewDocument });
    });
    rawTextEl.addEventListener("click", () => this.handleUserCaretMovement());
    rawTextEl.addEventListener("keyup", () => this.handleUserCaretMovement());
    rawTextEl.addEventListener("select", () => this.handleUserCaretMovement());
  }

  private syncConfigFromInputs(): void {
    this.config.llm.provider = this.must<HTMLSelectElement>("llm-provider").value === "gemini_sdk" ? "gemini_sdk" : "openai_compatible";
    this.syncLlmInputsToActiveConfig();
    const detectionMode = this.must<HTMLSelectElement>("detector-mode").value;
    this.config.textProcessing.detectionMode = detectionMode === "off"
      || detectionMode === "fullscreen_only"
      || detectionMode === "fullscreen_and_window"
      || detectionMode === "all"
      ? detectionMode
      : "off";
    this.config.textProcessing.detectorBaseUrl = this.must<HTMLInputElement>("detector-url").value;
    this.config.services.externalRoot = this.must<HTMLInputElement>("services-external-root").value.trim();
    this.config.tts.provider = this.must<HTMLSelectElement>("tts-provider").value === "gemini_sdk" ? "gemini_sdk" : "openai_compatible";
    this.syncTtsInputsToActiveConfig();
    const minWords = Number(this.must<HTMLInputElement>("chunk-min").value);
    const maxWords = Number(this.must<HTMLInputElement>("chunk-max").value);
    this.config.reading.minWordsPerChunk = Number.isFinite(minWords) ? Math.max(1, Math.floor(minWords)) : 1;
    this.config.reading.maxWordsPerChunk = Number.isFinite(maxWords)
      ? Math.max(this.config.reading.minWordsPerChunk, Math.floor(maxWords))
      : this.config.reading.minWordsPerChunk;
    this.config.reading.cleanTextBeforeTts = this.must<HTMLInputElement>("clean-text-before-tts").checked;
    this.config.reading.lowercaseTextBeforeTts = this.must<HTMLInputElement>("lowercase-text-before-tts").checked;
    this.config.reading.wpmBase = Number(this.must<HTMLInputElement>("wpm").value);
    this.config.reading.streamWindowSize = Math.max(1, Math.floor(Number(this.must<HTMLInputElement>("stream-window-size").value) || 1));
    this.config.reading.chunkRequestConcurrency = Math.max(
      1,
      Math.floor(Number(this.must<HTMLInputElement>("chunk-concurrency").value) || 1)
    );
    this.config.reading.chunkRetryCount = Math.max(0, Math.floor(Number(this.must<HTMLInputElement>("chunk-retry-count").value) || 0));
    this.config.reading.chunkTimeoutMs = Math.max(1000, Math.floor(Number(this.must<HTMLInputElement>("chunk-timeout-ms").value) || 30000));
    this.config.reading.largeEditResetRatio = Math.max(
      0,
      Math.min(1, Number(this.must<HTMLInputElement>("large-edit-reset-ratio").value) || 0.35)
    );
    this.config.reading.failureCooldownMs = Math.max(0, Math.floor(Number(this.must<HTMLInputElement>("failure-cooldown-ms").value) || 0));
    this.config.reading.sessionChunkCacheLimit = Math.max(
      10,
      Math.floor(Number(this.must<HTMLInputElement>("session-chunk-cache-limit").value) || 300)
    );
    this.config.reading.sessionAudioByteLimit = Math.max(
      1000000,
      Math.floor(Number(this.must<HTMLInputElement>("session-audio-byte-limit").value) || 120000000)
    );
    const punctuationMode = this.must<HTMLSelectElement>("punctuation-pause").value;
    this.config.reading.punctuationPauseMode = ["off", "low", "medium", "high"].includes(punctuationMode)
      ? (punctuationMode as AppConfig["reading"]["punctuationPauseMode"])
      : "low";
    this.config.system.diagnosticsEnabled = this.must<HTMLInputElement>("diagnostics-enabled").checked;
    this.config.system.autoReaderAdvanceHotkey = this.must<HTMLInputElement>("auto-reader-advance-hotkey").value.trim().toLowerCase()
      || DEFAULT_CONFIG.system.autoReaderAdvanceHotkey;
    this.config.system.autoReaderAdvanceDelayMs = Math.max(
      0,
      Math.min(60000, Math.floor(Number(this.must<HTMLInputElement>("auto-reader-advance-delay-ms").value) || DEFAULT_CONFIG.system.autoReaderAdvanceDelayMs))
    );
    this.config.system.autoReaderNoTextRetryCount = Math.max(
      0,
      Math.min(
        MAX_AUTO_READER_NO_TEXT_RETRY_COUNT,
        Math.floor(Number(this.must<HTMLInputElement>("auto-reader-no-text-retry-count").value) || DEFAULT_CONFIG.system.autoReaderNoTextRetryCount)
      )
    );
    this.config.system.clipboardWatcherEnabled = this.must<HTMLInputElement>("clipboard-watcher-enabled").checked;
    this.config.system.captureDrawRectangle = this.must<HTMLInputElement>("capture-draw-rectangle").checked;
    this.syncFeedbackSoundsFromInputs();
    this.config.ui.showChunkDiagnostics = this.must<HTMLInputElement>("show-chunk-diagnostics").checked;
    this.config.ui.language = this.must<HTMLSelectElement>("ui-language").value === "ar" ? "ar" : "en";
    this.saveActiveLlmToSelectedProvider();
    this.saveActiveTtsToSelectedProvider();
    this.applyUiState();
    this.store.save(this.config);
    this.updateTimelineFromRawText();
  }

  private syncFeedbackSoundsFromInputs(): void {
    for (const key of this.getConfigurableHotkeyKeys()) {
      const soundId = this.must<HTMLSelectElement>(this.getHotkeySoundSelectId(key)).value as HotkeySoundId;
      const volume = Number(this.must<HTMLInputElement>(this.getHotkeySoundVolumeId(key)).value);
      this.config.system.feedbackSounds.byHotkey[key] = {
        soundId: HOTKEY_SOUND_OPTIONS.includes(soundId) ? soundId : DEFAULT_CONFIG.system.feedbackSounds.byHotkey[key].soundId,
        volume: Number.isFinite(volume) ? Math.max(0, Math.min(100, Math.round(volume))) : DEFAULT_CONFIG.system.feedbackSounds.byHotkey[key].volume
      };
    }
    const globalErrorSoundId = this.must<HTMLSelectElement>("global-error-sound-id").value as HotkeySoundId;
    const globalErrorVolume = Number(this.must<HTMLInputElement>("global-error-sound-volume").value);
    this.config.system.feedbackSounds.globalError = {
      soundId: HOTKEY_SOUND_OPTIONS.includes(globalErrorSoundId) ? globalErrorSoundId : DEFAULT_CONFIG.system.feedbackSounds.globalError.soundId,
      volume: Number.isFinite(globalErrorVolume)
        ? Math.max(0, Math.min(100, Math.round(globalErrorVolume)))
        : DEFAULT_CONFIG.system.feedbackSounds.globalError.volume
    };
    this.renderHotkeySoundControls();
  }

  private syncFeedbackSoundsOnly(): void {
    this.syncFeedbackSoundsFromInputs();
    this.store.save(this.config);
  }

  private renderHotkeySoundControls(): void {
    for (const key of this.getConfigurableHotkeyKeys()) {
      const current = this.config.system.feedbackSounds.byHotkey[key];
      this.renderHotkeySoundSelect(this.getHotkeySoundSelectId(key), current.soundId);
      this.must<HTMLInputElement>(this.getHotkeySoundVolumeId(key)).value = String(current.volume);
      this.must<HTMLDivElement>(this.getHotkeySoundVolumeValueId(key)).textContent = `${current.volume}%`;
      this.must<HTMLButtonElement>(this.getHotkeySoundPreviewButtonId(key)).textContent = this.t("action.preview");
    }
    this.renderHotkeySoundSelect("global-error-sound-id", this.config.system.feedbackSounds.globalError.soundId);
    this.must<HTMLInputElement>("global-error-sound-volume").value = String(this.config.system.feedbackSounds.globalError.volume);
    this.must<HTMLDivElement>("global-error-sound-volume-value").textContent = `${this.config.system.feedbackSounds.globalError.volume}%`;
    this.must<HTMLButtonElement>("btn-global-error-sound-preview").textContent = this.t("action.preview");
    for (const label of Array.from(document.querySelectorAll<HTMLLabelElement>("[for$='-sound-id']"))) {
      const wrapper = label.closest("[data-hotkey-sound-controls]");
      if (!wrapper) continue;
      label.textContent = wrapper.getAttribute("data-hotkey-sound-controls") === "globalError"
        ? this.t("system.errorSound")
        : this.t("system.soundEffect");
    }
    for (const label of Array.from(document.querySelectorAll<HTMLLabelElement>("[for$='-sound-volume'], [for='global-error-sound-volume']"))) {
      label.textContent = this.t("system.soundVolume");
    }
  }

  private renderHotkeySoundSelect(id: string, selected: HotkeySoundId): void {
    const select = this.must<HTMLSelectElement>(id);
    const previous = select.value;
    select.innerHTML = "";
    for (const soundId of HOTKEY_SOUND_OPTIONS) {
      const option = document.createElement("option");
      option.value = soundId;
      option.textContent = this.t(`sound.${soundId}` as TranslationKey);
      option.selected = soundId === selected || (!selected && soundId === previous);
      select.appendChild(option);
    }
    select.value = HOTKEY_SOUND_OPTIONS.includes(selected) ? selected : HOTKEY_SOUND_OPTIONS[0]!;
  }

  private async previewHotkeySound(key: ConfigurableHotkeyKey): Promise<void> {
    const sound = this.config.system.feedbackSounds.byHotkey[key];
    await this.playHotkeySound(sound.soundId, sound.volume);
  }

  private async playHotkeySound(soundId: HotkeySoundId, volume: number): Promise<void> {
    const audio = new Audio(HOTKEY_SOUND_URLS[soundId]);
    audio.preload = "auto";
    audio.volume = Math.max(0, Math.min(1, volume / 100));
    const release = (): void => {
      audio.removeEventListener("ended", release);
      audio.removeEventListener("error", release);
      this.activeHotkeyAudios.delete(audio);
    };
    audio.addEventListener("ended", release, { once: true });
    audio.addEventListener("error", release, { once: true });
    this.activeHotkeyAudios.add(audio);
    try {
      await audio.play();
    } catch {
      release();
      // Best effort preview/feedback.
    }
  }

  private async playConfiguredHotkeyFeedback(key: ConfigurableHotkeyKey): Promise<void> {
    const sound = this.config.system.feedbackSounds.byHotkey[key];
    await this.playHotkeySound(sound.soundId, sound.volume);
  }

  private async playConfiguredErrorFeedback(): Promise<void> {
    const sound = this.config.system.feedbackSounds.globalError;
    await this.playHotkeySound(sound.soundId, sound.volume);
  }

  private markHotkeyFeedback(key: ConfigurableHotkeyKey): void {
    this.lastHotkeyFeedbackAt[key] = Date.now();
  }

  private shouldUseHotkeyFeedbackFallback(key: ConfigurableHotkeyKey): boolean {
    const lastAt = this.lastHotkeyFeedbackAt[key] ?? 0;
    return Date.now() - lastAt > 750;
  }

  private handleHotkeyFeedback(event: HotkeyFeedbackEvent): void {
    this.markHotkeyFeedback(event.hotkey);
    if (event.phase === "error") {
      void this.playConfiguredErrorFeedback();
      if (event.message) {
        this.setStatus(event.message);
      }
      return;
    }
    void this.playConfiguredHotkeyFeedback(event.hotkey);
  }

  private syncLlmInputsToActiveConfig(): void {
    this.config.llm.baseUrl = this.must<HTMLInputElement>("llm-url").value;
    this.config.llm.apiKey = this.must<HTMLInputElement>("llm-key").value;
    this.config.llm.promptTemplate = this.must<HTMLInputElement>("llm-prompt").value;
    this.config.llm.imageDetail = this.must<HTMLSelectElement>("llm-image-detail").value as AppConfig["llm"]["imageDetail"];
    const maxTokens = Number(this.must<HTMLInputElement>("llm-max-tokens").value);
    this.config.llm.maxTokens = Number.isFinite(maxTokens) && maxTokens > 0 ? Math.floor(maxTokens) : 4096;
    this.config.llm.thinkingMode = this.readThinkingMode("llm-thinking-mode");
  }

  private syncTtsInputsToActiveConfig(): void {
    this.config.tts.baseUrl = this.must<HTMLInputElement>("tts-url").value;
    this.config.tts.apiKey = this.must<HTMLInputElement>("tts-key").value;
    this.config.tts.thinkingMode = this.readThinkingMode("tts-thinking-mode");
  }

  private readThinkingMode(id: "llm-thinking-mode" | "tts-thinking-mode"): "provider_default" | "low" | "off" {
    const value = this.must<HTMLSelectElement>(id).value;
    return value === "provider_default" || value === "low" ? value : "off";
  }

  private renderConfig(): void {
    this.must<HTMLSelectElement>("ui-language").value = this.config.ui.language;
    this.must<HTMLSelectElement>("llm-provider").value = this.currentOcrProvider();
    this.must<HTMLInputElement>("llm-url").value = this.config.llm.baseUrl;
    this.must<HTMLInputElement>("llm-key").value = this.config.llm.apiKey;
    this.must<HTMLInputElement>("llm-prompt").value = this.config.llm.promptTemplate;
    this.must<HTMLSelectElement>("llm-image-detail").value = this.config.llm.imageDetail;
    this.must<HTMLInputElement>("llm-max-tokens").value = String(this.config.llm.maxTokens);
    this.must<HTMLSelectElement>("llm-thinking-mode").value = this.config.llm.thinkingMode;
    this.must<HTMLSelectElement>("detector-mode").value = this.config.textProcessing.detectionMode;
    this.must<HTMLInputElement>("detector-url").value = this.config.textProcessing.detectorBaseUrl;
    this.must<HTMLInputElement>("services-external-root").value = this.config.services.externalRoot;
    this.must<HTMLSelectElement>("tts-provider").value = this.currentTtsProvider();
    this.must<HTMLInputElement>("tts-url").value = this.config.tts.baseUrl;
    this.must<HTMLInputElement>("tts-key").value = this.config.tts.apiKey;
    this.must<HTMLSelectElement>("tts-thinking-mode").value = this.config.tts.thinkingMode;
    this.must<HTMLInputElement>("chunk-min").value = String(this.config.reading.minWordsPerChunk);
    this.must<HTMLInputElement>("chunk-max").value = String(this.config.reading.maxWordsPerChunk);
    this.must<HTMLInputElement>("clean-text-before-tts").checked = this.config.reading.cleanTextBeforeTts;
    this.must<HTMLInputElement>("lowercase-text-before-tts").checked = this.config.reading.lowercaseTextBeforeTts;
    this.must<HTMLInputElement>("wpm").value = String(this.config.reading.wpmBase);
    this.must<HTMLInputElement>("stream-window-size").value = String(this.config.reading.streamWindowSize);
    this.must<HTMLInputElement>("chunk-concurrency").value = String(this.config.reading.chunkRequestConcurrency);
    this.must<HTMLInputElement>("chunk-retry-count").value = String(this.config.reading.chunkRetryCount);
    this.must<HTMLInputElement>("chunk-timeout-ms").value = String(this.config.reading.chunkTimeoutMs);
    this.must<HTMLInputElement>("large-edit-reset-ratio").value = String(this.config.reading.largeEditResetRatio);
    this.must<HTMLInputElement>("failure-cooldown-ms").value = String(this.config.reading.failureCooldownMs);
    this.must<HTMLInputElement>("session-chunk-cache-limit").value = String(this.config.reading.sessionChunkCacheLimit);
    this.must<HTMLInputElement>("session-audio-byte-limit").value = String(this.config.reading.sessionAudioByteLimit);
    this.must<HTMLSelectElement>("punctuation-pause").value = this.config.reading.punctuationPauseMode;
    this.must<HTMLInputElement>("diagnostics-enabled").checked = this.config.system.diagnosticsEnabled;
    this.must<HTMLInputElement>("auto-reader-advance-hotkey").value = this.config.system.autoReaderAdvanceHotkey;
    this.must<HTMLInputElement>("auto-reader-advance-delay-ms").value = String(this.config.system.autoReaderAdvanceDelayMs);
    this.must<HTMLInputElement>("auto-reader-no-text-retry-count").value = String(this.config.system.autoReaderNoTextRetryCount);
    this.must<HTMLInputElement>("clipboard-watcher-enabled").checked = this.config.system.clipboardWatcherEnabled;
    this.must<HTMLInputElement>("capture-draw-rectangle").checked = this.config.system.captureDrawRectangle;
    this.renderHotkeyInputs();
    this.renderHotkeySoundControls();
    if (window.electronAPI) {
      for (const key of this.getConfigurableHotkeyKeys()) {
        const binding = this.getHotkeyBindingConfig(key);
        this.setHotkeyRecordingStatus(key, this.getHotkeyStatus(this.config.system[binding.systemKey]));
      }
    } else {
      this.setAllHotkeyRecordingStatuses(this.t("hotkey.electronOnly"));
    }
    this.renderHotkeyButtonState();
    this.must<HTMLInputElement>("show-chunk-diagnostics").checked = this.config.ui.showChunkDiagnostics;
    this.must<HTMLSelectElement>("log-level").value = this.config.logging.level;
    this.must<HTMLInputElement>("log-console-enabled").checked = this.config.logging.enableConsoleLogging;
    this.must<HTMLInputElement>("log-file-enabled").checked = this.config.logging.enableFileLogging;
    this.must<HTMLInputElement>("vol-slider").value = String(this.config.ui.volume);
    this.must<HTMLInputElement>("vol-input").value = String(this.config.ui.volume);
    this.must<HTMLDivElement>("settings-last-import").textContent = this.config.system.lastImportAt
      ? this.t("settings.lastImport", { timestamp: this.config.system.lastImportAt })
      : this.t("settings.noImportYet");

    this.audio.volume = Math.max(0, Math.min(1, this.config.ui.volume / 100));
    this.applyPlaybackRateValue(this.config.ui.playbackRate, false);

    this.applyUiState();
    this.applyLanguage();
    this.renderProviderVisibility();

    this.applyOptions(this.llmModelSelect, [{ value: this.config.llm.model, label: this.config.llm.model }], this.config.llm.model);
    this.applyOptions(this.ttsModelSelect, [{ value: this.config.tts.model, label: this.config.tts.model }], this.config.tts.model);
    this.applyOptions(this.ttsVoiceSelect, [{ value: this.config.tts.voice, label: this.config.tts.voice }], this.config.tts.voice);
    this.applyDetectorHealthGate();
    this.updateStatusChip(
      "detector-status-chip",
      this.detectorHealthy ? this.describeDetectionMode(this.config.textProcessing.detectionMode) : this.t("statuschip.unreachable"),
      this.detectorHealthy ? "idle" : "error"
    );
    this.renderDiscoveredServicesDashboard();
    this.renderAlwaysOnTopButton();
    this.renderMainPreviewOverlay();
  }

  private renderAlwaysOnTopButton(): void {
    const button = document.getElementById("btn-always-on-top");
    if (!(button instanceof HTMLButtonElement)) return;
    const isElectron = Boolean(window.electronAPI?.getAlwaysOnTop && window.electronAPI?.setAlwaysOnTop);
    button.disabled = !isElectron;
    button.classList.toggle("active", isElectron && this.alwaysOnTopEnabled);
    button.setAttribute("aria-pressed", this.alwaysOnTopEnabled ? "true" : "false");
    button.title = this.t("actions.alwaysOnTop");
  }

  private async syncAlwaysOnTopButton(): Promise<void> {
    if (!window.electronAPI?.getAlwaysOnTop) {
      this.alwaysOnTopEnabled = false;
      this.renderAlwaysOnTopButton();
      return;
    }
    this.alwaysOnTopEnabled = await window.electronAPI.getAlwaysOnTop();
    this.renderAlwaysOnTopButton();
  }

  private async syncElectronOverlayTheme(): Promise<void> {
    if (!window.electronAPI?.setOverlayTheme) return;
    try {
      await window.electronAPI.setOverlayTheme(this.resolveActiveTheme());
    } catch (error) {
      loggers.settings.warn("Failed to sync overlay theme", {
        error: String(error),
        theme: this.resolveActiveTheme()
      });
    }
  }

  private applyUiState(): void {
    const shell = this.must<HTMLElement>("app-shell");
    shell.dataset.theme = this.resolveActiveTheme();
    shell.dataset.settingsOpen = this.config.ui.settingsDrawerOpen ? "true" : "false";
    shell.dataset.settingsPeek = this.settingsPeekOpen ? "true" : "false";
    shell.dataset.language = this.config.ui.language;
    shell.dataset.density = "comfortable";
    shell.dataset.showAdvanced = "true";
    shell.dataset.showDiagnostics = this.config.ui.showChunkDiagnostics ? "true" : "false";

    this.must<HTMLElement>("settings-drawer").setAttribute("aria-hidden", this.config.ui.settingsDrawerOpen ? "false" : "true");

    this.must<HTMLInputElement>("ui-dark-mode").checked = this.config.ui.darkMode;
    this.must<HTMLButtonElement>("theme-zen").classList.toggle("active", this.config.ui.theme === "zen");
    this.must<HTMLButtonElement>("theme-pink").classList.toggle("active", this.config.ui.theme === "pink");
    shell.style.setProperty("--workspace-left", `${this.config.ui.panels.desktop.leftPanePercent}%`);
    shell.style.setProperty("--workspace-right-top", `${this.config.ui.panels.desktop.rightTopPercent}%`);
    shell.style.setProperty("--mobile-image-height", `${this.config.ui.panels.mobile.imageHeightPercent}%`);
    shell.style.setProperty("--mobile-editor-height", `${this.config.ui.panels.mobile.editorHeightPercent}%`);
    shell.style.setProperty("--mobile-preview-height", `${this.config.ui.panels.mobile.previewHeightPercent}%`);

    this.must<HTMLElement>("pane-image").dataset.collapsed = this.config.ui.panels.mobile.collapsed.image ? "true" : "false";
    this.must<HTMLElement>("pane-editor").dataset.collapsed = this.config.ui.panels.mobile.collapsed.editor ? "true" : "false";
    this.must<HTMLElement>("pane-reading").dataset.collapsed = this.config.ui.panels.mobile.collapsed.preview ? "true" : "false";
  }

  private describeDetectionMode(mode: AppConfig["textProcessing"]["detectionMode"]): string {
    switch (mode) {
      case "fullscreen_only":
        return this.t("detection.mode.fullscreen_only");
      case "fullscreen_and_window":
        return this.t("detection.mode.fullscreen_and_window");
      case "all":
        return this.t("detection.mode.all");
      default:
        return this.t("detection.mode.off");
    }
  }

  private mergeTextProcessingConfig(textProcessing: unknown): AppConfig["textProcessing"] {
    const defaults = DEFAULT_CONFIG.textProcessing;
    if (!textProcessing || typeof textProcessing !== "object") {
      return defaults;
    }

    const value = textProcessing as Record<string, unknown>;
    const detectionMode = value.detectionMode;
    const rapidMode = value.rapidMode;
    const legacyRapidEnabled = value.rapidEnabled;
    const detectorProvider = value.detectorProvider;
    const detectorBaseUrls = (value.detectorBaseUrls as Record<string, unknown> | undefined) ?? {};
    const legacyRapidBaseUrl = typeof value.rapidBaseUrl === "string" && value.rapidBaseUrl.trim()
      ? value.rapidBaseUrl
      : defaults.detectorBaseUrl;
    const migratedProvider = detectorProvider === "rapid" || detectorProvider === "paddle"
      ? detectorProvider
      : "rapid";
    const migratedProviderUrl = typeof detectorBaseUrls[migratedProvider] === "string" && String(detectorBaseUrls[migratedProvider]).trim()
      ? String(detectorBaseUrls[migratedProvider]).trim()
      : undefined;
    const explicitDetectorBaseUrl = typeof value.detectorBaseUrl === "string" && value.detectorBaseUrl.trim()
      ? value.detectorBaseUrl.trim()
      : undefined;

    return {
      detectionMode: detectionMode === "off" || detectionMode === "fullscreen_only" || detectionMode === "fullscreen_and_window" || detectionMode === "all"
        ? detectionMode
        : (rapidMode === "off" || rapidMode === "fullscreen_only" || rapidMode === "fullscreen_and_window" || rapidMode === "all"
            ? rapidMode
            : (legacyRapidEnabled === true ? "all" : defaults.detectionMode)),
      detectorBaseUrl: explicitDetectorBaseUrl ?? migratedProviderUrl ?? legacyRapidBaseUrl
    };
  }

  private shouldUseDetector(captureContext?: CaptureContext): boolean {
    const mode = this.config.textProcessing.detectionMode;
    if (mode === "off") return false;
    if (captureContext?.source === "clipboard_watch") return mode === "all";
    if (mode === "all") return true;
    if (captureContext?.source !== "hotkey") return false;
    if (mode === "fullscreen_only") return captureContext.captureKind === "fullscreen";
    return captureContext.captureKind === "fullscreen" || captureContext.captureKind === "window";
  }

  private applyDetectorHealthGate(): void {
    for (const group of Array.from(document.querySelectorAll<HTMLElement>("[data-detector-dependent-main]"))) {
      group.classList.toggle("section-disabled", !this.detectorHealthy);
      const controls = group.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>("input, button, select");
      for (const control of Array.from(controls)) {
        control.disabled = !this.detectorHealthy;
      }
    }
  }

  private getDetectorBaseUrl(): string {
    return this.config.textProcessing.detectorBaseUrl;
  }

  private resolveActiveTheme(): UiTheme {
    if (!this.config.ui.darkMode) {
      return this.config.ui.theme;
    }
    return this.config.ui.theme === "pink" ? "dark-pink" : "dark-zen";
  }

  private setTheme(theme: BaseUiTheme): void {
    this.config.ui.theme = theme;
    this.applyUiState();
    this.store.save(this.config);
    void this.syncElectronOverlayTheme();
  }

  private exportSettings(): void {
    const payload = JSON.stringify(this.config, null, 2);
    const blob = new Blob([payload], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "tts-anywhere-settings.json";
    a.click();
    URL.revokeObjectURL(url);
    this.setStatus(this.t("status.settingsExported"));
  }

  private async importSettings(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as Partial<AppConfig>;
      const mergedPanels = this.mergePanels(parsed.ui?.panels);
      const merged: AppConfig = {
        llm: { ...DEFAULT_CONFIG.llm, ...parsed.llm },
        tts: { ...DEFAULT_CONFIG.tts, ...parsed.tts },
        reading: { ...DEFAULT_CONFIG.reading, ...parsed.reading },
        ui: {
          ...DEFAULT_CONFIG.ui,
          ...parsed.ui,
          playbackRate: sanitizePlaybackRate(parsed.ui?.playbackRate, DEFAULT_CONFIG.ui.playbackRate),
          language: parsed.ui?.language === "ar" || parsed.ui?.language === "en" ? parsed.ui.language : DEFAULT_CONFIG.ui.language,
          panels: mergedPanels
        },
        system: { ...DEFAULT_CONFIG.system, ...parsed.system },
        logging: { ...DEFAULT_CONFIG.logging, ...parsed.logging },
        textProcessing: this.mergeTextProcessingConfig(parsed.textProcessing),
        services: { ...DEFAULT_CONFIG.services, ...parsed.services },
        preprocessing: {
          ...DEFAULT_CONFIG.preprocessing,
          ...parsed.preprocessing,
          detectionFilter: {
            ...DEFAULT_CONFIG.preprocessing.detectionFilter,
            ...parsed.preprocessing?.detectionFilter
          },
          merge: {
            ...DEFAULT_CONFIG.preprocessing.merge,
            ...parsed.preprocessing?.merge
          },
          sorting: {
            ...DEFAULT_CONFIG.preprocessing.sorting,
            ...parsed.preprocessing?.sorting
          },
          selection: { ...DEFAULT_CONFIG.preprocessing.selection }
        }
      };
      Object.assign(this.config, merged);
      this.config.system.lastImportAt = new Date().toISOString();
      this.renderConfig();
      this.updateTimelineFromRawText();
      this.store.save(this.config);
      void this.syncAllElectronHotkeysFromSettings();
      void this.syncElectronOverlayTheme();
      void this.applyClipboardWatcherEnabledSetting();
      void this.syncElectronCaptureRectangleSetting();
      this.setStatus(this.t("status.settingsImported"));
      loggers.settings.info("Settings imported");
    } catch (error) {
      this.setStatus(this.t("status.importFailed", { error: String(error) }));
    } finally {
      input.value = "";
    }
  }

  private updateStatusChip(id: string, text: string, state: "ok" | "error" | "idle"): void {
    const chip = this.must<HTMLSpanElement>(id);
    chip.textContent = text;
    chip.classList.remove("ok", "error");
    if (state !== "idle") {
      chip.classList.add(state);
    }
  }

  private refreshChunkDiagnostics(): void {
    // Diagnostics were intentionally simplified out of the playback flow.
  }

  private bindBreak(): void {
    const btn = this.must<HTMLButtonElement>("btn-break");
    btn.disabled = true;
    btn.addEventListener("click", () => {
      void this.abortAllWork("user");
    });
  }

  private bindExit(): void {
    this.must<HTMLButtonElement>("btn-exit-app").addEventListener("click", async () => {
      if (!window.electronAPI?.requestExit) {
        this.setStatus(this.t("stack.electronOnly"));
        return;
      }
      if (!window.confirm(this.t("actions.exitConfirm"))) {
        return;
      }
      await window.electronAPI.requestExit();
    });
  }

  private updateBreakButtonState(): void {
    const btn = this.must<HTMLButtonElement>("btn-break");
    btn.disabled = !this.hasActiveWork();
  }

  private hasActiveWork(): boolean {
    return this.runInProgress || this.chunkPlaybackMode || !this.audio.paused || this.chunkInFlightById.size > 0 || this.modalAbortController !== null || this.ocrStreaming;
  }

  private isAbortError(error: unknown): boolean {
    const text = String((error as { message?: unknown })?.message ?? error).toLowerCase();
    return text.includes("abort") || text.includes("cancel");
  }

  private isEmptyOcrError(error: unknown): boolean {
    const text = String((error as { message?: unknown })?.message ?? error).toLowerCase();
    return text.includes("ocr produced empty text");
  }

  private throwIfStale(runId: number): void {
    if (runId !== this.activeRunId || this.activeRunAbortController?.signal.aborted) {
      throw new Error("Cancelled");
    }
  }

  private startRun(): { runId: number; signal: AbortSignal } {
    const lane = this.requestPreemptor.beginLane("ocr");
    this.activeRunAbortController = new AbortController();
    if (lane.signal.aborted) {
      this.activeRunAbortController.abort();
    } else {
      lane.signal.addEventListener("abort", () => this.activeRunAbortController?.abort(), { once: true });
    }
    this.activeRunId += 1;
    this.runInProgress = true;
    this.updateBreakButtonState();
    return { runId: this.activeRunId, signal: this.activeRunAbortController.signal };
  }

  private finishRun(runId: number): void {
    if (runId !== this.activeRunId) return;
    this.runInProgress = false;
    this.activeRunAbortController = null;
    this.updateBreakButtonState();
  }

  private async abortAllWork(reason: "user" | "superseded"): Promise<void> {
    if (this.autoReaderSessionRunId !== null) {
      await this.reportAutoReaderPageResult({
        runId: this.autoReaderSessionRunId,
        outcome: "cancelled",
        message: reason === "user" ? "Automatic reader cancelled." : "Automatic reader was interrupted by newer work."
      });
    }
    this.requestPreemptor.preemptAll();
    this.cancelVisionControllers();
    this.preprocessModal?.abortRunningWork();
    this.setRawTextLock(false);
    this.ocrStreaming = false;
    this.ocrStreamDone = false;
    this.activeOcrRequests = 0;
    this.ocrStreamSession += 1;
    this.activeRunId += 1;
    this.runInProgress = false;
    this.abortPlaybackAndSynthesis();
    if (reason === "user") {
      this.setStatus("Stopped");
    }
    this.updateBreakButtonState();
  }

  private async abortVisionWork(
    reason: "new_image" | "superseded",
    options: { preserveAutoReaderSession?: boolean; preservePlayback?: boolean } = {}
  ): Promise<void> {
    const { preserveAutoReaderSession = false, preservePlayback = false } = options;
    if (!preserveAutoReaderSession && this.autoReaderSessionRunId !== null) {
      await this.reportAutoReaderPageResult({
        runId: this.autoReaderSessionRunId,
        outcome: "cancelled",
        message: "Automatic reader was interrupted by a newer image."
      });
    }
    this.requestPreemptor.preemptLane("ocr");
    this.requestPreemptor.preemptLane("detect_main");
    this.requestPreemptor.preemptLane("detect_modal");
    this.cancelVisionControllers();
    this.preprocessModal?.abortRunningWork();
    this.setRawTextLock(false);
    this.ocrStreaming = false;
    this.ocrStreamDone = false;
    this.activeOcrRequests = 0;
    this.ocrStreamSession += 1;
    this.activeRunId += 1;
    this.runInProgress = false;
    if (!preservePlayback) {
      this.abortPlaybackAndSynthesis();
    }
    loggers.pipeline.info("Vision work preempted", { reason });
    this.updateBreakButtonState();
  }

  private cancelVisionControllers(): void {
    this.activeRunAbortController?.abort();
    this.activeRunAbortController = null;
    this.modalAbortController?.abort();
    this.modalAbortController = null;
  }

  private bindCapture(): void {
    this.must<HTMLButtonElement>("btn-always-on-top").addEventListener("click", async () => {
      if (!window.electronAPI?.setAlwaysOnTop) return;
      this.alwaysOnTopEnabled = await window.electronAPI.setAlwaysOnTop(!this.alwaysOnTopEnabled);
      this.renderAlwaysOnTopButton();
      this.setStatus(this.alwaysOnTopEnabled ? this.t("status.alwaysOnTopEnabled") : this.t("status.alwaysOnTopDisabled"));
    });

    this.must<HTMLButtonElement>("btn-paste-image").addEventListener("click", async () => {
        loggers.capture.info("Paste image requested");
      try {
        await this.abortVisionWork("new_image");
        const dataUrl = await this.pasteImageFromClipboard();
        if (dataUrl) {
          await this.runPipeline(dataUrl, { source: "clipboard" });
          return;
        }
        this.setStatus(this.t("status.noImageClipboard"));
      } catch (error) {
        loggers.capture.error("Paste image failed", { error: String(error) });
        this.setStatus(this.t("status.pasteImageFailed", { error: String(error) }));
      }
    });

    this.must<HTMLInputElement>("image-upload").addEventListener("change", async (event) => {
      const input = event.currentTarget as HTMLInputElement;
      const file = input.files?.[0];
      if (!file) return;
      loggers.capture.info("Image uploaded", { fileName: file.name, type: file.type });
      await this.abortVisionWork("new_image");
      const dataUrl = await this.fileToDataUrl(file);
      await this.runPipeline(dataUrl, { source: "upload" });
    });

    this.must<HTMLButtonElement>("btn-extract").addEventListener("click", async () => {
      if (!this.lastOriginalImageDataUrl) {
        this.setStatus(this.t("status.loadImageFirst"));
        return;
      }
      try {
        await this.abortVisionWork("superseded");
        const ocrInput = await this.buildOcrInput(this.lastOriginalImageDataUrl);
        this.currentOcrImageDataUrl = ocrInput.imageDataUrl;
        this.currentOcrRegions = ocrInput.regions;
        this.setPreviewImage(ocrInput.imageDataUrl);
        this.renderMainPreviewOverlay();
        await this.runPreparedOcr();
      } catch (error) {
        this.setStatus(this.t("status.extractFailed", { error: String(error) }));
      }
    });

    document.addEventListener("paste", async (event) => {
      const items = Array.from(event.clipboardData?.items ?? []);
      for (const item of items) {
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) {
            loggers.capture.info("Image pasted");
            await this.abortVisionWork("new_image");
            await this.runPipeline(await this.fileToDataUrl(file), { source: "paste" });
          }
          return;
        }
      }
    });

    document.addEventListener("dragover", (event) => event.preventDefault());
    document.addEventListener("drop", async (event) => {
      event.preventDefault();
      const file = event.dataTransfer?.files?.[0];
      if (!file || !file.type.startsWith("image/")) return;
      loggers.capture.info("Image dropped", { fileName: file.name });
      await this.abortVisionWork("new_image");
      await this.runPipeline(await this.fileToDataUrl(file), { source: "drop" });
    });

    window.electronAPI?.onCapturedImage(async ({ dataUrl, captureKind, resultMode, hotkey, automation }) => {
      loggers.capture.info("Hotkey capture image received");
      const hotkeyKey: ConfigurableHotkeyKey = hotkey ?? (captureKind === "fullscreen"
        ? "fullCapture"
        : captureKind === "window"
          ? "activeWindowCapture"
          : resultMode === "clipboard"
            ? "ocrClipboard"
            : "capture");
      if (automation?.kind !== "auto_reader" && this.shouldUseHotkeyFeedbackFallback(hotkeyKey)) {
        void this.playConfiguredHotkeyFeedback(hotkeyKey);
      }
      await this.abortVisionWork("new_image", automation?.kind === "auto_reader"
        ? { preserveAutoReaderSession: true, preservePlayback: true }
        : undefined);
      const context = { source: "hotkey", captureKind, resultMode } as const;
      await this.runPipeline(
        dataUrl,
        automation === undefined ? context : { ...context, automation }
      );
    });

    window.electronAPI?.onCopiedTextForPlayback(async (text: string) => {
      if (this.shouldUseHotkeyFeedbackFallback("copyPlay")) {
        void this.playConfiguredHotkeyFeedback("copyPlay");
      }
      if (this.hasActiveWork()) await this.abortAllWork("superseded");
      await this.playIncomingText(text, "status.copiedTextPlaying");
    });
    window.electronAPI?.onClipboardWatcherItem(async (payload) => {
      if (this.hasActiveWork()) await this.abortAllWork("superseded");
      if (payload.kind === "text") {
        await this.playIncomingText(payload.text, "status.clipboardWatcherTextPlaying");
        return;
      }
      await this.runPipeline(payload.dataUrl, { source: "clipboard_watch" });
    });
    window.electronAPI?.onClipboardWatcherStateChanged((enabled) => {
      this.applyClipboardWatcherEnabledLocally(
        enabled,
        enabled ? "status.clipboardWatcherEnabled" : "status.clipboardWatcherDisabled"
      );
    });
    window.electronAPI?.onAbortRequested(() => {
      void this.playConfiguredHotkeyFeedback("abort");
      if (this.autoReaderSessionRunId !== null) {
        void this.reportAutoReaderPageResult({
          runId: this.autoReaderSessionRunId,
          outcome: "cancelled",
          message: "Automatic reader cancelled."
        });
      }
      void this.abortAllWork("user");
    });
    window.electronAPI?.onPlaybackHotkey((action) => {
      void this.handlePlaybackHotkey(action);
    });
    window.electronAPI?.onHotkeyFeedback((event) => {
      this.handleHotkeyFeedback(event);
    });
    void this.syncAlwaysOnTopButton();
    void this.syncElectronOverlayTheme();
  }

  private bindMainPreviewRenderer(): void {
    this.mainPreviewRenderer = new PreprocPreviewRenderer(
      {
        viewer: this.must<HTMLDivElement>("preview-viewer"),
        preview: this.must<HTMLImageElement>("preview-img"),
        overlay: this.must<HTMLDivElement>("preview-overlay"),
        overlaySvg: this.must<SVGSVGElement>("preview-overlay-svg"),
        selectionMask: this.must<HTMLCanvasElement>("preview-selection-mask"),
        manualLayer: this.must<HTMLDivElement>("preview-manual-layer"),
        drawPreview: this.must<HTMLDivElement>("preview-draw-preview")
      },
      {
        getThresholds: () => ({
          minWidthRatio: this.config.preprocessing.detectionFilter.minWidthRatio,
          minHeightRatio: this.config.preprocessing.detectionFilter.minHeightRatio,
          medianHeightFraction: this.config.preprocessing.detectionFilter.medianHeightFraction,
          mergeVerticalRatio: this.config.preprocessing.merge.mergeVerticalRatio,
          mergeHorizontalRatio: this.config.preprocessing.merge.mergeHorizontalRatio,
          mergeWidthRatioThreshold: this.config.preprocessing.merge.mergeWidthRatioThreshold
        })
      }
    );
    this.mainPreviewRenderer.startAutoSync();

    window.addEventListener("resize", () => this.renderMainPreviewOverlay());
    window.addEventListener("workspace:layout-change", () => this.mainPreviewRenderer?.requestRender());
  }

  private bindPreprocessModal(): void {
    const root = this.must<HTMLElement>("app-shell");
    this.preprocessModal = new PreprocessModalController({
      root,
      getConfig: () => this.config,
      saveConfig: (cfg) => {
        Object.assign(this.config, cfg);
        this.store.save(this.config);
        this.renderConfig();
      },
      getCurrentImageDataUrl: () => this.lastOriginalImageDataUrl,
      setStatus: (text) => this.setStatus(text),
      onCommitResult: (result) => {
        this.currentOcrImageDataUrl = result.processedImageDataUrl;
        this.currentOcrRegions = result.finalBoxes;
        this.currentDetectedRawBoxes = result.rawBoxes;
        this.currentFilterResults = result.filterResults;
        this.currentMergedGroups = result.finalBoxes.map((box) => ({
          rect: {
            id: box.id,
            norm: { x: box.nx, y: box.ny, w: box.nw, h: box.nh },
            px: { x1: 0, y1: 0, x2: 0, y2: 0 }
          },
          members: []
        }));
        this.currentFilterStats = result.filterStats;
        this.setPreviewImage(result.processedImageDataUrl);
        this.renderMainPreviewOverlay();
      },
      registerAbortController: (controller) => {
        this.modalAbortController = controller;
        this.updateBreakButtonState();
      },
      preemptLane: () => this.requestPreemptor.preemptLane("detect_modal"),
      beginLane: (parentSignal?: AbortSignal) => this.requestPreemptor.beginLane("detect_modal", parentSignal),
      isLaneCurrent: (token: number) => this.requestPreemptor.isCurrent("detect_modal", token)
    });

    this.must<HTMLButtonElement>("btn-preprocess-lab").addEventListener("click", async () => {
      await this.preprocessModal?.open();
    });

    this.must<HTMLDivElement>("preview-viewer").addEventListener("click", async () => {
      if (!this.lastOriginalImageDataUrl) return;
      await this.preprocessModal?.open();
    });
  }

  private async playIncomingText(
    text: string,
    statusKey: "status.copiedTextPlaying" | "status.clipboardWatcherTextPlaying"
  ): Promise<void> {
    const nextText = text.trim();
    if (!nextText) {
      this.setStatus(this.t("status.copyHotkeyNoText"));
      return;
    }
    this.setRawTextValuePreservingScroll(nextText);
    this.reconcileText(this.getPlaybackText(), { source: "user", finalizeTail: true, treatAsNewDocument: true });
    this.setStatus(this.t(statusKey));
    try {
      await this.startOrResumePlayback();
    } catch (error) {
      await this.playConfiguredErrorFeedback();
      this.setStatus(this.withApiBaseUrlHint(this.t("status.playbackFailed", { error: String(error) }), "tts", this.config.tts.baseUrl));
    }
  }

  private renderHotkeyInputs(): void {
    for (const key of this.getConfigurableHotkeyKeys()) {
      const binding = this.getHotkeyBindingConfig(key);
      this.must<HTMLInputElement>(binding.inputId).value = this.pendingHotkeys[key] ?? this.config.system[binding.systemKey];
    }
  }

  private setHotkeyRecordingStatus(key: ConfigurableHotkeyKey, message: string): void {
    const binding = this.getHotkeyBindingConfig(key);
    this.must<HTMLDivElement>(binding.statusId).textContent = message;
  }

  private setAllHotkeyRecordingStatuses(message: string): void {
    for (const key of this.getConfigurableHotkeyKeys()) {
      this.setHotkeyRecordingStatus(key, message);
    }
  }

  private getConfigurableHotkeyKeys(): ConfigurableHotkeyKey[] {
    return ["capture", "ocrClipboard", "fullCapture", "activeWindowCapture", "copyPlay", "autoReader", "clipboardWatcher", "abort", "playPause", "nextChunk", "previousChunk", "volumeUp", "volumeDown", "replayCapture"];
  }

  private renderHotkeyButtonState(): void {
    for (const key of this.getConfigurableHotkeyKeys()) {
      const binding = this.getHotkeyBindingConfig(key);
      const available = Boolean(binding.beginEdit);
      const editing = this.hotkeyRecordingState[key];
      const recordButton = this.must<HTMLButtonElement>(binding.recordButtonId);
      const clearButton = this.must<HTMLButtonElement>(binding.clearButtonId);
      const resetButton = this.must<HTMLButtonElement>(binding.resetButtonId);
      const applyButton = this.must<HTMLButtonElement>(binding.applyButtonId);
      const cancelButton = this.must<HTMLButtonElement>(binding.cancelButtonId);
      recordButton.hidden = editing;
      clearButton.hidden = editing;
      resetButton.hidden = editing;
      applyButton.hidden = !editing;
      cancelButton.hidden = !editing;
      recordButton.style.display = editing ? "none" : "";
      clearButton.style.display = editing ? "none" : "";
      resetButton.style.display = editing ? "none" : "";
      applyButton.style.display = editing ? "" : "none";
      cancelButton.style.display = editing ? "" : "none";
      recordButton.disabled = !available || this.hotkeyRecordingState[key];
      clearButton.disabled = !available || editing;
      resetButton.disabled = !available || editing || this.config.system[binding.systemKey] === this.getDefaultHotkeyValue(key);
      applyButton.disabled = !available || !this.pendingHotkeys[key];
      cancelButton.disabled = !available || !editing;
    }
  }

  private async syncAllElectronHotkeysFromSettings(): Promise<void> {
    for (const key of this.getConfigurableHotkeyKeys()) {
      await this.syncElectronHotkeyFromSettings(key);
    }
  }

  private async syncElectronHotkeyFromSettings(key: ConfigurableHotkeyKey): Promise<void> {
    const binding = this.getHotkeyBindingConfig(key);
    if (!binding.apply) return;
    try {
      const applied = await binding.apply(this.config.system[binding.systemKey]);
      this.config.system[binding.systemKey] = applied;
      this.pendingHotkeys[key] = null;
      this.hotkeyRecordingState[key] = false;
      this.stopHotkeyRecordingListener(key);
      this.must<HTMLInputElement>(binding.inputId).value = applied;
      this.setHotkeyRecordingStatus(key, this.getHotkeyStatus(applied));
      this.renderHotkeyButtonState();
      this.store.save(this.config);
    } catch (error) {
      this.setStatus(this.t("status.applySavedNamedHotkeyFailed", {
        name: this.t(this.getHotkeyLabelKey(key)),
        error: String(error)
      }));
    }
  }

  private async syncElectronCaptureRectangleSetting(): Promise<void> {
    if (!window.electronAPI?.setCaptureDrawRectangle) return;
    try {
      const applied = await window.electronAPI.setCaptureDrawRectangle(this.config.system.captureDrawRectangle);
      this.config.system.captureDrawRectangle = applied;
      this.must<HTMLInputElement>("capture-draw-rectangle").checked = applied;
      this.store.save(this.config);
    } catch (error) {
      this.setStatus(this.t("status.applyRectangleSettingFailed", { error: String(error) }));
    }
  }

  private async applyAutoReaderSettings(): Promise<void> {
    if (!window.electronAPI?.setAutoReaderSettings) return;
    try {
      const applied = await window.electronAPI.setAutoReaderSettings({
        advanceHotkey: this.config.system.autoReaderAdvanceHotkey,
        advanceDelayMs: this.config.system.autoReaderAdvanceDelayMs,
        noTextRetryCount: this.config.system.autoReaderNoTextRetryCount
      });
      this.config.system.autoReaderAdvanceHotkey = applied.advanceHotkey;
      this.config.system.autoReaderAdvanceDelayMs = applied.advanceDelayMs;
      this.config.system.autoReaderNoTextRetryCount = applied.noTextRetryCount;
      this.must<HTMLInputElement>("auto-reader-advance-hotkey").value = applied.advanceHotkey;
      this.must<HTMLInputElement>("auto-reader-advance-delay-ms").value = String(applied.advanceDelayMs);
      this.must<HTMLInputElement>("auto-reader-no-text-retry-count").value = String(applied.noTextRetryCount);
      this.store.save(this.config);
    } catch (error) {
      this.setStatus(this.t("status.applyAutoReaderSettingsFailed", { error: String(error) }));
    }
  }

  private clearAutoReaderSession(): void {
    this.autoReaderSessionRunId = null;
    this.activeAutoReaderPage = null;
    this.prefetchedAutoReaderPage = null;
    this.autoReaderHasTranscript = false;
  }

  private async reportAutoReaderPageResult(result: {
    runId: number;
    outcome: "ready" | "failed" | "cancelled";
    text?: string;
    message?: string;
  }, options: { clearSession?: boolean } = {}): Promise<void> {
    const { clearSession = result.outcome !== "ready" } = options;
    if (this.autoReaderSessionRunId !== result.runId) return;
    if (clearSession) {
      this.clearAutoReaderSession();
    }
    if (!window.electronAPI?.reportAutoReaderPageResult) return;
    await window.electronAPI.reportAutoReaderPageResult(result);
  }

  private snapshotAutoReaderBufferedPage(text: string, imageDataUrl: string, regions: DrawRect[]): AutoReaderBufferedPage {
    return {
      text,
      imageDataUrl,
      regions: structuredClone(regions),
      detectedRawBoxes: structuredClone(this.currentDetectedRawBoxes),
      filterResults: structuredClone(this.currentFilterResults),
      mergedGroups: structuredClone(this.currentMergedGroups),
      filterStats: { ...this.currentFilterStats },
      firstChunkId: null,
      readyReported: false
    };
  }

  private restoreAutoReaderBufferedPage(page: AutoReaderBufferedPage, options: { restoreText?: boolean } = {}): void {
    const { restoreText = true } = options;
    this.lastOriginalImageDataUrl = page.imageDataUrl;
    this.currentOcrImageDataUrl = page.imageDataUrl;
    this.currentOcrRegions = structuredClone(page.regions);
    this.currentDetectedRawBoxes = structuredClone(page.detectedRawBoxes);
    this.currentFilterResults = structuredClone(page.filterResults);
    this.currentMergedGroups = structuredClone(page.mergedGroups);
    this.currentFilterStats = { ...page.filterStats };
    this.setPreviewImage(page.imageDataUrl);
    if (restoreText) {
      this.setRawTextValuePreservingScroll(page.text);
    }
    this.renderMainPreviewOverlay();
  }

  private updateAutoReaderTranscript(page: AutoReaderBufferedPage): void {
    if (page.firstChunkId) {
      return;
    }

    if (!this.autoReaderHasTranscript) {
      this.setRawTextValuePreservingScroll(page.text);
      this.reconcileText(this.getPlaybackText(), { source: "llm", finalizeTail: true });
      page.firstChunkId = this.getChunkRecords().find((chunk) => chunk.finalized)?.id ?? null;
      this.autoReaderHasTranscript = true;
      return;
    }

    const raw = this.must<HTMLTextAreaElement>("raw-text");
    const previousPreparedText = this.getPlaybackText();
    const previousText = raw.value.replace(/\s+$/, "");
    const nextText = previousText ? `${previousText}\n\n${page.text}` : page.text;
    this.setRawTextValuePreservingScroll(nextText);
    this.reconcileText(this.getPlaybackText(), { source: "llm", finalizeTail: true });
    page.firstChunkId = this.getChunkRecords().find((chunk) => chunk.finalized && chunk.endChar > previousPreparedText.length)?.id ?? null;
    this.autoReaderHasTranscript = true;
  }

  private prefetchAutoReaderPage(page: AutoReaderBufferedPage): void {
    if (!page.firstChunkId) {
      return;
    }
    this.prefetchFromIndex(page.firstChunkId, this.chunkPlaybackSession);
  }

  private async markAutoReaderPageReady(page: AutoReaderBufferedPage, runId: number): Promise<void> {
    if (this.autoReaderSessionRunId !== runId || page.readyReported) {
      return;
    }
    page.readyReported = true;
    try {
      await this.reportAutoReaderPageResult({
        runId,
        outcome: "ready",
        text: page.text
      }, { clearSession: false });
    } catch (error) {
      page.readyReported = false;
      throw error;
    }
  }

  private async startAutoReaderPage(page: AutoReaderBufferedPage, runId: number): Promise<void> {
    if (this.autoReaderSessionRunId !== runId) return;
    this.activeAutoReaderPage = page;
    this.prefetchedAutoReaderPage = null;
    this.restoreAutoReaderBufferedPage(page, { restoreText: false });
    const firstChunkId = page.firstChunkId;
    this.resetPlaybackForTextChange();
    if (this.autoReaderSessionRunId !== runId) return;
    if (page.firstChunkId) {
      this.activeChunkId = firstChunkId;
      this.syncActiveChunkIndex();
      this.renderReadingPreview();
    }
    await this.startOrResumePlayback();
    if (this.autoReaderSessionRunId !== runId || this.activeAutoReaderPage !== page) return;
    await this.markAutoReaderPageReady(page, runId);
  }

  private promotePrefetchedAutoReaderPage(options: { startPlayback?: boolean } = {}): void {
    const { startPlayback = true } = options;
    const runId = this.autoReaderSessionRunId;
    const nextPage = this.prefetchedAutoReaderPage;
    if (runId === null || !nextPage) return;
    this.activeAutoReaderPage = nextPage;
    this.prefetchedAutoReaderPage = null;

    if (!startPlayback) {
      this.restoreAutoReaderBufferedPage(nextPage, { restoreText: false });
      void this.markAutoReaderPageReady(nextPage, runId).catch((error) => {
        loggers.pipeline.error("Automatic reader page ready report failed", { error: String(error), runId });
      });
      return;
    }

    void this.startAutoReaderPage(nextPage, runId).catch((error) => {
      loggers.pipeline.error("Automatic reader page promotion failed", { error: String(error), runId });
      void this.reportAutoReaderPageResult({
        runId,
        outcome: "failed",
        message: String(error)
      });
    });
  }

  private queueOrStartAutoReaderPage(page: AutoReaderBufferedPage, runId: number): Promise<void> {
    if (this.autoReaderSessionRunId !== runId) {
      return Promise.resolve();
    }
    this.updateAutoReaderTranscript(page);
    if (this.activeAutoReaderPage) {
      this.prefetchedAutoReaderPage = page;
      this.prefetchAutoReaderPage(page);
      this.restoreAutoReaderBufferedPage(this.activeAutoReaderPage, { restoreText: false });
      return Promise.resolve();
    }
    return this.startAutoReaderPage(page, runId);
  }

  private applyClipboardWatcherEnabledLocally(
    enabled: boolean,
    statusKey?: "status.clipboardWatcherEnabled" | "status.clipboardWatcherDisabled"
  ): void {
    this.config.system.clipboardWatcherEnabled = enabled;
    this.must<HTMLInputElement>("clipboard-watcher-enabled").checked = enabled;
    this.store.save(this.config);
    if (statusKey) {
      this.setStatus(this.t(statusKey));
    }
  }

  private async syncClipboardWatcherStateFromElectron(): Promise<void> {
    if (!window.electronAPI?.getClipboardWatcherEnabled) return;
    try {
      const enabled = await window.electronAPI.getClipboardWatcherEnabled();
      this.applyClipboardWatcherEnabledLocally(enabled);
    } catch (error) {
      this.setStatus(this.t("status.syncClipboardWatcherFailed", { error: String(error) }));
    }
  }

  private async applyClipboardWatcherEnabledSetting(): Promise<void> {
    if (!window.electronAPI?.setClipboardWatcherEnabled) return;
    try {
      const enabled = await window.electronAPI.setClipboardWatcherEnabled(this.config.system.clipboardWatcherEnabled);
      this.applyClipboardWatcherEnabledLocally(enabled);
    } catch (error) {
      this.setStatus(this.t("status.applyClipboardWatcherFailed", { error: String(error) }));
    }
  }

  private normalizeKeyboardHotkey(event: KeyboardEvent): string | null {
    const parts: string[] = [];
    if (event.ctrlKey) parts.push("ctrl");
    if (event.shiftKey) parts.push("shift");
    if (event.altKey) parts.push("alt");
    if (event.metaKey) parts.push("win");
    let baseKey: string | null = null;
    const code = event.code;
    if (/^Key[A-Z]$/.test(code)) {
      baseKey = code.slice(3).toLowerCase();
    } else if (/^Digit[0-9]$/.test(code)) {
      baseKey = code.slice(5);
    } else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) {
      baseKey = code.toLowerCase();
    } else {
      const key = event.key.toLowerCase();
      if (["control", "shift", "alt", "meta"].includes(key)) return null;
      if (!key) return null;
      if (key === " ") baseKey = "space";
      else if (key === "spacebar") baseKey = "space";
      else if (key === "arrowleft") baseKey = "left";
      else if (key === "arrowright") baseKey = "right";
      else if (key === "arrowup") baseKey = "up";
      else if (key === "arrowdown") baseKey = "down";
      else baseKey = key;
    }
    if (!baseKey) return null;
    parts.push(baseKey);
    return parts.join("+");
  }

  private getHotkeyLabelKey(key: ConfigurableHotkeyKey): TranslationKey {
    switch (key) {
      case "capture": return "system.captureHotkey";
      case "ocrClipboard": return "system.ocrClipboardHotkey";
      case "fullCapture": return "system.fullCaptureHotkey";
      case "activeWindowCapture": return "system.activeWindowCaptureHotkey";
      case "copyPlay": return "system.copyPlayHotkey";
      case "autoReader": return "system.autoReaderHotkey";
      case "clipboardWatcher": return "system.clipboardWatcherHotkey";
      case "abort": return "system.abortHotkey";
      case "playPause": return "system.playPauseHotkey";
      case "nextChunk": return "system.nextChunkHotkey";
      case "previousChunk": return "system.previousChunkHotkey";
      case "volumeUp": return "system.volumeUpHotkey";
      case "volumeDown": return "system.volumeDownHotkey";
      case "replayCapture": return "system.replayCaptureHotkey";
    }
  }

  private getDefaultHotkeyValue(key: ConfigurableHotkeyKey): string {
    const binding = this.getHotkeyBindingConfig(key);
    return DEFAULT_CONFIG.system[binding.systemKey];
  }

  private async beginHotkeyRecording(key: ConfigurableHotkeyKey): Promise<void> {
    if (this.hotkeyRecordingState[key]) return;
    const binding = this.getHotkeyBindingConfig(key);
    this.hotkeyRecordingState[key] = true;
    this.pendingHotkeys[key] = null;
    this.must<HTMLInputElement>(binding.inputId).value = "";
    this.setHotkeyRecordingStatus(key, this.t("hotkey.recording"));
    this.renderHotkeyButtonState();
    try {
      await binding.beginEdit?.();
    } catch (error) {
      this.hotkeyRecordingState[key] = false;
      this.must<HTMLInputElement>(binding.inputId).value = this.config.system[binding.systemKey];
      this.setHotkeyRecordingStatus(key, this.t("hotkey.startFailed", { error: String(error) }));
      this.renderHotkeyButtonState();
      return;
    }

    this.hotkeyKeydownHandlers[key] = (event: KeyboardEvent) => {
      if (!this.hotkeyRecordingState[key]) return;
      const normalized = this.normalizeKeyboardHotkey(event);
      if (!normalized) return;
      event.preventDefault();
      event.stopPropagation();
      this.pendingHotkeys[key] = normalized;
      this.must<HTMLInputElement>(binding.inputId).value = normalized;
      this.setHotkeyRecordingStatus(key, this.t("hotkey.captured", { hotkey: normalized }));
      this.stopHotkeyRecordingListener(key);
      this.renderHotkeyButtonState();
      void this.applyRecordedHotkey(key);
    };

    window.addEventListener("keydown", this.hotkeyKeydownHandlers[key], true);
  }

  private stopHotkeyRecordingListener(key: ConfigurableHotkeyKey): void {
    const handler = this.hotkeyKeydownHandlers[key];
    if (!handler) return;
    window.removeEventListener("keydown", handler, true);
    this.hotkeyKeydownHandlers[key] = null;
  }

  private async applyRecordedHotkey(key: ConfigurableHotkeyKey): Promise<void> {
    const pending = this.pendingHotkeys[key];
    if (!pending) return;
    const binding = this.getHotkeyBindingConfig(key);
    try {
      const applied = await binding.apply?.(pending);
      const next = applied ?? pending;
      this.config.system[binding.systemKey] = next;
      this.pendingHotkeys[key] = null;
      this.hotkeyRecordingState[key] = false;
      this.stopHotkeyRecordingListener(key);
      this.must<HTMLInputElement>(binding.inputId).value = next;
      this.setHotkeyRecordingStatus(key, this.getHotkeyAppliedStatus(next));
      this.store.save(this.config);
    } catch (error) {
      this.setHotkeyRecordingStatus(key, this.t("hotkey.applyFailed", { error: String(error) }));
      this.hotkeyRecordingState[key] = true;
      if (!this.hotkeyKeydownHandlers[key]) {
        this.hotkeyKeydownHandlers[key] = (event: KeyboardEvent) => {
          if (!this.hotkeyRecordingState[key]) return;
          const normalized = this.normalizeKeyboardHotkey(event);
          if (!normalized) return;
          event.preventDefault();
          event.stopPropagation();
          this.pendingHotkeys[key] = normalized;
          this.must<HTMLInputElement>(binding.inputId).value = normalized;
          this.setHotkeyRecordingStatus(key, this.t("hotkey.captured", { hotkey: normalized }));
          this.stopHotkeyRecordingListener(key);
          this.renderHotkeyButtonState();
          void this.applyRecordedHotkey(key);
        };
        window.addEventListener("keydown", this.hotkeyKeydownHandlers[key], true);
      }
      this.renderHotkeyButtonState();
      return;
    }
    this.renderHotkeyButtonState();
  }

  private async cancelHotkeyRecording(key: ConfigurableHotkeyKey): Promise<void> {
    const binding = this.getHotkeyBindingConfig(key);
    this.hotkeyRecordingState[key] = false;
    this.pendingHotkeys[key] = null;
    this.stopHotkeyRecordingListener(key);
    try {
      const restored = await binding.cancelEdit?.();
      if (restored) {
        this.config.system[binding.systemKey] = restored;
      }
    } catch (error) {
      this.setStatus(this.t("status.cancelNamedHotkeyEditFailed", {
        name: this.t(this.getHotkeyLabelKey(key)),
        error: String(error)
      }));
    }
    this.must<HTMLInputElement>(binding.inputId).value = this.config.system[binding.systemKey];
    this.setHotkeyRecordingStatus(key, this.getHotkeyStatus(this.config.system[binding.systemKey]));
    this.renderHotkeyButtonState();
    this.store.save(this.config);
  }

  private async clearHotkey(key: ConfigurableHotkeyKey): Promise<void> {
    const binding = this.getHotkeyBindingConfig(key);
    this.hotkeyRecordingState[key] = false;
    this.pendingHotkeys[key] = null;
    this.stopHotkeyRecordingListener(key);
    try {
      const cleared = await binding.clear?.();
      const next = cleared ?? "";
      this.config.system[binding.systemKey] = next;
      this.must<HTMLInputElement>(binding.inputId).value = next;
      this.setHotkeyRecordingStatus(key, this.getHotkeyStatus(next));
      this.store.save(this.config);
    } catch (error) {
      this.setHotkeyRecordingStatus(key, this.t("hotkey.clearFailed", { error: String(error) }));
      return;
    }
    this.renderHotkeyButtonState();
  }

  private async resetHotkey(key: ConfigurableHotkeyKey): Promise<void> {
    const binding = this.getHotkeyBindingConfig(key);
    const defaultValue = this.getDefaultHotkeyValue(key);
    this.hotkeyRecordingState[key] = false;
    this.pendingHotkeys[key] = null;
    this.stopHotkeyRecordingListener(key);
    try {
      const applied = await binding.apply?.(defaultValue);
      const next = applied ?? defaultValue;
      this.config.system[binding.systemKey] = next;
      this.must<HTMLInputElement>(binding.inputId).value = next;
      this.setHotkeyRecordingStatus(key, this.getHotkeyAppliedStatus(next));
      this.store.save(this.config);
    } catch (error) {
      this.setHotkeyRecordingStatus(key, this.t("hotkey.applyFailed", { error: String(error) }));
      return;
    }
    this.renderHotkeyButtonState();
  }

  private getHotkeyStatus(value: string): string {
    return value ? this.t("hotkey.currentActive") : this.t("hotkey.none");
  }

  private getHotkeyAppliedStatus(value: string): string {
    return value ? this.t("hotkey.active", { hotkey: value }) : this.t("hotkey.none");
  }

  private bindHotkeyButtons(key: ConfigurableHotkeyKey): void {
    const binding = this.getHotkeyBindingConfig(key);
    this.must<HTMLButtonElement>(binding.recordButtonId).addEventListener("click", () => {
      void this.beginHotkeyRecording(key);
    });
    this.must<HTMLButtonElement>(binding.clearButtonId).addEventListener("click", () => {
      void this.clearHotkey(key);
    });
    this.must<HTMLButtonElement>(binding.resetButtonId).addEventListener("click", () => {
      void this.resetHotkey(key);
    });
    this.must<HTMLButtonElement>(binding.applyButtonId).addEventListener("click", () => {
      void this.applyRecordedHotkey(key);
    });
    this.must<HTMLButtonElement>(binding.cancelButtonId).addEventListener("click", () => {
      void this.cancelHotkeyRecording(key);
    });
  }

  private bindPlayback(): void {
    const volSlider = this.must<HTMLInputElement>("vol-slider");
    const volInput = this.must<HTMLInputElement>("vol-input");
    const speedSlider = this.must<HTMLInputElement>("speed-slider");
    const speedInput = this.must<HTMLInputElement>("speed-input");
    speedSlider.min = String(MIN_PLAYBACK_RATE);
    speedSlider.max = String(MAX_PLAYBACK_RATE);

    const updateVol = (val: number) => {
      this.applyVolumeValue(val);
    };

    const updateSpeed = (val: number) => {
      this.applyPlaybackRateValue(val);
    };

    const commitSpeedInput = () => {
      const raw = speedInput.value.trim();
      if (!raw) {
        speedInput.value = String(this.config.ui.playbackRate);
        return;
      }
      const next = Number(raw);
      if (!Number.isFinite(next)) {
        speedInput.value = String(this.config.ui.playbackRate);
        return;
      }
      this.applyPlaybackRateValue(next);
    };

    volSlider.addEventListener("input", () => updateVol(Number(volSlider.value)));
    volInput.addEventListener("change", () => updateVol(Number(volInput.value)));
    speedSlider.addEventListener("input", () => updateSpeed(Number(speedSlider.value)));
    speedInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        commitSpeedInput();
      }
    });
    speedInput.addEventListener("blur", commitSpeedInput);
    speedInput.addEventListener("change", commitSpeedInput);

    this.must<HTMLButtonElement>("btn-play").addEventListener("click", async () => {
      if (this.audio.paused) {
        await this.startOrResumePlayback();
      } else {
        this.audio.pause();
      }
      this.renderPlayState();
    });

    this.must<HTMLButtonElement>("btn-prev").addEventListener("click", () => this.seekChunk(this.activeChunkIndex - 1));
    this.must<HTMLButtonElement>("btn-next").addEventListener("click", () => this.seekChunk(this.activeChunkIndex + 1));

    this.audio.addEventListener("timeupdate", () => {
      if (this.chunkPlaybackMode) {
        return;
      }
      this.activeChunkIndex = findChunkIndexByTime(this.timeline, this.audio.currentTime * 1000);
      this.renderReadingPreview();
    });

    this.audio.addEventListener("ended", () => {
      loggers.playback.info("Audio ended", { chunkPlaybackMode: this.chunkPlaybackMode, chunkIndex: this.activeChunkIndex });
      if (!this.chunkPlaybackMode) return;
      const current = this.getChunkById(this.speakingChunkId);
      if (current && current.status === "playing") {
        current.status = current.audioUrl ? "ready" : "dirty";
      }
      this.speakingChunkId = null;
      this.speakingRevision = null;
      const nextChunk = this.getChunkRecords().slice(this.activeChunkIndex + 1).find((chunk) => chunk.finalized);
      const nextIndex = nextChunk?.index ?? this.timeline.chunks.length;
      loggers.playback.info("Selecting next chunk after ended", {
        previousChunkIndex: this.activeChunkIndex,
        nextIndex,
        totalChunks: this.timeline.chunks.length
      });
      if (nextChunk && this.prefetchedAutoReaderPage?.firstChunkId === nextChunk.id) {
        this.promotePrefetchedAutoReaderPage({ startPlayback: false });
      }
      if (nextIndex >= this.timeline.chunks.length) {
        this.chunkPlaybackMode = false;
        this.audio.src = "";
        this.audio.currentTime = 0;
        if (this.autoReaderSessionRunId !== null) {
          this.activeAutoReaderPage = null;
          if (this.prefetchedAutoReaderPage) {
            this.promotePrefetchedAutoReaderPage();
            return;
          }
          this.setStatus(this.t("status.runningPipeline"));
          this.renderPlayState();
          return;
        }
        this.setStatus(this.t("playback.ready"));
        this.renderPlayState();
        return;
      }
      void this.playChunkAtIndex(nextIndex, this.chunkPlaybackSession);
    });

    this.audio.addEventListener("play", () => this.renderPlayState());
    this.audio.addEventListener("pause", () => this.renderPlayState());
  }

  private applyVolumeValue(val: number): void {
    const next = Math.max(0, Math.min(100, Math.round(val)));
    const volSlider = this.must<HTMLInputElement>("vol-slider");
    const volInput = this.must<HTMLInputElement>("vol-input");
    this.audio.volume = next / 100;
    this.config.ui.volume = next;
    volSlider.value = String(next);
    volInput.value = String(next);
    this.store.save(this.config);
  }

  private applyPlaybackRateValue(val: number, persist = true): void {
    const next = sanitizePlaybackRate(val, DEFAULT_CONFIG.ui.playbackRate);
    const speedSlider = this.must<HTMLInputElement>("speed-slider");
    const speedInput = this.must<HTMLInputElement>("speed-input");
    this.audio.playbackRate = next;
    this.config.ui.playbackRate = next;
    speedSlider.value = String(Math.max(MIN_PLAYBACK_RATE, Math.min(MAX_PLAYBACK_RATE, next)));
    speedInput.value = String(next);
    if (persist) {
      this.store.save(this.config);
    }
  }

  private adjustVolumeBy(delta: number): void {
    this.applyVolumeValue(this.config.ui.volume + delta);
  }

  private async handlePlaybackHotkey(action: PlaybackHotkeyAction): Promise<void> {
    try {
      switch (action) {
        case "toggle_play_pause":
          if (this.audio.paused) {
            await this.startOrResumePlayback();
            if (this.audio.paused && !this.chunkPlaybackMode && !this.audio.src) {
              await this.playConfiguredErrorFeedback();
              return;
            }
          } else {
            this.audio.pause();
          }
          this.renderPlayState();
          await this.playConfiguredHotkeyFeedback("playPause");
          break;
        case "next_chunk":
          if (this.activeChunkIndex + 1 >= this.timeline.chunks.length || !this.isChunkPlayable(this.activeChunkIndex + 1)) {
            await this.playConfiguredErrorFeedback();
            return;
          }
          this.seekChunk(this.activeChunkIndex + 1);
          await this.playConfiguredHotkeyFeedback("nextChunk");
          break;
        case "previous_chunk":
          if (this.activeChunkIndex <= 0 || !this.isChunkPlayable(this.activeChunkIndex - 1)) {
            await this.playConfiguredErrorFeedback();
            return;
          }
          this.seekChunk(this.activeChunkIndex - 1);
          await this.playConfiguredHotkeyFeedback("previousChunk");
          break;
        case "volume_up":
          this.adjustVolumeBy(5);
          await this.playConfiguredHotkeyFeedback("volumeUp");
          break;
        case "volume_down":
          this.adjustVolumeBy(-5);
          await this.playConfiguredHotkeyFeedback("volumeDown");
          break;
      }
    } catch (error) {
      await this.playConfiguredErrorFeedback();
      this.setStatus(this.t("status.playbackFailed", { error: String(error) }));
    }
  }

  private async copyTextToClipboard(text: string): Promise<void> {
    if (window.electronAPI?.writeTextToClipboard) {
      await window.electronAPI.writeTextToClipboard(text);
      return;
    }
    if ("clipboard" in navigator && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(text);
      return;
    }
    throw new Error("Clipboard write is unavailable");
  }

  private normalizeTextForClipboard(text: string): string {
    return this.prepareTextForPlayback(text);
  }

  private async runPipeline(dataUrl: string, captureContext: CaptureContext): Promise<void> {
    const { runId, signal } = this.startRun();
    const autoReaderRunId = captureContext.automation?.kind === "auto_reader" ? captureContext.automation.runId : null;
    if (autoReaderRunId !== null) {
      this.autoReaderSessionRunId = autoReaderRunId;
    }
    this.setStatus(this.t("status.runningPipeline"));
    const done = loggers.pipeline.time("pipeline.run");
    try {
      this.lastOriginalImageDataUrl = await normalizeImageDataUrl(dataUrl);
      this.throwIfStale(runId);
      const activeAutoReaderPage = autoReaderRunId !== null ? this.activeAutoReaderPage : null;
      const ocrInput = await this.buildOcrInput(this.lastOriginalImageDataUrl, signal, runId, (imageDataUrl) => {
        if (runId !== this.activeRunId) return;
        if (autoReaderRunId !== null && activeAutoReaderPage) {
          return;
        }
        // Show image immediately; detected boxes will be layered when detect finishes.
        this.currentDetectedRawBoxes = [];
        this.currentFilterResults = [];
        this.currentMergedGroups = [];
        this.currentFilterStats = { widthRemoved: 0, heightRemoved: 0, medianRemoved: 0, medianHeightPx: 0 };
        this.setPreviewImage(imageDataUrl);
        this.renderMainPreviewOverlay();
      }, captureContext);
      this.throwIfStale(runId);
      if (autoReaderRunId !== null && activeAutoReaderPage) {
        this.restoreAutoReaderBufferedPage(activeAutoReaderPage, { restoreText: false });
      } else {
        this.currentOcrImageDataUrl = ocrInput.imageDataUrl;
        this.currentOcrRegions = ocrInput.regions;
        this.setPreviewImage(ocrInput.imageDataUrl);
        this.renderMainPreviewOverlay();
      }
      const resultMode = captureContext.resultMode === "clipboard" ? "clipboard" : "editor";
      const streamingEnabled = autoReaderRunId === null && resultMode === "editor" && this.config.llm.ocrStreamingEnabled;
      let result: { text: string };
      if (streamingEnabled) {
        result = await this.runStreamingOcr(ocrInput.imageDataUrl, ocrInput.regions, signal);
      } else {
        result = await this.pipeline.run(ocrInput.imageDataUrl, this.config, { regions: ocrInput.regions, signal });
      }
      this.throwIfStale(runId);
      if (!result.text.trim()) {
        if (autoReaderRunId !== null) {
          done();
          loggers.pipeline.info("Automatic reader page produced no text", { runId, phase: captureContext.automation?.phase });
          await this.reportAutoReaderPageResult({
            runId: autoReaderRunId,
            outcome: "ready",
            text: ""
          });
          return;
        }
        throw new Error("OCR produced empty text");
      }
      done();
      loggers.pipeline.info("Pipeline completed", { textLength: result.text.length });
      if (resultMode === "clipboard") {
        await this.copyTextToClipboard(this.normalizeTextForClipboard(result.text));
        this.setStatus(this.t("status.ocrCopiedToClipboard"));
      } else if (!streamingEnabled) {
        if (autoReaderRunId !== null) {
          const page = this.snapshotAutoReaderBufferedPage(result.text, ocrInput.imageDataUrl, ocrInput.regions);
          await this.queueOrStartAutoReaderPage(page, autoReaderRunId);
        } else {
          this.must<HTMLTextAreaElement>("raw-text").value = result.text;
          this.updateTimelineFromRawText();
          this.resetPlaybackForTextChange();
          await this.startOrResumePlayback();
        }
      }
    } catch (error) {
      if (this.isAbortError(error)) {
        loggers.pipeline.info("Pipeline cancelled", { runId });
        if (autoReaderRunId !== null) {
          await this.reportAutoReaderPageResult({
            runId: autoReaderRunId,
            outcome: "cancelled",
            message: "Automatic reader cancelled."
          });
        }
      } else if (autoReaderRunId !== null && this.isEmptyOcrError(error)) {
        loggers.pipeline.info("Automatic reader page produced no text", {
          runId,
          phase: captureContext.automation?.phase,
          error: String(error)
        });
        await this.reportAutoReaderPageResult({
          runId: autoReaderRunId,
          outcome: "ready",
          text: ""
        });
      } else {
        loggers.pipeline.error("Pipeline failed", { error: String(error) });
        if (captureContext.source === "hotkey") {
          await this.playConfiguredErrorFeedback();
        }
        if (autoReaderRunId !== null) {
          await this.reportAutoReaderPageResult({
            runId: autoReaderRunId,
            outcome: "failed",
            message: String(error)
          });
        }
        this.setStatus(
          captureContext.resultMode === "clipboard"
            ? this.withApiBaseUrlHint(this.t("status.ocrCopyToClipboardFailed", { error: String(error) }), "ocr", this.config.llm.baseUrl)
            : this.withApiBaseUrlHint(this.t("status.pipelineError", { error: String(error) }), "ocr", this.config.llm.baseUrl)
        );
      }
    } finally {
      if (autoReaderRunId === null) {
        this.clearAutoReaderSession();
      }
      this.finishRun(runId);
    }
  }

  private async runStreamingOcr(
    imageDataUrl: string,
    regions: DrawRect[],
    signal: AbortSignal
  ): Promise<{ text: string }> {
    const streamSession = ++this.ocrStreamSession;
    this.ocrStreaming = true;
    this.ocrStreamDone = false;
    this.activeOcrRequests = 0;
    this.setRawTextLock(true);
    this.setRawTextValuePreservingScroll("");
    this.lastPlaybackText = "";
    this.replaceTimelineWithChunks([]);
    this.renderReadingPreview();
    this.setStatus(this.t("status.streamingOcr"));

    let streamText = "";
    const applyStreamToken = (token: string): void => {
      if (streamSession !== this.ocrStreamSession || signal.aborted) return;
      streamText += token;
      this.setRawTextValuePreservingScroll(streamText);
      this.reconcileText(this.getPlaybackText(), { source: "llm" });
    };

    try {
      const result = await this.pipeline.streamOcrText(imageDataUrl, this.config, {
        regions: regions.map((r) => ({ id: r.id, nx: r.nx, ny: r.ny, nw: r.nw, nh: r.nh })),
        signal,
        onToken: applyStreamToken,
        onOcrRequestStart: () => {
          if (streamSession !== this.ocrStreamSession) return;
          this.activeOcrRequests += 1;
          loggers.api.info("OCR stream request started", { active: this.activeOcrRequests });
        },
        onOcrRequestEnd: () => {
          if (streamSession !== this.ocrStreamSession) return;
          this.activeOcrRequests = Math.max(0, this.activeOcrRequests - 1);
          loggers.api.info("OCR stream request ended", { active: this.activeOcrRequests });
          this.maybeStartPlaybackFromStream();
        }
      });
      if (streamSession !== this.ocrStreamSession || signal.aborted) {
        throw new Error("Cancelled");
      }
      this.ocrStreamDone = true;
      this.ocrStreaming = false;
      this.setRawTextLock(false);
      this.setRawTextValuePreservingScroll(result.text);
      this.reconcileText(this.getPlaybackText(), { source: "llm", finalizeTail: true });
      return { text: result.text };
    } catch (error) {
      this.ocrStreaming = false;
      this.setRawTextLock(false);
      this.activeOcrRequests = 0;
      if (this.isAbortError(error)) {
        throw error;
      }
      this.setStatus(this.withApiBaseUrlHint(this.t("status.ocrStreamError", { error: String(error) }), "ocr", this.config.llm.baseUrl));
      return { text: this.getPlaybackText() };
    } finally {
      if (streamSession === this.ocrStreamSession) {
        this.ocrStreaming = false;
        this.ocrStreamDone = true;
        this.activeOcrRequests = 0;
        this.setRawTextLock(false);
      }
    }
  }

  private handleUserCaretMovement(): void {
    this.renderPlayState();
  }

  private maybeStartPlaybackFromStream(): void {
    this.logStreamingPlaybackGate("maybe_start");
    if (this.programmaticPauseActive) return;
    if (this.playbackStartInFlight) return;
    if (this.chunkPlaybackMode || !this.audio.paused) return;
    if (this.maxPlayableChunkIndex() < 0) return;
    void this.startOrResumePlayback().catch((error) => {
      this.setStatus(this.withApiBaseUrlHint(this.t("status.playbackFailed", { error: String(error) }), "tts", this.config.tts.baseUrl));
    });
  }

  private maxPlayableChunkIndex(): number {
    if (!this.timeline.chunks.length) return -1;
    const chunks = this.getChunkRecords();
    for (let i = chunks.length - 1; i >= 0; i -= 1) {
      if (chunks[i]?.finalized) return i;
    }
    return -1;
  }

  private logStreamingPlaybackGate(event: string): void {
    const maxPlayable = this.maxPlayableChunkIndex();
    const activeChunk = this.timeline.chunks[this.activeChunkIndex] ?? null;
    loggers.playback.debug("Streaming playback gate", {
      event,
      activeChunkIndex: this.activeChunkIndex,
      activeChunkRange: activeChunk ? { startChar: activeChunk.startChar, endChar: activeChunk.endChar } : null,
      chunkCount: this.timeline.chunks.length,
      maxPlayable,
      chunkPlaybackMode: this.chunkPlaybackMode,
      audioPaused: this.audio.paused,
      activeOcrRequests: this.activeOcrRequests,
      ocrStreaming: this.ocrStreaming,
      ocrStreamDone: this.ocrStreamDone,
      isTyping: this.isTypingActive(),
      isUserTyping: this.isUserTyping,
      programmaticPauseActive: this.programmaticPauseActive
    });
  }

  private isTypingActive(): boolean {
    const streamTyping = this.ocrStreaming || this.activeOcrRequests > 0;
    return this.isUserTyping || streamTyping;
  }

  private markUserTyping(): void {
    this.isUserTyping = true;
    this.userTypingLastAt = Date.now();
    if (this.userTypingIdleTimer) {
      clearTimeout(this.userTypingIdleTimer);
      this.userTypingIdleTimer = null;
    }
    const idleMs = Math.max(100, this.config.reading.typingIdleMs);
    this.userTypingIdleTimer = setTimeout(() => {
      const sinceLast = Date.now() - this.userTypingLastAt;
      if (sinceLast < idleMs) return;
      this.isUserTyping = false;
      this.renderReadingPreview();
      this.maybeStartPlaybackFromStream();
    }, idleMs);
  }

  private setRawTextLock(locked: boolean): void {
    this.must<HTMLTextAreaElement>("raw-text").readOnly = locked;
  }

  private async runPreparedOcr(): Promise<void> {
    if (!this.currentOcrImageDataUrl) return;
    const { runId, signal } = this.startRun();
    const done = loggers.pipeline.time("pipeline.run.prepared");
    try {
      const streamingEnabled = this.config.llm.ocrStreamingEnabled;
      const result = streamingEnabled
        ? await this.runStreamingOcr(this.currentOcrImageDataUrl, this.currentOcrRegions, signal)
        : await this.pipeline.run(this.currentOcrImageDataUrl, this.config, { regions: this.currentOcrRegions, signal });
      this.throwIfStale(runId);
      done();
      if (!streamingEnabled) {
        this.must<HTMLTextAreaElement>("raw-text").value = result.text;
        this.updateTimelineFromRawText();
        this.resetPlaybackForTextChange();
        await this.startOrResumePlayback();
      }
    } catch (error) {
      if (this.isAbortError(error)) {
        loggers.pipeline.info("Prepared OCR cancelled", { runId });
      } else {
        this.setStatus(this.withApiBaseUrlHint(this.t("status.pipelineError", { error: String(error) }), "ocr", this.config.llm.baseUrl));
      }
    } finally {
      this.finishRun(runId);
    }
  }

  private async recomputeMainPreviewFromCurrentState(): Promise<void> {
    if (!this.lastOriginalImageDataUrl) return;
    const ocrInput = await this.buildOcrInput(this.lastOriginalImageDataUrl);
    this.currentOcrImageDataUrl = ocrInput.imageDataUrl;
    this.currentOcrRegions = ocrInput.regions;
    this.setPreviewImage(ocrInput.imageDataUrl);
    this.renderMainPreviewOverlay();
  }

  private async buildOcrInput(
    originalDataUrl: string,
    signal?: AbortSignal,
    runId?: number,
    onImageReady?: (imageDataUrl: string) => void,
    captureContext?: CaptureContext
  ): Promise<{ imageDataUrl: string; regions: DrawRect[] }> {
    if (signal?.aborted) throw new Error("Cancelled");
    const pre = this.config.preprocessing;
    const processed = await applyPreprocessToDataUrl(originalDataUrl, {
      maxImageDimension: pre.maxImageDimension,
      binaryThreshold: pre.binaryThreshold,
      contrast: pre.contrast,
      brightness: pre.brightness,
      dilation: pre.dilation,
      invert: pre.invert
    });
    const scaled = await scaleDataUrlMaxDimension(processed, pre.maxImageDimension);
    if (signal?.aborted) throw new Error("Cancelled");
    if (runId !== undefined) this.throwIfStale(runId);
    onImageReady?.(scaled);

    let detectedBoxes: Array<{ id: string; norm: { x: number; y: number; w: number; h: number }; px: { x1: number; y1: number; x2: number; y2: number } }> = [];
    if (this.shouldUseDetector(captureContext)) {
      const detectLane = this.requestPreemptor.beginLane("detect_main", signal);
      try {
        const detect = await detectRawBoxes(this.getDetectorBaseUrl(), scaled, {
          signal: detectLane.signal
        });
        if (!this.requestPreemptor.isCurrent("detect_main", detectLane.token)) {
          throw new Error("Cancelled");
        }
        if (signal?.aborted) throw new Error("Cancelled");
        if (runId !== undefined) this.throwIfStale(runId);
        detectedBoxes = detect.boxes;
        this.updateStatusChip("detector-status-chip", this.t("statuschip.loadedCount", { count: detect.boxes.length }), "ok");
      } catch (error) {
        if (this.isAbortError(error)) throw error;
        this.updateStatusChip("detector-status-chip", this.t("statuschip.detectFailed"), "error");
        loggers.pipeline.warn("Text detection failed, falling back to manual/full image", {
          error: String(error)
        });
      } finally {
        detectLane.done();
      }
    }

    const dims = await this.readImageSize(scaled);
    const selectedDetected = detectedBoxes.filter((box) => selectionKeepRatio(box, dims.width, dims.height, pre.selection.baseState, pre.selection.ops) > 0.1);
    const filterResults = filterBySize(selectedDetected, dims.width, dims.height, pre.detectionFilter);
    const keptDetected = filterResults.filter((f) => f.keep).map((f) => f.box);
    const manualRaw = pre.selection.manualBoxes.map((m) => manualToRaw(m, dims.width, dims.height));
    const orderedDetected = sortByReadingOrder(keptDetected, pre.sorting);
    const mergedGroups = mergeCloseBoxes(orderedDetected, pre.merge, dims.width, dims.height)
      .map((group) => ({
        rect: adjustBoxPadding(group.rect, dims.width, dims.height, {
          boxPaddingWidthRatio: pre.boxPaddingWidthRatio,
          boxPaddingHeightRatio: pre.boxPaddingHeightRatio
        }),
        members: group.members
      }));
    const paddedDetected = mergedGroups.length
      ? mergedGroups.map((m) => m.rect)
      : orderedDetected.map((box) => adjustBoxPadding(box, dims.width, dims.height, {
        boxPaddingWidthRatio: pre.boxPaddingWidthRatio,
        boxPaddingHeightRatio: pre.boxPaddingHeightRatio
      }));
    const mergedOrOrdered = sortByReadingOrder([...paddedDetected, ...manualRaw], pre.sorting);

    const regions = finalizeOcrBoxes({
      rawBoxes: detectedBoxes,
      manualBoxes: pre.selection.manualBoxes,
      baseState: pre.selection.baseState,
      ops: pre.selection.ops,
      imageW: dims.width,
      imageH: dims.height,
      filter: pre.detectionFilter,
      sorting: pre.sorting,
      merge: pre.merge,
      adjustment: {
        boxPaddingWidthRatio: pre.boxPaddingWidthRatio,
        boxPaddingHeightRatio: pre.boxPaddingHeightRatio
      }
    });

    const heights = filterResults.map((f) => f.box.px.y2 - f.box.px.y1).filter((h) => h > 0).sort((a, b) => a - b);
    const mid = Math.floor(heights.length / 2);
    const med = heights.length % 2 === 0 ? ((heights[mid - 1] ?? 0) + (heights[mid] ?? 0)) / 2 : (heights[mid] ?? 0);
    this.currentDetectedRawBoxes = selectedDetected;
    this.currentFilterResults = filterResults;
    this.currentMergedGroups = mergedGroups.length ? mergedGroups : mergedOrOrdered.map((rect) => ({ rect, members: [rect] }));
    this.currentFilterStats = {
      widthRemoved: filterResults.filter((f) => f.removedBy.width).length,
      heightRemoved: filterResults.filter((f) => f.removedBy.height).length,
      medianRemoved: filterResults.filter((f) => f.removedBy.median).length,
      medianHeightPx: Math.max(0, Math.round(med || 0))
    };

    return { imageDataUrl: scaled, regions };
  }

  private async readImageSize(dataUrl: string): Promise<{ width: number; height: number }> {
    const image = new Image();
    image.src = dataUrl;
    await image.decode();
    return { width: image.naturalWidth, height: image.naturalHeight };
  }

  private updateTimelineFromRawText(): void {
    this.reconcileText(this.getPlaybackText(), { source: "user", finalizeTail: !this.ocrStreaming });
  }

  private getPlaybackText(): string {
    const raw = this.must<HTMLTextAreaElement>("raw-text").value;
    return this.prepareTextForPlayback(raw);
  }

  private prepareTextForPlayback(text: string): string {
    let prepared = this.config.reading.cleanTextBeforeTts ? cleanTextForTts(text) : text;
    if (this.config.reading.lowercaseTextBeforeTts) {
      prepared = prepared.toLowerCase();
    }
    return prepared;
  }

  private async startOrResumePlayback(): Promise<void> {
    if (this.playbackStartPromise) {
      return this.playbackStartPromise;
    }
    this.playbackStartInFlight = true;
    const startPromise = this.startOrResumePlaybackInternal().finally(() => {
      if (this.playbackStartPromise === startPromise) {
        this.playbackStartPromise = null;
        this.playbackStartInFlight = false;
      }
    });
    this.playbackStartPromise = startPromise;
    return startPromise;
  }

  private async startOrResumePlaybackInternal(): Promise<void> {
    const text = this.getPlaybackText().trim();
    if (!text) {
      this.setStatus(this.t("status.enterTextFirst"));
      return;
    }

    if (canResumePlayback({
      chunkPlaybackMode: this.chunkPlaybackMode,
      audioSrc: this.audio.src,
      speakingChunkId: this.speakingChunkId
    })) {
      await this.audio.play();
      loggers.playback.info("Playback resumed");
      return;
    }
    this.reconcileText(text, { source: "user", finalizeTail: true });

    if (this.timeline.chunks.length === 0) {
      this.setStatus(this.t("status.nothingToRead"));
      return;
    }
    if (this.programmaticPauseActive) {
      this.setStatus(this.programmaticPauseReason || this.t("status.pausedByCursorGate"));
      this.renderPlayState();
      return;
    }

    if (!this.chunkPlaybackMode) {
      this.chunkPlaybackMode = true;
      this.chunkPlaybackSession += 1;
      this.playbackMetrics.sessionStarts += 1;
      loggers.playback.info("Playback started", { session: this.chunkPlaybackSession, chunks: this.timeline.chunks.length });
    }
    this.logStreamingPlaybackGate("start_or_resume");
    const active = this.getChunkById(this.activeChunkId) ?? this.getChunkRecords().find((chunk) => chunk.finalized);
    if (!active) return;
    this.activeChunkId = active.id;
    this.activeChunkIndex = active.index;
    await this.playChunkAtIndex(active.index, this.chunkPlaybackSession);
  }

  private async playChunkAtIndex(index: number, session: number): Promise<void> {
    this.logStreamingPlaybackGate("play_chunk_request");
    if (!this.isChunkPlayable(index)) {
      this.chunkPlaybackMode = false;
      this.renderPlayState();
      this.setStatus(this.t("status.waitingTyping"));
      return;
    }
    if (index > this.maxPlayableChunkIndex()) {
      this.chunkPlaybackMode = false;
      this.renderPlayState();
      if (this.ocrStreaming && !this.ocrStreamDone) {
        this.setStatus(this.t("status.waitingOcrFinalize"));
      }
      return;
    }
    const chunk = this.getChunkRecords()[index];
    if (!chunk) return;
    if (session !== this.chunkPlaybackSession) return;
    loggers.playback.info("Play chunk requested", {
      requestedIndex: index,
      session,
      activeSession: this.chunkPlaybackSession,
      chunkRange: { startChar: chunk.startChar, endChar: chunk.endChar },
      chunkTextPreview: chunk.text.slice(0, 80)
    });
    this.playbackMetrics.playChunkRequests += 1;

    this.activeChunkId = chunk.id;
    this.activeChunkIndex = chunk.index;
    this.renderReadingPreview();
    this.prefetchFromIndex(chunk.id, session);
    this.setStatus(this.t("status.bufferingChunk", { current: chunk.index + 1, total: this.timeline.chunks.length }));

    try {
      const audioUrl = await this.getChunkAudioUrl(chunk.id, session);
      if (session !== this.chunkPlaybackSession) return;
      this.audio.src = audioUrl;
      this.audio.currentTime = 0;
      this.audio.volume = Math.max(0, Math.min(1, this.config.ui.volume / 100));
      this.audio.playbackRate = sanitizePlaybackRate(this.config.ui.playbackRate, DEFAULT_CONFIG.ui.playbackRate);
      chunk.status = "playing";
      this.speakingChunkId = chunk.id;
      this.speakingRevision = chunk.revision;
      this.renderReadingPreview();
      await this.audio.play();
      this.setStatus(this.t("status.playingChunk", { current: chunk.index + 1, total: this.timeline.chunks.length }));
      this.prefetchFromIndex(chunk.id, session);
    } catch (error) {
      if (session !== this.chunkPlaybackSession) return;
      if (this.isAbortError(error)) {
        loggers.playback.info("Chunk playback cancelled", { index: chunk.index + 1, session });
        return;
      }
      this.failPlaybackAtChunk(chunk.id);
      await this.playConfiguredErrorFeedback();
      this.setStatus(this.t("status.chunkSynthesisFailed", { current: chunk.index + 1, total: this.timeline.chunks.length, error: String(error) }));
    }
  }

  private async getChunkAudioUrl(chunkId: string, session: number): Promise<string> {
    const chunk = this.getChunkById(chunkId);
    if (!chunk) throw new Error("Invalid chunk id");
    if (chunk.audioUrl) {
      return chunk.audioUrl;
    }
    const inflight = this.chunkInFlightById.get(chunkId);
    if (inflight) return inflight;
    const metricKey = `${session}:${chunkId}:r${chunk.revision}`;
    this.playbackMetrics.ttsStartsBySessionAndHash[metricKey] =
      (this.playbackMetrics.ttsStartsBySessionAndHash[metricKey] ?? 0) + 1;
    chunk.status = "fetching";
    this.renderReadingPreview();
    const controller = new AbortController();
    this.chunkAbortControllersById.set(chunkId, controller);
    const revision = chunk.revision;
    const documentGeneration = this.playbackDocumentGeneration;
    const requestPromise = this.synthesizeChunk(chunk.index, chunk.text, session, controller.signal)
      .then((audioBlob) => {
        if (session !== this.chunkPlaybackSession || documentGeneration !== this.playbackDocumentGeneration) {
          throw new Error("Cancelled");
        }
        const url = URL.createObjectURL(audioBlob);
        const current = this.getChunkById(chunkId);
        if (!current || current.revision !== revision || documentGeneration !== this.playbackDocumentGeneration) {
          URL.revokeObjectURL(url);
          throw new Error("Cancelled");
        }
        current.audioUrl = url;
        current.status = "ready";
        this.renderReadingPreview();
        return url;
      })
      .finally(() => {
        this.chunkInFlightById.delete(chunkId);
        this.chunkAbortControllersById.delete(chunkId);
        this.refreshChunkDiagnostics();
      });
    this.chunkInFlightById.set(chunkId, requestPromise);
    this.refreshChunkDiagnostics();
    return requestPromise;
  }

  private abortPlaybackAndSynthesis(): void {
    this.chunkPlaybackSession += 1;
    this.chunkPlaybackMode = false;
    this.playbackStartPromise = null;
    this.playbackStartInFlight = false;
    this.speakingChunkId = null;
    this.speakingRevision = null;
    this.audio.pause();
    this.audio.src = "";
    this.chunkAbortControllersById.forEach((controller) => controller.abort());
    this.chunkAbortControllersById.clear();
    this.chunkInFlightById.clear();
    this.resetChunkVisualStateAfterAbort();
    this.renderPlayState();
    this.updateBreakButtonState();
  }

  private failPlaybackAtChunk(chunkId: string): void {
    this.chunkPlaybackSession += 1;
    this.chunkPlaybackMode = false;
    this.speakingChunkId = null;
    this.speakingRevision = null;
    this.audio.pause();
    this.audio.src = "";
    this.chunkAbortControllersById.forEach((controller) => controller.abort());
    this.chunkAbortControllersById.clear();
    this.chunkInFlightById.clear();

    for (const chunk of this.getChunkRecords()) {
      if (chunk.id === chunkId) {
        chunk.status = "failed";
        continue;
      }
      chunk.status = chunk.audioUrl ? "ready" : "dirty";
    }

    this.syncActiveChunkIndex();
    this.renderReadingPreview();
    this.renderPlayState();
    this.refreshChunkDiagnostics();
    this.updateBreakButtonState();
  }

  private resetChunkVisualStateAfterAbort(): void {
    for (const chunk of this.getChunkRecords()) {
      chunk.status = chunk.audioUrl ? "ready" : "dirty";
    }
    this.syncActiveChunkIndex();
    this.renderReadingPreview();
    this.refreshChunkDiagnostics();
  }

  private resetPlaybackForTextChange(): void {
    this.abortPlaybackAndSynthesis();
    this.renderReadingPreview();
    this.refreshChunkDiagnostics();
  }

  private renderReadingPreview(): void {
    const preview = this.must<HTMLDivElement>("reading-preview");
    const previousActiveChunkId = this.lastRenderedActiveChunkId;
    preview.innerHTML = "";

    this.getChunkRecords().forEach((chunk) => {
      const span = document.createElement("span");
      span.textContent = chunk.text;
      const state = chunk.status === "dirty" ? "not_started" : chunk.status;
      span.classList.add(`chunk-${state}`);
      const isDraft = !chunk.finalized;
      if (isDraft) {
        span.classList.add("chunk-draft");
      }
      if (state === "ready") {
        span.title = this.t("chunk.ready");
      }
      if (state === "failed") {
        span.title = this.t("chunk.error");
      }
      const playable = this.isChunkPlayable(chunk.index);
      if (!playable) {
        span.classList.add("chunk-unplayable");
        if (!span.title) {
          span.title = this.t("chunk.waitingTyping");
        }
      }
      const shouldHighlightActive = this.chunkPlaybackMode || !this.audio.paused;
      if (shouldHighlightActive && chunk.id === this.activeChunkId) {
        span.classList.add("active-chunk");
      }
      span.addEventListener("click", () => {
        if (!this.isChunkPlayable(chunk.index)) return;
        this.seekChunk(chunk.index);
      });
      preview.appendChild(span);
      preview.appendChild(document.createTextNode(" "));
    });

    const active = preview.querySelector<HTMLElement>("span.active-chunk");
    this.lastRenderedActiveChunkId = active ? this.activeChunkId : null;
    if (active && this.activeChunkId && this.activeChunkId !== previousActiveChunkId) {
      active.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
    }
  }

  private seekChunk(index: number): void {
    this.reconcileText(this.getPlaybackText(), { source: "user", finalizeTail: true });
    const chunk = this.getChunkRecords()[index];
    if (!chunk) return;
    if (!this.isChunkPlayable(index)) {
      this.setStatus(this.t("status.chunkDrafting"));
      return;
    }
    this.abortPlaybackAndSynthesis();
    this.activeChunkId = chunk.id;
    this.activeChunkIndex = chunk.index;
    this.renderReadingPreview();
    this.chunkPlaybackMode = true;
    void this.playChunkAtIndex(chunk.index, this.chunkPlaybackSession);
  }

  private isChunkPlayable(index: number): boolean {
    const chunk = this.getChunkRecords()[index];
    if (!chunk) return false;
    if (!this.isTypingActive()) return true;
    return chunk.finalized;
  }

  private prefetchFromIndex(activeChunkId: string, session: number): void {
    if (session !== this.chunkPlaybackSession) return;
    const targets = getPrefetchTargets(this.getChunkRecords(), activeChunkId, Math.max(1, this.config.reading.streamWindowSize));
    let queuedAny = false;
    for (const chunk of targets) {
      if (!chunk.finalized || chunk.audioUrl || this.chunkInFlightById.has(chunk.id) || chunk.status === "playing") {
        continue;
      }
      chunk.status = "queued";
      queuedAny = true;
      void this.getChunkAudioUrl(chunk.id, session).catch(() => {
        // Best effort prefetch.
      });
    }
    if (queuedAny) {
      this.renderReadingPreview();
    }
  }

  private async synthesizeChunk(index: number, text: string, session: number, signal: AbortSignal): Promise<Blob> {
    const retries = Math.max(0, this.config.reading.chunkRetryCount);
    const maxAttempts = retries + 1;
    let lastError: unknown = new Error("Unknown synthesis failure");

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (session !== this.chunkPlaybackSession || signal.aborted) {
        throw new Error("Cancelled");
      }
      try {
        const done = loggers.tts.time(`chunk.${index + 1}.synthesize`);
        const blob = await this.pipeline.synthesizeText(text, this.config, {
          signal,
          timeoutMs: this.config.reading.chunkTimeoutMs
        });
        done();
        return blob;
      } catch (error) {
        lastError = error;
        if (this.isAbortError(error) || session !== this.chunkPlaybackSession || signal.aborted) {
          loggers.tts.info("Chunk synthesis cancelled", { index: index + 1, attempt });
          throw new Error("Cancelled");
        }
        loggers.tts.warn("Chunk synthesis attempt failed", { index: index + 1, attempt, error: String(error) });
        if (attempt < maxAttempts) {
          this.setStatus(this.t("status.retryingChunk", { current: index + 1, total: this.timeline.chunks.length, attempt, retries }));
          continue;
        }
      }
    }
    throw lastError;
  }

  private renderPlayState(): void {
    const playBtn = this.must<HTMLButtonElement>("btn-play");
    const icon = playBtn.querySelector<HTMLElement>("[data-lucide]");
    if (!icon) {
      throw new Error("Missing play button icon");
    }
    icon.setAttribute("data-lucide", this.audio.paused ? "play" : "pause");
    playBtn.classList.toggle("programmatic-paused", this.programmaticPauseActive);
    playBtn.title = this.programmaticPauseActive ? this.programmaticPauseReason : (this.audio.paused ? this.t("controls.play") : this.t("controls.pause"));
    this.renderIcons();
    this.updateBreakButtonState();
  }

  private renderIcons(): void {
    createIcons({ icons: APP_ICONS });
  }

  private async pasteImageFromClipboard(): Promise<string | null> {
    if (!("clipboard" in navigator) || !("read" in navigator.clipboard)) {
      return null;
    }
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const imageType = item.types.find((type) => type.startsWith("image/"));
      if (!imageType) continue;
      const blob = await item.getType(imageType);
      return this.fileToDataUrl(blob);
    }
    return null;
  }

  private setPreviewImage(dataUrl: string): void {
    const image = this.must<HTMLImageElement>("preview-img");
    const viewer = this.must<HTMLDivElement>("preview-viewer");
    const emptyState = this.must<HTMLDivElement>("image-empty");
    image.src = dataUrl;
    viewer.classList.remove("hidden");
    emptyState.classList.add("hidden");
    image.decode().then(() => this.renderMainPreviewOverlay()).catch(() => {});
  }

  private renderMainPreviewOverlay(): void {
    if (!this.mainPreviewRenderer) return;
    this.mainPreviewRenderer.setState({
      overlayMode: "committed",
      activeFilterRule: null,
      selectionBaseState: DEFAULT_CONFIG.preprocessing.selection.baseState,
      selectionOps: [],
      manualBoxes: [],
      rawBoxes: this.currentDetectedRawBoxes,
      filterResults: this.currentFilterResults,
      mergedGroups: this.currentMergedGroups,
      filterStats: this.currentFilterStats
    });
    this.mainPreviewRenderer.render();
  }

  private fileToDataUrl(file: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result;
        if (typeof result === "string") {
          resolve(result);
        } else {
          reject(new Error("Failed to read image"));
        }
      };
      reader.onerror = () => reject(reader.error ?? new Error("File read failed"));
      reader.readAsDataURL(file);
    });
  }

  private bindWorkspaceResizer(): void {
    const shell = this.must<HTMLElement>("app-shell");
    const verticalHandle = this.must<HTMLElement>("workspace-resize-vertical");
    const horizontalHandle = this.must<HTMLElement>("workspace-resize-horizontal");
    this.workspaceResizer?.dispose();
    this.workspaceResizer = new WorkspaceResizer({
      shell,
      verticalHandle,
      horizontalHandle,
      initialLeftPercent: this.config.ui.panels.desktop.leftPanePercent,
      initialRightTopPercent: this.config.ui.panels.desktop.rightTopPercent,
      onChange: ({ leftPercent, rightTopPercent }) => {
        this.config.ui.panels.desktop.leftPanePercent = Number(leftPercent.toFixed(2));
        this.config.ui.panels.desktop.rightTopPercent = Number(rightTopPercent.toFixed(2));
        this.store.save(this.config);
      }
    });
  }

  private bindMobilePaneToggles(): void {
    const bind = (
      buttonId: string,
      paneId: string,
      key: "image" | "editor" | "preview"
    ): void => {
      this.must<HTMLButtonElement>(buttonId).addEventListener("click", () => {
        const current = this.config.ui.panels.mobile.collapsed[key];
        this.config.ui.panels.mobile.collapsed[key] = !current;
        this.must<HTMLElement>(paneId).dataset.collapsed = !current ? "true" : "false";
        this.store.save(this.config);
      });
    };

    bind("pane-toggle-image", "pane-image", "image");
    bind("pane-toggle-editor", "pane-editor", "editor");
    bind("pane-toggle-reading", "pane-reading", "preview");
  }

  private mergePanels(panels: unknown): AppConfig["ui"]["panels"] {
    const defaults = DEFAULT_CONFIG.ui.panels;
    if (!panels || typeof panels !== "object") {
      return defaults;
    }
    const value = panels as Record<string, unknown>;
    const desktop = (value.desktop as Record<string, unknown> | undefined) ?? {};
    const mobile = (value.mobile as Record<string, unknown> | undefined) ?? {};
    const collapsed = (mobile.collapsed as Record<string, unknown> | undefined) ?? {};
    const legacyImageWidth = this.readNumber(value.imagePanelWidthPercent, defaults.desktop.leftPanePercent);

    return {
      desktop: {
        leftPanePercent: this.readNumber(desktop.leftPanePercent, legacyImageWidth),
        rightTopPercent: this.readNumber(desktop.rightTopPercent, defaults.desktop.rightTopPercent)
      },
      mobile: {
        imageHeightPercent: this.readNumber(mobile.imageHeightPercent, defaults.mobile.imageHeightPercent),
        editorHeightPercent: this.readNumber(mobile.editorHeightPercent, defaults.mobile.editorHeightPercent),
        previewHeightPercent: this.readNumber(mobile.previewHeightPercent, defaults.mobile.previewHeightPercent),
        collapsed: {
          image: this.readBoolean(collapsed.image, defaults.mobile.collapsed.image),
          editor: this.readBoolean(collapsed.editor, defaults.mobile.collapsed.editor),
          preview: this.readBoolean(collapsed.preview, defaults.mobile.collapsed.preview)
        }
      }
    };
  }

  private readNumber(value: unknown, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
  }

  private readBoolean(value: unknown, fallback: boolean): boolean {
    return typeof value === "boolean" ? value : fallback;
  }

  private bindLoggingSettings(): void {
    const levelSelect = this.must<HTMLSelectElement>("log-level");
    const consoleToggle = this.must<HTMLInputElement>("log-console-enabled");
    const fileToggle = this.must<HTMLInputElement>("log-file-enabled");
    const viewBtn = this.must<HTMLButtonElement>("btn-view-logs");
    const clearBtn = this.must<HTMLButtonElement>("btn-clear-logs");
    const pathLabel = this.must<HTMLDivElement>("log-path-display");

    levelSelect.addEventListener("change", async () => {
      const level = levelSelect.value as AppConfig["logging"]["level"];
      this.config.logging.level = level;
      setLogLevel(level);
      await window.electronAPI?.setLogLevel?.(level);
      this.store.save(this.config);
      loggers.settings.info("Log level changed", { level });
    });

    consoleToggle.addEventListener("change", () => {
      const enabled = consoleToggle.checked;
      this.config.logging.enableConsoleLogging = enabled;
      if (enabled && !this.consoleTransport) {
        this.consoleTransport = new ConsoleTransport();
        addTransport(this.consoleTransport);
      } else if (!enabled && this.consoleTransport) {
        removeTransport(this.consoleTransport);
        this.consoleTransport = null;
      }
      this.store.save(this.config);
    });

    fileToggle.addEventListener("change", () => {
      const enabled = fileToggle.checked;
      this.config.logging.enableFileLogging = enabled;
      if (enabled && !this.ipcTransport && window.electronAPI?.sendLogEntries) {
        this.ipcTransport = new IpcTransport();
        addTransport(this.ipcTransport);
      } else if (!enabled && this.ipcTransport) {
        this.ipcTransport.stop();
        removeTransport(this.ipcTransport);
        this.ipcTransport = null;
      }
      this.store.save(this.config);
    });

    viewBtn.addEventListener("click", async () => {
      const logPath = await window.electronAPI?.getLogFilePath?.();
      pathLabel.textContent = logPath ? this.t("logging.path.value", { path: logPath }) : this.t("logging.path.availableElectronOnly");
      this.setStatus(logPath ? this.t("logging.file.value", { path: logPath }) : this.t("status.notRunningElectron"));
    });

    clearBtn.addEventListener("click", async () => {
      await window.electronAPI?.clearLogs?.();
      this.setStatus(this.t("status.logsCleared"));
    });

    void window.electronAPI?.getLogFilePath?.().then((logPath) => {
      if (logPath) pathLabel.textContent = this.t("logging.path.value", { path: logPath });
    });
  }

  private must<T extends Element>(id: string): T {
    const element = document.getElementById(id);
    if (!element) {
      throw new Error(`Missing element: ${id}`);
    }
    return element as unknown as T;
  }
}

export function startWebApp(): void {
  window.electronAPI?.recordStartupPhase?.("renderer.app.start", {
    readyState: document.readyState,
    sinceRendererBootMs: Number((performance.now() - rendererBootAt).toFixed(2))
  });
  loggers.app.info("renderer.entry.start", {
    readyState: document.readyState,
    sinceRendererBootMs: Number((performance.now() - rendererBootAt).toFixed(2))
  });
  window.addEventListener("DOMContentLoaded", () => {
    window.electronAPI?.recordStartupPhase?.("renderer.dom-content-loaded", {
      sinceRendererBootMs: Number((performance.now() - rendererBootAt).toFixed(2))
    });
    loggers.app.info("renderer.dom-content-loaded", {
      sinceRendererBootMs: Number((performance.now() - rendererBootAt).toFixed(2))
    });
  }, { once: true });
  const root = document.getElementById("app");
  if (!root) {
    throw new Error("Missing #app");
  }

  if (!localStorage.getItem(SETTINGS_KEY)) {
    const legacySettings = LEGACY_SETTINGS_KEYS
      .map((key) => localStorage.getItem(key))
      .find((value) => typeof value === "string");
    localStorage.setItem(SETTINGS_KEY, legacySettings ?? JSON.stringify(DEFAULT_CONFIG));
  }

  window.electronAPI?.recordStartupPhase?.("renderer.app.mount.begin", {
    sinceRendererBootMs: Number((performance.now() - rendererBootAt).toFixed(2))
  });
  new WebApp().mount(root);
  window.electronAPI?.recordStartupPhase?.("renderer.app.mount.end", {
    sinceRendererBootMs: Number((performance.now() - rendererBootAt).toFixed(2))
  });
  dismissBootScreen();
  window.electronAPI?.recordStartupPhase?.("renderer.boot.dismissed", {
    sinceRendererBootMs: Number((performance.now() - rendererBootAt).toFixed(2))
  });
}

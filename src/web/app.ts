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
import type { ManagedServiceId, ManagedServiceStatus, ManagedServicesStatus, UiTheme } from "../core/services/platform";
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
  applyButtonId: string;
  cancelButtonId: string;
  beginEdit: (() => Promise<string>) | undefined;
  apply: ((hotkey: string) => Promise<string>) | undefined;
  clear: (() => Promise<string>) | undefined;
  cancelEdit: (() => Promise<string>) | undefined;
}

type CaptureContext = {
  source: "hotkey" | "clipboard" | "upload" | "paste" | "drop";
  captureKind?: "selection" | "fullscreen" | "window";
  resultMode?: "editor" | "clipboard";
};

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
  private timeline: ReadingTimeline = { chunks: [], durationMs: 0 };
  private activeChunkId: string | null = null;
  private activeChunkIndex = 0;
  private speakingChunkId: string | null = null;
  private speakingRevision: number | null = null;
  private readonly optionCache = new Map<string, NamedOption[]>();
  private llmModelSelect: TomSelect | null = null;
  private ttsModelSelect: TomSelect | null = null;
  private ttsVoiceSelect: TomSelect | null = null;
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
          applyButtonId: "btn-copy-hotkey-apply",
          cancelButtonId: "btn-copy-hotkey-cancel",
          beginEdit: api?.beginCopyHotkeyEdit,
          apply: api?.applyCopyHotkey,
          clear: api?.clearCopyHotkey,
          cancelEdit: api?.cancelCopyHotkeyEdit
        };
      case "abort":
        return {
          systemKey: "abortHotkey",
          inputId: "abort-hotkey",
          statusId: "abort-hotkey-recording-status",
          recordButtonId: "btn-abort-hotkey-record",
          clearButtonId: "btn-abort-hotkey-clear",
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
    void this.refreshManagedServicesStatus();
    void this.syncAllElectronHotkeysFromSettings();
    void this.syncElectronCaptureRectangleSetting();
    this.logBootstrapStep("electron.settings.sync.started");
    this.installE2eHooks();
    this.logBootstrapStep("e2e.hooks.installed");
    window.addEventListener("beforeunload", () => {
      this.logLifecycle("window.beforeunload");
    });
    window.addEventListener("unload", () => {
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
        sessionStarts: this.playbackMetrics.sessionStarts,
        playChunkRequests: this.playbackMetrics.playChunkRequests,
        ttsStartsBySessionAndHash: { ...this.playbackMetrics.ttsStartsBySessionAndHash }
      }),
      clearPlaybackMetrics: () => {
        this.playbackMetrics.sessionStarts = 0;
        this.playbackMetrics.playChunkRequests = 0;
        this.playbackMetrics.ttsStartsBySessionAndHash = {};
      }
    };
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
    const error = await window.electronAPI.openRuntimeServicesFolder();
    if (error) {
      this.setStatus(this.t("status.runtimeServicesOpenFailed", { error }));
      return;
    }
    this.setStatus(this.t("status.runtimeServicesOpened"));
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
      [this.ttsVoiceSelect, this.t("tts.voice")]
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
    this.must<HTMLSelectElement>("detector-mode").addEventListener("change", () => this.syncConfigFromInputs());
    this.must<HTMLButtonElement>("detector-health").addEventListener("click", async () => {
      await this.checkDetectorHealth();
    });
    this.must<HTMLButtonElement>("btn-launch-paddle-service").addEventListener("click", () => {
      void this.launchManagedService("paddle");
    });
    this.must<HTMLButtonElement>("btn-stop-paddle-service").addEventListener("click", () => {
      void this.stopManagedService("paddle");
    });
    this.must<HTMLButtonElement>("btn-launch-edge-service").addEventListener("click", () => {
      void this.launchManagedService("edge");
    });
    this.must<HTMLButtonElement>("btn-stop-edge-service").addEventListener("click", () => {
      void this.stopManagedService("edge");
    });
    this.must<HTMLButtonElement>("btn-open-runtime-services").addEventListener("click", () => {
      void this.openRuntimeServicesFolder();
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
      void this.syncElectronOverlayTheme();
      void this.syncElectronCaptureRectangleSetting();
      this.setStatus(this.t("status.settingsReset"));
    });

    this.must<HTMLButtonElement>("btn-hotkey-record").addEventListener("click", () => {
      void this.beginHotkeyRecording("capture");
    });
    this.must<HTMLButtonElement>("btn-hotkey-clear").addEventListener("click", () => {
      void this.clearHotkey("capture");
    });
    this.must<HTMLButtonElement>("btn-hotkey-apply").addEventListener("click", () => {
      void this.applyRecordedHotkey("capture");
    });
    this.must<HTMLButtonElement>("btn-hotkey-cancel").addEventListener("click", () => {
      void this.cancelHotkeyRecording("capture");
    });
    this.must<HTMLButtonElement>("btn-ocr-clipboard-hotkey-record").addEventListener("click", () => {
      void this.beginHotkeyRecording("ocrClipboard");
    });
    this.must<HTMLButtonElement>("btn-ocr-clipboard-hotkey-clear").addEventListener("click", () => {
      void this.clearHotkey("ocrClipboard");
    });
    this.must<HTMLButtonElement>("btn-ocr-clipboard-hotkey-apply").addEventListener("click", () => {
      void this.applyRecordedHotkey("ocrClipboard");
    });
    this.must<HTMLButtonElement>("btn-ocr-clipboard-hotkey-cancel").addEventListener("click", () => {
      void this.cancelHotkeyRecording("ocrClipboard");
    });
    this.must<HTMLButtonElement>("btn-full-capture-hotkey-record").addEventListener("click", () => {
      void this.beginHotkeyRecording("fullCapture");
    });
    this.must<HTMLButtonElement>("btn-full-capture-hotkey-clear").addEventListener("click", () => {
      void this.clearHotkey("fullCapture");
    });
    this.must<HTMLButtonElement>("btn-full-capture-hotkey-apply").addEventListener("click", () => {
      void this.applyRecordedHotkey("fullCapture");
    });
    this.must<HTMLButtonElement>("btn-full-capture-hotkey-cancel").addEventListener("click", () => {
      void this.cancelHotkeyRecording("fullCapture");
    });
    this.must<HTMLButtonElement>("btn-active-window-capture-hotkey-record").addEventListener("click", () => {
      void this.beginHotkeyRecording("activeWindowCapture");
    });
    this.must<HTMLButtonElement>("btn-active-window-capture-hotkey-clear").addEventListener("click", () => {
      void this.clearHotkey("activeWindowCapture");
    });
    this.must<HTMLButtonElement>("btn-active-window-capture-hotkey-apply").addEventListener("click", () => {
      void this.applyRecordedHotkey("activeWindowCapture");
    });
    this.must<HTMLButtonElement>("btn-active-window-capture-hotkey-cancel").addEventListener("click", () => {
      void this.cancelHotkeyRecording("activeWindowCapture");
    });
    this.must<HTMLButtonElement>("btn-copy-hotkey-record").addEventListener("click", () => {
      void this.beginHotkeyRecording("copyPlay");
    });
    this.must<HTMLButtonElement>("btn-copy-hotkey-clear").addEventListener("click", () => {
      void this.clearHotkey("copyPlay");
    });
    this.must<HTMLButtonElement>("btn-copy-hotkey-apply").addEventListener("click", () => {
      void this.applyRecordedHotkey("copyPlay");
    });
    this.must<HTMLButtonElement>("btn-copy-hotkey-cancel").addEventListener("click", () => {
      void this.cancelHotkeyRecording("copyPlay");
    });
    this.must<HTMLButtonElement>("btn-abort-hotkey-record").addEventListener("click", () => {
      void this.beginHotkeyRecording("abort");
    });
    this.must<HTMLButtonElement>("btn-abort-hotkey-clear").addEventListener("click", () => {
      void this.clearHotkey("abort");
    });
    this.must<HTMLButtonElement>("btn-abort-hotkey-apply").addEventListener("click", () => {
      void this.applyRecordedHotkey("abort");
    });
    this.must<HTMLButtonElement>("btn-abort-hotkey-cancel").addEventListener("click", () => {
      void this.cancelHotkeyRecording("abort");
    });
    this.must<HTMLButtonElement>("btn-play-pause-hotkey-record").addEventListener("click", () => {
      void this.beginHotkeyRecording("playPause");
    });
    this.must<HTMLButtonElement>("btn-play-pause-hotkey-clear").addEventListener("click", () => {
      void this.clearHotkey("playPause");
    });
    this.must<HTMLButtonElement>("btn-play-pause-hotkey-apply").addEventListener("click", () => {
      void this.applyRecordedHotkey("playPause");
    });
    this.must<HTMLButtonElement>("btn-play-pause-hotkey-cancel").addEventListener("click", () => {
      void this.cancelHotkeyRecording("playPause");
    });
    this.must<HTMLButtonElement>("btn-next-chunk-hotkey-record").addEventListener("click", () => {
      void this.beginHotkeyRecording("nextChunk");
    });
    this.must<HTMLButtonElement>("btn-next-chunk-hotkey-clear").addEventListener("click", () => {
      void this.clearHotkey("nextChunk");
    });
    this.must<HTMLButtonElement>("btn-next-chunk-hotkey-apply").addEventListener("click", () => {
      void this.applyRecordedHotkey("nextChunk");
    });
    this.must<HTMLButtonElement>("btn-next-chunk-hotkey-cancel").addEventListener("click", () => {
      void this.cancelHotkeyRecording("nextChunk");
    });
    this.must<HTMLButtonElement>("btn-previous-chunk-hotkey-record").addEventListener("click", () => {
      void this.beginHotkeyRecording("previousChunk");
    });
    this.must<HTMLButtonElement>("btn-previous-chunk-hotkey-clear").addEventListener("click", () => {
      void this.clearHotkey("previousChunk");
    });
    this.must<HTMLButtonElement>("btn-previous-chunk-hotkey-apply").addEventListener("click", () => {
      void this.applyRecordedHotkey("previousChunk");
    });
    this.must<HTMLButtonElement>("btn-previous-chunk-hotkey-cancel").addEventListener("click", () => {
      void this.cancelHotkeyRecording("previousChunk");
    });
    this.must<HTMLButtonElement>("btn-volume-up-hotkey-record").addEventListener("click", () => {
      void this.beginHotkeyRecording("volumeUp");
    });
    this.must<HTMLButtonElement>("btn-volume-up-hotkey-clear").addEventListener("click", () => {
      void this.clearHotkey("volumeUp");
    });
    this.must<HTMLButtonElement>("btn-volume-up-hotkey-apply").addEventListener("click", () => {
      void this.applyRecordedHotkey("volumeUp");
    });
    this.must<HTMLButtonElement>("btn-volume-up-hotkey-cancel").addEventListener("click", () => {
      void this.cancelHotkeyRecording("volumeUp");
    });
    this.must<HTMLButtonElement>("btn-volume-down-hotkey-record").addEventListener("click", () => {
      void this.beginHotkeyRecording("volumeDown");
    });
    this.must<HTMLButtonElement>("btn-volume-down-hotkey-clear").addEventListener("click", () => {
      void this.clearHotkey("volumeDown");
    });
    this.must<HTMLButtonElement>("btn-volume-down-hotkey-apply").addEventListener("click", () => {
      void this.applyRecordedHotkey("volumeDown");
    });
    this.must<HTMLButtonElement>("btn-volume-down-hotkey-cancel").addEventListener("click", () => {
      void this.cancelHotkeyRecording("volumeDown");
    });
    this.must<HTMLButtonElement>("btn-replay-capture-hotkey-record").addEventListener("click", () => {
      void this.beginHotkeyRecording("replayCapture");
    });
    this.must<HTMLButtonElement>("btn-replay-capture-hotkey-clear").addEventListener("click", () => {
      void this.clearHotkey("replayCapture");
    });
    this.must<HTMLButtonElement>("btn-replay-capture-hotkey-apply").addEventListener("click", () => {
      void this.applyRecordedHotkey("replayCapture");
    });
    this.must<HTMLButtonElement>("btn-replay-capture-hotkey-cancel").addEventListener("click", () => {
      void this.cancelHotkeyRecording("replayCapture");
    });

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
    this.renderManagedServicesStatus();
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
          selection: {
            ...DEFAULT_CONFIG.preprocessing.selection,
            ...parsed.preprocessing?.selection,
            ops: parsed.preprocessing?.selection?.ops ?? DEFAULT_CONFIG.preprocessing.selection.ops,
            manualBoxes: parsed.preprocessing?.selection?.manualBoxes ?? DEFAULT_CONFIG.preprocessing.selection.manualBoxes
          }
        }
      };
      Object.assign(this.config, merged);
      this.config.system.lastImportAt = new Date().toISOString();
      this.renderConfig();
      this.updateTimelineFromRawText();
      this.store.save(this.config);
      void this.syncAllElectronHotkeysFromSettings();
      void this.syncElectronOverlayTheme();
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

  private async abortVisionWork(reason: "new_image" | "superseded"): Promise<void> {
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
    this.abortPlaybackAndSynthesis();
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

    window.electronAPI?.onCapturedImage(async ({ dataUrl, captureKind, resultMode, hotkey }) => {
      loggers.capture.info("Hotkey capture image received");
      const hotkeyKey: ConfigurableHotkeyKey = hotkey ?? (captureKind === "fullscreen"
        ? "fullCapture"
        : captureKind === "window"
          ? "activeWindowCapture"
          : resultMode === "clipboard"
            ? "ocrClipboard"
            : "capture");
      if (this.shouldUseHotkeyFeedbackFallback(hotkeyKey)) {
        void this.playConfiguredHotkeyFeedback(hotkeyKey);
      }
      await this.abortVisionWork("new_image");
      await this.runPipeline(dataUrl, { source: "hotkey", captureKind, resultMode });
    });

    window.electronAPI?.onCopiedTextForPlayback(async (text: string) => {
      if (this.shouldUseHotkeyFeedbackFallback("copyPlay")) {
        void this.playConfiguredHotkeyFeedback("copyPlay");
      }
      if (this.hasActiveWork()) await this.abortAllWork("superseded");
      await this.playCopiedText(text);
    });
    window.electronAPI?.onAbortRequested(() => {
      void this.playConfiguredHotkeyFeedback("abort");
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
        this.currentMergedGroups = result.mergedGroups;
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

  private async playCopiedText(text: string): Promise<void> {
    const nextText = text.trim();
    if (!nextText) {
      this.setStatus(this.t("status.copyHotkeyNoText"));
      return;
    }
    this.must<HTMLTextAreaElement>("raw-text").value = nextText;
    this.updateTimelineFromRawText();
    this.resetPlaybackForTextChange();
    this.setStatus(this.t("status.copiedTextPlaying"));
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
    return ["capture", "ocrClipboard", "fullCapture", "activeWindowCapture", "copyPlay", "abort", "playPause", "nextChunk", "previousChunk", "volumeUp", "volumeDown", "replayCapture"];
  }

  private renderHotkeyButtonState(): void {
    for (const key of this.getConfigurableHotkeyKeys()) {
      const binding = this.getHotkeyBindingConfig(key);
      const available = Boolean(binding.beginEdit);
      const editing = this.hotkeyRecordingState[key];
      const recordButton = this.must<HTMLButtonElement>(binding.recordButtonId);
      const clearButton = this.must<HTMLButtonElement>(binding.clearButtonId);
      const applyButton = this.must<HTMLButtonElement>(binding.applyButtonId);
      const cancelButton = this.must<HTMLButtonElement>(binding.cancelButtonId);
      recordButton.hidden = editing;
      clearButton.hidden = editing;
      applyButton.hidden = !editing;
      cancelButton.hidden = !editing;
      recordButton.style.display = editing ? "none" : "";
      clearButton.style.display = editing ? "none" : "";
      applyButton.style.display = editing ? "" : "none";
      cancelButton.style.display = editing ? "" : "none";
      recordButton.disabled = !available || this.hotkeyRecordingState[key];
      clearButton.disabled = !available || editing;
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
      case "abort": return "system.abortHotkey";
      case "playPause": return "system.playPauseHotkey";
      case "nextChunk": return "system.nextChunkHotkey";
      case "previousChunk": return "system.previousChunkHotkey";
      case "volumeUp": return "system.volumeUpHotkey";
      case "volumeDown": return "system.volumeDownHotkey";
      case "replayCapture": return "system.replayCaptureHotkey";
    }
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

  private getHotkeyStatus(value: string): string {
    return value ? this.t("hotkey.currentActive") : this.t("hotkey.none");
  }

  private getHotkeyAppliedStatus(value: string): string {
    return value ? this.t("hotkey.active", { hotkey: value }) : this.t("hotkey.none");
  }

  private bindPlayback(): void {
    const volSlider = this.must<HTMLInputElement>("vol-slider");
    const volInput = this.must<HTMLInputElement>("vol-input");
    const speedSlider = this.must<HTMLInputElement>("speed-slider");
    const speedInput = this.must<HTMLInputElement>("speed-input");
    speedSlider.min = String(MIN_PLAYBACK_RATE);
    speedSlider.max = String(MAX_PLAYBACK_RATE);
    speedInput.min = String(MIN_PLAYBACK_RATE);
    speedInput.max = String(MAX_PLAYBACK_RATE);

    const updateVol = (val: number) => {
      this.applyVolumeValue(val);
    };

    const updateSpeed = (val: number) => {
      this.applyPlaybackRateValue(val);
    };

    volSlider.addEventListener("input", () => updateVol(Number(volSlider.value)));
    volInput.addEventListener("change", () => updateVol(Number(volInput.value)));
    speedSlider.addEventListener("input", () => updateSpeed(Number(speedSlider.value)));
    speedInput.addEventListener("input", () => {
      const raw = speedInput.value.trim();
      if (!raw || raw.endsWith(".")) return;
      const next = Number(raw);
      if (!Number.isFinite(next)) return;
      this.applyPlaybackRateValue(next);
    });
    speedInput.addEventListener("change", () => updateSpeed(Number(speedInput.value)));

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
      if (nextIndex >= this.timeline.chunks.length) {
        this.chunkPlaybackMode = false;
        this.audio.src = "";
        this.audio.currentTime = 0;
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
    speedSlider.value = String(next);
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
    this.setStatus(this.t("status.runningPipeline"));
    const done = loggers.pipeline.time("pipeline.run");
    try {
      this.lastOriginalImageDataUrl = await normalizeImageDataUrl(dataUrl);
      this.throwIfStale(runId);
      const ocrInput = await this.buildOcrInput(this.lastOriginalImageDataUrl, signal, runId, (imageDataUrl) => {
        if (runId !== this.activeRunId) return;
        // Show image immediately; detected boxes will be layered when detect finishes.
        this.currentDetectedRawBoxes = [];
        this.currentFilterResults = [];
        this.currentMergedGroups = [];
        this.currentFilterStats = { widthRemoved: 0, heightRemoved: 0, medianRemoved: 0, medianHeightPx: 0 };
        this.setPreviewImage(imageDataUrl);
        this.renderMainPreviewOverlay();
      }, captureContext);
      this.throwIfStale(runId);
      this.currentOcrImageDataUrl = ocrInput.imageDataUrl;
      this.currentOcrRegions = ocrInput.regions;
      this.setPreviewImage(ocrInput.imageDataUrl);
      this.renderMainPreviewOverlay();
      const resultMode = captureContext.resultMode === "clipboard" ? "clipboard" : "editor";
      const streamingEnabled = resultMode === "editor" && this.config.llm.ocrStreamingEnabled;
      let result: { text: string };
      if (streamingEnabled) {
        result = await this.runStreamingOcr(ocrInput.imageDataUrl, ocrInput.regions, signal);
      } else {
        result = await this.pipeline.run(ocrInput.imageDataUrl, this.config, { regions: ocrInput.regions, signal });
      }
      this.throwIfStale(runId);
      if (!result.text.trim()) {
        throw new Error("OCR produced empty text");
      }
      done();
      loggers.pipeline.info("Pipeline completed", { textLength: result.text.length });
      if (resultMode === "clipboard") {
        await this.copyTextToClipboard(this.normalizeTextForClipboard(result.text));
        this.setStatus(this.t("status.ocrCopiedToClipboard"));
      } else if (!streamingEnabled) {
        this.must<HTMLTextAreaElement>("raw-text").value = result.text;
        this.updateTimelineFromRawText();
        this.resetPlaybackForTextChange();
        await this.startOrResumePlayback();
      }
    } catch (error) {
      if (this.isAbortError(error)) {
        loggers.pipeline.info("Pipeline cancelled", { runId });
      } else {
        loggers.pipeline.error("Pipeline failed", { error: String(error) });
        if (captureContext.source === "hotkey") {
          await this.playConfiguredErrorFeedback();
        }
        this.setStatus(
          captureContext.resultMode === "clipboard"
            ? this.withApiBaseUrlHint(this.t("status.ocrCopyToClipboardFailed", { error: String(error) }), "ocr", this.config.llm.baseUrl)
            : this.withApiBaseUrlHint(this.t("status.pipelineError", { error: String(error) }), "ocr", this.config.llm.baseUrl)
        );
      }
    } finally {
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
    const requestPromise = this.synthesizeChunk(chunk.index, chunk.text, session, controller.signal)
      .then((audioBlob) => {
        if (session !== this.chunkPlaybackSession) {
          throw new Error("Cancelled");
        }
        const url = URL.createObjectURL(audioBlob);
        const current = this.getChunkById(chunkId);
        if (!current || current.revision !== revision) {
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
    const pre = this.config.preprocessing;
    this.mainPreviewRenderer.setState({
      overlayMode: "committed",
      activeFilterRule: null,
      selectionBaseState: pre.selection.baseState,
      selectionOps: pre.selection.ops,
      manualBoxes: pre.selection.manualBoxes,
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

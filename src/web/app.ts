import TomSelect from "tom-select";
import "tom-select/dist/css/tom-select.css";
import { createIcons, icons } from "lucide";
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
import type { AppConfig, ReadingTimeline } from "../core/models/types";
import {
  createChunkRecords,
  getPrefetchTargets,
  reconcileChunks,
  toReadingTimeline,
  type ChunkRecord,
  type ChunkStatus
} from "../core/playback/chunking";
import { AppPipeline } from "../core/pipeline/app-pipeline";
import { SettingsStore } from "../core/services/settings-store";
import { WorkspaceResizer } from "../ui/workspace-resizer";
import { cleanTextForTts, findChunkIndexByTime } from "../core/utils/chunking";
import { RequestPreemptor } from "../core/utils/request-preemptor";
import { APP_TEMPLATE } from "../ui/template";
import { PreprocessModalController, type DrawRect } from "../features/preprocessing";
import { applyPreprocessToDataUrl, normalizeImageDataUrl, scaleDataUrlMaxDimension } from "../features/preprocessing/image";
import { detectRapidRawBoxes } from "../features/preprocessing/rapid-client";
import { filterBySize, finalizeOcrBoxes, manualToRaw, mergeCloseBoxes, selectionKeepRatio, sortByReadingOrder } from "../features/preprocessing/logic";
import { PreprocPreviewRenderer } from "../features/preprocessing/preview-renderer";
import type { FilteredBox, MergeGroup, RawBox } from "../features/preprocessing/types";
import "../ui/styles.css";

interface NamedOption {
  value: string;
  label: string;
}

interface ModelListResponse {
  data?: Array<{ id?: string }>;
}

type RequestLane = "ocr" | "rapid_main" | "rapid_modal";

interface PlaybackMetrics {
  sessionStarts: number;
  playChunkRequests: number;
  ttsStartsBySessionAndHash: Record<string, number>;
}

export class WebApp {
  private readonly store = new SettingsStore();
  private readonly pipeline = new AppPipeline();
  private readonly config: AppConfig = this.store.load();
  private readonly audio = new Audio();
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
  private captureHotkeyRecording = false;
  private pendingCaptureHotkey: string | null = null;
  private captureHotkeyKeydownHandler: ((event: KeyboardEvent) => void) | null = null;
  private copyHotkeyRecording = false;
  private pendingCopyPlayHotkey: string | null = null;
  private copyHotkeyKeydownHandler: ((event: KeyboardEvent) => void) | null = null;
  private preprocessModal: PreprocessModalController | null = null;
  private mainPreviewRenderer: PreprocPreviewRenderer | null = null;
  private lastOriginalImageDataUrl: string | null = null;
  private currentOcrImageDataUrl: string | null = null;
  private currentOcrRegions: DrawRect[] = [];
  private currentRapidRawBoxes: RawBox[] = [];
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
  private playbackStartInFlight = false;
  private readonly playbackMetrics: PlaybackMetrics = {
    sessionStarts: 0,
    playChunkRequests: 0,
    ttsStartsBySessionAndHash: {}
  };

  mount(root: HTMLElement): void {
    this.initializeLogging();
    root.innerHTML = APP_TEMPLATE;
    this.applyUiState();
    this.renderIcons();
    this.bindWindowControls();
    this.bindModelSelectors();
    this.bindSettings();
    this.bindCapture();
    this.bindBreak();
    this.bindMainPreviewRenderer();
    this.bindPreprocessModal();
    this.bindPlayback();
    this.bindWorkspaceResizer();
    this.bindMobilePaneToggles();
    this.bindLoggingSettings();
    this.renderConfig();
    void this.syncElectronCaptureHotkeyFromSettings();
    void this.syncElectronCopyHotkeyFromSettings();
    void this.syncElectronCaptureRectangleSetting();
    this.installE2eHooks();
    loggers.app.info("App mounted");
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

  private reconcileText(nextText: string, options?: { finalizeTail?: boolean; source?: "user" | "llm" }): void {
    const previousChunks = this.getChunkRecords();
    const previousText = this.lastPlaybackText;
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
          ...(this.activeChunkId ? { activeChunkId: this.activeChunkId } : {}),
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
      this.setStatus(options?.source === "llm" ? "Streaming updated the spoken chunk. Playback stopped." : "Edited spoken chunk. Playback stopped.");
    }

    this.renderReadingPreview();
    this.maybeStartPlaybackFromStream();

    if (previousText !== nextText && !speakingInvalidated && options?.source === "user") {
      this.setStatus("Text updated.");
    }
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

  private bindModelSelectors(): void {
    this.llmModelSelect = new TomSelect(this.must<HTMLSelectElement>("llm-model"), {
      create: true,
      persist: false,
      maxOptions: 500,
      placeholder: "Select OCR model"
    });

    this.ttsModelSelect = new TomSelect(this.must<HTMLSelectElement>("tts-model"), {
      create: true,
      persist: false,
      maxOptions: 500,
      placeholder: "Select TTS model"
    });

    this.ttsVoiceSelect = new TomSelect(this.must<HTMLSelectElement>("tts-voice"), {
      create: true,
      persist: false,
      maxOptions: 500,
      placeholder: "Select voice"
    });

    this.bindSelectorFetchBehavior(this.llmModelSelect, "llm-model", () => this.fetchLlmModels(false));
    this.bindSelectorFetchBehavior(this.ttsModelSelect, "tts-model", () => this.fetchTtsModels(false));
    this.bindSelectorFetchBehavior(this.ttsVoiceSelect, "tts-voice", () => this.fetchTtsVoices(false));

    this.must<HTMLButtonElement>("llm-refetch").addEventListener("click", () => {
      void this.fetchLlmModels(true);
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
      this.store.save(this.config);
    });

    this.ttsModelSelect.on("change", (value: string) => {
      this.config.tts.model = value;
      this.store.save(this.config);
    });

    this.ttsVoiceSelect.on("change", (value: string) => {
      this.config.tts.voice = value;
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
    const options = await this.fetchOptionsFromModelsEndpoint(this.config.llm.baseUrl, this.config.llm.apiKey, force, "llm-models");
    this.applyOptions(this.llmModelSelect, options, this.config.llm.model);
  }

  private async fetchTtsModels(force: boolean): Promise<void> {
    const options = await this.fetchOptionsFromModelsEndpoint(this.config.tts.baseUrl, this.config.tts.apiKey, force, "tts-models");
    this.applyOptions(this.ttsModelSelect, options, this.config.tts.model);
  }

  private async fetchTtsVoices(force: boolean): Promise<void> {
    const base = this.config.tts.baseUrl;
    const key = this.config.tts.apiKey;
    const cacheKey = this.makeCacheKey("tts-voices", base, key);

    if (!force && this.optionCache.has(cacheKey)) {
      this.applyOptions(this.ttsVoiceSelect, this.optionCache.get(cacheKey) ?? [], this.config.tts.voice);
      return;
    }

    const voices = await this.tryFetchVoiceOptions(base, key);
    this.optionCache.set(cacheKey, voices);
    this.applyOptions(this.ttsVoiceSelect, voices, this.config.tts.voice);
  }

  private async checkRapidHealth(): Promise<void> {
    const base = this.config.textProcessing.rapidBaseUrl;
    try {
      const response = await fetch(`${base.trim().replace(/\/+$/, "")}/healthz`);
      if (!response.ok) {
        this.updateStatusChip("rapid-status-chip", `HTTP ${response.status}`, "error");
        this.setStatus(`RapidOCR health failed: HTTP ${response.status}`);
        return;
      }
      const payload = (await response.json()) as { ok?: boolean; detector?: string };
      if (!payload.ok) {
        this.updateStatusChip("rapid-status-chip", "Unhealthy", "error");
        this.setStatus("RapidOCR health failed: unhealthy");
        return;
      }
      this.updateStatusChip("rapid-status-chip", `Healthy (${payload.detector ?? "rapid"})`, "ok");
      this.setStatus("RapidOCR is healthy.");
    } catch (error) {
      this.updateStatusChip("rapid-status-chip", "Unreachable", "error");
      this.setStatus(`RapidOCR health failed: ${String(error)}`);
    }
  }

  private async tryFetchVoiceOptions(baseUrl: string, apiKey: string): Promise<NamedOption[]> {
    const candidates = ["/voices", "/audio/voices", "/models"];
    for (const path of candidates) {
      try {
        const response = await fetch(this.joinApiPath(baseUrl, path), {
          headers: this.authHeaders(apiKey)
        });
        if (!response.ok) continue;
        const body = (await response.json()) as unknown;
        const options = this.parseOptions(body);
        if (options.length > 0) {
          this.updateStatusChip("tts-status-chip", "Voices loaded", "ok");
          return options;
        }
      } catch {
        // try next endpoint
      }
    }
    this.updateStatusChip("tts-status-chip", "Voice list unavailable", "error");
    this.setStatus("Voice list unavailable from API; you can still type manually.");
    return this.config.tts.voice ? [{ value: this.config.tts.voice, label: this.config.tts.voice }] : [];
  }

  private async fetchOptionsFromModelsEndpoint(
    baseUrl: string,
    apiKey: string,
    force: boolean,
    namespace: string
  ): Promise<NamedOption[]> {
    const cacheKey = this.makeCacheKey(namespace, baseUrl, apiKey);
    if (!force && this.optionCache.has(cacheKey)) {
      return this.optionCache.get(cacheKey) ?? [];
    }

    try {
      const response = await fetch(this.joinApiPath(baseUrl, "/models"), {
        headers: this.authHeaders(apiKey)
      });
      if (!response.ok) {
        this.setStatus(`Failed to fetch ${namespace}: ${response.status}`);
        if (namespace.startsWith("llm")) this.updateStatusChip("llm-status-chip", `HTTP ${response.status}`, "error");
        if (namespace.startsWith("tts")) this.updateStatusChip("tts-status-chip", `HTTP ${response.status}`, "error");
        return [];
      }

      const payload = (await response.json()) as ModelListResponse;
      const options = (payload.data ?? [])
        .map((item) => item.id?.trim() ?? "")
        .filter((id) => id.length > 0)
        .map((id) => ({ value: id, label: id }));

      this.optionCache.set(cacheKey, options);
      if (force) {
        this.setStatus(`Refetched ${namespace}`);
      }
      if (namespace.startsWith("llm")) this.updateStatusChip("llm-status-chip", `Loaded ${options.length}`, "ok");
      if (namespace.startsWith("tts")) this.updateStatusChip("tts-status-chip", `Loaded ${options.length}`, "ok");
      return options;
    } catch (error) {
      this.setStatus(`Failed to fetch ${namespace}: ${String(error)}`);
      if (namespace.startsWith("llm")) this.updateStatusChip("llm-status-chip", "Network error", "error");
      if (namespace.startsWith("tts")) this.updateStatusChip("tts-status-chip", "Network error", "error");
      return [];
    }
  }

  private parseOptions(payload: unknown): NamedOption[] {
    if (!payload || typeof payload !== "object") return [];
    const obj = payload as Record<string, unknown>;

    if (Array.isArray(obj.data)) {
      return obj.data
        .map((item) => {
          if (typeof item !== "object" || !item) return null;
          const record = item as Record<string, unknown>;
          const id = typeof record.id === "string" ? record.id : "";
          if (!id) return null;
          return { value: id, label: id };
        })
        .filter((item): item is NamedOption => item !== null);
    }

    if (Array.isArray(obj.voices)) {
      return obj.voices
        .map((entry) => {
          if (typeof entry === "string") return { value: entry, label: entry };
          if (typeof entry === "object" && entry) {
            const record = entry as Record<string, unknown>;
            const id = typeof record.id === "string" ? record.id : "";
            const name = typeof record.name === "string" ? record.name : id;
            if (!id) return null;
            return { value: id, label: name };
          }
          return null;
        })
        .filter((item): item is NamedOption => item !== null);
    }

    return [];
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

  private authHeaders(apiKey: string): HeadersInit {
    if (!apiKey) {
      return {};
    }
    return { Authorization: `Bearer ${apiKey}` };
  }

  private makeCacheKey(namespace: string, baseUrl: string, apiKey: string): string {
    return `${namespace}|${baseUrl.trim()}|${apiKey.trim()}`;
  }

  private joinApiPath(baseUrl: string, path: string): string {
    const normalized = baseUrl.replace(/\/+$/, "");
    const safePath = path.startsWith("/") ? path : `/${path}`;
    if (normalized.endsWith("/v1") || normalized.endsWith("/v1/")) {
      return `${normalized}${safePath}`;
    }
    return `${normalized}/v1${safePath}`;
  }

  private bindWindowControls(): void {
    const pinButton = this.must<HTMLButtonElement>("btn-pin");
    const minimizeButton = this.must<HTMLButtonElement>("btn-minimize");
    const maximizeButton = this.must<HTMLButtonElement>("btn-maximize");
    const closeButton = this.must<HTMLButtonElement>("btn-close");

    if (!window.electronAPI) {
      pinButton.disabled = true;
      minimizeButton.disabled = true;
      maximizeButton.disabled = true;
      closeButton.disabled = true;
      this.setStatus("Desktop window controls unavailable (running in browser mode).");
      return;
    }

    minimizeButton.addEventListener("click", () => {
      window.electronAPI?.minimizeWindow();
    });

    maximizeButton.addEventListener("click", async () => {
      const isMaximized = await window.electronAPI?.toggleMaximizeWindow();
      maximizeButton.innerHTML = isMaximized
        ? '<i data-lucide="copy" class="ui-icon"></i>'
        : '<i data-lucide="square" class="ui-icon"></i>';
      this.renderIcons();
      maximizeButton.title = isMaximized ? "Restore" : "Maximize";
    });

    closeButton.addEventListener("click", () => {
      window.electronAPI?.closeWindow();
    });

    void window.electronAPI?.getPinState().then((pinned) => {
      if (pinned) {
        pinButton.classList.add("active-pin");
      } else {
        pinButton.classList.remove("active-pin");
      }
    });

    pinButton.addEventListener("click", async () => {
      const pinned = await window.electronAPI?.togglePinWindow();
      if (pinned) {
        pinButton.classList.add("active-pin");
        this.setStatus("Always on top: On");
      } else {
        pinButton.classList.remove("active-pin");
        this.setStatus("Always on top: Off");
      }
    });
  }

  private setStatus(text: string): void {
    const el = this.must<HTMLSpanElement>("status-text");
    el.textContent = text;
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

    const basicIds = [
      "llm-url",
      "llm-key",
      "llm-prompt",
      "llm-image-detail",
      "llm-max-tokens",
      "rapid-url",
      "tts-url",
      "tts-key",
      "chunk-min",
      "chunk-max",
      "clean-text-before-tts",
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

    this.must<HTMLInputElement>("diagnostics-enabled").addEventListener("change", () => this.syncConfigFromInputs());
    this.must<HTMLInputElement>("rapid-enabled").addEventListener("change", () => this.syncConfigFromInputs());
    this.must<HTMLButtonElement>("rapid-health").addEventListener("click", async () => {
      await this.checkRapidHealth();
    });
    this.must<HTMLInputElement>("capture-draw-rectangle").addEventListener("change", () => {
      this.syncConfigFromInputs();
      void this.syncElectronCaptureRectangleSetting();
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
      this.renderConfig();
      this.store.save(this.config);
      this.updateTimelineFromRawText();
      void this.syncElectronCaptureHotkeyFromSettings();
      void this.syncElectronCopyHotkeyFromSettings();
      void this.syncElectronCaptureRectangleSetting();
      this.setStatus("Settings reset to defaults.");
    });

    this.must<HTMLButtonElement>("btn-hotkey-record").addEventListener("click", () => {
      void this.beginHotkeyRecording();
    });
    this.must<HTMLButtonElement>("btn-hotkey-apply").addEventListener("click", () => {
      void this.applyRecordedHotkey();
    });
    this.must<HTMLButtonElement>("btn-hotkey-cancel").addEventListener("click", () => {
      void this.cancelHotkeyRecording();
    });
    this.must<HTMLButtonElement>("btn-copy-hotkey-record").addEventListener("click", () => {
      void this.beginCopyHotkeyRecording();
    });
    this.must<HTMLButtonElement>("btn-copy-hotkey-apply").addEventListener("click", () => {
      void this.applyRecordedCopyHotkey();
    });
    this.must<HTMLButtonElement>("btn-copy-hotkey-cancel").addEventListener("click", () => {
      void this.cancelCopyHotkeyRecording();
    });

    const rawTextEl = this.must<HTMLTextAreaElement>("raw-text");
    rawTextEl.addEventListener("input", () => {
      this.markUserTyping();
      this.reconcileText(this.getPlaybackText(), { source: "user" });
    });
    rawTextEl.addEventListener("click", () => this.handleUserCaretMovement());
    rawTextEl.addEventListener("keyup", () => this.handleUserCaretMovement());
    rawTextEl.addEventListener("select", () => this.handleUserCaretMovement());
  }

  private syncConfigFromInputs(): void {
    this.config.llm.baseUrl = this.must<HTMLInputElement>("llm-url").value;
    this.config.llm.apiKey = this.must<HTMLInputElement>("llm-key").value;
    this.config.llm.promptTemplate = this.must<HTMLInputElement>("llm-prompt").value;
    this.config.llm.imageDetail = this.must<HTMLSelectElement>("llm-image-detail").value as AppConfig["llm"]["imageDetail"];
    const maxTokens = Number(this.must<HTMLInputElement>("llm-max-tokens").value);
    this.config.llm.maxTokens = Number.isFinite(maxTokens) && maxTokens > 0 ? Math.floor(maxTokens) : 4096;
    this.config.textProcessing.rapidEnabled = this.must<HTMLInputElement>("rapid-enabled").checked;
    this.config.textProcessing.rapidBaseUrl = this.must<HTMLInputElement>("rapid-url").value;
    this.config.tts.baseUrl = this.must<HTMLInputElement>("tts-url").value;
    this.config.tts.apiKey = this.must<HTMLInputElement>("tts-key").value;
    const minWords = Number(this.must<HTMLInputElement>("chunk-min").value);
    const maxWords = Number(this.must<HTMLInputElement>("chunk-max").value);
    this.config.reading.minWordsPerChunk = Number.isFinite(minWords) ? Math.max(1, Math.floor(minWords)) : 1;
    this.config.reading.maxWordsPerChunk = Number.isFinite(maxWords)
      ? Math.max(this.config.reading.minWordsPerChunk, Math.floor(maxWords))
      : this.config.reading.minWordsPerChunk;
    this.config.reading.cleanTextBeforeTts = this.must<HTMLInputElement>("clean-text-before-tts").checked;
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
    this.config.ui.showChunkDiagnostics = this.must<HTMLInputElement>("show-chunk-diagnostics").checked;
    this.applyUiState();
    this.store.save(this.config);
    this.updateTimelineFromRawText();
  }

  private renderConfig(): void {
    this.must<HTMLInputElement>("llm-url").value = this.config.llm.baseUrl;
    this.must<HTMLInputElement>("llm-key").value = this.config.llm.apiKey;
    this.must<HTMLInputElement>("llm-prompt").value = this.config.llm.promptTemplate;
    this.must<HTMLSelectElement>("llm-image-detail").value = this.config.llm.imageDetail;
    this.must<HTMLInputElement>("llm-max-tokens").value = String(this.config.llm.maxTokens);
    this.must<HTMLInputElement>("rapid-enabled").checked = this.config.textProcessing.rapidEnabled;
    this.must<HTMLInputElement>("rapid-url").value = this.config.textProcessing.rapidBaseUrl;
    this.must<HTMLInputElement>("tts-url").value = this.config.tts.baseUrl;
    this.must<HTMLInputElement>("tts-key").value = this.config.tts.apiKey;
    this.must<HTMLInputElement>("chunk-min").value = String(this.config.reading.minWordsPerChunk);
    this.must<HTMLInputElement>("chunk-max").value = String(this.config.reading.maxWordsPerChunk);
    this.must<HTMLInputElement>("clean-text-before-tts").checked = this.config.reading.cleanTextBeforeTts;
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
    this.must<HTMLInputElement>("capture-hotkey").value = this.pendingCaptureHotkey ?? this.config.system.captureHotkey;
    this.must<HTMLInputElement>("copy-play-hotkey").value = this.pendingCopyPlayHotkey ?? this.config.system.copyPlayHotkey;
    this.setCaptureHotkeyRecordingStatus(window.electronAPI ? "Current hotkey is active." : "Hotkey editing is available in Electron only.");
    this.setCopyHotkeyRecordingStatus(window.electronAPI ? "Current hotkey is active." : "Hotkey editing is available in Electron only.");
    this.renderHotkeyButtonState();
    this.must<HTMLInputElement>("show-chunk-diagnostics").checked = this.config.ui.showChunkDiagnostics;
    this.must<HTMLSelectElement>("log-level").value = this.config.logging.level;
    this.must<HTMLInputElement>("log-console-enabled").checked = this.config.logging.enableConsoleLogging;
    this.must<HTMLInputElement>("log-file-enabled").checked = this.config.logging.enableFileLogging;
    this.must<HTMLInputElement>("vol-slider").value = String(this.config.ui.volume);
    this.must<HTMLInputElement>("vol-input").value = String(this.config.ui.volume);
    this.must<HTMLInputElement>("speed-slider").value = String(this.config.ui.playbackRate);
    this.must<HTMLInputElement>("speed-input").value = String(this.config.ui.playbackRate);
    this.must<HTMLDivElement>("settings-last-import").textContent = this.config.system.lastImportAt
      ? `Last import: ${this.config.system.lastImportAt}`
      : "No import yet.";

    this.audio.volume = Math.max(0, Math.min(1, this.config.ui.volume / 100));
    this.audio.playbackRate = this.config.ui.playbackRate;

    this.applyUiState();

    this.applyOptions(this.llmModelSelect, [{ value: this.config.llm.model, label: this.config.llm.model }], this.config.llm.model);
    this.applyOptions(this.ttsModelSelect, [{ value: this.config.tts.model, label: this.config.tts.model }], this.config.tts.model);
    this.applyOptions(this.ttsVoiceSelect, [{ value: this.config.tts.voice, label: this.config.tts.voice }], this.config.tts.voice);
    this.updateStatusChip("rapid-status-chip", this.config.textProcessing.rapidEnabled ? "Enabled" : "Disabled", "idle");
    this.renderMainPreviewOverlay();
  }

  private applyUiState(): void {
    const shell = this.must<HTMLElement>("app-shell");
    shell.dataset.theme = this.config.ui.theme;
    shell.dataset.settingsOpen = this.config.ui.settingsDrawerOpen ? "true" : "false";
    shell.dataset.settingsPeek = this.settingsPeekOpen ? "true" : "false";
    shell.dataset.density = "comfortable";
    shell.dataset.showAdvanced = "true";
    shell.dataset.showDiagnostics = this.config.ui.showChunkDiagnostics ? "true" : "false";

    this.must<HTMLElement>("settings-drawer").setAttribute("aria-hidden", this.config.ui.settingsDrawerOpen ? "false" : "true");

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

  private setTheme(theme: "zen" | "pink"): void {
    this.config.ui.theme = theme;
    this.applyUiState();
    this.store.save(this.config);
  }

  private exportSettings(): void {
    const payload = JSON.stringify(this.config, null, 2);
    const blob = new Blob([payload], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "tts-snipper-settings.json";
    a.click();
    URL.revokeObjectURL(url);
    this.setStatus("Settings exported.");
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
          panels: mergedPanels
        },
        system: { ...DEFAULT_CONFIG.system, ...parsed.system },
        logging: { ...DEFAULT_CONFIG.logging, ...parsed.logging },
        textProcessing: { ...DEFAULT_CONFIG.textProcessing, ...parsed.textProcessing },
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
      void this.syncElectronCaptureHotkeyFromSettings();
      void this.syncElectronCopyHotkeyFromSettings();
      void this.syncElectronCaptureRectangleSetting();
      this.setStatus("Settings imported.");
      loggers.settings.info("Settings imported");
    } catch (error) {
      this.setStatus(`Import failed: ${String(error)}`);
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
    this.requestPreemptor.preemptLane("rapid_main");
    this.requestPreemptor.preemptLane("rapid_modal");
    this.cancelVisionControllers();
    this.preprocessModal?.abortRunningWork();
    this.setRawTextLock(false);
    this.ocrStreaming = false;
    this.ocrStreamDone = false;
    this.activeOcrRequests = 0;
    this.ocrStreamSession += 1;
    this.activeRunId += 1;
    this.runInProgress = false;
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
    this.must<HTMLButtonElement>("btn-capture").addEventListener("click", async () => {
        loggers.capture.info("Capture requested");
      try {
        await this.abortVisionWork("new_image");
        const dataUrl = await this.pickImageFromClipboard();
        if (dataUrl) {
          await this.runPipeline(dataUrl);
          return;
        }
        this.setStatus("No image in clipboard. Use paste or upload.");
      } catch (error) {
        loggers.capture.error("Capture failed", { error: String(error) });
        this.setStatus(`Capture failed: ${String(error)}`);
      }
    });

    this.must<HTMLInputElement>("image-upload").addEventListener("change", async (event) => {
      const input = event.currentTarget as HTMLInputElement;
      const file = input.files?.[0];
      if (!file) return;
      loggers.capture.info("Image uploaded", { fileName: file.name, type: file.type });
      await this.abortVisionWork("new_image");
      const dataUrl = await this.fileToDataUrl(file);
      await this.runPipeline(dataUrl);
    });

    this.must<HTMLButtonElement>("btn-extract").addEventListener("click", async () => {
      if (!this.lastOriginalImageDataUrl) {
        this.setStatus("Load an image first.");
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
        this.setStatus(`Extract failed: ${String(error)}`);
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
            await this.runPipeline(await this.fileToDataUrl(file));
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
      await this.runPipeline(await this.fileToDataUrl(file));
    });

    window.electronAPI?.onCapturedImage(async (dataUrl: string) => {
      loggers.capture.info("Hotkey capture image received");
      await this.abortVisionWork("new_image");
      await this.runPipeline(dataUrl);
    });

    window.electronAPI?.onCopiedTextForPlayback(async (text: string) => {
      if (this.hasActiveWork()) await this.abortAllWork("superseded");
      await this.playCopiedText(text);
    });
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
      registerAbortController: (controller) => {
        this.modalAbortController = controller;
        this.updateBreakButtonState();
      },
      preemptLane: () => this.requestPreemptor.preemptLane("rapid_modal"),
      beginLane: (parentSignal?: AbortSignal) => this.requestPreemptor.beginLane("rapid_modal", parentSignal),
      isLaneCurrent: (token: number) => this.requestPreemptor.isCurrent("rapid_modal", token)
    });

    this.must<HTMLDivElement>("preview-viewer").addEventListener("click", async () => {
      if (!this.lastOriginalImageDataUrl) return;
      await this.preprocessModal?.open();
    });
  }

  private async playCopiedText(text: string): Promise<void> {
    const nextText = text.trim();
    if (!nextText) {
      this.setStatus("Copy hotkey triggered but no text was copied.");
      return;
    }
    this.must<HTMLTextAreaElement>("raw-text").value = nextText;
    this.updateTimelineFromRawText();
    this.resetPlaybackForTextChange();
    this.setStatus("Copied text received. Playing...");
    try {
      await this.startOrResumePlayback();
    } catch (error) {
      this.setStatus(`Playback failed: ${String(error)}`);
    }
  }

  private setCaptureHotkeyRecordingStatus(message: string): void {
    this.must<HTMLDivElement>("hotkey-recording-status").textContent = message;
  }

  private setCopyHotkeyRecordingStatus(message: string): void {
    this.must<HTMLDivElement>("copy-hotkey-recording-status").textContent = message;
  }

  private renderHotkeyButtonState(): void {
    const available = Boolean(window.electronAPI?.beginCaptureHotkeyEdit);
    this.must<HTMLButtonElement>("btn-hotkey-record").disabled = !available || this.captureHotkeyRecording;
    this.must<HTMLButtonElement>("btn-hotkey-apply").disabled = !available || !this.pendingCaptureHotkey;
    this.must<HTMLButtonElement>("btn-hotkey-cancel").disabled = !available || (!this.captureHotkeyRecording && !this.pendingCaptureHotkey);
    this.must<HTMLButtonElement>("btn-copy-hotkey-record").disabled = !available || this.copyHotkeyRecording;
    this.must<HTMLButtonElement>("btn-copy-hotkey-apply").disabled = !available || !this.pendingCopyPlayHotkey;
    this.must<HTMLButtonElement>("btn-copy-hotkey-cancel").disabled = !available || (!this.copyHotkeyRecording && !this.pendingCopyPlayHotkey);
  }

  private async syncElectronCaptureHotkeyFromSettings(): Promise<void> {
    if (!window.electronAPI?.applyCaptureHotkey) return;
    try {
      const applied = await window.electronAPI.applyCaptureHotkey(this.config.system.captureHotkey);
      this.config.system.captureHotkey = applied;
      this.pendingCaptureHotkey = null;
      this.must<HTMLInputElement>("capture-hotkey").value = applied;
      this.setCaptureHotkeyRecordingStatus("Current hotkey is active.");
      this.renderHotkeyButtonState();
      this.store.save(this.config);
    } catch (error) {
      this.setStatus(`Failed to apply saved hotkey: ${String(error)}`);
    }
  }

  private async syncElectronCopyHotkeyFromSettings(): Promise<void> {
    if (!window.electronAPI?.applyCopyHotkey) return;
    try {
      const applied = await window.electronAPI.applyCopyHotkey(this.config.system.copyPlayHotkey);
      this.config.system.copyPlayHotkey = applied;
      this.pendingCopyPlayHotkey = null;
      this.must<HTMLInputElement>("copy-play-hotkey").value = applied;
      this.setCopyHotkeyRecordingStatus("Current hotkey is active.");
      this.renderHotkeyButtonState();
      this.store.save(this.config);
    } catch (error) {
      this.setStatus(`Failed to apply saved copy hotkey: ${String(error)}`);
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
      this.setStatus(`Failed to apply rectangle setting: ${String(error)}`);
    }
  }

  private normalizeKeyboardHotkey(event: KeyboardEvent): string | null {
    const parts: string[] = [];
    if (event.ctrlKey) parts.push("ctrl");
    if (event.shiftKey) parts.push("shift");
    if (event.altKey) parts.push("alt");
    if (event.metaKey) parts.push("win");
    const key = event.key.toLowerCase();
    if (["control", "shift", "alt", "meta"].includes(key)) return null;
    parts.push(key.length === 1 ? key : key);
    return parts.join("+");
  }

  private async beginHotkeyRecording(): Promise<void> {
    if (this.captureHotkeyRecording) return;
    this.captureHotkeyRecording = true;
    this.pendingCaptureHotkey = null;
    this.must<HTMLInputElement>("capture-hotkey").value = "";
    this.setCaptureHotkeyRecordingStatus("Recording... press your desired hotkey.");
    this.renderHotkeyButtonState();
    try {
      await window.electronAPI?.beginCaptureHotkeyEdit?.();
    } catch (error) {
      this.captureHotkeyRecording = false;
      this.setCaptureHotkeyRecordingStatus(`Failed to start recording: ${String(error)}`);
      this.renderHotkeyButtonState();
      return;
    }

    this.captureHotkeyKeydownHandler = (event: KeyboardEvent) => {
      if (!this.captureHotkeyRecording) return;
      const normalized = this.normalizeKeyboardHotkey(event);
      if (!normalized) return;
      event.preventDefault();
      event.stopPropagation();
      this.pendingCaptureHotkey = normalized;
      this.must<HTMLInputElement>("capture-hotkey").value = normalized;
      this.setCaptureHotkeyRecordingStatus(`Captured: ${normalized}. Click Apply to activate.`);
      this.stopCaptureHotkeyRecordingListener();
      this.captureHotkeyRecording = false;
      this.renderHotkeyButtonState();
    };

    window.addEventListener("keydown", this.captureHotkeyKeydownHandler, true);
  }

  private stopCaptureHotkeyRecordingListener(): void {
    if (this.captureHotkeyKeydownHandler) {
      window.removeEventListener("keydown", this.captureHotkeyKeydownHandler, true);
      this.captureHotkeyKeydownHandler = null;
    }
  }

  private async applyRecordedHotkey(): Promise<void> {
    if (!this.pendingCaptureHotkey) return;
    try {
      const applied = await window.electronAPI?.applyCaptureHotkey?.(this.pendingCaptureHotkey);
      const next = applied ?? this.pendingCaptureHotkey;
      this.config.system.captureHotkey = next;
      this.pendingCaptureHotkey = null;
      this.captureHotkeyRecording = false;
      this.stopCaptureHotkeyRecordingListener();
      this.must<HTMLInputElement>("capture-hotkey").value = next;
      this.setCaptureHotkeyRecordingStatus(`Active hotkey: ${next}`);
      this.store.save(this.config);
    } catch (error) {
      this.setCaptureHotkeyRecordingStatus(`Apply failed: ${String(error)}`);
      return;
    }
    this.renderHotkeyButtonState();
  }

  private async cancelHotkeyRecording(): Promise<void> {
    this.captureHotkeyRecording = false;
    this.pendingCaptureHotkey = null;
    this.stopCaptureHotkeyRecordingListener();
    try {
      const restored = await window.electronAPI?.cancelCaptureHotkeyEdit?.();
      if (restored) {
        this.config.system.captureHotkey = restored;
      }
    } catch (error) {
      this.setStatus(`Failed to cancel hotkey edit: ${String(error)}`);
    }
    this.must<HTMLInputElement>("capture-hotkey").value = this.config.system.captureHotkey;
    this.setCaptureHotkeyRecordingStatus("Current hotkey is active.");
    this.renderHotkeyButtonState();
    this.store.save(this.config);
  }

  private async beginCopyHotkeyRecording(): Promise<void> {
    if (this.copyHotkeyRecording) return;
    this.copyHotkeyRecording = true;
    this.pendingCopyPlayHotkey = null;
    this.must<HTMLInputElement>("copy-play-hotkey").value = "";
    this.setCopyHotkeyRecordingStatus("Recording... press your desired hotkey.");
    this.renderHotkeyButtonState();
    try {
      await window.electronAPI?.beginCopyHotkeyEdit?.();
    } catch (error) {
      this.copyHotkeyRecording = false;
      this.setCopyHotkeyRecordingStatus(`Failed to start recording: ${String(error)}`);
      this.renderHotkeyButtonState();
      return;
    }

    this.copyHotkeyKeydownHandler = (event: KeyboardEvent) => {
      if (!this.copyHotkeyRecording) return;
      const normalized = this.normalizeKeyboardHotkey(event);
      if (!normalized) return;
      event.preventDefault();
      event.stopPropagation();
      this.pendingCopyPlayHotkey = normalized;
      this.must<HTMLInputElement>("copy-play-hotkey").value = normalized;
      this.setCopyHotkeyRecordingStatus(`Captured: ${normalized}. Click Apply to activate.`);
      this.stopCopyHotkeyRecordingListener();
      this.copyHotkeyRecording = false;
      this.renderHotkeyButtonState();
    };

    window.addEventListener("keydown", this.copyHotkeyKeydownHandler, true);
  }

  private stopCopyHotkeyRecordingListener(): void {
    if (this.copyHotkeyKeydownHandler) {
      window.removeEventListener("keydown", this.copyHotkeyKeydownHandler, true);
      this.copyHotkeyKeydownHandler = null;
    }
  }

  private async applyRecordedCopyHotkey(): Promise<void> {
    if (!this.pendingCopyPlayHotkey) return;
    try {
      const applied = await window.electronAPI?.applyCopyHotkey?.(this.pendingCopyPlayHotkey);
      const next = applied ?? this.pendingCopyPlayHotkey;
      this.config.system.copyPlayHotkey = next;
      this.pendingCopyPlayHotkey = null;
      this.copyHotkeyRecording = false;
      this.stopCopyHotkeyRecordingListener();
      this.must<HTMLInputElement>("copy-play-hotkey").value = next;
      this.setCopyHotkeyRecordingStatus(`Active hotkey: ${next}`);
      this.store.save(this.config);
    } catch (error) {
      this.setCopyHotkeyRecordingStatus(`Apply failed: ${String(error)}`);
      return;
    }
    this.renderHotkeyButtonState();
  }

  private async cancelCopyHotkeyRecording(): Promise<void> {
    this.copyHotkeyRecording = false;
    this.pendingCopyPlayHotkey = null;
    this.stopCopyHotkeyRecordingListener();
    try {
      const restored = await window.electronAPI?.cancelCopyHotkeyEdit?.();
      if (restored) {
        this.config.system.copyPlayHotkey = restored;
      }
    } catch (error) {
      this.setStatus(`Failed to cancel copy hotkey edit: ${String(error)}`);
    }
    this.must<HTMLInputElement>("copy-play-hotkey").value = this.config.system.copyPlayHotkey;
    this.setCopyHotkeyRecordingStatus("Current hotkey is active.");
    this.renderHotkeyButtonState();
    this.store.save(this.config);
  }

  private bindPlayback(): void {
    const volSlider = this.must<HTMLInputElement>("vol-slider");
    const volInput = this.must<HTMLInputElement>("vol-input");
    const speedSlider = this.must<HTMLInputElement>("speed-slider");
    const speedInput = this.must<HTMLInputElement>("speed-input");

    const updateVol = (val: number) => {
      this.audio.volume = val / 100;
      this.config.ui.volume = val;
      volSlider.value = String(val);
      volInput.value = String(val);
      this.store.save(this.config);
    };

    const updateSpeed = (val: number) => {
      this.audio.playbackRate = val;
      this.config.ui.playbackRate = val;
      speedSlider.value = String(val);
      speedInput.value = String(val);
      this.store.save(this.config);
    };

    volSlider.addEventListener("input", () => updateVol(Number(volSlider.value)));
    volInput.addEventListener("input", () => updateVol(Number(volInput.value)));
    speedSlider.addEventListener("input", () => updateSpeed(Number(speedSlider.value)));
    speedInput.addEventListener("input", () => updateSpeed(Number(speedInput.value)));

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
        this.setStatus("Ready");
        this.renderPlayState();
        return;
      }
      void this.playChunkAtIndex(nextIndex, this.chunkPlaybackSession);
    });

    this.audio.addEventListener("play", () => this.renderPlayState());
    this.audio.addEventListener("pause", () => this.renderPlayState());
  }

  private async runPipeline(dataUrl: string): Promise<void> {
    const { runId, signal } = this.startRun();
    this.setStatus("Running OCR + TTS...");
    const done = loggers.pipeline.time("pipeline.run");
    try {
      this.lastOriginalImageDataUrl = await normalizeImageDataUrl(dataUrl);
      this.throwIfStale(runId);
      const ocrInput = await this.buildOcrInput(this.lastOriginalImageDataUrl, signal, runId, (imageDataUrl) => {
        if (runId !== this.activeRunId) return;
        // Show image immediately; Rapid boxes will be layered when detect finishes.
        this.currentRapidRawBoxes = [];
        this.currentFilterResults = [];
        this.currentMergedGroups = [];
        this.currentFilterStats = { widthRemoved: 0, heightRemoved: 0, medianRemoved: 0, medianHeightPx: 0 };
        this.setPreviewImage(imageDataUrl);
        this.renderMainPreviewOverlay();
      });
      this.throwIfStale(runId);
      this.currentOcrImageDataUrl = ocrInput.imageDataUrl;
      this.currentOcrRegions = ocrInput.regions;
      this.setPreviewImage(ocrInput.imageDataUrl);
      this.renderMainPreviewOverlay();
      const streamingEnabled = this.config.llm.ocrStreamingEnabled;
      let result: { text: string };
      if (streamingEnabled) {
        result = await this.runStreamingOcr(ocrInput.imageDataUrl, ocrInput.regions, signal);
      } else {
        result = await this.pipeline.run(ocrInput.imageDataUrl, this.config, { regions: ocrInput.regions, signal });
      }
      this.throwIfStale(runId);
      done();
      loggers.pipeline.info("Pipeline completed", { textLength: result.text.length });
      if (!streamingEnabled) {
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
        this.setStatus(`Pipeline error: ${String(error)}`);
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
    this.must<HTMLTextAreaElement>("raw-text").value = "";
    this.lastPlaybackText = "";
    this.replaceTimelineWithChunks([]);
    this.renderReadingPreview();
    this.setStatus("Streaming OCR text...");

    let streamText = "";
    const applyStreamToken = (token: string): void => {
      if (streamSession !== this.ocrStreamSession || signal.aborted) return;
      streamText += token;
      this.must<HTMLTextAreaElement>("raw-text").value = streamText;
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
      this.must<HTMLTextAreaElement>("raw-text").value = result.text;
      this.reconcileText(this.getPlaybackText(), { source: "llm", finalizeTail: true });
      void this.startOrResumePlayback();
      return { text: result.text };
    } catch (error) {
      this.ocrStreaming = false;
      this.setRawTextLock(false);
      this.activeOcrRequests = 0;
      if (this.isAbortError(error)) {
        throw error;
      }
      this.setStatus(`OCR stream error (partial kept): ${String(error)}`);
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
    this.playbackStartInFlight = true;
    void this.startOrResumePlayback().catch((error) => {
      this.setStatus(`Playback failed: ${String(error)}`);
    }).finally(() => {
      this.playbackStartInFlight = false;
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
        this.setStatus(`Pipeline error: ${String(error)}`);
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
    onImageReady?: (imageDataUrl: string) => void
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

    let rapidBoxes: Array<{ id: string; norm: { x: number; y: number; w: number; h: number }; px: { x1: number; y1: number; x2: number; y2: number } }> = [];
    if (this.config.textProcessing.rapidEnabled) {
      const rapidLane = this.requestPreemptor.beginLane("rapid_main", signal);
      try {
        const detect = await detectRapidRawBoxes(this.config.textProcessing.rapidBaseUrl, scaled, { signal: rapidLane.signal });
        if (!this.requestPreemptor.isCurrent("rapid_main", rapidLane.token)) {
          throw new Error("Cancelled");
        }
        if (signal?.aborted) throw new Error("Cancelled");
        if (runId !== undefined) this.throwIfStale(runId);
        rapidBoxes = detect.boxes;
        this.updateStatusChip("rapid-status-chip", `Loaded ${detect.boxes.length}`, "ok");
      } catch (error) {
        if (this.isAbortError(error)) throw error;
        this.updateStatusChip("rapid-status-chip", "Detect failed", "error");
        loggers.pipeline.warn("Rapid detect failed, falling back to manual/full image", { error: String(error) });
      } finally {
        rapidLane.done();
      }
    }

    const dims = await this.readImageSize(scaled);
    const selectedRapid = rapidBoxes.filter((box) => selectionKeepRatio(box, dims.width, dims.height, pre.selection.baseState, pre.selection.ops) > 0.1);
    const filterResults = filterBySize(selectedRapid, dims.width, dims.height, pre.detectionFilter);
    const keptRapid = filterResults.filter((f) => f.keep).map((f) => f.box);
    const manualRaw = pre.selection.manualBoxes.map((m) => manualToRaw(m, dims.width, dims.height));
    const ordered = sortByReadingOrder([...keptRapid, ...manualRaw], pre.sorting);
    const mergedGroups = mergeCloseBoxes(ordered, pre.merge, dims.width, dims.height);
    const mergedOrOrdered = mergedGroups.length ? mergedGroups.map((m) => m.rect) : ordered;

    const regions = finalizeOcrBoxes({
      rapidRawBoxes: rapidBoxes,
      manualBoxes: pre.selection.manualBoxes,
      baseState: pre.selection.baseState,
      ops: pre.selection.ops,
      imageW: dims.width,
      imageH: dims.height,
      filter: pre.detectionFilter,
      sorting: pre.sorting,
      merge: pre.merge
    });

    const heights = filterResults.map((f) => f.box.px.y2 - f.box.px.y1).filter((h) => h > 0).sort((a, b) => a - b);
    const mid = Math.floor(heights.length / 2);
    const med = heights.length % 2 === 0 ? ((heights[mid - 1] ?? 0) + (heights[mid] ?? 0)) / 2 : (heights[mid] ?? 0);
    this.currentRapidRawBoxes = selectedRapid;
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
    return this.config.reading.cleanTextBeforeTts ? cleanTextForTts(raw) : raw;
  }

  private async startOrResumePlayback(): Promise<void> {
    const text = this.getPlaybackText().trim();
    if (!text) {
      this.setStatus("Enter text first.");
      return;
    }

    if (this.chunkPlaybackMode && this.audio.src) {
      await this.audio.play();
      loggers.playback.info("Playback resumed");
      return;
    }
    if (this.lastPlaybackText !== text) {
      this.reconcileText(text, { source: "user", finalizeTail: !this.ocrStreaming });
    }

    if (this.timeline.chunks.length === 0) {
      this.setStatus("Nothing to read.");
      return;
    }
    if (this.programmaticPauseActive) {
      this.setStatus(this.programmaticPauseReason || "Paused by cursor gate.");
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
      this.setStatus("Waiting for typing to settle before this chunk is playable...");
      return;
    }
    if (index > this.maxPlayableChunkIndex()) {
      this.chunkPlaybackMode = false;
      this.renderPlayState();
      if (this.ocrStreaming && !this.ocrStreamDone) {
        this.setStatus("Waiting for OCR stream to finalize next chunk...");
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
    this.setStatus(`Buffering chunk ${chunk.index + 1}/${this.timeline.chunks.length}...`);

    try {
      const audioUrl = await this.getChunkAudioUrl(chunk.id, session);
      if (session !== this.chunkPlaybackSession) return;
      this.audio.src = audioUrl;
      this.audio.currentTime = 0;
      chunk.status = "playing";
      this.speakingChunkId = chunk.id;
      this.speakingRevision = chunk.revision;
      this.renderReadingPreview();
      await this.audio.play();
      this.setStatus(`Playing chunk ${chunk.index + 1}/${this.timeline.chunks.length}`);
      this.prefetchFromIndex(chunk.id, session);
    } catch (error) {
      if (session !== this.chunkPlaybackSession) return;
      chunk.status = "failed";
      this.chunkPlaybackMode = false;
      this.speakingChunkId = null;
      this.speakingRevision = null;
      this.renderReadingPreview();
      this.renderPlayState();
      this.setStatus(`Stopped: failed to synthesize chunk ${chunk.index + 1}/${this.timeline.chunks.length}. ${String(error)}`);
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
        span.title = "Synthesized and ready";
      }
      if (state === "failed") {
        span.title = "Synthesis failed";
      }
      const playable = this.isChunkPlayable(chunk.index);
      if (!playable) {
        span.classList.add("chunk-unplayable");
        if (!span.title) {
          span.title = "Waiting for typing to settle";
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
    if (active) {
      active.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
    }
  }

  private seekChunk(index: number): void {
    const chunk = this.getChunkRecords()[index];
    if (!chunk) return;
    if (!this.isChunkPlayable(index)) {
      this.setStatus("Chunk is still drafting while typing is active.");
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
    for (const chunk of targets) {
      if (!chunk.finalized || chunk.audioUrl || this.chunkInFlightById.has(chunk.id) || chunk.status === "playing") {
        continue;
      }
      chunk.status = "queued";
      void this.getChunkAudioUrl(chunk.id, session).catch(() => {
        // Best effort prefetch.
      });
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
          this.setStatus(
            `Retrying chunk ${index + 1}/${this.timeline.chunks.length} (${attempt}/${retries})...`
          );
          continue;
        }
      }
    }
    throw lastError;
  }

  private renderPlayState(): void {
    const playBtn = this.must<HTMLButtonElement>("btn-play");
    playBtn.innerHTML = this.audio.paused
      ? '<i data-lucide="play" class="ui-icon"></i>'
      : '<i data-lucide="pause" class="ui-icon"></i>';
    playBtn.classList.toggle("programmatic-paused", this.programmaticPauseActive);
    playBtn.title = this.programmaticPauseActive ? this.programmaticPauseReason : (this.audio.paused ? "Play" : "Pause");
    this.renderIcons();
    this.updateBreakButtonState();
  }

  private renderIcons(): void {
    createIcons({ icons });
  }

  private async pickImageFromClipboard(): Promise<string | null> {
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
      rawBoxes: this.currentRapidRawBoxes,
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
      pathLabel.textContent = logPath ? `Log path: ${logPath}` : "Log path: available in Electron only";
      this.setStatus(logPath ? `Log file: ${logPath}` : "Not running in Electron");
    });

    clearBtn.addEventListener("click", async () => {
      await window.electronAPI?.clearLogs?.();
      this.setStatus("Logs cleared");
    });

    void window.electronAPI?.getLogFilePath?.().then((logPath) => {
      if (logPath) pathLabel.textContent = `Log path: ${logPath}`;
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
  const root = document.getElementById("app");
  if (!root) {
    throw new Error("Missing #app");
  }

  if (!localStorage.getItem("tts-snipper:settings")) {
    localStorage.setItem("tts-snipper:settings", JSON.stringify(DEFAULT_CONFIG));
  }

  new WebApp().mount(root);
}

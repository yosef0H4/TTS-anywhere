import TomSelect from "tom-select";
import "tom-select/dist/css/tom-select.css";
import { createIcons, icons } from "lucide";
import { DEFAULT_CONFIG } from "../core/models/defaults";
import type { AppConfig, ReadingTimeline } from "../core/models/types";
import { AppPipeline } from "../core/pipeline/app-pipeline";
import { SettingsStore } from "../core/services/settings-store";
import { buildReadingTimeline, findChunkIndexByTime, normalizeText } from "../core/utils/chunking";
import { APP_TEMPLATE } from "../ui/template";
import "../ui/styles.css";

interface NamedOption {
  value: string;
  label: string;
}

interface ModelListResponse {
  data?: Array<{ id?: string }>;
}

type ChunkSynthesisState =
  | "not_started"
  | "queued"
  | "synthesizing"
  | "ready"
  | "playing"
  | "done"
  | "failed"
  | "skipped";

interface AudioCacheEntry {
  url: string;
  byteLength: number;
  lastAccessAt: number;
  cooldownUntil: number;
}

export class WebApp {
  private readonly store = new SettingsStore();
  private readonly pipeline = new AppPipeline();
  private readonly config: AppConfig = this.store.load();
  private readonly audio = new Audio();
  private lastSynthText = "";
  private timeline: ReadingTimeline = { chunks: [], durationMs: 0 };
  private activeChunkIndex = 0;
  private readonly optionCache = new Map<string, NamedOption[]>();
  private llmModelSelect: TomSelect | null = null;
  private ttsModelSelect: TomSelect | null = null;
  private ttsVoiceSelect: TomSelect | null = null;
  private settingsPeekOpen = false;
  private chunkPlaybackMode = false;
  private chunkPlaybackSession = 0;
  private readonly chunkHashByIndex = new Map<number, string>();
  private readonly audioCacheByHash = new Map<string, AudioCacheEntry>();
  private readonly chunkInFlightByHash = new Map<string, Promise<string>>();
  private readonly chunkAbortControllersByHash = new Map<string, AbortController>();
  private readonly chunkStateByIndex = new Map<number, ChunkSynthesisState>();
  private readonly chunkErrorByIndex = new Map<number, string>();
  private evictedCount = 0;

  mount(root: HTMLElement): void {
    root.innerHTML = APP_TEMPLATE;
    this.applyUiState();
    this.renderIcons();
    this.bindWindowControls();
    this.bindModelSelectors();
    this.bindSettings();
    this.bindCapture();
    this.bindPlayback();
    this.renderConfig();
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
      "tts-url",
      "tts-key",
      "chunk-min",
      "chunk-max",
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
      this.setStatus("Settings reset to defaults.");
    });

    this.must<HTMLTextAreaElement>("raw-text").addEventListener("input", () => {
      const shouldRestart = this.chunkPlaybackMode;
      const resumeFrom = this.activeChunkIndex;
      this.updateTimelineFromRawText();
      if (shouldRestart) {
        this.restartPlaybackFromIndex(resumeFrom, true);
      } else {
        this.resetChunkPlaybackState();
      }
    });
  }

  private syncConfigFromInputs(): void {
    this.config.llm.baseUrl = this.must<HTMLInputElement>("llm-url").value;
    this.config.llm.apiKey = this.must<HTMLInputElement>("llm-key").value;
    this.config.llm.promptTemplate = this.must<HTMLInputElement>("llm-prompt").value;
    this.config.tts.baseUrl = this.must<HTMLInputElement>("tts-url").value;
    this.config.tts.apiKey = this.must<HTMLInputElement>("tts-key").value;
    const minWords = Number(this.must<HTMLInputElement>("chunk-min").value);
    const maxWords = Number(this.must<HTMLInputElement>("chunk-max").value);
    this.config.reading.minWordsPerChunk = Number.isFinite(minWords) ? Math.max(1, Math.floor(minWords)) : 1;
    this.config.reading.maxWordsPerChunk = Number.isFinite(maxWords)
      ? Math.max(this.config.reading.minWordsPerChunk, Math.floor(maxWords))
      : this.config.reading.minWordsPerChunk;
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
    this.config.ui.showChunkDiagnostics = this.must<HTMLInputElement>("show-chunk-diagnostics").checked;
    this.applyUiState();
    this.store.save(this.config);
    this.updateTimelineFromRawText();
  }

  private renderConfig(): void {
    this.must<HTMLInputElement>("llm-url").value = this.config.llm.baseUrl;
    this.must<HTMLInputElement>("llm-key").value = this.config.llm.apiKey;
    this.must<HTMLInputElement>("llm-prompt").value = this.config.llm.promptTemplate;
    this.must<HTMLInputElement>("tts-url").value = this.config.tts.baseUrl;
    this.must<HTMLInputElement>("tts-key").value = this.config.tts.apiKey;
    this.must<HTMLInputElement>("chunk-min").value = String(this.config.reading.minWordsPerChunk);
    this.must<HTMLInputElement>("chunk-max").value = String(this.config.reading.maxWordsPerChunk);
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
    this.must<HTMLInputElement>("show-chunk-diagnostics").checked = this.config.ui.showChunkDiagnostics;
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
      const merged: AppConfig = {
        llm: { ...DEFAULT_CONFIG.llm, ...parsed.llm },
        tts: { ...DEFAULT_CONFIG.tts, ...parsed.tts },
        reading: { ...DEFAULT_CONFIG.reading, ...parsed.reading },
        ui: { ...DEFAULT_CONFIG.ui, ...parsed.ui },
        system: { ...DEFAULT_CONFIG.system, ...parsed.system }
      };
      Object.assign(this.config, merged);
      this.config.system.lastImportAt = new Date().toISOString();
      this.renderConfig();
      this.updateTimelineFromRawText();
      this.store.save(this.config);
      this.setStatus("Settings imported.");
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

  private initializeChunkStates(): void {
    this.chunkHashByIndex.clear();
    this.chunkStateByIndex.clear();
    this.chunkErrorByIndex.clear();
    for (let i = 0; i < this.timeline.chunks.length; i += 1) {
      const hash = this.chunkHash(this.timeline.chunks[i]?.text ?? "");
      this.chunkHashByIndex.set(i, hash);
      this.chunkStateByIndex.set(i, "not_started");
    }
    this.refreshChunkDiagnostics();
  }

  private setChunkState(index: number, state: ChunkSynthesisState, errorMessage?: string): void {
    if (!this.timeline.chunks[index]) return;
    this.chunkStateByIndex.set(index, state);
    if (errorMessage) {
      this.chunkErrorByIndex.set(index, errorMessage);
    } else if (state !== "failed") {
      this.chunkErrorByIndex.delete(index);
    }
    this.refreshChunkDiagnostics();
  }

  private refreshChunkDiagnostics(): void {
    const counts = {
      queued: 0,
      inflight: this.chunkInFlightByHash.size,
      cached: this.audioCacheByHash.size,
      ready: 0,
      failed: 0,
      skipped: 0,
      cooldown: 0,
      evicted: this.evictedCount
    };
    this.chunkStateByIndex.forEach((state) => {
      if (state === "queued") counts.queued += 1;
      if (state === "ready") counts.ready += 1;
      if (state === "failed") counts.failed += 1;
      if (state === "skipped") counts.skipped += 1;
    });
    this.audioCacheByHash.forEach((entry) => {
      if (entry.cooldownUntil > Date.now()) counts.cooldown += 1;
    });

    this.must<HTMLSpanElement>("diag-queued").textContent = `Q:${counts.queued}`;
    this.must<HTMLSpanElement>("diag-inflight").textContent = `In:${counts.inflight}`;
    this.must<HTMLSpanElement>("diag-cached").textContent = `Cache:${counts.cached}`;
    this.must<HTMLSpanElement>("diag-ready").textContent = `Ready:${counts.ready}`;
    this.must<HTMLSpanElement>("diag-failed").textContent = `Fail:${counts.failed}`;
    this.must<HTMLSpanElement>("diag-skipped").textContent = `Skip:${counts.skipped}`;
    this.must<HTMLSpanElement>("diag-cooldown").textContent = `Cool:${counts.cooldown}`;
    this.must<HTMLSpanElement>("diag-evicted").textContent = `Evict:${counts.evicted}`;
  }

  private bindCapture(): void {
    this.must<HTMLButtonElement>("btn-capture").addEventListener("click", async () => {
      try {
        const dataUrl = await this.pickImageFromClipboard();
        if (dataUrl) {
          await this.runPipeline(dataUrl);
          return;
        }
        this.setStatus("No image in clipboard. Use paste or upload.");
      } catch (error) {
        this.setStatus(`Capture failed: ${String(error)}`);
      }
    });

    this.must<HTMLInputElement>("image-upload").addEventListener("change", async (event) => {
      const input = event.currentTarget as HTMLInputElement;
      const file = input.files?.[0];
      if (!file) return;
      const dataUrl = await this.fileToDataUrl(file);
      await this.runPipeline(dataUrl);
    });

    document.addEventListener("paste", async (event) => {
      const items = Array.from(event.clipboardData?.items ?? []);
      for (const item of items) {
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) {
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
      await this.runPipeline(await this.fileToDataUrl(file));
    });

    window.electronAPI?.onCaptureRequested(() => {
      this.setStatus("Electron hotkey pressed. Paste or upload image to continue.");
    });
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
      if (!this.chunkPlaybackMode) return;
      this.setChunkState(this.activeChunkIndex, "done");
      const nextIndex = this.activeChunkIndex + 1;
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
    this.setPreviewImage(dataUrl);
    this.setStatus("Running OCR + TTS...");

    try {
      const result = await this.pipeline.run(dataUrl, this.config);
      this.must<HTMLTextAreaElement>("raw-text").value = result.text;
      this.timeline = result.timeline;
      this.activeChunkIndex = 0;
      this.resetChunkPlaybackState();
      this.initializeChunkStates();
      this.renderReadingPreview();
      this.lastSynthText = result.text;
      this.setStatus("Ready");
    } catch (error) {
      this.setStatus(`Pipeline error: ${String(error)}`);
    }
  }

  private updateTimelineFromRawText(): void {
    const text = this.must<HTMLTextAreaElement>("raw-text").value;
    const oldText = this.lastSynthText;
    const oldActiveHash = this.chunkHashByIndex.get(this.activeChunkIndex) ?? "";
    this.timeline = buildReadingTimeline(
      text,
      this.config.reading.minWordsPerChunk,
      this.config.reading.maxWordsPerChunk,
      this.config.reading.wpmBase
    );
    this.initializeChunkStates();
    this.reconcileAudioCacheForTextChange(oldText, text);
    if (oldActiveHash) {
      const mapped = this.findFirstIndexByHash(oldActiveHash);
      if (mapped >= 0) {
        this.activeChunkIndex = mapped;
      } else {
        this.activeChunkIndex = Math.min(this.activeChunkIndex, Math.max(0, this.timeline.chunks.length - 1));
      }
    }
    this.lastSynthText = text;
    this.renderReadingPreview();
  }

  private async startOrResumePlayback(): Promise<void> {
    const text = this.must<HTMLTextAreaElement>("raw-text").value.trim();
    if (!text) {
      this.setStatus("Enter text first.");
      return;
    }

    if (this.chunkPlaybackMode && this.audio.src) {
      await this.audio.play();
      return;
    }

    if (this.lastSynthText !== text) {
      this.updateTimelineFromRawText();
    }

    if (this.timeline.chunks.length === 0) {
      this.setStatus("Nothing to read.");
      return;
    }

    if (!this.chunkPlaybackMode) {
      this.chunkPlaybackMode = true;
      this.chunkPlaybackSession += 1;
    }
    await this.playChunkAtIndex(this.activeChunkIndex, this.chunkPlaybackSession);
  }

  private async playChunkAtIndex(index: number, session: number): Promise<void> {
    const chunk = this.timeline.chunks[index];
    if (!chunk) return;
    if (session !== this.chunkPlaybackSession) return;

    this.activeChunkIndex = chunk.index;
    this.renderReadingPreview();
    this.scheduleWindowPrefetch(session);
    this.setStatus(`Buffering chunk ${chunk.index + 1}/${this.timeline.chunks.length}...`);

    try {
      const audioUrl = await this.getChunkAudioUrl(chunk.index, session);
      if (session !== this.chunkPlaybackSession) return;
      this.audio.src = audioUrl;
      this.audio.currentTime = 0;
      this.setChunkState(chunk.index, "playing");
      await this.audio.play();
      this.setStatus(`Playing chunk ${chunk.index + 1}/${this.timeline.chunks.length}`);
      this.scheduleWindowPrefetch(session);
    } catch (error) {
      if (session !== this.chunkPlaybackSession) return;
      const nextIndex = this.activeChunkIndex + 1;
      if (nextIndex < this.timeline.chunks.length) {
        this.setChunkState(chunk.index, "failed", String(error));
        this.setChunkState(chunk.index, "skipped");
        this.setStatus(`Skipping chunk ${this.activeChunkIndex + 1}: ${String(error)}`);
        await this.playChunkAtIndex(nextIndex, session);
        return;
      }
      this.chunkPlaybackMode = false;
      this.setStatus("Ready");
    }
  }

  private async getChunkAudioUrl(index: number, session: number): Promise<string> {
    const hash = this.chunkHashByIndex.get(index);
    if (!hash) throw new Error("Invalid chunk hash");
    const cacheEntry = this.audioCacheByHash.get(hash);
    if (cacheEntry?.url) {
      if (cacheEntry.cooldownUntil > Date.now()) {
        throw new Error("Chunk on cooldown");
      }
      cacheEntry.lastAccessAt = Date.now();
      return cacheEntry.url;
    }
    const inflight = this.chunkInFlightByHash.get(hash);
    if (inflight) return inflight;
    const chunk = this.timeline.chunks[index];
    if (!chunk) throw new Error("Invalid chunk index");
    this.setChunkState(index, "synthesizing");
    const controller = new AbortController();
    this.chunkAbortControllersByHash.set(hash, controller);
    const requestPromise = this.synthesizeChunkWithRetry(index, chunk.text, session, controller.signal)
      .then((audioBlob) => {
        if (session !== this.chunkPlaybackSession) {
          throw new Error("Cancelled");
        }
        const url = URL.createObjectURL(audioBlob);
        this.audioCacheByHash.set(hash, {
          url,
          byteLength: audioBlob.size,
          lastAccessAt: Date.now(),
          cooldownUntil: 0
        });
        this.updateStatesForHash(hash, "ready");
        this.enforceAudioCacheLimits();
        return url;
      })
      .finally(() => {
        this.chunkInFlightByHash.delete(hash);
        this.chunkAbortControllersByHash.delete(hash);
        this.refreshChunkDiagnostics();
      });
    this.chunkInFlightByHash.set(hash, requestPromise);
    this.refreshChunkDiagnostics();
    return requestPromise;
  }

  private resetChunkPlaybackState(): void {
    this.chunkPlaybackMode = false;
    this.chunkPlaybackSession += 1;
    this.audio.pause();
    this.audio.src = "";
    this.chunkAbortControllersByHash.forEach((controller) => controller.abort());
    this.chunkAbortControllersByHash.clear();
    this.chunkInFlightByHash.clear();
    this.audioCacheByHash.forEach((entry) => {
      if (entry.url && entry.url.startsWith("blob:")) {
        URL.revokeObjectURL(entry.url);
      }
    });
    this.audioCacheByHash.clear();
    this.evictedCount = 0;
    this.refreshChunkDiagnostics();
  }

  private renderReadingPreview(): void {
    const preview = this.must<HTMLDivElement>("reading-preview");
    preview.innerHTML = "";

    this.timeline.chunks.forEach((chunk) => {
      const span = document.createElement("span");
      span.textContent = chunk.text;
      const state = this.chunkStateByIndex.get(chunk.index) ?? "not_started";
      span.classList.add(`chunk-${state}`);
      if (state === "ready" || state === "done" || state === "playing") {
        span.classList.add("chunk-instant");
        span.title = "Instant start available";
      }
      if (state === "failed") {
        span.title = this.chunkErrorByIndex.get(chunk.index) ?? "Synthesis failed";
      }
      if (chunk.index === this.activeChunkIndex) {
        span.classList.add("active-chunk");
      }
      span.addEventListener("click", () => this.seekChunk(chunk.index));
      preview.appendChild(span);
      preview.appendChild(document.createTextNode(" "));
    });

    const active = preview.querySelector<HTMLElement>("span.active-chunk");
    if (active) {
      active.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
    }
  }

  private seekChunk(index: number): void {
    const chunk = this.timeline.chunks[index];
    if (!chunk) return;
    this.activeChunkIndex = chunk.index;
    this.renderReadingPreview();
    this.restartPlaybackFromIndex(chunk.index, true);
  }

  private restartPlaybackFromIndex(index: number, shouldAutoPlay: boolean): void {
    this.chunkPlaybackSession += 1;
    this.chunkAbortControllersByHash.forEach((controller) => controller.abort());
    this.chunkAbortControllersByHash.clear();
    this.chunkInFlightByHash.clear();
    this.activeChunkIndex = Math.max(0, Math.min(index, this.timeline.chunks.length - 1));
    if (!this.timeline.chunks[this.activeChunkIndex]) {
      this.chunkPlaybackMode = false;
      this.setStatus("Nothing to read.");
      return;
    }
    this.chunkPlaybackMode = true;
    if (shouldAutoPlay) {
      void this.playChunkAtIndex(this.activeChunkIndex, this.chunkPlaybackSession);
    } else {
      this.setStatus(`Ready at chunk ${this.activeChunkIndex + 1}/${this.timeline.chunks.length}`);
    }
  }

  private scheduleWindowPrefetch(session: number): void {
    if (session !== this.chunkPlaybackSession) return;
    const windowSize = Math.max(1, this.config.reading.streamWindowSize);
    const maxInFlight = Math.max(1, this.config.reading.chunkRequestConcurrency);
    const start = this.activeChunkIndex;
    const end = Math.min(this.timeline.chunks.length - 1, start + windowSize);

    for (let idx = start; idx <= end; idx += 1) {
      const hash = this.chunkHashByIndex.get(idx);
      if (!hash) continue;
      const cacheEntry = this.audioCacheByHash.get(hash);
      if ((cacheEntry?.url ?? false) || this.chunkInFlightByHash.has(hash)) {
        continue;
      }
      if (this.chunkInFlightByHash.size >= maxInFlight) {
        break;
      }
      this.setChunkState(idx, "queued");
      void this.getChunkAudioUrl(idx, session).catch(() => {
        // Playback path handles retries/errors; prefetch is best effort.
      });
    }
  }

  private async synthesizeChunkWithRetry(index: number, text: string, session: number, signal: AbortSignal): Promise<Blob> {
    const retries = Math.max(0, this.config.reading.chunkRetryCount);
    const maxAttempts = retries + 1;
    let lastError: unknown = new Error("Unknown TTS failure");

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (session !== this.chunkPlaybackSession || signal.aborted) {
        throw new Error("Cancelled");
      }
      try {
        return await this.pipeline.synthesizeText(text, this.config, {
          signal,
          timeoutMs: this.config.reading.chunkTimeoutMs
        });
      } catch (error) {
        lastError = error;
        if (attempt < maxAttempts) {
          this.setStatus(`Retrying chunk ${index + 1}/${this.timeline.chunks.length} (${attempt}/${retries})...`);
          continue;
        }
      }
    }
    const hash = this.chunkHash(text);
    const existing = this.audioCacheByHash.get(hash);
    this.audioCacheByHash.set(hash, {
      url: existing?.url ?? "",
      byteLength: existing?.byteLength ?? 0,
      lastAccessAt: Date.now(),
      cooldownUntil: Date.now() + Math.max(0, this.config.reading.failureCooldownMs)
    });
    throw lastError;
  }

  private reconcileAudioCacheForTextChange(oldText: string, newText: string): void {
    const ratio = this.computeEditRatio(normalizeText(oldText), normalizeText(newText));
    if (ratio > this.config.reading.largeEditResetRatio) {
      this.resetChunkPlaybackState();
      this.initializeChunkStates();
      return;
    }

    const validHashes = new Set<string>();
    this.chunkHashByIndex.forEach((hash) => validHashes.add(hash));

    this.audioCacheByHash.forEach((entry, hash) => {
      if (!validHashes.has(hash)) {
        if (entry.url && entry.url.startsWith("blob:")) {
          URL.revokeObjectURL(entry.url);
        }
        this.audioCacheByHash.delete(hash);
      }
    });

    this.chunkHashByIndex.forEach((hash, idx) => {
      const entry = this.audioCacheByHash.get(hash);
      if (entry?.url) {
        this.setChunkState(idx, "ready");
      }
    });
    this.refreshChunkDiagnostics();
  }

  private chunkHash(text: string): string {
    const input = normalizeText(text);
    let hash = 2166136261;
    for (let i = 0; i < input.length; i += 1) {
      hash ^= input.charCodeAt(i);
      hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return `h${(hash >>> 0).toString(16)}`;
  }

  private findFirstIndexByHash(hash: string): number {
    for (let i = 0; i < this.timeline.chunks.length; i += 1) {
      if (this.chunkHashByIndex.get(i) === hash) {
        return i;
      }
    }
    return -1;
  }

  private computeEditRatio(oldText: string, newText: string): number {
    if (!oldText && !newText) return 0;
    const maxLen = Math.max(oldText.length, newText.length);
    if (maxLen === 0) return 0;
    let prefix = 0;
    while (prefix < oldText.length && prefix < newText.length && oldText[prefix] === newText[prefix]) {
      prefix += 1;
    }
    let suffix = 0;
    while (
      suffix < oldText.length - prefix &&
      suffix < newText.length - prefix &&
      oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]
    ) {
      suffix += 1;
    }
    const common = prefix + suffix;
    return Math.max(0, maxLen - common) / maxLen;
  }

  private updateStatesForHash(hash: string, state: ChunkSynthesisState): void {
    this.chunkHashByIndex.forEach((value, index) => {
      if (value === hash) {
        this.setChunkState(index, state);
      }
    });
  }

  private enforceAudioCacheLimits(): void {
    const maxChunks = Math.max(10, this.config.reading.sessionChunkCacheLimit);
    const maxBytes = Math.max(1000000, this.config.reading.sessionAudioByteLimit);
    let totalBytes = 0;
    this.audioCacheByHash.forEach((entry) => {
      totalBytes += entry.byteLength;
    });
    if (this.audioCacheByHash.size <= maxChunks && totalBytes <= maxBytes) return;

    const sorted = Array.from(this.audioCacheByHash.entries())
      .filter(([, entry]) => entry.url)
      .sort((a, b) => a[1].lastAccessAt - b[1].lastAccessAt);

    for (const [hash, entry] of sorted) {
      if (this.audioCacheByHash.size <= maxChunks && totalBytes <= maxBytes) break;
      if (entry.url.startsWith("blob:")) {
        URL.revokeObjectURL(entry.url);
      }
      totalBytes -= entry.byteLength;
      this.audioCacheByHash.delete(hash);
      this.evictedCount += 1;
      this.updateStatesForHash(hash, "not_started");
    }
    this.refreshChunkDiagnostics();
  }

  private renderPlayState(): void {
    this.must<HTMLButtonElement>("btn-play").innerHTML = this.audio.paused
      ? '<i data-lucide="play" class="ui-icon"></i>'
      : '<i data-lucide="pause" class="ui-icon"></i>';
    this.renderIcons();
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
    const emptyState = this.must<HTMLDivElement>("image-empty");
    image.src = dataUrl;
    image.classList.remove("hidden");
    emptyState.classList.add("hidden");
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

  private must<T extends HTMLElement>(id: string): T {
    const element = document.getElementById(id);
    if (!element) {
      throw new Error(`Missing element: ${id}`);
    }
    return element as T;
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

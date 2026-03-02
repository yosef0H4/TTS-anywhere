import TomSelect from "tom-select";
import "tom-select/dist/css/tom-select.css";
import { createIcons, icons } from "lucide";
import { DEFAULT_CONFIG } from "../core/models/defaults";
import type { AppConfig, ReadingTimeline } from "../core/models/types";
import { AppPipeline } from "../core/pipeline/app-pipeline";
import { SettingsStore } from "../core/services/settings-store";
import { buildReadingTimeline, findChunkIndexByTime } from "../core/utils/chunking";
import { APP_TEMPLATE } from "../ui/template";
import "../ui/styles.css";

interface NamedOption {
  value: string;
  label: string;
}

interface ModelListResponse {
  data?: Array<{ id?: string }>;
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

  mount(root: HTMLElement): void {
    root.innerHTML = APP_TEMPLATE;
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
          return options;
        }
      } catch {
        // try next endpoint
      }
    }
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
      return options;
    } catch (error) {
      this.setStatus(`Failed to fetch ${namespace}: ${String(error)}`);
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

    pinButton.classList.add("active-pin");
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
    const basicIds = ["llm-url", "llm-key", "llm-prompt", "tts-url", "tts-key", "chunk-size", "wpm"];
    basicIds.forEach((id) => {
      this.must<HTMLInputElement>(id).addEventListener("change", () => {
        this.syncConfigFromInputs();
      });
    });

    this.must<HTMLTextAreaElement>("raw-text").addEventListener("input", () => this.updateTimelineFromRawText());
  }

  private syncConfigFromInputs(): void {
    this.config.llm.baseUrl = this.must<HTMLInputElement>("llm-url").value;
    this.config.llm.apiKey = this.must<HTMLInputElement>("llm-key").value;
    this.config.llm.promptTemplate = this.must<HTMLInputElement>("llm-prompt").value;
    this.config.tts.baseUrl = this.must<HTMLInputElement>("tts-url").value;
    this.config.tts.apiKey = this.must<HTMLInputElement>("tts-key").value;
    this.config.reading.chunkSize = Number(this.must<HTMLInputElement>("chunk-size").value);
    this.config.reading.wpmBase = Number(this.must<HTMLInputElement>("wpm").value);
    this.store.save(this.config);
    this.updateTimelineFromRawText();
  }

  private renderConfig(): void {
    this.must<HTMLInputElement>("llm-url").value = this.config.llm.baseUrl;
    this.must<HTMLInputElement>("llm-key").value = this.config.llm.apiKey;
    this.must<HTMLInputElement>("llm-prompt").value = this.config.llm.promptTemplate;
    this.must<HTMLInputElement>("tts-url").value = this.config.tts.baseUrl;
    this.must<HTMLInputElement>("tts-key").value = this.config.tts.apiKey;
    this.must<HTMLInputElement>("chunk-size").value = String(this.config.reading.chunkSize);
    this.must<HTMLInputElement>("wpm").value = String(this.config.reading.wpmBase);

    this.applyOptions(this.llmModelSelect, [{ value: this.config.llm.model, label: this.config.llm.model }], this.config.llm.model);
    this.applyOptions(this.ttsModelSelect, [{ value: this.config.tts.model, label: this.config.tts.model }], this.config.tts.model);
    this.applyOptions(this.ttsVoiceSelect, [{ value: this.config.tts.voice, label: this.config.tts.voice }], this.config.tts.voice);
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
    this.must<HTMLInputElement>("vol-slider").addEventListener("input", (event) => {
      const value = Number((event.currentTarget as HTMLInputElement).value);
      this.audio.volume = value / 100;
    });

    this.must<HTMLInputElement>("speed-slider").addEventListener("input", (event) => {
      const value = Number((event.currentTarget as HTMLInputElement).value);
      this.audio.playbackRate = value;
    });

    this.must<HTMLButtonElement>("btn-play").addEventListener("click", async () => {
      if (this.audio.paused) {
        await this.ensureAudioForCurrentText();
        await this.audio.play();
      } else {
        this.audio.pause();
      }
      this.renderPlayState();
    });

    this.must<HTMLButtonElement>("btn-prev").addEventListener("click", () => this.seekChunk(this.activeChunkIndex - 1));
    this.must<HTMLButtonElement>("btn-next").addEventListener("click", () => this.seekChunk(this.activeChunkIndex + 1));

    this.audio.addEventListener("timeupdate", () => {
      this.activeChunkIndex = findChunkIndexByTime(this.timeline, this.audio.currentTime * 1000);
      this.renderReadingPreview();
    });

    this.audio.addEventListener("play", () => this.renderPlayState());
    this.audio.addEventListener("pause", () => this.renderPlayState());
  }

  private async runPipeline(dataUrl: string): Promise<void> {
    this.must<HTMLImageElement>("preview-img").src = dataUrl;
    this.setStatus("Running OCR + TTS...");

    try {
      const result = await this.pipeline.run(dataUrl, this.config);
      this.must<HTMLTextAreaElement>("raw-text").value = result.text;
      this.timeline = result.timeline;
      this.activeChunkIndex = 0;
      this.renderReadingPreview();

      const oldObjectUrl = this.audio.src;
      this.audio.src = URL.createObjectURL(result.audioBlob);
      this.lastSynthText = result.text;
      if (oldObjectUrl.startsWith("blob:")) {
        URL.revokeObjectURL(oldObjectUrl);
      }
      this.audio.currentTime = 0;
      this.setStatus("Ready");
    } catch (error) {
      this.setStatus(`Pipeline error: ${String(error)}`);
    }
  }

  private updateTimelineFromRawText(): void {
    const text = this.must<HTMLTextAreaElement>("raw-text").value;
    this.timeline = buildReadingTimeline(text, this.config.reading.chunkSize, this.config.reading.wpmBase);
    this.renderReadingPreview();
  }

  private async ensureAudioForCurrentText(): Promise<void> {
    const text = this.must<HTMLTextAreaElement>("raw-text").value.trim();
    if (!text) {
      this.setStatus("Enter text first.");
      return;
    }

    const needsSynthesis = !this.audio.src || this.lastSynthText !== text;
    if (!needsSynthesis) {
      return;
    }

    this.setStatus("Synthesizing text...");
    try {
      const audioBlob = await this.pipeline.synthesizeText(text, this.config);
      const oldObjectUrl = this.audio.src;
      this.audio.src = URL.createObjectURL(audioBlob);
      this.audio.currentTime = 0;
      this.lastSynthText = text;
      if (oldObjectUrl.startsWith("blob:")) {
        URL.revokeObjectURL(oldObjectUrl);
      }
      this.setStatus("Ready");
    } catch (error) {
      this.setStatus(`TTS error: ${String(error)}`);
    }
  }

  private renderReadingPreview(): void {
    const preview = this.must<HTMLDivElement>("reading-preview");
    preview.innerHTML = "";

    this.timeline.chunks.forEach((chunk) => {
      const span = document.createElement("span");
      span.textContent = chunk.text;
      if (chunk.index === this.activeChunkIndex) {
        span.classList.add("active-chunk");
      }
      span.addEventListener("click", () => this.seekChunk(chunk.index));
      preview.appendChild(span);
      preview.appendChild(document.createTextNode(" "));
    });
  }

  private seekChunk(index: number): void {
    const chunk = this.timeline.chunks[index];
    if (!chunk) return;
    this.audio.currentTime = chunk.startMs / 1000;
    this.activeChunkIndex = chunk.index;
    this.renderReadingPreview();
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

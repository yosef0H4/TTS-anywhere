import { DEFAULT_CONFIG } from "../core/models/defaults";
import type { AppConfig, ReadingTimeline } from "../core/models/types";
import { AppPipeline } from "../core/pipeline/app-pipeline";
import { SettingsStore } from "../core/services/settings-store";
import { buildReadingTimeline, findChunkIndexByTime } from "../core/utils/chunking";
import { APP_TEMPLATE } from "../ui/template";
import "../ui/styles.css";

export class WebApp {
  private readonly store = new SettingsStore();
  private readonly pipeline = new AppPipeline();
  private readonly config: AppConfig = this.store.load();
  private readonly audio = new Audio();
  private timeline: ReadingTimeline = { chunks: [], durationMs: 0 };
  private activeChunkIndex = 0;
  private imageDataUrl = "";

  mount(root: HTMLElement): void {
    root.innerHTML = APP_TEMPLATE;
    this.bindWindowControls();
    this.bindSettings();
    this.bindCapture();
    this.bindPlayback();
    this.renderConfig();
  }

  private bindWindowControls(): void {
    const pinButton = this.must<HTMLButtonElement>("btn-pin");
    const minimizeButton = this.must<HTMLButtonElement>("btn-minimize");
    const closeButton = this.must<HTMLButtonElement>("btn-close");
    const alwaysOnTopButton = this.must<HTMLButtonElement>("btn-aot-toggle");

    if (!window.electronAPI) {
      pinButton.style.display = "none";
      minimizeButton.style.display = "none";
      closeButton.style.display = "none";
      alwaysOnTopButton.style.display = "none";
      return;
    }

    minimizeButton.addEventListener("click", () => {
      window.electronAPI?.minimizeWindow();
    });

    closeButton.addEventListener("click", () => {
      window.electronAPI?.closeWindow();
    });

    pinButton.classList.add("active-pin");
    pinButton.addEventListener("click", async () => {
      const pinned = await window.electronAPI?.togglePinWindow();
      if (pinned) {
        pinButton.classList.add("active-pin");
        alwaysOnTopButton.textContent = "Always On Top: On";
        alwaysOnTopButton.classList.add("active-aot");
      } else {
        pinButton.classList.remove("active-pin");
        alwaysOnTopButton.textContent = "Always On Top: Off";
        alwaysOnTopButton.classList.remove("active-aot");
      }
    });

    alwaysOnTopButton.classList.add("active-aot");
    alwaysOnTopButton.addEventListener("click", async () => {
      const pinned = await window.electronAPI?.togglePinWindow();
      if (pinned) {
        pinButton.classList.add("active-pin");
        alwaysOnTopButton.textContent = "Always On Top: On";
        alwaysOnTopButton.classList.add("active-aot");
      } else {
        pinButton.classList.remove("active-pin");
        alwaysOnTopButton.textContent = "Always On Top: Off";
        alwaysOnTopButton.classList.remove("active-aot");
      }
    });
  }

  private setStatus(text: string): void {
    const el = this.must<HTMLSpanElement>("status-text");
    el.textContent = text;
  }

  private bindSettings(): void {
    const ids = ["llm-url", "llm-key", "llm-model", "llm-prompt", "tts-url", "tts-key", "tts-model", "tts-voice", "chunk-size", "wpm"];
    ids.forEach((id) => {
      this.must<HTMLInputElement>(id).addEventListener("change", () => {
        this.config.llm.baseUrl = this.must<HTMLInputElement>("llm-url").value;
        this.config.llm.apiKey = this.must<HTMLInputElement>("llm-key").value;
        this.config.llm.model = this.must<HTMLInputElement>("llm-model").value;
        this.config.llm.promptTemplate = this.must<HTMLInputElement>("llm-prompt").value;
        this.config.tts.baseUrl = this.must<HTMLInputElement>("tts-url").value;
        this.config.tts.apiKey = this.must<HTMLInputElement>("tts-key").value;
        this.config.tts.model = this.must<HTMLInputElement>("tts-model").value;
        this.config.tts.voice = this.must<HTMLInputElement>("tts-voice").value;
        this.config.reading.chunkSize = Number(this.must<HTMLInputElement>("chunk-size").value);
        this.config.reading.wpmBase = Number(this.must<HTMLInputElement>("wpm").value);
        this.store.save(this.config);
        this.updateTimelineFromRawText();
      });
    });

    this.must<HTMLTextAreaElement>("raw-text").addEventListener("input", () => this.updateTimelineFromRawText());
  }

  private renderConfig(): void {
    this.must<HTMLInputElement>("llm-url").value = this.config.llm.baseUrl;
    this.must<HTMLInputElement>("llm-key").value = this.config.llm.apiKey;
    this.must<HTMLInputElement>("llm-model").value = this.config.llm.model;
    this.must<HTMLInputElement>("llm-prompt").value = this.config.llm.promptTemplate;
    this.must<HTMLInputElement>("tts-url").value = this.config.tts.baseUrl;
    this.must<HTMLInputElement>("tts-key").value = this.config.tts.apiKey;
    this.must<HTMLInputElement>("tts-model").value = this.config.tts.model;
    this.must<HTMLInputElement>("tts-voice").value = this.config.tts.voice;
    this.must<HTMLInputElement>("chunk-size").value = String(this.config.reading.chunkSize);
    this.must<HTMLInputElement>("wpm").value = String(this.config.reading.wpmBase);
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
    this.imageDataUrl = dataUrl;
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
    this.must<HTMLButtonElement>("btn-play").textContent = this.audio.paused ? "▶" : "⏸";
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

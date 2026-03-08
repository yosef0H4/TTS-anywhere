// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../core/models/defaults";
import { resolveUiLanguage } from "../core/models/locale";
import { SettingsStore } from "../core/services/settings-store";

class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

describe("settings store", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      value: new MemoryStorage(),
      configurable: true,
      writable: true
    });
  });

  it("returns defaults when empty", () => {
    const store = new SettingsStore();
    expect(store.load()).toEqual(DEFAULT_CONFIG);
  });

  it("persists and restores", () => {
    const store = new SettingsStore();
    const cfg = store.load();
    cfg.llm.model = "vision-model";
    cfg.tts.voice = "nova";
    cfg.ui.language = "ar";
    cfg.textProcessing.detectionMode = "fullscreen_only";
    cfg.textProcessing.detectorProvider = "paddle";
    cfg.textProcessing.detectorBaseUrls.paddle = "http://127.0.0.1:8093";
    store.save(cfg);

    expect(store.load().llm.model).toBe("vision-model");
    expect(store.load().tts.voice).toBe("nova");
    expect(store.load().ui.language).toBe("ar");
    expect(store.load().textProcessing.detectionMode).toBe("fullscreen_only");
    expect(store.load().textProcessing.detectorProvider).toBe("paddle");
    expect(store.load().textProcessing.detectorBaseUrls.paddle).toBe("http://127.0.0.1:8093");
  });

  it("migrates legacy panel width config", () => {
    const legacy = {
      ...DEFAULT_CONFIG,
      ui: {
        ...DEFAULT_CONFIG.ui,
        panels: {
          imagePanelWidthPercent: 46,
          textPanelWidthPercent: 30
        }
      }
    };

    localStorage.setItem("tts-snipper:settings", JSON.stringify(legacy));
    const restored = new SettingsStore().load();

    expect(restored.ui.panels.desktop.leftPanePercent).toBe(46);
    expect(restored.ui.panels.desktop.rightTopPercent).toBe(DEFAULT_CONFIG.ui.panels.desktop.rightTopPercent);
  });

  it("migrates legacy rapidEnabled to provider-neutral text processing config", () => {
    const legacy = {
      ...DEFAULT_CONFIG,
      textProcessing: {
        rapidEnabled: true,
        rapidBaseUrl: "http://127.0.0.1:8099"
      }
    };

    localStorage.setItem("tts-snipper:settings", JSON.stringify(legacy));
    const restored = new SettingsStore().load();

    expect(restored.textProcessing.detectionMode).toBe("all");
    expect(restored.textProcessing.detectorProvider).toBe("rapid");
    expect(restored.textProcessing.detectorBaseUrls.rapid).toBe("http://127.0.0.1:8099");
  });

  it("defaults missing ui.language using locale resolution", () => {
    const legacy = {
      ...DEFAULT_CONFIG,
      ui: {
        ...DEFAULT_CONFIG.ui
      }
    };
    delete (legacy.ui as Partial<typeof legacy.ui>).language;

    localStorage.setItem("tts-snipper:settings", JSON.stringify(legacy));
    const restored = new SettingsStore().load();

    expect(restored.ui.language).toBe(resolveUiLanguage());
  });
});

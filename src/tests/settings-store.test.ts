// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../core/models/defaults";
import { resolveUiLanguage } from "../core/models/locale";
import { LEGACY_SETTINGS_KEYS, SETTINGS_KEY, SettingsStore } from "../core/services/settings-store";

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
    cfg.system.abortHotkey = "ctrl+shift+alt+z";
    cfg.system.playPauseHotkey = "ctrl+shift+alt+space";
    cfg.system.replayCaptureHotkey = "ctrl+shift+alt+d";
    cfg.textProcessing.detectionMode = "fullscreen_only";
    cfg.textProcessing.detectorBaseUrl = "http://127.0.0.1:8093";
    store.save(cfg);

    expect(localStorage.getItem(SETTINGS_KEY)).not.toBeNull();
    expect(localStorage.getItem(LEGACY_SETTINGS_KEYS[0])).toBeNull();
    expect(store.load().llm.model).toBe("vision-model");
    expect(store.load().tts.voice).toBe("nova");
    expect(store.load().ui.language).toBe("ar");
    expect(store.load().system.abortHotkey).toBe("ctrl+shift+alt+z");
    expect(store.load().system.playPauseHotkey).toBe("ctrl+shift+alt+space");
    expect(store.load().system.replayCaptureHotkey).toBe("ctrl+shift+alt+d");
    expect(store.load().textProcessing.detectionMode).toBe("fullscreen_only");
    expect(store.load().textProcessing.detectorBaseUrl).toBe("http://127.0.0.1:8093");
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

    localStorage.setItem(LEGACY_SETTINGS_KEYS[0], JSON.stringify(legacy));
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

    localStorage.setItem(LEGACY_SETTINGS_KEYS[0], JSON.stringify(legacy));
    const restored = new SettingsStore().load();

    expect(restored.textProcessing.detectionMode).toBe("all");
    expect(restored.textProcessing.detectorBaseUrl).toBe("http://127.0.0.1:8099");
  });

  it("migrates legacy selected detector provider url into generic detector url", () => {
    const legacy = {
      ...DEFAULT_CONFIG,
      textProcessing: {
        detectionMode: "all",
        detectorProvider: "paddle",
        detectorBaseUrls: {
          rapid: "http://127.0.0.1:8091",
          paddle: "http://127.0.0.1:8093"
        }
      }
    };

    localStorage.setItem(LEGACY_SETTINGS_KEYS[0], JSON.stringify(legacy));
    const restored = new SettingsStore().load();

    expect(restored.textProcessing.detectionMode).toBe("all");
    expect(restored.textProcessing.detectorBaseUrl).toBe("http://127.0.0.1:8093");
  });

  it("defaults missing ui.language using locale resolution", () => {
    const legacy = {
      ...DEFAULT_CONFIG,
      ui: {
        ...DEFAULT_CONFIG.ui
      }
    };
    delete (legacy.ui as Partial<typeof legacy.ui>).language;

    localStorage.setItem(LEGACY_SETTINGS_KEYS[0], JSON.stringify(legacy));
    const restored = new SettingsStore().load();

    expect(restored.ui.language).toBe(resolveUiLanguage());
  });
});

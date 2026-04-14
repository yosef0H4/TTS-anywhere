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
    cfg.llm.geminiSdk.model = "vision-model";
    cfg.tts.voice = "nova";
    cfg.tts.geminiSdk.voice = "nova";
    cfg.ui.language = "ar";
    cfg.ui.theme = "pink";
    cfg.ui.darkMode = true;
    cfg.system.abortHotkey = "ctrl+shift+alt+z";
    cfg.system.playPauseHotkey = "ctrl+shift+alt+space";
    cfg.system.replayCaptureHotkey = "ctrl+shift+alt+d";
    cfg.system.activeWindowCaptureHotkey = "ctrl+shift+alt+w";
    cfg.system.ocrClipboardHotkey = "ctrl+shift+alt+c";
    cfg.system.feedbackSounds.byHotkey.capture.soundId = "capture_full_chime";
    cfg.system.feedbackSounds.byHotkey.capture.volume = 64;
    cfg.system.feedbackSounds.globalError.soundId = "error_double_buzz";
    cfg.system.feedbackSounds.globalError.volume = 71;
    cfg.textProcessing.detectionMode = "fullscreen_and_window";
    cfg.textProcessing.detectorBaseUrl = "http://127.0.0.1:8093";
    store.save(cfg);

    expect(localStorage.getItem(SETTINGS_KEY)).not.toBeNull();
    expect(localStorage.getItem(LEGACY_SETTINGS_KEYS[0])).toBeNull();
    expect(store.load().llm.model).toBe("vision-model");
    expect(store.load().tts.voice).toBe("nova");
    expect(store.load().ui.language).toBe("ar");
    expect(store.load().ui.theme).toBe("pink");
    expect(store.load().ui.darkMode).toBe(true);
    expect(store.load().system.abortHotkey).toBe("ctrl+shift+alt+z");
    expect(store.load().system.playPauseHotkey).toBe("ctrl+shift+alt+space");
    expect(store.load().system.replayCaptureHotkey).toBe("ctrl+shift+alt+d");
    expect(store.load().system.activeWindowCaptureHotkey).toBe("ctrl+shift+alt+w");
    expect(store.load().system.ocrClipboardHotkey).toBe("ctrl+shift+alt+c");
    expect(store.load().system.feedbackSounds.byHotkey.capture.soundId).toBe("capture_full_chime");
    expect(store.load().system.feedbackSounds.byHotkey.capture.volume).toBe(64);
    expect(store.load().system.feedbackSounds.globalError.soundId).toBe("error_double_buzz");
    expect(store.load().system.feedbackSounds.globalError.volume).toBe(71);
    expect(store.load().system.fullCaptureHotkey).toBe(DEFAULT_CONFIG.system.fullCaptureHotkey);
    expect(store.load().textProcessing.detectionMode).toBe("fullscreen_and_window");
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

  it("defaults missing dark mode to false for legacy settings", () => {
    const legacy = {
      ...DEFAULT_CONFIG,
      ui: {
        ...DEFAULT_CONFIG.ui,
        theme: "pink"
      }
    };
    delete (legacy.ui as Partial<typeof legacy.ui>).darkMode;

    localStorage.setItem(LEGACY_SETTINGS_KEYS[0], JSON.stringify(legacy));
    const restored = new SettingsStore().load();

    expect(restored.ui.theme).toBe("pink");
    expect(restored.ui.darkMode).toBe(false);
  });

  it("falls back to the default base theme when saved theme is invalid", () => {
    const invalid = {
      ...DEFAULT_CONFIG,
      ui: {
        ...DEFAULT_CONFIG.ui,
        theme: "dark-pink",
        darkMode: true
      }
    };

    localStorage.setItem(SETTINGS_KEY, JSON.stringify(invalid));
    const restored = new SettingsStore().load();

    expect(restored.ui.theme).toBe(DEFAULT_CONFIG.ui.theme);
    expect(restored.ui.darkMode).toBe(true);
  });

  it("clamps saved playback speed to the supported minimum", () => {
    const invalid = {
      ...DEFAULT_CONFIG,
      ui: {
        ...DEFAULT_CONFIG.ui,
        playbackRate: 0
      }
    };

    localStorage.setItem(SETTINGS_KEY, JSON.stringify(invalid));
    const restored = new SettingsStore().load();

    expect(restored.ui.playbackRate).toBe(0.2);
  });

  it("sanitizes playback speed before persisting settings", () => {
    const store = new SettingsStore();
    const cfg = store.load();
    cfg.ui.playbackRate = 0;
    store.save(cfg);

    expect(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}").ui?.playbackRate).toBe(0.2);
    expect(store.load().ui.playbackRate).toBe(0.2);
  });

  it("fills missing full screen capture hotkey from defaults", () => {
    const legacy = {
      ...DEFAULT_CONFIG,
      system: {
        ...DEFAULT_CONFIG.system
      }
    };
    delete (legacy.system as Partial<typeof legacy.system>).fullCaptureHotkey;

    localStorage.setItem(LEGACY_SETTINGS_KEYS[0], JSON.stringify(legacy));
    const restored = new SettingsStore().load();

    expect(restored.system.captureHotkey).toBe(DEFAULT_CONFIG.system.captureHotkey);
    expect(restored.system.fullCaptureHotkey).toBe(DEFAULT_CONFIG.system.fullCaptureHotkey);
  });

  it("fills missing active window capture hotkey from defaults", () => {
    const legacy = {
      ...DEFAULT_CONFIG,
      system: {
        ...DEFAULT_CONFIG.system
      }
    };
    delete (legacy.system as Partial<typeof legacy.system>).activeWindowCaptureHotkey;

    localStorage.setItem(LEGACY_SETTINGS_KEYS[0], JSON.stringify(legacy));
    const restored = new SettingsStore().load();

    expect(restored.system.activeWindowCaptureHotkey).toBe(DEFAULT_CONFIG.system.activeWindowCaptureHotkey);
  });

  it("fills missing OCR clipboard hotkey from defaults", () => {
    const legacy = {
      ...DEFAULT_CONFIG,
      system: {
        ...DEFAULT_CONFIG.system
      }
    };
    delete (legacy.system as Partial<typeof legacy.system>).ocrClipboardHotkey;

    localStorage.setItem(LEGACY_SETTINGS_KEYS[0], JSON.stringify(legacy));
    const restored = new SettingsStore().load();

    expect(restored.system.ocrClipboardHotkey).toBe(DEFAULT_CONFIG.system.ocrClipboardHotkey);
  });

  it("preserves cleared hotkeys instead of restoring defaults", () => {
    const cfg = {
      ...DEFAULT_CONFIG,
      system: {
        ...DEFAULT_CONFIG.system,
        captureHotkey: "",
        playPauseHotkey: ""
      }
    };

    localStorage.setItem(SETTINGS_KEY, JSON.stringify(cfg));
    const restored = new SettingsStore().load();

    expect(restored.system.captureHotkey).toBe("");
    expect(restored.system.playPauseHotkey).toBe("");
  });

  it("fills missing feedback sound settings from defaults", () => {
    const legacy = {
      ...DEFAULT_CONFIG,
      system: {
        ...DEFAULT_CONFIG.system
      }
    };
    delete (legacy.system as Partial<typeof legacy.system>).feedbackSounds;

    localStorage.setItem(SETTINGS_KEY, JSON.stringify(legacy));
    const restored = new SettingsStore().load();

    expect(restored.system.feedbackSounds).toEqual(DEFAULT_CONFIG.system.feedbackSounds);
  });
});

import { DEFAULT_CONFIG } from "../models/defaults";
import { resolveUiLanguage } from "../models/locale";
import type { AppConfig } from "../models/types";

export const SETTINGS_KEY = "tts-anywhere:settings";
export const LEGACY_SETTINGS_KEYS = ["tts-snipper:settings"] as const;

export class SettingsStore {
  load(): AppConfig {
    const raw = localStorage.getItem(SETTINGS_KEY)
      ?? LEGACY_SETTINGS_KEYS.map((key) => localStorage.getItem(key)).find((value) => typeof value === "string")
      ?? null;
    if (!raw) return this.cloneDefaults();
    try {
      const parsed = JSON.parse(raw) as Partial<AppConfig>;
      const migratedPanels = this.mergePanels(parsed.ui?.panels);
      const migratedTextProcessing = this.mergeTextProcessing(parsed.textProcessing);
      return {
        llm: { ...DEFAULT_CONFIG.llm, ...parsed.llm },
        tts: { ...DEFAULT_CONFIG.tts, ...parsed.tts },
        reading: { ...DEFAULT_CONFIG.reading, ...parsed.reading },
        ui: {
          ...DEFAULT_CONFIG.ui,
          ...parsed.ui,
          language: parsed.ui?.language === "ar" || parsed.ui?.language === "en" ? parsed.ui.language : resolveUiLanguage(),
          panels: migratedPanels
        },
        system: { ...DEFAULT_CONFIG.system, ...parsed.system },
        logging: { ...DEFAULT_CONFIG.logging, ...parsed.logging },
        textProcessing: migratedTextProcessing,
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
    } catch {
      return this.cloneDefaults();
    }
  }

  save(next: AppConfig): void {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
    for (const legacyKey of LEGACY_SETTINGS_KEYS) {
      localStorage.removeItem(legacyKey);
    }
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

  private cloneDefaults(): AppConfig {
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as AppConfig;
  }

  private mergeTextProcessing(textProcessing: unknown): AppConfig["textProcessing"] {
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
    const explicitBaseUrl = typeof value.detectorBaseUrl === "string" && value.detectorBaseUrl.trim()
      ? value.detectorBaseUrl
      : null;
    const legacyRapidBaseUrl = typeof value.rapidBaseUrl === "string" && value.rapidBaseUrl.trim()
      ? value.rapidBaseUrl
      : defaults.detectorBaseUrl;
    const migratedProvider = detectorProvider === "rapid" || detectorProvider === "paddle"
      ? detectorProvider
      : "rapid";
    const migratedProviderUrl = typeof detectorBaseUrls[migratedProvider] === "string" && String(detectorBaseUrls[migratedProvider]).trim()
      ? String(detectorBaseUrls[migratedProvider]).trim()
      : null;

    return {
      detectionMode: detectionMode === "off" || detectionMode === "fullscreen_only" || detectionMode === "all"
        ? detectionMode
        : (rapidMode === "off" || rapidMode === "fullscreen_only" || rapidMode === "all"
            ? rapidMode
            : (legacyRapidEnabled === true ? "all" : defaults.detectionMode)),
      detectorBaseUrl: explicitBaseUrl ?? migratedProviderUrl ?? legacyRapidBaseUrl
    };
  }
}

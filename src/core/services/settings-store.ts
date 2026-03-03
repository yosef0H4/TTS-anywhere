import { DEFAULT_CONFIG } from "../models/defaults";
import type { AppConfig } from "../models/types";

const SETTINGS_KEY = "tts-snipper:settings";

export class SettingsStore {
  load(): AppConfig {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_CONFIG;
    try {
      const parsed = JSON.parse(raw) as Partial<AppConfig>;
      const migratedPanels = this.mergePanels(parsed.ui?.panels);
      return {
        llm: { ...DEFAULT_CONFIG.llm, ...parsed.llm },
        tts: { ...DEFAULT_CONFIG.tts, ...parsed.tts },
        reading: { ...DEFAULT_CONFIG.reading, ...parsed.reading },
        ui: {
          ...DEFAULT_CONFIG.ui,
          ...parsed.ui,
          panels: migratedPanels
        },
        system: { ...DEFAULT_CONFIG.system, ...parsed.system },
        logging: { ...DEFAULT_CONFIG.logging, ...parsed.logging }
      };
    } catch {
      return DEFAULT_CONFIG;
    }
  }

  save(next: AppConfig): void {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
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
}

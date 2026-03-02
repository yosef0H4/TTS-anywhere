import { DEFAULT_CONFIG } from "../models/defaults";
import type { AppConfig } from "../models/types";

const SETTINGS_KEY = "tts-snipper:settings";

export class SettingsStore {
  load(): AppConfig {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_CONFIG;
    try {
      const parsed = JSON.parse(raw) as Partial<AppConfig>;
      return {
        llm: { ...DEFAULT_CONFIG.llm, ...parsed.llm },
        tts: { ...DEFAULT_CONFIG.tts, ...parsed.tts },
        reading: { ...DEFAULT_CONFIG.reading, ...parsed.reading },
        ui: { ...DEFAULT_CONFIG.ui, ...parsed.ui }
      };
    } catch {
      return DEFAULT_CONFIG;
    }
  }

  save(next: AppConfig): void {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  }
}

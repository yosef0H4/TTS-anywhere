// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../core/models/defaults";
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
    store.save(cfg);

    expect(store.load().llm.model).toBe("vision-model");
    expect(store.load().tts.voice).toBe("nova");
  });
});

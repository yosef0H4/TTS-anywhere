import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { parseHotkeySpec } from "./hotkey-parser.js";
import type { HotkeySpec, HotkeySessionEvents, HotkeySessionOptions } from "./types.js";

const DEFAULT_HOTKEY = "ctrl+shift+alt+s";

type NativeHotkeyEvent = {
  type?: "triggerDown" | "triggerUp";
  point?: { x?: number; y?: number };
};

type NativeHotkeyModule = {
  createHotkeySession(spec: HotkeySpec, callback: (event: NativeHotkeyEvent) => void): number;
  destroyHotkeySession(id: number): void;
  startHotkeySession(id: number): void;
  stopHotkeySession(id: number): void;
  setHotkeySessionSpec(id: number, spec: HotkeySpec): void;
  getCursorPosition(): { x?: number; y?: number };
  isVirtualKeyDown(vk: number): boolean;
};

let hotkeyModule: NativeHotkeyModule | null | undefined;

function resolveHotkeyAddonPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const packageRoot = path.resolve(here, "..");
  const candidates = [
    path.join(packageRoot, "build", "Release", "nodehotkey_hotkey.node"),
    path.join(packageRoot, "build", "Debug", "nodehotkey_hotkey.node")
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    `nodehotkey native hotkey addon not found. Expected one of: ${candidates.join(", ")}`
  );
}

function loadHotkeyModule(): NativeHotkeyModule {
  if (hotkeyModule) return hotkeyModule;
  if (hotkeyModule === null) throw new Error("nodehotkey native hotkey addon is unavailable");
  if (process.platform !== "win32") {
    hotkeyModule = null;
    throw new Error("nodehotkey native hotkey addon is Windows-only");
  }

  const require = createRequire(import.meta.url);
  const addonPath = resolveHotkeyAddonPath();
  const loaded = require(addonPath) as Partial<NativeHotkeyModule>;
  if (
    typeof loaded.createHotkeySession !== "function" ||
    typeof loaded.destroyHotkeySession !== "function" ||
    typeof loaded.startHotkeySession !== "function" ||
    typeof loaded.stopHotkeySession !== "function" ||
    typeof loaded.setHotkeySessionSpec !== "function" ||
    typeof loaded.getCursorPosition !== "function" ||
    typeof loaded.isVirtualKeyDown !== "function"
  ) {
    hotkeyModule = null;
    throw new Error(`nodehotkey native hotkey addon at ${addonPath} does not expose the expected API`);
  }

  hotkeyModule = loaded as NativeHotkeyModule;
  return hotkeyModule;
}

function normalizePoint(point: NativeHotkeyEvent["point"]): { x: number; y: number } | null {
  if (typeof point?.x !== "number" || typeof point?.y !== "number") return null;
  return { x: point.x, y: point.y };
}

export class HotkeySession {
  private readonly pollMs: number;
  private readonly events: HotkeySessionEvents | undefined;
  private readonly native: NativeHotkeyModule;

  private running = false;
  private activeHotkey: HotkeySpec | null;
  private nativeSessionId: number | null = null;

  constructor(options: HotkeySessionOptions = {}) {
    if (process.platform !== "win32") throw new Error("nodehotkey is Windows-only");
    this.pollMs = options.pollMs ?? 16;
    this.events = options.events;
    this.activeHotkey = this.parseOptionalHotkey(options.initialHotkey ?? DEFAULT_HOTKEY);
    this.native = loadHotkeyModule();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    if (!this.activeHotkey) return;

    this.nativeSessionId = this.native.createHotkeySession(this.activeHotkey, (event) => {
      const point = normalizePoint(event.point);
      if (event.type === "triggerDown" && point) {
        this.events?.onTriggerDown?.(point);
        return;
      }
      if (event.type === "triggerUp" && point) {
        this.events?.onTriggerUp?.(point);
      }
    });
    this.native.startHotkeySession(this.nativeSessionId);
    this.events?.onHotkeyRegistered?.(this.activeHotkey.label);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.nativeSessionId !== null) {
      this.native.stopHotkeySession(this.nativeSessionId);
      this.native.destroyHotkeySession(this.nativeSessionId);
      this.nativeSessionId = null;
    }
  }

  setHotkey(hotkey: string): void {
    const next = this.parseOptionalHotkey(hotkey);
    this.activeHotkey = next;

    if (this.nativeSessionId !== null) {
      this.native.stopHotkeySession(this.nativeSessionId);
      this.native.destroyHotkeySession(this.nativeSessionId);
      this.nativeSessionId = null;
    }

    if (this.running && next) {
      this.nativeSessionId = this.native.createHotkeySession(next, (event) => {
        const point = normalizePoint(event.point);
        if (event.type === "triggerDown" && point) {
          this.events?.onTriggerDown?.(point);
          return;
        }
        if (event.type === "triggerUp" && point) {
          this.events?.onTriggerUp?.(point);
        }
      });
      this.native.startHotkeySession(this.nativeSessionId);
    }

    this.events?.onHotkeySwitched?.(next?.label ?? "");
  }

  getHotkey(): string {
    return this.activeHotkey?.label ?? "";
  }

  getHotkeySpec(): HotkeySpec {
    if (!this.activeHotkey) throw new Error("Hotkey session is disabled");
    return this.activeHotkey;
  }

  getCursorPos(): { x: number; y: number } | null {
    const point = this.native.getCursorPosition();
    return normalizePoint(point);
  }

  isKeyDown(vk: number): boolean {
    return this.native.isVirtualKeyDown(vk);
  }

  private parseOptionalHotkey(hotkey: string | null | undefined): HotkeySpec | null {
    const normalized = String(hotkey ?? "").trim();
    if (!normalized) return null;
    return parseHotkeySpec(normalized);
  }
}

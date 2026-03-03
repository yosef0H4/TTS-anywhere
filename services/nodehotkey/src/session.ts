import { parseHotkeySpec, MOD_ALT, MOD_CONTROL, MOD_SHIFT, MOD_WIN } from "./hotkey-parser.js";
import type { HotkeySpec, HotkeySessionEvents, HotkeySessionOptions } from "./types.js";
import {
  ensureDpiAwareness,
  GetAsyncKeyState,
  GetCursorPos,
  PeekMessageW,
  PM_REMOVE,
  RegisterHotKey,
  UnregisterHotKey,
  WM_HOTKEY,
  type Point,
  type WinMsg
} from "./win32-bindings.js";

const HOTKEY_ID = 1;
const DEFAULT_HOTKEY = "ctrl+shift+alt+s";
const VK_SHIFT = 0x10;
const VK_CONTROL = 0x11;
const VK_MENU = 0x12;
const VK_LWIN = 0x5b;
const VK_RWIN = 0x5c;

export class HotkeySession {
  private readonly pollMs: number;
  private readonly events: HotkeySessionEvents | undefined;

  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private activeHotkey: HotkeySpec;
  private triggerComboDown = false;
  private triggerHeld = false;

  constructor(options: HotkeySessionOptions = {}) {
    if (process.platform !== "win32") throw new Error("nodehotkey is Windows-only");
    this.pollMs = options.pollMs ?? 16;
    this.events = options.events;
    this.activeHotkey = parseHotkeySpec(options.initialHotkey ?? DEFAULT_HOTKEY);
  }

  start(): void {
    if (this.running) return;
    ensureDpiAwareness();
    this.tryRegisterHotkey(this.activeHotkey);
    this.events?.onHotkeyRegistered?.(this.activeHotkey.label);

    this.running = true;
    this.timer = setInterval(() => this.tick(), this.pollMs);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    UnregisterHotKey(null, HOTKEY_ID);
    this.triggerComboDown = false;
    this.triggerHeld = false;
  }

  setHotkey(hotkey: string): void {
    const next = parseHotkeySpec(hotkey);
    const previous = this.activeHotkey;

    UnregisterHotKey(null, HOTKEY_ID);
    try {
      this.tryRegisterHotkey(next);
      this.activeHotkey = next;
      this.events?.onHotkeySwitched?.(next.label);
    } catch (error) {
      this.tryRegisterHotkey(previous);
      throw error;
    }
  }

  getHotkey(): string {
    return this.activeHotkey.label;
  }

  getHotkeySpec(): HotkeySpec {
    return this.activeHotkey;
  }

  getCursorPos(): Point | null {
    const point: Point = { x: 0, y: 0 };
    return GetCursorPos(point) ? point : null;
  }

  isKeyDown(vk: number): boolean {
    return (GetAsyncKeyState(vk) & 0x8000) !== 0;
  }

  private tryRegisterHotkey(spec: HotkeySpec): void {
    const ok = RegisterHotKey(null, HOTKEY_ID, spec.modifiers, spec.vk);
    if (!ok) throw new Error(`RegisterHotKey failed for ${spec.label}`);
  }

  private tick(): void {
    if (!this.running) return;

    let startedByMessage = false;
    const msg: WinMsg = {};
    while (PeekMessageW(msg, null, WM_HOTKEY, WM_HOTKEY, PM_REMOVE)) {
      if (msg.message === WM_HOTKEY && Number(msg.wParam) === HOTKEY_ID) {
        startedByMessage = true;
        if (!this.triggerHeld) {
          this.triggerHeld = true;
          const point = this.getCursorPos();
          if (point) this.events?.onTriggerDown?.(point);
        }
      }
    }

    const comboDown = this.isTriggerComboDown();
    if (!startedByMessage && comboDown && !this.triggerComboDown && !this.triggerHeld) {
      this.triggerHeld = true;
      const point = this.getCursorPos();
      if (point) this.events?.onTriggerDown?.(point);
    }

    if (this.triggerHeld && !this.isKeyDown(this.activeHotkey.releaseVk)) {
      this.triggerHeld = false;
      const point = this.getCursorPos();
      if (point) this.events?.onTriggerUp?.(point);
    }

    this.triggerComboDown = comboDown;
  }

  private isTriggerComboDown(): boolean {
    const mods = this.activeHotkey.modifiers;
    if ((mods & MOD_CONTROL) !== 0 && (GetAsyncKeyState(VK_CONTROL) & 0x8000) === 0) return false;
    if ((mods & MOD_SHIFT) !== 0 && (GetAsyncKeyState(VK_SHIFT) & 0x8000) === 0) return false;
    if ((mods & MOD_ALT) !== 0 && (GetAsyncKeyState(VK_MENU) & 0x8000) === 0) return false;
    if ((mods & MOD_WIN) !== 0) {
      const lWinDown = (GetAsyncKeyState(VK_LWIN) & 0x8000) !== 0;
      const rWinDown = (GetAsyncKeyState(VK_RWIN) & 0x8000) !== 0;
      if (!lWinDown && !rWinDown) return false;
    }
    return (GetAsyncKeyState(this.activeHotkey.vk) & 0x8000) !== 0;
  }
}

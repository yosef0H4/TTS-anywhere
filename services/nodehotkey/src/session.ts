import { parseHotkeySpec, MOD_ALT, MOD_CONTROL, MOD_SHIFT, MOD_WIN } from "./hotkey-parser.js";
import type { HotkeySpec, HotkeySessionEvents, HotkeySessionOptions } from "./types.js";
import {
  CallNextHookEx,
  GetModuleHandleW,
  ensureDpiAwareness,
  GetAsyncKeyState,
  GetCursorPos,
  HC_ACTION,
  LLKHF_INJECTED,
  PeekMessageW,
  PM_REMOVE,
  RegisterHotKey,
  registerLowLevelKeyboardProc,
  RegisteredCallback,
  SetWindowsHookExW,
  UnregisterHotKey,
  unregisterCallback,
  UnhookWindowsHookEx,
  WH_KEYBOARD_LL,
  WM_HOTKEY,
  WM_KEYDOWN,
  WM_KEYUP,
  WM_SYSKEYDOWN,
  WM_SYSKEYUP,
  type Point,
  type KbdLlHookStruct,
  type WinMsg
} from "./win32-bindings.js";

const HOTKEY_ID = 1;
const DEFAULT_HOTKEY = "ctrl+shift+alt+s";
const VK_SHIFT = 0x10;
const VK_CONTROL = 0x11;
const VK_MENU = 0x12;
const VK_LWIN = 0x5b;
const VK_RWIN = 0x5c;

function sessionDiag(event: string, data?: Record<string, unknown>): void {
  try {
    const context = data ? ` ${JSON.stringify(data)}` : "";
    console.info(`[nodehotkey] ${event}${context}`);
  } catch {
    console.info(`[nodehotkey] ${event}`);
  }
}

export class HotkeySession {
  private readonly pollMs: number;
  private readonly events: HotkeySessionEvents | undefined;

  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private activeHotkey: HotkeySpec;
  private triggerComboDown = false;
  private triggerHeld = false;
  private keyboardHook: unknown = null;
  private keyboardHookCallback: RegisteredCallback | null = null;
  private tickCount = 0;

  constructor(options: HotkeySessionOptions = {}) {
    if (process.platform !== "win32") throw new Error("nodehotkey is Windows-only");
    this.pollMs = options.pollMs ?? 16;
    this.events = options.events;
    this.activeHotkey = parseHotkeySpec(options.initialHotkey ?? DEFAULT_HOTKEY);
  }

  start(): void {
    if (this.running) return;
    const startedAt = Date.now();
    sessionDiag("session.start.begin", { hotkey: this.activeHotkey.label, pollMs: this.pollMs });
    ensureDpiAwareness();
    sessionDiag("session.start.dpi-ready", { hotkey: this.activeHotkey.label, elapsedMs: Date.now() - startedAt });
    this.tryRegisterHotkey(this.activeHotkey);
    sessionDiag("session.start.hotkey-registered", { hotkey: this.activeHotkey.label, elapsedMs: Date.now() - startedAt });
    this.installKeyboardHook();
    sessionDiag("session.start.hook-installed", { hotkey: this.activeHotkey.label, elapsedMs: Date.now() - startedAt });
    this.events?.onHotkeyRegistered?.(this.activeHotkey.label);

    this.running = true;
    this.tickCount = 0;
    this.timer = setInterval(() => this.tick(), this.pollMs);
    sessionDiag("session.start.timer-created", { hotkey: this.activeHotkey.label, elapsedMs: Date.now() - startedAt });
  }

  stop(): void {
    if (!this.running) return;
    sessionDiag("session.stop.begin", { hotkey: this.activeHotkey.label });
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    UnregisterHotKey(null, HOTKEY_ID);
    this.uninstallKeyboardHook();
    this.triggerComboDown = false;
    this.triggerHeld = false;
    this.tickCount = 0;
    sessionDiag("session.stop.end", { hotkey: this.activeHotkey.label });
  }

  setHotkey(hotkey: string): void {
    const next = parseHotkeySpec(hotkey);
    if (!this.running) {
      this.activeHotkey = next;
      this.events?.onHotkeySwitched?.(next.label);
      return;
    }

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

  private installKeyboardHook(): void {
    if (this.keyboardHook) return;
    const startedAt = Date.now();
    this.keyboardHookCallback = registerLowLevelKeyboardProc((nCode, wParam, info) => this.handleKeyboardHook(nCode, wParam, info));
    sessionDiag("session.hook.callback-registered", { hotkey: this.activeHotkey.label, elapsedMs: Date.now() - startedAt });
    const module = GetModuleHandleW(null);
    sessionDiag("session.hook.module-resolved", { hotkey: this.activeHotkey.label, hasModule: Boolean(module), elapsedMs: Date.now() - startedAt });
    this.keyboardHook = SetWindowsHookExW(WH_KEYBOARD_LL, this.keyboardHookCallback, module, 0);
    if (!this.keyboardHook) {
      if (this.keyboardHookCallback) unregisterCallback(this.keyboardHookCallback);
      this.keyboardHookCallback = null;
      throw new Error(`SetWindowsHookExW failed for ${this.activeHotkey.label}`);
    }
    sessionDiag("session.hook.set", { hotkey: this.activeHotkey.label, elapsedMs: Date.now() - startedAt });
  }

  private uninstallKeyboardHook(): void {
    if (this.keyboardHook) {
      UnhookWindowsHookEx(this.keyboardHook);
      this.keyboardHook = null;
    }
    if (this.keyboardHookCallback) {
      unregisterCallback(this.keyboardHookCallback);
      this.keyboardHookCallback = null;
    }
  }

  private handleKeyboardHook(nCode: number, wParam: number, info: KbdLlHookStruct): number {
    if (nCode !== HC_ACTION) return CallNextHookEx(this.keyboardHook, nCode, wParam, info);
    if ((info.flags & LLKHF_INJECTED) !== 0) return CallNextHookEx(this.keyboardHook, nCode, wParam, info);
    if (!this.running) return CallNextHookEx(this.keyboardHook, nCode, wParam, info);

    const isKeyMessage = wParam === WM_KEYDOWN || wParam === WM_KEYUP || wParam === WM_SYSKEYDOWN || wParam === WM_SYSKEYUP;
    if (!isKeyMessage) return CallNextHookEx(this.keyboardHook, nCode, wParam, info);

    if (this.shouldSuppressVk(info.vkCode)) return 1;
    return CallNextHookEx(this.keyboardHook, nCode, wParam, info);
  }

  private shouldSuppressVk(vkCode: number): boolean {
    if (vkCode === this.activeHotkey.vk && this.areRequiredModifiersDown()) return true;
    if (!this.triggerHeld) return false;
    if (vkCode === this.activeHotkey.releaseVk) return true;
    if ((this.activeHotkey.modifiers & MOD_CONTROL) !== 0 && vkCode === VK_CONTROL) return true;
    if ((this.activeHotkey.modifiers & MOD_SHIFT) !== 0 && vkCode === VK_SHIFT) return true;
    if ((this.activeHotkey.modifiers & MOD_ALT) !== 0 && vkCode === VK_MENU) return true;
    if ((this.activeHotkey.modifiers & MOD_WIN) !== 0 && (vkCode === VK_LWIN || vkCode === VK_RWIN)) return true;
    return false;
  }

  private areRequiredModifiersDown(): boolean {
    const mods = this.activeHotkey.modifiers;
    if ((mods & MOD_CONTROL) !== 0 && !this.isKeyDown(VK_CONTROL)) return false;
    if ((mods & MOD_SHIFT) !== 0 && !this.isKeyDown(VK_SHIFT)) return false;
    if ((mods & MOD_ALT) !== 0 && !this.isKeyDown(VK_MENU)) return false;
    if ((mods & MOD_WIN) !== 0) {
      const lWinDown = this.isKeyDown(VK_LWIN);
      const rWinDown = this.isKeyDown(VK_RWIN);
      if (!lWinDown && !rWinDown) return false;
    }
    return true;
  }

  private tick(): void {
    if (!this.running) return;
    this.tickCount += 1;
    if (this.tickCount === 1) {
      sessionDiag("session.tick.first", { hotkey: this.activeHotkey.label });
    }

    let startedByMessage = false;
    const msg: WinMsg = {};
    // Only consume WM_HOTKEY here. Draining the full queue from Electron's main
    // thread steals framework messages and can stall window/web startup.
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
    if (!this.areRequiredModifiersDown()) return false;
    return (GetAsyncKeyState(this.activeHotkey.vk) & 0x8000) !== 0;
  }
}

import { HotkeySession } from "../services/nodehotkey/dist/session.js";
import { parseHotkeySpec, MOD_ALT, MOD_CONTROL, MOD_SHIFT, MOD_WIN } from "../services/nodehotkey/dist/hotkey-parser.js";
import {
  CallNextHookEx,
  GetAsyncKeyState,
  GetCursorPos,
  GetModuleHandleW,
  HC_ACTION,
  LLKHF_INJECTED,
  PeekMessageW,
  PM_REMOVE,
  RegisterHotKey,
  registerLowLevelKeyboardProc,
  SetWindowsHookExW,
  UnregisterHotKey,
  unregisterCallback,
  UnhookWindowsHookEx,
  VK_CONTROL,
  VK_LWIN,
  VK_MENU,
  VK_RWIN,
  VK_SHIFT,
  WH_KEYBOARD_LL,
  WM_HOTKEY,
  WM_KEYDOWN,
  WM_KEYUP,
  WM_SYSKEYDOWN,
  WM_SYSKEYUP,
  ensureDpiAwareness
} from "../services/nodehotkey/dist/win32-bindings.js";

const NEW_HOTKEY = "ctrl+shift+alt+d";
const OLD_HOTKEY = "ctrl+shift+alt+f";
const HOTKEY_ID = 1;

function log(label, phase, point) {
  const coords = point ? ` @ (${point.x}, ${point.y})` : "";
  console.log(`[${new Date().toISOString()}] ${label} ${phase}${coords}`);
}

class LegacyHotkeySession {
  constructor({ initialHotkey, pollMs = 16, label }) {
    if (process.platform !== "win32") throw new Error("Windows only");
    this.label = label;
    this.pollMs = pollMs;
    this.activeHotkey = parseHotkeySpec(initialHotkey);
    this.running = false;
    this.timer = null;
    this.triggerComboDown = false;
    this.triggerHeld = false;
    this.keyboardHook = null;
    this.keyboardHookCallback = null;
  }

  start() {
    if (this.running) return;
    ensureDpiAwareness();
    if (!RegisterHotKey(null, HOTKEY_ID, this.activeHotkey.modifiers, this.activeHotkey.vk)) {
      throw new Error(`RegisterHotKey failed for ${this.activeHotkey.label}`);
    }
    this.keyboardHookCallback = registerLowLevelKeyboardProc((nCode, wParam, info) => this.handleKeyboardHook(nCode, wParam, info));
    const module = GetModuleHandleW(null);
    this.keyboardHook = SetWindowsHookExW(WH_KEYBOARD_LL, this.keyboardHookCallback, module, 0);
    if (!this.keyboardHook) {
      unregisterCallback(this.keyboardHookCallback);
      this.keyboardHookCallback = null;
      UnregisterHotKey(null, HOTKEY_ID);
      throw new Error(`SetWindowsHookExW failed for ${this.activeHotkey.label}`);
    }
    this.running = true;
    this.timer = setInterval(() => this.tick(), this.pollMs);
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    UnregisterHotKey(null, HOTKEY_ID);
    if (this.keyboardHook) {
      UnhookWindowsHookEx(this.keyboardHook);
      this.keyboardHook = null;
    }
    if (this.keyboardHookCallback) {
      unregisterCallback(this.keyboardHookCallback);
      this.keyboardHookCallback = null;
    }
    this.triggerComboDown = false;
    this.triggerHeld = false;
  }

  getCursorPos() {
    const point = { x: 0, y: 0 };
    return GetCursorPos(point) ? point : null;
  }

  isKeyDown(vk) {
    return (GetAsyncKeyState(vk) & 0x8000) !== 0;
  }

  areRequiredModifiersDown() {
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

  shouldSuppressVk(vkCode) {
    if (vkCode === this.activeHotkey.vk && this.areRequiredModifiersDown()) return true;
    if (!this.triggerHeld) return false;
    if (vkCode === this.activeHotkey.releaseVk) return true;
    if ((this.activeHotkey.modifiers & MOD_CONTROL) !== 0 && vkCode === VK_CONTROL) return true;
    if ((this.activeHotkey.modifiers & MOD_SHIFT) !== 0 && vkCode === VK_SHIFT) return true;
    if ((this.activeHotkey.modifiers & MOD_ALT) !== 0 && vkCode === VK_MENU) return true;
    if ((this.activeHotkey.modifiers & MOD_WIN) !== 0 && (vkCode === VK_LWIN || vkCode === VK_RWIN)) return true;
    return false;
  }

  handleKeyboardHook(nCode, wParam, info) {
    if (nCode !== HC_ACTION) return CallNextHookEx(this.keyboardHook, nCode, wParam, info);
    if ((info.flags & LLKHF_INJECTED) !== 0) return CallNextHookEx(this.keyboardHook, nCode, wParam, info);
    if (!this.running) return CallNextHookEx(this.keyboardHook, nCode, wParam, info);

    const isKeyMessage = wParam === WM_KEYDOWN || wParam === WM_KEYUP || wParam === WM_SYSKEYDOWN || wParam === WM_SYSKEYUP;
    if (!isKeyMessage) return CallNextHookEx(this.keyboardHook, nCode, wParam, info);

    if (this.shouldSuppressVk(info.vkCode)) return 1;
    return CallNextHookEx(this.keyboardHook, nCode, wParam, info);
  }

  tick() {
    if (!this.running) return;

    let startedByMessage = false;
    const msg = {};
    while (PeekMessageW(msg, null, WM_HOTKEY, WM_HOTKEY, PM_REMOVE)) {
      if (msg.message === WM_HOTKEY && Number(msg.wParam) === HOTKEY_ID) {
        startedByMessage = true;
        if (!this.triggerHeld) {
          this.triggerHeld = true;
          log(this.label, "down", this.getCursorPos());
        }
      }
    }

    const comboDown = this.areRequiredModifiersDown() && this.isKeyDown(this.activeHotkey.vk);
    if (!startedByMessage && comboDown && !this.triggerComboDown && !this.triggerHeld) {
      this.triggerHeld = true;
      log(this.label, "down", this.getCursorPos());
    }

    if (this.triggerHeld && !this.isKeyDown(this.activeHotkey.releaseVk)) {
      this.triggerHeld = false;
      log(this.label, "up", this.getCursorPos());
    }

    this.triggerComboDown = comboDown;
  }
}

if (process.platform !== "win32") {
  throw new Error("This script is Windows-only.");
}

const currentSession = new HotkeySession({
  initialHotkey: NEW_HOTKEY,
  events: {
    onTriggerDown: (point) => log("new", "down", point),
    onTriggerUp: (point) => log("new", "up", point)
  }
});

const legacySession = new LegacyHotkeySession({
  initialHotkey: OLD_HOTKEY,
  label: "old"
});

currentSession.start();
legacySession.start();

console.log(`new hotkey: ${NEW_HOTKEY}`);
console.log(`old hotkey: ${OLD_HOTKEY}`);
console.log("Press Ctrl+C to exit.");

const shutdown = () => {
  currentSession.stop();
  legacySession.stop();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

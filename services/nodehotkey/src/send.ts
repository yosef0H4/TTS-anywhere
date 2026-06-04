import { MOD_ALT, MOD_CONTROL, MOD_SHIFT, MOD_WIN, parseKeyCombo } from "./hotkey-parser.js";
import type { MouseButton, MouseClickOptions, SendHotkeyOptions, SendMode, SendSpec } from "./types.js";
import {
  GetLastError,
  GetAsyncKeyState,
  GetCursorPos,
  INPUT_KEYBOARD,
  INPUT_SIZE,
  KEYEVENTF_EXTENDEDKEY,
  KEYEVENTF_KEYUP,
  KEYEVENTF_SCANCODE,
  MAPVK_VK_TO_VSC_EX,
  MapVirtualKeyW,
  MOUSEEVENTF_LEFTDOWN,
  MOUSEEVENTF_LEFTUP,
  MOUSEEVENTF_MIDDLEDOWN,
  MOUSEEVENTF_MIDDLEUP,
  MOUSEEVENTF_RIGHTDOWN,
  MOUSEEVENTF_RIGHTUP,
  PostMessageW,
  SendInput,
  SetCursorPos,
  VK_CONTROL,
  VK_RWIN,
  VK_LWIN,
  VK_MENU,
  VK_SHIFT,
  WM_KEYDOWN,
  WM_KEYUP,
  WM_SYSKEYDOWN,
  WM_SYSKEYUP,
  mouse_event
} from "./win32-bindings.js";

type KeyboardInput = {
  type: number;
  _pad: number;
  _unionPad: number;
  ki: {
    wVk: number;
    wScan: number;
    dwFlags: number;
    time: number;
    dwExtraInfo: number;
  };
};

type KeyDescriptor = {
  vk: number;
  scanCode: number;
  extended: boolean;
};

const MOUSE_SPEC_ALIASES = new Map<string, MouseButton>([
  ["click", "left"],
  ["leftclick", "left"],
  ["lclick", "left"],
  ["rightclick", "right"],
  ["rclick", "right"],
  ["middleclick", "middle"],
  ["mclick", "middle"]
]);

function isExtendedVk(vk: number): boolean {
  return (
    vk === 0x25 || // left
    vk === 0x26 || // up
    vk === 0x27 || // right
    vk === 0x28 || // down
    vk === 0x2d || // insert
    vk === 0x2e || // delete
    vk === 0x24 || // home
    vk === 0x23 || // end
    vk === 0x21 || // page up
    vk === 0x22 // page down
  );
}

function getKeyDescriptor(vk: number): KeyDescriptor {
  const mapped = MapVirtualKeyW(vk, MAPVK_VK_TO_VSC_EX);
  return {
    vk,
    scanCode: mapped ? (mapped & 0xff) : 0,
    extended: isExtendedVk(vk) || (mapped & 0xff00) !== 0
  };
}

function keyEvent(descriptor: KeyDescriptor, keyUp: boolean, mode: SendMode): KeyboardInput {
  let flags = keyUp ? KEYEVENTF_KEYUP : 0;
  if (mode === "scancode" && descriptor.scanCode !== 0) {
    flags |= KEYEVENTF_SCANCODE;
    if (descriptor.extended) flags |= KEYEVENTF_EXTENDEDKEY;
    return {
      type: INPUT_KEYBOARD,
      _pad: 0,
      _unionPad: 0,
      ki: {
        wVk: 0,
        wScan: descriptor.scanCode,
        dwFlags: flags,
        time: 0,
        dwExtraInfo: 0
      }
    };
  }
  if (descriptor.extended) flags |= KEYEVENTF_EXTENDEDKEY;
  return {
    type: INPUT_KEYBOARD,
    _pad: 0,
    _unionPad: 0,
    ki: {
      wVk: descriptor.vk,
      wScan: 0,
      dwFlags: flags,
      time: 0,
      dwExtraInfo: 0
    }
  };
}

function modifierVks(modifiers: number): number[] {
  const vks: number[] = [];
  if ((modifiers & MOD_CONTROL) !== 0) vks.push(VK_CONTROL);
  if ((modifiers & MOD_SHIFT) !== 0) vks.push(VK_SHIFT);
  if ((modifiers & MOD_ALT) !== 0) vks.push(VK_MENU);
  if ((modifiers & MOD_WIN) !== 0) vks.push(VK_LWIN);
  return vks;
}

function isVkDown(vk: number): boolean {
  return (GetAsyncKeyState(vk) & 0x8000) !== 0;
}

function activeModifierMask(): number {
  let mask = 0;
  if (isVkDown(VK_CONTROL)) mask |= MOD_CONTROL;
  if (isVkDown(VK_SHIFT)) mask |= MOD_SHIFT;
  if (isVkDown(VK_MENU)) mask |= MOD_ALT;
  if (isVkDown(VK_LWIN) || isVkDown(VK_RWIN)) mask |= MOD_WIN;
  return mask;
}

export function parseSendSpec(input: string): SendSpec {
  const normalized = String(input).trim().toLowerCase();
  if (!normalized) throw new Error("Send hotkey string is empty");
  const compact = normalized.replace(/[\s_-]+/g, "");
  const mouseButton = MOUSE_SPEC_ALIASES.get(compact);
  if (mouseButton) {
    return {
      kind: "mouse",
      label: normalized,
      button: mouseButton
    };
  }

  const combo = parseKeyCombo(normalized, {
    emptyMessage: "Send hotkey string is empty",
    minimumTokenCount: 1,
    minimumTokenMessage: "Send hotkey string is empty",
    multipleKeysMessage: (left, right) => `Send hotkey has multiple keys: "${left}" and "${right}"`,
    requireModifier: false,
    missingKeyMessage: "Send hotkey must include a base key",
    unsupportedKeyMessage: (token) => `Unsupported send key token: "${token}"`
  });

  return {
    kind: "keyboard",
    label: combo.label,
    modifiers: combo.modifiers,
    vk: combo.vk
  };
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function keyboardMessageFor(vk: number, keyUp: boolean, altContext: boolean): number {
  const useSystemMessage = vk === VK_MENU || altContext;
  if (useSystemMessage) {
    return keyUp ? WM_SYSKEYUP : WM_SYSKEYDOWN;
  }
  return keyUp ? WM_KEYUP : WM_KEYDOWN;
}

function keyboardMessageLParam(descriptor: KeyDescriptor, keyUp: boolean, altContext: boolean): number {
  let lParam = 1 | ((descriptor.scanCode & 0xff) << 16);
  if (descriptor.extended) lParam |= 1 << 24;
  if (altContext) lParam |= 1 << 29;
  if (keyUp) lParam |= (1 << 30) | (1 << 31);
  return lParam >>> 0;
}

function postKeyboardMessage(targetWindow: unknown, descriptor: KeyDescriptor, keyUp: boolean, altContext: boolean): void {
  const ok = PostMessageW(
    targetWindow,
    keyboardMessageFor(descriptor.vk, keyUp, altContext),
    descriptor.vk,
    keyboardMessageLParam(descriptor, keyUp, altContext)
  );
  if (!ok) {
    throw new Error(`PostMessageW failed (lastError=${GetLastError()})`);
  }
}

async function waitForExtraModifiersToRelease(specModifiers: number, options: SendHotkeyOptions): Promise<number> {
  const timeoutMs = Math.max(0, Math.floor(options.modifierReleaseSettleTimeoutMs ?? 250));
  const pollMs = Math.max(1, Math.floor(options.modifierReleaseSettlePollMs ?? 8));
  let currentMask = activeModifierMask();

  if (timeoutMs === 0 || (currentMask & ~specModifiers) === 0) {
    return currentMask;
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    await sleepMs(pollMs);
    currentMask = activeModifierMask();
    if ((currentMask & ~specModifiers) === 0) {
      return currentMask;
    }
  }

  return currentMask;
}

function getCursorPos(): { x: number; y: number } {
  const point = { x: 0, y: 0 };
  if (!GetCursorPos(point)) {
    throw new Error(`GetCursorPos failed (lastError=${GetLastError()})`);
  }
  return point;
}

function mouseButtonFlags(button: MouseButton): { down: number; up: number } {
  switch (button) {
    case "left":
      return { down: MOUSEEVENTF_LEFTDOWN, up: MOUSEEVENTF_LEFTUP };
    case "right":
      return { down: MOUSEEVENTF_RIGHTDOWN, up: MOUSEEVENTF_RIGHTUP };
    case "middle":
      return { down: MOUSEEVENTF_MIDDLEDOWN, up: MOUSEEVENTF_MIDDLEUP };
  }
}

export async function sendMouseClickAtPoint(
  button: MouseButton,
  point: { x: number; y: number },
  options: MouseClickOptions = {}
): Promise<void> {
  if (process.platform !== "win32") throw new Error("sendMouseClickAtPoint is Windows-only");

  const targetX = Math.round(point.x);
  const targetY = Math.round(point.y);
  const original = options.restoreCursor ? getCursorPos() : null;
  const clickCount = Math.max(1, Math.floor(options.clickCount ?? 1));
  const pressDurationMs = Math.max(0, Math.floor(options.pressDurationMs ?? 0));
  const interClickDelayMs = Math.max(0, Math.floor(options.interClickDelayMs ?? 24));
  const flags = mouseButtonFlags(button);

  if (!SetCursorPos(targetX, targetY)) {
    throw new Error(`SetCursorPos failed (lastError=${GetLastError()})`);
  }

  try {
    for (let index = 0; index < clickCount; index += 1) {
      mouse_event(flags.down, 0, 0, 0, 0);
      if (pressDurationMs > 0) {
        await sleepMs(pressDurationMs);
      }
      mouse_event(flags.up, 0, 0, 0, 0);
      if (index + 1 < clickCount && interClickDelayMs > 0) {
        await sleepMs(interClickDelayMs);
      }
    }
  } finally {
    if (original && !SetCursorPos(original.x, original.y)) {
      throw new Error(`SetCursorPos failed while restoring cursor (lastError=${GetLastError()})`);
    }
  }
}

export async function sendHotkey(input: string, options: SendHotkeyOptions = {}): Promise<void> {
  if (process.platform !== "win32") throw new Error("sendHotkey is Windows-only");

  const spec = parseSendSpec(input);
  if (spec.kind === "mouse") {
    throw new Error(`Mouse action "${spec.label}" requires sendMouseClickAtPoint`);
  }
  const downModifiers = modifierVks(spec.modifiers);
  const events: KeyboardInput[] = [];
  const blind = options.blind ?? false;
  const mode = options.mode ?? "vk";

  const currentlyDownMods = blind ? activeModifierMask() : await waitForExtraModifiersToRelease(spec.modifiers, options);
  const modsToTemporarilyRelease = blind ? 0 : (currentlyDownMods & ~spec.modifiers);

  if ((modsToTemporarilyRelease & MOD_WIN) !== 0) {
    if (isVkDown(VK_LWIN)) events.push(keyEvent(getKeyDescriptor(VK_LWIN), true, mode));
    if (isVkDown(VK_RWIN)) events.push(keyEvent(getKeyDescriptor(VK_RWIN), true, mode));
  }
  if ((modsToTemporarilyRelease & MOD_ALT) !== 0) events.push(keyEvent(getKeyDescriptor(VK_MENU), true, mode));
  if ((modsToTemporarilyRelease & MOD_SHIFT) !== 0) events.push(keyEvent(getKeyDescriptor(VK_SHIFT), true, mode));
  if ((modsToTemporarilyRelease & MOD_CONTROL) !== 0) events.push(keyEvent(getKeyDescriptor(VK_CONTROL), true, mode));

  for (const vk of downModifiers) events.push(keyEvent(getKeyDescriptor(vk), false, mode));
  events.push(keyEvent(getKeyDescriptor(spec.vk), false, mode));

  const pressDurationMs = Math.max(0, Math.floor(options.pressDurationMs ?? 0));
  if (pressDurationMs > 0) {
    const inserted = SendInput(events.length, events, INPUT_SIZE);
    if (inserted !== events.length) {
      throw new Error(`SendInput inserted ${inserted}/${events.length} key-down events (lastError=${GetLastError()})`);
    }
    await sleepMs(pressDurationMs);
    events.length = 0;
  }

  events.push(keyEvent(getKeyDescriptor(spec.vk), true, mode));
  for (let i = downModifiers.length - 1; i >= 0; i -= 1) {
    events.push(keyEvent(getKeyDescriptor(downModifiers[i] as number), true, mode));
  }
  if ((modsToTemporarilyRelease & MOD_CONTROL) !== 0) events.push(keyEvent(getKeyDescriptor(VK_CONTROL), false, mode));
  if ((modsToTemporarilyRelease & MOD_SHIFT) !== 0) events.push(keyEvent(getKeyDescriptor(VK_SHIFT), false, mode));
  if ((modsToTemporarilyRelease & MOD_ALT) !== 0) events.push(keyEvent(getKeyDescriptor(VK_MENU), false, mode));
  if ((modsToTemporarilyRelease & MOD_WIN) !== 0) {
    events.push(keyEvent(getKeyDescriptor(VK_LWIN), false, mode));
  }

  const inserted = SendInput(events.length, events, INPUT_SIZE);
  if (inserted !== events.length) {
    throw new Error(`SendInput inserted ${inserted}/${events.length} events (lastError=${GetLastError()})`);
  }
}

export async function sendHotkeyToWindow(targetWindow: unknown, input: string, options: SendHotkeyOptions = {}): Promise<void> {
  if (process.platform !== "win32") throw new Error("sendHotkeyToWindow is Windows-only");
  if (!targetWindow) throw new Error("Target window handle is required");

  const spec = parseSendSpec(input);
  if (spec.kind === "mouse") {
    throw new Error(`Mouse action "${spec.label}" is not supported for window-target posting`);
  }
  const downModifiers = modifierVks(spec.modifiers);
  const specDescriptor = getKeyDescriptor(spec.vk);

  for (const vk of downModifiers) {
    const descriptor = getKeyDescriptor(vk);
    postKeyboardMessage(targetWindow, descriptor, false, false);
  }
  postKeyboardMessage(targetWindow, specDescriptor, false, (spec.modifiers & MOD_ALT) !== 0);

  const pressDurationMs = Math.max(0, Math.floor(options.pressDurationMs ?? 0));
  if (pressDurationMs > 0) {
    await sleepMs(pressDurationMs);
  }

  postKeyboardMessage(targetWindow, specDescriptor, true, (spec.modifiers & MOD_ALT) !== 0);
  for (let i = downModifiers.length - 1; i >= 0; i -= 1) {
    const descriptor = getKeyDescriptor(downModifiers[i] as number);
    postKeyboardMessage(targetWindow, descriptor, true, false);
  }
}

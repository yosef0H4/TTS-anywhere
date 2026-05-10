import { MOD_ALT, MOD_CONTROL, MOD_SHIFT, MOD_WIN, TOKEN_TO_MOD, keyTokenToVk } from "./hotkey-parser.js";
import type { SendHotkeyOptions, SendMode, SendSpec } from "./types.js";
import {
  GetLastError,
  GetAsyncKeyState,
  INPUT_KEYBOARD,
  INPUT_SIZE,
  KEYEVENTF_EXTENDEDKEY,
  KEYEVENTF_KEYUP,
  KEYEVENTF_SCANCODE,
  MAPVK_VK_TO_VSC_EX,
  MapVirtualKeyW,
  SendInput,
  VK_CONTROL,
  VK_RWIN,
  VK_LWIN,
  VK_MENU,
  VK_SHIFT
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

  const tokens = normalized
    .split("+")
    .map((t) => t.trim())
    .filter(Boolean);
  if (tokens.length < 1) throw new Error("Send hotkey string is empty");

  let modifiers = 0;
  let keyToken: string | null = null;
  for (const token of tokens) {
    const mod = TOKEN_TO_MOD.get(token);
    if (mod) {
      modifiers |= mod;
      continue;
    }
    if (keyToken) throw new Error(`Send hotkey has multiple keys: "${keyToken}" and "${token}"`);
    keyToken = token;
  }

  if (!keyToken) throw new Error("Send hotkey must include a base key");
  const vk = keyTokenToVk(keyToken);
  if (vk == null) throw new Error(`Unsupported send key token: "${keyToken}"`);

  return {
    label: tokens.join("+"),
    modifiers,
    vk
  };
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

export async function sendHotkey(input: string, options: SendHotkeyOptions = {}): Promise<void> {
  if (process.platform !== "win32") throw new Error("sendHotkey is Windows-only");

  const spec = parseSendSpec(input);
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

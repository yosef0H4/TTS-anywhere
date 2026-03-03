import type { HotkeySpec } from "./types.js";

export const MOD_ALT = 0x0001;
export const MOD_CONTROL = 0x0002;
export const MOD_SHIFT = 0x0004;
export const MOD_WIN = 0x0008;
export const MOD_NOREPEAT = 0x4000;

const TOKEN_TO_MOD = new Map<string, number>([
  ["ctrl", MOD_CONTROL],
  ["control", MOD_CONTROL],
  ["shift", MOD_SHIFT],
  ["alt", MOD_ALT],
  ["win", MOD_WIN],
  ["meta", MOD_WIN]
]);

const KEY_ALIASES = new Map<string, number>([
  ["esc", 0x1b],
  ["escape", 0x1b],
  ["enter", 0x0d],
  ["return", 0x0d],
  ["space", 0x20],
  ["tab", 0x09],
  ["up", 0x26],
  ["down", 0x28],
  ["left", 0x25],
  ["right", 0x27]
]);

function keyTokenToVk(token: string): number | null {
  if (KEY_ALIASES.has(token)) return KEY_ALIASES.get(token) ?? null;
  if (/^[a-z]$/.test(token)) return token.toUpperCase().charCodeAt(0);
  if (/^[0-9]$/.test(token)) return token.charCodeAt(0);
  const fn = token.match(/^f([1-9]|1[0-9]|2[0-4])$/);
  if (fn) return 0x70 + Number(fn[1]) - 1;
  return null;
}

export function parseHotkeySpec(input: string): HotkeySpec {
  const normalized = String(input).trim().toLowerCase();
  if (!normalized) throw new Error("Hotkey string is empty");

  const tokens = normalized
    .split("+")
    .map((t) => t.trim())
    .filter(Boolean);

  if (tokens.length < 2) throw new Error("Hotkey must include at least one modifier and one key");

  let modifiers = 0;
  let keyToken: string | null = null;

  for (const token of tokens) {
    const mod = TOKEN_TO_MOD.get(token);
    if (mod) {
      modifiers |= mod;
      continue;
    }
    if (keyToken) throw new Error(`Hotkey contains multiple non-modifier keys: \"${keyToken}\" and \"${token}\"`);
    keyToken = token;
  }

  if (!modifiers) throw new Error("Hotkey must include at least one modifier");
  if (!keyToken) throw new Error("Hotkey must include a base key");

  const vk = keyTokenToVk(keyToken);
  if (vk == null) throw new Error(`Unsupported key token: \"${keyToken}\"`);

  return {
    label: tokens.join("+"),
    modifiers: modifiers | MOD_NOREPEAT,
    vk,
    releaseVk: vk
  };
}

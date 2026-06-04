import type { HotkeySpec } from "./types.js";

export const MOD_ALT = 0x0001;
export const MOD_CONTROL = 0x0002;
export const MOD_SHIFT = 0x0004;
export const MOD_WIN = 0x0008;
export const MOD_NOREPEAT = 0x4000;

export const TOKEN_TO_MOD = new Map<string, number>([
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
  ["backspace", 0x08],
  ["space", 0x20],
  ["tab", 0x09],
  ["insert", 0x2d],
  ["delete", 0x2e],
  ["home", 0x24],
  ["end", 0x23],
  ["pageup", 0x21],
  ["pgup", 0x21],
  ["pagedown", 0x22],
  ["pgdn", 0x22],
  ["up", 0x26],
  ["down", 0x28],
  ["left", 0x25],
  ["right", 0x27]
]);

export function keyTokenToVk(token: string): number | null {
  if (KEY_ALIASES.has(token)) return KEY_ALIASES.get(token) ?? null;
  if (/^[a-z]$/.test(token)) return token.toUpperCase().charCodeAt(0);
  if (/^[0-9]$/.test(token)) return token.charCodeAt(0);
  const fn = token.match(/^f([1-9]|1[0-9]|2[0-4])$/);
  if (fn) return 0x70 + Number(fn[1]) - 1;
  return null;
}

export interface ParsedKeyCombo {
  label: string;
  modifiers: number;
  keyToken: string;
  vk: number;
}

export function parseKeyCombo(input: string, options: {
  emptyMessage: string;
  minimumTokenCount: number;
  minimumTokenMessage: string;
  multipleKeysMessage: (left: string, right: string) => string;
  requireModifier: boolean;
  missingModifierMessage?: string;
  missingKeyMessage: string;
  unsupportedKeyMessage: (token: string) => string;
}): ParsedKeyCombo {
  const normalized = String(input).trim().toLowerCase();
  if (!normalized) throw new Error(options.emptyMessage);

  const tokens = normalized
    .split("+")
    .map((t) => t.trim())
    .filter(Boolean);

  if (tokens.length < options.minimumTokenCount) throw new Error(options.minimumTokenMessage);

  let modifiers = 0;
  let keyToken: string | null = null;

  for (const token of tokens) {
    const mod = TOKEN_TO_MOD.get(token);
    if (mod) {
      modifiers |= mod;
      continue;
    }
    if (keyToken) throw new Error(options.multipleKeysMessage(keyToken, token));
    keyToken = token;
  }

  if (options.requireModifier && !modifiers) {
    throw new Error(options.missingModifierMessage ?? "Hotkey must include at least one modifier");
  }
  if (!keyToken) throw new Error(options.missingKeyMessage);

  const vk = keyTokenToVk(keyToken);
  if (vk == null) throw new Error(options.unsupportedKeyMessage(keyToken));

  return { label: tokens.join("+"), modifiers, keyToken, vk };
}

export function parseHotkeySpec(input: string): HotkeySpec {
  const combo = parseKeyCombo(input, {
    emptyMessage: "Hotkey string is empty",
    minimumTokenCount: 2,
    minimumTokenMessage: "Hotkey must include at least one modifier and one key",
    multipleKeysMessage: (left, right) => `Hotkey contains multiple non-modifier keys: \"${left}\" and \"${right}\"`,
    requireModifier: true,
    missingModifierMessage: "Hotkey must include at least one modifier",
    missingKeyMessage: "Hotkey must include a base key",
    unsupportedKeyMessage: (token) => `Unsupported key token: \"${token}\"`
  });

  return {
    label: combo.label,
    modifiers: combo.modifiers | MOD_NOREPEAT,
    vk: combo.vk,
    releaseVk: combo.vk
  };
}

import type { Chunk } from "../models/types";

export type TextEditKind = "no_effect" | "append_only" | "tail_subtract_only" | "mutated_existing";

export function stripNonEffectiveTrailing(text: string): string {
  return text.replace(/[ \t\r\n]+$/g, "");
}

export function classifyEffectiveTextEdit(previousText: string, nextText: string): TextEditKind {
  const prev = stripNonEffectiveTrailing(previousText);
  const next = stripNonEffectiveTrailing(nextText);
  if (prev === next) return "no_effect";
  if (next.startsWith(prev)) return "append_only";
  if (prev.startsWith(next)) return "tail_subtract_only";
  return "mutated_existing";
}

export function findChunkIndexAtOrAfterChar(chunks: Chunk[], charOffset: number): number {
  if (chunks.length === 0) return 0;
  const clamped = Math.max(0, Math.floor(charOffset));
  const containing = chunks.find((chunk) => clamped >= chunk.startChar && clamped < chunk.endChar);
  if (containing) return containing.index;
  const next = chunks.find((chunk) => chunk.startChar >= clamped);
  if (next) return next.index;
  const last = chunks[chunks.length - 1];
  return last?.index ?? 0;
}

export function shouldHardResetTailSubtract(activeEndChar: number, preservedChars: number): boolean {
  return preservedChars < activeEndChar;
}


import type { ReadingTimeline } from "../models/types";

export function cleanTextForTts(input: string): string {
  // Match PiperAnywhere behavior: strip decorative symbols/emojis, normalize whitespace,
  // and cap excessive terminal punctuation.
  // First convert newlines to spaces so they become word boundaries
  let cleaned = input.replace(/[\r\n]+/g, " ");
  cleaned = cleaned.replace(/[^\p{L}\p{N}\p{P}\p{Z}]/gu, "");
  cleaned = cleaned.replace(/\s+/g, " ").trim();
  cleaned = cleaned.replace(/([.!?]){4,}/g, "$1$1$1");
  return cleaned;
}

export function findChunkIndexByTime(timeline: ReadingTimeline, timeMs: number): number {
  if (timeline.chunks.length === 0) return -1;
  const clamped = Math.max(0, timeMs);
  const found = timeline.chunks.find((chunk) => clamped >= chunk.startMs && clamped < chunk.endMs);
  if (found) return found.index;
  const lastChunk = timeline.chunks[timeline.chunks.length - 1];
  return lastChunk ? lastChunk.index : -1;
}

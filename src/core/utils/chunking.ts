import type { ReadingTimeline } from "../models/types";

export function cleanTextForTts(input: string): string {
  // Match PiperAnywhere behavior: strip decorative symbols/emojis, normalize whitespace,
  // and cap excessive terminal punctuation.
  // Keep line breaks available for chunking while normalizing other whitespace.
  let cleaned = input.replace(/\r\n?/g, "\n");
  cleaned = cleaned.replace(/[\*「」『』【】《》〈〉]/g, "");
  cleaned = cleaned.replace(/_+/g, " ");
  cleaned = cleaned.replace(/[^\p{L}\p{N}\p{P}\p{Z}\n]/gu, "");
  cleaned = cleaned.replace(/[^\S\n]+/g, " ");
  cleaned = cleaned.replace(/ *\n+ */g, "\n").trim();
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

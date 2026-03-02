import type { Chunk, ReadingTimeline } from "../models/types";

export function normalizeText(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

export function splitIntoChunks(text: string, chunkSize: number): string[] {
  const normalized = normalizeText(text);
  if (!normalized) return [];
  const safeChunkSize = Math.max(1, Math.floor(chunkSize));
  const words = normalized.split(" ");
  const out: string[] = [];
  for (let i = 0; i < words.length; i += safeChunkSize) {
    out.push(words.slice(i, i + safeChunkSize).join(" "));
  }
  return out;
}

export function buildReadingTimeline(text: string, chunkSize: number, wpm: number): ReadingTimeline {
  const chunksText = splitIntoChunks(text, chunkSize);
  const safeWpm = Math.max(1, wpm);
  const msPerWord = 60000 / safeWpm;

  let cursor = 0;
  const chunks: Chunk[] = chunksText.map((chunkText, index) => {
    const wordsInChunk = chunkText.split(" ").filter(Boolean).length;
    const duration = Math.round(wordsInChunk * msPerWord);
    const startMs = cursor;
    const endMs = startMs + duration;
    cursor = endMs;
    return { index, text: chunkText, startMs, endMs };
  });

  return { chunks, durationMs: cursor };
}

export function findChunkIndexByTime(timeline: ReadingTimeline, timeMs: number): number {
  if (timeline.chunks.length === 0) return -1;
  const clamped = Math.max(0, timeMs);
  const found = timeline.chunks.find((chunk) => clamped >= chunk.startMs && clamped < chunk.endMs);
  if (found) return found.index;
  const lastChunk = timeline.chunks[timeline.chunks.length - 1];
  return lastChunk ? lastChunk.index : -1;
}

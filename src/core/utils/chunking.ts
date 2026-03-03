import type { Chunk, ReadingTimeline } from "../models/types";

export function normalizeText(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function splitSentenceLikeUnits(text: string): string[] {
  const prepared = text.replace(/\r\n/g, "\n");
  return prepared
    .split(/(?<=[.!?؟])\s+|\n+/u)
    .map((part) => part.trim())
    .filter(Boolean);
}

function countWords(text: string): number {
  return normalizeText(text).split(" ").filter(Boolean).length;
}

function rebalanceUnits(units: string[], minWordsPerChunk: number, maxWordsPerChunk: number): string[] {
  const safeMin = Math.max(1, Math.floor(minWordsPerChunk));
  const safeMax = Math.max(safeMin, Math.floor(maxWordsPerChunk));
  const queue = [...units];
  const result: string[] = [];

  let i = 0;
  while (i < queue.length) {
    let current = normalizeText(queue[i] ?? "");
    if (!current) {
      i += 1;
      continue;
    }

    let words = countWords(current);
    if (words > safeMax) {
      const tokens = current.split(" ");
      for (let start = 0; start < tokens.length; start += safeMax) {
        result.push(tokens.slice(start, start + safeMax).join(" "));
      }
      i += 1;
      continue;
    }

    while (words < safeMin && i + 1 < queue.length) {
      const next = normalizeText(queue[i + 1] ?? "");
      if (!next) {
        i += 1;
        continue;
      }
      const merged = `${current} ${next}`.trim();
      const mergedWords = countWords(merged);
      if (mergedWords > safeMax) break;
      current = merged;
      words = mergedWords;
      i += 1;
    }

    result.push(current);
    i += 1;
  }

  return result;
}

export function splitIntoChunks(text: string, minWordsPerChunk: number, maxWordsPerChunk: number): string[] {
  if (!normalizeText(text)) return [];
  return rebalanceUnits(splitSentenceLikeUnits(text), minWordsPerChunk, maxWordsPerChunk);
}

export function buildReadingTimeline(
  text: string,
  minWordsPerChunk: number,
  maxWordsPerChunk: number,
  wpm: number
): ReadingTimeline {
  const chunksText = splitIntoChunks(text, minWordsPerChunk, maxWordsPerChunk);
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

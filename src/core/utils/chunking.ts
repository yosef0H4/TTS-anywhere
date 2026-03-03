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
  const expanded: string[] = [];

  for (const unit of units) {
    const current = normalizeText(unit);
    if (!current) continue;
    const words = countWords(current);
    if (words <= safeMax) {
      expanded.push(current);
      continue;
    }
    const tokens = current.split(" ");
    for (let start = 0; start < tokens.length; start += safeMax) {
      expanded.push(tokens.slice(start, start + safeMax).join(" "));
    }
  }

  const chunks = [...expanded];
  let i = 0;
  while (i < chunks.length) {
    const current = normalizeText(chunks[i] ?? "");
    if (!current) {
      chunks.splice(i, 1);
      continue;
    }

    const currentWords = countWords(current);
    if (currentWords >= safeMin) {
      chunks[i] = current;
      i += 1;
      continue;
    }

    // Prefer forward merge for reading flow continuity.
    if (i + 1 < chunks.length) {
      const next = normalizeText(chunks[i + 1] ?? "");
      if (next) {
        const forwardMerged = `${current} ${next}`.trim();
        if (countWords(forwardMerged) <= safeMax) {
          chunks[i] = forwardMerged;
          chunks.splice(i + 1, 1);
          continue;
        }
      }
    }

    // Fallback to backward merge to avoid tiny isolated chunks.
    if (i > 0) {
      const prev = normalizeText(chunks[i - 1] ?? "");
      if (prev) {
        const backwardMerged = `${prev} ${current}`.trim();
        if (countWords(backwardMerged) <= safeMax) {
          chunks[i - 1] = backwardMerged;
          chunks.splice(i, 1);
          i = Math.max(0, i - 1);
          continue;
        }
      }
    }

    chunks[i] = current;
    i += 1;
  }

  return chunks;
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

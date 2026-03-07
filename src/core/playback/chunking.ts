import type { Chunk, ReadingTimeline } from "../models/types";

export type ChunkStatus = "dirty" | "queued" | "fetching" | "ready" | "failed" | "stale" | "playing";

export interface ChunkDraft {
  text: string;
  start: number;
  end: number;
  wordCount: number;
  finalized: boolean;
}

export interface ChunkRecord extends Chunk {
  wordCount: number;
  finalized: boolean;
  id: string;
  revision: number;
  status: ChunkStatus;
  audioUrl?: string;
}

export interface ReconcileParams {
  nextText: string;
  previousChunks: ChunkRecord[];
  minWordsPerChunk: number;
  maxWordsPerChunk: number;
  wpmBase: number;
  activeChunkId?: string;
  speakingChunkId?: string;
  speakingRevision?: number;
  finalizeTail?: boolean;
}

export interface ReconcileResult {
  chunks: ChunkRecord[];
  activeChunkId?: string;
  dirtyChunkIds: string[];
}

interface ReconciledDraft extends ChunkDraft {
  id: string;
  revision: number;
  status: ChunkStatus;
  audioUrl?: string;
}

interface Token {
  text: string;
  start: number;
  end: number;
  isWord: boolean;
  hasStop: boolean;
}

const STOP_REGEX = /[.!?;:)]$/;
const WORD_PATTERN = /[A-Za-z0-9]+(?:'[A-Za-z0-9]+)*/;
const WORD_REGEX = /[A-Za-z0-9]+(?:'[A-Za-z0-9]+)*/g;

function tokenize(text: string): Token[] {
  const matches = text.matchAll(/\S+/g);
  return Array.from(matches, (match) => {
    const token = match[0];
    const start = match.index ?? 0;
    return {
      text: token,
      start,
      end: start + token.length,
      isWord: WORD_PATTERN.test(token),
      hasStop: STOP_REGEX.test(token),
    };
  });
}

function countWords(text: string): number {
  return text.match(WORD_REGEX)?.length ?? 0;
}

function normalize(text: string): string {
  return (text.toLowerCase().match(WORD_REGEX) ?? []).join(' ');
}

function wordSet(text: string): Set<string> {
  return new Set(text.toLowerCase().match(WORD_REGEX) ?? []);
}

function nextId(previousChunks: ChunkRecord[]): () => string {
  const maxId = previousChunks.reduce((max, chunk) => {
    const numeric = Number(chunk.id.replace(/^chunk-/, ''));
    return Number.isFinite(numeric) ? Math.max(max, numeric) : max;
  }, 0);

  let current = maxId;
  return () => {
    current += 1;
    return `chunk-${String(current).padStart(4, '0')}`;
  };
}

function similarityScore(previous: ChunkRecord, next: ChunkDraft, nextIndex: number): number {
  const previousNormalized = normalize(previous.text);
  const nextNormalized = normalize(next.text);
  if (!previousNormalized || !nextNormalized) {
    return 0;
  }

  if (previousNormalized === nextNormalized) {
    return 10;
  }

  const prevWords = wordSet(previous.text);
  const nextWords = wordSet(next.text);
  let overlap = 0;
  for (const word of prevWords) {
    if (nextWords.has(word)) {
      overlap += 1;
    }
  }

  const union = prevWords.size + nextWords.size - overlap;
  const jaccard = union === 0 ? 0 : overlap / union;
  const distancePenalty = Math.abs(nextIndex - previous.startChar / 1000) * 0.02;
  const sizePenalty = Math.abs(previous.wordCount - next.wordCount) * 0.03;
  return jaccard - distancePenalty - sizePenalty;
}

function resolveFallbackActiveChunkId(
  previousChunks: ChunkRecord[],
  nextChunks: ReconciledDraft[],
  activeChunkId?: string,
): string | undefined {
  if (!activeChunkId || nextChunks.some((chunk) => chunk.id === activeChunkId)) {
    return activeChunkId;
  }

  const previousActiveChunk = previousChunks.find((chunk) => chunk.id === activeChunkId);
  if (!previousActiveChunk) {
    return nextChunks[0]?.id;
  }

  let bestMatch: ReconciledDraft | undefined;
  let bestScore = 0.25;

  for (const [index, nextChunk] of nextChunks.entries()) {
    const score = similarityScore(previousActiveChunk, nextChunk, index);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = nextChunk;
    }
  }

  if (bestMatch) {
    return bestMatch.id;
  }

  const previousIndex = previousChunks.findIndex((chunk) => chunk.id === activeChunkId);
  return nextChunks[Math.min(Math.max(previousIndex, 0), Math.max(nextChunks.length - 1, 0))]?.id;
}

export function chunkText(text: string, minWordsPerChunk = 5, maxWordsPerChunk = 25, finalizeTail = false): ChunkDraft[] {
  const trimmedText = text.trim();
  if (!trimmedText) {
    return [];
  }

  const tokens = tokenize(text);
  if (tokens.length === 0) {
    return [];
  }

  const chunks: ChunkDraft[] = [];
  let chunkStartTokenIndex = 0;
  let wordCount = 0;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    if (token.isWord) {
      wordCount += 1;
    }

    const shouldFinalizeByStop = token.hasStop && wordCount > Math.max(1, minWordsPerChunk - 1);
    const shouldFinalizeByLimit = wordCount >= Math.max(minWordsPerChunk, maxWordsPerChunk);

    if (!shouldFinalizeByStop && !shouldFinalizeByLimit) {
      continue;
    }

    const startToken = tokens[chunkStartTokenIndex];
    if (!startToken) continue;
    const start = startToken.start;
    const end = token.end;
    chunks.push({
      text: text.slice(start, end).trim(),
      start,
      end,
      wordCount,
      finalized: true,
    });

    chunkStartTokenIndex = index + 1;
    wordCount = 0;
  }

  if (chunkStartTokenIndex < tokens.length) {
    const startToken = tokens[chunkStartTokenIndex];
    const lastToken = tokens[tokens.length - 1];
    if (!startToken || !lastToken) {
      return chunks;
    }
    const start = startToken.start;
    const end = lastToken.end;
    const chunkTextValue = text.slice(start, end).trim();
    if (chunkTextValue) {
      chunks.push({
        text: chunkTextValue,
        start,
        end,
        wordCount: countWords(chunkTextValue),
        finalized: finalizeTail,
      });
    }
  }

  return chunks;
}

function estimateDurationMs(text: string, wpmBase: number): number {
  const words = countWords(text);
  if (!words) return 0;
  return Math.max(250, Math.round((words / Math.max(1, wpmBase)) * 60000));
}

function withTimeline(chunks: ReconciledDraft[], wpmBase: number): ChunkRecord[] {
  let cursorMs = 0;
  return chunks.map((chunk, index) => {
    const durationMs = estimateDurationMs(chunk.text, wpmBase);
    const startMs = cursorMs;
    const endMs = startMs + durationMs;
    cursorMs = endMs;
    return {
      ...chunk,
      index,
      startChar: chunk.start,
      endChar: chunk.end,
      startMs,
      endMs,
      isCompleted: chunk.finalized,
    };
  });
}

export function createChunkRecords(
  text: string,
  options: { minWordsPerChunk: number; maxWordsPerChunk: number; wpmBase: number; finalizeTail?: boolean },
): ChunkRecord[] {
  const drafts = chunkText(text, options.minWordsPerChunk, options.maxWordsPerChunk, options.finalizeTail).map((chunk, index) => ({
    ...chunk,
    id: `chunk-${String(index + 1).padStart(4, "0")}`,
    revision: 1,
    status: "dirty" as const,
  }));
  return withTimeline(drafts, options.wpmBase);
}

export function reconcileChunks(params: ReconcileParams): ReconcileResult {
  const {
    previousChunks,
    nextText,
    minWordsPerChunk,
    maxWordsPerChunk,
    wpmBase,
    activeChunkId,
    speakingChunkId,
    speakingRevision,
    finalizeTail,
  } = params;
  const drafts = chunkText(nextText, minWordsPerChunk, maxWordsPerChunk, finalizeTail);
  const allocateId = nextId(previousChunks);
  const unusedPrevious = new Set(previousChunks.map((chunk) => chunk.id));
  const exactBuckets = new Map<string, ChunkRecord[]>();

  for (const chunk of previousChunks) {
    const key = normalize(chunk.text);
    const bucket = exactBuckets.get(key) ?? [];
    bucket.push(chunk);
    exactBuckets.set(key, bucket);
  }

  const chunks: ReconciledDraft[] = drafts.map((draft, index) => {
    const exactBucket = exactBuckets.get(normalize(draft.text));
    let match: ChunkRecord | undefined = exactBucket?.find((candidate) => unusedPrevious.has(candidate.id));

    if (!match) {
      let bestScore = 0.35;
      for (const candidate of previousChunks) {
        if (!unusedPrevious.has(candidate.id)) {
          continue;
        }
        const score = similarityScore(candidate, draft, index);
        if (score > bestScore) {
          bestScore = score;
          match = candidate;
        }
      }
    }

    if (!match) {
      return {
        ...draft,
        id: allocateId(),
        revision: 1,
        status: "dirty",
      } satisfies ReconciledDraft;
    }

    unusedPrevious.delete(match.id);
    const changed = normalize(match.text) !== normalize(draft.text) || match.finalized !== draft.finalized;
    if (!changed) {
      return {
        ...draft,
        id: match.id,
        revision: match.revision,
        status: match.status,
        ...(match.audioUrl ? { audioUrl: match.audioUrl } : {}),
      } satisfies ReconciledDraft;
    }

    const isCurrentlySpeaking = speakingChunkId === match.id && speakingRevision === match.revision;
    return {
      ...draft,
      id: match.id,
      revision: match.revision + 1,
      status: isCurrentlySpeaking ? "stale" : "dirty",
    } satisfies ReconciledDraft;
  });

  const resolvedActiveChunkId = resolveFallbackActiveChunkId(previousChunks, chunks, activeChunkId);
  return resolvedActiveChunkId
    ? {
        chunks: withTimeline(chunks, wpmBase),
        activeChunkId: resolvedActiveChunkId,
        dirtyChunkIds: chunks.filter((chunk) => chunk.status === "dirty" || chunk.status === "stale").map((chunk) => chunk.id),
      }
    : {
        chunks: withTimeline(chunks, wpmBase),
        dirtyChunkIds: chunks.filter((chunk) => chunk.status === "dirty" || chunk.status === "stale").map((chunk) => chunk.id),
      };
}

export function getPrefetchTargets(chunks: ChunkRecord[], activeChunkId: string, windowSize: number): ChunkRecord[] {
  const startIndex = chunks.findIndex((chunk) => chunk.id === activeChunkId);
  if (startIndex === -1) {
    return [];
  }

  const targets: ChunkRecord[] = [];
  for (let index = startIndex; index < chunks.length && targets.length < windowSize; index += 1) {
    const chunk = chunks[index];
    if (!chunk) continue;
    if (chunk.finalized) {
      targets.push(chunk);
    }
  }
  return targets;
}

export function toReadingTimeline(chunks: ChunkRecord[]): ReadingTimeline {
  const durationMs = chunks.length ? chunks[chunks.length - 1]?.endMs ?? 0 : 0;
  return { chunks, durationMs };
}

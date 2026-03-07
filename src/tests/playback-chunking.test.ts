import { describe, expect, it } from 'vitest';

import {
  chunkText,
  createChunkRecords,
  getPrefetchTargets,
  reconcileChunks,
  type ChunkRecord,
} from '../core/playback/chunking';

const DEFAULT_OPTIONS = {
  minWordsPerChunk: 6,
  maxWordsPerChunk: 25,
  wpmBase: 180,
};

function byText(chunks: ChunkRecord[], text: string): ChunkRecord {
  const match = chunks.find((chunk) => chunk.text === text);
  if (!match) {
    throw new Error(`Missing chunk: ${text}`);
  }
  return match;
}

describe('chunkText', () => {
  it('finalizes at punctuation once the chunk exceeds five words', () => {
    const chunks = chunkText('One two three four five six. Seven eight nine ten eleven twelve.', 6, 25);

    expect(chunks).toHaveLength(2);
    expect(chunks.map((chunk) => chunk.text)).toEqual([
      'One two three four five six.',
      'Seven eight nine ten eleven twelve.',
    ]);
    expect(chunks.every((chunk) => chunk.finalized)).toBe(true);
  });

  it('does not finalize a short punctuated fragment with five words or fewer', () => {
    const chunks = chunkText('One two three four five. Six seven eight nine ten eleven.', 6, 25);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]!).toMatchObject({
      text: 'One two three four five. Six seven eight nine ten eleven.',
      finalized: true,
      wordCount: 11,
    });
  });

  it('hard-splits once a chunk reaches twenty-five words without punctuation', () => {
    const words = Array.from({ length: 28 }, (_, index) => `w${index + 1}`).join(' ');

    const chunks = chunkText(words, 6, 25);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.wordCount).toBe(25);
    expect(chunks[0]!.finalized).toBe(true);
    expect(chunks[1]!.wordCount).toBe(3);
    expect(chunks[1]!.finalized).toBe(false);
  });

  it('keeps trailing partial text unfinalized until a boundary is reached', () => {
    const chunks = chunkText('This sentence is definitely long enough. but this tail is unfinished', 6, 25);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]!).toMatchObject({ finalized: true, text: 'This sentence is definitely long enough.' });
    expect(chunks[1]!).toMatchObject({ finalized: false, text: 'but this tail is unfinished' });
  });

  it('splits exactly at twenty-five words even with repeated punctuation-free text', () => {
    const text = Array.from({ length: 50 }, () => 'echo').join(' ');
    const chunks = chunkText(text, 6, 25);

    expect(chunks).toHaveLength(2);
    expect(chunks.every((chunk) => chunk.wordCount === 25)).toBe(true);
    expect(chunks.every((chunk) => chunk.finalized)).toBe(true);
  });
});

describe('reconcileChunks', () => {
  it('preserves ids and cached audio for untouched chunks', () => {
    const previousText = 'Alpha beta gamma delta epsilon zeta. Eta theta iota kappa lambda mu.';
    const previousChunks = createChunkRecords(previousText, DEFAULT_OPTIONS).map((chunk, index) => ({
      ...chunk,
      status: 'ready' as const,
      audioUrl: `blob:${index}`,
    }));

    const nextText = `${previousText} Nu xi omicron pi rho sigma.`;
    const result = reconcileChunks({ nextText, previousChunks, activeChunkId: previousChunks[0]!.id, ...DEFAULT_OPTIONS });

    expect(result.chunks[0]!.id).toBe(previousChunks[0]!.id);
    expect(result.chunks[0]!.audioUrl).toBe('blob:0');
    expect(result.chunks[1]!.id).toBe(previousChunks[1]!.id);
    expect(result.chunks[1]!.audioUrl).toBe('blob:1');
    expect(result.dirtyChunkIds).toEqual([result.chunks[2]!.id]);
  });

  it('keeps the playback pointer on the same logical chunk when text is inserted before it', () => {
    const previousText = 'Alpha beta gamma delta epsilon zeta. Eta theta iota kappa lambda mu. Nu xi omicron pi rho sigma.';
    const previousChunks = createChunkRecords(previousText, DEFAULT_OPTIONS);
    const activeChunkId = previousChunks[2]!.id;

    const nextText = 'Preface words added before everything else to shift offsets dramatically. ' + previousText;
    const result = reconcileChunks({ nextText, previousChunks, activeChunkId, ...DEFAULT_OPTIONS });

    expect(byText(result.chunks, 'Nu xi omicron pi rho sigma.').id).toBe(activeChunkId);
    expect(result.activeChunkId).toBe(activeChunkId);
  });

  it('marks the currently speaking chunk stale while preserving neighboring ready audio', () => {
    const previousText = 'Alpha beta gamma delta epsilon zeta. Eta theta iota kappa lambda mu. Nu xi omicron pi rho sigma.';
    const previousChunks = createChunkRecords(previousText, DEFAULT_OPTIONS).map((chunk, index) => ({
      ...chunk,
      status: 'ready' as const,
      audioUrl: `blob:${index}`,
    }));

    const activeChunkId = previousChunks[1]!.id;
    const nextText = 'Alpha beta gamma delta epsilon zeta. Eta theta iota kappa lambda revised mu. Nu xi omicron pi rho sigma.';
    const result = reconcileChunks({
      nextText,
      previousChunks,
      activeChunkId,
      speakingChunkId: activeChunkId,
      speakingRevision: previousChunks[1]!.revision,
      ...DEFAULT_OPTIONS,
    });

    const current = byText(result.chunks, 'Eta theta iota kappa lambda revised mu.');
    expect(current.id).toBe(activeChunkId);
    expect(current.status).toBe('stale');
    expect(current.audioUrl).toBeUndefined();
    expect(byText(result.chunks, 'Alpha beta gamma delta epsilon zeta.').audioUrl).toBe('blob:0');
    expect(byText(result.chunks, 'Nu xi omicron pi rho sigma.').audioUrl).toBe('blob:2');
  });

  it('invalidates only boundary-affected chunks on a mid-document insertion', () => {
    const previousText = 'Alpha beta gamma delta epsilon zeta. Eta theta iota kappa lambda mu. Nu xi omicron pi rho sigma.';
    const previousChunks = createChunkRecords(previousText, DEFAULT_OPTIONS).map((chunk, index) => ({
      ...chunk,
      status: 'ready' as const,
      audioUrl: `blob:${index}`,
    }));

    const nextText = 'Alpha beta gamma delta epsilon zeta changed here heavily and still valid. Eta theta iota kappa lambda mu. Nu xi omicron pi rho sigma.';
    const result = reconcileChunks({ nextText, previousChunks, activeChunkId: previousChunks[2]!.id, ...DEFAULT_OPTIONS });

    expect(result.dirtyChunkIds).toContain(result.chunks[0]!.id);
    expect(byText(result.chunks, 'Eta theta iota kappa lambda mu.').audioUrl).toBe('blob:1');
    expect(byText(result.chunks, 'Nu xi omicron pi rho sigma.').audioUrl).toBe('blob:2');
  });

  it('keeps duplicate chunks stable when editing only the second duplicate', () => {
    const previousText = 'Repeat alpha beta gamma delta epsilon zeta. Repeat alpha beta gamma delta epsilon zeta. Tail theta iota kappa lambda mu nu.';
    const previousChunks = createChunkRecords(previousText, DEFAULT_OPTIONS).map((chunk, index) => ({
      ...chunk,
      status: 'ready' as const,
      audioUrl: `blob:${index}`,
    }));

    const nextText = 'Repeat alpha beta gamma delta epsilon zeta. Repeat alpha beta gamma delta epsilon revised zeta. Tail theta iota kappa lambda mu nu.';
    const result = reconcileChunks({ nextText, previousChunks, activeChunkId: previousChunks[2]!.id, ...DEFAULT_OPTIONS });

    expect(result.chunks[0]!.id).toBe(previousChunks[0]!.id);
    expect(result.chunks[0]!.audioUrl).toBe('blob:0');
    expect(result.chunks[1]!.id).toBe(previousChunks[1]!.id);
    expect(result.chunks[1]!.status).toBe('dirty');
    expect(result.chunks[2]!.id).toBe(previousChunks[2]!.id);
  });

  it('remaps the active chunk by similarity when a merge removes its old id', () => {
    const previousText = 'Alpha beta gamma delta epsilon zeta. Eta theta iota kappa lambda mu. Nu xi omicron pi rho sigma.';
    const previousChunks = createChunkRecords(previousText, DEFAULT_OPTIONS);
    const activeChunkId = previousChunks[1]!.id;

    const nextText = 'Alpha beta gamma delta epsilon zeta Eta theta iota kappa lambda mu. Nu xi omicron pi rho sigma.';
    const result = reconcileChunks({ nextText, previousChunks, activeChunkId, ...DEFAULT_OPTIONS });

    expect(result.activeChunkId).toBe(result.chunks[0]!.id);
    expect(result.chunks[0]!.text).toContain('Eta theta iota kappa lambda mu.');
  });
});

describe('getPrefetchTargets', () => {
  it('returns the active finalized chunk plus the next two finalized chunks', () => {
    const chunks = createChunkRecords(
      'Alpha beta gamma delta epsilon zeta. Eta theta iota kappa lambda mu. Nu xi omicron pi rho sigma. trailing partial words',
      DEFAULT_OPTIONS,
    );

    const targets = getPrefetchTargets(chunks, chunks[1]!.id, 3);

    expect(targets.map((chunk) => chunk.text)).toEqual([
      'Eta theta iota kappa lambda mu.',
      'Nu xi omicron pi rho sigma.',
    ]);
  });
});

import { describe, expect, it } from "vitest";
import { buildReadingTimeline, cleanTextForTts, findChunkIndexByTime, normalizeText, splitIntoChunks } from "../core/utils/chunking";

describe("chunking", () => {
  it("normalizes whitespace", () => {
    expect(normalizeText("  hello\n\nworld  ")).toBe("hello world");
  });

  it("cleans text for tts", () => {
    expect(cleanTextForTts("Hi 😊   there!!!!\n\n#ok")).toBe("Hi there!!! #ok");
  });

  it("preserves word boundaries from newlines", () => {
    expect(cleanTextForTts("hi\nhi")).toBe("hi hi");
    expect(cleanTextForTts("word1\r\nword2\nword3")).toBe("word1 word2 word3");
  });

  it("splits by sentence boundaries and punctuation", () => {
    expect(splitIntoChunks("one two. three four?", 2, 5)).toEqual(["one two.", "three four?"]);
  });

  it("combines short units and splits long ones", () => {
    expect(splitIntoChunks("one. two. three four five six seven.", 2, 3)).toEqual([
      "one. two.",
      "three four five",
      "six seven."
    ]);
  });

  it("falls back to backward merge for short abbreviations", () => {
    expect(splitIntoChunks("This is six words here now. John H. Watson writes.", 3, 6)).toEqual([
      "This is six words here now.",
      "John H. Watson",
      "writes."
    ]);
  });

  it("builds a timeline", () => {
    const timeline = buildReadingTimeline("one two three four", 1, 2, 120);
    expect(timeline.chunks).toHaveLength(2);
    const firstChunk = timeline.chunks[0];
    expect(firstChunk?.startMs).toBe(0);
    expect(firstChunk?.endMs).toBe(1000);
    expect(timeline.durationMs).toBe(2000);
  });

  it("maps time to chunk index", () => {
    const timeline = buildReadingTimeline("one two three four", 1, 2, 120);
    expect(findChunkIndexByTime(timeline, 0)).toBe(0);
    expect(findChunkIndexByTime(timeline, 1300)).toBe(1);
    expect(findChunkIndexByTime(timeline, 99999)).toBe(1);
  });
});

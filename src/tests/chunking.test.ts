import { describe, expect, it } from "vitest";
import { cleanTextForTts, findChunkIndexByTime } from "../core/utils/chunking";
import { DEFAULT_CONFIG } from "../core/models/defaults";

describe("chunking", () => {
  it("enables clean text by default", () => {
    expect(DEFAULT_CONFIG.reading.cleanTextBeforeTts).toBe(true);
    expect(DEFAULT_CONFIG.reading.lowercaseTextBeforeTts).toBe(false);
  });

  it("cleans text for tts", () => {
    expect(cleanTextForTts("Hi 😊   there!!!!\n\n#ok")).toBe("Hi there!!! #ok");
  });

  it("preserves word boundaries from newlines", () => {
    expect(cleanTextForTts("hi\nhi")).toBe("hi hi");
    expect(cleanTextForTts("word1\r\nword2\nword3")).toBe("word1 word2 word3");
  });

  it("maps time to chunk index", () => {
    const timeline = {
      durationMs: 2000,
      chunks: [
        { index: 0, text: "one two", startChar: 0, endChar: 7, startMs: 0, endMs: 1000 },
        { index: 1, text: "three four", startChar: 8, endChar: 18, startMs: 1000, endMs: 2000 }
      ]
    };
    expect(findChunkIndexByTime(timeline, 0)).toBe(0);
    expect(findChunkIndexByTime(timeline, 1300)).toBe(1);
    expect(findChunkIndexByTime(timeline, 99999)).toBe(1);
  });
});

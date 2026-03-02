import { describe, expect, it } from "vitest";
import { buildReadingTimeline, findChunkIndexByTime, normalizeText, splitIntoChunks } from "../core/utils/chunking";

describe("chunking", () => {
  it("normalizes whitespace", () => {
    expect(normalizeText("  hello\n\nworld  ")).toBe("hello world");
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

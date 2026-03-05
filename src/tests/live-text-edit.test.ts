import { describe, expect, it } from "vitest";
import type { Chunk } from "../core/models/types";
import {
  classifyEffectiveTextEdit,
  findChunkIndexAtOrAfterChar,
  shouldHardResetTailSubtract,
  stripNonEffectiveTrailing
} from "../core/utils/live-text-edit";

describe("live text edit policy", () => {
  it("treats trailing whitespace-only changes as no_effect", () => {
    expect(stripNonEffectiveTrailing("hello \n\n")).toBe("hello");
    expect(classifyEffectiveTextEdit("hello", "hello \n")).toBe("no_effect");
    expect(classifyEffectiveTextEdit("hello\n", "hello")).toBe("no_effect");
  });

  it("classifies append-only edits", () => {
    expect(classifyEffectiveTextEdit("line1\nline2", "line1\nline2\nline3")).toBe("append_only");
  });

  it("classifies tail subtraction edits", () => {
    expect(classifyEffectiveTextEdit("line1\nline2\nline3", "line1\nline2")).toBe("tail_subtract_only");
    expect(classifyEffectiveTextEdit("abc", "ab")).toBe("tail_subtract_only");
  });

  it("classifies middle mutation edits", () => {
    expect(classifyEffectiveTextEdit("line1\nline2\nline3", "line1\nlineX\nline3")).toBe("mutated_existing");
  });

  it("uses hard reset only when tail subtraction touches active chunk end", () => {
    expect(shouldHardResetTailSubtract(120, 140)).toBe(false);
    expect(shouldHardResetTailSubtract(120, 120)).toBe(false);
    expect(shouldHardResetTailSubtract(120, 119)).toBe(true);
  });

  it("maps continuation index by char offset on rebuilt timeline", () => {
    const chunks: Chunk[] = [
      { index: 0, text: "aaa", startChar: 0, endChar: 3, startMs: 0, endMs: 100 },
      { index: 1, text: "bbb", startChar: 4, endChar: 7, startMs: 100, endMs: 200 },
      { index: 2, text: "ccc", startChar: 8, endChar: 11, startMs: 200, endMs: 300 }
    ];
    expect(findChunkIndexAtOrAfterChar(chunks, 0)).toBe(0);
    expect(findChunkIndexAtOrAfterChar(chunks, 5)).toBe(1);
    expect(findChunkIndexAtOrAfterChar(chunks, 7)).toBe(2);
    expect(findChunkIndexAtOrAfterChar(chunks, 999)).toBe(2);
  });
});


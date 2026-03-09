import { describe, expect, it } from "vitest";

import { canResumePlayback } from "../core/playback/session";

describe("canResumePlayback", () => {
  it("allows resume for an active chunk in the current session", () => {
    expect(canResumePlayback({
      chunkPlaybackMode: true,
      audioSrc: "blob:current",
      speakingChunkId: "chunk-1"
    })).toBe(true);
  });

  it("rejects stale audio left behind after playback completed", () => {
    expect(canResumePlayback({
      chunkPlaybackMode: true,
      audioSrc: "blob:previous",
      speakingChunkId: null
    })).toBe(false);
  });

  it("rejects resume when no playback session is active", () => {
    expect(canResumePlayback({
      chunkPlaybackMode: false,
      audioSrc: "blob:previous",
      speakingChunkId: "chunk-1"
    })).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { joinApiPath, makeOptionCacheKey, resolveVoiceSelection } from "../web/tts-option-utils";

describe("tts-option-utils", () => {
  it("builds model-aware cache keys", () => {
    expect(makeOptionCacheKey("tts-voices", "http://127.0.0.1:8014", "", "KittenML/kitten-tts-mini-0.8"))
      .toBe("tts-voices|http://127.0.0.1:8014||KittenML/kitten-tts-mini-0.8");
  });

  it("adds the model query parameter to voice-list requests", () => {
    expect(joinApiPath("http://127.0.0.1:8014", "/voices", { model: "KittenML/kitten-tts-mini-0.8" }))
      .toBe("http://127.0.0.1:8014/voices?model=KittenML%2Fkitten-tts-mini-0.8");
  });

  it("keeps the current voice when still available", () => {
    expect(resolveVoiceSelection("Bella", [{ value: "Bella", label: "Bella" }, { value: "Jasper", label: "Jasper" }]))
      .toBe("Bella");
  });

  it("falls back to the first voice when the current voice is missing", () => {
    expect(resolveVoiceSelection("Jasper", [{ value: "Bella", label: "Bella" }])).toBe("Bella");
  });
});

import { describe, expect, it } from "vitest";
import { RequestPreemptor } from "../core/utils/request-preemptor";

describe("request preemptor", () => {
  it("preempts older request in same lane", () => {
    const preemptor = new RequestPreemptor<"ocr" | "rapid">();
    const first = preemptor.beginLane("ocr");
    expect(first.signal.aborted).toBe(false);

    const second = preemptor.beginLane("ocr");
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
    expect(preemptor.isCurrent("ocr", first.token)).toBe(false);
    expect(preemptor.isCurrent("ocr", second.token)).toBe(true);
  });

  it("does not preempt other lanes", () => {
    const preemptor = new RequestPreemptor<"ocr" | "rapid">();
    const ocr = preemptor.beginLane("ocr");
    const rapid = preemptor.beginLane("rapid");
    expect(ocr.signal.aborted).toBe(false);
    expect(rapid.signal.aborted).toBe(false);
    preemptor.preemptLane("ocr");
    expect(ocr.signal.aborted).toBe(true);
    expect(rapid.signal.aborted).toBe(false);
  });

  it("propagates parent signal abort", () => {
    const preemptor = new RequestPreemptor<"ocr">();
    const parent = new AbortController();
    const lane = preemptor.beginLane("ocr", parent.signal);
    expect(lane.signal.aborted).toBe(false);
    parent.abort();
    expect(lane.signal.aborted).toBe(true);
  });

  it("invalidates stale handles across repeated begin/done cycles", () => {
    const preemptor = new RequestPreemptor<"ocr">();
    const first = preemptor.beginLane("ocr");
    const firstToken = first.token;
    first.done();
    expect(preemptor.isCurrent("ocr", firstToken)).toBe(true);

    const second = preemptor.beginLane("ocr");
    expect(first.signal.aborted).toBe(true);
    expect(preemptor.isCurrent("ocr", firstToken)).toBe(false);
    expect(preemptor.isCurrent("ocr", second.token)).toBe(true);
  });
});

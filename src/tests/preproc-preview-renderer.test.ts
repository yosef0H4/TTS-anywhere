import { describe, expect, it } from "vitest";
import { PreprocPreviewRenderer } from "../features/preprocessing/preview-renderer";

function defineImageSize(image: HTMLImageElement, width: number, height: number): void {
  Object.defineProperty(image, "naturalWidth", { configurable: true, get: () => width });
  Object.defineProperty(image, "naturalHeight", { configurable: true, get: () => height });
}

function makeRenderer() {
  const viewer = document.createElement("div");
  const content = document.createElement("div");
  const preview = document.createElement("img");
  const overlay = document.createElement("div");
  const overlaySvg = document.createElementNS("http://www.w3.org/2000/svg", "svg") as unknown as SVGSVGElement;
  const selectionMask = document.createElement("canvas");
  const manualLayer = document.createElement("div");
  const drawPreview = document.createElement("div");

  preview.src = "data:image/png;base64,abc";
  defineImageSize(preview, 200, 100);
  viewer.getBoundingClientRect = () => new DOMRect(0, 0, 400, 200);

  const renderer = new PreprocPreviewRenderer(
    {
      viewer,
      content,
      preview,
      overlay,
      overlaySvg,
      selectionMask,
      manualLayer,
      drawPreview
    },
    {
      getThresholds: () => ({
        minWidthRatio: 0,
        minHeightRatio: 0,
        medianHeightFraction: 0.45,
        mergeVerticalRatio: 0.07,
        mergeHorizontalRatio: 0.37,
        mergeWidthRatioThreshold: 0.75
      })
    }
  );

  return { renderer };
}

describe("preproc-preview-renderer", () => {
  it("keeps pointer normalization stable when zooming around the cursor", () => {
    const { renderer } = makeRenderer();

    renderer.zoomAt(200, 100, -1);
    const point = renderer.pointerToNormalized(200, 100);

    expect(point).toEqual({ x: 0.5, y: 0.5 });
  });

  it("clamps panning so the canvas cannot be dragged past the origin edge", () => {
    const { renderer } = makeRenderer();

    renderer.zoomAt(200, 100, -1);
    renderer.panBy(100, 50);

    expect(renderer.getViewportSnapshot()).toEqual({
      zoom: 1.1,
      panX: 0,
      panY: 0
    });
  });
});

import { test } from "@playwright/test";
import { loadFixture, readState, setControls } from "./helpers/lab";
import { captureCanvasSnapshot } from "./helpers/screenshot";

test("visualizers render default and tuned geometric states", async ({ page }, testInfo) => {
  await page.goto("/");
  await loadFixture(page, "sgdsfg.webp");

  const state = await readState<{ status: string }>(page);
  if (state.status.startsWith("Detection failed")) {
    test.skip(true, "Python server unavailable; skipping visualizer snapshots.");
  }

  await captureCanvasSnapshot(page, testInfo, "viz-default");

  await setControls(page, {
    "max-image-dimension": 420,
    "merge-vertical-ratio": 0.65,
    "merge-horizontal-ratio": 1.6,
    "merge-width-ratio-threshold": 0.92,
    "min-width-ratio": 0.06,
    "min-height-ratio": 0.06
  });

  await page.waitForTimeout(120);
  await captureCanvasSnapshot(page, testInfo, "viz-tuned");
});

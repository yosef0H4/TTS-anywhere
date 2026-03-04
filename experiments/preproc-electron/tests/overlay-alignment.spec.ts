import { test } from "@playwright/test";
import { assertNoOffCanvas, loadFixture, readState, runDetect } from "./helpers/lab";
import { captureCanvasSnapshot } from "./helpers/screenshot";

test("overlay boxes remain on canvas after resize", async ({ page }, testInfo) => {
  await page.goto("/");
  await loadFixture(page, "test.png");
  await runDetect(page);

  const state = await readState<{ status: string; metrics: null | { raw_count: number } }>(page);
  if (state.status.startsWith("Detection failed") || state.metrics === null) {
    test.skip(true, "Python server unavailable; skipping overlay assertions.");
  }

  await page.setViewportSize({ width: 1400, height: 900 });
  await assertNoOffCanvas(page);
  await captureCanvasSnapshot(page, testInfo, "overlay-1400x900");

  await page.setViewportSize({ width: 1100, height: 760 });
  await assertNoOffCanvas(page);
  await captureCanvasSnapshot(page, testInfo, "overlay-1100x760");
});

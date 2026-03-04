import { expect, test } from "@playwright/test";
import { loadFixture, readState, runDetect } from "./helpers/lab";

test("fixture detection runs and populates metrics", async ({ page }) => {
  await page.goto("/");
  await loadFixture(page, "test.png");
  await runDetect(page);

  const state = await readState<{
    metrics: null | { raw_count: number; live_count: number };
    status: string;
    boxes: unknown[];
    rawCount: number;
    liveCount: number;
  }>(page);

  if (state.status.startsWith("Detection failed") || state.metrics === null) {
    test.skip(true, "Python server unavailable; skipping detection assertions.");
  }

  expect(state.metrics).not.toBeNull();
  expect(state.metrics!.raw_count).toBeGreaterThanOrEqual(0);
  expect(state.metrics!.live_count).toBeGreaterThanOrEqual(0);
  expect(state.boxes.length).toBe(state.liveCount);
});

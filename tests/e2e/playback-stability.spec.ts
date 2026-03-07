import { expect, test } from "@playwright/test";
import { clearPlaybackMetrics, dispatchEngine, getPlaybackMetrics, gotoApp } from "./helpers/e2e-harness";
import { installMockTts } from "./helpers/mock-api";

test("streaming deltas do not create playback session storm", async ({ page }) => {
  await installMockTts(page);
  await gotoApp(page);
  await clearPlaybackMetrics(page);

  await dispatchEngine(page, { type: "STREAM_START" });
  await dispatchEngine(page, { type: "OCR_DELTA", token: "Sherlock Holmes is a fictional detective created by Arthur Conan Doyle. " });
  await dispatchEngine(page, { type: "OCR_DELTA", token: "He solves mysteries with Dr Watson in London. " });
  await dispatchEngine(page, { type: "OCR_DELTA", token: "Cases continue." });
  await dispatchEngine(page, { type: "STREAM_DONE" });

  await expect.poll(async () => (await getPlaybackMetrics(page)).sessionStarts).toBeGreaterThan(0);
  await page.waitForTimeout(300);

  const metrics = await getPlaybackMetrics(page);
  expect(metrics.sessionStarts).toBeLessThanOrEqual(2);
});

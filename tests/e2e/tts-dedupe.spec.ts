import { expect, test } from "@playwright/test";
import { clearPlaybackMetrics, dispatchEngine, getPlaybackMetrics, gotoApp, startPlayback, waitForStablePlaybackStart } from "./helpers/e2e-harness";
import { installMockTts } from "./helpers/mock-api";

test("does not synthesize same chunk hash twice in the same session", async ({ page }) => {
  await installMockTts(page);
  await gotoApp(page);
  await clearPlaybackMetrics(page);

  await dispatchEngine(page, { type: "TEXT_SYNC", source: "user", text:
    "Sherlock Holmes is a fictional detective created by Arthur Conan Doyle. " +
    "Referring to himself as a consulting detective, he investigates cases for a wide variety of clients. " +
    "Most stories are narrated by Dr John Watson."
  });

  await startPlayback(page);
  await waitForStablePlaybackStart(page);
  await page.waitForTimeout(600);

  const metrics = await getPlaybackMetrics(page);
  const counts = Object.values(metrics.ttsStartsBySessionAndHash);
  expect(counts.length).toBeGreaterThan(0);
  counts.forEach((count) => expect(count).toBe(1));
});

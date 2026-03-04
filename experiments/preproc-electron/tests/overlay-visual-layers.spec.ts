import { expect, test } from "@playwright/test";
import { loadFixture, readState, setControls } from "./helpers/lab";

test("merge preview shows helper layers and committed view keeps merged overlays", async ({ page }) => {
  await page.goto("/");
  await loadFixture(page, "sgdsfg.webp");

  const stateA = await readState<{ status: string }>(page);
  if (stateA.status.startsWith("Detection failed")) {
    test.skip(true, "Python server unavailable; skipping overlay helper assertions.");
  }

  await setControls(page, {
    "merge-vertical-ratio": 0.45,
    "merge-horizontal-ratio": 0.8,
    "merge-width-ratio-threshold": 0.5
  });
  await page.waitForTimeout(70);

  const helperCount = await page.getByTestId("overlay-tolerance").count();
  const ratioCount = await page.getByTestId("overlay-ratio-bar").count();
  const pathCount = await page.getByTestId("overlay-flow-path").count();
  const arrowCount = await page.getByTestId("overlay-flow-arrow").count();
  expect(helperCount).toBeGreaterThan(0);
  expect(ratioCount).toBeGreaterThan(0);
  expect(pathCount).toBeGreaterThan(0);
  expect(arrowCount).toBeGreaterThan(0);

  await page.waitForTimeout(400);
  const stateB = await readState<{ overlayMode: string; overlayLayersActive: string[]; liveCount: number }>(page);
  expect(stateB.overlayMode).toBe("committed");
  expect(stateB.liveCount).toBeGreaterThan(0);
  expect(stateB.overlayLayersActive).toContain("overlay-merged");
});


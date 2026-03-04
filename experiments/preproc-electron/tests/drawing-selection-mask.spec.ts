import { expect, test } from "@playwright/test";
import { drawNormalized, loadFixture, readState, setTool } from "./helpers/lab";

test("selection add/sub mask updates live counts and manual boxes stay included", async ({ page }) => {
  await page.goto("/");
  await loadFixture(page, "sgdsfg.webp");

  const stateA = await readState<{ status: string; liveCount: number }>(page);
  if (stateA.status.startsWith("Detection failed")) {
    test.skip(true, "Python server unavailable; skipping selection mask assertions.");
  }

  const baseline = stateA.liveCount;

  await page.evaluate(() => window.lab.deselectAll());
  await setTool(page, "add");
  const added = await drawNormalized(page, { nx: 0.08, ny: 0.08, nw: 0.32, nh: 0.35 });
  expect(added).toBeTruthy();

  const stateB = await readState<{ selectionBaseState: boolean; selectionOpCount: number; liveCount: number; overlayLayersActive: string[] }>(page);
  expect(stateB.selectionBaseState).toBeFalsy();
  expect(stateB.selectionOpCount).toBe(1);
  expect(stateB.overlayLayersActive).toContain("selection-mask");

  await setTool(page, "sub");
  const subbed = await drawNormalized(page, { nx: 0.18, ny: 0.14, nw: 0.1, nh: 0.1 });
  expect(subbed).toBeTruthy();
  const stateC = await readState<{ selectionOpCount: number; liveCount: number }>(page);
  expect(stateC.selectionOpCount).toBe(2);
  expect(stateC.liveCount).toBeLessThanOrEqual(stateB.liveCount);

  await setTool(page, "manual");
  await drawNormalized(page, { nx: 0.72, ny: 0.73, nw: 0.15, nh: 0.14 });
  const stateD = await readState<{ manualBoxCount: number; liveCount: number }>(page);
  expect(stateD.manualBoxCount).toBeGreaterThan(0);
  expect(stateD.liveCount).toBeGreaterThanOrEqual(stateC.liveCount);
  expect(stateD.liveCount).toBeGreaterThanOrEqual(Math.min(1, baseline));
});


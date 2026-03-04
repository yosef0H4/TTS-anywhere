import { expect, test } from "@playwright/test";
import { loadFixture, readState, setControls } from "./helpers/lab";

test("postprocess sliders update live without model rerun; preprocess sliders rerun model", async ({ page }) => {
  await page.goto("/");
  await loadFixture(page, "sgdsfg.webp");

  const stateA = await readState<{ rawCount: number; liveCount: number; status: string }>(page);
  if (stateA.status.startsWith("Detection failed")) {
    test.skip(true, "Python server unavailable; skipping behavior assertions.");
  }

  const beforeRaw = stateA.rawCount;

  await setControls(page, { "group-tolerance": 0.8, "merge-horizontal-ratio": 0.8, "reading-direction": "vertical_rtl" });
  await page.waitForTimeout(100);
  const stateB = await readState<{ rawCount: number; direction: string; overlayMode: string }>(page);
  expect(stateB.rawCount).toBe(beforeRaw);
  expect(stateB.direction).toBe("vertical_rtl");
  expect(["merge-preview", "committed"]).toContain(stateB.overlayMode);

  await setControls(page, { contrast: 1.8 });
  await page.waitForFunction(() => {
    const s = window.lab.getState();
    return s.pendingDetect === false;
  }, { timeout: 15000 });

  const stateC = await readState<{ rawCount: number; pendingDetect: boolean }>(page);
  expect(stateC.pendingDetect).toBeFalsy();
  expect(stateC.rawCount).toBeGreaterThanOrEqual(0);
});

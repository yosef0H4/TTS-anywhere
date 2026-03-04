import { expect, test } from "@playwright/test";
import { drawNormalized, loadFixture, readState, setTool } from "./helpers/lab";

test("manual drawing adds removable persistent boxes", async ({ page }) => {
  await page.goto("/");
  await loadFixture(page, "test.png");

  const initial = await readState<{ status: string }>(page);
  if (initial.status.startsWith("Detection failed")) {
    test.skip(true, "Python server unavailable; skipping drawing assertions.");
  }

  await setTool(page, "manual");
  const created = await drawNormalized(page, { nx: 0.12, ny: 0.14, nw: 0.22, nh: 0.2 });
  expect(created).toBeTruthy();

  const stateA = await readState<{ manualBoxCount: number; toolMode: string; liveCount: number }>(page);
  expect(stateA.toolMode).toBe("manual");
  expect(stateA.manualBoxCount).toBeGreaterThanOrEqual(1);
  expect(stateA.liveCount).toBeGreaterThan(0);
  await expect(page.getByTestId("manual-box")).toHaveCount(stateA.manualBoxCount);

  await page.getByTestId("manual-delete").first().click();
  const stateB = await readState<{ manualBoxCount: number }>(page);
  expect(stateB.manualBoxCount).toBe(0);

  await setTool(page, "manual");
  await drawNormalized(page, { nx: 0.22, ny: 0.18, nw: 0.2, nh: 0.2 });
  const stateC = await readState<{ manualBoxCount: number }>(page);
  expect(stateC.manualBoxCount).toBe(1);

  await page.reload();
  await page.waitForFunction(() => typeof window.lab === "object");
  const stateD = await readState<{ manualBoxCount: number }>(page);
  expect(stateD.manualBoxCount).toBe(1);
});


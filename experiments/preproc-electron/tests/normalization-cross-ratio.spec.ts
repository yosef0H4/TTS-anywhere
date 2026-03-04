import { expect, test } from "@playwright/test";
import { drawNormalized, getLab, readState, setTool } from "./helpers/lab";

async function loadSynthetic(page: any, width: number, height: number): Promise<void> {
  await getLab(page);
  await page.evaluate(async ({ w, h }) => {
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d context unavailable");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#000000";
    ctx.font = "bold 28px sans-serif";
    ctx.fillText(`${w}x${h}`, 20, Math.max(40, h / 2));
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("blob failed"))), "image/png");
    });
    await window.lab.loadImageBlob(blob);
  }, { w: width, h: height });
}

test("manual/selection normalized state reprojects across image aspect ratios", async ({ page }) => {
  await page.goto("/");

  await loadSynthetic(page, 1600, 900);
  await setTool(page, "manual");
  expect(await drawNormalized(page, { nx: 0.1, ny: 0.15, nw: 0.25, nh: 0.2 })).toBeTruthy();

  const before = await readState<{ manualBoxCount: number; imageMeta: { oriented: boolean; sourceWidth: number; sourceHeight: number } | null }>(page);
  expect(before.manualBoxCount).toBe(1);
  expect(before.imageMeta).not.toBeNull();

  await loadSynthetic(page, 900, 1600);
  const after = await readState<{ manualBoxCount: number }>(page);
  expect(after.manualBoxCount).toBe(1);

  const noOff = await page.evaluate(() => window.lab.assertNoOffCanvasBoxes());
  expect(noOff.ok, `offenders: ${noOff.offenders.join(",")}`).toBeTruthy();
  await expect(page.locator('[data-testid="manual-box"]')).toHaveCount(1);
});

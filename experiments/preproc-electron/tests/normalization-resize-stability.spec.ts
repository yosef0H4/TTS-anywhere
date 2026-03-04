import { expect, test } from "@playwright/test";
import { drawNormalized, setTool } from "./helpers/lab";

test("normalized overlays remain in-bounds after viewport resizes", async ({ page }) => {
  await page.goto("/");

  await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 2000;
    canvas.height = 700;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d context unavailable");
    ctx.fillStyle = "#f4f4f4";
    ctx.fillRect(0, 0, 2000, 700);
    ctx.fillStyle = "#111";
    ctx.font = "bold 40px sans-serif";
    ctx.fillText("Resize Stability", 50, 130);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("blob failed"))), "image/png");
    });
    await window.lab.loadImageBlob(blob);
  });

  await setTool(page, "manual");
  expect(await drawNormalized(page, { nx: 0.05, ny: 0.08, nw: 0.2, nh: 0.28 })).toBeTruthy();
  expect(await drawNormalized(page, { nx: 0.64, ny: 0.55, nw: 0.28, nh: 0.3 })).toBeTruthy();

  const sizes = [
    { width: 1500, height: 900 },
    { width: 960, height: 720 },
    { width: 1280, height: 800 },
    { width: 1720, height: 960 }
  ];

  for (const size of sizes) {
    await page.setViewportSize(size);
    await page.waitForTimeout(80);
    const noOff = await page.evaluate(() => window.lab.assertNoOffCanvasBoxes());
    expect(noOff.ok, `viewport ${size.width}x${size.height} offenders: ${noOff.offenders.join(",")}`).toBeTruthy();
  }
});

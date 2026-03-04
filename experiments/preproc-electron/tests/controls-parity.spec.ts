import { expect, test } from "@playwright/test";
import { readState } from "./helpers/lab";

test("non-TTS controls expose numeric inputs and reset buttons", async ({ page }) => {
  await page.goto("/");

  const ids = [
    "max-image-dimension",
    "binary-threshold",
    "contrast",
    "brightness",
    "dilation",
    "min-width-ratio",
    "min-height-ratio",
    "median-height-fraction",
    "merge-vertical-ratio",
    "merge-horizontal-ratio",
    "merge-width-ratio-threshold",
    "group-tolerance"
  ];

  for (const id of ids) {
    await expect(page.locator(`#${id}-num`)).toBeVisible();
    await expect(page.locator(`#${id}-reset`)).toBeVisible();
  }

  await expect(page.locator("#invert-reset")).toBeVisible();
  await expect(page.locator("#reading-direction-reset")).toBeVisible();
  await expect(page.locator("#quality-viz")).toBeVisible();
  await expect(page.locator("#settings-viz")).toBeVisible();

  await page.fill("#contrast-num", "2.1");
  await expect(page.locator("#contrast")).toHaveValue("2.1");
  await page.locator("#contrast-reset").click();
  await expect(page.locator("#contrast")).toHaveValue("1");

  await page.fill("#max-image-dimension-num", "1440");
  const state = await readState<{ maxImageDimension: number }>(page);
  expect(state.maxImageDimension).toBe(1440);
});

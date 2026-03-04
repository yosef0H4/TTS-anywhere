import { expect, test } from "@playwright/test";

test("detailed tooltips are present on all major sliders and action buttons", async ({ page }) => {
  await page.goto("/");

  const ids = [
    "server-url", "btn-health", "btn-server-start", "btn-server-stop", "image-upload", "btn-clear",
    "max-image-dimension", "max-image-dimension-num", "max-image-dimension-reset",
    "tool-none", "tool-add", "tool-sub", "tool-manual", "btn-select-all", "btn-deselect-all", "btn-clear-manual",
    "binary-threshold", "binary-threshold-num", "binary-threshold-reset",
    "contrast", "contrast-num", "contrast-reset",
    "brightness", "brightness-num", "brightness-reset",
    "dilation", "dilation-num", "dilation-reset",
    "invert", "invert-reset",
    "min-width-ratio", "min-width-ratio-num", "min-width-ratio-reset",
    "min-height-ratio", "min-height-ratio-num", "min-height-ratio-reset",
    "median-height-fraction", "median-height-fraction-num", "median-height-fraction-reset",
    "reading-direction", "reading-direction-reset",
    "merge-vertical-ratio", "merge-vertical-ratio-num", "merge-vertical-ratio-reset",
    "merge-horizontal-ratio", "merge-horizontal-ratio-num", "merge-horizontal-ratio-reset",
    "merge-width-ratio-threshold", "merge-width-ratio-threshold-num", "merge-width-ratio-threshold-reset",
    "group-tolerance", "group-tolerance-num", "group-tolerance-reset",
    "btn-detect", "btn-debug-refresh"
  ];

  for (const id of ids) {
    const locator = page.locator(`#${id}`);
    await expect(locator, `missing element #${id}`).toHaveCount(1);
    const title = await locator.getAttribute("title");
    expect(title, `missing tooltip title for #${id}`).toBeTruthy();
    expect((title ?? "").trim().length, `tooltip too short for #${id}`).toBeGreaterThan(20);
  }
});

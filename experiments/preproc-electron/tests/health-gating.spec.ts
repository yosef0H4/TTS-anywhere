import { expect, test } from "@playwright/test";
import { readState } from "./helpers/lab";

test("server health gates OCR controls but keeps manual and preprocessing controls active", async ({ page }) => {
  await page.goto("/");

  await page.fill("#server-url", "http://127.0.0.1:65531");
  await page.locator("#btn-health").click();

  await expect(page.locator("#server-status")).toContainText("Server unreachable");
  await expect(page.locator("section[data-ocr-controls]").first()).toHaveClass(/section-disabled/);

  await expect(page.locator("#tool-add")).toBeEnabled();
  await expect(page.locator("#min-width-ratio")).toBeDisabled();
  await expect(page.locator("#merge-vertical-ratio")).toBeDisabled();
  await expect(page.locator("#btn-detect")).toBeDisabled();

  await expect(page.locator("#max-image-dimension")).toBeEnabled();
  await expect(page.locator("#binary-threshold")).toBeEnabled();
  await expect(page.locator("#contrast")).toBeEnabled();

  const state = await readState<{ serverHealthy: boolean }>(page);
  expect(state.serverHealthy).toBe(false);
});

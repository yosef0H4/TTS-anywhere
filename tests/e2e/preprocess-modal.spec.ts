import { test, expect } from "@playwright/test";

const IMG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAJYAAAB4CAIAAADv2b9rAAAAA3NCSVQICAjb4U/gAAABGUlEQVR4nO3QQQ3AIBDAsIP9d25XIC+EZE8QZc18w5l9O+AlZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmhV8B5BwDG3M7a7wAAAAASUVORK5CYII=";
const IMG_BYTES = Buffer.from(IMG.split(",")[1] ?? "", "base64");

async function uploadFixtureImage(page: import("@playwright/test").Page): Promise<void> {
  await page.setInputFiles("#image-upload", {
    name: "fixture.png",
    mimeType: "image/png",
    buffer: IMG_BYTES
  });
  await expect(page.locator("#preview-img")).toBeVisible();
}

test("preprocess modal opens and close works", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await uploadFixtureImage(page);

  await page.click("#preview-img");
  await expect(page.locator("[data-preproc-modal]")).toBeVisible();

  await page.click("#preproc-close");
  await expect(page.locator("[data-preproc-modal]")).toBeHidden();
});

test("preprocess modal sliders interact without crash", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await uploadFixtureImage(page);

  await page.click("#preview-img");
  await expect(page.locator("[data-preproc-modal]")).toBeVisible();

  await page.locator("#preproc-contrast").fill("1.5");
  await page.locator("#preproc-brightness").fill("20");
  await page.locator("#preproc-threshold").fill("80");

  await expect(page.locator("#preproc-preview")).toBeVisible();
});

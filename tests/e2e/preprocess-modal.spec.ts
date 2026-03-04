import { test, expect } from "@playwright/test";

const IMG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAJYAAAB4CAIAAADv2b9rAAAAA3NCSVQICAjb4U/gAAABGUlEQVR4nO3QQQ3AIBDAsIP9d25XIC+EZE8QZc18w5l9O+AlZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmhV8B5BwDG3M7a7wAAAAASUVORK5CYII=";

test("preprocess modal opens and close works", async ({ page }) => {
  page.on("console", (msg) => console.log("BROWSER:", msg.type(), msg.text()));
  await page.goto("/", { waitUntil: "domcontentloaded" });

  await page.evaluate((img) => {
    const input = document.querySelector<HTMLInputElement>("#image-upload");
    const imgEl = document.querySelector<HTMLImageElement>("#preview-img");
    const empty = document.querySelector<HTMLElement>("#image-empty");
    if (!input || !imgEl || !empty) throw new Error("missing base UI elements");
    imgEl.src = img;
    imgEl.classList.remove("hidden");
    empty.classList.add("hidden");
  }, IMG);

  await page.click("#preview-img");
  await expect(page.locator("[data-preproc-modal]")).toBeVisible();

  await page.click("#preproc-close");
  await expect(page.locator("[data-preproc-modal]")).toBeHidden();
});

test("preprocess modal sliders interact without crash", async ({ page }) => {
  page.on("console", (msg) => console.log("BROWSER:", msg.type(), msg.text()));
  await page.goto("/", { waitUntil: "domcontentloaded" });

  await page.evaluate((img) => {
    const imgEl = document.querySelector<HTMLImageElement>("#preview-img");
    const empty = document.querySelector<HTMLElement>("#image-empty");
    if (!imgEl || !empty) throw new Error("missing base UI elements");
    imgEl.src = img;
    imgEl.classList.remove("hidden");
    empty.classList.add("hidden");
  }, IMG);

  await page.click("#preview-img");
  await expect(page.locator("[data-preproc-modal]")).toBeVisible();

  await page.locator("#preproc-contrast").fill("1.5");
  await page.locator("#preproc-brightness").fill("20");
  await page.locator("#preproc-threshold").fill("80");

  await expect(page.locator("#preproc-preview")).toBeVisible();
});

import { expect, test } from "@playwright/test";

test("lab API is exposed and fixture can be loaded", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => typeof (window as { lab?: unknown }).lab === "object");

  await page.evaluate(async () => {
    await window.lab.loadFixture("test.png");
  });

  await expect(page.getByTestId("viewer")).toBeVisible();
  await expect(page.getByTestId("preview")).toHaveAttribute("src", /blob:/);
});

import { expect, Page } from "@playwright/test";

export async function getLab(page: Page): Promise<void> {
  await page.waitForFunction(() => typeof (window as { lab?: unknown }).lab === "object");
}

export async function loadFixture(page: Page, name: string): Promise<void> {
  await getLab(page);
  await page.evaluate(async (fixtureName) => {
    await window.lab.loadFixture(fixtureName);
  }, name);
}

export async function setControls(page: Page, values: Record<string, string | number | boolean>): Promise<void> {
  await getLab(page);
  await page.evaluate(async (nextValues) => {
    window.lab.batchSet(nextValues);
  }, values);
}

export async function runDetect(page: Page): Promise<void> {
  await getLab(page);
  await page.evaluate(async () => {
    await window.lab.detect();
  });
}

export async function readState(page: Page): Promise<unknown> {
  await getLab(page);
  return page.evaluate(() => window.lab.getState());
}

export async function assertNoOffCanvas(page: Page): Promise<void> {
  await getLab(page);
  const result = await page.evaluate(() => window.lab.assertNoOffCanvasBoxes());
  expect(result.ok, `offenders: ${result.offenders.join(",")}`).toBeTruthy();
}

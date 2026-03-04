import { expect, Page, TestInfo } from "@playwright/test";

export async function captureCanvasSnapshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const canvas = page.getByTestId("paste-target");
  const bytes = await canvas.screenshot({ animations: "disabled", caret: "hide" });
  expect(bytes.byteLength).toBeGreaterThan(1000);
  await testInfo.attach(name, { body: bytes, contentType: "image/png" });
}

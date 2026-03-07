import { expect, test } from "@playwright/test";
import { dispatchEngine, getState, gotoApp, setTypingState } from "./helpers/e2e-harness";

test("draft chunk is gated while typing, then becomes playable after stream done", async ({ page }) => {
  await gotoApp(page);
  await dispatchEngine(page, { type: "STREAM_START" });
  await dispatchEngine(page, { type: "OCR_DELTA", token: "Alpha beta gamma" });
  await setTypingState(page, { ocrStreaming: true, activeOcrRequests: 1 });

  const typingState = await getState(page);
  expect(typingState.chunkCount).toBeGreaterThan(0);
  expect(typingState.chunks.some((c) => !c.isCompleted)).toBeTruthy();
  expect(typingState.isTypingActive).toBeTruthy();
  await expect(page.locator("#reading-preview span.chunk-unplayable").first()).toBeVisible();

  await dispatchEngine(page, { type: "STREAM_DONE" });
  await setTypingState(page, { ocrStreaming: false, activeOcrRequests: 0 });

  await page.waitForTimeout(250);
  const doneState = await getState(page);
  expect(doneState.chunks.every((c) => c.isCompleted)).toBeTruthy();
  const unplayableCount = await page.locator("#reading-preview span.chunk-unplayable").count();
  expect(unplayableCount).toBe(0);
});

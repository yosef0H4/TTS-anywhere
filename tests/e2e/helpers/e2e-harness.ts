import { expect, type Page } from "@playwright/test";

type EngineEvent =
  | { type: "STREAM_START" }
  | { type: "OCR_DELTA"; token: string }
  | { type: "STREAM_DONE" }
  | { type: "TEXT_SYNC"; text: string; source: "user" | "llm"; caret?: number };

interface E2eState {
  activeChunkIndex: number;
  chunkCount: number;
  chunkPlaybackMode: boolean;
  isTypingActive: boolean;
  ocrStreaming: boolean;
  ocrStreamDone: boolean;
  activeOcrRequests: number;
  chunks: Array<{ index: number; text: string; startChar: number; endChar: number; isCompleted: boolean }>;
}

interface PlaybackMetrics {
  sessionStarts: number;
  playChunkRequests: number;
  ttsStartsBySessionAndHash: Record<string, number>;
}

export async function gotoApp(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.removeItem("tts-anywhere:settings");
    localStorage.removeItem("tts-snipper:settings");
    const proto = window.HTMLMediaElement?.prototype as { play?: () => Promise<void>; pause?: () => void };
    if (proto?.play) {
      proto.play = async () => {};
    }
    if (proto?.pause) {
      proto.pause = () => {};
    }
  });
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await page.goto("http://127.0.0.1:4174/", { waitUntil: "commit", timeout: 45000 });
      await page.waitForSelector("#raw-text", { timeout: 45000 });
      await page.waitForFunction(() => typeof (window as { __e2e?: unknown }).__e2e === "object", undefined, {
        timeout: 45000
      });
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 2) {
        await page.waitForTimeout(1000);
      }
    }
  }
  throw lastError ?? new Error("Failed to load app under test");
}

export async function setTypingState(
  page: Page,
  typing: { userTyping?: boolean; ocrStreaming?: boolean; activeOcrRequests?: number }
): Promise<void> {
  await page.evaluate((nextTyping) => {
    (window as { __e2e: { setTypingState: (typing: typeof nextTyping) => void } }).__e2e.setTypingState(nextTyping);
  }, typing);
}

export async function setRawText(page: Page, text: string): Promise<void> {
  await page.evaluate((nextText) => {
    (window as { __e2e: { setRawText: (text: string) => void } }).__e2e.setRawText(nextText);
  }, text);
}

export async function dispatchEngine(page: Page, event: EngineEvent): Promise<void> {
  await page.evaluate((e) => {
    (window as { __e2e: { dispatchEngine: (event: EngineEvent) => void } }).__e2e.dispatchEngine(e);
  }, event);
}

export async function startPlayback(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await (window as { __e2e: { startPlayback: () => Promise<void> } }).__e2e.startPlayback();
  });
}

export async function getState(page: Page): Promise<E2eState> {
  return page.evaluate(() => (window as { __e2e: { getState: () => E2eState } }).__e2e.getState());
}

export async function getPlaybackMetrics(page: Page): Promise<PlaybackMetrics> {
  return page.evaluate(() => (window as { __e2e: { getPlaybackMetrics: () => PlaybackMetrics } }).__e2e.getPlaybackMetrics());
}

export async function clearPlaybackMetrics(page: Page): Promise<void> {
  await page.evaluate(() => (window as { __e2e: { clearPlaybackMetrics: () => void } }).__e2e.clearPlaybackMetrics());
}

export async function waitForStablePlaybackStart(page: Page): Promise<void> {
  await expect.poll(async () => {
    const state = await getState(page);
    return state.chunkPlaybackMode;
  }).toBeTruthy();
}

import type { Page } from "@playwright/test";

const SILENT_WAV = (() => {
  const sampleRate = 8000;
  const durationMs = 300;
  const samples = Math.floor((sampleRate * durationMs) / 1000);
  const dataSize = samples;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate, 28);
  buffer.writeUInt16LE(1, 32);
  buffer.writeUInt16LE(8, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
})();

export async function installMockTts(page: Page): Promise<void> {
  await page.route("**/v1/audio/speech", async (route) => {
    await route.fulfill({
      status: 200,
      headers: {
        "content-type": "audio/wav"
      },
      body: SILENT_WAV
    });
  });
}

export async function installMockOcr(page: Page, text: string): Promise<void> {
  await page.route("**/v1/chat/completions", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        choices: [{ message: { content: text } }]
      })
    });
  });
}

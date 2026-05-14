import { _electron as electron, expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const distMain = path.resolve("dist-electron", "main.js");
const servicesRoot = path.resolve("services");
const sampleImagePath = path.resolve("EyeHearYou", "test.png");

async function openSettings(page: Page): Promise<void> {
  const drawer = page.locator("#settings-drawer");
  if ((await drawer.getAttribute("aria-hidden")) !== "false") {
    await page.locator("#btn-settings-toggle").click();
    await expect(drawer).toHaveAttribute("aria-hidden", "false");
  }
}

async function setInputValue(page: Page, id: string, value: string): Promise<void> {
  await page.evaluate(({ id: inputId, value: inputValue }) => {
    const input = document.getElementById(inputId) as HTMLInputElement | null;
    if (!input) {
      throw new Error(`Missing input: ${inputId}`);
    }
    input.value = inputValue;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, { id, value });
}

async function tomSelectOptions(page: Page, selectId: string): Promise<string[]> {
  return page.evaluate((id) => {
    const select = document.getElementById(id) as (HTMLSelectElement & { tomselect?: { options: Record<string, { text?: string }> } }) | null;
    const options = select?.tomselect?.options;
    if (!options) {
      throw new Error(`Missing TomSelect options for ${id}`);
    }
    return Object.values(options).map((option) => String(option.text ?? ""));
  }, selectId);
}

async function setTomSelectByLabel(page: Page, selectId: string, label: string): Promise<void> {
  await page.evaluate(({ selectId: id, label: optionLabel }) => {
    const select = document.getElementById(id) as (HTMLSelectElement & {
      tomselect?: {
        options: Record<string, { text?: string }>;
        setValue: (value: string, silent?: boolean) => void;
      };
    }) | null;
    const control = select?.tomselect;
    if (!control) {
      throw new Error(`Missing TomSelect control for ${id}`);
    }
    const match = Object.entries(control.options).find(([, option]) => option.text === optionLabel);
    if (!match) {
      throw new Error(`Option not found in ${id}: ${optionLabel}`);
    }
    control.setValue(match[0], true);
  }, { selectId, label });
}

async function inputValue(page: Page, id: string): Promise<string> {
  return page.locator(`#${id}`).inputValue();
}

async function waitForChip(page: Page, id: string, expected: string, timeout: number): Promise<void> {
  await expect.poll(async () => (await page.locator(`#${id}`).textContent())?.trim() ?? "", { timeout }).toBe(expected);
}

test("electron launcher starts real local services and endpoints respond", async () => {
  test.setTimeout(30 * 60_000);

  if (!fs.existsSync(distMain)) {
    test.skip();
  }

  const app = await electron.launch({
    args: ["."],
    env: {
      ...process.env,
      VITE_DEV_SERVER_URL: "http://127.0.0.1:4173"
    }
  });

  const page = await app.firstWindow();

  try {
    await page.waitForSelector("#btn-play", { timeout: 120000 });
    await openSettings(page);

    await setInputValue(page, "services-external-root", servicesRoot);
    await page.locator("#btn-refresh-services-dashboard").click();

    await expect(page.locator("#services-dashboard-footnote")).toContainText("Detected 2 services", { timeout: 120000 });

    const detectOptions = await tomSelectOptions(page, "service-detect-select");
    const ocrOptions = await tomSelectOptions(page, "service-ocr-select");
    const ttsOptions = await tomSelectOptions(page, "service-tts-select");

    expect(detectOptions).toEqual(expect.arrayContaining(["Paddle", "Paddle NVIDIA"]));
    expect(ocrOptions).toEqual(expect.arrayContaining(["Paddle", "Paddle NVIDIA"]));
    expect(ttsOptions).toEqual(expect.arrayContaining(["Edge"]));
    expect(detectOptions).not.toContain("Paddle Detect");

    await setTomSelectByLabel(page, "service-detect-select", "Paddle");
    await setTomSelectByLabel(page, "service-ocr-select", "Paddle");
    await setTomSelectByLabel(page, "service-tts-select", "Edge");

    await page.locator("#btn-launch-selected-services").click();

    await waitForChip(page, "service-detect-status-chip", "Running", 20 * 60_000);
    await waitForChip(page, "service-ocr-status-chip", "Running", 20 * 60_000);
    await waitForChip(page, "service-tts-status-chip", "Running", 20 * 60_000);

    await expect.poll(async () => await inputValue(page, "detector-url"), { timeout: 120000 }).toContain("127.0.0.1");
    await expect.poll(async () => await inputValue(page, "llm-url"), { timeout: 120000 }).toContain("127.0.0.1");
    await expect.poll(async () => await inputValue(page, "tts-url"), { timeout: 120000 }).toContain("127.0.0.1");

    const detectorUrl = await inputValue(page, "detector-url");
    const ocrUrl = await inputValue(page, "llm-url");
    const ttsUrl = await inputValue(page, "tts-url");
    const imageBytes = fs.readFileSync(sampleImagePath);
    const imageDataUrl = `data:image/png;base64,${imageBytes.toString("base64")}`;

    const detectForm = new FormData();
    detectForm.set("image", new Blob([imageBytes], { type: "image/png" }), "test.png");
    const detectResponse = await fetch(`${detectorUrl}/v1/detect`, {
      method: "POST",
      body: detectForm
    });
    expect(detectResponse.ok).toBeTruthy();
    const detectPayload = await detectResponse.json() as { boxes?: unknown };
    expect(Array.isArray(detectPayload.boxes)).toBeTruthy();

    const ocrModelsResponse = await fetch(`${ocrUrl}/models`);
    expect(ocrModelsResponse.ok).toBeTruthy();
    const ocrModelsPayload = await ocrModelsResponse.json() as { data?: Array<{ id?: string }> };
    const ocrModel = ocrModelsPayload.data?.[0]?.id ?? "paddleocr";

    const ocrResponse = await fetch(`${ocrUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: ocrModel,
        messages: [
          {
            role: "user",
            content: [
              { type: "input_text", text: "Extract the visible text from this image." },
              { type: "input_image", image_url: imageDataUrl }
            ]
          }
        ]
      })
    });
    expect(ocrResponse.ok).toBeTruthy();
    const ocrPayload = await ocrResponse.json() as { choices?: Array<{ message?: { content?: unknown } }> };
    expect(typeof ocrPayload.choices?.[0]?.message?.content).toBe("string");

    const ttsModelsResponse = await fetch(`${ttsUrl}/models`);
    expect(ttsModelsResponse.ok).toBeTruthy();
    const ttsModelsPayload = await ttsModelsResponse.json() as { data?: Array<{ id?: string }> };
    const ttsModel = ttsModelsPayload.data?.[0]?.id ?? "edge-tts";

    const ttsVoicesResponse = await fetch(`${ttsUrl}/voices`);
    expect(ttsVoicesResponse.ok).toBeTruthy();
    const ttsVoicesPayload = await ttsVoicesResponse.json() as { voices?: Array<{ id?: string }> };
    const ttsVoice = ttsVoicesPayload.voices?.[0]?.id ?? "en-US-AriaNeural";

    const ttsResponse = await fetch(`${ttsUrl}/audio/speech`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: ttsModel,
        input: "Launcher integration test",
        voice: ttsVoice
      })
    });
    expect(ttsResponse.ok).toBeTruthy();
    const ttsAudio = Buffer.from(await ttsResponse.arrayBuffer());
    expect(ttsAudio.byteLength).toBeGreaterThan(256);

    await page.locator("#btn-stop-selected-services").click();
    await waitForChip(page, "service-detect-status-chip", "Stopped", 120000);
    await waitForChip(page, "service-ocr-status-chip", "Stopped", 120000);
    await waitForChip(page, "service-tts-status-chip", "Stopped", 120000);
  } finally {
    await app.close();
  }
});
import { GoogleGenAI } from "@google/genai";
import type {
  ProviderAudioResult,
  ProviderLlmConfig,
  ProviderOption,
  ProviderTextResult,
  ProviderTtsConfig
} from "./provider-ipc.js";

const GEMINI_TTS_VOICES = [
  "Zephyr",
  "Puck",
  "Charon",
  "Kore",
  "Fenrir",
  "Leda",
  "Orus",
  "Aoede",
  "Callirrhoe",
  "Autonoe",
  "Enceladus",
  "Iapetus",
  "Umbriel",
  "Algieba",
  "Despina",
  "Erinome",
  "Algenib",
  "Rasalgethi",
  "Laomedeia",
  "Achernar",
  "Alnilam",
  "Schedar",
  "Gacrux",
  "Pulcherrima",
  "Achird",
  "Zubenelgenubi",
  "Vindemiatrix",
  "Sadachbia",
  "Sadaltager",
  "Sulafat"
] as const;

function createClient(apiKey: string): GoogleGenAI {
  return new GoogleGenAI({ apiKey });
}

function parseDataUrl(dataUrl: string): { mimeType: string; data: string } {
  const match = /^data:([^;,]+)?(?:;charset=[^;,]+)?;base64,(.*)$/s.exec(dataUrl);
  if (!match) {
    throw new Error("Invalid image data URL");
  }
  return {
    mimeType: match[1] || "image/png",
    data: match[2] ?? ""
  };
}

function normalizeGeminiModel(model: string): string {
  return model.trim();
}

function buildThinkingConfig(
  model: string,
  thinkingMode: "provider_default" | "low" | "off" | undefined
): { thinkingBudget: number } | undefined {
  if (thinkingMode === "provider_default") {
    return undefined;
  }
  if (thinkingMode === "low") {
    return { thinkingBudget: 1024 };
  }
  const normalized = model.trim().toLowerCase();
  if (normalized.includes("gemini-2.5")) {
    return { thinkingBudget: 0 };
  }
  return undefined;
}

function buildWaveBuffer(pcmBytes: Uint8Array, sampleRate = 24000, channels = 1, bytesPerSample = 2): Uint8Array {
  const dataLength = pcmBytes.byteLength;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);
  const output = new Uint8Array(buffer);
  let offset = 0;

  const writeString = (value: string): void => {
    for (let i = 0; i < value.length; i += 1) {
      view.setUint8(offset, value.charCodeAt(i));
      offset += 1;
    }
  };

  writeString("RIFF");
  view.setUint32(offset, 36 + dataLength, true);
  offset += 4;
  writeString("WAVE");
  writeString("fmt ");
  view.setUint32(offset, 16, true);
  offset += 4;
  view.setUint16(offset, 1, true);
  offset += 2;
  view.setUint16(offset, channels, true);
  offset += 2;
  view.setUint32(offset, sampleRate, true);
  offset += 4;
  view.setUint32(offset, sampleRate * channels * bytesPerSample, true);
  offset += 4;
  view.setUint16(offset, channels * bytesPerSample, true);
  offset += 2;
  view.setUint16(offset, bytesPerSample * 8, true);
  offset += 2;
  writeString("data");
  view.setUint32(offset, dataLength, true);
  offset += 4;
  output.set(pcmBytes, offset);
  return output;
}

export class GeminiSdkLlmService {
  async extractTextFromImage(
    dataUrl: string,
    config: ProviderLlmConfig
  ): Promise<ProviderTextResult> {
    const image = parseDataUrl(dataUrl);
    const thinkingConfig = buildThinkingConfig(config.model, config.thinkingMode);
    const response = await createClient(config.apiKey).models.generateContent({
      model: normalizeGeminiModel(config.model),
      contents: [
        {
          role: "user",
          parts: [
            { text: config.promptTemplate },
            { inlineData: image }
          ]
        }
      ],
      config: {
        maxOutputTokens: config.maxTokens,
        ...(thinkingConfig ? { thinkingConfig } : {})
      }
    });

    const text = response.text?.trim() ?? "";
    if (!text) {
      throw new Error("OCR produced empty text");
    }
    return { text };
  }

  async extractTextFromImageStream(
    dataUrl: string,
    config: ProviderLlmConfig,
    options?: { onToken?: (token: string) => void }
  ): Promise<ProviderTextResult> {
    const image = parseDataUrl(dataUrl);
    const thinkingConfig = buildThinkingConfig(config.model, config.thinkingMode);
    const stream = await createClient(config.apiKey).models.generateContentStream({
      model: normalizeGeminiModel(config.model),
      contents: [
        {
          role: "user",
          parts: [
            { text: config.promptTemplate },
            { inlineData: image }
          ]
        }
      ],
      config: {
        maxOutputTokens: config.maxTokens,
        ...(thinkingConfig ? { thinkingConfig } : {})
      }
    });

    let fullText = "";
    for await (const chunk of stream) {
      const token = chunk.text ?? "";
      if (!token) continue;
      fullText += token;
      options?.onToken?.(token);
    }

    const text = fullText.trim();
    if (!text) {
      throw new Error("OCR produced empty text");
    }
    return { text };
  }
}

export class GeminiSdkTtsService {
  async synthesize(
    text: string,
    config: ProviderTtsConfig
  ): Promise<ProviderAudioResult> {
    const response = await createClient(config.apiKey).models.generateContent({
      model: normalizeGeminiModel(config.model),
      contents: [{ parts: [{ text }] }],
      config: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: config.voice
            }
          }
        }
      }
    });

    const base64Data = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data ?? "";
    if (!base64Data) {
      throw new Error("Gemini TTS produced no audio");
    }
    const pcmBytes = Uint8Array.from(Buffer.from(base64Data, "base64"));
    const wavBytes = buildWaveBuffer(pcmBytes);
    return {
      audioBytes: wavBytes,
      mimeType: "audio/wav"
    };
  }
}

export async function fetchGeminiModels(apiKey: string, kind: "ocr" | "tts"): Promise<ProviderOption[]> {
  const pager = await createClient(apiKey).models.list();
  const options: ProviderOption[] = [];

  for await (const model of pager) {
    const name = model.name?.trim();
    if (!name?.startsWith("models/")) continue;
    const isTts = name.toLowerCase().includes("tts");
    const supportsGenerateContent = model.supportedActions?.includes("generateContent") ?? true;
    if (!supportsGenerateContent) continue;
    if (kind === "tts" && !isTts) continue;
    if (kind === "ocr" && isTts) continue;
    options.push({ value: name, label: name });
  }

  return options.sort((a, b) => a.label.localeCompare(b.label));
}

export function fetchGeminiVoices(): ProviderOption[] {
  return GEMINI_TTS_VOICES.map((voice) => ({ value: voice, label: voice }));
}

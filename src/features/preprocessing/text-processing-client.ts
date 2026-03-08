import type { DetectResponse, RawBox } from "./types";
import { dataUrlToBlob } from "../../core/utils/data-url";
import { loggers } from "../../core/logging";

function normalizeServerUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

export interface TextProcessingHealth {
  ok: boolean;
  detector?: string;
  features?: {
    detect?: boolean;
    openai_ocr?: boolean;
  };
}

export async function checkTextProcessingHealth(baseUrl: string): Promise<TextProcessingHealth> {
  const res = await fetch(`${normalizeServerUrl(baseUrl)}/healthz`);
  if (!res.ok) return { ok: false };
  return (await res.json()) as TextProcessingHealth;
}

export async function detectRawBoxes(
  baseUrl: string,
  imageDataUrl: string,
  options?: { signal?: AbortSignal }
): Promise<{ boxes: RawBox[]; metrics?: DetectResponse["metrics"] }> {
  const endpoint = `${normalizeServerUrl(baseUrl)}/v1/detect`;
  const done = loggers.api.time("text-processing.detect");
  loggers.api.info("Text detect started", { endpoint, imageBytes: imageDataUrl.length });
  const blob = dataUrlToBlob(imageDataUrl);
  const form = new FormData();
  form.append("image", blob, "processed.png");
  form.append("settings", JSON.stringify({ detector: { include_polygons: false } }));

  const req: RequestInit = { method: "POST", body: form };
  if (options?.signal) req.signal = options.signal;
  try {
    const res = await fetch(endpoint, req);
    const data = (await res.json()) as DetectResponse;
    if (!res.ok || data.status !== "success") {
      const errorText = data.error?.message ?? `Detect failed: HTTP ${res.status}`;
      loggers.api.error("Text detect failed", { endpoint, error: errorText });
      throw new Error(errorText);
    }
    done();
    loggers.api.info("Text detect completed", { endpoint, rawCount: data.raw_boxes?.length ?? 0 });
    return { boxes: data.raw_boxes ?? [], metrics: data.metrics };
  } catch (error) {
    const text = String((error as { message?: unknown })?.message ?? error).toLowerCase();
    if (text.includes("abort") || text.includes("cancel")) {
      loggers.api.info("Text detect cancelled", { endpoint });
      throw new Error("Cancelled");
    }
    throw error;
  }
}

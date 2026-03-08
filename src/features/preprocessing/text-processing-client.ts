import type { DetectResponse, RawBox } from "./types";
import { dataUrlToBlob } from "../../core/utils/data-url";
import { loggers } from "../../core/logging";

function normalizeServerUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

export async function checkTextProcessingHealth(baseUrl: string): Promise<{ ok: boolean; detector?: string }> {
  const res = await fetch(`${normalizeServerUrl(baseUrl)}/healthz`);
  if (!res.ok) return { ok: false };
  return (await res.json()) as { ok: boolean; detector?: string };
}

export async function detectRawBoxes(
  baseUrl: string,
  imageDataUrl: string,
  options?: { signal?: AbortSignal; provider?: string }
): Promise<{ boxes: RawBox[]; metrics?: DetectResponse["metrics"] }> {
  const endpoint = `${normalizeServerUrl(baseUrl)}/v1/detect`;
  const provider = options?.provider ?? "text-processing";
  const done = loggers.api.time(`${provider}.detect`);
  loggers.api.info("Text detect started", { endpoint, provider, imageBytes: imageDataUrl.length });
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
      loggers.api.error("Text detect failed", { endpoint, provider, error: errorText });
      throw new Error(errorText);
    }
    done();
    loggers.api.info("Text detect completed", { endpoint, provider, rawCount: data.raw_boxes?.length ?? 0 });
    return { boxes: data.raw_boxes ?? [], metrics: data.metrics };
  } catch (error) {
    const text = String((error as { message?: unknown })?.message ?? error).toLowerCase();
    if (text.includes("abort") || text.includes("cancel")) {
      loggers.api.info("Text detect cancelled", { endpoint, provider });
      throw new Error("Cancelled");
    }
    throw error;
  }
}

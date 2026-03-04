import type { DetectResponse, RawBox } from "./types";
import { dataUrlToBlob } from "../../core/utils/data-url";

function normalizeServerUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

export async function checkRapidHealth(baseUrl: string): Promise<{ ok: boolean; detector?: string }> {
  const res = await fetch(`${normalizeServerUrl(baseUrl)}/healthz`);
  if (!res.ok) return { ok: false };
  return (await res.json()) as { ok: boolean; detector?: string };
}

export async function detectRapidRawBoxes(baseUrl: string, imageDataUrl: string): Promise<{ boxes: RawBox[]; metrics?: DetectResponse["metrics"] }> {
  const blob = dataUrlToBlob(imageDataUrl);
  const form = new FormData();
  form.append("image", blob, "processed.png");
  form.append("settings", JSON.stringify({ detector: { include_polygons: false } }));

  const res = await fetch(`${normalizeServerUrl(baseUrl)}/v1/detect`, { method: "POST", body: form });
  const data = (await res.json()) as DetectResponse;
  if (!res.ok || data.status !== "success") {
    throw new Error(data.error?.message ?? `Rapid detect failed: HTTP ${res.status}`);
  }
  return { boxes: data.raw_boxes ?? [], metrics: data.metrics };
}

import type { DrawRect, PreprocessSettings } from "./types";
import { dataUrlToBlob } from "../../core/utils/data-url";

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

export async function normalizeImageDataUrl(inputDataUrl: string): Promise<string> {
  const blob = dataUrlToBlob(inputDataUrl);
  const source = await createImageBitmap(blob, { imageOrientation: "from-image" });
  const canvas = document.createElement("canvas");
  canvas.width = source.width;
  canvas.height = source.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas context unavailable");
  ctx.drawImage(source, 0, 0);
  source.close();
  return canvas.toDataURL("image/png");
}

export async function applyPreprocessToDataUrl(dataUrl: string, settings: PreprocessSettings): Promise<string> {
  const blob = dataUrlToBlob(dataUrl);
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas context unavailable");
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = imgData.data;
  for (let i = 0; i < d.length; i += 4) {
    let r = d[i] ?? 0;
    let g = d[i + 1] ?? 0;
    let b = d[i + 2] ?? 0;

    r = (r - 128) * settings.contrast + 128 + settings.brightness;
    g = (g - 128) * settings.contrast + 128 + settings.brightness;
    b = (b - 128) * settings.contrast + 128 + settings.brightness;

    r = clamp(r, 0, 255);
    g = clamp(g, 0, 255);
    b = clamp(b, 0, 255);

    if (settings.binaryThreshold > 0) {
      const y = 0.299 * r + 0.587 * g + 0.114 * b;
      const v = y >= settings.binaryThreshold ? 255 : 0;
      r = v;
      g = v;
      b = v;
    }

    if (settings.invert) {
      r = 255 - r;
      g = 255 - g;
      b = 255 - b;
    }

    d[i] = r;
    d[i + 1] = g;
    d[i + 2] = b;
  }

  if (settings.dilation !== 0) {
    applyMorphology(imgData, canvas.width, canvas.height, settings.dilation);
  }

  ctx.putImageData(imgData, 0, 0);
  return canvas.toDataURL("image/png");
}

function applyMorphology(imgData: ImageData, width: number, height: number, dilation: number): void {
  const iterations = Math.min(5, Math.abs(Math.trunc(dilation)));
  if (iterations === 0) return;
  const isDilate = dilation > 0;

  for (let iter = 0; iter < iterations; iter += 1) {
    const src = new Uint8ClampedArray(imgData.data);
    const dst = imgData.data;

    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        let best = isDilate ? 0 : 255;
        for (let ky = -1; ky <= 1; ky += 1) {
          for (let kx = -1; kx <= 1; kx += 1) {
            const idx = ((y + ky) * width + (x + kx)) * 4;
            const v = src[idx] ?? 0;
            if (isDilate) best = Math.max(best, v);
            else best = Math.min(best, v);
          }
        }
        const out = (y * width + x) * 4;
        dst[out] = best;
        dst[out + 1] = best;
        dst[out + 2] = best;
      }
    }
  }
}

export async function scaleDataUrlMaxDimension(dataUrl: string, maxDim: number): Promise<string> {
  const blob = dataUrlToBlob(dataUrl);
  const bitmap = await createImageBitmap(blob);
  const w = bitmap.width;
  const h = bitmap.height;
  const maxCurrent = Math.max(w, h);
  if (maxCurrent <= maxDim || maxDim <= 0) {
    bitmap.close();
    return dataUrl;
  }
  const scale = maxDim / maxCurrent;
  const tw = Math.max(1, Math.round(w * scale));
  const th = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement("canvas");
  canvas.width = tw;
  canvas.height = th;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    throw new Error("Canvas context unavailable");
  }
  ctx.drawImage(bitmap, 0, 0, tw, th);
  bitmap.close();
  return canvas.toDataURL("image/png");
}

export async function cropNormalizedRect(dataUrl: string, rect: DrawRect): Promise<string> {
  const blob = dataUrlToBlob(dataUrl);
  const bitmap = await createImageBitmap(blob);
  const x = Math.max(0, Math.floor(rect.nx * bitmap.width));
  const y = Math.max(0, Math.floor(rect.ny * bitmap.height));
  const w = Math.max(1, Math.floor(rect.nw * bitmap.width));
  const h = Math.max(1, Math.floor(rect.nh * bitmap.height));

  const cw = Math.min(bitmap.width - x, w);
  const ch = Math.min(bitmap.height - y, h);
  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    throw new Error("Canvas context unavailable");
  }
  ctx.drawImage(bitmap, x, y, cw, ch, 0, 0, cw, ch);
  bitmap.close();
  return canvas.toDataURL("image/png");
}

import { dataUrlToBlob } from "./data-url";

export interface NormalizedRect {
  nx: number;
  ny: number;
  nw: number;
  nh: number;
}

export async function cropNormalizedDataUrl(dataUrl: string, rect: NormalizedRect): Promise<string> {
  const blob = dataUrlToBlob(dataUrl);
  const bitmap = await createImageBitmap(blob);
  const x = Math.max(0, Math.floor(rect.nx * bitmap.width));
  const y = Math.max(0, Math.floor(rect.ny * bitmap.height));
  const w = Math.max(1, Math.floor(rect.nw * bitmap.width));
  const h = Math.max(1, Math.floor(rect.nh * bitmap.height));
  const cw = Math.min(w, Math.max(1, bitmap.width - x));
  const ch = Math.min(h, Math.max(1, bitmap.height - y));
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

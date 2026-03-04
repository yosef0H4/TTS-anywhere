import type { DetectionFilterSettings, DrawRect, FilteredBox, MergeGroup, MergeSettings, RawBox, ReadingDirection, SelectionOp, SortingSettings } from "./types";

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] ?? 0 : ((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2;
}

function isSelected(nx: number, ny: number, baseState: boolean, ops: SelectionOp[]): boolean {
  let selected = baseState;
  for (const op of ops) {
    const hit = nx >= op.nx && nx <= op.nx + op.nw && ny >= op.ny && ny <= op.ny + op.nh;
    if (!hit) continue;
    selected = op.op === "add";
  }
  return selected;
}

export function selectionKeepRatio(box: RawBox, imageW: number, imageH: number, baseState: boolean, ops: SelectionOp[]): number {
  const w = Math.max(1, box.px.x2 - box.px.x1);
  const h = Math.max(1, box.px.y2 - box.px.y1);
  const stepX = Math.max(1, Math.floor(w / 8));
  const stepY = Math.max(1, Math.floor(h / 8));
  let keep = 0;
  let total = 0;
  for (let y = box.px.y1; y < box.px.y2; y += stepY) {
    for (let x = box.px.x1; x < box.px.x2; x += stepX) {
      if (isSelected(x / Math.max(1, imageW), y / Math.max(1, imageH), baseState, ops)) keep += 1;
      total += 1;
    }
  }
  return total ? keep / total : 0;
}

export function filterBySize(boxes: RawBox[], imageW: number, imageH: number, p: DetectionFilterSettings): FilteredBox[] {
  const heights = boxes.map((b) => b.px.y2 - b.px.y1).filter((h) => h > 0);
  const med = median(heights);
  return boxes.map((box) => {
    const w = box.px.x2 - box.px.x1;
    const h = box.px.y2 - box.px.y1;
    const removedByHeight = p.minHeightRatio > 0 && h < imageH * p.minHeightRatio;
    const removedByWidth = p.minWidthRatio > 0 && w < imageW * p.minWidthRatio;
    const removedByMedian = med > 0 && h < med * p.medianHeightFraction && w < med * 2;
    const keep = !(removedByHeight || removedByWidth || removedByMedian);
    return { box, keep, removedBy: { width: removedByWidth, height: removedByHeight, median: removedByMedian } };
  });
}

export function sortByReadingOrder(boxes: RawBox[], sorting: SortingSettings): RawBox[] {
  if (boxes.length <= 1) return [...boxes];
  const direction = sorting.direction;
  const horizontal = direction.startsWith("horizontal");
  const reverse = direction.endsWith("rtl");

  const primaryStart = horizontal ? "y1" : "x1";
  const primaryEnd = horizontal ? "y2" : "x2";
  const secondaryStart = horizontal ? "x1" : "y1";

  const bandMeasure = boxes.map((b) => b.px[primaryEnd] - b.px[primaryStart]);
  const band = Math.max(1, (sorting.groupTolerance || 0.5) * (median(bandMeasure) || 30));

  const sortedPrimary = [...boxes].sort((a, b) => a.px[primaryStart] - b.px[primaryStart]);
  const groups: RawBox[][] = [];
  let current: RawBox[] = [];
  let center = -1000;

  for (const box of sortedPrimary) {
    const c = (box.px[primaryStart] + box.px[primaryEnd]) / 2;
    if (current.length && Math.abs(c - center) <= band) {
      current.push(box);
      center = current.map((v) => (v.px[primaryStart] + v.px[primaryEnd]) / 2).reduce((a, b) => a + b, 0) / current.length;
      continue;
    }
    if (current.length) groups.push(current);
    current = [box];
    center = c;
  }
  if (current.length) groups.push(current);

  const out: RawBox[] = [];
  for (const group of groups) {
    group.sort((a, b) => (reverse ? b.px[secondaryStart] - a.px[secondaryStart] : a.px[secondaryStart] - b.px[secondaryStart]));
    out.push(...group);
  }
  return out;
}

export function mergeCloseBoxes(boxes: RawBox[], merge: MergeSettings, imageW: number, imageH: number): MergeGroup[] {
  if (!boxes.length) return [];
  const used = new Array(boxes.length).fill(false);
  const out: MergeGroup[] = [];

  const canMerge = (a: RawBox, b: RawBox): boolean => {
    const h1 = a.px.y2 - a.px.y1;
    const h2 = b.px.y2 - b.px.y1;
    const minH = Math.min(h1, h2);
    const refH = (h1 + h2) / 2;

    const maxVGap = refH * merge.mergeVerticalRatio;
    const maxHGap = refH * merge.mergeHorizontalRatio;

    const yOverlap = Math.max(0, Math.min(a.px.y2, b.px.y2) - Math.max(a.px.y1, b.px.y1));
    if (yOverlap > minH * 0.5) {
      const gap = Math.max(a.px.x1, b.px.x1) - Math.min(a.px.x2, b.px.x2);
      if (gap < maxHGap) return true;
    }

    const vGap = Math.max(a.px.y1, b.px.y1) - Math.min(a.px.y2, b.px.y2);
    if (vGap < maxVGap) {
      const xOverlap = Math.max(0, Math.min(a.px.x2, b.px.x2) - Math.max(a.px.x1, b.px.x1));
      const alignTol = refH * 0.5;
      if (xOverlap > 0 || Math.abs(a.px.x1 - b.px.x1) < alignTol) {
        const w1 = a.px.x2 - a.px.x1;
        const w2 = b.px.x2 - b.px.x1;
        if (!w1 || !w2) return true;
        const ratio = Math.min(w1, w2) / Math.max(w1, w2);
        return ratio >= merge.mergeWidthRatioThreshold;
      }
    }
    return false;
  };

  for (let i = 0; i < boxes.length; i += 1) {
    if (used[i]) continue;
    used[i] = true;
    const seed = boxes[i];
    if (!seed) continue;
    const group: RawBox[] = [seed];
    let changed = true;

    while (changed) {
      changed = false;
      for (let j = 0; j < boxes.length; j += 1) {
        if (used[j]) continue;
        const candidate = boxes[j];
        if (!candidate) continue;
        if (group.some((g) => canMerge(g, candidate))) {
          used[j] = true;
          group.push(candidate);
          changed = true;
        }
      }
    }

    const x1 = Math.min(...group.map((g) => g.px.x1));
    const y1 = Math.min(...group.map((g) => g.px.y1));
    const x2 = Math.max(...group.map((g) => g.px.x2));
    const y2 = Math.max(...group.map((g) => g.px.y2));
    const rect: RawBox = {
      id: crypto.randomUUID(),
      px: { x1, y1, x2, y2 },
      norm: {
        x: x1 / Math.max(1, imageW),
        y: y1 / Math.max(1, imageH),
        w: (x2 - x1) / Math.max(1, imageW),
        h: (y2 - y1) / Math.max(1, imageH)
      }
    };
    out.push({ rect, members: group });
  }

  return out;
}

export function manualToRaw(box: DrawRect, imageW: number, imageH: number): RawBox {
  const x1 = Math.round(box.nx * imageW);
  const y1 = Math.round(box.ny * imageH);
  const x2 = Math.round((box.nx + box.nw) * imageW);
  const y2 = Math.round((box.ny + box.nh) * imageH);
  return {
    id: box.id,
    norm: { x: box.nx, y: box.ny, w: box.nw, h: box.nh },
    px: { x1, y1, x2, y2 }
  };
}

export function finalizeOcrBoxes(params: {
  rapidRawBoxes: RawBox[];
  manualBoxes: DrawRect[];
  baseState: boolean;
  ops: SelectionOp[];
  imageW: number;
  imageH: number;
  filter: DetectionFilterSettings;
  sorting: SortingSettings;
  merge: MergeSettings;
}): DrawRect[] {
  const selectedRapid = params.rapidRawBoxes.filter((b) => selectionKeepRatio(b, params.imageW, params.imageH, params.baseState, params.ops) > 0.1);
  const filteredRapid = filterBySize(selectedRapid, params.imageW, params.imageH, params.filter).filter((f) => f.keep).map((f) => f.box);

  const manualRaw = params.manualBoxes.map((m) => manualToRaw(m, params.imageW, params.imageH));
  const input = sortByReadingOrder([...filteredRapid, ...manualRaw], params.sorting);
  const merged = mergeCloseBoxes(input, params.merge, params.imageW, params.imageH);

  const boxes = (merged.length ? merged.map((m) => m.rect) : input).map((b) => ({
    id: b.id,
    nx: b.norm.x,
    ny: b.norm.y,
    nw: b.norm.w,
    nh: b.norm.h
  }));

  return sortByReadingOrder(boxes.map((b) => ({
    id: b.id,
    norm: { x: b.nx, y: b.ny, w: b.nw, h: b.nh },
    px: {
      x1: Math.round(b.nx * params.imageW),
      y1: Math.round(b.ny * params.imageH),
      x2: Math.round((b.nx + b.nw) * params.imageW),
      y2: Math.round((b.ny + b.nh) * params.imageH)
    }
  })), params.sorting).map((b) => ({ id: b.id, nx: b.norm.x, ny: b.norm.y, nw: b.norm.w, nh: b.norm.h }));
}

export function sanitizeRect<T extends { nx: number; ny: number; nw: number; nh: number }>(rect: T): T {
  const nx = Math.max(0, Math.min(1, rect.nx));
  const ny = Math.max(0, Math.min(1, rect.ny));
  const nw = Math.max(0, Math.min(1 - nx, rect.nw));
  const nh = Math.max(0, Math.min(1 - ny, rect.nh));
  return { ...rect, nx, ny, nw, nh };
}

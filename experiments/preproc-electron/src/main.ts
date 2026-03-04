import { createIcons, icons } from "lucide";
import "./styles.css";

type Primitive = string | number | boolean;
type OverlayMode = "committed" | "filter-preview" | "merge-preview";
type ReadingDirection = "horizontal_ltr" | "horizontal_rtl" | "vertical_ltr" | "vertical_rtl";

type PreprocessingSettings = {
  binary_threshold: number;
  invert: boolean;
  dilation: number;
  contrast: number;
  brightness: number;
};

type PostprocessSettings = {
  min_width_ratio: number;
  min_height_ratio: number;
  median_height_fraction: number;
  merge_vertical_ratio: number;
  merge_horizontal_ratio: number;
  merge_width_ratio_threshold: number;
  group_tolerance: number;
  direction: ReadingDirection;
};

type DetectRequest = {
  detector: { include_polygons: boolean };
};

type RawBox = {
  id: string;
  norm: { x: number; y: number; w: number; h: number };
  px: { x1: number; y1: number; x2: number; y2: number };
  polygon?: Array<[number, number]> | null;
};

type DetectResponse = {
  status: "success" | "error";
  request_id?: string;
  image?: { width: number; height: number };
  raw_boxes?: RawBox[];
  metrics?: { detect_ms: number; total_ms: number; raw_count: number };
  error?: { code: string; message: string };
};

type RenderedBox = {
  id: string;
  norm: { x: number; y: number; w: number; h: number };
  rendered: { left: number; top: number; width: number; height: number };
};

type BoxFilterResult = {
  box: RawBox;
  keep: boolean;
};

type MergeGroup = {
  rect: RawBox;
  members: RawBox[];
};

type LabState = {
  preprocess: PreprocessingSettings;
  postprocess: PostprocessSettings;
  image: {
    naturalWidth: number;
    naturalHeight: number;
    displayWidth: number;
    displayHeight: number;
    left: number;
    top: number;
  } | null;
  rawCount: number;
  liveCount: number;
  filteredCount: number;
  mergedCount: number;
  direction: ReadingDirection;
  overlayMode: OverlayMode;
  overlayLayersActive: string[];
  boxes: RenderedBox[];
  metrics: { detect_ms: number; total_ms: number; raw_count: number; live_count: number } | null;
  status: string;
  serverUrl: string;
  pendingDetect: boolean;
};

type ElectronAPI = {
  startPythonServer: () => Promise<{ ok: boolean; message: string }>;
  stopPythonServer: () => Promise<{ ok: boolean; message: string }>;
};

type LabAPI = {
  health: () => Promise<{ ok: boolean; detector?: string }>;
  setServerUrl: (url: string) => void;
  loadFixture: (name: string) => Promise<void>;
  loadImageBlob: (blob: Blob) => Promise<void>;
  set: (controlId: string, value: Primitive) => void;
  batchSet: (values: Record<string, Primitive>) => void;
  redetectNow: () => Promise<void>;
  recomputeBoxesNow: () => void;
  getState: () => LabState;
  assertNoOffCanvasBoxes: () => { ok: boolean; offenders: string[] };
  reset: () => void;
};

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
    lab: LabAPI;
  }
}

const DEFAULT_SERVER_URL = localStorage.getItem("preproc:serverUrl") ?? "http://127.0.0.1:8091";
const FIXTURE_BASE = "/fixtures";
const PREPROCESS_CONTROL_IDS = ["binary-threshold", "contrast", "brightness", "dilation", "invert"] as const;
const FILTER_PREVIEW_IDS = ["min-width-ratio", "min-height-ratio", "median-height-fraction"] as const;
const MERGE_PREVIEW_IDS = ["merge-vertical-ratio", "merge-horizontal-ratio", "merge-width-ratio-threshold", "group-tolerance", "reading-direction"] as const;

let originalImageBitmap: ImageBitmap | null = null;
let previewObjectUrl: string | null = null;

let rawBoxes: RawBox[] = [];
let filterResults: BoxFilterResult[] = [];
let mergedGroups: MergeGroup[] = [];
let liveBoxes: RawBox[] = [];
let renderedBoxes: RenderedBox[] = [];
let currentMetrics: { detect_ms: number; total_ms: number; raw_count: number; live_count: number } | null = null;
let currentStatus = "idle";
let preprocessTimer: number | null = null;
let overlayMode: OverlayMode = "committed";
let overlayModeTimer: number | null = null;
let currentDetectSeq = 0;
let pendingDetect = false;
let activeLayers: string[] = [];

const app = mustEl<HTMLDivElement>(document.querySelector("#app"), "App root not found");
app.innerHTML = `
<div class="layout" data-testid="layout-root">
  <aside class="sidebar" data-testid="sidebar">
    <h1>Preprocessing Lab</h1>
    <p class="sub">Electron UI + Python RapidOCR server</p>

    <section>
      <label for="server-url">Server URL</label>
      <div class="row">
        <input data-testid="server-url" id="server-url" type="text" value="${DEFAULT_SERVER_URL}">
        <button data-testid="btn-health" id="btn-health">Health</button>
      </div>
      <div class="row">
        <button data-testid="btn-server-start" id="btn-server-start">Start Py</button>
        <button data-testid="btn-server-stop" id="btn-server-stop">Stop Py</button>
      </div>
      <div data-testid="server-status" id="server-status" class="status">Status: idle</div>
    </section>

    <section>
      <label for="image-upload">Image Input</label>
      <input data-testid="image-upload" id="image-upload" type="file" accept="image/png,image/jpeg,image/webp">
      <div class="hint">Tip: paste image with Ctrl+V</div>
      <div class="row"><button data-testid="btn-clear" id="btn-clear">Clear</button></div>
    </section>

    <section>
      <h2>Preprocessing (re-run OCR)</h2>
      <p class="hint">These sliders change the image itself, then run model detection again.</p>
      <label>Binary Threshold <span data-testid="val-threshold" id="val-threshold"></span></label>
      <input data-testid="binary-threshold" id="binary-threshold" type="range" min="0" max="255" step="1" value="0">

      <label>Contrast <span data-testid="val-contrast" id="val-contrast"></span></label>
      <input data-testid="contrast" id="contrast" type="range" min="0.2" max="3" step="0.1" value="1">

      <label>Brightness <span data-testid="val-brightness" id="val-brightness"></span></label>
      <input data-testid="brightness" id="brightness" type="range" min="-100" max="100" step="1" value="0">

      <label>Dilation/Erosion <span data-testid="val-dilation" id="val-dilation"></span></label>
      <input data-testid="dilation" id="dilation" type="range" min="-5" max="5" step="1" value="0">

      <label class="checkbox-row"><input data-testid="invert" id="invert" type="checkbox">Invert</label>
    </section>

    <section>
      <h2>Detection Filter (live)</h2>
      <p class="hint">Green boxes survive filtering. Red dashed boxes are discarded as noise.</p>
      <label>Min Width Ratio <span data-testid="val-min-width-ratio" id="val-min-width-ratio"></span></label>
      <input data-testid="min-width-ratio" id="min-width-ratio" type="range" min="0" max="0.1" step="0.001" value="0">

      <label>Min Height Ratio <span data-testid="val-min-height-ratio" id="val-min-height-ratio"></span></label>
      <input data-testid="min-height-ratio" id="min-height-ratio" type="range" min="0" max="0.1" step="0.001" value="0">

      <label>Median Height Fraction <span data-testid="val-median-height" id="val-median-height"></span></label>
      <input data-testid="median-height-fraction" id="median-height-fraction" type="range" min="0.1" max="1.2" step="0.05" value="0.45">
    </section>

    <section>
      <h2>Merging + Ordering (live)</h2>
      <p class="hint">Yellow zones, cyan bars, and magenta arrows explain why boxes merge and in what order.</p>
      <label>Reading Direction</label>
      <select data-testid="reading-direction" id="reading-direction">
        <option value="horizontal_ltr">Horizontal LTR</option>
        <option value="horizontal_rtl">Horizontal RTL</option>
        <option value="vertical_ltr">Vertical LTR</option>
        <option value="vertical_rtl">Vertical RTL</option>
      </select>

      <label>Merge Vertical Ratio <span data-testid="val-merge-v" id="val-merge-v"></span></label>
      <input data-testid="merge-vertical-ratio" id="merge-vertical-ratio" type="range" min="0" max="1" step="0.01" value="0.07">

      <label>Merge Horizontal Ratio <span data-testid="val-merge-h" id="val-merge-h"></span></label>
      <input data-testid="merge-horizontal-ratio" id="merge-horizontal-ratio" type="range" min="0" max="2" step="0.01" value="0.37">

      <label>Merge Width Ratio Threshold <span data-testid="val-merge-w" id="val-merge-w"></span></label>
      <input data-testid="merge-width-ratio-threshold" id="merge-width-ratio-threshold" type="range" min="0" max="1" step="0.01" value="0.75">

      <label>Group Tolerance <span data-testid="val-group-tolerance" id="val-group-tolerance"></span></label>
      <input data-testid="group-tolerance" id="group-tolerance" type="range" min="0.1" max="1.2" step="0.01" value="0.5">
    </section>

    <section>
      <div class="legend" data-testid="overlay-legend">
        <span class="chip chip-blue">Merged</span>
        <span class="chip chip-green">Keep</span>
        <span class="chip chip-red">Discard</span>
        <span class="chip chip-yellow">Tolerance</span>
        <span class="chip chip-cyan">Ratio Bar</span>
        <span class="chip chip-magenta">Order Path</span>
      </div>
      <div class="row">
        <button data-testid="btn-detect" id="btn-detect" class="primary">Run Detection Now</button>
      </div>
      <h2>Metrics</h2>
      <pre data-testid="metrics" id="metrics">No run yet</pre>
    </section>

    <section>
      <div class="row"><button data-testid="btn-debug-refresh" id="btn-debug-refresh">Refresh Debug</button></div>
      <pre data-testid="debug-state" id="debug-state">No debug state yet</pre>
    </section>
  </aside>

  <main class="canvas-area" data-testid="paste-target" id="paste-target" tabindex="0">
    <div data-testid="empty" id="empty" class="empty"><i data-lucide="image-plus"></i><p>Upload or paste an image to start.</p></div>
    <div data-testid="viewer" id="viewer" class="viewer hidden">
      <img data-testid="preview" id="preview" alt="preview">
      <svg data-testid="overlay-svg" id="overlay-svg" class="overlay-svg"></svg>
      <div data-testid="overlay" id="overlay" class="overlay"></div>
    </div>
  </main>
</div>`;

createIcons({ icons });

const serverUrlEl = byId<HTMLInputElement>("server-url");
const serverStatusEl = byId<HTMLDivElement>("server-status");
const imageUploadEl = byId<HTMLInputElement>("image-upload");
const detectBtn = byId<HTMLButtonElement>("btn-detect");
const metricsEl = byId<HTMLElement>("metrics");
const debugStateEl = byId<HTMLElement>("debug-state");
const previewEl = byId<HTMLImageElement>("preview");
const overlayEl = byId<HTMLDivElement>("overlay");
const overlaySvgEl = byId<SVGSVGElement>("overlay-svg");
const viewerEl = byId<HTMLDivElement>("viewer");
const emptyEl = byId<HTMLDivElement>("empty");

serverUrlEl.addEventListener("change", () => localStorage.setItem("preproc:serverUrl", serverUrlEl.value.trim()));
byId<HTMLButtonElement>("btn-health").addEventListener("click", async () => {
  await checkHealth();
  refreshDebugState();
});
byId<HTMLButtonElement>("btn-server-start").addEventListener("click", async () => {
  if (!window.electronAPI) return;
  const res = await window.electronAPI.startPythonServer();
  setStatus(res.message);
  await new Promise((r) => setTimeout(r, 600));
  await checkHealth();
  refreshDebugState();
});
byId<HTMLButtonElement>("btn-server-stop").addEventListener("click", async () => {
  if (!window.electronAPI) return;
  const res = await window.electronAPI.stopPythonServer();
  setStatus(res.message);
  refreshDebugState();
});
byId<HTMLButtonElement>("btn-clear").addEventListener("click", () => {
  resetState();
  refreshDebugState();
});
byId<HTMLButtonElement>("btn-debug-refresh").addEventListener("click", refreshDebugState);

imageUploadEl.addEventListener("change", async () => {
  const file = imageUploadEl.files?.[0];
  if (file) {
    await loadOriginalImage(file);
    schedulePreprocessAndDetect();
  }
});

window.addEventListener("paste", async (event) => {
  const items = event.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) {
        await loadOriginalImage(file);
        setStatus("Pasted image from clipboard.");
        schedulePreprocessAndDetect();
      }
      break;
    }
  }
});

window.addEventListener("resize", () => {
  renderOverlay();
  refreshDebugState();
});

for (const id of PREPROCESS_CONTROL_IDS) {
  byId<HTMLInputElement>(id).addEventListener("input", () => {
    refreshValueLabels();
    schedulePreprocessAndDetect();
  });
  byId<HTMLInputElement>(id).addEventListener("change", () => {
    refreshValueLabels();
    schedulePreprocessAndDetect();
  });
}

for (const id of FILTER_PREVIEW_IDS) {
  byId<HTMLInputElement>(id).addEventListener("input", () => {
    refreshValueLabels();
    setOverlayMode("filter-preview");
    recomputeLiveBoxes();
  });
}

for (const id of MERGE_PREVIEW_IDS) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element: ${id}`);
  el.addEventListener("input", () => {
    refreshValueLabels();
    setOverlayMode("merge-preview");
    recomputeLiveBoxes();
  });
  el.addEventListener("change", () => {
    refreshValueLabels();
    setOverlayMode("committed");
    recomputeLiveBoxes();
  });
}

detectBtn.addEventListener("click", async () => {
  await forceDetectNow();
  refreshDebugState();
});

window.lab = {
  health: async () => {
    const res = await fetch(`${normalizeServerUrl(serverUrlEl.value)}/healthz`);
    return (await res.json()) as { ok: boolean; detector?: string };
  },
  setServerUrl: (url: string) => {
    serverUrlEl.value = url;
    refreshDebugState();
  },
  loadFixture: async (name: string) => {
    const res = await fetch(`${FIXTURE_BASE}/${name.replace(/^\/+/, "")}`);
    if (!res.ok) throw new Error(`Fixture not found: ${name}`);
    await loadOriginalImage(await res.blob());
    await preprocessAndDetectNow();
    refreshDebugState();
  },
  loadImageBlob: async (blob: Blob) => {
    await loadOriginalImage(blob);
    await preprocessAndDetectNow();
    refreshDebugState();
  },
  set: (controlId: string, value: Primitive) => {
    setControlValue(controlId, value);
    refreshValueLabels();
    if (PREPROCESS_CONTROL_IDS.includes(controlId as (typeof PREPROCESS_CONTROL_IDS)[number])) schedulePreprocessAndDetect();
    else {
      setOverlayMode(FILTER_PREVIEW_IDS.includes(controlId as (typeof FILTER_PREVIEW_IDS)[number]) ? "filter-preview" : "merge-preview");
      recomputeLiveBoxes();
    }
    refreshDebugState();
  },
  batchSet: (values: Record<string, Primitive>) => {
    let rerun = false;
    let preview: OverlayMode = "committed";
    for (const [k, v] of Object.entries(values)) {
      setControlValue(k, v);
      if (PREPROCESS_CONTROL_IDS.includes(k as (typeof PREPROCESS_CONTROL_IDS)[number])) rerun = true;
      if (FILTER_PREVIEW_IDS.includes(k as (typeof FILTER_PREVIEW_IDS)[number])) preview = "filter-preview";
      if (MERGE_PREVIEW_IDS.includes(k as (typeof MERGE_PREVIEW_IDS)[number])) preview = "merge-preview";
    }
    refreshValueLabels();
    if (rerun) schedulePreprocessAndDetect();
    else {
      setOverlayMode(preview);
      recomputeLiveBoxes();
    }
    refreshDebugState();
  },
  redetectNow: async () => {
    await forceDetectNow();
    refreshDebugState();
  },
  recomputeBoxesNow: () => {
    recomputeLiveBoxes();
    refreshDebugState();
  },
  getState: () => getLabState(),
  assertNoOffCanvasBoxes: () => {
    const image = getImageGeometry();
    if (!image) return { ok: false, offenders: ["no_image"] };
    const offenders = renderedBoxes
      .filter((box) => {
        const r = box.rendered;
        return r.left < 0 || r.top < 0 || r.left + r.width > image.displayWidth + 0.5 || r.top + r.height > image.displayHeight + 0.5;
      })
      .map((box) => box.id);
    return { ok: offenders.length === 0, offenders };
  },
  reset: () => {
    resetState();
    refreshDebugState();
  }
};

refreshValueLabels();
void checkHealth().then(refreshDebugState);

async function loadOriginalImage(blob: Blob): Promise<void> {
  if (originalImageBitmap) originalImageBitmap.close();
  originalImageBitmap = await createImageBitmap(blob);

  if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl);
  previewObjectUrl = URL.createObjectURL(blob);
  previewEl.src = previewObjectUrl;
  await previewEl.decode();

  viewerEl.classList.remove("hidden");
  emptyEl.classList.add("hidden");
  rawBoxes = [];
  filterResults = [];
  mergedGroups = [];
  liveBoxes = [];
  renderedBoxes = [];
  overlayEl.innerHTML = "";
  overlaySvgEl.innerHTML = "";
  currentMetrics = null;
  setStatus("Image loaded.");
}

function readPreprocess(): PreprocessingSettings {
  return {
    binary_threshold: num("binary-threshold"),
    invert: byId<HTMLInputElement>("invert").checked,
    dilation: num("dilation"),
    contrast: num("contrast"),
    brightness: num("brightness")
  };
}

function readPostprocess(): PostprocessSettings {
  return {
    min_width_ratio: num("min-width-ratio"),
    min_height_ratio: num("min-height-ratio"),
    median_height_fraction: num("median-height-fraction"),
    merge_vertical_ratio: num("merge-vertical-ratio"),
    merge_horizontal_ratio: num("merge-horizontal-ratio"),
    merge_width_ratio_threshold: num("merge-width-ratio-threshold"),
    group_tolerance: num("group-tolerance"),
    direction: byId<HTMLSelectElement>("reading-direction").value as ReadingDirection
  };
}

function schedulePreprocessAndDetect(): void {
  if (preprocessTimer) window.clearTimeout(preprocessTimer);
  preprocessTimer = window.setTimeout(() => {
    void preprocessAndDetectNow();
  }, 170);
}

async function forceDetectNow(): Promise<void> {
  if (preprocessTimer) {
    window.clearTimeout(preprocessTimer);
    preprocessTimer = null;
  }
  await preprocessAndDetectNow();
}

async function preprocessAndDetectNow(): Promise<void> {
  if (!originalImageBitmap) return;
  const seq = ++currentDetectSeq;
  pendingDetect = true;

  try {
    const preproc = readPreprocess();
    const processed = await applyPreprocessing(originalImageBitmap, preproc);
    if (seq !== currentDetectSeq) return;

    if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl);
    previewObjectUrl = URL.createObjectURL(processed);
    previewEl.src = previewObjectUrl;
    await previewEl.decode();

    const request: DetectRequest = { detector: { include_polygons: true } };
    const form = new FormData();
    form.append("image", processed, "processed.png");
    form.append("settings", JSON.stringify(request));

    setStatus("Running RapidOCR...");
    const res = await fetch(`${normalizeServerUrl(serverUrlEl.value)}/v1/detect`, { method: "POST", body: form });
    const data = (await res.json()) as DetectResponse;
    if (!res.ok || data.status !== "success" || !data.raw_boxes || !data.metrics) {
      throw new Error(data.error?.message ?? `HTTP ${res.status}`);
    }
    if (seq !== currentDetectSeq) return;

    rawBoxes = data.raw_boxes;
    setOverlayMode("committed");
    recomputeLiveBoxes();
    currentMetrics = {
      detect_ms: data.metrics.detect_ms,
      total_ms: data.metrics.total_ms,
      raw_count: data.metrics.raw_count,
      live_count: liveBoxes.length
    };
    metricsEl.textContent = JSON.stringify(currentMetrics, null, 2);
    setStatus(`Done: raw ${rawBoxes.length}, live ${liveBoxes.length}`);
  } catch (error) {
    setStatus(`Detection failed: ${String(error)}`);
    currentMetrics = null;
  } finally {
    pendingDetect = false;
  }
}

async function applyPreprocessing(bitmap: ImageBitmap, s: PreprocessingSettings): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas 2D context unavailable");
  ctx.drawImage(bitmap, 0, 0);

  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = imgData.data;

  for (let i = 0; i < d.length; i += 4) {
    let r = d[i] ?? 0;
    let g = d[i + 1] ?? 0;
    let b = d[i + 2] ?? 0;

    r = (r - 128) * s.contrast + 128 + s.brightness;
    g = (g - 128) * s.contrast + 128 + s.brightness;
    b = (b - 128) * s.contrast + 128 + s.brightness;

    r = Math.max(0, Math.min(255, r));
    g = Math.max(0, Math.min(255, g));
    b = Math.max(0, Math.min(255, b));

    if (s.binary_threshold > 0) {
      const y = 0.299 * r + 0.587 * g + 0.114 * b;
      const v = y >= s.binary_threshold ? 255 : 0;
      r = v;
      g = v;
      b = v;
    }

    if (s.invert) {
      r = 255 - r;
      g = 255 - g;
      b = 255 - b;
    }

    d[i] = r;
    d[i + 1] = g;
    d[i + 2] = b;
  }

  if (s.dilation !== 0) {
    applyMorphology(imgData, canvas.width, canvas.height, s.dilation);
  }

  ctx.putImageData(imgData, 0, 0);
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("Failed to generate processed image blob"));
        return;
      }
      resolve(blob);
    }, "image/png");
  });
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

function recomputeLiveBoxes(): void {
  const p = readPostprocess();
  const filter = filterBySize(rawBoxes, previewEl.naturalWidth, previewEl.naturalHeight, p);
  filterResults = filter;
  const filtered = filter.filter((f) => f.keep).map((f) => f.box);
  const sorted = sortByReadingOrder(filtered, p.group_tolerance, p.direction);
  mergedGroups = mergeCloseBoxes(sorted, p);
  const sortedMerged = sortByReadingOrder(mergedGroups.map((g) => g.rect), p.group_tolerance, p.direction);
  const groupMap = new Map(mergedGroups.map((g) => [g.rect.id, g]));
  mergedGroups = sortedMerged.map((box) => groupMap.get(box.id)).filter((v): v is MergeGroup => Boolean(v));
  liveBoxes = mergedGroups.map((g) => g.rect);

  renderOverlay();
  if (currentMetrics) {
    currentMetrics = { ...currentMetrics, live_count: liveBoxes.length };
    metricsEl.textContent = JSON.stringify(currentMetrics, null, 2);
  }
}

function filterBySize(boxes: RawBox[], imgW: number, imgH: number, p: PostprocessSettings): BoxFilterResult[] {
  if (!boxes.length || imgW <= 0 || imgH <= 0) return [];
  const heights = boxes.map((b) => b.px.y2 - b.px.y1).filter((h) => h > 0);
  const medianH = median(heights);
  return boxes.map((box) => {
    const w = box.px.x2 - box.px.x1;
    const h = box.px.y2 - box.px.y1;
    let keep = w > 0 && h > 0;
    if (keep && p.min_height_ratio > 0 && h < imgH * p.min_height_ratio) keep = false;
    if (keep && p.min_width_ratio > 0 && w < imgW * p.min_width_ratio) keep = false;
    if (keep && medianH > 0 && h < medianH * p.median_height_fraction && w < medianH * 2) keep = false;
    return { box, keep };
  });
}

function sortByReadingOrder(boxes: RawBox[], groupTolerance: number, direction: ReadingDirection): RawBox[] {
  if (boxes.length <= 1) return [...boxes];
  const horizontal = direction.startsWith("horizontal");
  const reverse = direction.endsWith("rtl");
  const primaryStart = horizontal ? "y1" : "x1";
  const primaryEnd = horizontal ? "y2" : "x2";
  const secondaryStart = horizontal ? "x1" : "y1";
  const measure = boxes.map((b) => b.px[primaryEnd] - b.px[primaryStart]);
  const band = Math.max(1, groupTolerance * (median(measure) || 30));
  const sorted = [...boxes].sort((a, b) => a.px[primaryStart] - b.px[primaryStart]);

  const lines: RawBox[][] = [];
  let current: RawBox[] = [];
  let currentCenter = -1000;
  for (const box of sorted) {
    const center = (box.px[primaryStart] + box.px[primaryEnd]) / 2;
    if (current.length > 0 && Math.abs(center - currentCenter) <= band) {
      current.push(box);
      const centers = current.map((c) => (c.px[primaryStart] + c.px[primaryEnd]) / 2);
      currentCenter = centers.reduce((a, b) => a + b, 0) / centers.length;
    } else {
      if (current.length > 0) lines.push(current);
      current = [box];
      currentCenter = center;
    }
  }
  if (current.length > 0) lines.push(current);

  const out: RawBox[] = [];
  for (const line of lines) {
    line.sort((a, b) => reverse ? b.px[secondaryStart] - a.px[secondaryStart] : a.px[secondaryStart] - b.px[secondaryStart]);
    out.push(...line);
  }
  return out;
}

function mergeCloseBoxes(boxes: RawBox[], p: PostprocessSettings): MergeGroup[] {
  if (boxes.length === 0) return [];
  if (boxes.length === 1) return [{ rect: boxes[0], members: [boxes[0]] }];

  const used = new Array(boxes.length).fill(false);
  const out: MergeGroup[] = [];

  const canMerge = (a: RawBox, b: RawBox): boolean => {
    const h1 = a.px.y2 - a.px.y1;
    const h2 = b.px.y2 - b.px.y1;
    const minH = Math.min(h1, h2);
    const refH = (h1 + h2) / 2;

    const maxVGap = refH * p.merge_vertical_ratio;
    const maxHGap = refH * p.merge_horizontal_ratio;

    const yOverlap = Math.max(0, Math.min(a.px.y2, b.px.y2) - Math.max(a.px.y1, b.px.y1));
    const sameRow = yOverlap > minH * 0.5;
    if (sameRow) {
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
        if (w1 > 0 && w2 > 0) {
          const ratio = Math.min(w1, w2) / Math.max(w1, w2);
          return ratio >= p.merge_width_ratio_threshold;
        }
        return true;
      }
    }
    return false;
  };

  for (let i = 0; i < boxes.length; i += 1) {
    if (used[i]) continue;
    const group = [boxes[i]];
    used[i] = true;

    let changed = true;
    while (changed) {
      changed = false;
      for (let j = 0; j < boxes.length; j += 1) {
        if (used[j]) continue;
        if (group.some((g) => canMerge(g, boxes[j]))) {
          group.push(boxes[j]);
          used[j] = true;
          changed = true;
        }
      }
    }

    const x1 = Math.min(...group.map((g) => g.px.x1));
    const y1 = Math.min(...group.map((g) => g.px.y1));
    const x2 = Math.max(...group.map((g) => g.px.x2));
    const y2 = Math.max(...group.map((g) => g.px.y2));
    const w = Math.max(1, previewEl.naturalWidth);
    const h = Math.max(1, previewEl.naturalHeight);
    const rect: RawBox = {
      id: crypto.randomUUID(),
      px: { x1, y1, x2, y2 },
      norm: { x: x1 / w, y: y1 / h, w: (x2 - x1) / w, h: (y2 - y1) / h },
      polygon: null
    };
    out.push({ rect, members: group });
  }
  return out;
}

function renderOverlay(): void {
  overlayEl.innerHTML = "";
  overlaySvgEl.innerHTML = "";
  renderedBoxes = [];
  activeLayers = [];
  const g = getImageGeometry();
  if (!g) return;

  overlayEl.style.width = `${g.displayWidth}px`;
  overlayEl.style.height = `${g.displayHeight}px`;
  overlayEl.style.left = `${g.left}px`;
  overlayEl.style.top = `${g.top}px`;
  overlaySvgEl.style.width = `${g.displayWidth}px`;
  overlaySvgEl.style.height = `${g.displayHeight}px`;
  overlaySvgEl.style.left = `${g.left}px`;
  overlaySvgEl.style.top = `${g.top}px`;
  overlaySvgEl.setAttribute("viewBox", `0 0 ${g.displayWidth} ${g.displayHeight}`);

  if (overlayMode === "filter-preview" && filterResults.length > 0) {
    drawFilterPreview(g);
  } else {
    drawMergedView(g, overlayMode === "merge-preview");
  }
}

function drawFilterPreview(g: NonNullable<LabState["image"]>): void {
  activeLayers.push("overlay-filter-keep", "overlay-filter-drop");
  for (const r of filterResults) {
    const rendered = toRendered(r.box, g);
    const el = document.createElement("div");
    el.className = r.keep ? "box box-keep" : "box box-drop";
    el.dataset.testid = r.keep ? "overlay-filter-keep" : "overlay-filter-drop";
    if (!r.keep) el.style.borderStyle = "dashed";
    el.style.left = `${rendered.left}px`;
    el.style.top = `${rendered.top}px`;
    el.style.width = `${rendered.width}px`;
    el.style.height = `${rendered.height}px`;
    overlayEl.appendChild(el);
  }
}

function drawMergedView(g: NonNullable<LabState["image"]>, showHelpers: boolean): void {
  if (mergedGroups.length === 0) return;
  activeLayers.push("overlay-merged", "overlay-seq-badge", "overlay-flow-path", "overlay-flow-arrow");
  if (showHelpers) activeLayers.push("overlay-tolerance", "overlay-ratio-bar");

  const centers: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < mergedGroups.length; i += 1) {
    const group = mergedGroups[i];
    const rendered = toRendered(group.rect, g);
    renderedBoxes.push({ id: group.rect.id, norm: group.rect.norm, rendered });
    centers.push({ x: rendered.left + rendered.width / 2, y: rendered.top + rendered.height / 2 });

    const box = document.createElement("div");
    box.className = "box box-merged";
    box.dataset.testid = "overlay-box";
    box.style.left = `${rendered.left}px`;
    box.style.top = `${rendered.top}px`;
    box.style.width = `${rendered.width}px`;
    box.style.height = `${rendered.height}px`;
    overlayEl.appendChild(box);

    const seq = document.createElement("div");
    seq.className = "badge badge-seq";
    seq.dataset.testid = "overlay-seq-badge";
    seq.textContent = `${i + 1}`;
    seq.style.left = `${rendered.left - 12}px`;
    seq.style.top = `${rendered.top - 12}px`;
    overlayEl.appendChild(seq);

    if (group.members.length > 1) {
      activeLayers.push("overlay-count-badge");
      const cnt = document.createElement("div");
      cnt.className = "badge badge-count";
      cnt.dataset.testid = "overlay-count-badge";
      cnt.textContent = `${group.members.length}`;
      cnt.style.left = `${rendered.left + rendered.width - 22}px`;
      cnt.style.top = `${rendered.top + rendered.height - 16}px`;
      overlayEl.appendChild(cnt);
    }

    if (showHelpers) {
      drawTolerance(group, g);
      drawRatioBars(group, g);
    }
  }
  drawOrderPath(centers);
}

function drawTolerance(group: MergeGroup, g: NonNullable<LabState["image"]>): void {
  const p = readPostprocess();
  const vTol = p.merge_vertical_ratio * 20;
  const hTol = p.merge_horizontal_ratio * 20;
  for (const member of group.members) {
    const r = toRendered(member, g);
    const zone = document.createElement("div");
    zone.className = "box box-tolerance";
    zone.dataset.testid = "overlay-tolerance";
    zone.style.left = `${r.left - hTol}px`;
    zone.style.top = `${r.top - vTol}px`;
    zone.style.width = `${r.width + hTol * 2}px`;
    zone.style.height = `${r.height + vTol * 2}px`;
    overlayEl.appendChild(zone);
  }
}

function drawRatioBars(group: MergeGroup, g: NonNullable<LabState["image"]>): void {
  const ratio = readPostprocess().merge_width_ratio_threshold;
  for (const member of group.members) {
    const r = toRendered(member, g);
    const barW = r.width * ratio;
    const bar = document.createElement("div");
    bar.className = "ratio-bar";
    bar.dataset.testid = "overlay-ratio-bar";
    bar.style.left = `${r.left + (r.width - barW) / 2}px`;
    bar.style.top = `${Math.max(r.top, r.top + r.height - 6)}px`;
    bar.style.width = `${barW}px`;
    overlayEl.appendChild(bar);
  }
}

function drawOrderPath(centers: Array<{ x: number; y: number }>): void {
  if (centers.length < 2) return;
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("data-testid", "overlay-flow-path");
  path.setAttribute("class", "flow-path");
  path.setAttribute("d", `M ${centers.map((c) => `${c.x} ${c.y}`).join(" L ")}`);
  overlaySvgEl.appendChild(path);
  for (let i = 0; i < centers.length - 1; i += 1) {
    drawArrow(centers[i], centers[i + 1]);
  }
}

function drawArrow(from: { x: number; y: number }, to: { x: number; y: number }): void {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len <= 0.01) return;
  const ux = dx / len;
  const uy = dy / len;
  const back = 11;
  const side = 5;
  const tipX = to.x;
  const tipY = to.y;
  const baseX = tipX - ux * back;
  const baseY = tipY - uy * back;
  const leftX = baseX + -uy * side;
  const leftY = baseY + ux * side;
  const rightX = baseX - -uy * side;
  const rightY = baseY - ux * side;
  const poly = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
  poly.setAttribute("data-testid", "overlay-flow-arrow");
  poly.setAttribute("class", "flow-arrow");
  poly.setAttribute("points", `${tipX},${tipY} ${leftX},${leftY} ${rightX},${rightY}`);
  overlaySvgEl.appendChild(poly);
}

function toRendered(box: RawBox, g: NonNullable<LabState["image"]>): RenderedBox["rendered"] {
  return {
    left: box.norm.x * g.displayWidth,
    top: box.norm.y * g.displayHeight,
    width: box.norm.w * g.displayWidth,
    height: box.norm.h * g.displayHeight
  };
}

function setOverlayMode(mode: OverlayMode): void {
  overlayMode = mode;
  if (overlayModeTimer) window.clearTimeout(overlayModeTimer);
  if (mode !== "committed") {
    overlayModeTimer = window.setTimeout(() => {
      overlayMode = "committed";
      renderOverlay();
      refreshDebugState();
    }, 280);
  }
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2 : (sorted[mid] ?? 0);
}

function getImageGeometry(): LabState["image"] {
  if (!previewEl.src || previewEl.naturalWidth <= 0 || previewEl.naturalHeight <= 0) return null;
  const viewRect = viewerEl.getBoundingClientRect();
  const imgRect = previewEl.getBoundingClientRect();
  return {
    naturalWidth: previewEl.naturalWidth,
    naturalHeight: previewEl.naturalHeight,
    displayWidth: imgRect.width,
    displayHeight: imgRect.height,
    left: imgRect.left - viewRect.left,
    top: imgRect.top - viewRect.top
  };
}

function setControlValue(controlId: string, value: Primitive): void {
  const el = document.getElementById(controlId);
  if (!el) throw new Error(`Unknown control: ${controlId}`);
  if (el instanceof HTMLInputElement) {
    if (el.type === "checkbox") el.checked = Boolean(value);
    else el.value = String(value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }
  if (el instanceof HTMLSelectElement) {
    el.value = String(value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }
  throw new Error(`Unsupported control: ${controlId}`);
}

function refreshValueLabels(): void {
  label("val-threshold", `${num("binary-threshold")}`);
  label("val-contrast", num("contrast").toFixed(1));
  label("val-brightness", `${num("brightness")}`);
  label("val-dilation", `${num("dilation")}`);
  label("val-min-width-ratio", num("min-width-ratio").toFixed(3));
  label("val-min-height-ratio", num("min-height-ratio").toFixed(3));
  label("val-median-height", num("median-height-fraction").toFixed(2));
  label("val-merge-v", num("merge-vertical-ratio").toFixed(2));
  label("val-merge-h", num("merge-horizontal-ratio").toFixed(2));
  label("val-merge-w", num("merge-width-ratio-threshold").toFixed(2));
  label("val-group-tolerance", num("group-tolerance").toFixed(2));
}

function label(id: string, text: string): void {
  byId<HTMLElement>(id).textContent = text;
}

function getLabState(): LabState {
  return {
    preprocess: readPreprocess(),
    postprocess: readPostprocess(),
    image: getImageGeometry(),
    rawCount: rawBoxes.length,
    liveCount: liveBoxes.length,
    filteredCount: filterResults.filter((r) => r.keep).length,
    mergedCount: mergedGroups.length,
    direction: readPostprocess().direction,
    overlayMode,
    overlayLayersActive: [...activeLayers],
    boxes: renderedBoxes,
    metrics: currentMetrics,
    status: currentStatus,
    serverUrl: serverUrlEl.value,
    pendingDetect
  };
}

function refreshDebugState(): void {
  debugStateEl.textContent = JSON.stringify(getLabState(), null, 2);
}

function resetState(): void {
  if (previewObjectUrl) {
    URL.revokeObjectURL(previewObjectUrl);
    previewObjectUrl = null;
  }
  if (originalImageBitmap) {
    originalImageBitmap.close();
    originalImageBitmap = null;
  }

  rawBoxes = [];
  filterResults = [];
  mergedGroups = [];
  liveBoxes = [];
  renderedBoxes = [];
  currentMetrics = null;
  pendingDetect = false;
  activeLayers = [];
  overlayMode = "committed";

  imageUploadEl.value = "";
  previewEl.src = "";
  overlayEl.innerHTML = "";
  overlaySvgEl.innerHTML = "";
  viewerEl.classList.add("hidden");
  emptyEl.classList.remove("hidden");
  metricsEl.textContent = "No run yet";
  setStatus("Cleared");
}

async function checkHealth(): Promise<void> {
  try {
    const res = await fetch(`${normalizeServerUrl(serverUrlEl.value)}/healthz`);
    const data = (await res.json()) as { ok: boolean; detector?: string };
    if (!res.ok || !data.ok) throw new Error("unhealthy");
    setStatus(`Healthy (${data.detector ?? "unknown"})`);
  } catch {
    setStatus("Server unreachable");
  }
}

function setStatus(text: string): void {
  currentStatus = text;
  serverStatusEl.textContent = `Status: ${text}`;
}

function normalizeServerUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function num(id: string): number {
  return Number(byId<HTMLInputElement>(id).value);
}

function byId<T extends Element>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element: ${id}`);
  return el as unknown as T;
}

function mustEl<T>(el: T | null, errorMessage: string): T {
  if (!el) throw new Error(errorMessage);
  return el;
}

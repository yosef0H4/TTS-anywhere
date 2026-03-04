import { createIcons, icons } from "lucide";
import "./styles.css";

type Primitive = string | number | boolean;
type OverlayMode = "committed" | "filter-preview" | "merge-preview";
type FilterRule = "width" | "height" | "median" | null;
type ReadingDirection = "horizontal_ltr" | "horizontal_rtl" | "vertical_ltr" | "vertical_rtl";
type ToolMode = "none" | "add" | "sub" | "manual";

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
  image: { max_dimension: number };
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
  removedBy: { width: boolean; height: boolean; median: boolean };
};

type MergeGroup = {
  rect: RawBox;
  members: RawBox[];
};

type DrawRect = { id: string; nx: number; ny: number; nw: number; nh: number };
type SelectionOp = DrawRect & { op: "add" | "sub" };

type LabState = {
  preprocess: PreprocessingSettings;
  postprocess: PostprocessSettings;
  maxImageDimension: number;
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
  toolMode: ToolMode;
  selectionBaseState: boolean;
  selectionOpCount: number;
  manualBoxCount: number;
  drawingActive: boolean;
  boxes: RenderedBox[];
  metrics: { detect_ms: number; total_ms: number; raw_count: number; live_count: number } | null;
  status: string;
  serverUrl: string;
  serverHealthy: boolean;
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
  setTool: (mode: ToolMode) => void;
  selectAll: () => void;
  deselectAll: () => void;
  clearManual: () => void;
  drawNormalized: (rect: { nx: number; ny: number; nw: number; nh: number }) => boolean;
  getDrawingState: () => { selectionBaseState: boolean; selectionOps: SelectionOp[]; manualBoxes: DrawRect[] };
  setDrawingState: (state: { selectionBaseState?: boolean; selectionOps?: SelectionOp[]; manualBoxes?: DrawRect[] }) => void;
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
const MAX_IMAGE_DIMENSION_DEFAULT = (() => {
  const raw = localStorage.getItem("preproc:maxImageDimension");
  const parsed = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1080;
})();
const RANGE_CONTROL_DEFAULTS: Record<string, number> = {
  "max-image-dimension": 1080,
  "binary-threshold": 0,
  "contrast": 1,
  "brightness": 0,
  "dilation": 0,
  "min-width-ratio": 0,
  "min-height-ratio": 0,
  "median-height-fraction": 0.45,
  "merge-vertical-ratio": 0.07,
  "merge-horizontal-ratio": 0.37,
  "merge-width-ratio-threshold": 0.75,
  "group-tolerance": 0.5
};
const INVERT_DEFAULT = false;
const READING_DIRECTION_DEFAULT = "horizontal_ltr" as ReadingDirection;
const RANGE_CONTROL_IDS = [
  "max-image-dimension", "binary-threshold", "contrast", "brightness", "dilation",
  "min-width-ratio", "min-height-ratio", "median-height-fraction",
  "merge-vertical-ratio", "merge-horizontal-ratio", "merge-width-ratio-threshold", "group-tolerance"
] as const;

const LS_SELECTION_BASE = "preproc:selectionBaseState";
const LS_SELECTION_OPS = "preproc:selectionOps";
const LS_MANUAL = "preproc:manualBoxes";

let originalImageBitmap: ImageBitmap | null = null;
let previewObjectUrl: string | null = null;

let rawBoxes: RawBox[] = [];
let filterResults: BoxFilterResult[] = [];
let mergedGroups: MergeGroup[] = [];
let liveBoxes: RawBox[] = [];
let renderedBoxes: RenderedBox[] = [];
let currentMetrics: { detect_ms: number; total_ms: number; raw_count: number; live_count: number } | null = null;
let filterStats = { widthRemoved: 0, heightRemoved: 0, medianRemoved: 0, medianHeightPx: 0 };
let currentStatus = "idle";
let preprocessTimer: number | null = null;
let overlayMode: OverlayMode = "committed";
let overlayModeTimer: number | null = null;
let activeFilterRule: FilterRule = null;
let currentDetectSeq = 0;
let pendingDetect = false;
let activeLayers: string[] = [];
let serverHealthy = false;

let toolMode: ToolMode = "none";
let selectionBaseState = true;
let selectionOps: SelectionOp[] = [];
let manualBoxes: DrawRect[] = [];
let drawingActive = false;
let drawStart: { x: number; y: number } | null = null;
let drawCurrent: { x: number; y: number } | null = null;

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
      <h2>Quality</h2>
      <div class="viz-wrap">
        <canvas id="quality-viz" class="side-viz" width="320" height="60"></canvas>
      </div>
      <label>Max Image Dimension <span id="val-max-image-dimension"></span></label>
      <div class="control-row">
        <input id="max-image-dimension" type="range" min="360" max="3840" step="60" value="${MAX_IMAGE_DIMENSION_DEFAULT}">
        <input id="max-image-dimension-num" type="number" min="360" max="3840" step="60" value="${MAX_IMAGE_DIMENSION_DEFAULT}" class="control-num">
        <button id="max-image-dimension-reset" class="control-reset" title="Reset">↻</button>
      </div>
    </section>

    <section>
      <h2>Selection Tools</h2>
      <p class="hint">Add/Sub changes selectable mask; Manual creates explicit boxes with delete handles.</p>
      <div class="row tool-row">
        <button data-testid="tool-none" id="tool-none">View</button>
        <button data-testid="tool-add" id="tool-add">Add Area</button>
        <button data-testid="tool-sub" id="tool-sub">Remove Area</button>
        <button data-testid="tool-manual" id="tool-manual">Manual Box</button>
      </div>
      <div class="row">
        <button data-testid="btn-select-all" id="btn-select-all">Select All</button>
        <button data-testid="btn-deselect-all" id="btn-deselect-all">Deselect All</button>
        <button data-testid="btn-clear-manual" id="btn-clear-manual">Clear Manual</button>
      </div>
    </section>

    <section>
      <h2>Preprocessing (re-run OCR)</h2>
      <p class="hint">These sliders change the image itself, then run model detection again.</p>
      <label>Binary Threshold <span data-testid="val-threshold" id="val-threshold"></span></label>
      <div class="control-row">
        <input data-testid="binary-threshold" id="binary-threshold" type="range" min="0" max="255" step="1" value="0">
        <input id="binary-threshold-num" type="number" min="0" max="255" step="1" value="0" class="control-num">
        <button id="binary-threshold-reset" class="control-reset" title="Reset">↻</button>
      </div>

      <label>Contrast <span data-testid="val-contrast" id="val-contrast"></span></label>
      <div class="control-row">
        <input data-testid="contrast" id="contrast" type="range" min="0.2" max="3" step="0.1" value="1">
        <input id="contrast-num" type="number" min="0.2" max="3" step="0.1" value="1" class="control-num">
        <button id="contrast-reset" class="control-reset" title="Reset">↻</button>
      </div>

      <label>Brightness <span data-testid="val-brightness" id="val-brightness"></span></label>
      <div class="control-row">
        <input data-testid="brightness" id="brightness" type="range" min="-100" max="100" step="1" value="0">
        <input id="brightness-num" type="number" min="-100" max="100" step="1" value="0" class="control-num">
        <button id="brightness-reset" class="control-reset" title="Reset">↻</button>
      </div>

      <label>Dilation/Erosion <span data-testid="val-dilation" id="val-dilation"></span></label>
      <div class="control-row">
        <input data-testid="dilation" id="dilation" type="range" min="-5" max="5" step="1" value="0">
        <input id="dilation-num" type="number" min="-5" max="5" step="1" value="0" class="control-num">
        <button id="dilation-reset" class="control-reset" title="Reset">↻</button>
      </div>

      <div class="control-row checkbox-row">
        <label style="margin:0; flex:1;"><input data-testid="invert" id="invert" type="checkbox">Invert</label>
        <button id="invert-reset" class="control-reset" title="Reset">↻</button>
      </div>
    </section>

    <section data-ocr-controls>
      <h2>Detection Filter (live)</h2>
      <p class="hint">While dragging a filter slider, each box turns green/red live and shows that rule's threshold guide directly on the image.</p>
      <label>Min Width Ratio <span data-testid="val-min-width-ratio" id="val-min-width-ratio"></span></label>
      <div class="hint" id="rule-min-width">Reject widths below 0.0% of image width.</div>
      <div class="hint" id="stat-min-width">Removed by width rule: 0</div>
      <div class="control-row">
        <input data-testid="min-width-ratio" id="min-width-ratio" type="range" min="0" max="0.1" step="0.001" value="0">
        <input id="min-width-ratio-num" type="number" min="0" max="0.1" step="0.001" value="0" class="control-num">
        <button id="min-width-ratio-reset" class="control-reset" title="Reset">↻</button>
      </div>

      <label>Min Height Ratio <span data-testid="val-min-height-ratio" id="val-min-height-ratio"></span></label>
      <div class="hint" id="rule-min-height">Reject heights below 0.0% of image height.</div>
      <div class="hint" id="stat-min-height">Removed by height rule: 0</div>
      <div class="control-row">
        <input data-testid="min-height-ratio" id="min-height-ratio" type="range" min="0" max="0.1" step="0.001" value="0">
        <input id="min-height-ratio-num" type="number" min="0" max="0.1" step="0.001" value="0" class="control-num">
        <button id="min-height-ratio-reset" class="control-reset" title="Reset">↻</button>
      </div>

      <label>Median Height Fraction <span data-testid="val-median-height" id="val-median-height"></span></label>
      <div class="hint" id="rule-median-height">Reject narrow boxes below median-height rule.</div>
      <div class="hint" id="stat-median-height">Removed by median rule: 0</div>
      <div class="control-row">
        <input data-testid="median-height-fraction" id="median-height-fraction" type="range" min="0.1" max="1.2" step="0.05" value="0.45">
        <input id="median-height-fraction-num" type="number" min="0.1" max="1.2" step="0.05" value="0.45" class="control-num">
        <button id="median-height-fraction-reset" class="control-reset" title="Reset">↻</button>
      </div>
    </section>

    <section data-ocr-controls>
      <h2>Merging + Ordering (live)</h2>
      <p class="hint">Yellow zones, cyan bars, and magenta arrows explain why boxes merge and in what order.</p>
      <div class="control-row">
        <label style="margin:0; flex:1;">Reading Direction</label>
        <button id="reading-direction-reset" class="control-reset" title="Reset">↻</button>
      </div>
      <select data-testid="reading-direction" id="reading-direction">
        <option value="horizontal_ltr">Horizontal LTR</option>
        <option value="horizontal_rtl">Horizontal RTL</option>
        <option value="vertical_ltr">Vertical LTR</option>
        <option value="vertical_rtl">Vertical RTL</option>
      </select>

      <label>Merge Vertical Ratio <span data-testid="val-merge-v" id="val-merge-v"></span></label>
      <div class="control-row">
        <input data-testid="merge-vertical-ratio" id="merge-vertical-ratio" type="range" min="0" max="1" step="0.01" value="0.07">
        <input id="merge-vertical-ratio-num" type="number" min="0" max="1" step="0.01" value="0.07" class="control-num">
        <button id="merge-vertical-ratio-reset" class="control-reset" title="Reset">↻</button>
      </div>

      <label>Merge Horizontal Ratio <span data-testid="val-merge-h" id="val-merge-h"></span></label>
      <div class="control-row">
        <input data-testid="merge-horizontal-ratio" id="merge-horizontal-ratio" type="range" min="0" max="2" step="0.01" value="0.37">
        <input id="merge-horizontal-ratio-num" type="number" min="0" max="2" step="0.01" value="0.37" class="control-num">
        <button id="merge-horizontal-ratio-reset" class="control-reset" title="Reset">↻</button>
      </div>

      <label>Merge Width Ratio Threshold <span data-testid="val-merge-w" id="val-merge-w"></span></label>
      <div class="control-row">
        <input data-testid="merge-width-ratio-threshold" id="merge-width-ratio-threshold" type="range" min="0" max="1" step="0.01" value="0.75">
        <input id="merge-width-ratio-threshold-num" type="number" min="0" max="1" step="0.01" value="0.75" class="control-num">
        <button id="merge-width-ratio-threshold-reset" class="control-reset" title="Reset">↻</button>
      </div>

      <label>Group Tolerance <span data-testid="val-group-tolerance" id="val-group-tolerance"></span></label>
      <div class="control-row">
        <input data-testid="group-tolerance" id="group-tolerance" type="range" min="0.1" max="1.2" step="0.01" value="0.5">
        <input id="group-tolerance-num" type="number" min="0.1" max="1.2" step="0.01" value="0.5" class="control-num">
        <button id="group-tolerance-reset" class="control-reset" title="Reset">↻</button>
      </div>
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
      <canvas data-testid="selection-mask" id="selection-mask" class="selection-mask"></canvas>
      <svg data-testid="overlay-svg" id="overlay-svg" class="overlay-svg"></svg>
      <div data-testid="overlay" id="overlay" class="overlay"></div>
      <div data-testid="manual-layer" id="manual-layer" class="manual-layer"></div>
      <div data-testid="draw-preview-layer" id="draw-preview-layer" class="draw-preview-layer"></div>
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
const manualLayerEl = byId<HTMLDivElement>("manual-layer");
const drawPreviewLayerEl = byId<HTMLDivElement>("draw-preview-layer");
const selectionMaskEl = byId<HTMLCanvasElement>("selection-mask");
const overlaySvgEl = byId<SVGSVGElement>("overlay-svg");
const viewerEl = byId<HTMLDivElement>("viewer");
const emptyEl = byId<HTMLDivElement>("empty");
const qualityVizEl = byId<HTMLCanvasElement>("quality-viz");

loadDrawingState();
setTool("none");
setupRangeControls();
setupResetButtons();
setupVisualizers();
applyHealthUiGate();

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
  setServerHealthy(false);
  refreshDebugState();
});
byId<HTMLButtonElement>("btn-clear").addEventListener("click", () => {
  resetState();
  refreshDebugState();
});
byId<HTMLButtonElement>("btn-debug-refresh").addEventListener("click", refreshDebugState);

byId<HTMLButtonElement>("tool-none").addEventListener("click", () => setTool("none"));
byId<HTMLButtonElement>("tool-add").addEventListener("click", () => setTool("add"));
byId<HTMLButtonElement>("tool-sub").addEventListener("click", () => setTool("sub"));
byId<HTMLButtonElement>("tool-manual").addEventListener("click", () => setTool("manual"));

byId<HTMLButtonElement>("btn-select-all").addEventListener("click", () => {
  selectionBaseState = true;
  selectionOps = [];
  persistDrawingState();
  setOverlayMode("committed");
  recomputeLiveBoxes();
  refreshDebugState();
});
byId<HTMLButtonElement>("btn-deselect-all").addEventListener("click", () => {
  selectionBaseState = false;
  selectionOps = [];
  persistDrawingState();
  setOverlayMode("committed");
  recomputeLiveBoxes();
  refreshDebugState();
});
byId<HTMLButtonElement>("btn-clear-manual").addEventListener("click", () => {
  manualBoxes = [];
  persistDrawingState();
  setOverlayMode("committed");
  recomputeLiveBoxes();
  refreshDebugState();
});

setupPointerDrawing();

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
    activeFilterRule = id === "min-width-ratio" ? "width" : id === "min-height-ratio" ? "height" : "median";
    setOverlayMode("filter-preview");
    recomputeLiveBoxes();
  });
  byId<HTMLInputElement>(id).addEventListener("change", () => {
    activeFilterRule = null;
    setOverlayMode("committed");
    recomputeLiveBoxes();
  });
}

for (const id of MERGE_PREVIEW_IDS) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element: ${id}`);
  el.addEventListener("input", () => {
    refreshValueLabels();
    activeFilterRule = null;
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
      activeFilterRule = controlId === "min-width-ratio" ? "width" : controlId === "min-height-ratio" ? "height" : controlId === "median-height-fraction" ? "median" : null;
      setOverlayMode(FILTER_PREVIEW_IDS.includes(controlId as (typeof FILTER_PREVIEW_IDS)[number]) ? "filter-preview" : "merge-preview");
      recomputeLiveBoxes();
    }
    refreshDebugState();
  },
  batchSet: (values: Record<string, Primitive>) => {
    let rerun = false;
    let preview: OverlayMode = "committed";
    let filterRule: FilterRule = null;
    for (const [k, v] of Object.entries(values)) {
      setControlValue(k, v);
      if (PREPROCESS_CONTROL_IDS.includes(k as (typeof PREPROCESS_CONTROL_IDS)[number])) rerun = true;
      if (k === "min-width-ratio") filterRule = "width";
      if (k === "min-height-ratio") filterRule = "height";
      if (k === "median-height-fraction") filterRule = "median";
      if (FILTER_PREVIEW_IDS.includes(k as (typeof FILTER_PREVIEW_IDS)[number])) preview = "filter-preview";
      if (MERGE_PREVIEW_IDS.includes(k as (typeof MERGE_PREVIEW_IDS)[number])) preview = "merge-preview";
    }
    refreshValueLabels();
    if (rerun) schedulePreprocessAndDetect();
    else {
      activeFilterRule = preview === "filter-preview" ? filterRule : null;
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
  setTool: (mode) => {
    setTool(mode);
    refreshDebugState();
  },
  selectAll: () => {
    selectionBaseState = true;
    selectionOps = [];
    persistDrawingState();
    recomputeLiveBoxes();
    refreshDebugState();
  },
  deselectAll: () => {
    selectionBaseState = false;
    selectionOps = [];
    persistDrawingState();
    recomputeLiveBoxes();
    refreshDebugState();
  },
  clearManual: () => {
    manualBoxes = [];
    persistDrawingState();
    recomputeLiveBoxes();
    refreshDebugState();
  },
  drawNormalized: (rect) => commitDrawRect(rect.nx, rect.ny, rect.nw, rect.nh),
  getDrawingState: () => ({ selectionBaseState, selectionOps: [...selectionOps], manualBoxes: [...manualBoxes] }),
  setDrawingState: (next) => {
    if (typeof next.selectionBaseState === "boolean") selectionBaseState = next.selectionBaseState;
    if (Array.isArray(next.selectionOps)) selectionOps = sanitizeSelectionOps(next.selectionOps);
    if (Array.isArray(next.manualBoxes)) manualBoxes = sanitizeManualBoxes(next.manualBoxes);
    persistDrawingState();
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
        return r.left < -0.5 || r.top < -0.5 || r.left + r.width > image.displayWidth + 0.5 || r.top + r.height > image.displayHeight + 0.5;
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

function setupPointerDrawing(): void {
  const target = byId<HTMLElement>("paste-target");
  target.addEventListener("pointerdown", (event) => {
    if (toolMode === "none" || !getImageGeometry()) return;
    if (event.button !== 0) return;
    const point = pointerToNormalized(event.clientX, event.clientY);
    if (!point) return;
    drawingActive = true;
    drawStart = point;
    drawCurrent = point;
    renderDrawPreview();
    event.preventDefault();
  });

  window.addEventListener("pointermove", (event) => {
    if (!drawingActive || !drawStart) return;
    const point = pointerToNormalized(event.clientX, event.clientY);
    if (!point) return;
    drawCurrent = point;
    renderDrawPreview();
  });

  window.addEventListener("pointerup", () => {
    if (!drawingActive || !drawStart || !drawCurrent) return;
    const rect = normalizeRect(drawStart.x, drawStart.y, drawCurrent.x, drawCurrent.y);
    drawingActive = false;
    drawStart = null;
    drawCurrent = null;
    drawPreviewLayerEl.innerHTML = "";
    commitDrawRect(rect.nx, rect.ny, rect.nw, rect.nh);
    refreshDebugState();
  });
}

function pointerToNormalized(clientX: number, clientY: number): { x: number; y: number } | null {
  const g = getImageGeometry();
  if (!g) return null;
  const rect = previewEl.getBoundingClientRect();
  const x = (clientX - rect.left) / Math.max(1, rect.width);
  const y = (clientY - rect.top) / Math.max(1, rect.height);
  return {
    x: clamp(x, 0, 1),
    y: clamp(y, 0, 1)
  };
}

function renderDrawPreview(): void {
  drawPreviewLayerEl.innerHTML = "";
  const g = getImageGeometry();
  if (!g || !drawStart || !drawCurrent) return;
  const r = normalizeRect(drawStart.x, drawStart.y, drawCurrent.x, drawCurrent.y);
  const el = document.createElement("div");
  el.className = `draw-preview ${toolMode === "add" ? "draw-preview-add" : toolMode === "sub" ? "draw-preview-sub" : "draw-preview-manual"}`;
  el.style.left = `${r.nx * g.displayWidth}px`;
  el.style.top = `${r.ny * g.displayHeight}px`;
  el.style.width = `${r.nw * g.displayWidth}px`;
  el.style.height = `${r.nh * g.displayHeight}px`;
  drawPreviewLayerEl.appendChild(el);
}

function commitDrawRect(nx: number, ny: number, nw: number, nh: number): boolean {
  const r = clampNormRect({ id: crypto.randomUUID(), nx, ny, nw, nh });
  if (r.nw <= 0.001 || r.nh <= 0.001) return false;

  if (toolMode === "manual") {
    if (!manualBoxes.some((b) => almostEqualRect(b, r))) {
      manualBoxes.push(r);
    }
  } else if (toolMode === "add" || toolMode === "sub") {
    selectionOps.push({ ...r, op: toolMode });
  } else {
    return false;
  }

  persistDrawingState();
  setOverlayMode("committed");
  recomputeLiveBoxes();
  return true;
}

function setTool(mode: ToolMode): void {
  toolMode = mode;
  const ids: Array<{ id: string; mode: ToolMode }> = [
    { id: "tool-none", mode: "none" },
    { id: "tool-add", mode: "add" },
    { id: "tool-sub", mode: "sub" },
    { id: "tool-manual", mode: "manual" }
  ];
  for (const item of ids) {
    byId<HTMLButtonElement>(item.id).classList.toggle("active-tool", item.mode === mode);
  }

  const pasteTarget = byId<HTMLElement>("paste-target");
  pasteTarget.style.cursor = mode === "none" ? "default" : "crosshair";
}

function persistDrawingState(): void {
  localStorage.setItem(LS_SELECTION_BASE, JSON.stringify(selectionBaseState));
  localStorage.setItem(LS_SELECTION_OPS, JSON.stringify(selectionOps));
  localStorage.setItem(LS_MANUAL, JSON.stringify(manualBoxes));
}

function loadDrawingState(): void {
  try {
    const baseRaw = localStorage.getItem(LS_SELECTION_BASE);
    if (baseRaw !== null) selectionBaseState = Boolean(JSON.parse(baseRaw));
    const opsRaw = localStorage.getItem(LS_SELECTION_OPS);
    if (opsRaw) selectionOps = sanitizeSelectionOps(JSON.parse(opsRaw) as SelectionOp[]);
    const manualRaw = localStorage.getItem(LS_MANUAL);
    if (manualRaw) manualBoxes = sanitizeManualBoxes(JSON.parse(manualRaw) as DrawRect[]);
  } catch {
    selectionBaseState = true;
    selectionOps = [];
    manualBoxes = [];
  }
}

function sanitizeSelectionOps(values: SelectionOp[]): SelectionOp[] {
  if (!Array.isArray(values)) return [];
  return values
    .filter((v) => v && (v.op === "add" || v.op === "sub"))
    .map((v) => clampNormRect({ id: v.id || crypto.randomUUID(), op: v.op, nx: Number(v.nx), ny: Number(v.ny), nw: Number(v.nw), nh: Number(v.nh) }));
}

function sanitizeManualBoxes(values: DrawRect[]): DrawRect[] {
  if (!Array.isArray(values)) return [];
  return values.map((v) => clampNormRect({ id: v.id || crypto.randomUUID(), nx: Number(v.nx), ny: Number(v.ny), nw: Number(v.nw), nh: Number(v.nh) }));
}

function clampNormRect<T extends { nx: number; ny: number; nw: number; nh: number }>(box: T): T {
  const nx = clamp(box.nx, 0, 1);
  const ny = clamp(box.ny, 0, 1);
  const nw = clamp(box.nw, 0, 1 - nx);
  const nh = clamp(box.nh, 0, 1 - ny);
  return { ...box, nx, ny, nw, nh };
}

function normalizeRect(x1: number, y1: number, x2: number, y2: number): { nx: number; ny: number; nw: number; nh: number } {
  const nx = Math.min(x1, x2);
  const ny = Math.min(y1, y2);
  const nw = Math.abs(x2 - x1);
  const nh = Math.abs(y2 - y1);
  return clampNormRect({ nx, ny, nw, nh });
}

function almostEqualRect(a: DrawRect, b: DrawRect): boolean {
  return Math.abs(a.nx - b.nx) < 0.001 && Math.abs(a.ny - b.ny) < 0.001 && Math.abs(a.nw - b.nw) < 0.001 && Math.abs(a.nh - b.nh) < 0.001;
}

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
  manualLayerEl.innerHTML = "";
  drawPreviewLayerEl.innerHTML = "";
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

    const request: DetectRequest = { detector: { include_polygons: true }, image: { max_dimension: num("max-image-dimension") } };
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

    setServerHealthy(true);
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
    setServerHealthy(false);
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
  const selectionFiltered = rawBoxes.filter((b) => selectionKeepRatio(b) > 0.1);
  const filter = filterBySize(selectionFiltered, previewEl.naturalWidth, previewEl.naturalHeight, p);
  filterResults = filter;
  filterStats = {
    widthRemoved: filter.filter((f) => f.removedBy.width).length,
    heightRemoved: filter.filter((f) => f.removedBy.height).length,
    medianRemoved: filter.filter((f) => f.removedBy.median).length,
    medianHeightPx: Math.round(median(selectionFiltered.map((b) => b.px.y2 - b.px.y1).filter((h) => h > 0)))
  };
  const filtered = filter.filter((f) => f.keep).map((f) => f.box);

  const manualRaw = manualBoxes.map((m) => normalizedRectToRaw(m));
  const mergedInput = [...filtered, ...manualRaw];

  const sorted = sortByReadingOrder(mergedInput, p.group_tolerance, p.direction);
  mergedGroups = mergeCloseBoxes(sorted, p);
  const sortedMerged = sortByReadingOrder(mergedGroups.map((g) => g.rect), p.group_tolerance, p.direction);
  const groupMap = new Map(mergedGroups.map((g) => [g.rect.id, g]));
  mergedGroups = sortedMerged.map((box) => groupMap.get(box.id)).filter((v): v is MergeGroup => Boolean(v));
  liveBoxes = mergedGroups.map((g) => g.rect);

  renderOverlay();
  refreshValueLabels();
  updateVisualizers();
  if (currentMetrics) {
    currentMetrics = { ...currentMetrics, live_count: liveBoxes.length };
    metricsEl.textContent = JSON.stringify(currentMetrics, null, 2);
  }
}

function normalizedRectToRaw(rect: DrawRect): RawBox {
  const w = Math.max(1, previewEl.naturalWidth);
  const h = Math.max(1, previewEl.naturalHeight);
  const x1 = Math.round(rect.nx * w);
  const y1 = Math.round(rect.ny * h);
  const x2 = Math.round((rect.nx + rect.nw) * w);
  const y2 = Math.round((rect.ny + rect.nh) * h);
  return {
    id: rect.id,
    norm: { x: rect.nx, y: rect.ny, w: rect.nw, h: rect.nh },
    px: { x1, y1, x2, y2 },
    polygon: null
  };
}

function selectionKeepRatio(box: RawBox): number {
  const w = Math.max(1, box.px.x2 - box.px.x1);
  const h = Math.max(1, box.px.y2 - box.px.y1);
  const stepX = Math.max(1, Math.floor(w / 8));
  const stepY = Math.max(1, Math.floor(h / 8));
  let keep = 0;
  let total = 0;
  for (let y = box.px.y1; y < box.px.y2; y += stepY) {
    for (let x = box.px.x1; x < box.px.x2; x += stepX) {
      const nx = x / Math.max(1, previewEl.naturalWidth);
      const ny = y / Math.max(1, previewEl.naturalHeight);
      if (isSelected(nx, ny)) keep += 1;
      total += 1;
    }
  }
  return total > 0 ? keep / total : 0;
}

function isSelected(nx: number, ny: number): boolean {
  let selected = selectionBaseState;
  for (const op of selectionOps) {
    const hit = nx >= op.nx && nx <= op.nx + op.nw && ny >= op.ny && ny <= op.ny + op.nh;
    if (!hit) continue;
    selected = op.op === "add";
  }
  return selected;
}

function filterBySize(boxes: RawBox[], imgW: number, imgH: number, p: PostprocessSettings): BoxFilterResult[] {
  if (!boxes.length || imgW <= 0 || imgH <= 0) return [];
  const heights = boxes.map((b) => b.px.y2 - b.px.y1).filter((h) => h > 0);
  const medianH = median(heights);
  return boxes.map((box) => {
    const w = box.px.x2 - box.px.x1;
    const h = box.px.y2 - box.px.y1;
    const invalid = !(w > 0 && h > 0);
    const removedByHeight = !invalid && p.min_height_ratio > 0 && h < imgH * p.min_height_ratio;
    const removedByWidth = !invalid && p.min_width_ratio > 0 && w < imgW * p.min_width_ratio;
    const removedByMedian = !invalid && medianH > 0 && h < medianH * p.median_height_fraction && w < medianH * 2;
    const keep = !invalid && !removedByHeight && !removedByWidth && !removedByMedian;
    return { box, keep, removedBy: { width: removedByWidth, height: removedByHeight, median: removedByMedian } };
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
    line.sort((a, b) => (reverse ? b.px[secondaryStart] - a.px[secondaryStart] : a.px[secondaryStart] - b.px[secondaryStart]));
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
  updateVisualizers();

  overlayEl.style.width = `${g.displayWidth}px`;
  overlayEl.style.height = `${g.displayHeight}px`;
  overlayEl.style.left = `${g.left}px`;
  overlayEl.style.top = `${g.top}px`;
  overlaySvgEl.style.width = `${g.displayWidth}px`;
  overlaySvgEl.style.height = `${g.displayHeight}px`;
  overlaySvgEl.style.left = `${g.left}px`;
  overlaySvgEl.style.top = `${g.top}px`;
  overlaySvgEl.setAttribute("viewBox", `0 0 ${g.displayWidth} ${g.displayHeight}`);

  manualLayerEl.style.width = `${g.displayWidth}px`;
  manualLayerEl.style.height = `${g.displayHeight}px`;
  manualLayerEl.style.left = `${g.left}px`;
  manualLayerEl.style.top = `${g.top}px`;
  drawPreviewLayerEl.style.width = `${g.displayWidth}px`;
  drawPreviewLayerEl.style.height = `${g.displayHeight}px`;
  drawPreviewLayerEl.style.left = `${g.left}px`;
  drawPreviewLayerEl.style.top = `${g.top}px`;

  renderSelectionMask(g);
  renderManualLayer(g);

  if (overlayMode === "filter-preview" && filterResults.length > 0) {
    drawFilterPreview(g);
  } else {
    drawMergedView(g, overlayMode === "merge-preview");
  }
}

function renderSelectionMask(g: NonNullable<LabState["image"]>): void {
  selectionMaskEl.style.width = `${g.displayWidth}px`;
  selectionMaskEl.style.height = `${g.displayHeight}px`;
  selectionMaskEl.style.left = `${g.left}px`;
  selectionMaskEl.style.top = `${g.top}px`;
  selectionMaskEl.width = Math.max(1, Math.round(g.displayWidth));
  selectionMaskEl.height = Math.max(1, Math.round(g.displayHeight));

  const ctx = selectionMaskEl.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, selectionMaskEl.width, selectionMaskEl.height);

  const dark = "rgba(0,0,0,0.5)";
  if (!selectionBaseState) {
    ctx.fillStyle = dark;
    ctx.fillRect(0, 0, selectionMaskEl.width, selectionMaskEl.height);
  }

  for (const op of selectionOps) {
    const x = op.nx * selectionMaskEl.width;
    const y = op.ny * selectionMaskEl.height;
    const w = op.nw * selectionMaskEl.width;
    const h = op.nh * selectionMaskEl.height;
    if (op.op === "add") {
      ctx.clearRect(x, y, w, h);
    } else {
      ctx.fillStyle = dark;
      ctx.fillRect(x, y, w, h);
    }
  }

  if (!selectionBaseState || selectionOps.some((o) => o.op === "sub")) {
    activeLayers.push("selection-mask");
  }
}

function renderManualLayer(g: NonNullable<LabState["image"]>): void {
  manualLayerEl.innerHTML = "";
  if (!manualBoxes.length) return;
  activeLayers.push("manual-box");
  for (const box of manualBoxes) {
    const rendered = {
      left: box.nx * g.displayWidth,
      top: box.ny * g.displayHeight,
      width: box.nw * g.displayWidth,
      height: box.nh * g.displayHeight
    };

    const el = document.createElement("div");
    el.className = "manual-box";
    el.dataset.testid = "manual-box";
    el.style.left = `${rendered.left}px`;
    el.style.top = `${rendered.top}px`;
    el.style.width = `${rendered.width}px`;
    el.style.height = `${rendered.height}px`;

    const del = document.createElement("button");
    del.className = "manual-delete";
    del.dataset.testid = "manual-delete";
    del.textContent = "×";
    del.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      manualBoxes = manualBoxes.filter((m) => m.id !== box.id);
      persistDrawingState();
      recomputeLiveBoxes();
      refreshDebugState();
    });

    el.appendChild(del);
    manualLayerEl.appendChild(el);
  }
}

function drawFilterPreview(g: NonNullable<LabState["image"]>): void {
  activeLayers.push("overlay-filter-keep", "overlay-filter-drop");
  let failCount = 0;
  for (const r of filterResults) {
    const rendered = toRendered(r.box, g);
    const failedActive = activeFilterRule ? r.removedBy[activeFilterRule] : !r.keep;
    if (failedActive) failCount += 1;
    const el = document.createElement("div");
    el.className = failedActive ? "box box-drop" : "box box-keep";
    el.dataset.testid = failedActive ? "overlay-filter-drop" : "overlay-filter-keep";
    el.style.left = `${rendered.left}px`;
    el.style.top = `${rendered.top}px`;
    el.style.width = `${rendered.width}px`;
    el.style.height = `${rendered.height}px`;
    if (activeFilterRule === "width") {
      const guide = document.createElement("div");
      guide.className = "filter-guide-line vertical";
      const minWpx = (num("min-width-ratio") * Math.max(1, previewEl.naturalWidth) / Math.max(1, previewEl.naturalWidth)) * g.displayWidth;
      guide.style.left = `${Math.min(rendered.width - 1, Math.max(1, minWpx))}px`;
      el.appendChild(guide);
    } else if (activeFilterRule === "height") {
      const guide = document.createElement("div");
      guide.className = "filter-guide-line horizontal";
      const minHpx = (num("min-height-ratio") * Math.max(1, previewEl.naturalHeight) / Math.max(1, previewEl.naturalHeight)) * g.displayHeight;
      guide.style.top = `${Math.min(rendered.height - 1, Math.max(1, minHpx))}px`;
      el.appendChild(guide);
    } else if (activeFilterRule === "median") {
      const guide = document.createElement("div");
      guide.className = "filter-guide-box";
      const targetH = (filterStats.medianHeightPx * num("median-height-fraction")) / Math.max(1, previewEl.naturalHeight) * g.displayHeight;
      const h = Math.max(2, Math.min(rendered.height - 2, targetH));
      const w = Math.max(2, Math.min(rendered.width - 2, (filterStats.medianHeightPx * 2) / Math.max(1, previewEl.naturalWidth) * g.displayWidth));
      guide.style.height = `${h}px`;
      guide.style.width = `${w}px`;
      guide.style.left = `${Math.max(1, (rendered.width - w) / 2)}px`;
      guide.style.top = `${Math.max(1, (rendered.height - h) / 2)}px`;
      el.appendChild(guide);
    }
    overlayEl.appendChild(el);
  }
  if (activeFilterRule) {
    const badge = document.createElement("div");
    badge.className = "filter-live-badge";
    const total = filterResults.length;
    const label = activeFilterRule === "width" ? "width" : activeFilterRule === "height" ? "height" : "median";
    badge.textContent = `Failing ${failCount} / ${total} by ${label}`;
    badge.dataset.testid = "overlay-filter-live-badge";
    overlayEl.appendChild(badge);
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
      activeFilterRule = null;
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
  label("val-max-image-dimension", `${num("max-image-dimension")}`);
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
  label("rule-min-width", `Reject widths below ${(num("min-width-ratio") * 100).toFixed(1)}% of image width.`);
  label("rule-min-height", `Reject heights below ${(num("min-height-ratio") * 100).toFixed(1)}% of image height.`);
  label("rule-median-height", `Reject narrow boxes shorter than ${(num("median-height-fraction") * 100).toFixed(0)}% of median height (${Math.max(0, filterStats.medianHeightPx)}px).`);
  label("stat-min-width", `Removed by width rule: ${filterStats.widthRemoved}`);
  label("stat-min-height", `Removed by height rule: ${filterStats.heightRemoved}`);
  label("stat-median-height", `Removed by median rule: ${filterStats.medianRemoved}`);
}

function label(id: string, text: string): void {
  byId<HTMLElement>(id).textContent = text;
}

function getLabState(): LabState {
  return {
    preprocess: readPreprocess(),
    postprocess: readPostprocess(),
    maxImageDimension: num("max-image-dimension"),
    image: getImageGeometry(),
    rawCount: rawBoxes.length,
    liveCount: liveBoxes.length,
    filteredCount: filterResults.filter((r) => r.keep).length,
    mergedCount: mergedGroups.length,
    direction: readPostprocess().direction,
    overlayMode,
    overlayLayersActive: [...activeLayers],
    toolMode,
    selectionBaseState,
    selectionOpCount: selectionOps.length,
    manualBoxCount: manualBoxes.length,
    drawingActive,
    boxes: renderedBoxes,
    metrics: currentMetrics,
    status: currentStatus,
    serverUrl: serverUrlEl.value,
    serverHealthy,
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
  filterStats = { widthRemoved: 0, heightRemoved: 0, medianRemoved: 0, medianHeightPx: 0 };
  pendingDetect = false;
  activeLayers = [];
  overlayMode = "committed";

  imageUploadEl.value = "";
  previewEl.src = "";
  overlayEl.innerHTML = "";
  overlaySvgEl.innerHTML = "";
  manualLayerEl.innerHTML = "";
  drawPreviewLayerEl.innerHTML = "";
  viewerEl.classList.add("hidden");
  emptyEl.classList.remove("hidden");
  metricsEl.textContent = "No run yet";
  setStatus("Cleared");
}

async function checkHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${normalizeServerUrl(serverUrlEl.value)}/healthz`);
    const data = (await res.json()) as { ok: boolean; detector?: string };
    if (!res.ok || !data.ok) throw new Error("unhealthy");
    setStatus(`Healthy (${data.detector ?? "unknown"})`);
    setServerHealthy(true);
    return true;
  } catch {
    setStatus("Server unreachable");
    setServerHealthy(false);
    return false;
  }
}

function setServerHealthy(healthy: boolean): void {
  serverHealthy = healthy;
  applyHealthUiGate();
}

function applyHealthUiGate(): void {
  const sections = Array.from(document.querySelectorAll<HTMLElement>("section[data-ocr-controls]"));
  for (const section of sections) {
    section.classList.toggle("section-disabled", !serverHealthy);
    const controls = section.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement>("input, button, select, textarea");
    for (const control of controls) {
      control.disabled = !serverHealthy;
    }
  }
  detectBtn.disabled = !serverHealthy;
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

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
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

function setupRangeControls(): void {
  for (const id of RANGE_CONTROL_IDS) {
    const slider = byId<HTMLInputElement>(id);
    const numInput = byId<HTMLInputElement>(`${id}-num`);

    slider.addEventListener("input", () => {
      numInput.value = slider.value;
      refreshValueLabels();
      if (id === "max-image-dimension") {
        localStorage.setItem("preproc:maxImageDimension", slider.value);
      } else if (PREPROCESS_CONTROL_IDS.includes(id as any)) {
        schedulePreprocessAndDetect();
      } else {
        activeFilterRule = id === "min-width-ratio" ? "width" : id === "min-height-ratio" ? "height" : id === "median-height-fraction" ? "median" : null;
        setOverlayMode(FILTER_PREVIEW_IDS.includes(id as any) ? "filter-preview" : "merge-preview");
        recomputeLiveBoxes();
      }
      updateVisualizers();
    });

    numInput.addEventListener("input", () => {
      const val = Number(numInput.value);
      const min = Number(slider.min);
      const max = Number(slider.max);
      const step = Number(slider.step);
      const clamped = clamp(val, min, max);
      numInput.value = String(clamped);
      slider.value = String(clamped);
      refreshValueLabels();
      if (id === "max-image-dimension") {
        localStorage.setItem("preproc:maxImageDimension", slider.value);
      } else if (PREPROCESS_CONTROL_IDS.includes(id as any)) {
        schedulePreprocessAndDetect();
      } else {
        activeFilterRule = id === "min-width-ratio" ? "width" : id === "min-height-ratio" ? "height" : id === "median-height-fraction" ? "median" : null;
        setOverlayMode(FILTER_PREVIEW_IDS.includes(id as any) ? "filter-preview" : "merge-preview");
        recomputeLiveBoxes();
      }
      updateVisualizers();
    });
  }

  byId<HTMLInputElement>("invert").addEventListener("change", () => {
    refreshValueLabels();
    schedulePreprocessAndDetect();
  });

  byId<HTMLSelectElement>("reading-direction").addEventListener("change", () => {
    refreshValueLabels();
    activeFilterRule = null;
    setOverlayMode("merge-preview");
    recomputeLiveBoxes();
    updateVisualizers();
  });
}

function setupResetButtons(): void {
  for (const id of RANGE_CONTROL_IDS) {
    const resetBtn = byId<HTMLButtonElement>(`${id}-reset`);
    const defaultVal = RANGE_CONTROL_DEFAULTS[id];
    resetBtn.addEventListener("click", () => {
      byId<HTMLInputElement>(id).value = String(defaultVal);
      byId<HTMLInputElement>(`${id}-num`).value = String(defaultVal);
      refreshValueLabels();
      if (id === "max-image-dimension") {
        localStorage.setItem("preproc:maxImageDimension", String(defaultVal));
      } else if (PREPROCESS_CONTROL_IDS.includes(id as any)) {
        schedulePreprocessAndDetect();
      } else {
        activeFilterRule = id === "min-width-ratio" ? "width" : id === "min-height-ratio" ? "height" : id === "median-height-fraction" ? "median" : null;
        setOverlayMode(FILTER_PREVIEW_IDS.includes(id as any) ? "filter-preview" : "merge-preview");
        recomputeLiveBoxes();
      }
      updateVisualizers();
    });
  }

  byId<HTMLButtonElement>("invert-reset").addEventListener("click", () => {
    byId<HTMLInputElement>("invert").checked = INVERT_DEFAULT;
    refreshValueLabels();
    schedulePreprocessAndDetect();
  });

  byId<HTMLButtonElement>("reading-direction-reset").addEventListener("click", () => {
    byId<HTMLSelectElement>("reading-direction").value = READING_DIRECTION_DEFAULT;
    refreshValueLabels();
    activeFilterRule = null;
    setOverlayMode("merge-preview");
    recomputeLiveBoxes();
    updateVisualizers();
  });
}

function setupVisualizers(): void {
  updateVisualizers();
}

function updateVisualizers(): void {
  drawQualityViz();
}

function drawQualityViz(): void {
  const ctx = qualityVizEl.getContext("2d");
  if (!ctx) return;
  const w = qualityVizEl.width;
  const h = qualityVizEl.height;
  ctx.clearRect(0, 0, w, h);
  ctx.imageSmoothingEnabled = false;

  const maxDim = num("max-image-dimension");

  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, w, h);

  const sourceW = 240;
  const sourceH = 120;
  const src = document.createElement("canvas");
  src.width = sourceW;
  src.height = sourceH;
  const sctx = src.getContext("2d");
  if (!sctx) return;
  sctx.fillStyle = "#000";
  sctx.fillRect(0, 0, sourceW, sourceH);
  sctx.fillStyle = "#fff";
  sctx.font = "700 24px 'Segoe UI', sans-serif";
  sctx.textAlign = "center";
  sctx.textBaseline = "middle";
  sctx.fillText("Quality", sourceW / 2, sourceH / 2);

  const scaleFactor = clamp(maxDim / 1080, 0.2, 1);
  const tinyW = Math.max(1, Math.round(sourceW * scaleFactor));
  const tinyH = Math.max(1, Math.round(sourceH * scaleFactor));
  const tiny = document.createElement("canvas");
  tiny.width = tinyW;
  tiny.height = tinyH;
  const tctx = tiny.getContext("2d");
  if (!tctx) return;
  tctx.imageSmoothingEnabled = false;
  tctx.drawImage(src, 0, 0, tinyW, tinyH);

  const drawW = Math.min(w - 8, sourceW);
  const drawH = Math.min(h - 8, sourceH);
  const dx = Math.round((w - drawW) / 2);
  const dy = Math.round((h - drawH) / 2);
  ctx.drawImage(tiny, dx, dy, drawW, drawH);

  ctx.fillStyle = "#ffffff";
  ctx.font = "10px 'IBM Plex Sans', sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText(`${maxDim}px`, 4, 4);
}

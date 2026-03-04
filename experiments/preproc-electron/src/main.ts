import { createIcons, icons } from "lucide";
import "./styles.css";

type Primitive = string | number | boolean;

type PreprocessingSettings = {
  binary_threshold: number;
  invert: boolean;
  dilation: number;
  contrast: number;
  brightness: number;
};

type DetectionSettings = {
  min_width_ratio: number;
  min_height_ratio: number;
  median_height_fraction: number;
};

type DetectRequest = {
  preprocessing: PreprocessingSettings;
  detection: DetectionSettings;
};

type NormalizedBox = {
  id: string;
  norm: { x: number; y: number; w: number; h: number };
  px?: { x1: number; y1: number; x2: number; y2: number };
};

type Metrics = {
  preprocess_ms: number;
  detect_ms: number;
  filter_ms: number;
  total_ms: number;
  raw_count: number;
  filtered_count: number;
};

type DetectResponse = {
  status: "success" | "error";
  request_id?: string;
  image?: { width: number; height: number };
  boxes?: NormalizedBox[];
  metrics?: Metrics;
  settings?: DetectRequest;
  error?: { code: string; message: string };
};

type RenderedBox = {
  id: string;
  norm: { x: number; y: number; w: number; h: number };
  rendered: { left: number; top: number; width: number; height: number };
};

type LabState = {
  settings: DetectRequest;
  image: {
    naturalWidth: number;
    naturalHeight: number;
    displayWidth: number;
    displayHeight: number;
    left: number;
    top: number;
  } | null;
  boxes: RenderedBox[];
  metrics: Metrics | null;
  status: string;
  serverUrl: string;
};

type ElectronAPI = {
  startPythonServer: () => Promise<{ ok: boolean; message: string }>;
  stopPythonServer: () => Promise<{ ok: boolean; message: string }>;
  getPythonServerState: () => Promise<{ running: boolean; pid: number | null }>;
};

type LabAPI = {
  health: () => Promise<{ ok: boolean; detector?: string }>;
  setServerUrl: (url: string) => void;
  loadFixture: (name: string) => Promise<void>;
  loadImageBlob: (blob: Blob) => Promise<void>;
  set: (controlId: string, value: Primitive) => void;
  batchSet: (values: Record<string, Primitive>) => void;
  detect: () => Promise<{ status: string; filtered_count?: number }>;
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

let currentImageBlob: Blob | null = null;
let currentBoxes: NormalizedBox[] = [];
let renderedBoxes: RenderedBox[] = [];
let currentMetrics: Metrics | null = null;
let currentStatus = "idle";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) {
  throw new Error("App root not found");
}

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
      <div class="row">
        <button data-testid="btn-clear" id="btn-clear">Clear</button>
      </div>
    </section>

    <section>
      <h2>Preprocessing</h2>
      <label>Binary Threshold <span data-testid="val-threshold" id="val-threshold"></span></label>
      <input data-testid="binary-threshold" id="binary-threshold" type="range" min="0" max="255" step="1" value="0">

      <label>Contrast <span data-testid="val-contrast" id="val-contrast"></span></label>
      <input data-testid="contrast" id="contrast" type="range" min="0.2" max="3" step="0.1" value="1">

      <label>Brightness <span data-testid="val-brightness" id="val-brightness"></span></label>
      <input data-testid="brightness" id="brightness" type="range" min="-100" max="100" step="1" value="0">

      <label>Dilation/Erosion <span data-testid="val-dilation" id="val-dilation"></span></label>
      <input data-testid="dilation" id="dilation" type="range" min="-5" max="5" step="1" value="0">

      <label class="checkbox-row">
        <input data-testid="invert" id="invert" type="checkbox">
        Invert
      </label>
    </section>

    <section>
      <h2>Detection Filter</h2>
      <label>Min Width Ratio <span data-testid="val-min-width-ratio" id="val-min-width-ratio"></span></label>
      <input data-testid="min-width-ratio" id="min-width-ratio" type="range" min="0" max="0.1" step="0.001" value="0">

      <label>Min Height Ratio <span data-testid="val-min-height-ratio" id="val-min-height-ratio"></span></label>
      <input data-testid="min-height-ratio" id="min-height-ratio" type="range" min="0" max="0.1" step="0.001" value="0">

      <label>Median Height Fraction <span data-testid="val-median-height" id="val-median-height"></span></label>
      <input data-testid="median-height-fraction" id="median-height-fraction" type="range" min="0.1" max="1.2" step="0.05" value="0.45">

      <button data-testid="btn-detect" id="btn-detect" class="primary">Run Detection</button>
    </section>

    <section>
      <h2>Metrics</h2>
      <pre data-testid="metrics" id="metrics">No run yet</pre>
    </section>

    <section>
      <div class="row">
        <button data-testid="btn-debug-refresh" id="btn-debug-refresh">Refresh Debug</button>
      </div>
      <pre data-testid="debug-state" id="debug-state">No debug state yet</pre>
    </section>
  </aside>

  <main class="canvas-area" id="paste-target" data-testid="paste-target" tabindex="0">
    <div data-testid="empty" id="empty" class="empty">
      <i data-lucide="image-plus"></i>
      <p>Upload or paste an image to start.</p>
    </div>
    <div data-testid="viewer" id="viewer" class="viewer hidden">
      <img data-testid="preview" id="preview" alt="preview">
      <div data-testid="overlay" id="overlay" class="overlay"></div>
    </div>
  </main>
</div>
`;

createIcons({ icons });

const serverUrlEl = must<HTMLInputElement>("server-url");
const serverStatusEl = must<HTMLDivElement>("server-status");
const imageUploadEl = must<HTMLInputElement>("image-upload");
const detectBtn = must<HTMLButtonElement>("btn-detect");
const metricsEl = must<HTMLElement>("metrics");
const debugStateEl = must<HTMLElement>("debug-state");
const previewEl = must<HTMLImageElement>("preview");
const overlayEl = must<HTMLDivElement>("overlay");
const viewerEl = must<HTMLDivElement>("viewer");
const emptyEl = must<HTMLDivElement>("empty");
const pasteTargetEl = must<HTMLElement>("paste-target");

serverUrlEl.addEventListener("change", () => {
  localStorage.setItem("preproc:serverUrl", serverUrlEl.value.trim());
});

must<HTMLButtonElement>("btn-health").addEventListener("click", async () => {
  await checkHealth();
  refreshDebugState();
});

must<HTMLButtonElement>("btn-server-start").addEventListener("click", async () => {
  if (!window.electronAPI) return;
  const res = await window.electronAPI.startPythonServer();
  setStatus(res.message);
  await new Promise((resolve) => setTimeout(resolve, 900));
  await checkHealth();
  refreshDebugState();
});

must<HTMLButtonElement>("btn-server-stop").addEventListener("click", async () => {
  if (!window.electronAPI) return;
  const res = await window.electronAPI.stopPythonServer();
  setStatus(res.message);
  refreshDebugState();
});

must<HTMLButtonElement>("btn-clear").addEventListener("click", () => {
  resetState();
});

must<HTMLButtonElement>("btn-debug-refresh").addEventListener("click", () => {
  refreshDebugState();
});

imageUploadEl.addEventListener("change", async () => {
  const file = imageUploadEl.files?.[0];
  if (!file) return;
  await loadImageBlob(file);
  refreshDebugState();
});

window.addEventListener("paste", async (event) => {
  const items = event.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) {
        await loadImageBlob(file);
        setStatus("Pasted image from clipboard.");
        refreshDebugState();
      }
      break;
    }
  }
});

detectBtn.addEventListener("click", async () => {
  await runDetection();
  refreshDebugState();
});

window.addEventListener("resize", () => {
  if (currentBoxes.length > 0) {
    renderBoxes();
    refreshDebugState();
  }
});

bindValueLabels();
void checkHealth().then(refreshDebugState);

window.lab = {
  health: async () => {
    const url = normalizeServerUrl(serverUrlEl.value);
    const response = await fetch(`${url}/healthz`);
    const data = (await response.json()) as { ok: boolean; detector?: string };
    return data;
  },
  setServerUrl: (url: string) => {
    serverUrlEl.value = url;
    localStorage.setItem("preproc:serverUrl", url);
    refreshDebugState();
  },
  loadFixture: async (name: string) => {
    const fixtureUrl = `${FIXTURE_BASE}/${name.replace(/^\/+/, "")}`;
    const response = await fetch(fixtureUrl);
    if (!response.ok) throw new Error(`Fixture not found: ${fixtureUrl}`);
    const blob = await response.blob();
    await loadImageBlob(blob);
    refreshDebugState();
  },
  loadImageBlob: async (blob: Blob) => {
    await loadImageBlob(blob);
    refreshDebugState();
  },
  set: (controlId: string, value: Primitive) => {
    setControlValue(controlId, value);
    refreshDebugState();
  },
  batchSet: (values: Record<string, Primitive>) => {
    for (const [key, value] of Object.entries(values)) {
      setControlValue(key, value);
    }
    refreshDebugState();
  },
  detect: async () => {
    const result = await runDetection();
    refreshDebugState();
    return result;
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

async function loadImageBlob(blob: Blob): Promise<void> {
  currentImageBlob = blob;
  currentBoxes = [];
  renderedBoxes = [];
  currentMetrics = null;
  overlayEl.innerHTML = "";

  const objectUrl = URL.createObjectURL(blob);
  previewEl.src = objectUrl;
  await previewEl.decode();

  viewerEl.classList.remove("hidden");
  emptyEl.classList.add("hidden");
  setStatus("Image loaded.");
}

async function runDetection(): Promise<{ status: string; filtered_count?: number }> {
  if (!currentImageBlob) {
    setStatus("No image loaded.");
    return { status: "error" };
  }

  const payload = readSettings();
  const url = normalizeServerUrl(serverUrlEl.value);
  setStatus("Running detection...");

  try {
    const form = new FormData();
    form.append("image", currentImageBlob, "input.png");
    form.append("settings", JSON.stringify(payload));

    const response = await fetch(`${url}/v1/detect`, {
      method: "POST",
      body: form
    });

    const data = (await response.json()) as DetectResponse;
    if (!response.ok || data.status !== "success" || !data.boxes || !data.metrics) {
      throw new Error(data.error?.message ?? `HTTP ${response.status}`);
    }

    currentBoxes = data.boxes;
    currentMetrics = data.metrics;
    renderBoxes();
    metricsEl.textContent = JSON.stringify(data.metrics, null, 2);
    setStatus(`Done: ${data.metrics.filtered_count} boxes`);
    return { status: "success", filtered_count: data.metrics.filtered_count };
  } catch (error) {
    currentMetrics = null;
    setStatus(`Detection failed: ${String(error)}`);
    return { status: "error" };
  }
}

function renderBoxes(): void {
  overlayEl.innerHTML = "";
  renderedBoxes = [];
  const geometry = getImageGeometry();
  if (!geometry) return;

  overlayEl.style.width = `${geometry.displayWidth}px`;
  overlayEl.style.height = `${geometry.displayHeight}px`;
  overlayEl.style.left = `${geometry.left}px`;
  overlayEl.style.top = `${geometry.top}px`;

  for (const box of currentBoxes) {
    const rendered = {
      left: box.norm.x * geometry.displayWidth,
      top: box.norm.y * geometry.displayHeight,
      width: box.norm.w * geometry.displayWidth,
      height: box.norm.h * geometry.displayHeight
    };
    renderedBoxes.push({ id: box.id, norm: box.norm, rendered });

    const el = document.createElement("div");
    el.className = "box";
    el.setAttribute("data-testid", "overlay-box");
    el.setAttribute("data-box-id", box.id);
    el.style.left = `${rendered.left}px`;
    el.style.top = `${rendered.top}px`;
    el.style.width = `${rendered.width}px`;
    el.style.height = `${rendered.height}px`;
    overlayEl.appendChild(el);
  }
}

function getImageGeometry(): LabState["image"] {
  if (!previewEl.src || previewEl.naturalWidth <= 0 || previewEl.naturalHeight <= 0) {
    return null;
  }
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

function readSettings(): DetectRequest {
  return {
    preprocessing: {
      binary_threshold: getNum("binary-threshold"),
      invert: must<HTMLInputElement>("invert").checked,
      dilation: getNum("dilation"),
      contrast: getNum("contrast"),
      brightness: getNum("brightness")
    },
    detection: {
      min_width_ratio: getNum("min-width-ratio"),
      min_height_ratio: getNum("min-height-ratio"),
      median_height_fraction: getNum("median-height-fraction")
    }
  };
}

function setControlValue(controlId: string, value: Primitive): void {
  const el = document.getElementById(controlId);
  if (!el) {
    throw new Error(`Unknown control: ${controlId}`);
  }

  if (el instanceof HTMLInputElement) {
    if (el.type === "checkbox") {
      el.checked = Boolean(value);
    } else {
      el.value = String(value);
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  } else {
    throw new Error(`Control is not an input: ${controlId}`);
  }
}

async function checkHealth(): Promise<void> {
  const url = normalizeServerUrl(serverUrlEl.value);
  try {
    const response = await fetch(`${url}/healthz`);
    if (!response.ok) throw new Error(String(response.status));
    const data = (await response.json()) as { ok: boolean; detector?: string };
    if (!data.ok) throw new Error("Server not ready");
    setStatus(`Healthy (${data.detector ?? "unknown"})`);
  } catch {
    setStatus("Server unreachable");
  }
}

function normalizeServerUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function setStatus(text: string): void {
  currentStatus = text;
  serverStatusEl.textContent = `Status: ${text}`;
}

function getNum(id: string): number {
  return Number(must<HTMLInputElement>(id).value);
}

function bindValueLabels(): void {
  bindPair("binary-threshold", "val-threshold", (v) => `${v}`);
  bindPair("contrast", "val-contrast", (v) => Number(v).toFixed(1));
  bindPair("brightness", "val-brightness", (v) => `${v}`);
  bindPair("dilation", "val-dilation", (v) => `${v}`);
  bindPair("min-width-ratio", "val-min-width-ratio", (v) => Number(v).toFixed(3));
  bindPair("min-height-ratio", "val-min-height-ratio", (v) => Number(v).toFixed(3));
  bindPair("median-height-fraction", "val-median-height", (v) => Number(v).toFixed(2));
}

function bindPair(inputId: string, valueId: string, formatter: (raw: string) => string): void {
  const input = must<HTMLInputElement>(inputId);
  const output = must<HTMLElement>(valueId);
  const sync = (): void => {
    output.textContent = formatter(input.value);
  };
  input.addEventListener("input", sync);
  sync();
}

function getLabState(): LabState {
  return {
    settings: readSettings(),
    image: getImageGeometry(),
    boxes: renderedBoxes,
    metrics: currentMetrics,
    status: currentStatus,
    serverUrl: serverUrlEl.value
  };
}

function refreshDebugState(): void {
  debugStateEl.textContent = JSON.stringify(getLabState(), null, 2);
}

function resetState(): void {
  currentImageBlob = null;
  currentBoxes = [];
  renderedBoxes = [];
  currentMetrics = null;
  imageUploadEl.value = "";
  previewEl.src = "";
  overlayEl.innerHTML = "";
  viewerEl.classList.add("hidden");
  emptyEl.classList.remove("hidden");
  metricsEl.textContent = "No run yet";
  setStatus("Cleared");
}

function must<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element: ${id}`);
  return el as T;
}

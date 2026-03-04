import { applyPreprocessToDataUrl, normalizeImageDataUrl, scaleDataUrlMaxDimension } from "./image";
import { finalizeOcrBoxes, sanitizeRect } from "./logic";
import { PREPROCESS_MODAL_TEMPLATE } from "./modal-template";
import { checkRapidHealth, detectRapidRawBoxes } from "./rapid-client";
import type { DrawRect, SelectionOp, ToolMode } from "./types";
import type { AppConfig } from "../../core/models/types";

interface PreprocessResult {
  processedImageDataUrl: string;
  finalBoxes: DrawRect[];
  rapidRawCount: number;
}

interface ModalControllerOptions {
  root: HTMLElement;
  getConfig: () => AppConfig;
  saveConfig: (cfg: AppConfig) => void;
  getCurrentImageDataUrl: () => string | null;
  onApply: (result: PreprocessResult) => void;
  setStatus: (text: string) => void;
}

export class PreprocessModalController {
  private readonly root: HTMLElement;
  private readonly opts: ModalControllerOptions;
  private backdrop: HTMLElement;
  private preview: HTMLImageElement;
  private overlay: HTMLDivElement;
  private drawPreview: HTMLDivElement;

  private originalDataUrl: string | null = null;
  private processedDataUrl: string | null = null;
  private rapidBoxes: Array<{ id: string; nx: number; ny: number; nw: number; nh: number; px: { x1: number; y1: number; x2: number; y2: number } }> = [];
  private finalBoxes: DrawRect[] = [];
  private selectionOps: SelectionOp[] = [];
  private manualBoxes: DrawRect[] = [];
  private selectionBaseState = true;
  private toolMode: ToolMode = "none";
  private redrawTimer: number | null = null;
  private draggingStart: { x: number; y: number } | null = null;

  constructor(opts: ModalControllerOptions) {
    this.opts = opts;
    this.root = opts.root;
    this.root.insertAdjacentHTML("beforeend", PREPROCESS_MODAL_TEMPLATE);
    this.backdrop = this.mustQuery<HTMLElement>("[data-preproc-modal]");
    this.backdrop.style.display = "none";
    this.backdrop.style.pointerEvents = "none";
    this.preview = this.mustById<HTMLImageElement>("preproc-preview");
    this.overlay = this.mustById<HTMLDivElement>("preproc-overlay");
    this.drawPreview = this.mustById<HTMLDivElement>("preproc-draw-preview");
    this.bind();
  }

  async open(): Promise<void> {
    console.info("[preproc] open:start");
    const cfg = this.opts.getConfig();
    const source = this.opts.getCurrentImageDataUrl();
    if (!source) {
      this.opts.setStatus("Load an image first.");
      console.info("[preproc] open:no-source");
      return;
    }
    this.originalDataUrl = await normalizeImageDataUrl(source);
    this.selectionBaseState = cfg.preprocessing.selection.baseState;
    this.selectionOps = [...cfg.preprocessing.selection.ops];
    this.manualBoxes = [...cfg.preprocessing.selection.manualBoxes];

    this.setInput("preproc-rapid-enabled", cfg.textProcessing.rapidEnabled);
    this.setValue("preproc-rapid-url", cfg.textProcessing.rapidBaseUrl);

    this.setValue("preproc-max-dim", cfg.preprocessing.maxImageDimension);
    this.setValue("preproc-threshold", cfg.preprocessing.binaryThreshold);
    this.setValue("preproc-contrast", cfg.preprocessing.contrast);
    this.setValue("preproc-brightness", cfg.preprocessing.brightness);
    this.setValue("preproc-dilation", cfg.preprocessing.dilation);
    this.setInput("preproc-invert", cfg.preprocessing.invert);

    this.setValue("preproc-min-width", cfg.preprocessing.detectionFilter.minWidthRatio);
    this.setValue("preproc-min-height", cfg.preprocessing.detectionFilter.minHeightRatio);
    this.setValue("preproc-median", cfg.preprocessing.detectionFilter.medianHeightFraction);

    this.setValue("preproc-merge-v", cfg.preprocessing.merge.mergeVerticalRatio);
    this.setValue("preproc-merge-h", cfg.preprocessing.merge.mergeHorizontalRatio);
    this.setValue("preproc-merge-w", cfg.preprocessing.merge.mergeWidthRatioThreshold);
    this.setValue("preproc-group", cfg.preprocessing.sorting.groupTolerance);
    this.setValue("preproc-direction", cfg.preprocessing.sorting.direction);

    await this.recompute();
    this.backdrop.hidden = false;
    this.backdrop.style.display = "flex";
    this.backdrop.style.pointerEvents = "auto";
    console.info("[preproc] open:done");
  }

  close(): void {
    this.backdrop.hidden = true;
    this.backdrop.style.display = "none";
    this.backdrop.style.pointerEvents = "none";
    this.drawPreview.innerHTML = "";
    console.info("[preproc] close");
  }

  private bind(): void {
    this.mustById<HTMLButtonElement>("preproc-close").addEventListener("click", () => {
      try {
        this.applyAndClose();
      } catch {
        // Never trap the user in the modal due to apply errors.
        this.close();
      }
    });

    this.mustById<HTMLButtonElement>("preproc-rapid-health").addEventListener("click", async () => {
      await this.healthCheck();
    });

    const recomputeIds = [
      "preproc-rapid-enabled", "preproc-rapid-url", "preproc-max-dim", "preproc-threshold", "preproc-contrast", "preproc-brightness", "preproc-dilation", "preproc-invert",
      "preproc-min-width", "preproc-min-height", "preproc-median", "preproc-merge-v", "preproc-merge-h", "preproc-merge-w", "preproc-group", "preproc-direction"
    ];
    for (const id of recomputeIds) {
      const el = this.mustById<HTMLElement>(id);
      el.addEventListener("input", () => this.scheduleRecompute());
      el.addEventListener("change", () => this.scheduleRecompute());
    }

    this.mustById<HTMLButtonElement>("preproc-tool-none").addEventListener("click", () => { this.toolMode = "none"; this.renderOverlay(); });
    this.mustById<HTMLButtonElement>("preproc-tool-add").addEventListener("click", () => { this.toolMode = "add"; this.renderOverlay(); });
    this.mustById<HTMLButtonElement>("preproc-tool-sub").addEventListener("click", () => { this.toolMode = "sub"; this.renderOverlay(); });
    this.mustById<HTMLButtonElement>("preproc-tool-manual").addEventListener("click", () => { this.toolMode = "manual"; this.renderOverlay(); });

    this.mustById<HTMLButtonElement>("preproc-select-all").addEventListener("click", () => { this.selectionBaseState = true; this.selectionOps = []; this.scheduleRecompute(); });
    this.mustById<HTMLButtonElement>("preproc-deselect-all").addEventListener("click", () => { this.selectionBaseState = false; this.selectionOps = []; this.scheduleRecompute(); });
    this.mustById<HTMLButtonElement>("preproc-clear-manual").addEventListener("click", () => { this.manualBoxes = []; this.scheduleRecompute(); });

    const viewer = this.mustById<HTMLDivElement>("preproc-viewer");
    viewer.addEventListener("pointerdown", (e) => {
      if (this.toolMode === "none") return;
      const rect = viewer.getBoundingClientRect();
      this.draggingStart = { x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height };
      this.drawPreview.innerHTML = "";
    });
    viewer.addEventListener("pointermove", (e) => {
      if (!this.draggingStart) return;
      const rect = viewer.getBoundingClientRect();
      const nx2 = (e.clientX - rect.left) / rect.width;
      const ny2 = (e.clientY - rect.top) / rect.height;
      const nx = Math.min(this.draggingStart.x, nx2);
      const ny = Math.min(this.draggingStart.y, ny2);
      const nw = Math.abs(nx2 - this.draggingStart.x);
      const nh = Math.abs(ny2 - this.draggingStart.y);
      this.drawPreview.innerHTML = `<div class="box-preview" style="left:${nx * 100}%;top:${ny * 100}%;width:${nw * 100}%;height:${nh * 100}%"></div>`;
    });
    viewer.addEventListener("pointerup", (e) => {
      if (!this.draggingStart) return;
      const rect = viewer.getBoundingClientRect();
      const nx2 = (e.clientX - rect.left) / rect.width;
      const ny2 = (e.clientY - rect.top) / rect.height;
      const nx = Math.min(this.draggingStart.x, nx2);
      const ny = Math.min(this.draggingStart.y, ny2);
      const nw = Math.abs(nx2 - this.draggingStart.x);
      const nh = Math.abs(ny2 - this.draggingStart.y);
      this.draggingStart = null;
      this.drawPreview.innerHTML = "";
      const rectNorm = sanitizeRect({ id: crypto.randomUUID(), nx, ny, nw, nh });
      if (rectNorm.nw < 0.005 || rectNorm.nh < 0.005) return;
      if (this.toolMode === "manual") {
        this.manualBoxes.push(rectNorm);
      } else if (this.toolMode === "add" || this.toolMode === "sub") {
        this.selectionOps.push({ ...rectNorm, op: this.toolMode });
      }
      this.scheduleRecompute();
    });

    this.backdrop.addEventListener("click", (e) => {
      if (e.target !== this.backdrop) return;
      try {
        this.applyAndClose();
      } catch {
        this.close();
      }
    });
  }

  private async healthCheck(): Promise<void> {
    try {
      const h = await checkRapidHealth(this.getRapidUrl());
      this.mustById<HTMLDivElement>("preproc-health-status").textContent = h.ok ? `Healthy (${h.detector ?? "rapid"})` : "Unhealthy";
    } catch {
      this.mustById<HTMLDivElement>("preproc-health-status").textContent = "Unreachable";
    }
  }

  private scheduleRecompute(): void {
    if (this.redrawTimer) window.clearTimeout(this.redrawTimer);
    this.redrawTimer = window.setTimeout(() => { void this.recompute(); }, 120);
  }

  private async recompute(): Promise<void> {
    console.info("[preproc] recompute:start");
    if (!this.originalDataUrl) return;
    this.renderLabels();

    const processed = await applyPreprocessToDataUrl(this.originalDataUrl, {
      maxImageDimension: this.getNum("preproc-max-dim", 1080),
      binaryThreshold: this.getNum("preproc-threshold", 0),
      contrast: this.getNum("preproc-contrast", 1),
      brightness: this.getNum("preproc-brightness", 0),
      dilation: this.getNum("preproc-dilation", 0),
      invert: this.mustById<HTMLInputElement>("preproc-invert").checked
    });
    this.processedDataUrl = await scaleDataUrlMaxDimension(processed, this.getNum("preproc-max-dim", 1080));
    this.preview.src = this.processedDataUrl;
    await this.preview.decode();

    const rapidEnabled = this.mustById<HTMLInputElement>("preproc-rapid-enabled").checked;
    let rapidRaw = [] as typeof this.rapidBoxes;
    if (rapidEnabled) {
      try {
        const detect = await detectRapidRawBoxes(this.getRapidUrl(), this.processedDataUrl);
        rapidRaw = (detect.boxes ?? []).map((b) => ({ id: b.id, nx: b.norm.x, ny: b.norm.y, nw: b.norm.w, nh: b.norm.h, px: b.px }));
        this.mustById<HTMLDivElement>("preproc-health-status").textContent = "Healthy";
        this.mustById<HTMLDivElement>("preproc-metrics").textContent = `Rapid raw boxes: ${rapidRaw.length}`;
      } catch (error) {
        this.mustById<HTMLDivElement>("preproc-health-status").textContent = `Rapid error: ${String(error)}`;
      }
    }

    this.rapidBoxes = rapidRaw;
    this.finalBoxes = finalizeOcrBoxes({
      rapidRawBoxes: this.rapidBoxes.map((b) => ({ id: b.id, norm: { x: b.nx, y: b.ny, w: b.nw, h: b.nh }, px: b.px })),
      manualBoxes: this.manualBoxes,
      baseState: this.selectionBaseState,
      ops: this.selectionOps,
      imageW: Math.max(1, this.preview.naturalWidth),
      imageH: Math.max(1, this.preview.naturalHeight),
      filter: {
        minWidthRatio: this.getNum("preproc-min-width", 0),
        minHeightRatio: this.getNum("preproc-min-height", 0),
        medianHeightFraction: this.getNum("preproc-median", 0.45)
      },
      sorting: {
        direction: this.mustById<HTMLSelectElement>("preproc-direction").value as AppConfig["preprocessing"]["sorting"]["direction"],
        groupTolerance: this.getNum("preproc-group", 0.5)
      },
      merge: {
        mergeVerticalRatio: this.getNum("preproc-merge-v", 0.07),
        mergeHorizontalRatio: this.getNum("preproc-merge-h", 0.37),
        mergeWidthRatioThreshold: this.getNum("preproc-merge-w", 0.75)
      }
    });

    this.renderOverlay();
    console.info("[preproc] recompute:done", { rapidRaw: this.rapidBoxes.length, final: this.finalBoxes.length });
  }

  private renderOverlay(): void {
    this.overlay.innerHTML = "";
    const add = (b: DrawRect, cls: string) => {
      const el = document.createElement("div");
      el.className = `box ${cls}`;
      el.style.left = `${b.nx * 100}%`;
      el.style.top = `${b.ny * 100}%`;
      el.style.width = `${b.nw * 100}%`;
      el.style.height = `${b.nh * 100}%`;
      this.overlay.appendChild(el);
    };

    for (const b of this.finalBoxes) add(b, "box-final");
    for (const b of this.manualBoxes) add(b, "box-manual");

    this.mustById<HTMLButtonElement>("preproc-tool-none").classList.toggle("active-pin", this.toolMode === "none");
    this.mustById<HTMLButtonElement>("preproc-tool-add").classList.toggle("active-pin", this.toolMode === "add");
    this.mustById<HTMLButtonElement>("preproc-tool-sub").classList.toggle("active-pin", this.toolMode === "sub");
    this.mustById<HTMLButtonElement>("preproc-tool-manual").classList.toggle("active-pin", this.toolMode === "manual");
  }

  private applyAndClose(): void {
    console.info("[preproc] apply:start");
    const cfg = this.opts.getConfig();
    cfg.textProcessing.rapidEnabled = this.mustById<HTMLInputElement>("preproc-rapid-enabled").checked;
    cfg.textProcessing.rapidBaseUrl = this.getRapidUrl();

    cfg.preprocessing.maxImageDimension = this.getNum("preproc-max-dim", 1080);
    cfg.preprocessing.binaryThreshold = this.getNum("preproc-threshold", 0);
    cfg.preprocessing.contrast = this.getNum("preproc-contrast", 1);
    cfg.preprocessing.brightness = this.getNum("preproc-brightness", 0);
    cfg.preprocessing.dilation = this.getNum("preproc-dilation", 0);
    cfg.preprocessing.invert = this.mustById<HTMLInputElement>("preproc-invert").checked;

    cfg.preprocessing.detectionFilter.minWidthRatio = this.getNum("preproc-min-width", 0);
    cfg.preprocessing.detectionFilter.minHeightRatio = this.getNum("preproc-min-height", 0);
    cfg.preprocessing.detectionFilter.medianHeightFraction = this.getNum("preproc-median", 0.45);

    cfg.preprocessing.merge.mergeVerticalRatio = this.getNum("preproc-merge-v", 0.07);
    cfg.preprocessing.merge.mergeHorizontalRatio = this.getNum("preproc-merge-h", 0.37);
    cfg.preprocessing.merge.mergeWidthRatioThreshold = this.getNum("preproc-merge-w", 0.75);

    cfg.preprocessing.sorting.direction = this.mustById<HTMLSelectElement>("preproc-direction").value as AppConfig["preprocessing"]["sorting"]["direction"];
    cfg.preprocessing.sorting.groupTolerance = this.getNum("preproc-group", 0.5);

    cfg.preprocessing.selection.baseState = this.selectionBaseState;
    cfg.preprocessing.selection.ops = this.selectionOps;
    cfg.preprocessing.selection.manualBoxes = this.manualBoxes;

    this.opts.saveConfig(cfg);

    if (this.processedDataUrl) {
      this.opts.onApply({
        processedImageDataUrl: this.processedDataUrl,
        finalBoxes: this.finalBoxes,
        rapidRawCount: this.rapidBoxes.length
      });
    }
    this.close();
    console.info("[preproc] apply:done");
  }

  private renderLabels(): void {
    this.setText("preproc-max-dim-val", String(this.getNum("preproc-max-dim", 1080)));
    this.setText("preproc-threshold-val", String(this.getNum("preproc-threshold", 0)));
    this.setText("preproc-contrast-val", String(this.getNum("preproc-contrast", 1)));
    this.setText("preproc-brightness-val", String(this.getNum("preproc-brightness", 0)));
    this.setText("preproc-dilation-val", String(this.getNum("preproc-dilation", 0)));
    this.setText("preproc-min-width-val", this.getNum("preproc-min-width", 0).toFixed(3));
    this.setText("preproc-min-height-val", this.getNum("preproc-min-height", 0).toFixed(3));
    this.setText("preproc-median-val", this.getNum("preproc-median", 0.45).toFixed(2));
    this.setText("preproc-merge-v-val", this.getNum("preproc-merge-v", 0.07).toFixed(2));
    this.setText("preproc-merge-h-val", this.getNum("preproc-merge-h", 0.37).toFixed(2));
    this.setText("preproc-merge-w-val", this.getNum("preproc-merge-w", 0.75).toFixed(2));
    this.setText("preproc-group-val", this.getNum("preproc-group", 0.5).toFixed(2));
  }

  private getRapidUrl(): string {
    return this.mustById<HTMLInputElement>("preproc-rapid-url").value.trim();
  }

  private getNum(id: string, fallback: number): number {
    const v = Number(this.mustById<HTMLInputElement>(id).value);
    return Number.isFinite(v) ? v : fallback;
  }

  private setText(id: string, value: string): void {
    this.mustById<HTMLElement>(id).textContent = value;
  }

  private setValue(id: string, value: string | number): void {
    this.mustById<HTMLInputElement | HTMLSelectElement>(id).value = String(value);
  }

  private setInput(id: string, value: boolean): void {
    this.mustById<HTMLInputElement>(id).checked = value;
  }

  private mustById<T extends HTMLElement>(id: string): T {
    const el = document.getElementById(id);
    if (!el) throw new Error(`Missing element: ${id}`);
    return el as T;
  }

  private mustQuery<T extends Element>(sel: string): T {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`Missing element: ${sel}`);
    return el as T;
  }
}

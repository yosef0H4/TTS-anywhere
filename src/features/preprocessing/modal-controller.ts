import { applyPreprocessToDataUrl, normalizeImageDataUrl, scaleDataUrlMaxDimension } from "./image";
import { filterBySize, manualToRaw, mergeCloseBoxes, sanitizeRect, selectionKeepRatio, sortByReadingOrder } from "./logic";
import { PREPROCESS_MODAL_TEMPLATE } from "./modal-template";
import { checkRapidHealth, detectRapidRawBoxes } from "./rapid-client";
import type { DrawRect, FilteredBox, RawBox, SelectionOp, ToolMode } from "./types";
import type { AppConfig } from "../../core/models/types";

type OverlayMode = "committed" | "filter-preview" | "merge-preview";
type FilterRule = "width" | "height" | "median" | null;

type ImageGeometry = {
  naturalWidth: number;
  naturalHeight: number;
  displayWidth: number;
  displayHeight: number;
  left: number;
  top: number;
};

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

const CONTROL_DEFAULTS: Record<string, number | string | boolean> = {
  "preproc-max-dim": 1080,
  "preproc-threshold": 0,
  "preproc-contrast": 1,
  "preproc-brightness": 0,
  "preproc-dilation": 0,
  "preproc-invert": false,
  "preproc-min-width": 0,
  "preproc-min-height": 0,
  "preproc-median": 0.45,
  "preproc-direction": "horizontal_ltr",
  "preproc-merge-v": 0.07,
  "preproc-merge-h": 0.37,
  "preproc-merge-w": 0.75,
  "preproc-group": 0.5
};

const RANGE_CONTROL_IDS = [
  "preproc-max-dim", "preproc-threshold", "preproc-contrast", "preproc-brightness", "preproc-dilation",
  "preproc-min-width", "preproc-min-height", "preproc-median", "preproc-merge-v", "preproc-merge-h", "preproc-merge-w", "preproc-group"
] as const;
const PREPROCESS_IDS = ["preproc-threshold", "preproc-contrast", "preproc-brightness", "preproc-dilation", "preproc-invert", "preproc-max-dim"] as const;
const FILTER_IDS = ["preproc-min-width", "preproc-min-height", "preproc-median"] as const;
const MERGE_IDS = ["preproc-merge-v", "preproc-merge-h", "preproc-merge-w", "preproc-group", "preproc-direction"] as const;

export class PreprocessModalController {
  private readonly root: HTMLElement;
  private readonly opts: ModalControllerOptions;
  private readonly backdrop: HTMLElement;
  private readonly viewer: HTMLDivElement;
  private readonly preview: HTMLImageElement;
  private readonly overlay: HTMLDivElement;
  private readonly overlaySvg: SVGSVGElement;
  private readonly selectionMask: HTMLCanvasElement;
  private readonly manualLayer: HTMLDivElement;
  private readonly drawPreview: HTMLDivElement;
  private readonly qualityViz: HTMLCanvasElement;

  private originalDataUrl: string | null = null;
  private processedDataUrl: string | null = null;

  private rawBoxes: RawBox[] = [];
  private filterResults: FilteredBox[] = [];
  private mergedGroups: Array<{ rect: RawBox; members: RawBox[] }> = [];
  private finalBoxes: DrawRect[] = [];

  private selectionOps: SelectionOp[] = [];
  private manualBoxes: DrawRect[] = [];
  private selectionBaseState = true;

  private rapidHealthy = false;
  private pendingDetect = false;
  private detectSeq = 0;

  private toolMode: ToolMode = "none";
  private overlayMode: OverlayMode = "committed";
  private overlayModeTimer: number | null = null;
  private activeFilterRule: FilterRule = null;
  private redrawTimer: number | null = null;

  private draggingStart: { x: number; y: number } | null = null;

  private filterStats = { widthRemoved: 0, heightRemoved: 0, medianRemoved: 0, medianHeightPx: 0 };

  constructor(opts: ModalControllerOptions) {
    this.opts = opts;
    this.root = opts.root;
    this.root.insertAdjacentHTML("beforeend", PREPROCESS_MODAL_TEMPLATE);
    this.backdrop = this.mustQuery<HTMLElement>("[data-preproc-modal]");
    this.viewer = this.mustById<HTMLDivElement>("preproc-viewer");
    this.preview = this.mustById<HTMLImageElement>("preproc-preview");
    this.overlay = this.mustById<HTMLDivElement>("preproc-overlay");
    this.overlaySvg = this.mustById<SVGSVGElement>("preproc-overlay-svg");
    this.selectionMask = this.mustById<HTMLCanvasElement>("preproc-selection-mask");
    this.manualLayer = this.mustById<HTMLDivElement>("preproc-manual-layer");
    this.drawPreview = this.mustById<HTMLDivElement>("preproc-draw-preview");
    this.qualityViz = this.mustById<HTMLCanvasElement>("preproc-quality-viz");

    this.backdrop.style.display = "none";
    this.backdrop.style.pointerEvents = "none";

    this.bind();
    this.bindRangeNumberSync();
    this.bindResets();
  }

  async open(): Promise<void> {
    const cfg = this.opts.getConfig();
    const source = this.opts.getCurrentImageDataUrl();
    if (!source) {
      this.opts.setStatus("Load an image first.");
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

    this.syncNumericInputsFromRanges();
    this.renderLabels();
    this.updateQualityViz();

    await this.runPreprocessAndDetect();

    this.backdrop.hidden = false;
    this.backdrop.style.display = "flex";
    this.backdrop.style.pointerEvents = "auto";
  }

  close(): void {
    this.backdrop.hidden = true;
    this.backdrop.style.display = "none";
    this.backdrop.style.pointerEvents = "none";
    this.drawPreview.innerHTML = "";
  }

  private bind(): void {
    this.mustById<HTMLButtonElement>("preproc-close").addEventListener("click", () => {
      try {
        this.applyAndClose();
      } catch {
        this.close();
      }
    });

    this.backdrop.addEventListener("click", (e) => {
      if (e.target !== this.backdrop) return;
      try {
        this.applyAndClose();
      } catch {
        this.close();
      }
    });

    this.mustById<HTMLButtonElement>("preproc-rapid-health").addEventListener("click", async () => {
      await this.healthCheck();
    });
    this.mustById<HTMLButtonElement>("preproc-detect-now").addEventListener("click", async () => {
      await this.runPreprocessAndDetect();
    });

    this.mustById<HTMLInputElement>("preproc-rapid-enabled").addEventListener("change", async () => {
      if (!this.mustById<HTMLInputElement>("preproc-rapid-enabled").checked) {
        this.rawBoxes = [];
        this.rapidHealthy = false;
      }
      this.applyHealthGate();
      await this.runPreprocessAndDetect();
    });

    this.mustById<HTMLInputElement>("preproc-rapid-url").addEventListener("change", () => {
      this.rapidHealthy = false;
      this.applyHealthGate();
      this.mustById<HTMLDivElement>("preproc-health-status").textContent = "Idle";
    });

    for (const id of RANGE_CONTROL_IDS) {
      const range = this.mustById<HTMLInputElement>(id);
      range.addEventListener("input", () => {
        this.syncNumberFromRange(id);
        this.renderLabels();
        this.updateQualityViz();

        if ((PREPROCESS_IDS as readonly string[]).includes(id)) {
          this.schedulePreprocessAndDetect();
          return;
        }

        if ((FILTER_IDS as readonly string[]).includes(id)) {
          this.activeFilterRule = id === "preproc-min-width" ? "width" : id === "preproc-min-height" ? "height" : "median";
          this.setOverlayMode("filter-preview");
          this.recomputeLiveBoxes();
          return;
        }

        if ((MERGE_IDS as readonly string[]).includes(id)) {
          this.activeFilterRule = null;
          this.setOverlayMode("merge-preview");
          this.recomputeLiveBoxes();
        }
      });

      range.addEventListener("change", () => {
        if ((FILTER_IDS as readonly string[]).includes(id)) this.activeFilterRule = null;
        this.setOverlayMode("committed");
      });
    }

    this.mustById<HTMLInputElement>("preproc-invert").addEventListener("change", () => {
      this.renderLabels();
      this.schedulePreprocessAndDetect();
    });

    this.mustById<HTMLSelectElement>("preproc-direction").addEventListener("input", () => {
      this.renderLabels();
      this.activeFilterRule = null;
      this.setOverlayMode("merge-preview");
      this.recomputeLiveBoxes();
    });

    this.mustById<HTMLButtonElement>("preproc-tool-none").addEventListener("click", () => this.setTool("none"));
    this.mustById<HTMLButtonElement>("preproc-tool-add").addEventListener("click", () => this.setTool("add"));
    this.mustById<HTMLButtonElement>("preproc-tool-sub").addEventListener("click", () => this.setTool("sub"));
    this.mustById<HTMLButtonElement>("preproc-tool-manual").addEventListener("click", () => this.setTool("manual"));

    this.mustById<HTMLButtonElement>("preproc-select-all").addEventListener("click", () => {
      this.selectionBaseState = true;
      this.selectionOps = [];
      this.setOverlayMode("committed");
      this.recomputeLiveBoxes();
    });
    this.mustById<HTMLButtonElement>("preproc-deselect-all").addEventListener("click", () => {
      this.selectionBaseState = false;
      this.selectionOps = [];
      this.setOverlayMode("committed");
      this.recomputeLiveBoxes();
    });
    this.mustById<HTMLButtonElement>("preproc-clear-manual").addEventListener("click", () => {
      this.manualBoxes = [];
      this.setOverlayMode("committed");
      this.recomputeLiveBoxes();
    });

    this.viewer.addEventListener("pointerdown", (event) => {
      if (this.toolMode === "none") return;
      if (event.button !== 0) return;
      const point = this.pointerToNormalized(event.clientX, event.clientY);
      if (!point) return;
      this.draggingStart = point;
      this.drawPreview.innerHTML = "";
      event.preventDefault();
    });

    window.addEventListener("pointermove", (event) => {
      if (!this.draggingStart) return;
      const point = this.pointerToNormalized(event.clientX, event.clientY);
      if (!point) return;
      const r = this.normalizeRect(this.draggingStart.x, this.draggingStart.y, point.x, point.y);
      this.drawPreview.innerHTML = `<div class="box-preview" style="left:${r.nx * 100}%;top:${r.ny * 100}%;width:${r.nw * 100}%;height:${r.nh * 100}%"></div>`;
    });

    window.addEventListener("pointerup", (event) => {
      if (!this.draggingStart) return;
      const point = this.pointerToNormalized(event.clientX, event.clientY);
      this.drawPreview.innerHTML = "";
      if (!point) {
        this.draggingStart = null;
        return;
      }
      const rect = this.normalizeRect(this.draggingStart.x, this.draggingStart.y, point.x, point.y);
      this.draggingStart = null;
      const draw = sanitizeRect({ id: crypto.randomUUID(), ...rect });
      if (draw.nw <= 0.001 || draw.nh <= 0.001) return;

      if (this.toolMode === "manual") this.manualBoxes.push(draw);
      else if (this.toolMode === "add" || this.toolMode === "sub") this.selectionOps.push({ ...draw, op: this.toolMode });
      else return;

      this.setOverlayMode("committed");
      this.recomputeLiveBoxes();
    });

    window.addEventListener("resize", () => {
      this.renderOverlay();
    });
  }

  private setTool(mode: ToolMode): void {
    this.toolMode = mode;
    this.mustById<HTMLButtonElement>("preproc-tool-none").classList.toggle("active-pin", mode === "none");
    this.mustById<HTMLButtonElement>("preproc-tool-add").classList.toggle("active-pin", mode === "add");
    this.mustById<HTMLButtonElement>("preproc-tool-sub").classList.toggle("active-pin", mode === "sub");
    this.mustById<HTMLButtonElement>("preproc-tool-manual").classList.toggle("active-pin", mode === "manual");
  }

  private schedulePreprocessAndDetect(): void {
    if (this.redrawTimer) window.clearTimeout(this.redrawTimer);
    this.redrawTimer = window.setTimeout(() => {
      void this.runPreprocessAndDetect();
    }, 170);
  }

  private async runPreprocessAndDetect(): Promise<void> {
    if (!this.originalDataUrl) return;
    const seq = ++this.detectSeq;
    this.pendingDetect = true;

    try {
      const processed = await applyPreprocessToDataUrl(this.originalDataUrl, {
        maxImageDimension: this.getNum("preproc-max-dim", 1080),
        binaryThreshold: this.getNum("preproc-threshold", 0),
        contrast: this.getNum("preproc-contrast", 1),
        brightness: this.getNum("preproc-brightness", 0),
        dilation: this.getNum("preproc-dilation", 0),
        invert: this.mustById<HTMLInputElement>("preproc-invert").checked
      });
      if (seq !== this.detectSeq) return;

      this.processedDataUrl = await scaleDataUrlMaxDimension(processed, this.getNum("preproc-max-dim", 1080));
      this.preview.src = this.processedDataUrl;
      await this.preview.decode();

      const rapidEnabled = this.mustById<HTMLInputElement>("preproc-rapid-enabled").checked;
      if (rapidEnabled) {
        try {
          const detect = await detectRapidRawBoxes(this.getRapidUrl(), this.processedDataUrl);
          if (seq !== this.detectSeq) return;
          this.rawBoxes = detect.boxes ?? [];
          this.rapidHealthy = true;
          this.mustById<HTMLDivElement>("preproc-health-status").textContent = "Healthy";
        } catch (error) {
          this.rawBoxes = [];
          this.rapidHealthy = false;
          this.mustById<HTMLDivElement>("preproc-health-status").textContent = `Rapid error: ${String(error)}`;
        }
      } else {
        this.rawBoxes = [];
        this.rapidHealthy = false;
        this.mustById<HTMLDivElement>("preproc-health-status").textContent = "Disabled";
      }

      this.applyHealthGate();
      this.setOverlayMode("committed");
      this.recomputeLiveBoxes();
    } finally {
      this.pendingDetect = false;
    }
  }

  private recomputeLiveBoxes(): void {
    const g = this.getImageGeometry();
    if (!g) {
      this.filterResults = [];
      this.finalBoxes = [];
      this.mergedGroups = [];
      this.renderOverlay();
      return;
    }

    const selectedRapid = this.rawBoxes.filter((box) => selectionKeepRatio(box, g.naturalWidth, g.naturalHeight, this.selectionBaseState, this.selectionOps) > 0.1);
    this.filterResults = filterBySize(selectedRapid, g.naturalWidth, g.naturalHeight, {
      minWidthRatio: this.getNum("preproc-min-width", 0),
      minHeightRatio: this.getNum("preproc-min-height", 0),
      medianHeightFraction: this.getNum("preproc-median", 0.45)
    });

    const keptRapid = this.filterResults.filter((f) => f.keep).map((f) => f.box);
    const manualRaw = this.manualBoxes.map((m) => manualToRaw(m, g.naturalWidth, g.naturalHeight));

    const ordered = sortByReadingOrder([...keptRapid, ...manualRaw], {
      direction: this.mustById<HTMLSelectElement>("preproc-direction").value as AppConfig["preprocessing"]["sorting"]["direction"],
      groupTolerance: this.getNum("preproc-group", 0.5)
    });

    this.mergedGroups = mergeCloseBoxes(ordered, {
      mergeVerticalRatio: this.getNum("preproc-merge-v", 0.07),
      mergeHorizontalRatio: this.getNum("preproc-merge-h", 0.37),
      mergeWidthRatioThreshold: this.getNum("preproc-merge-w", 0.75)
    }, g.naturalWidth, g.naturalHeight);

    const finalRaw = this.mergedGroups.length ? this.mergedGroups.map((m) => m.rect) : ordered;
    this.finalBoxes = sortByReadingOrder(finalRaw, {
      direction: this.mustById<HTMLSelectElement>("preproc-direction").value as AppConfig["preprocessing"]["sorting"]["direction"],
      groupTolerance: this.getNum("preproc-group", 0.5)
    }).map((b) => ({ id: b.id, nx: b.norm.x, ny: b.norm.y, nw: b.norm.w, nh: b.norm.h }));

    this.computeFilterStats();
    this.renderLabels();
    this.renderOverlay();
    const keepCount = this.filterResults.filter((f) => f.keep).length;
    const dropCount = this.filterResults.length - keepCount;
    this.mustById<HTMLDivElement>("preproc-metrics").textContent = `Rapid raw: ${this.rawBoxes.length}, keep: ${keepCount}, drop: ${dropCount}, final: ${this.finalBoxes.length}`;
    this.mustById<HTMLElement>("preproc-debug-state").textContent = JSON.stringify({
      overlayMode: this.overlayMode,
      activeFilterRule: this.activeFilterRule,
      selectionBaseState: this.selectionBaseState,
      selectionOpCount: this.selectionOps.length,
      manualBoxCount: this.manualBoxes.length,
      pendingDetect: this.pendingDetect,
      rapidHealthy: this.rapidHealthy
    }, null, 2);
  }

  private renderOverlay(): void {
    this.overlay.innerHTML = "";
    this.overlaySvg.innerHTML = "";
    this.manualLayer.innerHTML = "";

    const g = this.getImageGeometry();
    if (!g) return;

    this.placeLayer(this.overlay, g);
    this.placeLayer(this.overlaySvg, g);
    this.placeLayer(this.selectionMask, g);
    this.placeLayer(this.manualLayer, g);
    this.placeLayer(this.drawPreview, g);
    this.overlaySvg.setAttribute("viewBox", `0 0 ${g.displayWidth} ${g.displayHeight}`);

    this.renderSelectionMask(g);
    this.renderManualLayer(g);

    if (this.overlayMode === "filter-preview" && this.filterResults.length > 0) {
      this.drawFilterPreview(g);
    } else {
      this.drawMergedView(g, this.overlayMode === "merge-preview");
    }
  }

  private renderSelectionMask(g: ImageGeometry): void {
    this.selectionMask.width = Math.max(1, Math.round(g.displayWidth));
    this.selectionMask.height = Math.max(1, Math.round(g.displayHeight));
    const ctx = this.selectionMask.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, this.selectionMask.width, this.selectionMask.height);

    const dark = "rgba(0,0,0,0.5)";
    if (!this.selectionBaseState) {
      ctx.fillStyle = dark;
      ctx.fillRect(0, 0, this.selectionMask.width, this.selectionMask.height);
    }

    for (const op of this.selectionOps) {
      const x = op.nx * this.selectionMask.width;
      const y = op.ny * this.selectionMask.height;
      const w = op.nw * this.selectionMask.width;
      const h = op.nh * this.selectionMask.height;
      if (op.op === "add") ctx.clearRect(x, y, w, h);
      else {
        ctx.fillStyle = dark;
        ctx.fillRect(x, y, w, h);
      }
    }
  }

  private renderManualLayer(g: ImageGeometry): void {
    for (const box of this.manualBoxes) {
      const rendered = this.normRectToDisplayRect(box, g);
      const el = document.createElement("div");
      el.className = "box box-manual";
      el.style.left = `${rendered.left}px`;
      el.style.top = `${rendered.top}px`;
      el.style.width = `${rendered.width}px`;
      el.style.height = `${rendered.height}px`;

      const del = document.createElement("button");
      del.className = "manual-delete";
      del.textContent = "×";
      del.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.manualBoxes = this.manualBoxes.filter((m) => m.id !== box.id);
        this.recomputeLiveBoxes();
      });
      el.appendChild(del);
      this.manualLayer.appendChild(el);
    }
  }

  private drawFilterPreview(g: ImageGeometry): void {
    let failCount = 0;
    for (const r of this.filterResults) {
      const rendered = this.toRendered(r.box, g);
      const failedActive = this.activeFilterRule ? r.removedBy[this.activeFilterRule] : !r.keep;
      if (failedActive) failCount += 1;
      const el = document.createElement("div");
      el.className = failedActive ? "box box-discard" : "box box-keep";
      el.style.left = `${rendered.left}px`;
      el.style.top = `${rendered.top}px`;
      el.style.width = `${rendered.width}px`;
      el.style.height = `${rendered.height}px`;

      if (this.activeFilterRule === "width") {
        const guide = document.createElement("div");
        guide.className = "filter-guide-line vertical";
        const minWpx = this.getNum("preproc-min-width", 0) * g.displayWidth;
        guide.style.left = `${Math.min(rendered.width - 1, Math.max(1, minWpx))}px`;
        el.appendChild(guide);
      } else if (this.activeFilterRule === "height") {
        const guide = document.createElement("div");
        guide.className = "filter-guide-line horizontal";
        const minHpx = this.getNum("preproc-min-height", 0) * g.displayHeight;
        guide.style.top = `${Math.min(rendered.height - 1, Math.max(1, minHpx))}px`;
        el.appendChild(guide);
      } else if (this.activeFilterRule === "median") {
        const guide = document.createElement("div");
        guide.className = "filter-guide-box";
        const targetH = (this.filterStats.medianHeightPx * this.getNum("preproc-median", 0.45)) / Math.max(1, g.naturalHeight) * g.displayHeight;
        const h = Math.max(2, Math.min(rendered.height - 2, targetH));
        const w = Math.max(2, Math.min(rendered.width - 2, (this.filterStats.medianHeightPx * 2) / Math.max(1, g.naturalWidth) * g.displayWidth));
        guide.style.height = `${h}px`;
        guide.style.width = `${w}px`;
        guide.style.left = `${Math.max(1, (rendered.width - w) / 2)}px`;
        guide.style.top = `${Math.max(1, (rendered.height - h) / 2)}px`;
        el.appendChild(guide);
      }

      this.overlay.appendChild(el);
    }

    if (this.activeFilterRule) {
      const badge = document.createElement("div");
      badge.className = "filter-live-badge";
      badge.textContent = `Failing ${failCount} / ${this.filterResults.length} by ${this.activeFilterRule}`;
      this.overlay.appendChild(badge);
    }
  }

  private drawMergedView(g: ImageGeometry, showHelpers: boolean): void {
    if (this.mergedGroups.length === 0) return;

    const centers: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < this.mergedGroups.length; i += 1) {
      const group = this.mergedGroups[i];
      if (!group) continue;
      const rendered = this.toRendered(group.rect, g);

      const box = document.createElement("div");
      box.className = "box box-final";
      box.style.left = `${rendered.left}px`;
      box.style.top = `${rendered.top}px`;
      box.style.width = `${rendered.width}px`;
      box.style.height = `${rendered.height}px`;
      this.overlay.appendChild(box);

      const seq = document.createElement("div");
      seq.className = "box-tag";
      seq.textContent = `${i + 1}`;
      seq.style.left = `${rendered.left - 12}px`;
      seq.style.top = `${rendered.top - 12}px`;
      this.overlay.appendChild(seq);

      centers.push({ x: rendered.left + rendered.width / 2, y: rendered.top + rendered.height / 2 });

      if (showHelpers) {
        this.drawTolerance(group, g);
        this.drawRatioBars(group, g);
      }
    }

    this.drawOrderPath(centers);
  }

  private drawTolerance(group: { rect: RawBox; members: RawBox[] }, g: ImageGeometry): void {
    const vTol = this.getNum("preproc-merge-v", 0.07) * 20;
    const hTol = this.getNum("preproc-merge-h", 0.37) * 20;

    for (const member of group.members) {
      const r = this.toRendered(member, g);
      const zone = document.createElement("div");
      zone.className = "box-tolerance";
      zone.style.left = `${r.left - hTol}px`;
      zone.style.top = `${r.top - vTol}px`;
      zone.style.width = `${r.width + hTol * 2}px`;
      zone.style.height = `${r.height + vTol * 2}px`;
      this.overlay.appendChild(zone);
    }
  }

  private drawRatioBars(group: { rect: RawBox; members: RawBox[] }, g: ImageGeometry): void {
    const ratio = this.getNum("preproc-merge-w", 0.75);
    for (const member of group.members) {
      const r = this.toRendered(member, g);
      const barW = r.width * ratio;
      const bar = document.createElement("div");
      bar.className = "ratio-bar";
      bar.style.left = `${r.left + (r.width - barW) / 2}px`;
      bar.style.top = `${Math.max(r.top, r.top + r.height - 6)}px`;
      bar.style.width = `${barW}px`;
      this.overlay.appendChild(bar);
    }
  }

  private drawOrderPath(centers: Array<{ x: number; y: number }>): void {
    if (centers.length < 2) return;

    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("class", "flow-path");
    path.setAttribute("d", `M ${centers.map((c) => `${c.x} ${c.y}`).join(" L ")}`);
    this.overlaySvg.appendChild(path);

    for (let i = 0; i < centers.length - 1; i += 1) {
      const from = centers[i];
      const to = centers[i + 1];
      if (!from || !to) continue;
      this.drawArrow(from, to);
    }
  }

  private drawArrow(from: { x: number; y: number }, to: { x: number; y: number }): void {
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
    poly.setAttribute("class", "flow-arrow");
    poly.setAttribute("points", `${tipX},${tipY} ${leftX},${leftY} ${rightX},${rightY}`);
    this.overlaySvg.appendChild(poly);
  }

  private computeFilterStats(): void {
    const heights = this.filterResults.map((f) => f.box.px.y2 - f.box.px.y1).filter((h) => h > 0).sort((a, b) => a - b);
    const mid = Math.floor(heights.length / 2);
    const med = heights.length % 2 === 0 ? ((heights[mid - 1] ?? 0) + (heights[mid] ?? 0)) / 2 : (heights[mid] ?? 0);
    this.filterStats = {
      widthRemoved: this.filterResults.filter((f) => f.removedBy.width).length,
      heightRemoved: this.filterResults.filter((f) => f.removedBy.height).length,
      medianRemoved: this.filterResults.filter((f) => f.removedBy.median).length,
      medianHeightPx: Math.max(0, Math.round(med || 0))
    };
  }

  private setOverlayMode(mode: OverlayMode): void {
    this.overlayMode = mode;
    if (this.overlayModeTimer) window.clearTimeout(this.overlayModeTimer);
    if (mode !== "committed") {
      this.overlayModeTimer = window.setTimeout(() => {
        this.overlayMode = "committed";
        this.activeFilterRule = null;
        this.renderOverlay();
      }, 280);
    }
  }

  private async healthCheck(): Promise<void> {
    try {
      const h = await checkRapidHealth(this.getRapidUrl());
      this.rapidHealthy = h.ok;
      this.mustById<HTMLDivElement>("preproc-health-status").textContent = h.ok ? `Healthy (${h.detector ?? "rapid"})` : "Unhealthy";
    } catch {
      this.rapidHealthy = false;
      this.mustById<HTMLDivElement>("preproc-health-status").textContent = "Unreachable";
    }
    this.applyHealthGate();
  }

  private applyHealthGate(): void {
    const rapidEnabled = this.mustById<HTMLInputElement>("preproc-rapid-enabled").checked;
    const active = rapidEnabled && this.rapidHealthy;

    for (const section of Array.from(this.backdrop.querySelectorAll<HTMLElement>("[data-rapid-dependent]"))) {
      section.classList.toggle("section-disabled", !active);
      const controls = section.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>("input, button, select");
      for (const control of Array.from(controls)) control.disabled = !active;
    }
    this.mustById<HTMLButtonElement>("preproc-detect-now").disabled = !rapidEnabled;
  }

  private bindRangeNumberSync(): void {
    for (const id of RANGE_CONTROL_IDS) {
      const numEl = document.getElementById(`${id}-num`) as HTMLInputElement | null;
      if (!numEl) continue;
      numEl.addEventListener("input", () => {
        this.mustById<HTMLInputElement>(id).value = numEl.value;
        this.mustById<HTMLInputElement>(id).dispatchEvent(new Event("input", { bubbles: true }));
      });
      numEl.addEventListener("change", () => {
        this.mustById<HTMLInputElement>(id).value = numEl.value;
        this.mustById<HTMLInputElement>(id).dispatchEvent(new Event("input", { bubbles: true }));
        this.mustById<HTMLInputElement>(id).dispatchEvent(new Event("change", { bubbles: true }));
      });
    }
  }

  private bindResets(): void {
    for (const [id, value] of Object.entries(CONTROL_DEFAULTS)) {
      const reset = document.getElementById(`${id}-reset`) as HTMLButtonElement | null;
      if (!reset) continue;
      reset.addEventListener("click", () => {
        if (typeof value === "boolean") {
          this.mustById<HTMLInputElement>(id).checked = value;
          this.mustById<HTMLInputElement>(id).dispatchEvent(new Event("change", { bubbles: true }));
          return;
        }
        this.setValue(id, value);
        const numEl = document.getElementById(`${id}-num`) as HTMLInputElement | null;
        if (numEl) numEl.value = String(value);
        this.mustById<HTMLInputElement | HTMLSelectElement>(id).dispatchEvent(new Event("input", { bubbles: true }));
        this.mustById<HTMLInputElement | HTMLSelectElement>(id).dispatchEvent(new Event("change", { bubbles: true }));
      });
    }
  }

  private syncNumericInputsFromRanges(): void {
    for (const id of RANGE_CONTROL_IDS) this.syncNumberFromRange(id);
  }

  private syncNumberFromRange(id: string): void {
    const numEl = document.getElementById(`${id}-num`) as HTMLInputElement | null;
    if (!numEl) return;
    numEl.value = this.mustById<HTMLInputElement>(id).value;
  }

  private updateQualityViz(): void {
    const ctx = this.qualityViz.getContext("2d");
    if (!ctx) return;
    const w = this.qualityViz.width;
    const h = this.qualityViz.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#000";
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

    const scaleFactor = clamp(this.getNum("preproc-max-dim", 1080) / 1080, 0.2, 1);
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
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tiny, dx, dy, drawW, drawH);
  }

  private renderLabels(): void {
    this.setText("preproc-max-dim-val", `${this.getNum("preproc-max-dim", 1080)}`);
    this.setText("preproc-threshold-val", `${this.getNum("preproc-threshold", 0)}`);
    this.setText("preproc-contrast-val", this.getNum("preproc-contrast", 1).toFixed(1));
    this.setText("preproc-brightness-val", `${this.getNum("preproc-brightness", 0)}`);
    this.setText("preproc-dilation-val", `${this.getNum("preproc-dilation", 0)}`);

    this.setText("preproc-min-width-val", this.getNum("preproc-min-width", 0).toFixed(3));
    this.setText("preproc-min-height-val", this.getNum("preproc-min-height", 0).toFixed(3));
    this.setText("preproc-median-val", this.getNum("preproc-median", 0.45).toFixed(2));

    this.setText("preproc-merge-v-val", this.getNum("preproc-merge-v", 0.07).toFixed(2));
    this.setText("preproc-merge-h-val", this.getNum("preproc-merge-h", 0.37).toFixed(2));
    this.setText("preproc-merge-w-val", this.getNum("preproc-merge-w", 0.75).toFixed(2));
    this.setText("preproc-group-val", this.getNum("preproc-group", 0.5).toFixed(2));

    this.setText("preproc-rule-min-width", `Reject widths below ${(this.getNum("preproc-min-width", 0) * 100).toFixed(1)}% of image width.`);
    this.setText("preproc-rule-min-height", `Reject heights below ${(this.getNum("preproc-min-height", 0) * 100).toFixed(1)}% of image height.`);
    this.setText("preproc-rule-median", `Reject narrow boxes shorter than ${(this.getNum("preproc-median", 0.45) * 100).toFixed(0)}% of median height (${this.filterStats.medianHeightPx}px).`);
    this.setText("preproc-stat-min-width", `Removed by width rule: ${this.filterStats.widthRemoved}`);
    this.setText("preproc-stat-min-height", `Removed by height rule: ${this.filterStats.heightRemoved}`);
    this.setText("preproc-stat-median", `Removed by median rule: ${this.filterStats.medianRemoved}`);
  }

  private applyAndClose(): void {
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
        rapidRawCount: this.rawBoxes.length
      });
    }

    this.close();
  }

  private getImageGeometry(): ImageGeometry | null {
    if (!this.preview.src || this.preview.naturalWidth <= 0 || this.preview.naturalHeight <= 0) return null;
    const viewRect = this.viewer.getBoundingClientRect();
    const imgRect = this.preview.getBoundingClientRect();
    return {
      naturalWidth: this.preview.naturalWidth,
      naturalHeight: this.preview.naturalHeight,
      displayWidth: imgRect.width,
      displayHeight: imgRect.height,
      left: imgRect.left - viewRect.left,
      top: imgRect.top - viewRect.top
    };
  }

  private placeLayer(layer: HTMLElement | SVGSVGElement | HTMLCanvasElement, g: ImageGeometry): void {
    layer.style.width = `${g.displayWidth}px`;
    layer.style.height = `${g.displayHeight}px`;
    layer.style.left = `${g.left}px`;
    layer.style.top = `${g.top}px`;
  }

  private normRectToDisplayRect(rect: { nx: number; ny: number; nw: number; nh: number }, g: ImageGeometry): { left: number; top: number; width: number; height: number } {
    return {
      left: rect.nx * g.displayWidth,
      top: rect.ny * g.displayHeight,
      width: rect.nw * g.displayWidth,
      height: rect.nh * g.displayHeight
    };
  }

  private toRendered(box: RawBox, g: ImageGeometry): { left: number; top: number; width: number; height: number } {
    return this.normRectToDisplayRect({ nx: box.norm.x, ny: box.norm.y, nw: box.norm.w, nh: box.norm.h }, g);
  }

  private normalizeRect(x1: number, y1: number, x2: number, y2: number): { nx: number; ny: number; nw: number; nh: number } {
    const nx = Math.min(x1, x2);
    const ny = Math.min(y1, y2);
    const nw = Math.abs(x2 - x1);
    const nh = Math.abs(y2 - y1);
    return sanitizeRect({ nx, ny, nw, nh });
  }

  private pointerToNormalized(clientX: number, clientY: number): { x: number; y: number } | null {
    const g = this.getImageGeometry();
    if (!g) return null;
    const rect = this.preview.getBoundingClientRect();
    return {
      x: clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1),
      y: clamp((clientY - rect.top) / Math.max(1, rect.height), 0, 1)
    };
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

  private mustById<T extends Element>(id: string): T {
    const el = document.getElementById(id);
    if (!el) throw new Error(`Missing element: ${id}`);
    return el as unknown as T;
  }

  private mustQuery<T extends Element>(sel: string): T {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`Missing element: ${sel}`);
    return el as T;
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

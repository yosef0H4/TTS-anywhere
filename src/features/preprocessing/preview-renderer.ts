import type { DrawRect, FilteredBox, MergeGroup, RawBox, SelectionOp } from "./types";

export type OverlayMode = "committed" | "filter-preview" | "merge-preview";
export type FilterRule = "width" | "height" | "median" | null;

export interface FilterStats {
  widthRemoved: number;
  heightRemoved: number;
  medianRemoved: number;
  medianHeightPx: number;
}

export interface PreviewRendererElements {
  viewer: HTMLElement;
  content?: HTMLDivElement;
  preview: HTMLImageElement;
  overlay: HTMLDivElement;
  overlaySvg: SVGSVGElement;
  selectionMask: HTMLCanvasElement;
  manualLayer: HTMLDivElement;
  drawPreview: HTMLDivElement;
}

export interface PreviewRendererState {
  overlayMode: OverlayMode;
  activeFilterRule: FilterRule;
  analysisWidth: number;
  analysisHeight: number;
  selectionBaseState: boolean;
  selectionOps: SelectionOp[];
  manualBoxes: DrawRect[];
  rawBoxes: RawBox[];
  filterResults: FilteredBox[];
  mergedGroups: MergeGroup[];
  filterStats: FilterStats;
}

type ImageGeometry = {
  naturalWidth: number;
  naturalHeight: number;
  displayWidth: number;
  displayHeight: number;
  left: number;
  top: number;
};

const DEFAULT_STATS: FilterStats = { widthRemoved: 0, heightRemoved: 0, medianRemoved: 0, medianHeightPx: 0 };

export class PreprocPreviewRenderer {
  private state: PreviewRendererState = {
    overlayMode: "committed",
    activeFilterRule: null,
    analysisWidth: 0,
    analysisHeight: 0,
    selectionBaseState: true,
    selectionOps: [],
    manualBoxes: [],
    rawBoxes: [],
    filterResults: [],
    mergedGroups: [],
    filterStats: DEFAULT_STATS
  };
  private viewport = {
    zoom: 1,
    panX: 0,
    panY: 0,
    minZoom: 1,
    maxZoom: 8
  };
  private resizeObserver: ResizeObserver | null = null;
  private rafId: number | null = null;
  private readonly onPreviewLoad = (): void => {
    this.resetViewport();
    this.requestRender();
  };

  constructor(
    private readonly els: PreviewRendererElements,
    private readonly opts: {
      getThresholds: () => { minWidthRatio: number; minHeightRatio: number; medianHeightFraction: number; mergeVerticalRatio: number; mergeHorizontalRatio: number; mergeWidthRatioThreshold: number };
      onDeleteManual?: (id: string) => void;
    }
  ) {}

  setState(next: Partial<PreviewRendererState>): void {
    this.state = { ...this.state, ...next };
  }

  startAutoSync(): void {
    this.stopAutoSync();
    this.els.preview.addEventListener("load", this.onPreviewLoad);

    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => this.requestRender());
      this.resizeObserver.observe(this.els.viewer);
      this.resizeObserver.observe(this.els.preview);
      if (this.els.viewer.parentElement) {
        this.resizeObserver.observe(this.els.viewer.parentElement);
      }
    }
  }

  stopAutoSync(): void {
    this.els.preview.removeEventListener("load", this.onPreviewLoad);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.rafId !== null) {
      window.cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  requestRender(): void {
    if (this.rafId !== null) return;
    this.rafId = window.requestAnimationFrame(() => {
      this.rafId = null;
      this.render();
    });
  }

  render(): void {
    const { overlay, overlaySvg, manualLayer } = this.els;
    overlay.innerHTML = "";
    overlaySvg.innerHTML = "";
    manualLayer.innerHTML = "";

    const g = this.getImageGeometry();
    if (!g) {
      if (this.els.content) {
        this.els.content.style.width = "0px";
        this.els.content.style.height = "0px";
        this.els.content.style.transform = "";
      }
      return;
    }

    if (this.els.content) {
      this.els.content.style.width = `${g.displayWidth}px`;
      this.els.content.style.height = `${g.displayHeight}px`;
      this.els.content.style.transform = `translate(${g.left}px, ${g.top}px) scale(${this.viewport.zoom})`;
    }

    this.placeLayer(this.els.overlay, g);
    this.placeLayer(this.els.overlaySvg, g);
    this.placeLayer(this.els.selectionMask, g);
    this.placeLayer(this.els.manualLayer, g);
    this.placeLayer(this.els.drawPreview, g);
    this.els.overlaySvg.setAttribute("viewBox", `0 0 ${g.displayWidth} ${g.displayHeight}`);

    this.renderSelectionMask(g);
    this.renderManualLayer(g);

    if (this.state.overlayMode === "filter-preview" && this.state.filterResults.length > 0) {
      this.drawFilterPreview(g);
      return;
    }
    this.drawMergedView(g, this.state.overlayMode === "merge-preview");
  }

  pointerToNormalized(clientX: number, clientY: number): { x: number; y: number } | null {
    if (!this.els.content) {
      const rect = this.els.preview.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      return {
        x: clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1),
        y: clamp((clientY - rect.top) / Math.max(1, rect.height), 0, 1)
      };
    }
    const g = this.getImageGeometry();
    if (!g) return null;
    const viewerRect = this.els.viewer.getBoundingClientRect();
    const localX = clientX - viewerRect.left;
    const localY = clientY - viewerRect.top;
    const contentX = (localX - g.left) / Math.max(this.viewport.zoom, 0.001);
    const contentY = (localY - g.top) / Math.max(this.viewport.zoom, 0.001);
    if (contentX < 0 || contentY < 0 || contentX > g.displayWidth || contentY > g.displayHeight) return null;
    return {
      x: clamp(contentX / Math.max(1, g.displayWidth), 0, 1),
      y: clamp(contentY / Math.max(1, g.displayHeight), 0, 1)
    };
  }

  resetViewport(): void {
    this.viewport.zoom = 1;
    this.viewport.panX = 0;
    this.viewport.panY = 0;
  }

  zoomAt(clientX: number, clientY: number, deltaY: number): void {
    const current = this.getImageGeometry();
    if (!current) return;
    const factor = deltaY < 0 ? 1.1 : 1 / 1.1;
    const nextZoom = clamp(this.viewport.zoom * factor, this.viewport.minZoom, this.viewport.maxZoom);
    if (Math.abs(nextZoom - this.viewport.zoom) < 0.0001) return;

    const viewerRect = this.els.viewer.getBoundingClientRect();
    const localX = clientX - viewerRect.left;
    const localY = clientY - viewerRect.top;
    const contentX = (localX - current.left) / Math.max(this.viewport.zoom, 0.001);
    const contentY = (localY - current.top) / Math.max(this.viewport.zoom, 0.001);

    this.viewport.zoom = nextZoom;
    const base = this.getBaseGeometry();
    if (!base) return;
    this.viewport.panX = localX - base.left - contentX * this.viewport.zoom;
    this.viewport.panY = localY - base.top - contentY * this.viewport.zoom;
    this.clampViewport(base);
    this.requestRender();
  }

  panBy(dx: number, dy: number): void {
    const base = this.getBaseGeometry();
    if (!base) return;
    this.viewport.panX += dx;
    this.viewport.panY += dy;
    this.clampViewport(base);
    this.requestRender();
  }

  getViewportSnapshot(): { zoom: number; panX: number; panY: number } {
    return { zoom: this.viewport.zoom, panX: this.viewport.panX, panY: this.viewport.panY };
  }

  private getImageGeometry(): ImageGeometry | null {
    if (!this.els.content) {
      return this.getLegacyImageGeometry();
    }
    const base = this.getBaseGeometry();
    if (!base) return null;
    return {
      ...base,
      left: base.left + this.viewport.panX,
      top: base.top + this.viewport.panY
    };
  }

  private getBaseGeometry(): ImageGeometry | null {
    const { preview, viewer } = this.els;
    if (!preview.src || preview.naturalWidth <= 0 || preview.naturalHeight <= 0) return null;
    const viewRect = viewer.getBoundingClientRect();
    if (viewRect.width <= 0 || viewRect.height <= 0) return null;
    const scale = Math.min(viewRect.width / preview.naturalWidth, viewRect.height / preview.naturalHeight);
    const displayWidth = Math.max(1, preview.naturalWidth * scale);
    const displayHeight = Math.max(1, preview.naturalHeight * scale);
    const base = {
      naturalWidth: preview.naturalWidth,
      naturalHeight: preview.naturalHeight,
      displayWidth,
      displayHeight,
      left: (viewRect.width - displayWidth) / 2,
      top: (viewRect.height - displayHeight) / 2
    };
    this.clampViewport(base);
    return base;
  }

  private getLegacyImageGeometry(): ImageGeometry | null {
    const { preview, viewer } = this.els;
    if (!preview.src || preview.naturalWidth <= 0 || preview.naturalHeight <= 0) return null;
    const viewRect = viewer.getBoundingClientRect();
    const imgRect = preview.getBoundingClientRect();
    if (imgRect.width <= 0 || imgRect.height <= 0) return null;
    return {
      naturalWidth: preview.naturalWidth,
      naturalHeight: preview.naturalHeight,
      displayWidth: imgRect.width,
      displayHeight: imgRect.height,
      left: imgRect.left - viewRect.left,
      top: imgRect.top - viewRect.top
    };
  }

  private placeLayer(layer: HTMLElement | SVGSVGElement | HTMLCanvasElement, g: ImageGeometry): void {
    layer.style.width = `${g.displayWidth}px`;
    layer.style.height = `${g.displayHeight}px`;
    layer.style.left = this.els.content ? "0px" : `${g.left}px`;
    layer.style.top = this.els.content ? "0px" : `${g.top}px`;
  }

  private renderSelectionMask(g: ImageGeometry): void {
    const mask = this.els.selectionMask;
    mask.width = Math.max(1, Math.round(g.displayWidth));
    mask.height = Math.max(1, Math.round(g.displayHeight));
    const ctx = mask.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, mask.width, mask.height);

    const dark = "rgba(0,0,0,0.5)";
    if (!this.state.selectionBaseState) {
      ctx.fillStyle = dark;
      ctx.fillRect(0, 0, mask.width, mask.height);
    }

    for (const op of this.state.selectionOps) {
      const x = op.nx * mask.width;
      const y = op.ny * mask.height;
      const w = op.nw * mask.width;
      const h = op.nh * mask.height;
      if (op.op === "add") ctx.clearRect(x, y, w, h);
      else {
        ctx.fillStyle = dark;
        ctx.fillRect(x, y, w, h);
      }
    }
  }

  private renderManualLayer(g: ImageGeometry): void {
    for (const box of this.state.manualBoxes) {
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
        this.opts.onDeleteManual?.(box.id);
      });
      el.appendChild(del);
      this.els.manualLayer.appendChild(el);
    }
  }

  private drawFilterPreview(g: ImageGeometry): void {
    let failCount = 0;
    const thresholds = this.opts.getThresholds();
    for (const r of this.state.filterResults) {
      const rendered = this.toRendered(r.box, g);
      const failedActive = this.state.activeFilterRule ? r.removedBy[this.state.activeFilterRule] : !r.keep;
      if (failedActive) failCount += 1;
      const el = document.createElement("div");
      el.className = failedActive ? "box box-discard" : "box box-keep";
      el.style.left = `${rendered.left}px`;
      el.style.top = `${rendered.top}px`;
      el.style.width = `${rendered.width}px`;
      el.style.height = `${rendered.height}px`;

      if (this.state.activeFilterRule === "width") {
        const guide = document.createElement("div");
        guide.className = "filter-guide-line vertical";
        const minWpx = thresholds.minWidthRatio * g.displayWidth;
        guide.style.left = `${Math.min(rendered.width - 1, Math.max(1, minWpx))}px`;
        el.appendChild(guide);
      } else if (this.state.activeFilterRule === "height") {
        const guide = document.createElement("div");
        guide.className = "filter-guide-line horizontal";
        const minHpx = thresholds.minHeightRatio * g.displayHeight;
        guide.style.top = `${Math.min(rendered.height - 1, Math.max(1, minHpx))}px`;
        el.appendChild(guide);
      } else if (this.state.activeFilterRule === "median") {
        const guide = document.createElement("div");
        guide.className = "filter-guide-box";
        const analysisHeight = this.state.analysisHeight || g.naturalHeight;
        const analysisWidth = this.state.analysisWidth || g.naturalWidth;
        const targetH = (this.state.filterStats.medianHeightPx * thresholds.medianHeightFraction) / Math.max(1, analysisHeight) * g.displayHeight;
        const h = Math.max(2, Math.min(rendered.height - 2, targetH));
        const w = Math.max(2, Math.min(rendered.width - 2, (this.state.filterStats.medianHeightPx * 2) / Math.max(1, analysisWidth) * g.displayWidth));
        guide.style.height = `${h}px`;
        guide.style.width = `${w}px`;
        guide.style.left = `${Math.max(1, (rendered.width - w) / 2)}px`;
        guide.style.top = `${Math.max(1, (rendered.height - h) / 2)}px`;
        el.appendChild(guide);
      }

      this.els.overlay.appendChild(el);
    }

    if (this.state.activeFilterRule) {
      const badge = document.createElement("div");
      badge.className = "filter-live-badge";
      badge.textContent = `Failing ${failCount} / ${this.state.filterResults.length} by ${this.state.activeFilterRule}`;
      this.els.overlay.appendChild(badge);
    }
  }

  private drawMergedView(g: ImageGeometry, showHelpers: boolean): void {
    if (this.state.mergedGroups.length === 0) return;

    const centers: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < this.state.mergedGroups.length; i += 1) {
      const group = this.state.mergedGroups[i];
      if (!group) continue;
      const rendered = this.toRendered(group.rect, g);

      const box = document.createElement("div");
      box.className = "box box-final";
      box.style.left = `${rendered.left}px`;
      box.style.top = `${rendered.top}px`;
      box.style.width = `${rendered.width}px`;
      box.style.height = `${rendered.height}px`;
      this.els.overlay.appendChild(box);

      const seq = document.createElement("div");
      seq.className = "box-tag";
      seq.textContent = `${i + 1}`;
      seq.style.left = `${rendered.left - 12}px`;
      seq.style.top = `${rendered.top - 12}px`;
      this.els.overlay.appendChild(seq);

      centers.push({ x: rendered.left + rendered.width / 2, y: rendered.top + rendered.height / 2 });

      if (showHelpers) {
        this.drawTolerance(group, g);
        this.drawRatioBars(group, g);
      }
    }

    this.drawOrderPath(centers);
  }

  private drawTolerance(group: MergeGroup, g: ImageGeometry): void {
    const t = this.opts.getThresholds();
    const vTol = t.mergeVerticalRatio * 20;
    const hTol = t.mergeHorizontalRatio * 20;

    for (const member of group.members) {
      const r = this.toRendered(member, g);
      const zone = document.createElement("div");
      zone.className = "box-tolerance";
      zone.style.left = `${r.left - hTol}px`;
      zone.style.top = `${r.top - vTol}px`;
      zone.style.width = `${r.width + hTol * 2}px`;
      zone.style.height = `${r.height + vTol * 2}px`;
      this.els.overlay.appendChild(zone);
    }
  }

  private drawRatioBars(group: MergeGroup, g: ImageGeometry): void {
    const ratio = this.opts.getThresholds().mergeWidthRatioThreshold;
    for (const member of group.members) {
      const r = this.toRendered(member, g);
      const barW = r.width * ratio;
      const bar = document.createElement("div");
      bar.className = "ratio-bar";
      bar.style.left = `${r.left + (r.width - barW) / 2}px`;
      bar.style.top = `${Math.max(r.top, r.top + r.height - 6)}px`;
      bar.style.width = `${barW}px`;
      this.els.overlay.appendChild(bar);
    }
  }

  private drawOrderPath(centers: Array<{ x: number; y: number }>): void {
    if (centers.length < 2) return;

    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("class", "flow-path");
    path.setAttribute("d", `M ${centers.map((c) => `${c.x} ${c.y}`).join(" L ")}`);
    this.els.overlaySvg.appendChild(path);

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
    this.els.overlaySvg.appendChild(poly);
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

  private clampViewport(base: ImageGeometry): void {
    if (this.viewport.zoom <= 1.0001) {
      this.viewport.panX = 0;
      this.viewport.panY = 0;
      return;
    }
    const viewRect = this.els.viewer.getBoundingClientRect();
    const scaledWidth = base.displayWidth * this.viewport.zoom;
    const scaledHeight = base.displayHeight * this.viewport.zoom;
    const minPanX = viewRect.width - base.left - scaledWidth;
    const minPanY = viewRect.height - base.top - scaledHeight;
    this.viewport.panX = clamp(this.viewport.panX, Math.min(0, minPanX), 0);
    this.viewport.panY = clamp(this.viewport.panY, Math.min(0, minPanY), 0);
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

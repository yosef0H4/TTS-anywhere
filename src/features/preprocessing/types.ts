export type ReadingDirection = "horizontal_ltr" | "horizontal_rtl" | "vertical_ltr" | "vertical_rtl";

export type ToolMode = "none" | "add" | "sub" | "manual";

export interface PreprocessSettings {
  maxImageDimension: number;
  binaryThreshold: number;
  contrast: number;
  brightness: number;
  dilation: number;
  invert: boolean;
}

export interface DetectionFilterSettings {
  minWidthRatio: number;
  minHeightRatio: number;
  medianHeightFraction: number;
}

export interface MergeSettings {
  mergeVerticalRatio: number;
  mergeHorizontalRatio: number;
  mergeWidthRatioThreshold: number;
}

export interface SortingSettings {
  direction: ReadingDirection;
  groupTolerance: number;
}

export interface BoxAdjustmentSettings {
  boxPaddingWidthRatio: number;
  boxPaddingHeightRatio: number;
}

export interface DrawRect {
  id: string;
  nx: number;
  ny: number;
  nw: number;
  nh: number;
}

export interface SelectionOp extends DrawRect {
  op: "add" | "sub";
}

export interface RawBox {
  id: string;
  norm: { x: number; y: number; w: number; h: number };
  px: { x1: number; y1: number; x2: number; y2: number };
}

export interface MergeGroup {
  rect: RawBox;
  members: RawBox[];
}

export interface FilteredBox {
  box: RawBox;
  keep: boolean;
  removedBy: { width: boolean; height: boolean; median: boolean };
}

export interface DetectResponse {
  status: "success" | "error";
  raw_boxes?: RawBox[];
  metrics?: { detect_ms: number; total_ms: number; raw_count: number };
  error?: { message?: string };
}

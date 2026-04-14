export type HotkeySpec = {
  label: string;
  modifiers: number;
  vk: number;
  releaseVk: number;
};

export type HotkeySessionEvents = {
  onHotkeyRegistered?: (label: string) => void;
  onHotkeySwitched?: (label: string) => void;
  onTriggerDown?: (point: { x: number; y: number }) => void;
  onTriggerUp?: (point: { x: number; y: number }) => void;
};

export type HotkeySessionOptions = {
  initialHotkey?: string | null;
  pollMs?: number;
  events?: HotkeySessionEvents;
};

export type MonitorBounds = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type FrozenCaptureHandle = {
  id: number;
  bounds: MonitorBounds;
  capturedAt: number;
  captureAttempts?: number;
};

export type CaptureCropRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type SendSpec = {
  label: string;
  modifiers: number;
  vk: number;
};

export type SendHotkeyOptions = {
  pressDurationMs?: number;
  blind?: boolean;
  modifierReleaseSettleTimeoutMs?: number;
  modifierReleaseSettlePollMs?: number;
};

export type ClipboardWaitMode = "text_or_files" | "any";

export type ClipboardFormatEntry = {
  format: number;
  size: number;
  data: Buffer;
};

export type ClipboardSnapshot = {
  advertisedFormats: number[];
  skippedFormats: Array<{ format: number; reason: string }>;
  formats: ClipboardFormatEntry[];
  plainText: string;
  signature: string;
  capturedAt: number;
};

export type ClipboardWaitOptions = {
  timeoutMs?: number;
  pollMs?: number;
  mode?: ClipboardWaitMode;
};

export type ClipboardRestoreResult = {
  restoredCount: number;
  failedFormats: number[];
};

export type CopyCaptureOptions = {
  copyHotkey?: string;
  timeoutMs?: number;
  pollMs?: number;
  restoreClipboard?: boolean;
  waitMode?: ClipboardWaitMode;
};

export type CopyCaptureResult = {
  changed: boolean;
  text: string;
  snapshot: ClipboardSnapshot;
  clearedSignature: string;
  changedBySequence: boolean;
  sequenceBeforeClear: number;
  sequenceAfterClear: number;
  sequenceAfterCopy: number;
  postRestoreText?: string;
  restore?: ClipboardRestoreResult;
};

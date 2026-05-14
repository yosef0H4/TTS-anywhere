export type {
  HotkeySpec,
  HotkeySessionEvents,
  HotkeySessionOptions,
  SendSpec,
  MouseButton,
  SendMode,
  SendHotkeyOptions,
  MouseClickOptions,
  MonitorBounds,
  WindowHandle,
  WindowInfo,
  FrozenCaptureHandle,
  CaptureCropRect,
  ClipboardWaitMode,
  ClipboardFormatEntry,
  ClipboardSnapshot,
  ClipboardWaitOptions,
  ClipboardRestoreResult,
  CopyCaptureOptions,
  CopyCaptureResult
} from "./types.js";
export { parseHotkeySpec } from "./hotkey-parser.js";
export { parseSendSpec, sendHotkey, sendHotkeyToWindow, sendMouseClickAtPoint } from "./send.js";
export { snapshotClipboard, restoreClipboard, clearClipboard, readClipboardText, waitForClipboardChange, captureCopyToText } from "./clipboard.js";
export {
  captureWindowRegion,
  captureMonitorAtPoint,
  beginFrozenMonitorCaptureAtPoint,
  cropFrozenCapture,
  disposeFrozenCapture,
  getMonitorBoundsAtPoint,
  getForegroundWindowBounds,
  getForegroundWindowInfo,
  getWindowInfo
} from "./capture.js";
export { BorderOverlay } from "./overlay.js";
export { HotkeySession } from "./session.js";

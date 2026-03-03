export type HotkeySpec = {
  label: string;
  modifiers: number;
  vk: number;
  releaseVk: number;
};

export type CaptureRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type CaptureResult = {
  rect: CaptureRect;
  pngBuffer: Buffer;
};

export type NodeHotkeyEvents = {
  onHotkeyRegistered?: (label: string) => void;
  onHotkeySwitched?: (label: string) => void;
  onCaptureStart?: (start: { x: number; y: number; hotkey: string }) => void;
  onCaptureFinalize?: (rect: CaptureRect) => void;
  onError?: (error: Error) => void;
};

export type NodeHotkeyOptions = {
  initialHotkey?: string;
  pollMs?: number;
  borderThickness?: number;
  events?: NodeHotkeyEvents;
};

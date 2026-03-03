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
  initialHotkey?: string;
  pollMs?: number;
  events?: HotkeySessionEvents;
};

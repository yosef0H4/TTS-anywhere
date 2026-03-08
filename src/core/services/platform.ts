export interface PlatformBridge {
  onCapturedImage(handler: (payload: { dataUrl: string; isTap: boolean }) => void): void;
  onCopiedTextForPlayback(handler: (text: string) => void): void;
  onAbortRequested(handler: () => void): void;
  onPlaybackHotkey(handler: (action: "toggle_play_pause" | "next_chunk" | "previous_chunk" | "volume_up" | "volume_down") => void): void;
}

export interface RecommendedCpuStackUrls {
  detectionBaseUrl: string;
  ocrBaseUrl: string;
  ttsBaseUrl: string;
}

export interface RecommendedCpuStackStatus {
  state: "stopped" | "starting" | "running" | "failed";
  managed: boolean;
  urls: RecommendedCpuStackUrls | null;
  error: string | null;
}

export interface ElectronApi {
  onCapturedImage: (handler: (payload: { dataUrl: string; isTap: boolean }) => void) => void;
  onCopiedTextForPlayback: (handler: (text: string) => void) => void;
  onAbortRequested: (handler: () => void) => void;
  onPlaybackHotkey: (handler: (action: "toggle_play_pause" | "next_chunk" | "previous_chunk" | "volume_up" | "volume_down") => void) => void;
  getAlwaysOnTop: () => Promise<boolean>;
  setAlwaysOnTop: (enabled: boolean) => Promise<boolean>;
  beginCaptureHotkeyEdit: () => Promise<string>;
  applyCaptureHotkey: (hotkey: string) => Promise<string>;
  cancelCaptureHotkeyEdit: () => Promise<string>;
  getCaptureHotkey: () => Promise<string>;
  beginCopyHotkeyEdit: () => Promise<string>;
  applyCopyHotkey: (hotkey: string) => Promise<string>;
  cancelCopyHotkeyEdit: () => Promise<string>;
  getCopyHotkey: () => Promise<string>;
  beginAbortHotkeyEdit: () => Promise<string>;
  applyAbortHotkey: (hotkey: string) => Promise<string>;
  cancelAbortHotkeyEdit: () => Promise<string>;
  getAbortHotkey: () => Promise<string>;
  beginPlayPauseHotkeyEdit: () => Promise<string>;
  applyPlayPauseHotkey: (hotkey: string) => Promise<string>;
  cancelPlayPauseHotkeyEdit: () => Promise<string>;
  getPlayPauseHotkey: () => Promise<string>;
  beginNextChunkHotkeyEdit: () => Promise<string>;
  applyNextChunkHotkey: (hotkey: string) => Promise<string>;
  cancelNextChunkHotkeyEdit: () => Promise<string>;
  getNextChunkHotkey: () => Promise<string>;
  beginPreviousChunkHotkeyEdit: () => Promise<string>;
  applyPreviousChunkHotkey: (hotkey: string) => Promise<string>;
  cancelPreviousChunkHotkeyEdit: () => Promise<string>;
  getPreviousChunkHotkey: () => Promise<string>;
  beginVolumeUpHotkeyEdit: () => Promise<string>;
  applyVolumeUpHotkey: (hotkey: string) => Promise<string>;
  cancelVolumeUpHotkeyEdit: () => Promise<string>;
  getVolumeUpHotkey: () => Promise<string>;
  beginVolumeDownHotkeyEdit: () => Promise<string>;
  applyVolumeDownHotkey: (hotkey: string) => Promise<string>;
  cancelVolumeDownHotkeyEdit: () => Promise<string>;
  getVolumeDownHotkey: () => Promise<string>;
  beginReplayCaptureHotkeyEdit: () => Promise<string>;
  applyReplayCaptureHotkey: (hotkey: string) => Promise<string>;
  cancelReplayCaptureHotkeyEdit: () => Promise<string>;
  getReplayCaptureHotkey: () => Promise<string>;
  setCaptureDrawRectangle: (enabled: boolean) => Promise<boolean>;
  getCaptureDrawRectangle: () => Promise<boolean>;
  launchRecommendedCpuStack: () => Promise<RecommendedCpuStackStatus>;
  stopRecommendedCpuStack: () => Promise<RecommendedCpuStackStatus>;
  openRuntimeServicesFolder: () => Promise<string>;
  getRecommendedCpuStackStatus: () => Promise<RecommendedCpuStackStatus>;
  recordStartupPhase?: (phase: string, details?: Record<string, unknown>) => void;
  sendLogEntries: (entries: unknown[]) => void;
  getLogLevel: () => Promise<string>;
  setLogLevel: (level: string) => Promise<void>;
  getLogFilePath: () => Promise<string>;
  clearLogs: () => Promise<void>;
}

declare global {
  interface Window {
    electronAPI?: ElectronApi;
  }
}

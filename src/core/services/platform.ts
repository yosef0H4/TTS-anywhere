export interface PlatformBridge {
  onCapturedImage(handler: (dataUrl: string) => void): void;
  onCopiedTextForPlayback(handler: (text: string) => void): void;
}

export interface ElectronApi {
  onCapturedImage: (handler: (dataUrl: string) => void) => void;
  onCopiedTextForPlayback: (handler: (text: string) => void) => void;
  beginCaptureHotkeyEdit: () => Promise<string>;
  applyCaptureHotkey: (hotkey: string) => Promise<string>;
  cancelCaptureHotkeyEdit: () => Promise<string>;
  getCaptureHotkey: () => Promise<string>;
  beginCopyHotkeyEdit: () => Promise<string>;
  applyCopyHotkey: (hotkey: string) => Promise<string>;
  cancelCopyHotkeyEdit: () => Promise<string>;
  getCopyHotkey: () => Promise<string>;
  setCaptureDrawRectangle: (enabled: boolean) => Promise<boolean>;
  getCaptureDrawRectangle: () => Promise<boolean>;
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

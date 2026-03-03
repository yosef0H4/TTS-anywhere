export interface PlatformBridge {
  onCapturedImage(handler: (dataUrl: string) => void): void;
}

export interface ElectronApi {
  onCapturedImage: (handler: (dataUrl: string) => void) => void;
  minimizeWindow: () => void;
  toggleMaximizeWindow: () => Promise<boolean>;
  closeWindow: () => void;
  getPinState: () => Promise<boolean>;
  togglePinWindow: () => Promise<boolean>;
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

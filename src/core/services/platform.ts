export interface PlatformBridge {
  onCaptureRequested(handler: () => void): void;
}

export interface ElectronApi {
  onCaptureRequested: (handler: () => void) => void;
  minimizeWindow: () => void;
  toggleMaximizeWindow: () => Promise<boolean>;
  closeWindow: () => void;
  getPinState: () => Promise<boolean>;
  togglePinWindow: () => Promise<boolean>;
}

declare global {
  interface Window {
    electronAPI?: ElectronApi;
  }
}

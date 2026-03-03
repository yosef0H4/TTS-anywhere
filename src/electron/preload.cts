import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("electronAPI", {
  onCapturedImage: (handler: (dataUrl: string) => void) => {
    ipcRenderer.on("capture-image", (_event, payload: { dataUrl?: string }) => {
      if (payload?.dataUrl) handler(payload.dataUrl);
    });
  },
  beginCaptureHotkeyEdit: () => {
    return ipcRenderer.invoke("capture:begin-hotkey-edit") as Promise<string>;
  },
  applyCaptureHotkey: (hotkey: string) => {
    return ipcRenderer.invoke("capture:apply-hotkey", hotkey) as Promise<string>;
  },
  cancelCaptureHotkeyEdit: () => {
    return ipcRenderer.invoke("capture:cancel-hotkey-edit") as Promise<string>;
  },
  getCaptureHotkey: () => {
    return ipcRenderer.invoke("capture:get-hotkey") as Promise<string>;
  },
  setCaptureDrawRectangle: (enabled: boolean) => {
    return ipcRenderer.invoke("capture:set-draw-rectangle", enabled) as Promise<boolean>;
  },
  getCaptureDrawRectangle: () => {
    return ipcRenderer.invoke("capture:get-draw-rectangle") as Promise<boolean>;
  },
  minimizeWindow: () => {
    ipcRenderer.send("window:minimize");
  },
  toggleMaximizeWindow: () => {
    return ipcRenderer.invoke("window:toggle-maximize") as Promise<boolean>;
  },
  closeWindow: () => {
    ipcRenderer.send("window:close");
  },
  getPinState: () => {
    return ipcRenderer.invoke("window:get-pin") as Promise<boolean>;
  },
  togglePinWindow: () => {
    return ipcRenderer.invoke("window:toggle-pin") as Promise<boolean>;
  },
  sendLogEntries: (entries: unknown[]) => {
    ipcRenderer.send("log:write", entries);
  },
  getLogLevel: () => {
    return ipcRenderer.invoke("log:get-level") as Promise<string>;
  },
  setLogLevel: (level: string) => {
    return ipcRenderer.invoke("log:set-level", level) as Promise<void>;
  },
  getLogFilePath: () => {
    return ipcRenderer.invoke("log:get-path") as Promise<string>;
  },
  clearLogs: () => {
    return ipcRenderer.invoke("log:clear") as Promise<void>;
  }
});

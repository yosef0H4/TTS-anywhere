import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("electronAPI", {
  onCapturedImage: (handler: (dataUrl: string) => void) => {
    ipcRenderer.on("capture-image", (_event, payload: { dataUrl?: string }) => {
      if (payload?.dataUrl) handler(payload.dataUrl);
    });
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

import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("electronAPI", {
  onCaptureRequested: (handler: () => void) => {
    ipcRenderer.on("capture-requested", () => handler());
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
  }
});

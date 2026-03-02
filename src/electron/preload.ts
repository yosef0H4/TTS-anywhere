import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("electronAPI", {
  onCaptureRequested: (handler: () => void) => {
    ipcRenderer.on("capture-requested", () => handler());
  },
  minimizeWindow: () => {
    ipcRenderer.send("window:minimize");
  },
  closeWindow: () => {
    ipcRenderer.send("window:close");
  },
  togglePinWindow: () => {
    return ipcRenderer.invoke("window:toggle-pin") as Promise<boolean>;
  }
});

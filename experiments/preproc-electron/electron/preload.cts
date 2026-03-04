import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("electronAPI", {
  startPythonServer: () => ipcRenderer.invoke("python:start") as Promise<{ ok: boolean; message: string }>,
  stopPythonServer: () => ipcRenderer.invoke("python:stop") as Promise<{ ok: boolean; message: string }>,
  getPythonServerState: () => ipcRenderer.invoke("python:state") as Promise<{ running: boolean; pid: number | null }>
});

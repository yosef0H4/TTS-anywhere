import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("electronAPI", {
  onCapturedImage: (handler: (payload: { dataUrl: string; isTap: boolean }) => void) => {
    ipcRenderer.on("capture-image", (_event, payload: { dataUrl?: string; isTap?: boolean }) => {
      if (payload?.dataUrl) handler({ dataUrl: payload.dataUrl, isTap: payload.isTap === true });
    });
  },
  onCopiedTextForPlayback: (handler: (text: string) => void) => {
    ipcRenderer.on("copy-play-text", (_event, payload: { text?: string }) => {
      if (payload?.text) handler(payload.text);
    });
  },
  onAbortRequested: (handler: () => void) => {
    ipcRenderer.on("abort-requested", () => {
      handler();
    });
  },
  onPlaybackHotkey: (
    handler: (action: "toggle_play_pause" | "next_chunk" | "previous_chunk" | "volume_up" | "volume_down") => void
  ) => {
    ipcRenderer.on("playback-hotkey", (
      _event,
      payload: { action?: "toggle_play_pause" | "next_chunk" | "previous_chunk" | "volume_up" | "volume_down" }
    ) => {
      if (payload?.action) handler(payload.action);
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
  beginCopyHotkeyEdit: () => {
    return ipcRenderer.invoke("copy:begin-hotkey-edit") as Promise<string>;
  },
  applyCopyHotkey: (hotkey: string) => {
    return ipcRenderer.invoke("copy:apply-hotkey", hotkey) as Promise<string>;
  },
  cancelCopyHotkeyEdit: () => {
    return ipcRenderer.invoke("copy:cancel-hotkey-edit") as Promise<string>;
  },
  getCopyHotkey: () => {
    return ipcRenderer.invoke("copy:get-hotkey") as Promise<string>;
  },
  beginAbortHotkeyEdit: () => {
    return ipcRenderer.invoke("abort:begin-hotkey-edit") as Promise<string>;
  },
  applyAbortHotkey: (hotkey: string) => {
    return ipcRenderer.invoke("abort:apply-hotkey", hotkey) as Promise<string>;
  },
  cancelAbortHotkeyEdit: () => {
    return ipcRenderer.invoke("abort:cancel-hotkey-edit") as Promise<string>;
  },
  getAbortHotkey: () => {
    return ipcRenderer.invoke("abort:get-hotkey") as Promise<string>;
  },
  beginPlayPauseHotkeyEdit: () => {
    return ipcRenderer.invoke("playback-toggle:begin-hotkey-edit") as Promise<string>;
  },
  applyPlayPauseHotkey: (hotkey: string) => {
    return ipcRenderer.invoke("playback-toggle:apply-hotkey", hotkey) as Promise<string>;
  },
  cancelPlayPauseHotkeyEdit: () => {
    return ipcRenderer.invoke("playback-toggle:cancel-hotkey-edit") as Promise<string>;
  },
  getPlayPauseHotkey: () => {
    return ipcRenderer.invoke("playback-toggle:get-hotkey") as Promise<string>;
  },
  beginNextChunkHotkeyEdit: () => {
    return ipcRenderer.invoke("playback-next:begin-hotkey-edit") as Promise<string>;
  },
  applyNextChunkHotkey: (hotkey: string) => {
    return ipcRenderer.invoke("playback-next:apply-hotkey", hotkey) as Promise<string>;
  },
  cancelNextChunkHotkeyEdit: () => {
    return ipcRenderer.invoke("playback-next:cancel-hotkey-edit") as Promise<string>;
  },
  getNextChunkHotkey: () => {
    return ipcRenderer.invoke("playback-next:get-hotkey") as Promise<string>;
  },
  beginPreviousChunkHotkeyEdit: () => {
    return ipcRenderer.invoke("playback-previous:begin-hotkey-edit") as Promise<string>;
  },
  applyPreviousChunkHotkey: (hotkey: string) => {
    return ipcRenderer.invoke("playback-previous:apply-hotkey", hotkey) as Promise<string>;
  },
  cancelPreviousChunkHotkeyEdit: () => {
    return ipcRenderer.invoke("playback-previous:cancel-hotkey-edit") as Promise<string>;
  },
  getPreviousChunkHotkey: () => {
    return ipcRenderer.invoke("playback-previous:get-hotkey") as Promise<string>;
  },
  beginVolumeUpHotkeyEdit: () => {
    return ipcRenderer.invoke("volume-up:begin-hotkey-edit") as Promise<string>;
  },
  applyVolumeUpHotkey: (hotkey: string) => {
    return ipcRenderer.invoke("volume-up:apply-hotkey", hotkey) as Promise<string>;
  },
  cancelVolumeUpHotkeyEdit: () => {
    return ipcRenderer.invoke("volume-up:cancel-hotkey-edit") as Promise<string>;
  },
  getVolumeUpHotkey: () => {
    return ipcRenderer.invoke("volume-up:get-hotkey") as Promise<string>;
  },
  beginVolumeDownHotkeyEdit: () => {
    return ipcRenderer.invoke("volume-down:begin-hotkey-edit") as Promise<string>;
  },
  applyVolumeDownHotkey: (hotkey: string) => {
    return ipcRenderer.invoke("volume-down:apply-hotkey", hotkey) as Promise<string>;
  },
  cancelVolumeDownHotkeyEdit: () => {
    return ipcRenderer.invoke("volume-down:cancel-hotkey-edit") as Promise<string>;
  },
  getVolumeDownHotkey: () => {
    return ipcRenderer.invoke("volume-down:get-hotkey") as Promise<string>;
  },
  beginReplayCaptureHotkeyEdit: () => {
    return ipcRenderer.invoke("capture-replay:begin-hotkey-edit") as Promise<string>;
  },
  applyReplayCaptureHotkey: (hotkey: string) => {
    return ipcRenderer.invoke("capture-replay:apply-hotkey", hotkey) as Promise<string>;
  },
  cancelReplayCaptureHotkeyEdit: () => {
    return ipcRenderer.invoke("capture-replay:cancel-hotkey-edit") as Promise<string>;
  },
  getReplayCaptureHotkey: () => {
    return ipcRenderer.invoke("capture-replay:get-hotkey") as Promise<string>;
  },
  setCaptureDrawRectangle: (enabled: boolean) => {
    return ipcRenderer.invoke("capture:set-draw-rectangle", enabled) as Promise<boolean>;
  },
  getCaptureDrawRectangle: () => {
    return ipcRenderer.invoke("capture:get-draw-rectangle") as Promise<boolean>;
  },
  launchRecommendedCpuStack: () => {
    return ipcRenderer.invoke("stack:launch-recommended-cpu") as Promise<"started" | "already_running">;
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

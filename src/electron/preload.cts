import { contextBridge, ipcRenderer } from "electron";
import type {
  ElectronHotkeyFeedbackEvent,
  ElectronHotkeyFeedbackPhase,
  ElectronHotkeyKey,
  ProviderModelsRequest,
  ProviderOcrRequest,
  ProviderOcrStreamEvent,
  ProviderTtsRequest,
  ProviderVoicesRequest
} from "./provider-ipc.js";

function recordStartupPhase(phase: string, details?: Record<string, unknown>): void {
  ipcRenderer.send("startup:phase", { phase, details });
}

recordStartupPhase("preload.evaluate.start", {
  readyState: document.readyState
});

window.addEventListener("DOMContentLoaded", () => {
  recordStartupPhase("preload.dom-content-loaded", {
    readyState: document.readyState
  });
}, { once: true });

recordStartupPhase("preload.evaluate.end", {
  readyState: document.readyState
});

contextBridge.exposeInMainWorld("electronAPI", {
  onCapturedImage: (handler: (payload: {
    dataUrl: string;
    captureKind: "selection" | "fullscreen" | "window";
    resultMode: "editor" | "clipboard";
    hotkey?: ElectronHotkeyKey;
  }) => void) => {
    ipcRenderer.on("capture-image", (_event, payload: {
      dataUrl?: string;
      captureKind?: "selection" | "fullscreen" | "window";
      resultMode?: "editor" | "clipboard";
      hotkey?: ElectronHotkeyKey;
    }) => {
      if (!payload?.dataUrl) return;
      const captureKind = payload.captureKind === "fullscreen" || payload.captureKind === "window"
        ? payload.captureKind
        : "selection";
      const resultMode = payload.resultMode === "clipboard" ? "clipboard" : "editor";
      handler(payload.hotkey
        ? { dataUrl: payload.dataUrl, captureKind, resultMode, hotkey: payload.hotkey }
        : { dataUrl: payload.dataUrl, captureKind, resultMode });
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
  onHotkeyFeedback: (handler: (payload: ElectronHotkeyFeedbackEvent) => void) => {
    ipcRenderer.on("hotkey-feedback", (_event, payload: {
      hotkey?: ElectronHotkeyKey;
      phase?: ElectronHotkeyFeedbackPhase;
      message?: string;
    }) => {
      if (!payload?.hotkey || !payload?.phase) return;
      handler(payload.message
        ? { hotkey: payload.hotkey, phase: payload.phase, message: payload.message }
        : { hotkey: payload.hotkey, phase: payload.phase });
    });
  },
  getAlwaysOnTop: () => {
    return ipcRenderer.invoke("window:get-always-on-top") as Promise<boolean>;
  },
  setAlwaysOnTop: (enabled: boolean) => {
    return ipcRenderer.invoke("window:set-always-on-top", enabled) as Promise<boolean>;
  },
  beginCaptureHotkeyEdit: () => {
    return ipcRenderer.invoke("capture:begin-hotkey-edit") as Promise<string>;
  },
  applyCaptureHotkey: (hotkey: string) => {
    return ipcRenderer.invoke("capture:apply-hotkey", hotkey) as Promise<string>;
  },
  clearCaptureHotkey: () => {
    return ipcRenderer.invoke("capture:clear-hotkey") as Promise<string>;
  },
  cancelCaptureHotkeyEdit: () => {
    return ipcRenderer.invoke("capture:cancel-hotkey-edit") as Promise<string>;
  },
  getCaptureHotkey: () => {
    return ipcRenderer.invoke("capture:get-hotkey") as Promise<string>;
  },
  beginOcrClipboardHotkeyEdit: () => {
    return ipcRenderer.invoke("capture-ocr-clipboard:begin-hotkey-edit") as Promise<string>;
  },
  applyOcrClipboardHotkey: (hotkey: string) => {
    return ipcRenderer.invoke("capture-ocr-clipboard:apply-hotkey", hotkey) as Promise<string>;
  },
  clearOcrClipboardHotkey: () => {
    return ipcRenderer.invoke("capture-ocr-clipboard:clear-hotkey") as Promise<string>;
  },
  cancelOcrClipboardHotkeyEdit: () => {
    return ipcRenderer.invoke("capture-ocr-clipboard:cancel-hotkey-edit") as Promise<string>;
  },
  getOcrClipboardHotkey: () => {
    return ipcRenderer.invoke("capture-ocr-clipboard:get-hotkey") as Promise<string>;
  },
  beginFullCaptureHotkeyEdit: () => {
    return ipcRenderer.invoke("capture-fullscreen:begin-hotkey-edit") as Promise<string>;
  },
  applyFullCaptureHotkey: (hotkey: string) => {
    return ipcRenderer.invoke("capture-fullscreen:apply-hotkey", hotkey) as Promise<string>;
  },
  clearFullCaptureHotkey: () => {
    return ipcRenderer.invoke("capture-fullscreen:clear-hotkey") as Promise<string>;
  },
  cancelFullCaptureHotkeyEdit: () => {
    return ipcRenderer.invoke("capture-fullscreen:cancel-hotkey-edit") as Promise<string>;
  },
  getFullCaptureHotkey: () => {
    return ipcRenderer.invoke("capture-fullscreen:get-hotkey") as Promise<string>;
  },
  beginActiveWindowCaptureHotkeyEdit: () => {
    return ipcRenderer.invoke("capture-window:begin-hotkey-edit") as Promise<string>;
  },
  applyActiveWindowCaptureHotkey: (hotkey: string) => {
    return ipcRenderer.invoke("capture-window:apply-hotkey", hotkey) as Promise<string>;
  },
  clearActiveWindowCaptureHotkey: () => {
    return ipcRenderer.invoke("capture-window:clear-hotkey") as Promise<string>;
  },
  cancelActiveWindowCaptureHotkeyEdit: () => {
    return ipcRenderer.invoke("capture-window:cancel-hotkey-edit") as Promise<string>;
  },
  getActiveWindowCaptureHotkey: () => {
    return ipcRenderer.invoke("capture-window:get-hotkey") as Promise<string>;
  },
  beginCopyHotkeyEdit: () => {
    return ipcRenderer.invoke("copy:begin-hotkey-edit") as Promise<string>;
  },
  applyCopyHotkey: (hotkey: string) => {
    return ipcRenderer.invoke("copy:apply-hotkey", hotkey) as Promise<string>;
  },
  clearCopyHotkey: () => {
    return ipcRenderer.invoke("copy:clear-hotkey") as Promise<string>;
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
  clearAbortHotkey: () => {
    return ipcRenderer.invoke("abort:clear-hotkey") as Promise<string>;
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
  clearPlayPauseHotkey: () => {
    return ipcRenderer.invoke("playback-toggle:clear-hotkey") as Promise<string>;
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
  clearNextChunkHotkey: () => {
    return ipcRenderer.invoke("playback-next:clear-hotkey") as Promise<string>;
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
  clearPreviousChunkHotkey: () => {
    return ipcRenderer.invoke("playback-previous:clear-hotkey") as Promise<string>;
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
  clearVolumeUpHotkey: () => {
    return ipcRenderer.invoke("volume-up:clear-hotkey") as Promise<string>;
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
  clearVolumeDownHotkey: () => {
    return ipcRenderer.invoke("volume-down:clear-hotkey") as Promise<string>;
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
  clearReplayCaptureHotkey: () => {
    return ipcRenderer.invoke("capture-replay:clear-hotkey") as Promise<string>;
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
  setOverlayTheme: (theme: "zen" | "pink") => {
    return ipcRenderer.invoke("overlay-theme:set", theme) as Promise<void>;
  },
  getOverlayTheme: () => {
    return ipcRenderer.invoke("overlay-theme:get") as Promise<"zen" | "pink">;
  },
  launchManagedService: (serviceId: "rapid" | "edge") => {
    return ipcRenderer.invoke("stack:launch-service", serviceId);
  },
  stopManagedService: (serviceId: "rapid" | "edge") => {
    return ipcRenderer.invoke("stack:stop-service", serviceId);
  },
  openRuntimeServicesFolder: () => {
    return ipcRenderer.invoke("stack:open-runtime-services") as Promise<string>;
  },
  getManagedServicesStatus: () => {
    return ipcRenderer.invoke("stack:get-services-status");
  },
  recordStartupPhase,
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
  },
  writeTextToClipboard: (text: string) => {
    return ipcRenderer.invoke("clipboard:write-text", text) as Promise<void>;
  },
  extractProviderText: (request: ProviderOcrRequest) => {
    return ipcRenderer.invoke("provider:extract-text", request);
  },
  startProviderOcrStream: (request: ProviderOcrRequest) => {
    return ipcRenderer.invoke("provider:start-ocr-stream", request);
  },
  synthesizeProviderText: (request: ProviderTtsRequest) => {
    return ipcRenderer.invoke("provider:synthesize-text", request);
  },
  fetchProviderModels: (request: ProviderModelsRequest) => {
    return ipcRenderer.invoke("provider:fetch-models", request);
  },
  fetchProviderVoices: (request: ProviderVoicesRequest) => {
    return ipcRenderer.invoke("provider:fetch-voices", request);
  },
  cancelProviderRequest: (requestId: string) => {
    return ipcRenderer.invoke("provider:cancel-request", requestId) as Promise<void>;
  },
  onProviderOcrStreamEvent: (handler: (event: ProviderOcrStreamEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
      if (!payload || typeof payload !== "object") return;
      handler(payload as ProviderOcrStreamEvent);
    };
    ipcRenderer.on("provider:ocr-stream-event", listener);
    return () => {
      ipcRenderer.removeListener("provider:ocr-stream-event", listener);
    };
  }
});

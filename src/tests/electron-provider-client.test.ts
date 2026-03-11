import { describe, expect, it, vi } from "vitest";
import type { ElectronApi, ProviderOcrStreamEvent } from "../core/services/platform";
import { ElectronBackedLlmService, ElectronBackedTtsService } from "../web/electron-provider-client";

function createApi(overrides: Partial<ElectronApi> = {}): ElectronApi {
  return {
    onCapturedImage: () => undefined,
    onCopiedTextForPlayback: () => undefined,
    onAbortRequested: () => undefined,
    onPlaybackHotkey: () => undefined,
    onHotkeyFeedback: () => undefined,
    getAlwaysOnTop: async () => false,
    setAlwaysOnTop: async () => false,
    beginCaptureHotkeyEdit: async () => "",
    applyCaptureHotkey: async () => "",
    clearCaptureHotkey: async () => "",
    cancelCaptureHotkeyEdit: async () => "",
    getCaptureHotkey: async () => "",
    beginOcrClipboardHotkeyEdit: async () => "",
    applyOcrClipboardHotkey: async () => "",
    clearOcrClipboardHotkey: async () => "",
    cancelOcrClipboardHotkeyEdit: async () => "",
    getOcrClipboardHotkey: async () => "",
    beginFullCaptureHotkeyEdit: async () => "",
    applyFullCaptureHotkey: async () => "",
    clearFullCaptureHotkey: async () => "",
    cancelFullCaptureHotkeyEdit: async () => "",
    getFullCaptureHotkey: async () => "",
    beginActiveWindowCaptureHotkeyEdit: async () => "",
    applyActiveWindowCaptureHotkey: async () => "",
    clearActiveWindowCaptureHotkey: async () => "",
    cancelActiveWindowCaptureHotkeyEdit: async () => "",
    getActiveWindowCaptureHotkey: async () => "",
    beginCopyHotkeyEdit: async () => "",
    applyCopyHotkey: async () => "",
    clearCopyHotkey: async () => "",
    cancelCopyHotkeyEdit: async () => "",
    getCopyHotkey: async () => "",
    beginAbortHotkeyEdit: async () => "",
    applyAbortHotkey: async () => "",
    clearAbortHotkey: async () => "",
    cancelAbortHotkeyEdit: async () => "",
    getAbortHotkey: async () => "",
    beginPlayPauseHotkeyEdit: async () => "",
    applyPlayPauseHotkey: async () => "",
    clearPlayPauseHotkey: async () => "",
    cancelPlayPauseHotkeyEdit: async () => "",
    getPlayPauseHotkey: async () => "",
    beginNextChunkHotkeyEdit: async () => "",
    applyNextChunkHotkey: async () => "",
    clearNextChunkHotkey: async () => "",
    cancelNextChunkHotkeyEdit: async () => "",
    getNextChunkHotkey: async () => "",
    beginPreviousChunkHotkeyEdit: async () => "",
    applyPreviousChunkHotkey: async () => "",
    clearPreviousChunkHotkey: async () => "",
    cancelPreviousChunkHotkeyEdit: async () => "",
    getPreviousChunkHotkey: async () => "",
    beginVolumeUpHotkeyEdit: async () => "",
    applyVolumeUpHotkey: async () => "",
    clearVolumeUpHotkey: async () => "",
    cancelVolumeUpHotkeyEdit: async () => "",
    getVolumeUpHotkey: async () => "",
    beginVolumeDownHotkeyEdit: async () => "",
    applyVolumeDownHotkey: async () => "",
    clearVolumeDownHotkey: async () => "",
    cancelVolumeDownHotkeyEdit: async () => "",
    getVolumeDownHotkey: async () => "",
    beginReplayCaptureHotkeyEdit: async () => "",
    applyReplayCaptureHotkey: async () => "",
    clearReplayCaptureHotkey: async () => "",
    cancelReplayCaptureHotkeyEdit: async () => "",
    getReplayCaptureHotkey: async () => "",
    setCaptureDrawRectangle: async () => false,
    getCaptureDrawRectangle: async () => false,
    setOverlayTheme: async () => undefined,
    getOverlayTheme: async () => "zen",
    launchManagedService: async () => ({ state: "stopped", managed: false, url: null, error: null, urls: null }),
    stopManagedService: async () => ({ state: "stopped", managed: false, url: null, error: null, urls: null }),
    openRuntimeServicesFolder: async () => "",
    getManagedServicesStatus: async () => ({
      rapid: { state: "stopped", managed: false, url: null, error: null, urls: null },
      edge: { state: "stopped", managed: false, url: null, error: null, urls: null }
    }),
    sendLogEntries: () => undefined,
    getLogLevel: async () => "info",
    setLogLevel: async () => undefined,
    getLogFilePath: async () => "",
    clearLogs: async () => undefined,
    writeTextToClipboard: async () => undefined,
    extractProviderText: async () => ({ text: "plain" }),
    startProviderOcrStream: async () => ({ text: "streamed" }),
    synthesizeProviderText: async () => ({ audioBytes: new Uint8Array([1, 2, 3]), mimeType: "audio/mpeg" }),
    fetchProviderModels: async () => [],
    fetchProviderVoices: async () => [],
    cancelProviderRequest: async () => undefined,
    onProviderOcrStreamEvent: () => () => undefined,
    ...overrides
  };
}

describe("electron provider client", () => {
  it("forwards OCR stream tokens to the renderer callback", async () => {
    let listener: ((event: ProviderOcrStreamEvent) => void) | null = null;
    const api = createApi({
      onProviderOcrStreamEvent: (handler) => {
        listener = handler;
        return () => {
          listener = null;
        };
      },
      startProviderOcrStream: vi.fn().mockImplementation(async (request) => {
        listener?.({ requestId: request.requestId, type: "token", token: "hello " });
        listener?.({ requestId: request.requestId, type: "token", token: "world" });
        return { text: "hello world" };
      })
    });

    const service = new ElectronBackedLlmService(api);
    const onToken = vi.fn();
    const result = await service.extractTextFromImageStream("data:image/png;base64,abc", {
      baseUrl: "https://example.com/v1",
      apiKey: "k",
      model: "m",
      promptTemplate: "Extract",
      imageDetail: "low",
      ocrStreamingEnabled: true,
      ocrStreamingFallbackToNonStream: true,
      maxTokens: 256
    }, { onToken });

    expect(result.text).toBe("hello world");
    expect(onToken).toHaveBeenNthCalledWith(1, "hello ");
    expect(onToken).toHaveBeenNthCalledWith(2, "world");
  });

  it("converts synthesized bytes into a blob", async () => {
    const api = createApi();
    const service = new ElectronBackedTtsService(api);
    const result = await service.synthesize("hi", {
      baseUrl: "https://example.com/v1",
      apiKey: "k",
      model: "tts-model",
      voice: "alloy",
      format: "mp3",
      speed: 1
    });

    expect(result.audioBlob.size).toBe(3);
    expect(result.audioBlob.type).toBe("audio/mpeg");
  });
});

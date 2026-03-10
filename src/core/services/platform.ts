import type { ConfigurableHotkeyKey, HotkeyFeedbackEvent } from "../models/types";

export interface PlatformBridge {
  onCapturedImage(handler: (payload: {
    dataUrl: string;
    captureKind: "selection" | "fullscreen" | "window";
    resultMode: "editor" | "clipboard";
    hotkey?: ConfigurableHotkeyKey;
  }) => void): void;
  onCopiedTextForPlayback(handler: (text: string) => void): void;
  onAbortRequested(handler: () => void): void;
  onPlaybackHotkey(handler: (action: "toggle_play_pause" | "next_chunk" | "previous_chunk" | "volume_up" | "volume_down") => void): void;
  onHotkeyFeedback(handler: (event: HotkeyFeedbackEvent) => void): void;
}

export interface ManagedRapidServiceUrls {
  detectionBaseUrl: string;
  ocrBaseUrl: string;
}

export type ManagedServiceId = "rapid" | "edge";

export interface ManagedServiceStatus {
  state: "stopped" | "starting" | "running" | "failed";
  managed: boolean;
  url: string | null;
  error: string | null;
  urls: ManagedRapidServiceUrls | null;
}

export interface ManagedServicesStatus {
  rapid: ManagedServiceStatus;
  edge: ManagedServiceStatus;
}

export type ProviderKind = "openai_compatible" | "gemini_sdk";

export interface ProviderLlmConfig {
  baseUrl?: string;
  apiKey: string;
  model: string;
  promptTemplate: string;
  imageDetail: "low" | "high";
  ocrStreamingEnabled: boolean;
  ocrStreamingFallbackToNonStream: boolean;
  maxTokens: number;
  thinkingMode?: "provider_default" | "low" | "off";
}

export interface ProviderTtsConfig {
  baseUrl?: string;
  apiKey: string;
  model: string;
  voice: string;
  format: "mp3" | "wav" | "opus";
  speed: number;
  thinkingMode?: "provider_default" | "low" | "off";
}

export interface ProviderOption {
  value: string;
  label: string;
}

export interface ProviderOcrRequest {
  requestId: string;
  provider: ProviderKind;
  imageDataUrl: string;
  config: ProviderLlmConfig;
}

export interface ProviderTtsRequest {
  requestId: string;
  provider: ProviderKind;
  text: string;
  config: ProviderTtsConfig;
  timeoutMs?: number;
}

export interface ProviderModelsRequest {
  provider: ProviderKind;
  kind: "ocr" | "tts";
  baseUrl?: string;
  apiKey: string;
}

export interface ProviderVoicesRequest extends ProviderModelsRequest {
  model?: string;
}

export interface ProviderTextResult {
  text: string;
}

export interface ProviderAudioResult {
  audioBytes: Uint8Array;
  mimeType: string;
}

export interface ProviderOcrStreamEvent {
  requestId: string;
  type: "token" | "done" | "error";
  token?: string;
  text?: string;
  error?: string;
}

export interface ElectronApi {
  onCapturedImage: (handler: (payload: {
    dataUrl: string;
    captureKind: "selection" | "fullscreen" | "window";
    resultMode: "editor" | "clipboard";
    hotkey?: ConfigurableHotkeyKey;
  }) => void) => void;
  onCopiedTextForPlayback: (handler: (text: string) => void) => void;
  onAbortRequested: (handler: () => void) => void;
  onPlaybackHotkey: (handler: (action: "toggle_play_pause" | "next_chunk" | "previous_chunk" | "volume_up" | "volume_down") => void) => void;
  onHotkeyFeedback: (handler: (event: HotkeyFeedbackEvent) => void) => void;
  getAlwaysOnTop: () => Promise<boolean>;
  setAlwaysOnTop: (enabled: boolean) => Promise<boolean>;
  beginCaptureHotkeyEdit: () => Promise<string>;
  applyCaptureHotkey: (hotkey: string) => Promise<string>;
  clearCaptureHotkey: () => Promise<string>;
  cancelCaptureHotkeyEdit: () => Promise<string>;
  getCaptureHotkey: () => Promise<string>;
  beginOcrClipboardHotkeyEdit: () => Promise<string>;
  applyOcrClipboardHotkey: (hotkey: string) => Promise<string>;
  clearOcrClipboardHotkey: () => Promise<string>;
  cancelOcrClipboardHotkeyEdit: () => Promise<string>;
  getOcrClipboardHotkey: () => Promise<string>;
  beginFullCaptureHotkeyEdit: () => Promise<string>;
  applyFullCaptureHotkey: (hotkey: string) => Promise<string>;
  clearFullCaptureHotkey: () => Promise<string>;
  cancelFullCaptureHotkeyEdit: () => Promise<string>;
  getFullCaptureHotkey: () => Promise<string>;
  beginActiveWindowCaptureHotkeyEdit: () => Promise<string>;
  applyActiveWindowCaptureHotkey: (hotkey: string) => Promise<string>;
  clearActiveWindowCaptureHotkey: () => Promise<string>;
  cancelActiveWindowCaptureHotkeyEdit: () => Promise<string>;
  getActiveWindowCaptureHotkey: () => Promise<string>;
  beginCopyHotkeyEdit: () => Promise<string>;
  applyCopyHotkey: (hotkey: string) => Promise<string>;
  clearCopyHotkey: () => Promise<string>;
  cancelCopyHotkeyEdit: () => Promise<string>;
  getCopyHotkey: () => Promise<string>;
  beginAbortHotkeyEdit: () => Promise<string>;
  applyAbortHotkey: (hotkey: string) => Promise<string>;
  clearAbortHotkey: () => Promise<string>;
  cancelAbortHotkeyEdit: () => Promise<string>;
  getAbortHotkey: () => Promise<string>;
  beginPlayPauseHotkeyEdit: () => Promise<string>;
  applyPlayPauseHotkey: (hotkey: string) => Promise<string>;
  clearPlayPauseHotkey: () => Promise<string>;
  cancelPlayPauseHotkeyEdit: () => Promise<string>;
  getPlayPauseHotkey: () => Promise<string>;
  beginNextChunkHotkeyEdit: () => Promise<string>;
  applyNextChunkHotkey: (hotkey: string) => Promise<string>;
  clearNextChunkHotkey: () => Promise<string>;
  cancelNextChunkHotkeyEdit: () => Promise<string>;
  getNextChunkHotkey: () => Promise<string>;
  beginPreviousChunkHotkeyEdit: () => Promise<string>;
  applyPreviousChunkHotkey: (hotkey: string) => Promise<string>;
  clearPreviousChunkHotkey: () => Promise<string>;
  cancelPreviousChunkHotkeyEdit: () => Promise<string>;
  getPreviousChunkHotkey: () => Promise<string>;
  beginVolumeUpHotkeyEdit: () => Promise<string>;
  applyVolumeUpHotkey: (hotkey: string) => Promise<string>;
  clearVolumeUpHotkey: () => Promise<string>;
  cancelVolumeUpHotkeyEdit: () => Promise<string>;
  getVolumeUpHotkey: () => Promise<string>;
  beginVolumeDownHotkeyEdit: () => Promise<string>;
  applyVolumeDownHotkey: (hotkey: string) => Promise<string>;
  clearVolumeDownHotkey: () => Promise<string>;
  cancelVolumeDownHotkeyEdit: () => Promise<string>;
  getVolumeDownHotkey: () => Promise<string>;
  beginReplayCaptureHotkeyEdit: () => Promise<string>;
  applyReplayCaptureHotkey: (hotkey: string) => Promise<string>;
  clearReplayCaptureHotkey: () => Promise<string>;
  cancelReplayCaptureHotkeyEdit: () => Promise<string>;
  getReplayCaptureHotkey: () => Promise<string>;
  setCaptureDrawRectangle: (enabled: boolean) => Promise<boolean>;
  getCaptureDrawRectangle: () => Promise<boolean>;
  launchManagedService: (serviceId: ManagedServiceId) => Promise<ManagedServiceStatus>;
  stopManagedService: (serviceId: ManagedServiceId) => Promise<ManagedServiceStatus>;
  openRuntimeServicesFolder: () => Promise<string>;
  getManagedServicesStatus: () => Promise<ManagedServicesStatus>;
  recordStartupPhase?: (phase: string, details?: Record<string, unknown>) => void;
  sendLogEntries: (entries: unknown[]) => void;
  getLogLevel: () => Promise<string>;
  setLogLevel: (level: string) => Promise<void>;
  getLogFilePath: () => Promise<string>;
  clearLogs: () => Promise<void>;
  writeTextToClipboard: (text: string) => Promise<void>;
  extractProviderText: (request: ProviderOcrRequest) => Promise<ProviderTextResult>;
  startProviderOcrStream: (request: ProviderOcrRequest) => Promise<ProviderTextResult>;
  synthesizeProviderText: (request: ProviderTtsRequest) => Promise<ProviderAudioResult>;
  fetchProviderModels: (request: ProviderModelsRequest) => Promise<ProviderOption[]>;
  fetchProviderVoices: (request: ProviderVoicesRequest) => Promise<ProviderOption[]>;
  cancelProviderRequest: (requestId: string) => Promise<void>;
  onProviderOcrStreamEvent: (handler: (event: ProviderOcrStreamEvent) => void) => () => void;
}

declare global {
  interface Window {
    electronAPI?: ElectronApi;
  }
}

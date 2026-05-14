import type { BaseUiTheme, ConfigurableHotkeyKey, HotkeyFeedbackEvent } from "../models/types";

export type UiTheme = BaseUiTheme | "dark-zen" | "dark-pink";

export interface PlatformBridge {
  onCapturedImage(handler: (payload: {
    dataUrl: string;
    captureKind: "selection" | "fullscreen" | "window";
    resultMode: "editor" | "clipboard";
    hotkey?: ConfigurableHotkeyKey;
    automation?: { kind: "auto_reader"; runId: number; phase: "initial" | "replay" };
  }) => void): void;
  onCopiedTextForPlayback(handler: (text: string) => void): void;
  onClipboardWatcherItem(handler: (payload: { kind: "text"; text: string } | { kind: "image"; dataUrl: string }) => void): void;
  onClipboardWatcherStateChanged(handler: (enabled: boolean) => void): void;
  onAbortRequested(handler: () => void): void;
  onPlaybackHotkey(handler: (action: "toggle_play_pause" | "next_chunk" | "previous_chunk" | "volume_up" | "volume_down") => void): void;
  onHotkeyFeedback(handler: (event: HotkeyFeedbackEvent) => void): void;
}

export interface ManagedOcrServiceUrls {
  detectionBaseUrl: string;
  ocrBaseUrl: string;
}

export type ManagedServiceId = "paddle" | "edge";

export interface ManagedServiceStatus {
  state: "stopped" | "starting" | "running" | "failed";
  managed: boolean;
  url: string | null;
  error: string | null;
  urls: ManagedOcrServiceUrls | null;
}

export interface ManagedServicesStatus {
  paddle: ManagedServiceStatus;
  edge: ManagedServiceStatus;
}

export type DiscoveredServiceSource = "bundled" | "external";
export type DiscoveredServiceFamily = "ocr" | "tts";
export type DiscoveredServiceCapability = "detect" | "ocr" | "speech";
export type DiscoveredServiceConfigTarget = "textProcessing.detectorBaseUrl" | "tts.baseUrl";
export type DiscoveredServiceDevice = "cpu" | "gpu";

export interface DiscoveredServiceLauncher {
  executable: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface DiscoveredServiceRuntime {
  detect?: DiscoveredServiceDevice;
  ocr?: DiscoveredServiceDevice;
  speech?: DiscoveredServiceDevice;
}

export interface DiscoveredServicePreset {
  id: string;
  name: string;
  defaultPort: number;
  args?: string[];
  env?: Record<string, string>;
  capabilities: DiscoveredServiceCapability[];
  configTargets: DiscoveredServiceConfigTarget[];
  runtime?: DiscoveredServiceRuntime;
}

export interface DiscoveredServiceSelector {
  id: string;
  name: string;
  capabilities: DiscoveredServiceCapability[];
  presetId?: string;
  runtime?: DiscoveredServiceRuntime;
}

export interface DiscoveredServiceCatalogItem {
  id: string;
  name: string;
  family: DiscoveredServiceFamily;
  description?: string;
  healthPath?: string;
  launcher: DiscoveredServiceLauncher;
  presets: DiscoveredServicePreset[];
  selectors?: DiscoveredServiceSelector[];
  manifestPath: string;
  servicePath: string;
  rootPath: string;
  relativePath: string;
  source: DiscoveredServiceSource;
}

export interface DiscoveredServiceError {
  manifestPath: string;
  message: string;
}

export interface DiscoveredServicesSnapshot {
  services: DiscoveredServiceCatalogItem[];
  errors: DiscoveredServiceError[];
}

export interface DiscoveredServiceRunUrls {
  detectionBaseUrl?: string;
  ocrBaseUrl?: string;
  ttsBaseUrl?: string;
}

export type DiscoveredServiceSlot = "detect" | "ocr" | "tts";

export interface DiscoveredServiceRunStatus {
  slot: DiscoveredServiceSlot;
  servicePath: string;
  serviceId: string;
  family: DiscoveredServiceFamily;
  presetId: string | null;
  pid: number | null;
  state: "stopped" | "starting" | "running" | "failed";
  managed: boolean;
  url: string | null;
  urls: DiscoveredServiceRunUrls | null;
  launchCwd: string | null;
  launchCommand: string | null;
  logLines: string[];
  error: string | null;
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
    automation?: { kind: "auto_reader"; runId: number; phase: "initial" | "replay" };
  }) => void) => void;
  onCopiedTextForPlayback: (handler: (text: string) => void) => void;
  onClipboardWatcherItem: (handler: (payload: { kind: "text"; text: string } | { kind: "image"; dataUrl: string }) => void) => void;
  onClipboardWatcherStateChanged: (handler: (enabled: boolean) => void) => void;
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
  beginAutoReaderHotkeyEdit: () => Promise<string>;
  applyAutoReaderHotkey: (hotkey: string) => Promise<string>;
  clearAutoReaderHotkey: () => Promise<string>;
  cancelAutoReaderHotkeyEdit: () => Promise<string>;
  getAutoReaderHotkey: () => Promise<string>;
  beginClipboardWatcherHotkeyEdit: () => Promise<string>;
  applyClipboardWatcherHotkey: (hotkey: string) => Promise<string>;
  clearClipboardWatcherHotkey: () => Promise<string>;
  cancelClipboardWatcherHotkeyEdit: () => Promise<string>;
  getClipboardWatcherHotkey: () => Promise<string>;
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
  setOverlayTheme: (theme: UiTheme) => Promise<void>;
  getOverlayTheme: () => Promise<UiTheme>;
  setAutoReaderSettings: (settings: {
    advanceHotkey: string;
    advanceDelayMs: number;
    noTextRetryCount: number;
  }) => Promise<{
    advanceHotkey: string;
    advanceDelayMs: number;
    noTextRetryCount: number;
  }>;
  getClipboardWatcherEnabled: () => Promise<boolean>;
  setClipboardWatcherEnabled: (enabled: boolean) => Promise<boolean>;
  reportAutoReaderPageResult: (result: {
    runId: number;
    outcome: "completed" | "failed" | "cancelled";
    text?: string;
    message?: string;
  }) => Promise<void>;
  launchManagedService: (serviceId: ManagedServiceId) => Promise<ManagedServiceStatus>;
  stopManagedService: (serviceId: ManagedServiceId) => Promise<ManagedServiceStatus>;
  openRuntimeServicesFolder: (configuredRoot?: string) => Promise<string>;
  getManagedServicesStatus: () => Promise<ManagedServicesStatus>;
  getDiscoveredServices?: (externalRoot?: string) => Promise<DiscoveredServicesSnapshot>;
  getDiscoveredServiceStatuses?: () => Promise<DiscoveredServiceRunStatus[]>;
  launchDiscoveredService?: (request: { slot: DiscoveredServiceSlot; servicePath: string; presetId: string; externalRoot?: string }) => Promise<DiscoveredServiceRunStatus>;
  stopDiscoveredService?: (slot: DiscoveredServiceSlot) => Promise<DiscoveredServiceRunStatus>;
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

import { app, BrowserWindow, clipboard, ipcMain, nativeImage, shell } from "electron";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  beginFrozenMonitorCaptureAtPoint,
  BorderOverlay,
  captureWindowRegion,
  captureCopyToText,
  cropFrozenCapture,
  disposeFrozenCapture,
  getForegroundWindowBounds,
  getForegroundWindowInfo,
  getWindowInfo,
  HotkeySession,
  parseSendSpec,
  sendHotkey,
  sendMouseClickAtPoint,
  sendHotkeyToWindow,
  type FrozenCaptureHandle,
  type WindowHandle
} from "nodehotkey";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  GeminiSdkLlmService,
  GeminiSdkTtsService,
  fetchGeminiModels,
  fetchGeminiVoices
} from "./gemini-sdk-service.js";
import {
  ElectronProviderLlmService,
  ElectronProviderTtsService,
  extractErrorMessage,
  fetchProviderModels,
  fetchProviderVoices
} from "./provider-service.js";
import type {
  ElectronHotkeyFeedbackPhase,
  ElectronHotkeyKey,
  ProviderModelsRequest,
  ProviderOcrRequest,
  ProviderOcrStreamEvent,
  ProviderTtsRequest,
  ProviderVoicesRequest
} from "./provider-ipc.js";
import { readBundledServicesManifest } from "./service-bundle-manifest.js";
import { scanServiceManifests } from "./service-manifest.js";
import { syncBundledServicesToRuntime as syncBundledServicesToRuntimeHelper } from "./runtime-services.js";

type LogLevel = "debug" | "info" | "warn" | "error";
type UiTheme = "zen" | "pink" | "dark-zen" | "dark-pink";

const OVERLAY_THEME_COLORS: Record<UiTheme, { outer: string; inner: string }> = {
  zen: {
    outer: "#ef6b57",
    inner: "#111111"
  },
  pink: {
    outer: "#db2777",
    inner: "#111111"
  },
  "dark-zen": {
    outer: "#f28b76",
    inner: "#f3ecdf"
  },
  "dark-pink": {
    outer: "#f472b6",
    inner: "#fff1f7"
  }
};

const MAX_AUTO_READER_NO_TEXT_RETRY_COUNT = 1_000_000;
const SERVICE_OWNER_HEARTBEAT_INTERVAL_MS = 2000;
const SERVICE_OWNER_GRACE_MS = 8000;

function isUiTheme(value: unknown): value is UiTheme {
  return value === "zen" || value === "pink" || value === "dark-zen" || value === "dark-pink";
}

interface BackendLogEntry {
  timestamp: string;
  level: LogLevel;
  category: string;
  message: string;
  context?: Record<string, unknown> | undefined;
  source: "frontend" | "backend";
}

interface ManagedOcrServiceUrls {
  detectionBaseUrl: string;
  ocrBaseUrl: string;
}

type ManagedServiceId = "paddle" | "edge";
type AutoReaderState = "idle" | "processing" | "advancing";
type AutoReaderCapturePhase = "initial" | "replay";
type AutoReaderTargetWindow = {
  handle: WindowHandle;
  region: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
};
type AutoReaderPageResult = {
  runId: number;
  outcome: "ready" | "failed" | "cancelled";
  text?: string;
  message?: string;
};
type CaptureAutomationPayload = {
  kind: "auto_reader";
  runId: number;
  phase: AutoReaderCapturePhase;
};

interface ManagedServiceStatus {
  state: "stopped" | "starting" | "running" | "failed";
  managed: boolean;
  url: string | null;
  error: string | null;
  urls: ManagedOcrServiceUrls | null;
}

interface ManagedServicesStatus {
  paddle: ManagedServiceStatus;
  edge: ManagedServiceStatus;
}

class ManagedServiceLaunchCancelledError extends Error {
  constructor(serviceId: ManagedServiceId) {
    super(`Managed service launch cancelled: ${serviceId}`);
    this.name = "ManagedServiceLaunchCancelledError";
  }
}

type PaddleStartupMode = "warm" | "cold";

interface PaddleProvisioningState {
  mode: PaddleStartupMode;
  reason: "ready" | "missing_venv" | "missing_python" | "missing_paddle_package" | "wrong_paddle_version" | "probe_failed";
  installedVersion: string | null;
}

interface ManagedStackChild {
  name: ManagedServiceId;
  child: ChildProcess;
}

interface DiscoveredServiceRunUrls {
  detectionBaseUrl?: string;
  ocrBaseUrl?: string;
  ttsBaseUrl?: string;
}

interface DiscoveredServiceRunStatus {
  slot: "detect" | "ocr" | "tts";
  servicePath: string;
  serviceId: string;
  family: "ocr" | "tts";
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

interface DiscoveredServiceChild {
  slot: "detect" | "ocr" | "tts";
  child: ChildProcess;
}

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};
const PADDLE_CPU_PACKAGE_NAME = "paddlepaddle";
const PADDLE_CPU_PACKAGE_VERSION = "3.2.0";
const PADDLE_WARM_START_TIMEOUT_MS = 120000;
const PADDLE_COLD_START_TIMEOUT_MS = 10 * 60 * 1000;
const CLIPBOARD_WATCH_POLL_MS = 500;
const DISCOVERED_SERVICE_LOG_LIMIT = 200;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow: BrowserWindow | null = null;
let isPinned = false;
let currentLogLevel: LogLevel = "info";
let captureHotkeySession: HotkeySession | null = null;
let ocrClipboardHotkeySession: HotkeySession | null = null;
let fullCaptureHotkeySession: HotkeySession | null = null;
let activeWindowCaptureHotkeySession: HotkeySession | null = null;
let copyHotkeySession: HotkeySession | null = null;
let autoReaderHotkeySession: HotkeySession | null = null;
let clipboardWatcherHotkeySession: HotkeySession | null = null;
let abortHotkeySession: HotkeySession | null = null;
let playbackToggleHotkeySession: HotkeySession | null = null;
let playbackNextHotkeySession: HotkeySession | null = null;
let playbackPreviousHotkeySession: HotkeySession | null = null;
let volumeUpHotkeySession: HotkeySession | null = null;
let volumeDownHotkeySession: HotkeySession | null = null;
let replayCaptureHotkeySession: HotkeySession | null = null;
let activeCaptureHotkey = "ctrl+shift+alt+s";
let activeOcrClipboardHotkey = "ctrl+shift+alt+c";
let activeFullCaptureHotkey = "ctrl+shift+alt+a";
let activeActiveWindowCaptureHotkey = "ctrl+shift+alt+w";
let activeCopyHotkey = "ctrl+shift+alt+x";
let activeAutoReaderHotkey = "ctrl+shift+alt+r";
let autoReaderAdvanceHotkey = "space";
let autoReaderAdvanceDelayMs = 900;
let autoReaderNoTextRetryCount = 5;
let activeClipboardWatcherHotkey = "ctrl+shift+alt+v";
let activeAbortHotkey = "ctrl+shift+alt+z";
let activePlaybackToggleHotkey = "ctrl+shift+alt+space";
let activePlaybackNextHotkey = "ctrl+shift+alt+right";
let activePlaybackPreviousHotkey = "ctrl+shift+alt+left";
let activeVolumeUpHotkey = "ctrl+shift+alt+up";
let activeVolumeDownHotkey = "ctrl+shift+alt+down";
let activeReplayCaptureHotkey = "ctrl+shift+alt+d";
let captureHotkeyBeforeEdit: string | null = null;
let ocrClipboardHotkeyBeforeEdit: string | null = null;
let fullCaptureHotkeyBeforeEdit: string | null = null;
let activeWindowCaptureHotkeyBeforeEdit: string | null = null;
let copyHotkeyBeforeEdit: string | null = null;
let autoReaderHotkeyBeforeEdit: string | null = null;
let clipboardWatcherHotkeyBeforeEdit: string | null = null;
let abortHotkeyBeforeEdit: string | null = null;
let playbackToggleHotkeyBeforeEdit: string | null = null;
let playbackNextHotkeyBeforeEdit: string | null = null;
let playbackPreviousHotkeyBeforeEdit: string | null = null;
let volumeUpHotkeyBeforeEdit: string | null = null;
let volumeDownHotkeyBeforeEdit: string | null = null;
let replayCaptureHotkeyBeforeEdit: string | null = null;
let drawSelectionRectangle = true;
let overlay: BorderOverlay | null = null;
let activeTheme: UiTheme = "zen";
let selectionTicker: NodeJS.Timeout | null = null;
let selectionActive = false;
let selectionStart: { x: number; y: number } | null = null;
let selectionResultMode: "editor" | "clipboard" = "editor";
let selectionSession: HotkeySession | null = null;
let selectionHotkey: ElectronHotkeyKey | undefined = undefined;
let selectionAutomation: CaptureAutomationPayload | null = null;
let lastCursor: { x: number; y: number } | null = null;
let lastRect: { left: number; top: number; right: number; bottom: number } | null = null;
let lastSavedCaptureRect: { left: number; top: number; width: number; height: number } | null = null;
let frozenCaptureSession: Promise<FrozenCaptureHandle> | null = null;
let flashOverlayTimer: NodeJS.Timeout | null = null;
let copyPlayInFlight = false;
let autoReaderState: AutoReaderState = "idle";
let autoReaderRunCounter = 0;
let autoReaderActiveRunId: number | null = null;
let autoReaderLastTextSignature: string | null = null;
let autoReaderNoTextStreak = 0;
let autoReaderTargetWindow: AutoReaderTargetWindow | null = null;
let lastSavedCaptureTargetWindow: AutoReaderTargetWindow | null = null;
let clipboardWatcherEnabled = false;
let clipboardWatcherPollTimer: NodeJS.Timeout | null = null;
let clipboardWatcherPollInFlight = false;
let clipboardWatcherLastSignature: string | null = null;
const clipboardWatcherSuppressedSignatures = new Set<string>();
let appCloseInFlight = false;
let shutdownWatchdog: NodeJS.Timeout | null = null;
let managedServiceChildren: Partial<Record<ManagedServiceId, ManagedStackChild>> = {};
let managedServiceLaunchPromises: Partial<Record<ManagedServiceId, Promise<ManagedServiceStatus>>> = {};
let managedServiceLaunchTokens: Partial<Record<ManagedServiceId, number>> = {};
let managedServiceLaunchTokenCounter = 0;
const discoveredServiceChildren = new Map<string, DiscoveredServiceChild>();
const discoveredServiceLaunchPromises = new Map<string, Promise<DiscoveredServiceRunStatus>>();
const discoveredServiceLaunchTokens = new Map<string, number>();
const discoveredServiceStatuses = new Map<string, DiscoveredServiceRunStatus>();
let discoveredServiceLaunchTokenCounter = 0;
const providerLlmService = new ElectronProviderLlmService();
const providerTtsService = new ElectronProviderTtsService();
const geminiSdkLlmService = new GeminiSdkLlmService();
const geminiSdkTtsService = new GeminiSdkTtsService();
const providerAbortControllers = new Map<string, AbortController>();
let managedServicesStatus: ManagedServicesStatus = {
  paddle: {
    state: "stopped",
    managed: false,
    url: null,
    urls: null,
    error: null
  },
  edge: {
    state: "stopped",
    managed: false,
    url: null,
    urls: null,
    error: null
  }
};
let serviceOwnerSessionId: string | null = null;
let serviceOwnerHeartbeatFilePath: string | null = null;
let serviceOwnerHeartbeatTimer: NodeJS.Timeout | null = null;
const processStartAt = Date.now();
const startupPhaseBuffer: string[] = [];
let startupWatchdogDomReady: NodeJS.Timeout | null = null;
let startupWatchdogRendererMount: NodeJS.Timeout | null = null;
let startupDomReadySeen = false;
let startupRendererMountSeen = false;
const hasSingleInstanceLock = app.requestSingleInstanceLock();

function processUptimeMs(): number {
  return Date.now() - processStartAt;
}

function focusMainWindow(targetWindow: BrowserWindow | null): void {
  if (!targetWindow || targetWindow.isDestroyed()) return;
  if (targetWindow.isMinimized()) targetWindow.restore();
  if (!targetWindow.isVisible()) targetWindow.show();
  targetWindow.focus();
}

function prefsPath(): string {
  return path.join(app.getPath("userData"), "window-prefs.json");
}

interface NativePrefs {
  alwaysOnTop?: boolean;
  captureHotkey?: string;
  ocrClipboardHotkey?: string;
  fullCaptureHotkey?: string;
  activeWindowCaptureHotkey?: string;
  copyPlayHotkey?: string;
  autoReaderHotkey?: string;
  autoReaderAdvanceHotkey?: string;
  autoReaderAdvanceDelayMs?: number;
  autoReaderNoTextRetryCount?: number;
  clipboardWatcherEnabled?: boolean;
  clipboardWatcherHotkey?: string;
  captureDrawRectangle?: boolean;
  abortHotkey?: string;
  playPauseHotkey?: string;
  nextChunkHotkey?: string;
  previousChunkHotkey?: string;
  volumeUpHotkey?: string;
  volumeDownHotkey?: string;
  replayCaptureHotkey?: string;
  theme?: UiTheme;
  lastCaptureRect?: { left?: number; top?: number; width?: number; height?: number };
}

function isDevMode(): boolean {
  return !app.isPackaged || Boolean(process.env.VITE_DEV_SERVER_URL);
}

function getLogDir(): string {
  if (isDevMode()) {
    return path.resolve(process.cwd(), "logs");
  }
  return path.join(app.getPath("userData"), "logs");
}

function getLogFilePath(): string {
  return path.join(getLogDir(), "tts-anywhere.log");
}

function diagnosticsPath(): string {
  return path.join(getLogDir(), "capture-diagnostics.log");
}

function startupDiagnosticsPath(): string {
  return path.join(getLogDir(), "startup-diagnostics.log");
}

function projectRootPath(): string {
  return path.resolve(__dirname, "..");
}

function legacyUserDataCandidates(): string[] {
  const currentUserData = app.getPath("userData");
  const appDataRoot = path.dirname(currentUserData);
  return ["tts-snipper", "TTS Snipper"]
    .map((name) => path.join(appDataRoot, name))
    .filter((candidate) => candidate !== currentUserData);
}

function migrateLegacyUserData(): void {
  if (isDevMode()) return;
  const currentUserData = app.getPath("userData");
  ensureDir(currentUserData);
  for (const legacyPath of legacyUserDataCandidates()) {
    if (!fs.existsSync(legacyPath)) continue;
    try {
      fs.cpSync(legacyPath, currentUserData, { recursive: true, force: false, errorOnExist: false });
      console.info(`[migration] merged legacy userData from ${legacyPath} to ${currentUserData}`);
    } catch (error) {
      console.warn(`[migration] failed to merge legacy userData from ${legacyPath}: ${String(error)}`);
    }
  }
}

function servicesBasePath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "services");
  }
  return path.join(projectRootPath(), "services");
}

function bundledBinPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "bin");
  }
  return path.join(projectRootPath(), "bin");
}

function bundledUvPath(): string | null {
  const executableName = process.platform === "win32" ? "uv.exe" : "uv";
  const candidate = path.join(bundledBinPath(), executableName);
  return fs.existsSync(candidate) ? candidate : null;
}

function recommendedCpuStackRuntimeRoot(): string {
  return path.join(app.getPath("userData"), "managed-services", "recommended-cpu");
}

function runtimeServicesRoot(): string {
  return path.join(app.getPath("userData"), "runtime", "services");
}

function bundledServicesManifestPath(): string {
  return path.join(servicesBasePath(), ".bundle-manifest.json");
}

function runtimeSyncManifestFile(): string {
  return path.join(app.getPath("userData"), "runtime", ".bundled-services-manifest.json");
}

function managedServiceStatusSnapshot(serviceId: ManagedServiceId): ManagedServiceStatus {
  const status = managedServicesStatus[serviceId];
  return {
    ...status,
    urls: status.urls ? { ...status.urls } : status.urls
  };
}

function managedServicesStatusSnapshot(): ManagedServicesStatus {
  return {
    paddle: managedServiceStatusSnapshot("paddle"),
    edge: managedServiceStatusSnapshot("edge")
  };
}

function setManagedServiceStatus(serviceId: ManagedServiceId, next: Partial<ManagedServiceStatus>): ManagedServiceStatus {
  managedServicesStatus = {
    ...managedServicesStatus,
    [serviceId]: {
      ...managedServicesStatus[serviceId],
      ...next
    }
  };
  return managedServiceStatusSnapshot(serviceId);
}

function beginManagedServiceLaunch(serviceId: ManagedServiceId): number {
  const token = ++managedServiceLaunchTokenCounter;
  managedServiceLaunchTokens[serviceId] = token;
  return token;
}

function cancelManagedServiceLaunch(serviceId: ManagedServiceId): void {
  managedServiceLaunchTokens[serviceId] = ++managedServiceLaunchTokenCounter;
}

function isManagedServiceLaunchCurrent(serviceId: ManagedServiceId, token: number): boolean {
  return managedServiceLaunchTokens[serviceId] === token;
}

function assertManagedServiceLaunchCurrent(serviceId: ManagedServiceId, token: number): void {
  if (!isManagedServiceLaunchCurrent(serviceId, token)) {
    throw new ManagedServiceLaunchCancelledError(serviceId);
  }
}

function preferredUvCommand(): string {
  return bundledUvPath() ?? "uv";
}

function windowsEnv(base: NodeJS.ProcessEnv, additions: Record<string, string>): NodeJS.ProcessEnv {
  const next = { ...base, ...additions };
  const uvPath = bundledUvPath();
  if (uvPath) {
    next.PATH = `${path.dirname(uvPath)};${next.PATH ?? ""}`;
  }
  next.UV_LINK_MODE ??= "copy";
  next.PYTHONUTF8 ??= "1";
  return next;
}

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function serviceOwnerHeartbeatDir(): string {
  return path.join(app.getPath("temp"), "tts-anywhere-service-owner");
}

function writeServiceOwnerHeartbeat(): void {
  if (!serviceOwnerSessionId || !serviceOwnerHeartbeatFilePath) {
    return;
  }
  ensureDir(path.dirname(serviceOwnerHeartbeatFilePath));
  fs.writeFileSync(serviceOwnerHeartbeatFilePath, JSON.stringify({
    sessionId: serviceOwnerSessionId,
    ownerPid: process.pid,
    updatedAt: Date.now()
  }), "utf-8");
}

function ensureServiceOwnerHeartbeatSession(): { sessionId: string; heartbeatFilePath: string } {
  if (!serviceOwnerSessionId || !serviceOwnerHeartbeatFilePath) {
    serviceOwnerSessionId = `${process.pid}-${Date.now().toString(36)}`;
    serviceOwnerHeartbeatFilePath = path.join(serviceOwnerHeartbeatDir(), `${serviceOwnerSessionId}.json`);
    writeServiceOwnerHeartbeat();
    serviceOwnerHeartbeatTimer = setInterval(() => {
      writeServiceOwnerHeartbeat();
    }, SERVICE_OWNER_HEARTBEAT_INTERVAL_MS);
    serviceOwnerHeartbeatTimer.unref();
  }
  return {
    sessionId: serviceOwnerSessionId,
    heartbeatFilePath: serviceOwnerHeartbeatFilePath
  };
}

function clearServiceOwnerHeartbeatSession(): void {
  if (serviceOwnerHeartbeatTimer) {
    clearInterval(serviceOwnerHeartbeatTimer);
    serviceOwnerHeartbeatTimer = null;
  }
  if (serviceOwnerHeartbeatFilePath && fs.existsSync(serviceOwnerHeartbeatFilePath)) {
    try {
      fs.unlinkSync(serviceOwnerHeartbeatFilePath);
    } catch {
      // Ignore cleanup failures during shutdown.
    }
  }
  serviceOwnerSessionId = null;
  serviceOwnerHeartbeatFilePath = null;
}

function withServiceOwnerEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const session = ensureServiceOwnerHeartbeatSession();
  return {
    ...env,
    TTS_ANYWHERE_OWNER_MODE: "heartbeat-file",
    TTS_ANYWHERE_OWNER_SESSION_ID: session.sessionId,
    TTS_ANYWHERE_OWNER_PID: String(process.pid),
    TTS_ANYWHERE_OWNER_HEARTBEAT_FILE: session.heartbeatFilePath,
    TTS_ANYWHERE_OWNER_HEARTBEAT_INTERVAL_MS: String(SERVICE_OWNER_HEARTBEAT_INTERVAL_MS),
    TTS_ANYWHERE_OWNER_GRACE_MS: String(SERVICE_OWNER_GRACE_MS)
  };
}

function readProjectPythonVersion(projectDir: string): string {
  const pythonVersionPath = path.join(projectDir, ".python-version");
  const raw = fs.readFileSync(pythonVersionPath, "utf-8").trim();
  if (!raw) {
    throw new Error(`Missing Python version in ${pythonVersionPath}`);
  }
  return raw;
}

function syncBundledServicesToRuntime(): string {
  const bundledManifest = readBundledServicesManifest(bundledServicesManifestPath());
  return syncBundledServicesToRuntimeHelper({
    isPackaged: app.isPackaged,
    sourceRoot: servicesBasePath(),
    targetRoot: runtimeServicesRoot(),
    bundledManifest,
    manifestFile: runtimeSyncManifestFile(),
    logSync: ({ action, reason, sourceRoot, targetRoot, bundledHash, runtimeHash }) => {
      writeBackendLog("info", "stack", `runtime.services.${action}`, {
        reason,
        sourceRoot,
        targetRoot,
        bundledHash,
        runtimeHash
      });
    }
  });
}

function selectedServicesRoot(configuredRoot?: string): { path: string; source: "bundled" | "external" } {
  if (typeof configuredRoot === "string" && configuredRoot.trim().length > 0) {
    return {
      path: configuredRoot.trim(),
      source: "external"
    };
  }
  return {
    path: syncBundledServicesToRuntime(),
    source: "bundled"
  };
}

function discoverManagedServices(externalRoot?: string): ReturnType<typeof scanServiceManifests> {
  const root = selectedServicesRoot(externalRoot);
  return scanServiceManifests([root]);
}

function discoverManagedServicesSnapshot(externalRoot?: string): {
  services: Array<{
    id: string;
    name: string;
    family: "ocr" | "tts";
    description?: string;
    healthPath?: string;
    launcher: {
      executable: string;
      args?: string[];
      cwd?: string;
      env?: Record<string, string>;
    };
    presets: Array<{
      id: string;
      name: string;
      defaultPort: number;
      args?: string[];
      env?: Record<string, string>;
      capabilities: Array<"detect" | "ocr" | "speech">;
      configTargets: Array<"textProcessing.detectorBaseUrl" | "tts.baseUrl">;
      runtime?: { detect?: "cpu" | "gpu"; ocr?: "cpu" | "gpu"; speech?: "cpu" | "gpu" };
    }>;
    manifestPath: string;
    servicePath: string;
    rootPath: string;
    relativePath: string;
    source: "bundled" | "external";
  }>;
  errors: Array<{ manifestPath: string; message: string }>;
} {
  const result = discoverManagedServices(externalRoot);
  return {
    services: result.services.map((service) => ({
      id: service.manifest.id,
      name: service.manifest.name,
      family: service.manifest.family,
      ...(service.manifest.description ? { description: service.manifest.description } : {}),
      ...(service.manifest.healthPath ? { healthPath: service.manifest.healthPath } : {}),
      launcher: {
        executable: service.manifest.launcher.executable,
        ...(service.manifest.launcher.args ? { args: [...service.manifest.launcher.args] } : {}),
        ...(service.manifest.launcher.cwd ? { cwd: service.manifest.launcher.cwd } : {}),
        ...(service.manifest.launcher.env ? { env: { ...service.manifest.launcher.env } } : {})
      },
      presets: service.manifest.presets.map((preset) => ({
        id: preset.id,
        name: preset.name,
        defaultPort: preset.defaultPort,
        ...(preset.args ? { args: [...preset.args] } : {}),
        ...(preset.env ? { env: { ...preset.env } } : {}),
        capabilities: [...preset.capabilities],
        configTargets: [...preset.configTargets],
        ...(preset.runtime ? { runtime: { ...preset.runtime } } : {})
      })),
      ...(service.manifest.selectors
        ? {
            selectors: service.manifest.selectors.map((selector) => ({
              id: selector.id,
              name: selector.name,
              ...(selector.presetId ? { presetId: selector.presetId } : {}),
              capabilities: [...selector.capabilities],
              ...(selector.runtime ? { runtime: { ...selector.runtime } } : {})
            }))
          }
        : {}),
      manifestPath: service.manifestPath,
      servicePath: service.servicePath,
      rootPath: service.rootPath,
      relativePath: service.relativePath,
      source: service.source
    })),
    errors: result.errors.map((error) => ({ manifestPath: error.manifestPath, message: error.message }))
  };
}

function normalizeDiscoveredServicePath(servicePath: string): string {
  return path.resolve(servicePath);
}

function familyForSlot(slot: "detect" | "ocr" | "tts"): "ocr" | "tts" {
  return slot === "tts" ? "tts" : "ocr";
}

function findDiscoveredService(servicePath: string, externalRoot?: string) {
  const normalizedPath = normalizeDiscoveredServicePath(servicePath);
  return discoverManagedServices(externalRoot).services.find(
    (service) => normalizeDiscoveredServicePath(service.servicePath) === normalizedPath
  ) ?? null;
}

function buildDiscoveredServiceStatus(
  slot: "detect" | "ocr" | "tts",
  service: ReturnType<typeof discoverManagedServices>["services"][number],
  next?: Partial<DiscoveredServiceRunStatus>
): DiscoveredServiceRunStatus {
  const normalizedPath = normalizeDiscoveredServicePath(service.servicePath);
  const current = discoveredServiceStatuses.get(slot);
  return {
    slot,
    servicePath: normalizedPath,
    serviceId: service.manifest.id,
    family: service.manifest.family,
    presetId: null,
    pid: null,
    state: "stopped",
    managed: false,
    url: null,
    urls: null,
    launchCwd: null,
    launchCommand: null,
    logLines: [],
    error: null,
    ...(current ?? {}),
    ...(next ?? {})
  };
}

function setDiscoveredServiceStatus(
  slot: "detect" | "ocr" | "tts",
  service: ReturnType<typeof discoverManagedServices>["services"][number],
  next?: Partial<DiscoveredServiceRunStatus>
): DiscoveredServiceRunStatus {
  const status = buildDiscoveredServiceStatus(slot, service, next);
  discoveredServiceStatuses.set(slot, status);
  return status;
}

function discoveredServiceStatusSnapshot(slot: "detect" | "ocr" | "tts"): DiscoveredServiceRunStatus | null {
  const current = discoveredServiceStatuses.get(slot);
  return current ? { ...current, urls: current.urls ? { ...current.urls } : null, logLines: [...current.logLines] } : null;
}

function discoveredServiceStatusesSnapshot(): DiscoveredServiceRunStatus[] {
  return Array.from(discoveredServiceStatuses.values())
    .map((status) => ({ ...status, urls: status.urls ? { ...status.urls } : null, logLines: [...status.logLines] }))
    .sort((left, right) => left.slot.localeCompare(right.slot));
}

function appendDiscoveredServiceLog(slot: "detect" | "ocr" | "tts", line: string): void {
  const current = discoveredServiceStatuses.get(slot);
  if (!current) {
    return;
  }
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }
  discoveredServiceStatuses.set(slot, {
    ...current,
    logLines: [...current.logLines, trimmed].slice(-DISCOVERED_SERVICE_LOG_LIMIT)
  });
}

function appendDiscoveredServiceChunk(slot: "detect" | "ocr" | "tts", stream: "stdout" | "stderr", chunk: unknown): void {
  for (const line of String(chunk).split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    appendDiscoveredServiceLog(slot, `[${stream}] ${trimmed}`);
  }
}

function beginDiscoveredServiceLaunch(slot: "detect" | "ocr" | "tts"): number {
  const token = ++discoveredServiceLaunchTokenCounter;
  discoveredServiceLaunchTokens.set(slot, token);
  return token;
}

function cancelDiscoveredServiceLaunch(slot: "detect" | "ocr" | "tts"): void {
  discoveredServiceLaunchTokens.set(slot, ++discoveredServiceLaunchTokenCounter);
}

function isDiscoveredServiceLaunchCurrent(slot: "detect" | "ocr" | "tts", token: number): boolean {
  return discoveredServiceLaunchTokens.get(slot) === token;
}

function assertDiscoveredServiceLaunchCurrent(slot: "detect" | "ocr" | "tts", token: number): void {
  if (!isDiscoveredServiceLaunchCurrent(slot, token)) {
    throw new Error(`Discovered service launch cancelled: ${slot}`);
  }
}

function attachDiscoveredServiceChildLogging(
  slot: "detect" | "ocr" | "tts",
  service: ReturnType<typeof discoverManagedServices>["services"][number],
  child: ChildProcess
): void {
  const logName = `${service.manifest.id}@${service.relativePath}`;
  child.stdout?.on("data", (chunk) => {
    appendDiscoveredServiceChunk(slot, "stdout", chunk);
    writeBackendLog("info", "stack", `${logName}.stdout`, { line: String(chunk).trim() });
  });
  child.stderr?.on("data", (chunk) => {
    appendDiscoveredServiceChunk(slot, "stderr", chunk);
    writeBackendLog("warn", "stack", `${logName}.stderr`, { line: String(chunk).trim() });
  });
  child.on("exit", (code, signal) => {
    appendDiscoveredServiceLog(slot, `[exit] code=${code ?? "null"} signal=${signal ?? "null"}`);
    writeBackendLog("info", "stack", `${logName}.exit`, { code, signal });
    if (discoveredServiceChildren.get(slot)?.child === child) {
      discoveredServiceChildren.delete(slot);
    }
    const current = discoveredServiceStatuses.get(slot);
    if (current?.state === "running") {
      discoveredServiceStatuses.set(slot, { ...current, state: "stopped", managed: false, url: null, urls: null, error: null });
    }
  });
  child.on("error", (error) => {
    appendDiscoveredServiceLog(slot, `[error] ${error.stack ?? String(error)}`);
    writeBackendLog("error", "stack", `${logName}.error`, { error: error.stack ?? String(error) });
  });
}

function spawnDiscoveredServiceChild(
  slot: "detect" | "ocr" | "tts",
  service: ReturnType<typeof discoverManagedServices>["services"][number],
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv
): ChildProcess {
  const child = spawn(command, args, {
    cwd,
    env: withServiceOwnerEnv(env),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  attachDiscoveredServiceChildLogging(slot, service, child);
  discoveredServiceChildren.set(slot, {
    slot,
    child
  });
  return child;
}

async function terminateDiscoveredServiceChild(slot: "detect" | "ocr" | "tts"): Promise<void> {
  const child = discoveredServiceChildren.get(slot)?.child ?? null;
  if (!child) return;
  discoveredServiceChildren.delete(slot);
  await terminateChildTree(child);
}

function resolveDiscoveredServiceExecutable(executable: string, servicePath: string): string {
  if (executable === "uv") {
    return preferredUvCommand();
  }
  if (path.isAbsolute(executable) || executable.startsWith(".") || executable.includes("/") || executable.includes("\\")) {
    return path.resolve(servicePath, executable);
  }
  return executable;
}

function formatDiscoveredServiceCommand(command: string, args: string[]): string {
  const quote = (value: string): string => {
    if (value.length === 0 || /[\s"]/u.test(value)) {
      return `"${value.replace(/"/g, '\\"')}"`;
    }
    return value;
  };
  return [command, ...args].map(quote).join(" ");
}

function buildDiscoveredServiceUrls(
  preset: ReturnType<typeof discoverManagedServices>["services"][number]["manifest"]["presets"][number],
  baseUrl: string
): { url: string; urls: DiscoveredServiceRunUrls | null } {
  const urls: DiscoveredServiceRunUrls = {};
  if (preset.capabilities.includes("detect")) {
    urls.detectionBaseUrl = baseUrl;
  }
  if (preset.capabilities.includes("ocr")) {
    urls.ocrBaseUrl = `${baseUrl}/v1`;
  }
  if (preset.capabilities.includes("speech")) {
    urls.ttsBaseUrl = `${baseUrl}/v1`;
  }
  const url = urls.ttsBaseUrl ?? urls.ocrBaseUrl ?? urls.detectionBaseUrl ?? baseUrl;
  return {
    url,
    urls: Object.keys(urls).length > 0 ? urls : null
  };
}

async function stopDiscoveredService(slot: "detect" | "ocr" | "tts", externalRoot?: string): Promise<DiscoveredServiceRunStatus> {
  discoveredServiceLaunchPromises.delete(slot);
  cancelDiscoveredServiceLaunch(slot);
  await terminateDiscoveredServiceChild(slot);
  const current = discoveredServiceStatusSnapshot(slot);
  const service = current ? findDiscoveredService(current.servicePath, externalRoot) : null;
  if (service) {
    return setDiscoveredServiceStatus(slot, service, {
      state: "stopped",
      managed: false,
      url: null,
      urls: null,
      error: null
    });
  }
  const fallback: DiscoveredServiceRunStatus = current ?? {
    slot,
    servicePath: "",
    serviceId: slot,
    family: familyForSlot(slot),
    presetId: null,
    pid: null,
    state: "stopped",
    managed: false,
    url: null,
    urls: null,
    launchCwd: null,
    launchCommand: null,
    logLines: [],
    error: null
  };
  discoveredServiceStatuses.set(slot, { ...fallback, state: "stopped", managed: false, url: null, urls: null, error: null });
  return discoveredServiceStatusSnapshot(slot) as DiscoveredServiceRunStatus;
}

async function launchDiscoveredServiceInternal(
  slot: "detect" | "ocr" | "tts",
  service: ReturnType<typeof discoverManagedServices>["services"][number],
  preset: ReturnType<typeof discoverManagedServices>["services"][number]["manifest"]["presets"][number],
  launchToken: number
): Promise<DiscoveredServiceRunStatus> {
  const normalizedPath = normalizeDiscoveredServicePath(service.servicePath);
  const uvCacheDir = path.join(recommendedCpuStackRuntimeRoot(), "uv-cache");
  ensureDir(uvCacheDir);
  const port = await resolveAvailablePort(preset.defaultPort);
  const baseUrl = `http://127.0.0.1:${port}`;
  const cwd = service.manifest.launcher.cwd ? path.resolve(service.servicePath, service.manifest.launcher.cwd) : service.servicePath;
  const command = resolveDiscoveredServiceExecutable(service.manifest.launcher.executable, service.servicePath);
  const args = [
    ...(service.manifest.launcher.args ?? []),
    ...(preset.args ?? []),
    "--host",
    "127.0.0.1",
    "--port",
    String(port)
  ];
  const launchCommand = formatDiscoveredServiceCommand(command, args);
  const env = windowsEnv(process.env, {
    UV_CACHE_DIR: uvCacheDir,
    ...(service.manifest.launcher.env ?? {}),
    ...(preset.env ?? {})
  });
  const child = spawnDiscoveredServiceChild(slot, service, command, args, cwd, env);
  setDiscoveredServiceStatus(slot, service, {
    presetId: preset.id,
    pid: child.pid ?? null,
    state: "starting",
    managed: false,
    url: null,
    urls: null,
    launchCwd: cwd,
    launchCommand,
    logLines: [`[launch] ${launchCommand}`],
    error: null
  });
  writeBackendLog("info", "stack", "discovered-service.started", {
    slot,
    serviceId: service.manifest.id,
    servicePath: normalizedPath,
    presetId: preset.id,
    pid: child.pid,
    port
  });
  await waitForServiceHealth(
    baseUrl,
    service.manifest.family === "ocr" ? PADDLE_COLD_START_TIMEOUT_MS : 120000,
    (payload) => payload.ok === true,
    service.manifest.healthPath ?? "/healthz"
  );
  assertDiscoveredServiceLaunchCurrent(slot, launchToken);
  const urls = buildDiscoveredServiceUrls(preset, baseUrl);
  return setDiscoveredServiceStatus(slot, service, {
    presetId: preset.id,
    pid: child.pid ?? null,
    state: "running",
    managed: true,
    url: urls.url,
    urls: urls.urls,
    error: null
  });
}

async function launchDiscoveredService(slot: "detect" | "ocr" | "tts", servicePath: string, presetId: string, externalRoot?: string): Promise<DiscoveredServiceRunStatus> {
  const service = findDiscoveredService(servicePath, externalRoot);
  if (!service) {
    throw new Error(`Discovered service not found: ${servicePath}`);
  }
  const preset = service.manifest.presets.find((candidate) => candidate.id === presetId);
  if (!preset) {
    throw new Error(`Preset not found for ${service.manifest.id}: ${presetId}`);
  }
  const current = discoveredServiceStatusSnapshot(slot);
  if (current?.state === "running" && current.presetId === presetId) {
    return current;
  }
  const inFlight = discoveredServiceLaunchPromises.get(slot);
  if (inFlight) {
    return inFlight;
  }
  if (current?.state === "running" || current?.state === "starting") {
    await stopDiscoveredService(slot, externalRoot);
  }
  setDiscoveredServiceStatus(slot, service, {
    presetId,
    pid: null,
    state: "starting",
    managed: false,
    url: null,
    urls: null,
    launchCwd: null,
    launchCommand: null,
    logLines: [],
    error: null
  });
  const launchToken = beginDiscoveredServiceLaunch(slot);
  const launchPromise = (async () => {
    try {
      return await launchDiscoveredServiceInternal(slot, service, preset, launchToken);
    } catch (error) {
      if (!isDiscoveredServiceLaunchCurrent(slot, launchToken)) {
        return discoveredServiceStatusSnapshot(slot) ?? buildDiscoveredServiceStatus(slot, service);
      }
      discoveredServiceLaunchPromises.delete(slot);
      await terminateDiscoveredServiceChild(slot);
      return setDiscoveredServiceStatus(slot, service, {
        presetId,
        pid: null,
        state: "failed",
        managed: false,
        url: null,
        urls: null,
        error: String(error)
      });
    } finally {
      if (isDiscoveredServiceLaunchCurrent(slot, launchToken)) {
        discoveredServiceLaunchPromises.delete(slot);
      }
    }
  })();
  discoveredServiceLaunchPromises.set(slot, launchPromise);
  return launchPromise;
}

function envPythonPath(envDir: string): string {
  if (process.platform === "win32") {
    return path.join(envDir, "Scripts", "python.exe");
  }
  return path.join(envDir, "bin", "python");
}

function detectPaddleProvisioningState(paddleEnvDir: string): PaddleProvisioningState {
  if (!fs.existsSync(paddleEnvDir)) {
    return { mode: "cold", reason: "missing_venv", installedVersion: null };
  }

  const pythonPath = envPythonPath(paddleEnvDir);
  if (!fs.existsSync(pythonPath)) {
    return { mode: "cold", reason: "missing_python", installedVersion: null };
  }

  const probe = spawnSync(
    pythonPath,
    [
      "-c",
      [
        "import importlib.metadata as m, json",
        `name=${JSON.stringify(PADDLE_CPU_PACKAGE_NAME)}`,
        "try:",
        "    version = m.version(name)",
        "except m.PackageNotFoundError:",
        "    version = None",
        "print(json.dumps({'version': version}))"
      ].join("\n")
    ],
    {
      windowsHide: true,
      encoding: "utf-8"
    }
  );

  if (probe.status !== 0) {
    return { mode: "cold", reason: "probe_failed", installedVersion: null };
  }

  try {
    const payload = JSON.parse(probe.stdout || "{}") as { version?: unknown };
    const installedVersion = typeof payload.version === "string" ? payload.version : null;
    if (!installedVersion) {
      return { mode: "cold", reason: "missing_paddle_package", installedVersion: null };
    }
    if (installedVersion !== PADDLE_CPU_PACKAGE_VERSION) {
      return { mode: "cold", reason: "wrong_paddle_version", installedVersion };
    }
    return { mode: "warm", reason: "ready", installedVersion };
  } catch {
    return { mode: "cold", reason: "probe_failed", installedVersion: null };
  }
}

function attachManagedChildLogging(name: ManagedStackChild["name"], child: ChildProcess): void {
  child.stdout?.on("data", (chunk) => {
    writeBackendLog("info", "stack", `${name}.stdout`, { line: String(chunk).trim() });
  });
  child.stderr?.on("data", (chunk) => {
    writeBackendLog("warn", "stack", `${name}.stderr`, { line: String(chunk).trim() });
  });
  child.on("exit", (code, signal) => {
    writeBackendLog("info", "stack", `${name}.exit`, { code, signal });
    if (managedServiceChildren[name]?.child === child) {
      delete managedServiceChildren[name];
    }
    if (managedServicesStatus[name].state === "running") {
      setManagedServiceStatus(name, {
        state: "stopped",
        managed: false,
        url: null,
        urls: null,
        error: null
      });
    }
  });
  child.on("error", (error) => {
    writeBackendLog("error", "stack", `${name}.error`, { error: error.stack ?? String(error) });
  });
}

function spawnManagedChild(
  name: ManagedStackChild["name"],
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv
): ChildProcess {
  const child = spawn(command, args, {
    cwd,
    env: withServiceOwnerEnv(env),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  attachManagedChildLogging(name, child);
  managedServiceChildren[name] = { name, child };
  return child;
}

function runManagedCommand(label: string, command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    writeBackendLog("info", "stack", `${label}.run`, { command, args, cwd });
    const child = spawn(command, args, {
      cwd,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout?.on("data", (chunk) => {
      writeBackendLog("info", "stack", `${label}.stdout`, { line: String(chunk).trim() });
    });
    child.stderr?.on("data", (chunk) => {
      writeBackendLog("warn", "stack", `${label}.stderr`, { line: String(chunk).trim() });
    });
    child.on("error", (error) => reject(error));
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${label} exited with code ${code ?? "unknown"}`));
    });
  });
}

function terminateChildTreeSync(child: ChildProcess): void {
  if (!child.pid || child.exitCode !== null || child.killed) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true });
    return;
  }
  child.kill("SIGTERM");
}

function terminateChildTree(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.killed) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    child.once("exit", finish);
    child.once("error", finish);
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
      killer.once("exit", finish);
      killer.once("error", finish);
      return;
    }
    child.kill("SIGTERM");
    setTimeout(finish, 2000);
  });
}

async function openRuntimeServicesFolder(configuredRoot?: string): Promise<string> {
  const target = selectedServicesRoot(configuredRoot).path;
  ensureDir(target);
  return shell.openPath(target);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveAvailablePort(preferredPort: number): Promise<number> {
  const tryListen = (port: number): Promise<number> => new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", (error) => {
      server.close();
      reject(error);
    });
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const resolvedPort = typeof address === "object" && address ? address.port : port;
      server.close(() => resolve(resolvedPort));
    });
  });

  try {
    return await tryListen(preferredPort);
  } catch {
    return tryListen(0);
  }
}

async function waitForServiceHealth(
  baseUrl: string,
  timeoutMs: number,
  validate: (payload: Record<string, unknown>) => boolean,
  healthPath = "/healthz"
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no response";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}${healthPath}`);
      if (!response.ok) {
        lastError = `HTTP ${response.status}`;
      } else {
        const payload = (await response.json()) as Record<string, unknown>;
        if (validate(payload)) {
          return payload;
        }
        lastError = JSON.stringify(payload);
      }
    } catch (error) {
      lastError = String(error);
    }
    await delay(1000);
  }
  throw new Error(`Service at ${baseUrl} did not become healthy in ${Math.round(timeoutMs / 1000)}s: ${lastError}`);
}

function getManagedServicePaths(): {
  stackRoot: string;
  uvCacheDir: string;
  runtimeServicesDir: string;
  paddleServiceDir: string;
  edgeServiceDir: string;
  paddleEnvDir: string;
  edgeEnvDir: string;
} {
  if (process.platform !== "win32") {
    throw new Error("Recommended CPU stack launcher is currently Windows-only.");
  }
  const stackRoot = recommendedCpuStackRuntimeRoot();
  const uvCacheDir = path.join(stackRoot, "uv-cache");
  const runtimeServicesDir = syncBundledServicesToRuntime();
  const paddleServiceDir = path.join(runtimeServicesDir, "text_processing", "paddle");
  const edgeServiceDir = path.join(runtimeServicesDir, "tts", "edge");
  const paddleEnvDir = path.join(paddleServiceDir, ".venv-cpu");
  const edgeEnvDir = path.join(edgeServiceDir, ".venv");
  if (!fs.existsSync(paddleServiceDir)) {
    throw new Error(`Paddle service directory not found: ${paddleServiceDir}`);
  }
  if (!fs.existsSync(edgeServiceDir)) {
    throw new Error(`Edge service directory not found: ${edgeServiceDir}`);
  }
  ensureDir(uvCacheDir);
  return {
    stackRoot,
    uvCacheDir,
    runtimeServicesDir,
    paddleServiceDir,
    edgeServiceDir,
    paddleEnvDir,
    edgeEnvDir
  };
}

async function launchPaddleServiceInternal(launchToken: number): Promise<ManagedServiceStatus> {
  const { uvCacheDir, paddleServiceDir, paddleEnvDir } = getManagedServicePaths();
  const paddlePort = await resolveAvailablePort(8091);
  const urls: ManagedOcrServiceUrls = {
    detectionBaseUrl: `http://127.0.0.1:${paddlePort}`,
    ocrBaseUrl: `http://127.0.0.1:${paddlePort}/v1`
  };
  const baseEnv = windowsEnv(process.env, { UV_CACHE_DIR: uvCacheDir });
  const paddleEnv = windowsEnv(baseEnv, { UV_PROJECT_ENVIRONMENT: paddleEnvDir });
  const provisioning = detectPaddleProvisioningState(paddleEnvDir);
  const healthTimeoutMs = provisioning.mode === "cold" ? PADDLE_COLD_START_TIMEOUT_MS : PADDLE_WARM_START_TIMEOUT_MS;
  writeBackendLog("info", "stack", "recommendedCpu.paddle.preflight", {
    mode: provisioning.mode,
    reason: provisioning.reason,
    installedVersion: provisioning.installedVersion,
    expectedVersion: PADDLE_CPU_PACKAGE_VERSION,
    timeoutMs: healthTimeoutMs,
    envDir: paddleEnvDir
  });
  const paddlePythonPath = envPythonPath(paddleEnvDir);
  if (!fs.existsSync(paddlePythonPath)) {
    await runManagedCommand(
      "recommendedCpu.paddle.venv",
      preferredUvCommand(),
      ["venv", paddleEnvDir, "--python", readProjectPythonVersion(paddleServiceDir)],
      paddleServiceDir,
      paddleEnv
    );
    assertManagedServiceLaunchCurrent("paddle", launchToken);
  }

  const paddleChild = spawnManagedChild(
    "paddle",
    paddlePythonPath,
    [
      "launcher.py",
      "--host",
      "127.0.0.1",
      "--port",
      String(paddlePort),
      "--enable-detect",
      "--enable-openai-ocr",
      "--detect-device",
      "cpu",
      "--ocr-device",
      "cpu"
    ],
    paddleServiceDir,
    paddleEnv
  );
  writeBackendLog("info", "stack", "recommendedCpu.paddle.started", { pid: paddleChild.pid, port: paddlePort });
  await waitForServiceHealth(
    urls.detectionBaseUrl,
    healthTimeoutMs,
    (payload) => payload.ok === true
      && typeof payload.features === "object"
      && payload.features !== null
      && (payload.features as Record<string, unknown>).detect === true
      && (payload.features as Record<string, unknown>).openai_ocr === true
  );
  assertManagedServiceLaunchCurrent("paddle", launchToken);
  return setManagedServiceStatus("paddle", {
    state: "running",
    managed: true,
    url: urls.ocrBaseUrl,
    urls,
    error: null
  });
}

async function launchEdgeServiceInternal(launchToken: number): Promise<ManagedServiceStatus> {
  const { uvCacheDir, edgeServiceDir, edgeEnvDir } = getManagedServicePaths();
  const edgePort = await resolveAvailablePort(8012);
  const ttsUrl = `http://127.0.0.1:${edgePort}/v1`;
  const edgeHealthUrl = `http://127.0.0.1:${edgePort}`;
  const baseEnv = windowsEnv(process.env, { UV_CACHE_DIR: uvCacheDir });
  await runManagedCommand(
    "recommendedCpu.edge.sync",
    preferredUvCommand(),
    ["sync", "--inexact"],
    edgeServiceDir,
    windowsEnv(baseEnv, { UV_PROJECT_ENVIRONMENT: edgeEnvDir })
  );
  assertManagedServiceLaunchCurrent("edge", launchToken);
  const edgeChild = spawnManagedChild(
    "edge",
    envPythonPath(edgeEnvDir),
    ["-m", "tts_edge_adapter.cli", "serve", "--host", "127.0.0.1", "--port", String(edgePort)],
    edgeServiceDir,
    windowsEnv(baseEnv, { UV_PROJECT_ENVIRONMENT: edgeEnvDir })
  );
  writeBackendLog("info", "stack", "recommendedCpu.edge.started", { pid: edgeChild.pid, port: edgePort });
  await waitForServiceHealth(edgeHealthUrl, 60000, (payload) => payload.ok === true);
  assertManagedServiceLaunchCurrent("edge", launchToken);
  return setManagedServiceStatus("edge", {
    state: "running",
    managed: true,
    url: ttsUrl,
    error: null
  });
}

async function terminateManagedServiceChild(serviceId: ManagedServiceId): Promise<void> {
  const child = managedServiceChildren[serviceId]?.child ?? null;
  if (!child) return;
  delete managedServiceChildren[serviceId];
  await terminateChildTree(child);
}

async function stopManagedService(serviceId: ManagedServiceId): Promise<ManagedServiceStatus> {
  delete managedServiceLaunchPromises[serviceId];
  cancelManagedServiceLaunch(serviceId);
  await terminateManagedServiceChild(serviceId);
  return setManagedServiceStatus(serviceId, {
    state: "stopped",
    managed: false,
    url: null,
    urls: null,
    error: null
  });
}

async function launchManagedService(serviceId: ManagedServiceId): Promise<ManagedServiceStatus> {
  const current = managedServicesStatus[serviceId];
  if (current.state === "running") {
    return managedServiceStatusSnapshot(serviceId);
  }
  if (managedServiceLaunchPromises[serviceId]) {
    return managedServiceLaunchPromises[serviceId] as Promise<ManagedServiceStatus>;
  }

  setManagedServiceStatus(serviceId, {
    state: "starting",
    managed: false,
    url: null,
    urls: null,
    error: null
  });
  const launchToken = beginManagedServiceLaunch(serviceId);
  const launchPromise = (async () => {
    try {
      return serviceId === "paddle"
        ? await launchPaddleServiceInternal(launchToken)
        : await launchEdgeServiceInternal(launchToken);
    } catch (error) {
      if (error instanceof ManagedServiceLaunchCancelledError || !isManagedServiceLaunchCurrent(serviceId, launchToken)) {
        return managedServiceStatusSnapshot(serviceId);
      }
      delete managedServiceLaunchPromises[serviceId];
      await terminateManagedServiceChild(serviceId);
      return setManagedServiceStatus(serviceId, {
        state: "failed",
        managed: false,
        url: null,
        urls: null,
        error: String(error)
      });
    } finally {
      if (isManagedServiceLaunchCurrent(serviceId, launchToken)) {
        delete managedServiceLaunchPromises[serviceId];
      }
    }
  })();
  managedServiceLaunchPromises[serviceId] = launchPromise;

  return launchPromise;
}

function loadPinnedPref(): boolean {
  try {
    const raw = fs.readFileSync(prefsPath(), "utf-8");
    const parsed = JSON.parse(raw) as NativePrefs;
    return parsed.alwaysOnTop ?? false;
  } catch {
    return false;
  }
}

function loadNativePrefs(): NativePrefs {
  try {
    const raw = fs.readFileSync(prefsPath(), "utf-8");
    return JSON.parse(raw) as NativePrefs;
  } catch {
    return {};
  }
}

function saveNativePrefs(next: NativePrefs): void {
  const current = loadNativePrefs();
  const merged: NativePrefs = {
    ...current,
    ...next
  };
  try {
    fs.writeFileSync(prefsPath(), JSON.stringify(merged, null, 2), "utf-8");
  } catch {
    // ignore persistence failures
  }
}

function savePinnedPref(value: boolean): void {
  saveNativePrefs({ alwaysOnTop: value });
}

type ClipboardWatcherSnapshot =
  | { kind: "text"; signature: string; text: string }
  | { kind: "image"; signature: string; dataUrl: string }
  | { kind: "unsupported" | "none"; signature: string };

function sha256Hex(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function clipboardWatcherTextSignature(text: string): string {
  return `text:${sha256Hex(text)}`;
}

function suppressClipboardWatcherText(text: string): void {
  const normalized = String(text ?? "").trim();
  if (!normalized) return;
  clipboardWatcherSuppressedSignatures.add(clipboardWatcherTextSignature(normalized));
}

function isLikelyImageClipboardFormat(formats: string[]): boolean {
  return formats.some((format) => /image|png|bmp|dib|bitmap|jfif|jpeg|jpg|gif|tiff|webp/i.test(format));
}

function readClipboardWatcherSnapshot(): ClipboardWatcherSnapshot {
  const formats = clipboard.availableFormats();
  if (isLikelyImageClipboardFormat(formats)) {
    const image = clipboard.readImage();
    if (!image.isEmpty()) {
      const pngBuffer = image.toPNG();
      if (pngBuffer.byteLength > 0) {
        return {
          kind: "image",
          signature: `image:${sha256Hex(pngBuffer)}`,
          dataUrl: `data:image/png;base64,${pngBuffer.toString("base64")}`
        };
      }
    }
  }

  const text = clipboard.readText().trim();
  if (text) {
    return { kind: "text", signature: clipboardWatcherTextSignature(text), text };
  }

  if (formats.length === 0) {
    return { kind: "none", signature: "none" };
  }

  const normalizedFormats = formats.map(String).sort().join("|");
  return { kind: "unsupported", signature: `unsupported:${sha256Hex(normalizedFormats)}` };
}

function emitClipboardWatcherItem(snapshot: Extract<ClipboardWatcherSnapshot, { kind: "text" | "image" }>): void {
  if (snapshot.kind === "text") {
    mainWindow?.webContents.send("clipboard-watcher-item", { kind: "text", text: snapshot.text });
    diag("clipboard.watcher.text.sent", { length: snapshot.text.length });
    return;
  }
  mainWindow?.webContents.send("clipboard-watcher-item", { kind: "image", dataUrl: snapshot.dataUrl });
  diag("clipboard.watcher.image.sent", { dataUrlLength: snapshot.dataUrl.length });
}

function emitClipboardWatcherStateChanged(enabled: boolean): void {
  mainWindow?.webContents.send("clipboard-watcher-state-changed", { enabled });
  diag("clipboard.watcher.state.sent", { enabled });
}

function seedClipboardWatcherSignature(): void {
  try {
    clipboardWatcherLastSignature = readClipboardWatcherSnapshot().signature;
  } catch (error) {
    clipboardWatcherLastSignature = null;
    diag("clipboard.watcher.seed.failed", { error: String(error) });
  }
}

async function pollClipboardWatcher(): Promise<void> {
  if (!clipboardWatcherEnabled || clipboardWatcherPollInFlight || copyPlayInFlight) {
    return;
  }
  clipboardWatcherPollInFlight = true;
  try {
    const snapshot = readClipboardWatcherSnapshot();
    if (snapshot.signature === clipboardWatcherLastSignature) {
      return;
    }
    clipboardWatcherLastSignature = snapshot.signature;
    if (clipboardWatcherSuppressedSignatures.delete(snapshot.signature)) {
      diag("clipboard.watcher.signature.suppressed", { kind: snapshot.kind });
      return;
    }
    if (snapshot.kind === "text" || snapshot.kind === "image") {
      emitClipboardWatcherItem(snapshot);
    }
  } catch (error) {
    diag("clipboard.watcher.poll.failed", { error: String(error) });
  } finally {
    clipboardWatcherPollInFlight = false;
  }
}

function stopClipboardWatcher(): void {
  if (clipboardWatcherPollTimer) {
    clearInterval(clipboardWatcherPollTimer);
    clipboardWatcherPollTimer = null;
  }
  clipboardWatcherPollInFlight = false;
  clipboardWatcherLastSignature = null;
  diag("clipboard.watcher.stopped");
}

function startClipboardWatcher(): void {
  if (clipboardWatcherPollTimer) {
    return;
  }
  seedClipboardWatcherSignature();
  clipboardWatcherPollTimer = setInterval(() => {
    void pollClipboardWatcher();
  }, CLIPBOARD_WATCH_POLL_MS);
  diag("clipboard.watcher.started", { pollMs: CLIPBOARD_WATCH_POLL_MS });
}

function setClipboardWatcherEnabledState(
  enabled: boolean,
  options?: { source?: "startup" | "ipc" | "hotkey"; emitState?: boolean; emitFeedback?: boolean }
): boolean {
  const next = Boolean(enabled);
  clipboardWatcherEnabled = next;
  saveNativePrefs({ clipboardWatcherEnabled: next });
  if (next) {
    startClipboardWatcher();
  } else {
    stopClipboardWatcher();
  }
  if (options?.emitFeedback) {
    emitHotkeyFeedback("clipboardWatcher", "success");
  }
  if (options?.emitState !== false) {
    emitClipboardWatcherStateChanged(next);
  }
  diag("clipboard.watcher.changed", { enabled: next, source: options?.source ?? "ipc" });
  return next;
}

function getOverlayThemeColors(theme: UiTheme): { outerColor: string; innerColor: string } {
  const colors = OVERLAY_THEME_COLORS[theme];
  return {
    outerColor: colors.outer,
    innerColor: colors.inner
  };
}

function applyOverlayTheme(theme: UiTheme): void {
  activeTheme = theme;
  const colors = getOverlayThemeColors(theme);
  overlay?.setColors(colors);
  diag("overlay.theme.applied", {
    theme,
    outerColor: colors.outerColor,
    innerColor: colors.innerColor
  });
}

function setOverlayTheme(theme: UiTheme): void {
  applyOverlayTheme(theme);
  saveNativePrefs({ theme });
  writeBackendLog("info", "electron", "overlay.theme.updated", {
    theme,
    ...getOverlayThemeColors(theme)
  });
}

function setAlwaysOnTopState(value: boolean, targetWindow?: BrowserWindow | null): boolean {
  isPinned = Boolean(value);
  const activeWindow = targetWindow && !targetWindow.isDestroyed()
    ? targetWindow
    : (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null);
  if (activeWindow) {
    activeWindow.setAlwaysOnTop(isPinned, "floating");
  }
  savePinnedPref(isPinned);
  diag("window.always-on-top.changed", { enabled: isPinned });
  return isPinned;
}

function shouldWrite(level: LogLevel): boolean {
  return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[currentLogLevel];
}

function appendLogLine(line: string): void {
  try {
    fs.mkdirSync(getLogDir(), { recursive: true });
    fs.appendFileSync(getLogFilePath(), `${line}\n`, "utf-8");
  } catch {
    // keep process alive even if file logging fails
  }
}

function appendStartupLine(line: string): void {
  try {
    ensureDir(getLogDir());
    fs.appendFileSync(startupDiagnosticsPath(), `${line}\n`, "utf-8");
  } catch {
    // keep process alive even if file logging fails
  }
}

function flushStartupPhaseBuffer(): void {
  if (startupPhaseBuffer.length === 0) return;
  for (const line of startupPhaseBuffer.splice(0, startupPhaseBuffer.length)) {
    appendStartupLine(line);
  }
}

function recordStartupPhase(phase: string, details?: Record<string, unknown>): void {
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    uptimeMs: processUptimeMs(),
    phase,
    ...(details ?? {})
  });
  if (app.isReady()) {
    flushStartupPhaseBuffer();
    appendStartupLine(line);
    return;
  }
  startupPhaseBuffer.push(line);
}

function clearStartupWatchdog(timer: NodeJS.Timeout | null): NodeJS.Timeout | null {
  if (timer) clearTimeout(timer);
  return null;
}

function armStartupWatchdogs(): void {
  startupWatchdogDomReady = clearStartupWatchdog(startupWatchdogDomReady);
  startupWatchdogRendererMount = clearStartupWatchdog(startupWatchdogRendererMount);
  startupDomReadySeen = false;
  startupRendererMountSeen = false;
  startupWatchdogDomReady = setTimeout(() => {
    if (!startupDomReadySeen) {
      recordStartupPhase("watchdog.dom-ready.slow", { thresholdMs: 5000 });
    }
  }, 5000);
  startupWatchdogRendererMount = setTimeout(() => {
    if (!startupRendererMountSeen) {
      recordStartupPhase("watchdog.renderer-mount.slow", { thresholdMs: 15000 });
    }
  }, 15000);
}

function noteStartupPhase(phase: string, details?: Record<string, unknown>): void {
  recordStartupPhase(phase, details);
  if (phase === "window.web.dom-ready") {
    startupDomReadySeen = true;
    startupWatchdogDomReady = clearStartupWatchdog(startupWatchdogDomReady);
  }
  if (phase === "renderer.app.mount.end") {
    startupRendererMountSeen = true;
    startupWatchdogRendererMount = clearStartupWatchdog(startupWatchdogRendererMount);
  }
}

function writeBackendLog(level: LogLevel, category: string, message: string, context?: Record<string, unknown>): void {
  if (!shouldWrite(level)) return;
  const entry: BackendLogEntry = {
    timestamp: new Date().toISOString(),
    level,
    category,
    message,
    context,
    source: "backend"
  };
  const consoleLine = `[${entry.timestamp}] [${entry.level.toUpperCase().padEnd(5)}] [${entry.category}] ${entry.message}`;
  const contextPart = entry.context ? ` ${JSON.stringify(entry.context)}` : "";
  if (entry.level === "error") console.error(`${consoleLine}${contextPart}`);
  else if (entry.level === "warn") console.warn(`${consoleLine}${contextPart}`);
  else if (entry.level === "debug") console.debug(`${consoleLine}${contextPart}`);
  else console.info(`${consoleLine}${contextPart}`);
  appendLogLine(JSON.stringify(entry));
}

function diag(event: string, data?: Record<string, unknown>): void {
  writeBackendLog("info", "electron", event, {
    uptimeMs: processUptimeMs(),
    ...data
  });
  try {
    const payload = JSON.stringify({
      uptimeMs: processUptimeMs(),
      ...(data ?? {})
    });
    fs.appendFileSync(diagnosticsPath(), `[${new Date().toISOString()}] ${event}${payload}\n`, "utf-8");
  } catch {
    // no-op
  }
  noteStartupPhase(event, data);
}

type CaptureAuditStats = {
  width: number;
  height: number;
  pixelCount: number;
  opaqueBlackPixels: number;
  transparentPixels: number;
  nonBlackPixels: number;
  blackRatio: number;
  transparentRatio: number;
  blankRatio: number;
  isProbablyBlackFrame: boolean;
  isProbablyBlankFrame: boolean;
};

function sanitizeCaptureAuditName(value: string): string {
  return value.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "capture";
}

function inspectCapturePng(pngBuffer: Buffer): CaptureAuditStats {
  const image = nativeImage.createFromBuffer(pngBuffer);
  const size = image.getSize();
  const bitmap = image.toBitmap();
  const pixelCount = size.width * size.height;
  let opaqueBlackPixels = 0;
  let transparentPixels = 0;

  for (let index = 0; index < bitmap.length; index += 4) {
    const blue = bitmap[index] ?? 0;
    const green = bitmap[index + 1] ?? 0;
    const red = bitmap[index + 2] ?? 0;
    const alpha = bitmap[index + 3] ?? 0;
    if (alpha === 0) {
      transparentPixels += 1;
      continue;
    }
    if (red === 0 && green === 0 && blue === 0) {
      opaqueBlackPixels += 1;
    }
  }

  const nonBlackPixels = Math.max(0, pixelCount - opaqueBlackPixels - transparentPixels);
  const blackRatio = pixelCount > 0 ? opaqueBlackPixels / pixelCount : 0;
  const transparentRatio = pixelCount > 0 ? transparentPixels / pixelCount : 0;
  const blankRatio = pixelCount > 0 ? (opaqueBlackPixels + transparentPixels) / pixelCount : 0;
  return {
    width: size.width,
    height: size.height,
    pixelCount,
    opaqueBlackPixels,
    transparentPixels,
    nonBlackPixels,
    blackRatio,
    transparentRatio,
    blankRatio,
    isProbablyBlackFrame: pixelCount > 0 && blackRatio >= 0.98,
    isProbablyBlankFrame: pixelCount > 0 && blankRatio >= 0.98
  };
}

function persistCapturedScreenshot(
  pngBuffer: Buffer,
  details: {
    captureKind: "selection" | "fullscreen" | "window";
    hotkey?: ElectronHotkeyKey;
    resultMode?: "editor" | "clipboard";
  }
): { filePath: string; fileName: string } {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const modePart = details.resultMode ? `-${sanitizeCaptureAuditName(details.resultMode)}` : "";
  const hotkeyPart = details.hotkey ? `-${sanitizeCaptureAuditName(details.hotkey)}` : "";
  const fileName = `${stamp}-${sanitizeCaptureAuditName(details.captureKind)}${modePart}${hotkeyPart}.png`;
  return {
    fileName,
    filePath: path.join(getLogDir(), "screenshot", fileName)
  };
}

function emitCapturedImage(
  pngBuffer: Buffer,
  details: {
    captureKind: "selection" | "fullscreen" | "window";
    hotkey?: ElectronHotkeyKey;
    resultMode?: "editor" | "clipboard";
    automation?: CaptureAutomationPayload;
    bounds?: Record<string, unknown>;
    frozen?: FrozenCaptureHandle | null;
    crop?: Record<string, unknown>;
    sourceEvent: string;
  }
): void {
  const persisted = persistCapturedScreenshot(pngBuffer, details);
  const audit = inspectCapturePng(pngBuffer);
  diag(`${details.sourceEvent}.buffer`, {
    bytes: pngBuffer.byteLength,
    savedPath: persisted.filePath,
    captureKind: details.captureKind,
    hotkey: details.hotkey,
    resultMode: details.resultMode,
    automation: details.automation,
    bounds: details.bounds,
    crop: details.crop,
    frozenAgeMs: details.frozen ? Date.now() - details.frozen.capturedAt : undefined,
    captureAttempts: details.frozen?.captureAttempts,
    ...audit
  });
  if (audit.isProbablyBlankFrame) {
    diag("capture.blank-frame.detected", {
      sourceEvent: details.sourceEvent,
      savedPath: persisted.filePath,
      captureKind: details.captureKind,
      hotkey: details.hotkey,
      resultMode: details.resultMode,
      automation: details.automation,
      bounds: details.bounds,
      crop: details.crop,
      blankRatio: audit.blankRatio,
      blackRatio: audit.blackRatio,
      transparentRatio: audit.transparentRatio,
      bytes: pngBuffer.byteLength,
      frozenAgeMs: details.frozen ? Date.now() - details.frozen.capturedAt : undefined,
      captureAttempts: details.frozen?.captureAttempts
    });
  }

  const dataUrl = `data:image/png;base64,${pngBuffer.toString("base64")}`;
  mainWindow?.webContents.send("capture-image", {
    dataUrl,
    captureKind: details.captureKind,
    resultMode: details.resultMode ?? "editor",
    hotkey: details.hotkey,
    automation: details.automation
  });
}

function createProviderController(requestId: string): AbortController {
  const existing = providerAbortControllers.get(requestId);
  existing?.abort();
  const controller = new AbortController();
  providerAbortControllers.set(requestId, controller);
  return controller;
}

function finishProviderController(requestId: string): void {
  providerAbortControllers.delete(requestId);
}

function sendProviderOcrStreamEvent(event: ProviderOcrStreamEvent): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("provider:ocr-stream-event", event);
}

function clearLogs(): void {
  const basePath = getLogFilePath();
  try {
    if (fs.existsSync(basePath)) fs.unlinkSync(basePath);
    for (let i = 1; i <= 3; i += 1) {
      const rotated = `${basePath}.${i}`;
      if (fs.existsSync(rotated)) fs.unlinkSync(rotated);
    }
  } catch {
    // no-op
  }
}

function clearShutdownWatchdog(): void {
  if (!shutdownWatchdog) return;
  clearTimeout(shutdownWatchdog);
  shutdownWatchdog = null;
}

function disposeNativeResources(): void {
  if (selectionTicker) {
    clearInterval(selectionTicker);
    selectionTicker = null;
  }
  captureHotkeySession?.stop();
  captureHotkeySession = null;
  ocrClipboardHotkeySession?.stop();
  ocrClipboardHotkeySession = null;
  fullCaptureHotkeySession?.stop();
  fullCaptureHotkeySession = null;
  activeWindowCaptureHotkeySession?.stop();
  activeWindowCaptureHotkeySession = null;
  copyHotkeySession?.stop();
  copyHotkeySession = null;
  autoReaderHotkeySession?.stop();
  autoReaderHotkeySession = null;
  abortHotkeySession?.stop();
  abortHotkeySession = null;
  playbackToggleHotkeySession?.stop();
  playbackToggleHotkeySession = null;
  playbackNextHotkeySession?.stop();
  playbackNextHotkeySession = null;
  playbackPreviousHotkeySession?.stop();
  playbackPreviousHotkeySession = null;
  volumeUpHotkeySession?.stop();
  volumeUpHotkeySession = null;
  volumeDownHotkeySession?.stop();
  volumeDownHotkeySession = null;
  replayCaptureHotkeySession?.stop();
  replayCaptureHotkeySession = null;
  resetAutoReaderRun();
  if (flashOverlayTimer) {
    clearTimeout(flashOverlayTimer);
    flashOverlayTimer = null;
  }
  overlay?.destroy();
  overlay = null;
}

function requestAppClose(): void {
  if (appCloseInFlight) {
    diag("app.close.request.ignored");
    return;
  }
  appCloseInFlight = true;
  diag("app.close.requested");

  const win = mainWindow;
  if (win && !win.isDestroyed()) {
    win.setSkipTaskbar(true);
    win.hide();
    diag("window.hide.for-close");
  }

  clearShutdownWatchdog();
  shutdownWatchdog = setTimeout(() => {
    diag("app.close.watchdog", {
      hasWindow: Boolean(mainWindow && !mainWindow.isDestroyed())
    });
  }, 2000);

  setTimeout(() => {
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        diag("window.destroy.for-close.begin");
        mainWindow.destroy();
      }
    } finally {
      diag("app.quit.requested");
      app.quit();
    }
  }, 0);
}

recordStartupPhase("process.start", {
  pid: process.pid,
  packaged: app.isPackaged,
  platform: process.platform
});

function createMainWindow(): BrowserWindow {
  diag("window.create.begin");
  armStartupWatchdogs();
  const win = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 860,
    minHeight: 560,
    resizable: true,
    frame: true,
    backgroundColor: "#fff0f5",
    show: isDevMode(),
    alwaysOnTop: isPinned,
    skipTaskbar: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  win.setResizable(true);
  win.setMenuBarVisibility(false);
  setAlwaysOnTopState(isPinned, win);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  const webContents = win.webContents;
  webContents.on("did-start-loading", () => {
    diag("window.web.did-start-loading");
    if (isDevMode() && !win.isDestroyed() && !win.isVisible()) {
      diag("window.show.dev-did-start-loading");
      win.show();
    }
  });
  webContents.on("dom-ready", () => {
    diag("window.web.dom-ready");
  });
  webContents.on("did-frame-finish-load", (_event, isMainFrame) => {
    diag("window.web.did-frame-finish-load", { isMainFrame });
  });
  webContents.on("did-finish-load", () => {
    diag("window.web.did-finish-load");
  });
  webContents.on("did-stop-loading", () => {
    diag("window.web.did-stop-loading");
  });
  webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    diag("window.web.did-fail-load", { errorCode, errorDescription, validatedURL, isMainFrame });
  });
  webContents.on("render-process-gone", (_event, details) => {
    diag("window.web.render-process-gone", {
      reason: details.reason,
      exitCode: details.exitCode
    });
    startupWatchdogDomReady = clearStartupWatchdog(startupWatchdogDomReady);
    startupWatchdogRendererMount = clearStartupWatchdog(startupWatchdogRendererMount);
  });
  webContents.on("unresponsive", () => {
    diag("window.web.unresponsive");
  });
  webContents.on("responsive", () => {
    diag("window.web.responsive");
  });

  win.on("show", () => {
    diag("window.show");
  });
  win.on("hide", () => {
    diag("window.hide");
  });
  win.on("close", () => {
    diag("window.close");
  });
  win.on("closed", () => {
    diag("window.closed");
    startupWatchdogDomReady = clearStartupWatchdog(startupWatchdogDomReady);
    startupWatchdogRendererMount = clearStartupWatchdog(startupWatchdogRendererMount);
    clearShutdownWatchdog();
    mainWindow = null;
  });

  if (isDevMode()) {
    if (!win.isVisible()) {
      diag("window.show.dev-immediate");
      win.show();
    }
  } else {
    win.once("ready-to-show", () => {
      diag("window.ready-to-show");
      win.show();
    });
  }

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  diag("window.load.begin", {
    target: devUrl ? "dev-server" : "dist-file",
    url: devUrl ?? path.join(__dirname, "../dist/index.html")
  });
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(path.join(__dirname, "../dist/index.html"));
  }

  return win;
}

function buildRect(a: { x: number; y: number }, b: { x: number; y: number }): { left: number; top: number; right: number; bottom: number } {
  return {
    left: Math.min(a.x, b.x),
    top: Math.min(a.y, b.y),
    right: Math.max(a.x, b.x),
    bottom: Math.max(a.y, b.y)
  };
}

function toStoredRect(
  rect: { left: number; top: number; right: number; bottom: number }
): { left: number; top: number; width: number; height: number } {
  return {
    left: rect.left,
    top: rect.top,
    width: rect.right - rect.left,
    height: rect.bottom - rect.top
  };
}

function toOverlayRect(
  rect: { left: number; top: number; width: number; height: number }
): { left: number; top: number; right: number; bottom: number } {
  return {
    left: rect.left,
    top: rect.top,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height
  };
}

function isValidStoredRect(rect: unknown): rect is { left: number; top: number; width: number; height: number } {
  if (!rect || typeof rect !== "object") return false;
  const value = rect as Record<string, unknown>;
  return (
    typeof value.left === "number" &&
    typeof value.top === "number" &&
    typeof value.width === "number" &&
    typeof value.height === "number" &&
    value.width > 0 &&
    value.height > 0
  );
}

function persistLastCaptureRect(rect: { left: number; top: number; width: number; height: number }): void {
  lastSavedCaptureRect = rect;
  saveNativePrefs({ lastCaptureRect: rect });
  diag("capture.last-rect.saved", rect);
}

function flashOverlayRect(rect: { left: number; top: number; right: number; bottom: number }, durationMs = 180): void {
  if (!overlay) return;
  if (flashOverlayTimer) {
    clearTimeout(flashOverlayTimer);
    flashOverlayTimer = null;
  }
  overlay.draw(rect);
  flashOverlayTimer = setTimeout(() => {
    overlay?.hide();
    flashOverlayTimer = null;
  }, durationMs);
}

function sameRect(
  a: { left: number; top: number; right: number; bottom: number } | null,
  b: { left: number; top: number; right: number; bottom: number } | null
): boolean {
  if (!a || !b) return false;
  return a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom;
}

function beginFrozenCaptureSession(): void {
  if (!selectionStart) return;
  frozenCaptureSession = beginFrozenMonitorCaptureAtPoint(selectionStart.x, selectionStart.y)
    .then((capture) => {
      diag("capture.frame.frozen", {
        left: capture.bounds.left,
        top: capture.bounds.top,
        width: capture.bounds.width,
        height: capture.bounds.height,
        ageMs: Date.now() - capture.capturedAt
      });
      return capture;
    })
    .catch((error: unknown) => {
      frozenCaptureSession = null;
      diag("capture.frame.error", { error: String(error) });
      throw error;
    });
}

function startSelection(
  point: { x: number; y: number },
  resultMode: "editor" | "clipboard",
  session: HotkeySession | null,
  hotkey: ElectronHotkeyKey,
  automation: CaptureAutomationPayload | null = null
): void {
  selectionStart = { x: point.x, y: point.y };
  selectionResultMode = resultMode;
  selectionSession = session;
  selectionHotkey = hotkey;
  selectionAutomation = automation;
  lastCursor = { x: point.x, y: point.y };
  lastRect = null;
  selectionActive = true;
  beginFrozenCaptureSession();
  if (drawSelectionRectangle) overlay?.hide();
  diag("capture.start", { x: point.x, y: point.y, hotkey: session?.getHotkey(), resultMode, sourceHotkey: hotkey, automation });
}

async function finalizeSelection(point: { x: number; y: number }): Promise<void> {
  if (!selectionActive || !selectionStart) {
    selectionActive = false;
    selectionStart = null;
    selectionResultMode = "editor";
    selectionSession = null;
    selectionHotkey = undefined;
    selectionAutomation = null;
    lastCursor = null;
    lastRect = null;
    if (drawSelectionRectangle) overlay?.hide();
    return;
  }

  lastCursor = { x: point.x, y: point.y };
  const startPoint = { x: selectionStart.x, y: selectionStart.y };
  const rect = buildRect(startPoint, lastCursor);
  const payload = {
    x: rect.left,
    y: rect.top,
    width: rect.right - rect.left,
    height: rect.bottom - rect.top
  };
  diag("capture.finalize", payload);

  selectionActive = false;
  selectionStart = null;
  const resultMode = selectionResultMode;
  const sourceHotkey = selectionHotkey;
  const automation = selectionAutomation;
  selectionResultMode = "editor";
  selectionSession = null;
  selectionHotkey = undefined;
  selectionAutomation = null;
  lastCursor = null;
  lastRect = null;
  if (drawSelectionRectangle) overlay?.hide();

  let frozen: FrozenCaptureHandle | null = null;
  try {
    const sessionPromise = frozenCaptureSession ?? beginFrozenMonitorCaptureAtPoint(point.x, point.y);
    frozen = await sessionPromise;
    frozenCaptureSession = null;
    if (payload.width < 1 || payload.height < 1) {
      throw new Error("Selection rectangle has zero area");
    }
    persistLastCaptureRect({
      left: payload.x,
      top: payload.y,
      width: payload.width,
      height: payload.height
    });
    rememberLastCaptureTargetWindow({
      left: payload.x,
      top: payload.y,
      width: payload.width,
      height: payload.height
    });
    const cropLeft = payload.x - frozen.bounds.left;
    const cropTop = payload.y - frozen.bounds.top;
    const pngBuffer = await cropFrozenCapture(frozen.id, {
      x: cropLeft,
      y: cropTop,
      width: payload.width,
      height: payload.height
    });

    emitCapturedImage(pngBuffer, {
      captureKind: "selection",
      resultMode,
      ...(sourceHotkey ? { hotkey: sourceHotkey } : {}),
      ...(automation ? { automation } : {}),
      bounds: {
        left: frozen.bounds.left,
        top: frozen.bounds.top,
        width: frozen.bounds.width,
        height: frozen.bounds.height
      },
      frozen,
      crop: {
        x: cropLeft,
        y: cropTop,
        width: payload.width,
        height: payload.height
      },
      sourceEvent: "capture.image.sent"
    });
    diag("capture.image.sent", {
      width: payload.width,
      height: payload.height,
      captureKind: "selection",
      resultMode,
      sourceHotkey,
      automation,
      frozenAgeMs: Date.now() - frozen.capturedAt
    });
  } catch (error) {
    frozenCaptureSession = null;
    if (sourceHotkey) {
      emitHotkeyFeedback(sourceHotkey, "error", String(error));
    }
    if (sourceHotkey === "autoReader") {
      resetAutoReaderRun();
    }
    diag("capture.error", { error: String(error) });
  } finally {
    if (frozen) {
      try {
        disposeFrozenCapture(frozen.id);
      } catch {
        // best effort
      }
    }
  }
}

async function captureSavedRect(options: {
  sourceEvent: string;
  hotkey?: ElectronHotkeyKey;
  automation?: CaptureAutomationPayload;
  emitFeedbackHotkey?: ElectronHotkeyKey;
  successEvent: string;
  errorEvent: string;
}): Promise<void> {
  const rect = lastSavedCaptureRect;
  if (!rect) {
    throw new Error("No previous capture selection available");
  }
  if (rect.width < 1 || rect.height < 1) {
    throw new Error("Previous capture selection is invalid");
  }

  let frozen: FrozenCaptureHandle | null = null;
  try {
    const anchorX = rect.left + Math.floor(rect.width / 2);
    const anchorY = rect.top + Math.floor(rect.height / 2);
    frozen = await beginFrozenMonitorCaptureAtPoint(anchorX, anchorY);
    const overlayRect = toOverlayRect(rect);
    flashOverlayRect(overlayRect);

    const cropLeft = rect.left - frozen.bounds.left;
    const cropTop = rect.top - frozen.bounds.top;
    const pngBuffer = await cropFrozenCapture(frozen.id, {
      x: cropLeft,
      y: cropTop,
      width: rect.width,
      height: rect.height
    });

    emitCapturedImage(pngBuffer, {
      captureKind: "selection",
      ...(options.hotkey ? { hotkey: options.hotkey } : {}),
      ...(options.automation ? { automation: options.automation } : {}),
      bounds: {
        left: frozen.bounds.left,
        top: frozen.bounds.top,
        width: frozen.bounds.width,
        height: frozen.bounds.height
      },
      frozen,
      crop: {
        x: cropLeft,
        y: cropTop,
        width: rect.width,
        height: rect.height
      },
      sourceEvent: options.sourceEvent
    });
    if (options.emitFeedbackHotkey) {
      emitHotkeyFeedback(options.emitFeedbackHotkey, "success");
    }
    diag(options.successEvent, {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      frozenAgeMs: Date.now() - frozen.capturedAt
    });
  } catch (error) {
    if (options.emitFeedbackHotkey) {
      emitHotkeyFeedback(options.emitFeedbackHotkey, "error", String(error));
    }
    diag(options.errorEvent, {
      error: String(error),
      rect
    });
    throw error;
  } finally {
    if (frozen) {
      try {
        disposeFrozenCapture(frozen.id);
      } catch {
        // best effort
      }
    }
  }
}

async function captureAutoReaderTargetRect(options: {
  sourceEvent: string;
  hotkey?: ElectronHotkeyKey;
  automation: CaptureAutomationPayload;
  successEvent: string;
  errorEvent: string;
}): Promise<void> {
  let frozen: FrozenCaptureHandle | null = null;
  try {
    const target = autoReaderTargetWindow;
    if (!target) {
      throw new Error("Automatic reader target window is not locked.");
    }
    const { rect } = resolveTargetRectForWindow(target);
    flashOverlayRect(toOverlayRect(rect));
    let captureBackend: "windows_graphics_capture" | "desktop_duplication" = "windows_graphics_capture";
    let pngBuffer: Buffer;
    let bounds: Record<string, unknown> = {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height
    };
    let crop: Record<string, unknown> = {
      x: target.region.x,
      y: target.region.y,
      width: target.region.width,
      height: target.region.height
    };
    try {
      pngBuffer = await captureWindowRegion(target.handle, {
        x: target.region.x,
        y: target.region.y,
        width: target.region.width,
        height: target.region.height
      });
    } catch (windowCaptureError) {
      captureBackend = "desktop_duplication";
      diag("auto.reader.capture.window-capture.failed", {
        error: String(windowCaptureError),
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height
      });
      const anchorX = rect.left + Math.floor(rect.width / 2);
      const anchorY = rect.top + Math.floor(rect.height / 2);
      frozen = await beginFrozenMonitorCaptureAtPoint(anchorX, anchorY);
      const cropLeft = rect.left - frozen.bounds.left;
      const cropTop = rect.top - frozen.bounds.top;
      pngBuffer = await cropFrozenCapture(frozen.id, {
        x: cropLeft,
        y: cropTop,
        width: rect.width,
        height: rect.height
      });
      bounds = {
        left: frozen.bounds.left,
        top: frozen.bounds.top,
        width: frozen.bounds.width,
        height: frozen.bounds.height
      };
      crop = {
        x: cropLeft,
        y: cropTop,
        width: rect.width,
        height: rect.height
      };
    }

    emitCapturedImage(pngBuffer, {
      captureKind: "selection",
      ...(options.hotkey ? { hotkey: options.hotkey } : {}),
      automation: options.automation,
      bounds: {
        ...bounds,
        captureBackend
      },
      frozen,
      crop,
      sourceEvent: options.sourceEvent
    });
    diag(options.successEvent, {
      left: rect.left,
      pid: null,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      captureBackend,
      launchCwd: null,
      launchCommand: null,
      logLines: [],
      frozenAgeMs: frozen ? Date.now() - frozen.capturedAt : undefined
    });
  } catch (error) {
    diag(options.errorEvent, {
      error: String(error)
    });
    throw error;
  } finally {
    if (frozen) {
      try {
        disposeFrozenCapture(frozen.id);
      } catch {
        // best effort
      }
    }
  }
}

async function replayLastCaptureRect(): Promise<void> {
  try {
    await captureSavedRect({
      sourceEvent: "capture.replay.sent",
      hotkey: "replayCapture",
      emitFeedbackHotkey: "replayCapture",
      successEvent: "capture.replay.sent",
      errorEvent: "capture.replay.error"
    });
  } catch {
    // feedback/logging already handled by captureSavedRect
  }
}

async function captureFullScreenAtPoint(point: { x: number; y: number }): Promise<void> {
  let frozen: FrozenCaptureHandle | null = null;
  try {
    frozen = await beginFrozenMonitorCaptureAtPoint(point.x, point.y);
    const pngBuffer = await cropFrozenCapture(frozen.id, {
      x: 0,
      y: 0,
      width: frozen.bounds.width,
      height: frozen.bounds.height
    });

    emitCapturedImage(pngBuffer, {
      captureKind: "fullscreen",
      hotkey: "fullCapture",
      bounds: {
        left: frozen.bounds.left,
        top: frozen.bounds.top,
        width: frozen.bounds.width,
        height: frozen.bounds.height
      },
      frozen,
      crop: {
        x: 0,
        y: 0,
        width: frozen.bounds.width,
        height: frozen.bounds.height
      },
      sourceEvent: "capture.fullscreen.sent"
    });
    emitHotkeyFeedback("fullCapture", "success");
    diag("capture.fullscreen.sent", {
      left: frozen.bounds.left,
      top: frozen.bounds.top,
      width: frozen.bounds.width,
      height: frozen.bounds.height,
      hotkey: fullCaptureHotkeySession?.getHotkey(),
      frozenAgeMs: Date.now() - frozen.capturedAt
    });
  } catch (error) {
    emitHotkeyFeedback("fullCapture", "error", String(error));
    diag("capture.fullscreen.error", { error: String(error) });
  } finally {
    if (frozen) {
      try {
        disposeFrozenCapture(frozen.id);
      } catch {
        // best effort
      }
    }
  }
}

async function captureActiveWindow(): Promise<void> {
  let frozen: FrozenCaptureHandle | null = null;
  try {
    const bounds = getForegroundWindowBounds();
    const anchorX = bounds.left + Math.floor(bounds.width / 2);
    const anchorY = bounds.top + Math.floor(bounds.height / 2);
    frozen = await beginFrozenMonitorCaptureAtPoint(anchorX, anchorY);

    const windowRight = bounds.left + bounds.width;
    const windowBottom = bounds.top + bounds.height;
    const frozenRight = frozen.bounds.left + frozen.bounds.width;
    const frozenBottom = frozen.bounds.top + frozen.bounds.height;
    const fitsSingleMonitor =
      bounds.left >= frozen.bounds.left &&
      bounds.top >= frozen.bounds.top &&
      windowRight <= frozenRight &&
      windowBottom <= frozenBottom;
    if (!fitsSingleMonitor) {
      throw new Error("Active window spans multiple monitors");
    }

    const pngBuffer = await cropFrozenCapture(frozen.id, {
      x: bounds.left - frozen.bounds.left,
      y: bounds.top - frozen.bounds.top,
      width: bounds.width,
      height: bounds.height
    });

    emitCapturedImage(pngBuffer, {
      captureKind: "window",
      hotkey: "activeWindowCapture",
      bounds: {
        left: frozen.bounds.left,
        top: frozen.bounds.top,
        width: frozen.bounds.width,
        height: frozen.bounds.height,
        windowLeft: bounds.left,
        windowTop: bounds.top,
        windowWidth: bounds.width,
        windowHeight: bounds.height
      },
      frozen,
      crop: {
        x: bounds.left - frozen.bounds.left,
        y: bounds.top - frozen.bounds.top,
        width: bounds.width,
        height: bounds.height
      },
      sourceEvent: "capture.window.sent"
    });
    emitHotkeyFeedback("activeWindowCapture", "success");
    diag("capture.window.sent", {
      left: bounds.left,
      top: bounds.top,
      width: bounds.width,
      height: bounds.height,
      hotkey: activeWindowCaptureHotkeySession?.getHotkey(),
      frozenAgeMs: Date.now() - frozen.capturedAt
    });
  } catch (error) {
    emitHotkeyFeedback("activeWindowCapture", "error", String(error));
    diag("capture.window.error", { error: String(error) });
  } finally {
    if (frozen) {
      try {
        disposeFrozenCapture(frozen.id);
      } catch {
        // best effort
      }
    }
  }
}

function startSelectionTicker(): void {
  if (selectionTicker) return;
  selectionTicker = setInterval(() => {
    if (!selectionActive || !selectionSession || !selectionStart) return;
    const point = selectionSession.getCursorPos();
    if (!point) return;

    lastCursor = { x: point.x, y: point.y };
    const nextRect = buildRect(selectionStart, lastCursor);
    if (nextRect.right <= nextRect.left || nextRect.bottom <= nextRect.top) return;

    if (!drawSelectionRectangle) return;
    if (!sameRect(lastRect, nextRect)) {
      overlay?.draw(nextRect);
      lastRect = nextRect;
    }
  }, 16);
}

function normalizeHotkeyLabel(hotkey: string): string {
  return String(hotkey ?? "").trim().toLowerCase();
}

function readStoredHotkey(value: string | undefined, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function normalizeAutoReaderText(value: string | undefined): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function isValidAutoReaderDelay(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 60_000;
}

function isValidAutoReaderNoTextRetryCount(value: number | undefined): value is number {
  return typeof value === "number"
    && Number.isFinite(value)
    && Number.isInteger(value)
    && value >= 0
    && value <= MAX_AUTO_READER_NO_TEXT_RETRY_COUNT;
}

function rectRight(rect: { left: number; width: number }): number {
  return rect.left + rect.width;
}

function rectBottom(rect: { top: number; height: number }): number {
  return rect.top + rect.height;
}

function lockAutoReaderTargetWindow(selectionRect: { left: number; top: number; width: number; height: number }): AutoReaderTargetWindow {
  const windowInfo = getForegroundWindowInfo();
  if (windowInfo.minimized) {
    throw new Error("The target window is minimized.");
  }
  if (
    selectionRect.left < windowInfo.bounds.left ||
    selectionRect.top < windowInfo.bounds.top ||
    rectRight(selectionRect) > rectRight(windowInfo.bounds) ||
    rectBottom(selectionRect) > rectBottom(windowInfo.bounds)
  ) {
    throw new Error("Start automatic reader with the target window active and the saved capture area visible inside it.");
  }
  return {
    handle: windowInfo.handle,
    region: {
      x: selectionRect.left - windowInfo.bounds.left,
      y: selectionRect.top - windowInfo.bounds.top,
      width: selectionRect.width,
      height: selectionRect.height
    }
  };
}

function resolveTargetRectForWindow(target: AutoReaderTargetWindow): { rect: { left: number; top: number; width: number; height: number } } {
  const windowInfo = getWindowInfo(target.handle);
  if (windowInfo.minimized) {
    throw new Error("The target window is minimized.");
  }
  const rect = {
    left: windowInfo.bounds.left + target.region.x,
    top: windowInfo.bounds.top + target.region.y,
    width: target.region.width,
    height: target.region.height
  };
  if (
    rect.left < windowInfo.bounds.left ||
    rect.top < windowInfo.bounds.top ||
    rectRight(rect) > rectRight(windowInfo.bounds) ||
    rectBottom(rect) > rectBottom(windowInfo.bounds)
  ) {
    throw new Error("The saved capture area no longer fits inside the locked target window.");
  }
  return { rect };
}

function resolveAutoReaderTargetRect(): { rect: { left: number; top: number; width: number; height: number } } {
  const target = autoReaderTargetWindow;
  if (!target) {
    throw new Error("Automatic reader target window is not locked.");
  }
  return resolveTargetRectForWindow(target);
}

function rememberLastCaptureTargetWindow(rect: { left: number; top: number; width: number; height: number }): void {
  try {
    lastSavedCaptureTargetWindow = lockAutoReaderTargetWindow(rect);
    diag("capture.last-target-window.saved", rect);
  } catch (error) {
    lastSavedCaptureTargetWindow = null;
    diag("capture.last-target-window.skipped", { error: String(error), rect });
  }
}

function resetAutoReaderRun(): void {
  autoReaderState = "idle";
  autoReaderActiveRunId = null;
  autoReaderLastTextSignature = null;
  autoReaderNoTextStreak = 0;
  autoReaderTargetWindow = null;
  selectionAutomation = null;
}

function stopAutoReader(message?: string, phase: ElectronHotkeyFeedbackPhase = "success"): void {
  if (autoReaderActiveRunId !== null || autoReaderState !== "idle") {
    diag("auto.reader.stop", { runId: autoReaderActiveRunId, state: autoReaderState, message, phase });
  }
  if (selectionAutomation?.kind === "auto_reader") {
    selectionActive = false;
    selectionStart = null;
    selectionSession = null;
    selectionHotkey = undefined;
    selectionAutomation = null;
    lastCursor = null;
    lastRect = null;
    if (drawSelectionRectangle) {
      overlay?.hide();
    }
  }
  resetAutoReaderRun();
  emitHotkeyFeedback("autoReader", phase, message ?? "Automatic reader stopped.");
  mainWindow?.webContents.send("abort-requested");
}

async function beginAutoReaderRun(): Promise<void> {
  if (selectionActive) {
    emitHotkeyFeedback("autoReader", "error", "Finish the active selection first.");
    return;
  }
  if (!lastSavedCaptureRect) {
    emitHotkeyFeedback("autoReader", "error", "Select an area first with Capture or Replay Capture.");
    diag("auto.reader.start.missing-rect");
    return;
  }
  if (lastSavedCaptureRect.width < 1 || lastSavedCaptureRect.height < 1) {
    emitHotkeyFeedback("autoReader", "error", "The saved capture area is invalid. Capture an area again first.");
    diag("auto.reader.start.invalid-rect", lastSavedCaptureRect);
    return;
  }
  autoReaderRunCounter += 1;
  let targetWindow: AutoReaderTargetWindow;
  try {
    if (lastSavedCaptureTargetWindow) {
      resolveTargetRectForWindow(lastSavedCaptureTargetWindow);
      targetWindow = lastSavedCaptureTargetWindow;
    } else {
      targetWindow = lockAutoReaderTargetWindow(lastSavedCaptureRect);
    }
  } catch (error) {
    emitHotkeyFeedback("autoReader", "error", String(error));
    diag("auto.reader.start.invalid-target", { error: String(error), rect: lastSavedCaptureRect });
    return;
  }
  const runId = autoReaderRunCounter;
  autoReaderActiveRunId = runId;
  autoReaderState = "processing";
  autoReaderLastTextSignature = null;
  autoReaderNoTextStreak = 0;
  autoReaderTargetWindow = targetWindow;
  try {
    await captureAutoReaderTargetRect({
      sourceEvent: "auto.reader.capture.initial.sent",
      hotkey: "autoReader",
      automation: { kind: "auto_reader", runId, phase: "initial" },
      successEvent: "auto.reader.capture.initial.sent",
      errorEvent: "auto.reader.capture.initial.error"
    });
    if (autoReaderActiveRunId === runId) {
      emitHotkeyFeedback("autoReader", "success", "Automatic reader started.");
      diag("auto.reader.started", { runId, phase: "initial" });
    }
  } catch (error) {
    if (autoReaderActiveRunId === runId) {
      stopAutoReader(`Automatic reader could not use the saved capture area: ${String(error)}`, "error");
    }
  }
}

async function advanceAutoReader(runId: number): Promise<void> {
  if (autoReaderActiveRunId !== runId || autoReaderState !== "processing") {
    return;
  }

  autoReaderState = "advancing";
  try {
    if (!autoReaderTargetWindow) {
      throw new Error("Automatic reader target window is not locked.");
    }
    const advanceSpec = parseSendSpec(autoReaderAdvanceHotkey);
    if (advanceSpec.kind === "mouse") {
      const { rect } = resolveTargetRectForWindow(autoReaderTargetWindow);
      await sendMouseClickAtPoint(advanceSpec.button, {
        x: rect.left + Math.floor(rect.width / 2),
        y: rect.top + Math.floor(rect.height / 2)
      }, {
        pressDurationMs: 24,
        restoreCursor: true
      });
    } else {
      await sendHotkeyToWindow(autoReaderTargetWindow.handle, autoReaderAdvanceHotkey, { pressDurationMs: 24 });
    }
  } catch (error) {
    stopAutoReader(`Automatic reader could not send "${autoReaderAdvanceHotkey}": ${String(error)}`, "error");
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, autoReaderAdvanceDelayMs));
  if (autoReaderActiveRunId !== runId || autoReaderState !== "advancing") {
    return;
  }

  try {
    await captureAutoReaderTargetRect({
      sourceEvent: "auto.reader.capture.replay.sent",
      hotkey: "autoReader",
      automation: { kind: "auto_reader", runId, phase: "replay" },
      successEvent: "auto.reader.capture.replay.sent",
      errorEvent: "auto.reader.capture.replay.error"
    });
    if (autoReaderActiveRunId === runId) {
      autoReaderState = "processing";
    }
  } catch (error) {
    stopAutoReader(`Automatic reader could not capture the next page: ${String(error)}`, "error");
  }
}

function handleAutoReaderPageResult(result: AutoReaderPageResult): void {
  if (result.runId !== autoReaderActiveRunId) {
    diag("auto.reader.result.stale", { result, activeRunId: autoReaderActiveRunId });
    return;
  }

  if (result.outcome === "cancelled") {
    stopAutoReader(result.message ?? "Automatic reader cancelled.");
    return;
  }

  if (result.outcome === "failed") {
    stopAutoReader(result.message ?? "Automatic reader stopped due to an OCR or playback error.", "error");
    return;
  }

  if (result.outcome !== "ready") {
    return;
  }

  const textSignature = normalizeAutoReaderText(result.text);
  const repeatedText = Boolean(autoReaderLastTextSignature) && textSignature === autoReaderLastTextSignature;
  if (!textSignature || repeatedText) {
    autoReaderNoTextStreak += 1;
    if (autoReaderNoTextStreak >= autoReaderNoTextRetryCount) {
      stopAutoReader(`Automatic reader stopped after ${autoReaderNoTextRetryCount} consecutive page turns without finding new text.`, "error");
      return;
    }
    if (!textSignature) {
      diag("auto.reader.result.empty", {
        runId: result.runId,
        emptyCount: autoReaderNoTextStreak,
        noTextRetryCount: autoReaderNoTextRetryCount
      });
    } else {
      diag("auto.reader.result.duplicate", {
        runId: result.runId,
        duplicateCount: autoReaderNoTextStreak,
        noTextRetryCount: autoReaderNoTextRetryCount
      });
    }
    void advanceAutoReader(result.runId);
    return;
  }
  autoReaderNoTextStreak = 0;

  autoReaderLastTextSignature = textSignature;
  void advanceAutoReader(result.runId);
}

function emitHotkeyFeedback(hotkey: ElectronHotkeyKey, phase: ElectronHotkeyFeedbackPhase, message?: string): void {
  mainWindow?.webContents.send("hotkey-feedback", { hotkey, phase, message });
  diag("hotkey.feedback", { hotkey, phase, message });
}

function getAllActiveHotkeys(): Array<{ name: string; hotkey: string }> {
  return [
    { name: "capture", hotkey: activeCaptureHotkey },
    { name: "ocr to clipboard", hotkey: activeOcrClipboardHotkey },
    { name: "full screen capture", hotkey: activeFullCaptureHotkey },
    { name: "active window capture", hotkey: activeActiveWindowCaptureHotkey },
    { name: "copy & play", hotkey: activeCopyHotkey },
    { name: "automatic reader", hotkey: activeAutoReaderHotkey },
    { name: "clipboard watch toggle", hotkey: activeClipboardWatcherHotkey },
    { name: "abort", hotkey: activeAbortHotkey },
    { name: "play/pause", hotkey: activePlaybackToggleHotkey },
    { name: "next chunk", hotkey: activePlaybackNextHotkey },
    { name: "previous chunk", hotkey: activePlaybackPreviousHotkey },
    { name: "volume up", hotkey: activeVolumeUpHotkey },
    { name: "volume down", hotkey: activeVolumeDownHotkey },
    { name: "replay capture", hotkey: activeReplayCaptureHotkey }
  ];
}

function assertHotkeyDistinct(candidate: string, selfName: string): string {
  const normalized = normalizeHotkeyLabel(candidate);
  if (!normalized) return normalized;
  for (const entry of getAllActiveHotkeys()) {
    if (entry.name === selfName) continue;
    if (!normalizeHotkeyLabel(entry.hotkey)) continue;
    if (normalized === normalizeHotkeyLabel(entry.hotkey)) {
      throw new Error(`${selfName} hotkey cannot match ${entry.name} hotkey`);
    }
  }
  return normalized;
}

function beginEditableHotkey(
  session: HotkeySession | null,
  activeHotkey: string,
  setBeforeEdit: (value: string | null) => void,
  logEvent: string
): string {
  if (!session) return activeHotkey;
  setBeforeEdit(activeHotkey);
  session.stop();
  diag(logEvent, { activeHotkey });
  return activeHotkey;
}

function applyEditableHotkey(
  session: HotkeySession | null,
  hotkey: string,
  selfName: string,
  toPersist: (value: string) => Partial<NativePrefs>,
  setActiveHotkey: (value: string) => void,
  setBeforeEdit: (value: string | null) => void,
  logEvent: string,
  fallback: string
): string {
  if (!session) return fallback;
  const normalized = assertHotkeyDistinct(hotkey, selfName);
  if (!normalized) throw new Error("Hotkey is required");
  session.setHotkey(normalized);
  const next = session.getHotkey();
  setActiveHotkey(next);
  setBeforeEdit(null);
  session.start();
  saveNativePrefs(toPersist(next));
  diag(logEvent, { activeHotkey: next });
  return next;
}

function clearEditableHotkey(
  session: HotkeySession | null,
  toPersist: (value: string) => Partial<NativePrefs>,
  setActiveHotkey: (value: string) => void,
  setBeforeEdit: (value: string | null) => void,
  logEvent: string,
  fallback: string
): string {
  if (!session) return fallback;
  session.stop();
  session.setHotkey("");
  setActiveHotkey("");
  setBeforeEdit(null);
  session.start();
  saveNativePrefs(toPersist(""));
  diag(logEvent, { activeHotkey: "" });
  return "";
}

function cancelEditableHotkey(
  session: HotkeySession | null,
  beforeEdit: string | null,
  setActiveHotkey: (value: string) => void,
  setBeforeEdit: (value: string | null) => void,
  logEvent: string,
  fallback: string
): string {
  if (!session) return fallback;
  if (beforeEdit) {
    session.setHotkey(beforeEdit);
    setActiveHotkey(session.getHotkey());
  }
  setBeforeEdit(null);
  session.start();
  diag(logEvent, { activeHotkey: fallback });
  return session.getHotkey();
}

function getEditableHotkey(session: HotkeySession | null, fallback: string, setActiveHotkey: (value: string) => void): string {
  if (session) {
    const next = session.getHotkey();
    setActiveHotkey(next);
    return next;
  }
  return fallback;
}

async function runCopyPlayCapture(): Promise<void> {
  if (copyPlayInFlight) return;
  copyPlayInFlight = true;
  try {
    const result = await captureCopyToText({ copyHotkey: "ctrl+c", timeoutMs: 5000, pollMs: 25, restoreClipboard: true });
    const text = result.text.trim();
    if (!result.changed || !text) {
      emitHotkeyFeedback("copyPlay", "error", "No text copied");
      diag("copy.play.empty", { changed: result.changed });
      return;
    }
    mainWindow?.webContents.send("copy-play-text", { text });
    emitHotkeyFeedback("copyPlay", "success");
    diag("copy.play.sent", { length: text.length });
  } catch (error) {
    emitHotkeyFeedback("copyPlay", "error", String(error));
    diag("copy.play.error", { error: String(error) });
  } finally {
    copyPlayInFlight = false;
  }
}

function emitPlaybackHotkey(action: "toggle_play_pause" | "next_chunk" | "previous_chunk" | "volume_up" | "volume_down"): void {
  mainWindow?.webContents.send("playback-hotkey", { action });
  diag("playback.hotkey.triggered", { action });
}

if (!hasSingleInstanceLock) {
  diag("app.single-instance.lock.failed");
  app.quit();
} else {
  app.on("second-instance", () => {
    diag("app.second-instance");
    focusMainWindow(mainWindow);
  });

  app.whenReady().then(() => {
    flushStartupPhaseBuffer();
    migrateLegacyUserData();
    diag("app.ready");
    const nativePrefs = loadNativePrefs();
    isPinned = nativePrefs.alwaysOnTop ?? false;
    activeCaptureHotkey = readStoredHotkey(nativePrefs.captureHotkey, activeCaptureHotkey);
    activeOcrClipboardHotkey = readStoredHotkey(nativePrefs.ocrClipboardHotkey, activeOcrClipboardHotkey);
    activeFullCaptureHotkey = readStoredHotkey(nativePrefs.fullCaptureHotkey, activeFullCaptureHotkey);
    activeActiveWindowCaptureHotkey = readStoredHotkey(nativePrefs.activeWindowCaptureHotkey, activeActiveWindowCaptureHotkey);
    activeCopyHotkey = readStoredHotkey(nativePrefs.copyPlayHotkey, activeCopyHotkey);
    activeAutoReaderHotkey = readStoredHotkey(nativePrefs.autoReaderHotkey, activeAutoReaderHotkey);
    autoReaderAdvanceHotkey = readStoredHotkey(nativePrefs.autoReaderAdvanceHotkey, autoReaderAdvanceHotkey);
    autoReaderAdvanceDelayMs = isValidAutoReaderDelay(nativePrefs.autoReaderAdvanceDelayMs)
      ? nativePrefs.autoReaderAdvanceDelayMs
      : autoReaderAdvanceDelayMs;
    autoReaderNoTextRetryCount = isValidAutoReaderNoTextRetryCount(nativePrefs.autoReaderNoTextRetryCount)
      ? nativePrefs.autoReaderNoTextRetryCount
      : autoReaderNoTextRetryCount;
    activeClipboardWatcherHotkey = readStoredHotkey(nativePrefs.clipboardWatcherHotkey, activeClipboardWatcherHotkey);
    clipboardWatcherEnabled = nativePrefs.clipboardWatcherEnabled ?? clipboardWatcherEnabled;
    activeAbortHotkey = readStoredHotkey(nativePrefs.abortHotkey, activeAbortHotkey);
    activePlaybackToggleHotkey = readStoredHotkey(nativePrefs.playPauseHotkey, activePlaybackToggleHotkey);
    activePlaybackNextHotkey = readStoredHotkey(nativePrefs.nextChunkHotkey, activePlaybackNextHotkey);
    activePlaybackPreviousHotkey = readStoredHotkey(nativePrefs.previousChunkHotkey, activePlaybackPreviousHotkey);
    activeVolumeUpHotkey = readStoredHotkey(nativePrefs.volumeUpHotkey, activeVolumeUpHotkey);
    activeVolumeDownHotkey = readStoredHotkey(nativePrefs.volumeDownHotkey, activeVolumeDownHotkey);
    activeReplayCaptureHotkey = readStoredHotkey(nativePrefs.replayCaptureHotkey, activeReplayCaptureHotkey);
    activeTheme = isUiTheme(nativePrefs.theme) ? nativePrefs.theme : "zen";
    lastSavedCaptureRect = isValidStoredRect(nativePrefs.lastCaptureRect) ? nativePrefs.lastCaptureRect : null;
    drawSelectionRectangle = nativePrefs.captureDrawRectangle ?? drawSelectionRectangle;
    diag("app.native-prefs.loaded", {
      isPinned,
      activeCaptureHotkey,
      activeOcrClipboardHotkey,
      activeFullCaptureHotkey,
      activeActiveWindowCaptureHotkey,
      activeCopyHotkey,
      activeAutoReaderHotkey,
      autoReaderAdvanceHotkey,
      autoReaderAdvanceDelayMs,
      autoReaderNoTextRetryCount,
      activeClipboardWatcherHotkey,
      clipboardWatcherEnabled,
      activeAbortHotkey,
      activePlaybackToggleHotkey,
      activePlaybackNextHotkey,
      activePlaybackPreviousHotkey,
      activeVolumeUpHotkey,
      activeVolumeDownHotkey,
      activeReplayCaptureHotkey,
      activeTheme,
      lastSavedCaptureRect,
      drawSelectionRectangle
    });
    diag("app.main-window.create.begin");
    mainWindow = createMainWindow();
    diag("app.main-window.create.end", { hasWindow: Boolean(mainWindow) });
    overlay = new BorderOverlay({
      thickness: 2,
      ...getOverlayThemeColors(activeTheme)
    });
    diag("app.overlay.created");
    applyOverlayTheme(activeTheme);
    diag("app.capture-session.create.begin", { hotkey: activeCaptureHotkey });
    captureHotkeySession = new HotkeySession({
      initialHotkey: activeCaptureHotkey,
      events: {
        onHotkeyRegistered: (label) => diag("capture.hotkey.registered", { label }),
        onHotkeySwitched: (label) => diag("capture.hotkey.switched", { label }),
        onTriggerDown: (point) => startSelection(point, "editor", captureHotkeySession, "capture"),
        onTriggerUp: (point) => {
          void finalizeSelection(point);
        }
      }
    });
    diag("app.capture-session.create.end");
    diag("app.capture-ocr-clipboard-session.create.begin", { hotkey: activeOcrClipboardHotkey });
    ocrClipboardHotkeySession = new HotkeySession({
      initialHotkey: activeOcrClipboardHotkey,
      events: {
        onHotkeyRegistered: (label) => diag("capture.ocr-clipboard.hotkey.registered", { label }),
        onHotkeySwitched: (label) => diag("capture.ocr-clipboard.hotkey.switched", { label }),
        onTriggerDown: (point) => startSelection(point, "clipboard", ocrClipboardHotkeySession, "ocrClipboard"),
        onTriggerUp: (point) => {
          void finalizeSelection(point);
        }
      }
    });
    diag("app.capture-ocr-clipboard-session.create.end");
    diag("app.fullscreen-capture-session.create.begin", { hotkey: activeFullCaptureHotkey });
    fullCaptureHotkeySession = new HotkeySession({
      initialHotkey: activeFullCaptureHotkey,
      events: {
        onHotkeyRegistered: (label) => diag("capture.fullscreen.hotkey.registered", { label }),
        onHotkeySwitched: (label) => diag("capture.fullscreen.hotkey.switched", { label }),
        onTriggerUp: (point) => {
          void captureFullScreenAtPoint(point);
        }
      }
    });
    diag("app.fullscreen-capture-session.create.end");
    diag("app.window-capture-session.create.begin", { hotkey: activeActiveWindowCaptureHotkey });
    activeWindowCaptureHotkeySession = new HotkeySession({
      initialHotkey: activeActiveWindowCaptureHotkey,
      events: {
        onHotkeyRegistered: (label) => diag("capture.window.hotkey.registered", { label }),
        onHotkeySwitched: (label) => diag("capture.window.hotkey.switched", { label }),
        onTriggerUp: () => {
          void captureActiveWindow();
        }
      }
    });
    diag("app.window-capture-session.create.end");
    diag("app.copy-session.create.begin", { hotkey: activeCopyHotkey });
    copyHotkeySession = new HotkeySession({
      initialHotkey: activeCopyHotkey,
      events: {
        onHotkeyRegistered: (label) => diag("copy.hotkey.registered", { label }),
        onHotkeySwitched: (label) => diag("copy.hotkey.switched", { label }),
        onTriggerUp: () => {
          void runCopyPlayCapture();
        }
      }
    });
    diag("app.copy-session.create.end");
    diag("app.auto-reader-session.create.begin", { hotkey: activeAutoReaderHotkey });
    autoReaderHotkeySession = new HotkeySession({
      initialHotkey: activeAutoReaderHotkey,
      events: {
        onHotkeyRegistered: (label) => diag("auto.reader.hotkey.registered", { label }),
        onHotkeySwitched: (label) => diag("auto.reader.hotkey.switched", { label }),
        onTriggerUp: () => {
          if (autoReaderState === "idle") {
            void beginAutoReaderRun();
            return;
          }
          stopAutoReader("Automatic reader stopped.");
        }
      }
    });
    diag("app.auto-reader-session.create.end");
    diag("app.clipboard-watch-session.create.begin", { hotkey: activeClipboardWatcherHotkey, enabled: clipboardWatcherEnabled });
    clipboardWatcherHotkeySession = new HotkeySession({
      initialHotkey: activeClipboardWatcherHotkey,
      events: {
        onHotkeyRegistered: (label) => diag("clipboard.watcher.hotkey.registered", { label }),
        onHotkeySwitched: (label) => diag("clipboard.watcher.hotkey.switched", { label }),
        onTriggerUp: () => {
          setClipboardWatcherEnabledState(!clipboardWatcherEnabled, { source: "hotkey", emitFeedback: true });
        }
      }
    });
    diag("app.clipboard-watch-session.create.end");
    diag("app.replay-capture-session.create.begin", { hotkey: activeReplayCaptureHotkey });
    replayCaptureHotkeySession = new HotkeySession({
      initialHotkey: activeReplayCaptureHotkey,
      events: {
        onHotkeyRegistered: (label) => diag("capture.replay.hotkey.registered", { label }),
        onHotkeySwitched: (label) => diag("capture.replay.hotkey.switched", { label }),
        onTriggerUp: () => {
          void replayLastCaptureRect();
        }
      }
    });
    diag("app.replay-capture-session.create.end");
    diag("app.abort-session.create.begin", { hotkey: activeAbortHotkey });
    abortHotkeySession = new HotkeySession({
      initialHotkey: activeAbortHotkey,
      events: {
        onHotkeyRegistered: (label) => diag("abort.hotkey.registered", { label }),
        onHotkeySwitched: (label) => diag("abort.hotkey.switched", { label }),
        onTriggerUp: () => {
          mainWindow?.webContents.send("abort-requested");
          diag("abort.hotkey.triggered");
        }
      }
    });
    diag("app.abort-session.create.end");
    diag("app.playback-toggle-session.create.begin", { hotkey: activePlaybackToggleHotkey });
    playbackToggleHotkeySession = new HotkeySession({
      initialHotkey: activePlaybackToggleHotkey,
      events: {
        onHotkeyRegistered: (label) => diag("playback.toggle.hotkey.registered", { label }),
        onHotkeySwitched: (label) => diag("playback.toggle.hotkey.switched", { label }),
        onTriggerUp: () => emitPlaybackHotkey("toggle_play_pause")
      }
    });
    diag("app.playback-toggle-session.create.end");
    diag("app.playback-next-session.create.begin", { hotkey: activePlaybackNextHotkey });
    playbackNextHotkeySession = new HotkeySession({
      initialHotkey: activePlaybackNextHotkey,
      events: {
        onHotkeyRegistered: (label) => diag("playback.next.hotkey.registered", { label }),
        onHotkeySwitched: (label) => diag("playback.next.hotkey.switched", { label }),
        onTriggerUp: () => emitPlaybackHotkey("next_chunk")
      }
    });
    diag("app.playback-next-session.create.end");
    diag("app.playback-previous-session.create.begin", { hotkey: activePlaybackPreviousHotkey });
    playbackPreviousHotkeySession = new HotkeySession({
      initialHotkey: activePlaybackPreviousHotkey,
      events: {
        onHotkeyRegistered: (label) => diag("playback.previous.hotkey.registered", { label }),
        onHotkeySwitched: (label) => diag("playback.previous.hotkey.switched", { label }),
        onTriggerUp: () => emitPlaybackHotkey("previous_chunk")
      }
    });
    diag("app.playback-previous-session.create.end");
    diag("app.volume-up-session.create.begin", { hotkey: activeVolumeUpHotkey });
    volumeUpHotkeySession = new HotkeySession({
      initialHotkey: activeVolumeUpHotkey,
      events: {
        onHotkeyRegistered: (label) => diag("volume.up.hotkey.registered", { label }),
        onHotkeySwitched: (label) => diag("volume.up.hotkey.switched", { label }),
        onTriggerUp: () => emitPlaybackHotkey("volume_up")
      }
    });
    diag("app.volume-up-session.create.end");
    diag("app.volume-down-session.create.begin", { hotkey: activeVolumeDownHotkey });
    volumeDownHotkeySession = new HotkeySession({
      initialHotkey: activeVolumeDownHotkey,
      events: {
        onHotkeyRegistered: (label) => diag("volume.down.hotkey.registered", { label }),
        onHotkeySwitched: (label) => diag("volume.down.hotkey.switched", { label }),
        onTriggerUp: () => emitPlaybackHotkey("volume_down")
      }
    });
    diag("app.volume-down-session.create.end");
    diag("app.capture-session.start.begin");
    captureHotkeySession.start();
    diag("app.capture-session.start.end");
    diag("app.capture-ocr-clipboard-session.start.begin");
    ocrClipboardHotkeySession.start();
    diag("app.capture-ocr-clipboard-session.start.end");
    diag("app.fullscreen-capture-session.start.begin");
    fullCaptureHotkeySession.start();
    diag("app.fullscreen-capture-session.start.end");
    diag("app.window-capture-session.start.begin");
    activeWindowCaptureHotkeySession.start();
    diag("app.window-capture-session.start.end");
    diag("app.copy-session.start.begin");
    copyHotkeySession.start();
    diag("app.copy-session.start.end");
    diag("app.auto-reader-session.start.begin");
    autoReaderHotkeySession.start();
    diag("app.auto-reader-session.start.end");
    diag("app.clipboard-watch-session.start.begin");
    clipboardWatcherHotkeySession.start();
    diag("app.clipboard-watch-session.start.end");
    diag("app.replay-capture-session.start.begin");
    replayCaptureHotkeySession.start();
    diag("app.replay-capture-session.start.end");
    diag("app.abort-session.start.begin");
    abortHotkeySession.start();
    diag("app.abort-session.start.end");
    diag("app.playback-toggle-session.start.begin");
    playbackToggleHotkeySession.start();
    diag("app.playback-toggle-session.start.end");
    diag("app.playback-next-session.start.begin");
    playbackNextHotkeySession.start();
    diag("app.playback-next-session.start.end");
    diag("app.playback-previous-session.start.begin");
    playbackPreviousHotkeySession.start();
    diag("app.playback-previous-session.start.end");
    diag("app.volume-up-session.start.begin");
    volumeUpHotkeySession.start();
    diag("app.volume-up-session.start.end");
    diag("app.volume-down-session.start.begin");
    volumeDownHotkeySession.start();
    diag("app.volume-down-session.start.end");
    diag("app.selection-ticker.start.begin");
    startSelectionTicker();
    diag("app.selection-ticker.start.end");
    if (clipboardWatcherEnabled) {
      setClipboardWatcherEnabledState(true, { source: "startup", emitState: false });
    }

    app.on("activate", () => {
      if (appCloseInFlight) {
        diag("app.activate.ignored", { reason: "close-in-flight" });
        return;
      }
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createMainWindow();
        return;
      }
      focusMainWindow(mainWindow);
    });
  });
}

app.on("before-quit", (_event) => {
  diag("app.before-quit");
});

ipcMain.handle("capture:begin-hotkey-edit", () => {
  return beginEditableHotkey(
    captureHotkeySession,
    activeCaptureHotkey,
    (value) => { captureHotkeyBeforeEdit = value; },
    "capture.hotkey.edit.begin"
  );
});

ipcMain.handle("capture:apply-hotkey", (_event, hotkey: string) => {
  return applyEditableHotkey(
    captureHotkeySession,
    hotkey,
    "capture",
    (value) => ({ captureHotkey: value }),
    (value) => { activeCaptureHotkey = value; },
    (value) => { captureHotkeyBeforeEdit = value; },
    "capture.hotkey.edit.applied",
    activeCaptureHotkey
  );
});

ipcMain.handle("capture:clear-hotkey", () => {
  return clearEditableHotkey(
    captureHotkeySession,
    (value) => ({ captureHotkey: value }),
    (value) => { activeCaptureHotkey = value; },
    (value) => { captureHotkeyBeforeEdit = value; },
    "capture.hotkey.edit.cleared",
    activeCaptureHotkey
  );
});

ipcMain.handle("capture:cancel-hotkey-edit", () => {
  return cancelEditableHotkey(
    captureHotkeySession,
    captureHotkeyBeforeEdit,
    (value) => { activeCaptureHotkey = value; },
    (value) => { captureHotkeyBeforeEdit = value; },
    "capture.hotkey.edit.cancelled",
    activeCaptureHotkey
  );
});

ipcMain.handle("capture:get-hotkey", () => {
  return getEditableHotkey(captureHotkeySession, activeCaptureHotkey, (value) => { activeCaptureHotkey = value; });
});

ipcMain.handle("capture-ocr-clipboard:begin-hotkey-edit", () => {
  return beginEditableHotkey(
    ocrClipboardHotkeySession,
    activeOcrClipboardHotkey,
    (value) => { ocrClipboardHotkeyBeforeEdit = value; },
    "capture.ocr-clipboard.hotkey.edit.begin"
  );
});

ipcMain.handle("capture-ocr-clipboard:apply-hotkey", (_event, hotkey: string) => {
  return applyEditableHotkey(
    ocrClipboardHotkeySession,
    hotkey,
    "ocr to clipboard",
    (value) => ({ ocrClipboardHotkey: value }),
    (value) => { activeOcrClipboardHotkey = value; },
    (value) => { ocrClipboardHotkeyBeforeEdit = value; },
    "capture.ocr-clipboard.hotkey.edit.applied",
    activeOcrClipboardHotkey
  );
});

ipcMain.handle("capture-ocr-clipboard:clear-hotkey", () => {
  return clearEditableHotkey(
    ocrClipboardHotkeySession,
    (value) => ({ ocrClipboardHotkey: value }),
    (value) => { activeOcrClipboardHotkey = value; },
    (value) => { ocrClipboardHotkeyBeforeEdit = value; },
    "capture.ocr-clipboard.hotkey.edit.cleared",
    activeOcrClipboardHotkey
  );
});

ipcMain.handle("capture-ocr-clipboard:cancel-hotkey-edit", () => {
  return cancelEditableHotkey(
    ocrClipboardHotkeySession,
    ocrClipboardHotkeyBeforeEdit,
    (value) => { activeOcrClipboardHotkey = value; },
    (value) => { ocrClipboardHotkeyBeforeEdit = value; },
    "capture.ocr-clipboard.hotkey.edit.cancelled",
    activeOcrClipboardHotkey
  );
});

ipcMain.handle("capture-ocr-clipboard:get-hotkey", () => {
  return getEditableHotkey(ocrClipboardHotkeySession, activeOcrClipboardHotkey, (value) => { activeOcrClipboardHotkey = value; });
});

ipcMain.handle("capture-fullscreen:begin-hotkey-edit", () => {
  return beginEditableHotkey(
    fullCaptureHotkeySession,
    activeFullCaptureHotkey,
    (value) => { fullCaptureHotkeyBeforeEdit = value; },
    "capture.fullscreen.hotkey.edit.begin"
  );
});

ipcMain.handle("capture-fullscreen:apply-hotkey", (_event, hotkey: string) => {
  return applyEditableHotkey(
    fullCaptureHotkeySession,
    hotkey,
    "full screen capture",
    (value) => ({ fullCaptureHotkey: value }),
    (value) => { activeFullCaptureHotkey = value; },
    (value) => { fullCaptureHotkeyBeforeEdit = value; },
    "capture.fullscreen.hotkey.edit.applied",
    activeFullCaptureHotkey
  );
});

ipcMain.handle("capture-fullscreen:clear-hotkey", () => {
  return clearEditableHotkey(
    fullCaptureHotkeySession,
    (value) => ({ fullCaptureHotkey: value }),
    (value) => { activeFullCaptureHotkey = value; },
    (value) => { fullCaptureHotkeyBeforeEdit = value; },
    "capture.fullscreen.hotkey.edit.cleared",
    activeFullCaptureHotkey
  );
});

ipcMain.handle("capture-fullscreen:cancel-hotkey-edit", () => {
  return cancelEditableHotkey(
    fullCaptureHotkeySession,
    fullCaptureHotkeyBeforeEdit,
    (value) => { activeFullCaptureHotkey = value; },
    (value) => { fullCaptureHotkeyBeforeEdit = value; },
    "capture.fullscreen.hotkey.edit.cancelled",
    activeFullCaptureHotkey
  );
});

ipcMain.handle("capture-fullscreen:get-hotkey", () => {
  return getEditableHotkey(fullCaptureHotkeySession, activeFullCaptureHotkey, (value) => { activeFullCaptureHotkey = value; });
});

ipcMain.handle("capture-window:begin-hotkey-edit", () => {
  return beginEditableHotkey(
    activeWindowCaptureHotkeySession,
    activeActiveWindowCaptureHotkey,
    (value) => { activeWindowCaptureHotkeyBeforeEdit = value; },
    "capture.window.hotkey.edit.begin"
  );
});

ipcMain.handle("capture-window:apply-hotkey", (_event, hotkey: string) => {
  return applyEditableHotkey(
    activeWindowCaptureHotkeySession,
    hotkey,
    "active window capture",
    (value) => ({ activeWindowCaptureHotkey: value }),
    (value) => { activeActiveWindowCaptureHotkey = value; },
    (value) => { activeWindowCaptureHotkeyBeforeEdit = value; },
    "capture.window.hotkey.edit.applied",
    activeActiveWindowCaptureHotkey
  );
});

ipcMain.handle("capture-window:clear-hotkey", () => {
  return clearEditableHotkey(
    activeWindowCaptureHotkeySession,
    (value) => ({ activeWindowCaptureHotkey: value }),
    (value) => { activeActiveWindowCaptureHotkey = value; },
    (value) => { activeWindowCaptureHotkeyBeforeEdit = value; },
    "capture.window.hotkey.edit.cleared",
    activeActiveWindowCaptureHotkey
  );
});

ipcMain.handle("capture-window:cancel-hotkey-edit", () => {
  return cancelEditableHotkey(
    activeWindowCaptureHotkeySession,
    activeWindowCaptureHotkeyBeforeEdit,
    (value) => { activeActiveWindowCaptureHotkey = value; },
    (value) => { activeWindowCaptureHotkeyBeforeEdit = value; },
    "capture.window.hotkey.edit.cancelled",
    activeActiveWindowCaptureHotkey
  );
});

ipcMain.handle("capture-window:get-hotkey", () => {
  return getEditableHotkey(activeWindowCaptureHotkeySession, activeActiveWindowCaptureHotkey, (value) => {
    activeActiveWindowCaptureHotkey = value;
  });
});

ipcMain.handle("copy:begin-hotkey-edit", () => {
  return beginEditableHotkey(
    copyHotkeySession,
    activeCopyHotkey,
    (value) => { copyHotkeyBeforeEdit = value; },
    "copy.hotkey.edit.begin"
  );
});

ipcMain.handle("copy:apply-hotkey", (_event, hotkey: string) => {
  return applyEditableHotkey(
    copyHotkeySession,
    hotkey,
    "copy & play",
    (value) => ({ copyPlayHotkey: value }),
    (value) => { activeCopyHotkey = value; },
    (value) => { copyHotkeyBeforeEdit = value; },
    "copy.hotkey.edit.applied",
    activeCopyHotkey
  );
});

ipcMain.handle("copy:clear-hotkey", () => {
  return clearEditableHotkey(
    copyHotkeySession,
    (value) => ({ copyPlayHotkey: value }),
    (value) => { activeCopyHotkey = value; },
    (value) => { copyHotkeyBeforeEdit = value; },
    "copy.hotkey.edit.cleared",
    activeCopyHotkey
  );
});

ipcMain.handle("copy:cancel-hotkey-edit", () => {
  return cancelEditableHotkey(
    copyHotkeySession,
    copyHotkeyBeforeEdit,
    (value) => { activeCopyHotkey = value; },
    (value) => { copyHotkeyBeforeEdit = value; },
    "copy.hotkey.edit.cancelled",
    activeCopyHotkey
  );
});

ipcMain.handle("copy:get-hotkey", () => {
  return getEditableHotkey(copyHotkeySession, activeCopyHotkey, (value) => { activeCopyHotkey = value; });
});

ipcMain.handle("auto-reader:begin-hotkey-edit", () => {
  return beginEditableHotkey(
    autoReaderHotkeySession,
    activeAutoReaderHotkey,
    (value) => { autoReaderHotkeyBeforeEdit = value; },
    "auto.reader.hotkey.edit.begin"
  );
});

ipcMain.handle("auto-reader:apply-hotkey", (_event, hotkey: string) => {
  return applyEditableHotkey(
    autoReaderHotkeySession,
    hotkey,
    "automatic reader",
    (value) => ({ autoReaderHotkey: value }),
    (value) => { activeAutoReaderHotkey = value; },
    (value) => { autoReaderHotkeyBeforeEdit = value; },
    "auto.reader.hotkey.edit.applied",
    activeAutoReaderHotkey
  );
});

ipcMain.handle("auto-reader:clear-hotkey", () => {
  return clearEditableHotkey(
    autoReaderHotkeySession,
    (value) => ({ autoReaderHotkey: value }),
    (value) => { activeAutoReaderHotkey = value; },
    (value) => { autoReaderHotkeyBeforeEdit = value; },
    "auto.reader.hotkey.edit.cleared",
    activeAutoReaderHotkey
  );
});

ipcMain.handle("auto-reader:cancel-hotkey-edit", () => {
  return cancelEditableHotkey(
    autoReaderHotkeySession,
    autoReaderHotkeyBeforeEdit,
    (value) => { activeAutoReaderHotkey = value; },
    (value) => { autoReaderHotkeyBeforeEdit = value; },
    "auto.reader.hotkey.edit.cancelled",
    activeAutoReaderHotkey
  );
});

ipcMain.handle("auto-reader:get-hotkey", () => {
  return getEditableHotkey(autoReaderHotkeySession, activeAutoReaderHotkey, (value) => { activeAutoReaderHotkey = value; });
});

ipcMain.handle("clipboard-watcher:begin-hotkey-edit", () => {
  return beginEditableHotkey(
    clipboardWatcherHotkeySession,
    activeClipboardWatcherHotkey,
    (value) => { clipboardWatcherHotkeyBeforeEdit = value; },
    "clipboard.watcher.hotkey.edit.begin"
  );
});

ipcMain.handle("clipboard-watcher:apply-hotkey", (_event, hotkey: string) => {
  return applyEditableHotkey(
    clipboardWatcherHotkeySession,
    hotkey,
    "clipboard watch toggle",
    (value) => ({ clipboardWatcherHotkey: value }),
    (value) => { activeClipboardWatcherHotkey = value; },
    (value) => { clipboardWatcherHotkeyBeforeEdit = value; },
    "clipboard.watcher.hotkey.edit.applied",
    activeClipboardWatcherHotkey
  );
});

ipcMain.handle("clipboard-watcher:clear-hotkey", () => {
  return clearEditableHotkey(
    clipboardWatcherHotkeySession,
    (value) => ({ clipboardWatcherHotkey: value }),
    (value) => { activeClipboardWatcherHotkey = value; },
    (value) => { clipboardWatcherHotkeyBeforeEdit = value; },
    "clipboard.watcher.hotkey.edit.cleared",
    activeClipboardWatcherHotkey
  );
});

ipcMain.handle("clipboard-watcher:cancel-hotkey-edit", () => {
  return cancelEditableHotkey(
    clipboardWatcherHotkeySession,
    clipboardWatcherHotkeyBeforeEdit,
    (value) => { activeClipboardWatcherHotkey = value; },
    (value) => { clipboardWatcherHotkeyBeforeEdit = value; },
    "clipboard.watcher.hotkey.edit.cancelled",
    activeClipboardWatcherHotkey
  );
});

ipcMain.handle("clipboard-watcher:get-hotkey", () => {
  return getEditableHotkey(clipboardWatcherHotkeySession, activeClipboardWatcherHotkey, (value) => {
    activeClipboardWatcherHotkey = value;
  });
});

ipcMain.handle("abort:begin-hotkey-edit", () => {
  return beginEditableHotkey(
    abortHotkeySession,
    activeAbortHotkey,
    (value) => { abortHotkeyBeforeEdit = value; },
    "abort.hotkey.edit.begin"
  );
});

ipcMain.handle("abort:apply-hotkey", (_event, hotkey: string) => {
  return applyEditableHotkey(
    abortHotkeySession,
    hotkey,
    "abort",
    (value) => ({ abortHotkey: value }),
    (value) => { activeAbortHotkey = value; },
    (value) => { abortHotkeyBeforeEdit = value; },
    "abort.hotkey.edit.applied",
    activeAbortHotkey
  );
});

ipcMain.handle("abort:clear-hotkey", () => {
  return clearEditableHotkey(
    abortHotkeySession,
    (value) => ({ abortHotkey: value }),
    (value) => { activeAbortHotkey = value; },
    (value) => { abortHotkeyBeforeEdit = value; },
    "abort.hotkey.edit.cleared",
    activeAbortHotkey
  );
});

ipcMain.handle("abort:cancel-hotkey-edit", () => {
  return cancelEditableHotkey(
    abortHotkeySession,
    abortHotkeyBeforeEdit,
    (value) => { activeAbortHotkey = value; },
    (value) => { abortHotkeyBeforeEdit = value; },
    "abort.hotkey.edit.cancelled",
    activeAbortHotkey
  );
});

ipcMain.handle("abort:get-hotkey", () => {
  return getEditableHotkey(abortHotkeySession, activeAbortHotkey, (value) => { activeAbortHotkey = value; });
});

ipcMain.handle("playback-toggle:begin-hotkey-edit", () => {
  return beginEditableHotkey(
    playbackToggleHotkeySession,
    activePlaybackToggleHotkey,
    (value) => { playbackToggleHotkeyBeforeEdit = value; },
    "playback.toggle.hotkey.edit.begin"
  );
});

ipcMain.handle("playback-toggle:apply-hotkey", (_event, hotkey: string) => {
  return applyEditableHotkey(
    playbackToggleHotkeySession,
    hotkey,
    "play/pause",
    (value) => ({ playPauseHotkey: value }),
    (value) => { activePlaybackToggleHotkey = value; },
    (value) => { playbackToggleHotkeyBeforeEdit = value; },
    "playback.toggle.hotkey.edit.applied",
    activePlaybackToggleHotkey
  );
});

ipcMain.handle("playback-toggle:clear-hotkey", () => {
  return clearEditableHotkey(
    playbackToggleHotkeySession,
    (value) => ({ playPauseHotkey: value }),
    (value) => { activePlaybackToggleHotkey = value; },
    (value) => { playbackToggleHotkeyBeforeEdit = value; },
    "playback.toggle.hotkey.edit.cleared",
    activePlaybackToggleHotkey
  );
});

ipcMain.handle("playback-toggle:cancel-hotkey-edit", () => {
  return cancelEditableHotkey(
    playbackToggleHotkeySession,
    playbackToggleHotkeyBeforeEdit,
    (value) => { activePlaybackToggleHotkey = value; },
    (value) => { playbackToggleHotkeyBeforeEdit = value; },
    "playback.toggle.hotkey.edit.cancelled",
    activePlaybackToggleHotkey
  );
});

ipcMain.handle("playback-toggle:get-hotkey", () => {
  return getEditableHotkey(playbackToggleHotkeySession, activePlaybackToggleHotkey, (value) => { activePlaybackToggleHotkey = value; });
});

ipcMain.handle("playback-next:begin-hotkey-edit", () => {
  return beginEditableHotkey(
    playbackNextHotkeySession,
    activePlaybackNextHotkey,
    (value) => { playbackNextHotkeyBeforeEdit = value; },
    "playback.next.hotkey.edit.begin"
  );
});

ipcMain.handle("playback-next:apply-hotkey", (_event, hotkey: string) => {
  return applyEditableHotkey(
    playbackNextHotkeySession,
    hotkey,
    "next chunk",
    (value) => ({ nextChunkHotkey: value }),
    (value) => { activePlaybackNextHotkey = value; },
    (value) => { playbackNextHotkeyBeforeEdit = value; },
    "playback.next.hotkey.edit.applied",
    activePlaybackNextHotkey
  );
});

ipcMain.handle("playback-next:clear-hotkey", () => {
  return clearEditableHotkey(
    playbackNextHotkeySession,
    (value) => ({ nextChunkHotkey: value }),
    (value) => { activePlaybackNextHotkey = value; },
    (value) => { playbackNextHotkeyBeforeEdit = value; },
    "playback.next.hotkey.edit.cleared",
    activePlaybackNextHotkey
  );
});

ipcMain.handle("playback-next:cancel-hotkey-edit", () => {
  return cancelEditableHotkey(
    playbackNextHotkeySession,
    playbackNextHotkeyBeforeEdit,
    (value) => { activePlaybackNextHotkey = value; },
    (value) => { playbackNextHotkeyBeforeEdit = value; },
    "playback.next.hotkey.edit.cancelled",
    activePlaybackNextHotkey
  );
});

ipcMain.handle("playback-next:get-hotkey", () => {
  return getEditableHotkey(playbackNextHotkeySession, activePlaybackNextHotkey, (value) => { activePlaybackNextHotkey = value; });
});

ipcMain.handle("playback-previous:begin-hotkey-edit", () => {
  return beginEditableHotkey(
    playbackPreviousHotkeySession,
    activePlaybackPreviousHotkey,
    (value) => { playbackPreviousHotkeyBeforeEdit = value; },
    "playback.previous.hotkey.edit.begin"
  );
});

ipcMain.handle("playback-previous:apply-hotkey", (_event, hotkey: string) => {
  return applyEditableHotkey(
    playbackPreviousHotkeySession,
    hotkey,
    "previous chunk",
    (value) => ({ previousChunkHotkey: value }),
    (value) => { activePlaybackPreviousHotkey = value; },
    (value) => { playbackPreviousHotkeyBeforeEdit = value; },
    "playback.previous.hotkey.edit.applied",
    activePlaybackPreviousHotkey
  );
});

ipcMain.handle("playback-previous:clear-hotkey", () => {
  return clearEditableHotkey(
    playbackPreviousHotkeySession,
    (value) => ({ previousChunkHotkey: value }),
    (value) => { activePlaybackPreviousHotkey = value; },
    (value) => { playbackPreviousHotkeyBeforeEdit = value; },
    "playback.previous.hotkey.edit.cleared",
    activePlaybackPreviousHotkey
  );
});

ipcMain.handle("playback-previous:cancel-hotkey-edit", () => {
  return cancelEditableHotkey(
    playbackPreviousHotkeySession,
    playbackPreviousHotkeyBeforeEdit,
    (value) => { activePlaybackPreviousHotkey = value; },
    (value) => { playbackPreviousHotkeyBeforeEdit = value; },
    "playback.previous.hotkey.edit.cancelled",
    activePlaybackPreviousHotkey
  );
});

ipcMain.handle("playback-previous:get-hotkey", () => {
  return getEditableHotkey(playbackPreviousHotkeySession, activePlaybackPreviousHotkey, (value) => { activePlaybackPreviousHotkey = value; });
});

ipcMain.handle("volume-up:begin-hotkey-edit", () => {
  return beginEditableHotkey(
    volumeUpHotkeySession,
    activeVolumeUpHotkey,
    (value) => { volumeUpHotkeyBeforeEdit = value; },
    "volume.up.hotkey.edit.begin"
  );
});

ipcMain.handle("volume-up:apply-hotkey", (_event, hotkey: string) => {
  return applyEditableHotkey(
    volumeUpHotkeySession,
    hotkey,
    "volume up",
    (value) => ({ volumeUpHotkey: value }),
    (value) => { activeVolumeUpHotkey = value; },
    (value) => { volumeUpHotkeyBeforeEdit = value; },
    "volume.up.hotkey.edit.applied",
    activeVolumeUpHotkey
  );
});

ipcMain.handle("volume-up:clear-hotkey", () => {
  return clearEditableHotkey(
    volumeUpHotkeySession,
    (value) => ({ volumeUpHotkey: value }),
    (value) => { activeVolumeUpHotkey = value; },
    (value) => { volumeUpHotkeyBeforeEdit = value; },
    "volume.up.hotkey.edit.cleared",
    activeVolumeUpHotkey
  );
});

ipcMain.handle("volume-up:cancel-hotkey-edit", () => {
  return cancelEditableHotkey(
    volumeUpHotkeySession,
    volumeUpHotkeyBeforeEdit,
    (value) => { activeVolumeUpHotkey = value; },
    (value) => { volumeUpHotkeyBeforeEdit = value; },
    "volume.up.hotkey.edit.cancelled",
    activeVolumeUpHotkey
  );
});

ipcMain.handle("volume-up:get-hotkey", () => {
  return getEditableHotkey(volumeUpHotkeySession, activeVolumeUpHotkey, (value) => { activeVolumeUpHotkey = value; });
});

ipcMain.handle("volume-down:begin-hotkey-edit", () => {
  return beginEditableHotkey(
    volumeDownHotkeySession,
    activeVolumeDownHotkey,
    (value) => { volumeDownHotkeyBeforeEdit = value; },
    "volume.down.hotkey.edit.begin"
  );
});

ipcMain.handle("volume-down:apply-hotkey", (_event, hotkey: string) => {
  return applyEditableHotkey(
    volumeDownHotkeySession,
    hotkey,
    "volume down",
    (value) => ({ volumeDownHotkey: value }),
    (value) => { activeVolumeDownHotkey = value; },
    (value) => { volumeDownHotkeyBeforeEdit = value; },
    "volume.down.hotkey.edit.applied",
    activeVolumeDownHotkey
  );
});

ipcMain.handle("volume-down:clear-hotkey", () => {
  return clearEditableHotkey(
    volumeDownHotkeySession,
    (value) => ({ volumeDownHotkey: value }),
    (value) => { activeVolumeDownHotkey = value; },
    (value) => { volumeDownHotkeyBeforeEdit = value; },
    "volume.down.hotkey.edit.cleared",
    activeVolumeDownHotkey
  );
});

ipcMain.handle("volume-down:cancel-hotkey-edit", () => {
  return cancelEditableHotkey(
    volumeDownHotkeySession,
    volumeDownHotkeyBeforeEdit,
    (value) => { activeVolumeDownHotkey = value; },
    (value) => { volumeDownHotkeyBeforeEdit = value; },
    "volume.down.hotkey.edit.cancelled",
    activeVolumeDownHotkey
  );
});

ipcMain.handle("volume-down:get-hotkey", () => {
  return getEditableHotkey(volumeDownHotkeySession, activeVolumeDownHotkey, (value) => { activeVolumeDownHotkey = value; });
});

ipcMain.handle("capture-replay:begin-hotkey-edit", () => {
  return beginEditableHotkey(
    replayCaptureHotkeySession,
    activeReplayCaptureHotkey,
    (value) => { replayCaptureHotkeyBeforeEdit = value; },
    "capture.replay.hotkey.edit.begin"
  );
});

ipcMain.handle("capture-replay:apply-hotkey", (_event, hotkey: string) => {
  return applyEditableHotkey(
    replayCaptureHotkeySession,
    hotkey,
    "replay capture",
    (value) => ({ replayCaptureHotkey: value }),
    (value) => { activeReplayCaptureHotkey = value; },
    (value) => { replayCaptureHotkeyBeforeEdit = value; },
    "capture.replay.hotkey.edit.applied",
    activeReplayCaptureHotkey
  );
});

ipcMain.handle("capture-replay:clear-hotkey", () => {
  return clearEditableHotkey(
    replayCaptureHotkeySession,
    (value) => ({ replayCaptureHotkey: value }),
    (value) => { activeReplayCaptureHotkey = value; },
    (value) => { replayCaptureHotkeyBeforeEdit = value; },
    "capture.replay.hotkey.edit.cleared",
    activeReplayCaptureHotkey
  );
});

ipcMain.handle("capture-replay:cancel-hotkey-edit", () => {
  return cancelEditableHotkey(
    replayCaptureHotkeySession,
    replayCaptureHotkeyBeforeEdit,
    (value) => { activeReplayCaptureHotkey = value; },
    (value) => { replayCaptureHotkeyBeforeEdit = value; },
    "capture.replay.hotkey.edit.cancelled",
    activeReplayCaptureHotkey
  );
});

ipcMain.handle("capture-replay:get-hotkey", () => {
  return getEditableHotkey(replayCaptureHotkeySession, activeReplayCaptureHotkey, (value) => { activeReplayCaptureHotkey = value; });
});

ipcMain.handle("capture:set-draw-rectangle", (_event, enabled: boolean) => {
  drawSelectionRectangle = Boolean(enabled);
  if (!drawSelectionRectangle) {
    overlay?.hide();
  }
  saveNativePrefs({ captureDrawRectangle: drawSelectionRectangle });
  diag("capture.draw-rectangle.changed", { enabled: drawSelectionRectangle });
  return drawSelectionRectangle;
});

ipcMain.handle("capture:get-draw-rectangle", () => drawSelectionRectangle);

ipcMain.handle("overlay-theme:set", (_event, theme: unknown) => {
  if (!isUiTheme(theme)) {
    throw new Error(`Unsupported overlay theme: ${String(theme)}`);
  }
  setOverlayTheme(theme);
});

ipcMain.handle("overlay-theme:get", () => activeTheme);
ipcMain.handle("clipboard:write-text", (_event, text: string) => {
  const normalized = String(text ?? "");
  clipboard.writeText(normalized);
  suppressClipboardWatcherText(normalized);
});
ipcMain.handle("window:get-always-on-top", () => isPinned);
ipcMain.handle("window:set-always-on-top", (_event, enabled: boolean) => setAlwaysOnTopState(enabled));
ipcMain.handle("clipboard-watcher:get-enabled", () => clipboardWatcherEnabled);
ipcMain.handle("clipboard-watcher:set-enabled", (_event, enabled: boolean) => {
  return setClipboardWatcherEnabledState(enabled, { source: "ipc" });
});
ipcMain.handle("auto-reader:set-settings", (_event, settings: { advanceHotkey: string; advanceDelayMs: number; noTextRetryCount: number }) => {
  const normalizedHotkey = String(settings?.advanceHotkey ?? "").trim().toLowerCase();
  if (!normalizedHotkey) {
    throw new Error("Automatic reader advance hotkey is required");
  }
  parseSendSpec(normalizedHotkey);
  if (!isValidAutoReaderDelay(settings?.advanceDelayMs)) {
    throw new Error("Automatic reader delay must be between 0 and 60000 milliseconds");
  }
  if (!isValidAutoReaderNoTextRetryCount(settings?.noTextRetryCount)) {
    throw new Error(`Automatic reader no-text retry count must be between 0 and ${MAX_AUTO_READER_NO_TEXT_RETRY_COUNT}`);
  }
  autoReaderAdvanceHotkey = normalizedHotkey;
  autoReaderAdvanceDelayMs = settings.advanceDelayMs;
  autoReaderNoTextRetryCount = settings.noTextRetryCount;
  saveNativePrefs({
    autoReaderAdvanceHotkey,
    autoReaderAdvanceDelayMs,
    autoReaderNoTextRetryCount
  });
  diag("auto.reader.settings.changed", { autoReaderAdvanceHotkey, autoReaderAdvanceDelayMs, autoReaderNoTextRetryCount });
  return {
    advanceHotkey: autoReaderAdvanceHotkey,
    advanceDelayMs: autoReaderAdvanceDelayMs,
    noTextRetryCount: autoReaderNoTextRetryCount
  };
});
ipcMain.handle("auto-reader:page-result", (_event, result: AutoReaderPageResult) => {
  handleAutoReaderPageResult(result);
});
ipcMain.handle("stack:get-services-status", () => managedServicesStatusSnapshot());
ipcMain.handle("stack:discover-services", async (_event, externalRoot?: string) => discoverManagedServicesSnapshot(externalRoot));
ipcMain.handle("stack:get-discovered-service-statuses", () => discoveredServiceStatusesSnapshot());
ipcMain.handle(
  "stack:launch-discovered-service",
  async (_event, request: { slot: "detect" | "ocr" | "tts"; servicePath: string; presetId: string; externalRoot?: string }) => launchDiscoveredService(request.slot, request.servicePath, request.presetId, request.externalRoot)
);
ipcMain.handle("stack:stop-discovered-service", async (_event, slot: "detect" | "ocr" | "tts") => stopDiscoveredService(slot));
ipcMain.handle("stack:launch-service", async (_event, serviceId: ManagedServiceId) => launchManagedService(serviceId));
ipcMain.handle("stack:stop-service", async (_event, serviceId: ManagedServiceId) => stopManagedService(serviceId));
ipcMain.handle("stack:open-runtime-services", async (_event, configuredRoot?: string) => openRuntimeServicesFolder(configuredRoot));
ipcMain.handle("provider:extract-text", async (_event, request: ProviderOcrRequest) => {
  const controller = createProviderController(request.requestId);
  diag("provider.ocr.request.begin", { requestId: request.requestId, provider: request.provider, model: request.config.model });
  try {
    const result = request.provider === "gemini_sdk"
      ? await geminiSdkLlmService.extractTextFromImage(request.imageDataUrl, request.config)
      : await providerLlmService.extractTextFromImage(request.imageDataUrl, request.config, { signal: controller.signal });
    diag("provider.ocr.request.end", { requestId: request.requestId, textLength: result.text.length });
    return result;
  } catch (error) {
    const message = extractErrorMessage(error);
    diag("provider.ocr.request.failed", { requestId: request.requestId, error: message });
    throw new Error(message);
  } finally {
    finishProviderController(request.requestId);
  }
});
ipcMain.handle("provider:start-ocr-stream", async (_event, request: ProviderOcrRequest) => {
  const controller = createProviderController(request.requestId);
  diag("provider.ocr.stream.begin", { requestId: request.requestId, provider: request.provider, model: request.config.model });
  try {
    const result = request.provider === "gemini_sdk"
      ? await geminiSdkLlmService.extractTextFromImageStream(request.imageDataUrl, request.config, {
          onToken: (token) => {
            sendProviderOcrStreamEvent({ requestId: request.requestId, type: "token", token });
          }
        })
      : await providerLlmService.extractTextFromImageStream(request.imageDataUrl, request.config, {
          signal: controller.signal,
          onToken: (token) => {
            sendProviderOcrStreamEvent({ requestId: request.requestId, type: "token", token });
          }
        });
    sendProviderOcrStreamEvent({ requestId: request.requestId, type: "done", text: result.text });
    diag("provider.ocr.stream.end", { requestId: request.requestId, textLength: result.text.length });
    return result;
  } catch (error) {
    const message = extractErrorMessage(error);
    sendProviderOcrStreamEvent({ requestId: request.requestId, type: "error", error: message });
    diag("provider.ocr.stream.failed", { requestId: request.requestId, error: message });
    throw new Error(message);
  } finally {
    finishProviderController(request.requestId);
  }
});
ipcMain.handle("provider:synthesize-text", async (_event, request: ProviderTtsRequest) => {
  const controller = createProviderController(request.requestId);
  diag("provider.tts.request.begin", { requestId: request.requestId, provider: request.provider, model: request.config.model, voice: request.config.voice });
  try {
    const result = request.provider === "gemini_sdk"
      ? await geminiSdkTtsService.synthesize(request.text, request.config)
      : await providerTtsService.synthesize(
          request.text,
          request.config,
          request.timeoutMs === undefined
            ? { signal: controller.signal }
            : { signal: controller.signal, timeoutMs: request.timeoutMs }
        );
    diag("provider.tts.request.end", { requestId: request.requestId, bytes: result.audioBytes.byteLength });
    return result;
  } catch (error) {
    const message = extractErrorMessage(error);
    diag("provider.tts.request.failed", { requestId: request.requestId, error: message });
    throw new Error(message);
  } finally {
    finishProviderController(request.requestId);
  }
});
ipcMain.handle("provider:fetch-models", async (_event, request: ProviderModelsRequest) => {
  return request.provider === "gemini_sdk"
    ? fetchGeminiModels(request.apiKey, request.kind)
    : fetchProviderModels(request);
});
ipcMain.handle("provider:fetch-voices", async (_event, request: ProviderVoicesRequest) => {
  return request.provider === "gemini_sdk"
    ? fetchGeminiVoices()
    : fetchProviderVoices(request);
});
ipcMain.handle("provider:cancel-request", (_event, requestId: string) => {
  providerAbortControllers.get(requestId)?.abort();
});

ipcMain.on("startup:phase", (_event, payload: { phase?: string; details?: Record<string, unknown> }) => {
  if (!payload?.phase) return;
  noteStartupPhase(payload.phase, payload.details);
});

ipcMain.on("log:write", (_event, entries: unknown[]) => {
  if (!Array.isArray(entries)) return;
  for (const raw of entries) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Partial<BackendLogEntry>;
    const level = entry.level ?? "info";
    const category = entry.category ?? "frontend";
    const message = entry.message ?? "(empty)";
    if (!(["debug", "info", "warn", "error"] as const).includes(level)) continue;
    writeBackendLog(level, category, message, entry.context);
  }
});

ipcMain.handle("log:get-level", () => currentLogLevel);
ipcMain.handle("log:set-level", (_event, level: string) => {
  if ((["debug", "info", "warn", "error"] as const).includes(level as LogLevel)) {
    currentLogLevel = level as LogLevel;
    diag("log.level.changed", { level: currentLogLevel });
  }
});
ipcMain.handle("log:get-path", () => getLogFilePath());
ipcMain.handle("log:clear", () => {
  clearLogs();
  diag("log.cleared");
});

process.on("uncaughtException", (error) => {
  writeBackendLog("error", "electron", "uncaughtException", { error: error.stack ?? String(error) });
});

process.on("unhandledRejection", (reason) => {
  writeBackendLog("error", "electron", "unhandledRejection", { reason: String(reason) });
});

app.on("window-all-closed", () => {
  diag("app.window-all-closed");
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("will-quit", () => {
  diag("app.will-quit.begin");
  clearShutdownWatchdog();
  for (const controller of providerAbortControllers.values()) {
    controller.abort();
  }
  providerAbortControllers.clear();
  for (const entry of Object.values(managedServiceChildren)) {
    if (!entry) continue;
    terminateChildTreeSync(entry.child);
  }
  managedServiceChildren = {};
  for (const entry of discoveredServiceChildren.values()) {
    terminateChildTreeSync(entry.child);
  }
  discoveredServiceChildren.clear();
  for (const [slot, status] of discoveredServiceStatuses.entries()) {
    discoveredServiceStatuses.set(slot, {
      ...status,
      state: "stopped",
      managed: false,
      url: null,
      urls: null,
      error: null
    });
  }
  managedServicesStatus = {
    paddle: { state: "stopped", managed: false, url: null, urls: null, error: null },
    edge: { state: "stopped", managed: false, url: null, urls: null, error: null }
  };
  clearServiceOwnerHeartbeatSession();
  disposeNativeResources();
  diag("app.will-quit.end");
});

ipcMain.handle("ping", () => "pong");

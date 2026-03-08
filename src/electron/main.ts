import { app, BrowserWindow, ipcMain, shell } from "electron";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  beginFrozenMonitorCaptureAtPoint,
  BorderOverlay,
  captureCopyToText,
  cropFrozenCapture,
  disposeFrozenCapture,
  HotkeySession,
  type FrozenCaptureHandle
} from "nodehotkey";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

type LogLevel = "debug" | "info" | "warn" | "error";

interface BackendLogEntry {
  timestamp: string;
  level: LogLevel;
  category: string;
  message: string;
  context?: Record<string, unknown> | undefined;
  source: "frontend" | "backend";
}

interface RecommendedCpuStackUrls {
  detectionBaseUrl: string;
  ocrBaseUrl: string;
  ttsBaseUrl: string;
}

interface RecommendedCpuStackStatus {
  state: "stopped" | "starting" | "running" | "failed";
  managed: boolean;
  urls: RecommendedCpuStackUrls | null;
  error: string | null;
}

interface ManagedStackChild {
  name: "rapid" | "edge";
  child: ChildProcess;
}

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow: BrowserWindow | null = null;
let isPinned = true;
let currentLogLevel: LogLevel = "info";
let captureHotkeySession: HotkeySession | null = null;
let copyHotkeySession: HotkeySession | null = null;
let abortHotkeySession: HotkeySession | null = null;
let playbackToggleHotkeySession: HotkeySession | null = null;
let playbackNextHotkeySession: HotkeySession | null = null;
let playbackPreviousHotkeySession: HotkeySession | null = null;
let volumeUpHotkeySession: HotkeySession | null = null;
let volumeDownHotkeySession: HotkeySession | null = null;
let replayCaptureHotkeySession: HotkeySession | null = null;
let activeCaptureHotkey = "ctrl+shift+alt+s";
let activeCopyHotkey = "ctrl+shift+alt+x";
let activeAbortHotkey = "ctrl+shift+alt+z";
let activePlaybackToggleHotkey = "ctrl+shift+alt+space";
let activePlaybackNextHotkey = "ctrl+shift+alt+right";
let activePlaybackPreviousHotkey = "ctrl+shift+alt+left";
let activeVolumeUpHotkey = "ctrl+shift+alt+up";
let activeVolumeDownHotkey = "ctrl+shift+alt+down";
let activeReplayCaptureHotkey = "ctrl+shift+alt+d";
let captureHotkeyBeforeEdit: string | null = null;
let copyHotkeyBeforeEdit: string | null = null;
let abortHotkeyBeforeEdit: string | null = null;
let playbackToggleHotkeyBeforeEdit: string | null = null;
let playbackNextHotkeyBeforeEdit: string | null = null;
let playbackPreviousHotkeyBeforeEdit: string | null = null;
let volumeUpHotkeyBeforeEdit: string | null = null;
let volumeDownHotkeyBeforeEdit: string | null = null;
let replayCaptureHotkeyBeforeEdit: string | null = null;
let drawSelectionRectangle = true;
let overlay: BorderOverlay | null = null;
let selectionTicker: NodeJS.Timeout | null = null;
let selectionActive = false;
let selectionStart: { x: number; y: number } | null = null;
let lastCursor: { x: number; y: number } | null = null;
let lastRect: { left: number; top: number; right: number; bottom: number } | null = null;
let lastSavedCaptureRect: { left: number; top: number; width: number; height: number } | null = null;
let frozenCaptureSession: Promise<FrozenCaptureHandle> | null = null;
let flashOverlayTimer: NodeJS.Timeout | null = null;
let selectionStartedAt = 0;
let copyPlayInFlight = false;
let appCloseInFlight = false;
let shutdownWatchdog: NodeJS.Timeout | null = null;
let recommendedCpuStackChildren: ManagedStackChild[] = [];
let recommendedCpuStackLaunchPromise: Promise<RecommendedCpuStackStatus> | null = null;
let recommendedCpuStackStatus: RecommendedCpuStackStatus = {
  state: "stopped",
  managed: false,
  urls: null,
  error: null
};
const processStartAt = Date.now();
const startupPhaseBuffer: string[] = [];
let startupWatchdogDomReady: NodeJS.Timeout | null = null;
let startupWatchdogRendererMount: NodeJS.Timeout | null = null;
let startupDomReadySeen = false;
let startupRendererMountSeen = false;

const CAPTURE_TAP_THRESHOLD_MS = 150;
const CAPTURE_TAP_MAX_DRIFT_PX = 6;

function processUptimeMs(): number {
  return Date.now() - processStartAt;
}

function prefsPath(): string {
  return path.join(app.getPath("userData"), "window-prefs.json");
}

interface NativePrefs {
  alwaysOnTop?: boolean;
  captureHotkey?: string;
  copyPlayHotkey?: string;
  captureDrawRectangle?: boolean;
  abortHotkey?: string;
  playPauseHotkey?: string;
  nextChunkHotkey?: string;
  previousChunkHotkey?: string;
  volumeUpHotkey?: string;
  volumeDownHotkey?: string;
  replayCaptureHotkey?: string;
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
  return path.join(getLogDir(), "tts-sniffer.log");
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

function runtimeSyncVersionFile(): string {
  return path.join(app.getPath("userData"), "runtime", ".bundled-services-version");
}

function recommendedCpuStackStatusSnapshot(): RecommendedCpuStackStatus {
  return {
    state: recommendedCpuStackStatus.state,
    managed: recommendedCpuStackStatus.managed,
    urls: recommendedCpuStackStatus.urls ? { ...recommendedCpuStackStatus.urls } : null,
    error: recommendedCpuStackStatus.error
  };
}

function setRecommendedCpuStackStatus(next: Partial<RecommendedCpuStackStatus>): RecommendedCpuStackStatus {
  recommendedCpuStackStatus = {
    ...recommendedCpuStackStatus,
    ...next
  };
  return recommendedCpuStackStatusSnapshot();
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

function runtimeCopyShouldSkipName(name: string): boolean {
  return [
    ".venv",
    ".venv-cpu",
    ".venv-gpu",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    ".cache",
    ".hf-cache",
    ".paddlex-cache"
  ].includes(name);
}

function runtimeCopyShouldSkipFile(name: string): boolean {
  return name.endsWith(".pyc") || name.endsWith(".pyo");
}

function copyBundledServiceTree(sourceDir: string, targetDir: string): void {
  ensureDir(targetDir);
  const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (runtimeCopyShouldSkipName(entry.name)) continue;
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      copyBundledServiceTree(sourcePath, targetPath);
      continue;
    }
    if (!entry.isFile() || runtimeCopyShouldSkipFile(entry.name)) continue;
    ensureDir(path.dirname(targetPath));
    fs.copyFileSync(sourcePath, targetPath);
  }
}

function readRuntimeServicesVersion(): string | null {
  try {
    return fs.readFileSync(runtimeSyncVersionFile(), "utf-8").trim() || null;
  } catch {
    return null;
  }
}

function writeRuntimeServicesVersion(version: string): void {
  ensureDir(path.dirname(runtimeSyncVersionFile()));
  fs.writeFileSync(runtimeSyncVersionFile(), version, "utf-8");
}

function syncBundledServicesToRuntime(): string {
  if (!app.isPackaged) {
    return servicesBasePath();
  }
  const sourceRoot = servicesBasePath();
  const targetRoot = runtimeServicesRoot();
  const currentVersion = app.getVersion();
  if (readRuntimeServicesVersion() === currentVersion && fs.existsSync(targetRoot)) {
    return targetRoot;
  }

  ensureDir(targetRoot);
  const topLevelEntries = fs.readdirSync(sourceRoot, { withFileTypes: true });
  for (const entry of topLevelEntries) {
    if (!entry.isDirectory() || runtimeCopyShouldSkipName(entry.name)) continue;
    copyBundledServiceTree(path.join(sourceRoot, entry.name), path.join(targetRoot, entry.name));
  }
  writeRuntimeServicesVersion(currentVersion);
  writeBackendLog("info", "stack", "runtime.services.synced", {
    version: currentVersion,
    sourceRoot,
    targetRoot
  });
  return targetRoot;
}

function envPythonPath(envDir: string): string {
  if (process.platform === "win32") {
    return path.join(envDir, "Scripts", "python.exe");
  }
  return path.join(envDir, "bin", "python");
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
    recommendedCpuStackChildren = recommendedCpuStackChildren.filter((entry) => entry.child !== child);
    if (recommendedCpuStackStatus.state === "running" && recommendedCpuStackChildren.length === 0) {
      setRecommendedCpuStackStatus({
        state: "stopped",
        managed: false,
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
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  attachManagedChildLogging(name, child);
  recommendedCpuStackChildren.push({ name, child });
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

async function stopRecommendedCpuStack(): Promise<RecommendedCpuStackStatus> {
  recommendedCpuStackLaunchPromise = null;
  const children = [...recommendedCpuStackChildren].reverse();
  recommendedCpuStackChildren = [];
  await Promise.all(children.map(({ child }) => terminateChildTree(child)));
  return setRecommendedCpuStackStatus({
    state: "stopped",
    managed: false,
    urls: null,
    error: null
  });
}

async function openRuntimeServicesFolder(): Promise<string> {
  const target = app.isPackaged ? syncBundledServicesToRuntime() : servicesBasePath();
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
  validate: (payload: Record<string, unknown>) => boolean
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no response";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/healthz`);
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

async function launchRecommendedCpuStackInternal(): Promise<RecommendedCpuStackStatus> {
  if (process.platform !== "win32") {
    throw new Error("Recommended CPU stack launcher is currently Windows-only.");
  }

  const stackRoot = recommendedCpuStackRuntimeRoot();
  const uvCacheDir = path.join(stackRoot, "uv-cache");
  const runtimeServicesDir = syncBundledServicesToRuntime();
  const rapidServiceDir = path.join(runtimeServicesDir, "text_processing", "rapid");
  const edgeServiceDir = path.join(runtimeServicesDir, "tts", "edge");
  const rapidEnvDir = path.join(rapidServiceDir, ".venv");
  const edgeEnvDir = path.join(edgeServiceDir, ".venv");
  if (!fs.existsSync(rapidServiceDir)) {
    throw new Error(`Rapid service directory not found: ${rapidServiceDir}`);
  }
  if (!fs.existsSync(edgeServiceDir)) {
    throw new Error(`Edge service directory not found: ${edgeServiceDir}`);
  }
  ensureDir(uvCacheDir);

  const rapidPort = await resolveAvailablePort(8091);
  const edgePort = await resolveAvailablePort(8012);
  const urls: RecommendedCpuStackUrls = {
    detectionBaseUrl: `http://127.0.0.1:${rapidPort}`,
    ocrBaseUrl: `http://127.0.0.1:${rapidPort}`,
    ttsBaseUrl: `http://127.0.0.1:${edgePort}`
  };

  const baseEnv = windowsEnv(process.env, { UV_CACHE_DIR: uvCacheDir });

  await runManagedCommand(
    "recommendedCpu.rapid.sync",
    preferredUvCommand(),
    ["sync", "--inexact"],
    rapidServiceDir,
    windowsEnv(baseEnv, { UV_PROJECT_ENVIRONMENT: rapidEnvDir })
  );
  await runManagedCommand(
    "recommendedCpu.rapid.runtime",
    preferredUvCommand(),
    ["pip", "install", "--python", envPythonPath(rapidEnvDir), "onnxruntime>=1.24.2"],
    rapidServiceDir,
    windowsEnv(baseEnv, { UV_PROJECT_ENVIRONMENT: rapidEnvDir })
  );

  const rapidChild = spawnManagedChild(
    "rapid",
    envPythonPath(rapidEnvDir),
    [
      "-m",
      "rapid_text_processing.cli",
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      String(rapidPort),
      "--enable-detect",
      "--enable-openai-ocr",
      "--detect-provider",
      "cpu",
      "--ocr-provider",
      "cpu"
    ],
    rapidServiceDir,
    windowsEnv(baseEnv, { UV_PROJECT_ENVIRONMENT: rapidEnvDir })
  );
  writeBackendLog("info", "stack", "recommendedCpu.rapid.started", { pid: rapidChild.pid, port: rapidPort });
  await waitForServiceHealth(
    urls.detectionBaseUrl,
    120000,
    (payload) => payload.ok === true
      && typeof payload.features === "object"
      && payload.features !== null
      && (payload.features as Record<string, unknown>).detect === true
      && (payload.features as Record<string, unknown>).openai_ocr === true
  );

  await runManagedCommand(
    "recommendedCpu.edge.sync",
    preferredUvCommand(),
    ["sync", "--inexact"],
    edgeServiceDir,
    windowsEnv(baseEnv, { UV_PROJECT_ENVIRONMENT: edgeEnvDir })
  );
  const edgeChild = spawnManagedChild(
    "edge",
    envPythonPath(edgeEnvDir),
    ["-m", "tts_edge_adapter.cli", "serve", "--host", "127.0.0.1", "--port", String(edgePort)],
    edgeServiceDir,
    windowsEnv(baseEnv, { UV_PROJECT_ENVIRONMENT: edgeEnvDir })
  );
  writeBackendLog("info", "stack", "recommendedCpu.edge.started", { pid: edgeChild.pid, port: edgePort });
  await waitForServiceHealth(urls.ttsBaseUrl, 60000, (payload) => payload.ok === true);

  return setRecommendedCpuStackStatus({
    state: "running",
    managed: true,
    urls,
    error: null
  });
}

async function launchRecommendedCpuStack(): Promise<RecommendedCpuStackStatus> {
  if (recommendedCpuStackStatus.state === "running") {
    return recommendedCpuStackStatusSnapshot();
  }
  if (recommendedCpuStackLaunchPromise) {
    return recommendedCpuStackLaunchPromise;
  }

  setRecommendedCpuStackStatus({
    state: "starting",
    managed: false,
    urls: null,
    error: null
  });

  recommendedCpuStackLaunchPromise = (async () => {
    try {
      return await launchRecommendedCpuStackInternal();
    } catch (error) {
      await stopRecommendedCpuStack();
      return setRecommendedCpuStackStatus({
        state: "failed",
        managed: false,
        urls: null,
        error: String(error)
      });
    } finally {
      recommendedCpuStackLaunchPromise = null;
    }
  })();

  return recommendedCpuStackLaunchPromise;
}

function loadPinnedPref(): boolean {
  try {
    const raw = fs.readFileSync(prefsPath(), "utf-8");
    const parsed = JSON.parse(raw) as NativePrefs;
    return parsed.alwaysOnTop ?? true;
  } catch {
    return true;
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
  copyHotkeySession?.stop();
  copyHotkeySession = null;
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
  win.setAlwaysOnTop(isPinned, "floating");
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

function movementDistance(start: { x: number; y: number }, end: { x: number; y: number }): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  return Math.hypot(dx, dy);
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

function startSelection(point: { x: number; y: number }): void {
  selectionStart = { x: point.x, y: point.y };
  lastCursor = { x: point.x, y: point.y };
  lastRect = null;
  selectionActive = true;
  selectionStartedAt = Date.now();
  beginFrozenCaptureSession();
  if (drawSelectionRectangle) overlay?.hide();
  diag("capture.start", { x: point.x, y: point.y, hotkey: captureHotkeySession?.getHotkey() });
}

async function finalizeSelection(point: { x: number; y: number }): Promise<void> {
  if (!selectionActive || !selectionStart) {
    selectionActive = false;
    selectionStart = null;
    lastCursor = null;
    lastRect = null;
    selectionStartedAt = 0;
    if (drawSelectionRectangle) overlay?.hide();
    return;
  }

  lastCursor = { x: point.x, y: point.y };
  const startPoint = { x: selectionStart.x, y: selectionStart.y };
  const startedAt = selectionStartedAt;
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
  lastCursor = null;
  lastRect = null;
  selectionStartedAt = 0;
  if (drawSelectionRectangle) overlay?.hide();

  let frozen: FrozenCaptureHandle | null = null;
  try {
    const sessionPromise = frozenCaptureSession ?? beginFrozenMonitorCaptureAtPoint(point.x, point.y);
    frozen = await sessionPromise;
    frozenCaptureSession = null;
    const elapsedMs = Math.max(0, Date.now() - startedAt);
    const driftPx = movementDistance(startPoint, point);
    const isTap = elapsedMs <= CAPTURE_TAP_THRESHOLD_MS && driftPx <= CAPTURE_TAP_MAX_DRIFT_PX;

    let pngBuffer: Buffer;
    if (isTap) {
      pngBuffer = await cropFrozenCapture(frozen.id, {
        x: 0,
        y: 0,
        width: frozen.bounds.width,
        height: frozen.bounds.height
      });
    } else {
      if (payload.width < 1 || payload.height < 1) {
        throw new Error("Selection rectangle has zero area");
      }
      persistLastCaptureRect({
        left: payload.x,
        top: payload.y,
        width: payload.width,
        height: payload.height
      });
      const cropLeft = payload.x - frozen.bounds.left;
      const cropTop = payload.y - frozen.bounds.top;
      pngBuffer = await cropFrozenCapture(frozen.id, {
        x: cropLeft,
        y: cropTop,
        width: payload.width,
        height: payload.height
      });
    }

    const dataUrl = `data:image/png;base64,${pngBuffer.toString("base64")}`;
    mainWindow?.webContents.send("capture-image", { dataUrl, isTap });
    diag("capture.image.sent", {
      width: isTap ? frozen.bounds.width : payload.width,
      height: isTap ? frozen.bounds.height : payload.height,
      isTap,
      frozenAgeMs: Date.now() - frozen.capturedAt
    });
  } catch (error) {
    frozenCaptureSession = null;
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

async function replayLastCaptureRect(): Promise<void> {
  const rect = lastSavedCaptureRect;
  if (!rect) {
    diag("capture.replay.missing-rect");
    return;
  }
  if (rect.width < 1 || rect.height < 1) {
    diag("capture.replay.invalid-rect", rect);
    return;
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

    const dataUrl = `data:image/png;base64,${pngBuffer.toString("base64")}`;
    mainWindow?.webContents.send("capture-image", { dataUrl, isTap: false });
    diag("capture.replay.sent", {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      frozenAgeMs: Date.now() - frozen.capturedAt
    });
  } catch (error) {
    diag("capture.replay.error", {
      error: String(error),
      rect
    });
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
    if (!selectionActive || !captureHotkeySession || !selectionStart) return;
    const point = captureHotkeySession.getCursorPos();
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

function getAllActiveHotkeys(): Array<{ name: string; hotkey: string }> {
  return [
    { name: "capture", hotkey: activeCaptureHotkey },
    { name: "replay capture", hotkey: activeReplayCaptureHotkey },
    { name: "copy & play", hotkey: activeCopyHotkey },
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
  if (!normalized) throw new Error("Hotkey is required");
  for (const entry of getAllActiveHotkeys()) {
    if (entry.name === selfName) continue;
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
  session.setHotkey(normalized);
  const next = session.getHotkey();
  setActiveHotkey(next);
  setBeforeEdit(null);
  session.start();
  saveNativePrefs(toPersist(next));
  diag(logEvent, { activeHotkey: next });
  return next;
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
      diag("copy.play.empty", { changed: result.changed });
      return;
    }
    mainWindow?.webContents.send("copy-play-text", { text });
    diag("copy.play.sent", { length: text.length });
  } catch (error) {
    diag("copy.play.error", { error: String(error) });
  } finally {
    copyPlayInFlight = false;
  }
}

function emitPlaybackHotkey(action: "toggle_play_pause" | "next_chunk" | "previous_chunk" | "volume_up" | "volume_down"): void {
  mainWindow?.webContents.send("playback-hotkey", { action });
  diag("playback.hotkey.triggered", { action });
}

app.whenReady().then(() => {
  flushStartupPhaseBuffer();
  diag("app.ready");
  const nativePrefs = loadNativePrefs();
  isPinned = nativePrefs.alwaysOnTop ?? true;
  activeCaptureHotkey = nativePrefs.captureHotkey ?? activeCaptureHotkey;
  activeCopyHotkey = nativePrefs.copyPlayHotkey ?? activeCopyHotkey;
  activeAbortHotkey = nativePrefs.abortHotkey ?? activeAbortHotkey;
  activePlaybackToggleHotkey = nativePrefs.playPauseHotkey ?? activePlaybackToggleHotkey;
  activePlaybackNextHotkey = nativePrefs.nextChunkHotkey ?? activePlaybackNextHotkey;
  activePlaybackPreviousHotkey = nativePrefs.previousChunkHotkey ?? activePlaybackPreviousHotkey;
  activeVolumeUpHotkey = nativePrefs.volumeUpHotkey ?? activeVolumeUpHotkey;
  activeVolumeDownHotkey = nativePrefs.volumeDownHotkey ?? activeVolumeDownHotkey;
  activeReplayCaptureHotkey = nativePrefs.replayCaptureHotkey ?? activeReplayCaptureHotkey;
  lastSavedCaptureRect = isValidStoredRect(nativePrefs.lastCaptureRect) ? nativePrefs.lastCaptureRect : null;
  drawSelectionRectangle = nativePrefs.captureDrawRectangle ?? drawSelectionRectangle;
  diag("app.native-prefs.loaded", {
    isPinned,
    activeCaptureHotkey,
    activeCopyHotkey,
    activeAbortHotkey,
    activePlaybackToggleHotkey,
    activePlaybackNextHotkey,
    activePlaybackPreviousHotkey,
    activeVolumeUpHotkey,
    activeVolumeDownHotkey,
    activeReplayCaptureHotkey,
    lastSavedCaptureRect,
    drawSelectionRectangle
  });
  diag("app.main-window.create.begin");
  mainWindow = createMainWindow();
  diag("app.main-window.create.end", { hasWindow: Boolean(mainWindow) });
  overlay = new BorderOverlay(2);
  diag("app.overlay.created");
  diag("app.capture-session.create.begin", { hotkey: activeCaptureHotkey });
  captureHotkeySession = new HotkeySession({
    initialHotkey: activeCaptureHotkey,
    events: {
      onHotkeyRegistered: (label) => diag("capture.hotkey.registered", { label }),
      onHotkeySwitched: (label) => diag("capture.hotkey.switched", { label }),
      onTriggerDown: (point) => startSelection(point),
      onTriggerUp: (point) => {
        void finalizeSelection(point);
      }
    }
  });
  diag("app.capture-session.create.end");
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
  diag("app.copy-session.start.begin");
  copyHotkeySession.start();
  diag("app.copy-session.start.end");
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

  app.on("activate", () => {
    if (appCloseInFlight) {
      diag("app.activate.ignored", { reason: "close-in-flight" });
      return;
    }
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow();
    }
  });
});

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
ipcMain.handle("stack:get-recommended-cpu-status", () => recommendedCpuStackStatusSnapshot());
ipcMain.handle("stack:launch-recommended-cpu", async () => launchRecommendedCpuStack());
ipcMain.handle("stack:stop-recommended-cpu", async () => stopRecommendedCpuStack());
ipcMain.handle("stack:open-runtime-services", async () => openRuntimeServicesFolder());

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
  for (const { child } of recommendedCpuStackChildren) {
    terminateChildTreeSync(child);
  }
  recommendedCpuStackChildren = [];
  setRecommendedCpuStackStatus({
    state: "stopped",
    managed: false,
    urls: null,
    error: null
  });
  disposeNativeResources();
  diag("app.will-quit.end");
});

ipcMain.handle("ping", () => "pong");

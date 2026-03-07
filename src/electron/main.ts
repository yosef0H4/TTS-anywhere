import { app, BrowserWindow, desktopCapturer, ipcMain, nativeImage, screen } from "electron";
import { BorderOverlay, HotkeySession, captureCopyToText } from "nodehotkey";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

type LogLevel = "debug" | "info" | "warn" | "error";

interface BackendLogEntry {
  timestamp: string;
  level: LogLevel;
  category: string;
  message: string;
  context?: Record<string, unknown> | undefined;
  source: "frontend" | "backend";
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
let activeCaptureHotkey = "ctrl+shift+alt+s";
let activeCopyHotkey = "ctrl+shift+alt+x";
let captureHotkeyBeforeEdit: string | null = null;
let copyHotkeyBeforeEdit: string | null = null;
let drawSelectionRectangle = true;
let overlay: BorderOverlay | null = null;
let selectionTicker: NodeJS.Timeout | null = null;
let selectionActive = false;
let selectionStart: { x: number; y: number } | null = null;
let lastCursor: { x: number; y: number } | null = null;
let lastRect: { left: number; top: number; right: number; bottom: number } | null = null;
let frozenCaptureSession: Promise<FrozenDesktopCapture> | null = null;
let copyPlayInFlight = false;
let appCloseInFlight = false;
let shutdownWatchdog: NodeJS.Timeout | null = null;
const processStartAt = Date.now();

interface FrozenDesktopCapture {
  image: Electron.NativeImage;
  bounds: { left: number; top: number; width: number; height: number };
  capturedAt: number;
}

function processUptimeMs(): number {
  return Date.now() - processStartAt;
}

function prefsPath(): string {
  return path.join(app.getPath("userData"), "window-prefs.json");
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

function loadPinnedPref(): boolean {
  try {
    const raw = fs.readFileSync(prefsPath(), "utf-8");
    const parsed = JSON.parse(raw) as { alwaysOnTop?: boolean };
    return parsed.alwaysOnTop ?? true;
  } catch {
    return true;
  }
}

function savePinnedPref(value: boolean): void {
  try {
    fs.writeFileSync(prefsPath(), JSON.stringify({ alwaysOnTop: value }, null, 2), "utf-8");
  } catch {
    // ignore persistence failures
  }
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

function createMainWindow(): BrowserWindow {
  diag("window.create.begin");
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

function sameRect(
  a: { left: number; top: number; right: number; bottom: number } | null,
  b: { left: number; top: number; right: number; bottom: number } | null
): boolean {
  if (!a || !b) return false;
  return a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom;
}

function toPhysicalBounds(display: Electron.Display): { left: number; top: number; width: number; height: number } {
  const scale = Number.isFinite(display.scaleFactor) && display.scaleFactor > 0 ? display.scaleFactor : 1;
  return {
    left: Math.round(display.bounds.x * scale),
    top: Math.round(display.bounds.y * scale),
    width: Math.max(1, Math.round(display.bounds.width * scale)),
    height: Math.max(1, Math.round(display.bounds.height * scale))
  };
}

async function captureFrozenDesktop(): Promise<FrozenDesktopCapture> {
  const displays = screen.getAllDisplays();
  if (!displays.length) throw new Error("No displays available for capture");

  const physicalDisplays = displays.map((display) => ({
    display,
    bounds: toPhysicalBounds(display)
  }));
  const firstDisplay = physicalDisplays[0];
  if (!firstDisplay) throw new Error("No displays available for capture");
  const union = physicalDisplays.reduce(
    (acc, item) => ({
      left: Math.min(acc.left, item.bounds.left),
      top: Math.min(acc.top, item.bounds.top),
      right: Math.max(acc.right, item.bounds.left + item.bounds.width),
      bottom: Math.max(acc.bottom, item.bounds.top + item.bounds.height)
    }),
    {
      left: firstDisplay.bounds.left,
      top: firstDisplay.bounds.top,
      right: firstDisplay.bounds.left + firstDisplay.bounds.width,
      bottom: firstDisplay.bounds.top + firstDisplay.bounds.height
    }
  );

  const maxWidth = Math.max(...physicalDisplays.map((item) => item.bounds.width));
  const maxHeight = Math.max(...physicalDisplays.map((item) => item.bounds.height));
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: maxWidth, height: maxHeight },
    fetchWindowIcons: false
  });

  const composites: sharp.OverlayOptions[] = [];
  for (const item of physicalDisplays) {
    const source = sources.find((candidate) => candidate.display_id === String(item.display.id));
    if (!source) {
      throw new Error(`No desktop source for display ${item.display.id}`);
    }
    const sourceSize = source.thumbnail.getSize();
    if (sourceSize.width < 1 || sourceSize.height < 1) {
      throw new Error(`Empty thumbnail for display ${item.display.id}`);
    }

    const pngBuffer = source.thumbnail
      .resize({
        width: item.bounds.width,
        height: item.bounds.height,
        quality: "best"
      })
      .toPNG();

    composites.push({
      input: pngBuffer,
      left: item.bounds.left - union.left,
      top: item.bounds.top - union.top
    });
  }

  const stitched = await sharp({
    create: {
      width: Math.max(1, union.right - union.left),
      height: Math.max(1, union.bottom - union.top),
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 1 }
    }
  })
    .composite(composites)
    .png()
    .toBuffer();

  return {
    image: nativeImage.createFromBuffer(stitched),
    bounds: {
      left: union.left,
      top: union.top,
      width: Math.max(1, union.right - union.left),
      height: Math.max(1, union.bottom - union.top)
    },
    capturedAt: Date.now()
  };
}

function beginFrozenCaptureSession(): void {
  frozenCaptureSession = captureFrozenDesktop()
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
    if (drawSelectionRectangle) overlay?.hide();
    return;
  }

  lastCursor = { x: point.x, y: point.y };
  const rect = buildRect(selectionStart, lastCursor);
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
  if (drawSelectionRectangle) overlay?.hide();

  if (payload.width < 1 || payload.height < 1) {
    diag("capture.error", { error: "Selection rectangle has zero area" });
    return;
  }

  try {
    const sessionPromise = frozenCaptureSession ?? captureFrozenDesktop();
    const frozen = await sessionPromise;
    frozenCaptureSession = null;

    const cropLeft = payload.x - frozen.bounds.left;
    const cropTop = payload.y - frozen.bounds.top;
    if (cropLeft < 0 || cropTop < 0 || cropLeft + payload.width > frozen.bounds.width || cropTop + payload.height > frozen.bounds.height) {
      throw new Error("Selection is outside frozen desktop bounds");
    }

    const pngBuffer = frozen.image
      .crop({
        x: cropLeft,
        y: cropTop,
        width: payload.width,
        height: payload.height
      })
      .toPNG();

    const dataUrl = `data:image/png;base64,${pngBuffer.toString("base64")}`;
    mainWindow?.webContents.send("capture-image", { dataUrl });
    diag("capture.image.sent", {
      width: payload.width,
      height: payload.height,
      frozenAgeMs: Date.now() - frozen.capturedAt
    });
  } catch (error) {
    frozenCaptureSession = null;
    diag("capture.error", { error: String(error) });
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

function assertHotkeyDistinct(candidate: string, other: string, what: "capture" | "copy"): string {
  const normalized = normalizeHotkeyLabel(candidate);
  if (!normalized) throw new Error("Hotkey is required");
  if (normalized === normalizeHotkeyLabel(other)) {
    throw new Error(`${what} hotkey cannot match the other hotkey`);
  }
  return normalized;
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

app.whenReady().then(() => {
  diag("app.ready");
  isPinned = loadPinnedPref();
  mainWindow = createMainWindow();
  overlay = new BorderOverlay(2);
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
  captureHotkeySession.start();
  copyHotkeySession.start();
  startSelectionTicker();

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
  if (!captureHotkeySession) return activeCaptureHotkey;
  captureHotkeyBeforeEdit = activeCaptureHotkey;
  captureHotkeySession.stop();
  diag("capture.hotkey.edit.begin", { activeHotkey: activeCaptureHotkey });
  return activeCaptureHotkey;
});

ipcMain.handle("capture:apply-hotkey", (_event, hotkey: string) => {
  if (!captureHotkeySession) return activeCaptureHotkey;
  const normalized = assertHotkeyDistinct(hotkey, activeCopyHotkey, "capture");
  captureHotkeySession.setHotkey(normalized);
  activeCaptureHotkey = captureHotkeySession.getHotkey();
  captureHotkeyBeforeEdit = null;
  captureHotkeySession.start();
  diag("capture.hotkey.edit.applied", { activeHotkey: activeCaptureHotkey });
  return activeCaptureHotkey;
});

ipcMain.handle("capture:cancel-hotkey-edit", () => {
  if (!captureHotkeySession) return activeCaptureHotkey;
  if (captureHotkeyBeforeEdit) {
    captureHotkeySession.setHotkey(captureHotkeyBeforeEdit);
    activeCaptureHotkey = captureHotkeySession.getHotkey();
  }
  captureHotkeyBeforeEdit = null;
  captureHotkeySession.start();
  diag("capture.hotkey.edit.cancelled", { activeHotkey: activeCaptureHotkey });
  return activeCaptureHotkey;
});

ipcMain.handle("capture:get-hotkey", () => {
  if (captureHotkeySession) {
    activeCaptureHotkey = captureHotkeySession.getHotkey();
  }
  return activeCaptureHotkey;
});

ipcMain.handle("copy:begin-hotkey-edit", () => {
  if (!copyHotkeySession) return activeCopyHotkey;
  copyHotkeyBeforeEdit = activeCopyHotkey;
  copyHotkeySession.stop();
  diag("copy.hotkey.edit.begin", { activeHotkey: activeCopyHotkey });
  return activeCopyHotkey;
});

ipcMain.handle("copy:apply-hotkey", (_event, hotkey: string) => {
  if (!copyHotkeySession) return activeCopyHotkey;
  const normalized = assertHotkeyDistinct(hotkey, activeCaptureHotkey, "copy");
  copyHotkeySession.setHotkey(normalized);
  activeCopyHotkey = copyHotkeySession.getHotkey();
  copyHotkeyBeforeEdit = null;
  copyHotkeySession.start();
  diag("copy.hotkey.edit.applied", { activeHotkey: activeCopyHotkey });
  return activeCopyHotkey;
});

ipcMain.handle("copy:cancel-hotkey-edit", () => {
  if (!copyHotkeySession) return activeCopyHotkey;
  if (copyHotkeyBeforeEdit) {
    copyHotkeySession.setHotkey(copyHotkeyBeforeEdit);
    activeCopyHotkey = copyHotkeySession.getHotkey();
  }
  copyHotkeyBeforeEdit = null;
  copyHotkeySession.start();
  diag("copy.hotkey.edit.cancelled", { activeHotkey: activeCopyHotkey });
  return activeCopyHotkey;
});

ipcMain.handle("copy:get-hotkey", () => {
  if (copyHotkeySession) {
    activeCopyHotkey = copyHotkeySession.getHotkey();
  }
  return activeCopyHotkey;
});

ipcMain.handle("capture:set-draw-rectangle", (_event, enabled: boolean) => {
  drawSelectionRectangle = Boolean(enabled);
  if (!drawSelectionRectangle) {
    overlay?.hide();
  }
  diag("capture.draw-rectangle.changed", { enabled: drawSelectionRectangle });
  return drawSelectionRectangle;
});

ipcMain.handle("capture:get-draw-rectangle", () => drawSelectionRectangle);

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
  disposeNativeResources();
  diag("app.will-quit.end");
});

ipcMain.handle("ping", () => "pong");

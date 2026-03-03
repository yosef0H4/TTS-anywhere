import { app, BrowserWindow, ipcMain } from "electron";
import { BorderOverlay, HotkeySession, captureCopyToText } from "nodehotkey";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import screenshot from "screenshot-desktop";
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
let copyPlayInFlight = false;

function prefsPath(): string {
  return path.join(app.getPath("userData"), "window-prefs.json");
}

function getLogDir(): string {
  return path.join(app.getPath("userData"), "logs");
}

function getLogFilePath(): string {
  return path.join(getLogDir(), "tts-sniffer.log");
}

function diagnosticsPath(): string {
  return path.join(app.getPath("userData"), "capture-diagnostics.log");
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
  writeBackendLog("info", "electron", event, data);
  try {
    const payload = data ? ` ${JSON.stringify(data)}` : "";
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

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 860,
    minHeight: 560,
    resizable: true,
    frame: false,
    titleBarStyle: "hidden",
    backgroundColor: "#fff0f5",
    show: false,
    alwaysOnTop: isPinned,
    skipTaskbar: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  win.setResizable(true);
  win.setAlwaysOnTop(isPinned, "floating");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(path.join(__dirname, "../dist/index.html"));
  }

  win.once("ready-to-show", () => {
    win.show();
  });

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

function startSelection(point: { x: number; y: number }): void {
  selectionStart = { x: point.x, y: point.y };
  lastCursor = { x: point.x, y: point.y };
  lastRect = null;
  selectionActive = true;
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
    const desktopPng = await screenshot({ format: "png" });
    const pngBuffer = await sharp(desktopPng)
      .extract({
        left: payload.x,
        top: payload.y,
        width: payload.width,
        height: payload.height
      })
      .png()
      .toBuffer();

    const dataUrl = `data:image/png;base64,${pngBuffer.toString("base64")}`;
    mainWindow?.webContents.send("capture-image", { dataUrl });
  } catch (error) {
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
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow();
    }
  });
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

ipcMain.on("window:minimize", () => {
  mainWindow?.minimize();
});

ipcMain.handle("window:toggle-maximize", () => {
  if (!mainWindow) {
    return false;
  }
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
    return false;
  }
  mainWindow.maximize();
  return true;
});

ipcMain.on("window:close", () => {
  mainWindow?.close();
});

ipcMain.handle("window:get-pin", () => {
  return isPinned;
});

ipcMain.handle("window:toggle-pin", () => {
  if (!mainWindow) {
    return isPinned;
  }
  isPinned = !isPinned;
  mainWindow.setAlwaysOnTop(isPinned, "floating");
  savePinnedPref(isPinned);
  return isPinned;
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
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("will-quit", () => {
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
});

ipcMain.handle("ping", () => "pong");

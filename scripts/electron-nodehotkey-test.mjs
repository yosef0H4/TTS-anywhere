import { app, BrowserWindow, ipcMain } from "electron";
import fs from "node:fs";
import path from "node:path";
import screenshot from "screenshot-desktop";
import sharp from "sharp";
import { BorderOverlay, HotkeySession } from "nodehotkey";

const args = process.argv.slice(2);
const hotkeyArgIndex = args.findIndex((a) => a === "--hotkey");
const hotkey = hotkeyArgIndex >= 0 ? args[hotkeyArgIndex + 1] : "ctrl+shift+alt+s";

const outDir = path.join(process.cwd(), "services", "nodehotkey", "captures");
fs.mkdirSync(outDir, { recursive: true });

let mainWindow = null;
let session = null;
let overlay = null;
let captureCount = 0;

let selectionActive = false;
let selectionStart = null;
let lastCursor = null;
let lastRect = null;

function log(event, data) {
  const ts = new Date().toISOString();
  const payload = data ? ` ${JSON.stringify(data)}` : "";
  console.log(`[nodehotkey-electron-test] [${ts}] ${event}${payload}`);
}

function buildRect(a, b) {
  return {
    left: Math.min(a.x, b.x),
    top: Math.min(a.y, b.y),
    right: Math.max(a.x, b.x),
    bottom: Math.max(a.y, b.y)
  };
}

function toRectPayload(rect) {
  return {
    x: rect.left,
    y: rect.top,
    width: rect.right - rect.left,
    height: rect.bottom - rect.top
  };
}

function sameRect(a, b) {
  if (!a || !b) return false;
  return a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom;
}

async function saveCaptureFromRect(rect) {
  const payload = toRectPayload(rect);
  if (payload.width < 1 || payload.height < 1) {
    log("capture.skipped", { reason: "zero-area", rect: payload });
    return;
  }

  const desktopPng = await screenshot({ format: "png" });
  const pngBuffer = await sharp(desktopPng)
    .extract({ left: payload.x, top: payload.y, width: payload.width, height: payload.height })
    .png()
    .toBuffer();

  captureCount += 1;
  const filePath = path.join(outDir, `electron-capture-${String(captureCount).padStart(3, "0")}.png`);
  fs.writeFileSync(filePath, pngBuffer);
  log("capture.saved", { filePath, rect: payload });
}

function startSelection(point) {
  selectionStart = { x: point.x, y: point.y };
  lastCursor = { x: point.x, y: point.y };
  lastRect = null;
  selectionActive = true;
  overlay.hide();
  log("capture.start", { x: point.x, y: point.y, hotkey: session.getHotkey() });
}

function stopSelection(point) {
  if (!selectionActive || !selectionStart) {
    selectionActive = false;
    selectionStart = null;
    lastCursor = null;
    lastRect = null;
    overlay.hide();
    return;
  }

  lastCursor = { x: point.x, y: point.y };
  const rect = buildRect(selectionStart, lastCursor);
  const payload = toRectPayload(rect);
  log("capture.finalize", payload);

  selectionActive = false;
  selectionStart = null;
  lastCursor = null;
  lastRect = null;
  overlay.hide();

  void saveCaptureFromRect(rect).catch((error) => {
    log("capture.error", { error: String(error) });
  });
}

function startSelectionTicker() {
  setInterval(() => {
    if (!selectionActive || !session || !selectionStart) return;

    const point = session.getCursorPos();
    if (!point) return;
    lastCursor = { x: point.x, y: point.y };

    const nextRect = buildRect(selectionStart, lastCursor);
    if (nextRect.right <= nextRect.left || nextRect.bottom <= nextRect.top) return;

    if (!sameRect(lastRect, nextRect)) {
      overlay.draw(nextRect);
      lastRect = nextRect;
    }
  }, 16);
}

app.whenReady().then(() => {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 600,
    show: true,
    title: "nodehotkey electron test",
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  mainWindow.loadURL(
    "data:text/html," +
      encodeURIComponent(`
        <div style="font-family:sans-serif;padding:16px">
          <h3>nodehotkey electron test running</h3>
          <p>Use hotkey and drag-select, then release base key.</p>
          <button id="ping-btn" style="padding:8px 12px">Ping Main</button>
        </div>
        <script>
          const { ipcRenderer } = require("electron");
          document.getElementById("ping-btn").addEventListener("click", () => {
            ipcRenderer.send("test:ping");
          });
        </script>
      `)
  );

  ipcMain.on("test:ping", () => {
    log("test.pong");
  });

  overlay = new BorderOverlay(2);
  session = new HotkeySession({
    initialHotkey: hotkey,
    events: {
      onHotkeyRegistered: (label) => log("capture.hotkey.registered", { label }),
      onHotkeySwitched: (label) => log("capture.hotkey.switched", { label }),
      onTriggerDown: (point) => startSelection(point),
      onTriggerUp: (point) => stopSelection(point)
    }
  });

  session.start();
  startSelectionTicker();

  log("test.ready", { hotkey: session.getHotkey() });
  log("test.instructions", {
    message: "Hold hotkey, drag mouse, release base key. Ctrl+C to exit.",
    outputDir: outDir
  });
});

app.on("window-all-closed", () => {
  // keep running until Ctrl+C so global hotkey behavior can be tested while unfocused
});

app.on("will-quit", () => {
  if (session) {
    session.stop();
    session = null;
  }
  if (overlay) {
    overlay.destroy();
    overlay = null;
  }
});

process.on("SIGINT", () => {
  if (session) {
    session.stop();
    session = null;
  }
  if (overlay) {
    overlay.destroy();
    overlay = null;
  }
  app.quit();
});

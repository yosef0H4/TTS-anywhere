import { app, BrowserWindow, ipcMain } from "electron";
import fs from "node:fs";
import path from "node:path";
import screenshot from "screenshot-desktop";
import sharp from "sharp";
import { BorderOverlay, HotkeySession, captureCopyToText, sendHotkey } from "nodehotkey";

const args = process.argv.slice(2);
const hotkeyArgIndex = args.findIndex((a) => a === "--hotkey");
const hotkey = hotkeyArgIndex >= 0 ? args[hotkeyArgIndex + 1] : "ctrl+shift+alt+s";
const sendOnHotkeyArgIndex = args.findIndex((a) => a === "--send-on-hotkey");
const sendOnHotkey = sendOnHotkeyArgIndex >= 0 ? args[sendOnHotkeyArgIndex + 1] : "";

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
let sendInFlight = false;

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
  if (sendOnHotkey) return;
  selectionStart = { x: point.x, y: point.y };
  lastCursor = { x: point.x, y: point.y };
  lastRect = null;
  selectionActive = true;
  overlay.hide();
  log("capture.start", { x: point.x, y: point.y, hotkey: session.getHotkey() });
}

function stopSelection(point) {
  if (sendOnHotkey) {
    void sendMappedHotkeyOnRelease();
    return;
  }
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

const VK_SHIFT = 0x10;
const VK_CONTROL = 0x11;
const VK_MENU = 0x12;
const VK_LWIN = 0x5b;
const VK_RWIN = 0x5c;
const MOD_ALT = 0x0001;
const MOD_CONTROL = 0x0002;
const MOD_SHIFT = 0x0004;
const MOD_WIN = 0x0008;

function delayMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTriggerModifiersReleased(timeoutMs = 250) {
  if (!session) return;
  const startedAt = Date.now();
  const mods = session.getHotkeySpec().modifiers;
  while (Date.now() - startedAt < timeoutMs) {
    const ctrlDown = (mods & MOD_CONTROL) !== 0 && session.isKeyDown(VK_CONTROL);
    const shiftDown = (mods & MOD_SHIFT) !== 0 && session.isKeyDown(VK_SHIFT);
    const altDown = (mods & MOD_ALT) !== 0 && session.isKeyDown(VK_MENU);
    const winDown = (mods & MOD_WIN) !== 0 && (session.isKeyDown(VK_LWIN) || session.isKeyDown(VK_RWIN));
    if (!ctrlDown && !shiftDown && !altDown && !winDown) return;
    await delayMs(8);
  }
}

async function sendMappedHotkeyOnRelease() {
  if (sendInFlight) {
    log("send.hotkey.skipped", { reason: "in-flight" });
    return;
  }
  sendInFlight = true;
  try {
    await waitForTriggerModifiersReleased();
    if (String(sendOnHotkey).toLowerCase() === "ctrl+c") {
      const captureResult = await captureCopyToText({
        copyHotkey: "ctrl+c",
        timeoutMs: 5000,
        pollMs: 25,
        waitMode: "any",
        restoreClipboard: true
      });
      log("send.hotkey.ok", {
        trigger: session.getHotkey(),
        sent: sendOnHotkey,
        changed: captureResult.changed,
        copiedText: captureResult.text,
        restore: captureResult.restore
      });
      return;
    }
    await sendHotkey(sendOnHotkey);
    log("send.hotkey.ok", { trigger: session.getHotkey(), sent: sendOnHotkey });
  } catch (error) {
    log("send.hotkey.error", { trigger: session.getHotkey(), sent: sendOnHotkey, error: String(error) });
  } finally {
    sendInFlight = false;
  }
}

function startSelectionTicker() {
  setInterval(() => {
    if (sendOnHotkey) return;
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

  overlay = sendOnHotkey ? null : new BorderOverlay(2);
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
  if (!sendOnHotkey) {
    startSelectionTicker();
  }

  log("test.ready", { hotkey: session.getHotkey() });
  if (sendOnHotkey) {
    log("test.instructions", {
      message: "Press trigger hotkey to simulate configured hotkey. Ctrl+C to exit.",
      triggerHotkey: session.getHotkey(),
      sendOnHotkey
    });
  } else {
    log("test.instructions", {
      message: "Hold hotkey, drag mouse, release base key. Ctrl+C to exit.",
      outputDir: outDir
    });
  }
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

import { app, BrowserWindow, ipcMain } from "electron";
import fs from "node:fs";
import path from "node:path";
import { NodeHotkey } from "nodehotkey";

const args = process.argv.slice(2);
const hotkeyArgIndex = args.findIndex((a) => a === "--hotkey");
const hotkey = hotkeyArgIndex >= 0 ? args[hotkeyArgIndex + 1] : "ctrl+shift+alt+s";

const outDir = path.join(process.cwd(), "services", "nodehotkey", "captures");
fs.mkdirSync(outDir, { recursive: true });

let mainWindow = null;
let nodeHotkey = null;
let captureLoopRunning = false;
let captureCount = 0;

function log(event, data) {
  const ts = new Date().toISOString();
  const payload = data ? ` ${JSON.stringify(data)}` : "";
  console.log(`[nodehotkey-electron-test] [${ts}] ${event}${payload}`);
}

function startCaptureLoop() {
  if (captureLoopRunning || !nodeHotkey) return;
  captureLoopRunning = true;

  void (async () => {
    while (captureLoopRunning && nodeHotkey) {
      try {
        const result = await nodeHotkey.captureOnce();
        captureCount += 1;
        const filePath = path.join(outDir, `electron-capture-${String(captureCount).padStart(3, "0")}.png`);
        fs.writeFileSync(filePath, result.pngBuffer);
        log("capture.saved", { filePath, rect: result.rect });
      } catch (error) {
        if (!captureLoopRunning) return;
        log("capture.loop.error", { error: String(error) });
      }
    }
  })();
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

  nodeHotkey = new NodeHotkey({
    initialHotkey: hotkey,
    events: {
      onHotkeyRegistered: (label) => log("capture.hotkey.registered", { label }),
      onHotkeySwitched: (label) => log("capture.hotkey.switched", { label }),
      onCaptureStart: (start) => log("capture.start", start),
      onCaptureFinalize: (rect) => log("capture.finalize", rect),
      onError: (error) => log("capture.error", { error: String(error) })
    }
  });

  nodeHotkey.start();
  startCaptureLoop();
  log("test.ready", { hotkey });
  log("test.instructions", {
    message: "Hold hotkey, drag mouse, release base key. Ctrl+C to exit.",
    outputDir: outDir
  });
});

app.on("window-all-closed", () => {
  // keep running until Ctrl+C so global hotkey behavior can be tested while unfocused
});

app.on("will-quit", () => {
  captureLoopRunning = false;
  if (nodeHotkey) {
    nodeHotkey.stop();
    nodeHotkey = null;
  }
});

process.on("SIGINT", () => {
  captureLoopRunning = false;
  if (nodeHotkey) {
    nodeHotkey.stop();
    nodeHotkey = null;
  }
  app.quit();
});

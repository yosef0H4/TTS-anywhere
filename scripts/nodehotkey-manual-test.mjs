import fs from "node:fs";
import path from "node:path";
import screenshot from "screenshot-desktop";
import sharp from "sharp";
import { BorderOverlay, HotkeySession } from "nodehotkey";

if (process.platform !== "win32") {
  console.error("[nodehotkey-manual-test] Windows-only");
  process.exit(1);
}

const args = process.argv.slice(2);
const hotkeyArgIndex = args.findIndex((a) => a === "--hotkey");
const hotkey = hotkeyArgIndex >= 0 ? args[hotkeyArgIndex + 1] : "ctrl+shift+alt+s";

const outDir = path.join(process.cwd(), "services", "nodehotkey", "captures");
fs.mkdirSync(outDir, { recursive: true });

let count = 0;
let selectionActive = false;
let selectionStart = null;
let lastCursor = null;
let lastRect = null;

const overlay = new BorderOverlay(2);
const session = new HotkeySession({
  initialHotkey: hotkey,
  events: {
    onHotkeyRegistered: (label) => console.log(`[nodehotkey-manual-test] hotkey.registered ${label}`),
    onHotkeySwitched: (label) => console.log(`[nodehotkey-manual-test] hotkey.switched ${label}`),
    onTriggerDown: (start) => startSelection(start),
    onTriggerUp: (end) => void stopSelection(end)
  }
});

function buildRect(a, b) {
  return {
    left: Math.min(a.x, b.x),
    top: Math.min(a.y, b.y),
    right: Math.max(a.x, b.x),
    bottom: Math.max(a.y, b.y)
  };
}

function sameRect(a, b) {
  if (!a || !b) return false;
  return a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom;
}

async function saveCapture(rect) {
  const payload = {
    x: rect.left,
    y: rect.top,
    width: rect.right - rect.left,
    height: rect.bottom - rect.top
  };

  if (payload.width < 1 || payload.height < 1) {
    console.log("[nodehotkey-manual-test] capture.skipped zero-area");
    return;
  }

  const desktopPng = await screenshot({ format: "png" });
  const pngBuffer = await sharp(desktopPng)
    .extract({ left: payload.x, top: payload.y, width: payload.width, height: payload.height })
    .png()
    .toBuffer();

  count += 1;
  const file = path.join(outDir, `capture-${String(count).padStart(3, "0")}.png`);
  fs.writeFileSync(file, pngBuffer);
  console.log(`[nodehotkey-manual-test] saved ${file} (${payload.width}x${payload.height})`);
}

function startSelection(point) {
  selectionStart = { x: point.x, y: point.y };
  lastCursor = { x: point.x, y: point.y };
  lastRect = null;
  selectionActive = true;
  overlay.hide();
  console.log(`[nodehotkey-manual-test] capture.start x=${point.x} y=${point.y} hotkey=${session.getHotkey()}`);
}

async function stopSelection(point) {
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
  const payload = {
    x: rect.left,
    y: rect.top,
    width: rect.right - rect.left,
    height: rect.bottom - rect.top
  };
  console.log(`[nodehotkey-manual-test] capture.finalize x=${payload.x} y=${payload.y} w=${payload.width} h=${payload.height}`);

  selectionActive = false;
  selectionStart = null;
  lastCursor = null;
  lastRect = null;
  overlay.hide();

  try {
    await saveCapture(rect);
  } catch (error) {
    console.error(`[nodehotkey-manual-test] capture.error ${String(error)}`);
  }
}

const ticker = setInterval(() => {
  if (!selectionActive || !selectionStart) return;
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

session.start();
console.log(`[nodehotkey-manual-test] started, hotkey=${session.getHotkey()}`);
console.log("[nodehotkey-manual-test] hold hotkey, drag mouse, release base key to capture");
console.log("[nodehotkey-manual-test] press Ctrl+C to exit");

process.on("SIGINT", () => {
  clearInterval(ticker);
  session.stop();
  overlay.destroy();
  console.log("[nodehotkey-manual-test] stopped");
  process.exit(0);
});

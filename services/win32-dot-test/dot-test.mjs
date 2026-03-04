import koffi from "koffi";
import fs from "node:fs";
import path from "node:path";
import screenshot from "screenshot-desktop";
import sharp from "sharp";

if (process.platform !== "win32") {
  console.error("This script is Windows-only.");
  process.exit(1);
}

const POLL_MS = 16;
const DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4;
const BORDER_THICKNESS = 2;

const WS_POPUP = 0x80000000;
const WS_EX_TOPMOST = 0x00000008;
const WS_EX_TOOLWINDOW = 0x00000080;
const WS_EX_TRANSPARENT = 0x00000020;
const WS_EX_NOACTIVATE = 0x08000000;
const SS_BLACKRECT = 0x0004;

const SW_HIDE = 0;
const SW_SHOWNA = 8;
const SWP_NOACTIVATE = 0x0010;
const SWP_SHOWWINDOW = 0x0040;
const HWND_TOPMOST = -1;

const WM_HOTKEY = 0x0312;
const PM_REMOVE = 0x0001;
const HOTKEY_ID = 1;
const MOD_ALT = 0x0001;
const MOD_CONTROL = 0x0002;
const MOD_SHIFT = 0x0004;
const MOD_WIN = 0x0008;
const MOD_NOREPEAT = 0x4000;

const DEFAULT_HOTKEY = "ctrl+shift+alt+s";
const TEST_HOTKEYS = [
  "ctrl+shift+alt+s",
  "alt+q",
  "ctrl+shift+x",
  "ctrl+alt+z",
  "shift+f8"
];

const TOKEN_TO_MOD = new Map([
  ["ctrl", MOD_CONTROL],
  ["control", MOD_CONTROL],
  ["shift", MOD_SHIFT],
  ["alt", MOD_ALT],
  ["win", MOD_WIN],
  ["meta", MOD_WIN]
]);

const KEY_ALIASES = new Map([
  ["esc", 0x1B],
  ["escape", 0x1B],
  ["enter", 0x0D],
  ["return", 0x0D],
  ["space", 0x20],
  ["tab", 0x09],
  ["up", 0x26],
  ["down", 0x28],
  ["left", 0x25],
  ["right", 0x27]
]);

const POINT = koffi.struct("POINT", { x: "long", y: "long" });
const MSG = koffi.struct("MSG", {
  hwnd: "void *", message: "uint32", wParam: "uintptr", lParam: "intptr", time: "uint32", pt_x: "long", pt_y: "long"
});

const user32 = koffi.load("user32.dll");

const SetProcessDpiAwarenessContext = user32.func("bool __stdcall SetProcessDpiAwarenessContext(intptr value)");
const SetProcessDPIAware = user32.func("bool __stdcall SetProcessDPIAware()");
const RegisterHotKey = user32.func("bool __stdcall RegisterHotKey(void *hWnd, int id, uint32 fsModifiers, uint32 vk)");
const UnregisterHotKey = user32.func("bool __stdcall UnregisterHotKey(void *hWnd, int id)");
const PeekMessageW = user32.func("bool __stdcall PeekMessageW(_Out_ MSG *lpMsg, void *hWnd, uint32 wMsgFilterMin, uint32 wMsgFilterMax, uint32 wRemoveMsg)");
const GetAsyncKeyState = user32.func("short __stdcall GetAsyncKeyState(int vKey)");
const GetCursorPos = user32.func("bool __stdcall GetCursorPos(_Out_ POINT *lpPoint)");
const CreateWindowExW = user32.func("void * __stdcall CreateWindowExW(uint32 exStyle, const char16_t *className, const char16_t *windowName, uint32 style, int x, int y, int w, int h, void *parent, void *menu, void *instance, void *param)");
const DestroyWindow = user32.func("bool __stdcall DestroyWindow(void *hWnd)");
const ShowWindow = user32.func("bool __stdcall ShowWindow(void *hWnd, int nCmdShow)");
const SetWindowPos = user32.func("bool __stdcall SetWindowPos(void *hWnd, intptr hWndInsertAfter, int x, int y, int cx, int cy, uint32 flags)");
const InvalidateRect = user32.func("bool __stdcall InvalidateRect(void *hWnd, void *lpRect, bool erase)");
const UpdateWindow = user32.func("bool __stdcall UpdateWindow(void *hWnd)");

function parseArgs(argv) {
  let hotkeyText = DEFAULT_HOTKEY;
  let testHotkeys = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--test-hotkeys") {
      testHotkeys = true;
      continue;
    }
    if (arg === "--hotkey") {
      const next = argv[i + 1];
      if (!next) throw new Error("Missing value for --hotkey");
      hotkeyText = next;
      i += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { hotkeyText, testHotkeys };
}

function printUsage() {
  console.log("Usage:");
  console.log("  node dot-test.mjs [--hotkey \"ctrl+shift+alt+s\"] [--test-hotkeys]");
  console.log("");
  console.log("Notes:");
  console.log("  --hotkey accepts one combo with at least one modifier.");
  console.log("  --test-hotkeys rotates through 5 predefined hotkeys after each capture.");
}

function keyTokenToVk(token) {
  if (KEY_ALIASES.has(token)) return KEY_ALIASES.get(token);
  if (/^[a-z]$/.test(token)) return token.toUpperCase().charCodeAt(0);
  if (/^[0-9]$/.test(token)) return token.charCodeAt(0);
  const fn = token.match(/^f([1-9]|1[0-9]|2[0-4])$/);
  if (fn) return 0x70 + Number(fn[1]) - 1;
  return null;
}

function parseHotkeySpec(text) {
  const normalized = String(text).trim().toLowerCase();
  if (!normalized) throw new Error("Hotkey string is empty");

  const tokens = normalized.split("+").map((t) => t.trim()).filter(Boolean);
  if (tokens.length < 2) throw new Error("Hotkey must include at least one modifier and one key");

  let modifiers = 0;
  let keyToken = null;

  for (const token of tokens) {
    const mod = TOKEN_TO_MOD.get(token);
    if (mod) {
      modifiers |= mod;
      continue;
    }
    if (keyToken) throw new Error(`Hotkey contains multiple non-modifier keys: "${keyToken}" and "${token}"`);
    keyToken = token;
  }

  if (!modifiers) throw new Error("Hotkey must include at least one modifier");
  if (!keyToken) throw new Error("Hotkey must include a base key");

  const vk = keyTokenToVk(keyToken);
  if (vk == null) throw new Error(`Unsupported key token: "${keyToken}"`);

  const label = tokens.join("+");
  return { label, modifiers: modifiers | MOD_NOREPEAT, vk, releaseVk: vk };
}

function createBorderWindow() {
  const exStyle = WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE;
  const hwnd = CreateWindowExW(exStyle, "STATIC", "", WS_POPUP | SS_BLACKRECT, 0, 0, 1, 1, null, null, null, null);
  if (!hwnd) throw new Error("CreateWindowExW(STATIC) failed");
  return hwnd;
}

const borderWindows = { top: createBorderWindow(), right: createBorderWindow(), bottom: createBorderWindow(), left: createBorderWindow() };

function positionBorderWindow(hwnd, x, y, w, h) {
  const width = Math.max(1, w);
  const height = Math.max(1, h);
  SetWindowPos(hwnd, HWND_TOPMOST, x, y, width, height, SWP_NOACTIVATE | SWP_SHOWWINDOW);
  ShowWindow(hwnd, SW_SHOWNA);
  InvalidateRect(hwnd, null, true);
  UpdateWindow(hwnd);
}

function hideAllBorderWindows() {
  ShowWindow(borderWindows.top, SW_HIDE);
  ShowWindow(borderWindows.right, SW_HIDE);
  ShowWindow(borderWindows.bottom, SW_HIDE);
  ShowWindow(borderWindows.left, SW_HIDE);
}

function drawSolidRectBorder(rect) {
  const width = Math.max(1, rect.right - rect.left);
  const height = Math.max(1, rect.bottom - rect.top);
  const t = BORDER_THICKNESS;
  positionBorderWindow(borderWindows.top, rect.left, rect.top, width, t);
  positionBorderWindow(borderWindows.bottom, rect.left, rect.bottom - t, width, t);
  positionBorderWindow(borderWindows.left, rect.left, rect.top, t, height);
  positionBorderWindow(borderWindows.right, rect.right - t, rect.top, t, height);
}

function buildRect(a, b) {
  return { left: Math.min(a.x, b.x), top: Math.min(a.y, b.y), right: Math.max(a.x, b.x), bottom: Math.max(a.y, b.y) };
}

function rectEquals(a, b) {
  return a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom;
}

async function saveRectScreenshot(rect) {
  const width = Math.max(0, rect.right - rect.left);
  const height = Math.max(0, rect.bottom - rect.top);
  if (width < 1 || height < 1) throw new Error("Rectangle too small for screenshot");

  const screenshotsDir = path.join(process.cwd(), "screenshots");
  fs.mkdirSync(screenshotsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = path.join(screenshotsDir, `capture-${stamp}.png`);

  const png = await screenshot({ format: "png" });
  await sharp(png)
    .extract({ left: rect.left, top: rect.top, width, height })
    .png()
    .toFile(filePath);

  return filePath;
}

let running = true;
let drawCount = 0;
let savingScreenshot = false;

let dragStartPoint = null;
let lastCursorPoint = null;
let lastRenderedRect = null;
let captureActive = false;

let rotationEnabled = false;
let hotkeyCycle = [];
let hotkeyIndex = 0;
let activeHotkey = null;

function tryRegisterHotkey(spec) {
  const ok = RegisterHotKey(null, HOTKEY_ID, spec.modifiers, spec.vk);
  if (!ok) {
    console.error(`[win32-dot-test] hotkey.register.fail hotkey=${spec.label}`);
    return false;
  }
  activeHotkey = spec;
  console.log(`[win32-dot-test] hotkey.register.ok hotkey=${spec.label}`);
  return true;
}

function unregisterActiveHotkey() {
  if (activeHotkey) {
    UnregisterHotKey(null, HOTKEY_ID);
    console.log(`[win32-dot-test] hotkey.unregister hotkey=${activeHotkey.label}`);
    activeHotkey = null;
  }
}

function switchToHotkeyIndex(nextIndex) {
  if (!rotationEnabled) return true;
  const oldHotkey = activeHotkey;
  const candidate = hotkeyCycle[nextIndex];
  if (!candidate) return false;

  unregisterActiveHotkey();
  if (!tryRegisterHotkey(candidate)) {
    if (oldHotkey) {
      const rollbackOk = tryRegisterHotkey(oldHotkey);
      if (!rollbackOk) {
        console.error("[win32-dot-test] hotkey.switch.fail rollback failed");
      }
    }
    return false;
  }

  hotkeyIndex = nextIndex;
  console.log(`[win32-dot-test] hotkey.switch.ok next=${candidate.label}`);
  console.log(`[win32-dot-test] Next hotkey to use: ${candidate.label}`);
  return true;
}

function resetCaptureState() {
  hideAllBorderWindows();
  dragStartPoint = null;
  lastCursorPoint = null;
  lastRenderedRect = null;
  captureActive = false;
}

function startCapture() {
  const point = { x: 0, y: 0 };
  const ok = GetCursorPos(point);
  if (!ok || typeof point.x !== "number" || typeof point.y !== "number") {
    console.error("[win32-dot-test] capture.start failed: unable to read cursor position");
    resetCaptureState();
    return;
  }
  dragStartPoint = { x: point.x, y: point.y };
  lastCursorPoint = { x: point.x, y: point.y };
  lastRenderedRect = null;
  captureActive = true;
  hideAllBorderWindows();
  console.log(`[win32-dot-test] capture.start x=${point.x}, y=${point.y}, hotkey=${activeHotkey?.label ?? "unknown"}`);
}

function updateCapture() {
  if (!captureActive || !dragStartPoint) return;
  const point = { x: 0, y: 0 };
  const ok = GetCursorPos(point);
  if (!ok || typeof point.x !== "number" || typeof point.y !== "number") return;

  lastCursorPoint = { x: point.x, y: point.y };
  const nextRect = buildRect(dragStartPoint, lastCursorPoint);
  if (nextRect.right <= nextRect.left || nextRect.bottom <= nextRect.top) return;

  if (!lastRenderedRect || !rectEquals(lastRenderedRect, nextRect)) {
    drawSolidRectBorder(nextRect);
    lastRenderedRect = nextRect;
  }
}

function finalizeCapture() {
  if (!captureActive || !dragStartPoint || !lastCursorPoint) {
    resetCaptureState();
    return;
  }

  const rect = buildRect(dragStartPoint, lastCursorPoint);
  const width = rect.right - rect.left;
  const height = rect.bottom - rect.top;

  drawCount += 1;
  console.log(`[win32-dot-test] capture.finalize #${drawCount} release x=${lastCursorPoint.x}, y=${lastCursorPoint.y}`);
  console.log(`[win32-dot-test] rectangle x=${rect.left}, y=${rect.top}, width=${width}, height=${height}`);

  resetCaptureState();

  if (width < 1 || height < 1) {
    console.log("[win32-dot-test] capture.finalize skipped screenshot: zero-size rectangle");
    return;
  }
  if (savingScreenshot) {
    console.log("[win32-dot-test] capture.finalize skipped screenshot: previous save still in progress");
    return;
  }

  savingScreenshot = true;
  void saveRectScreenshot(rect)
    .then((savedPath) => {
      console.log(`[win32-dot-test] screenshot saved: ${savedPath}`);
      if (rotationEnabled) {
        const next = (hotkeyIndex + 1) % hotkeyCycle.length;
        switchToHotkeyIndex(next);
      }
    })
    .catch((error) => {
      console.error(`[win32-dot-test] screenshot failed: ${String(error)}`);
    })
    .finally(() => {
      savingScreenshot = false;
    });
}

function configureHotkeys() {
  let cli;
  try {
    cli = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[win32-dot-test] ${String(error)}`);
    printUsage();
    process.exit(2);
  }

  if (cli.testHotkeys) {
    rotationEnabled = true;
    hotkeyCycle = TEST_HOTKEYS.map((entry) => parseHotkeySpec(entry));
    hotkeyIndex = 0;
    if (cli.hotkeyText !== DEFAULT_HOTKEY) {
      console.log("[win32-dot-test] --test-hotkeys is enabled; --hotkey is ignored.");
    }
    return;
  }

  rotationEnabled = false;
  hotkeyCycle = [parseHotkeySpec(cli.hotkeyText)];
  hotkeyIndex = 0;
}

try {
  const ok = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  if (!ok) SetProcessDPIAware();
} catch {}

try {
  configureHotkeys();
} catch (error) {
  console.error(`[win32-dot-test] Failed to configure hotkeys: ${String(error)}`);
  process.exit(2);
}

if (!tryRegisterHotkey(hotkeyCycle[hotkeyIndex])) {
  process.exit(1);
}

console.log("[win32-dot-test] Started");
if (rotationEnabled) {
  console.log(`[win32-dot-test] Test mode enabled. Rotating ${hotkeyCycle.length} hotkeys after each screenshot.`);
  console.log(`[win32-dot-test] Rotation order: ${hotkeyCycle.map((h) => h.label).join(" -> ")}`);
  console.log(`[win32-dot-test] Next hotkey to use: ${activeHotkey.label}`);
} else {
  console.log(`[win32-dot-test] Active hotkey: ${activeHotkey.label}`);
}
console.log("[win32-dot-test] Hold active hotkey to start rectangle selection.");
console.log("[win32-dot-test] While held: live solid rectangle. On base-key release: logs rectangle and saves screenshot.");
console.log("[win32-dot-test] Press Ctrl+C to exit");

const timer = setInterval(() => {
  if (!running) return;

  const msg = {};
  while (PeekMessageW(msg, null, 0, 0, PM_REMOVE)) {
    if (msg.message === WM_HOTKEY && Number(msg.wParam) === HOTKEY_ID) {
      if (!captureActive) {
        startCapture();
      } else {
        console.log("[win32-dot-test] capture.hotkey ignored: capture already active");
      }
    }
  }

  if (captureActive && activeHotkey) {
    const baseKeyDown = (GetAsyncKeyState(activeHotkey.releaseVk) & 0x8000) !== 0;
    if (baseKeyDown) {
      updateCapture();
    } else {
      finalizeCapture();
    }
  }
}, POLL_MS);

function shutdown() {
  if (!running) return;
  running = false;
  clearInterval(timer);
  unregisterActiveHotkey();
  hideAllBorderWindows();
  DestroyWindow(borderWindows.top);
  DestroyWindow(borderWindows.right);
  DestroyWindow(borderWindows.bottom);
  DestroyWindow(borderWindows.left);
  console.log("[win32-dot-test] Stopped.");
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

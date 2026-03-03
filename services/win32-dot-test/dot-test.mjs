import koffi from "koffi";

if (process.platform !== "win32") {
  console.error("This script is Windows-only.");
  process.exit(1);
}

const VK_OEM_3 = 0xC0; // ` (backtick on US layout)
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
const MOD_NOREPEAT = 0x4000;

const POINT = koffi.struct("POINT", {
  x: "long",
  y: "long"
});

const RECT = koffi.struct("RECT", {
  left: "long",
  top: "long",
  right: "long",
  bottom: "long"
});

const MSG = koffi.struct("MSG", {
  hwnd: "void *",
  message: "uint32",
  wParam: "uintptr",
  lParam: "intptr",
  time: "uint32",
  pt_x: "long",
  pt_y: "long"
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

function createBorderWindow() {
  const exStyle = WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE;
  const hwnd = CreateWindowExW(
    exStyle,
    "STATIC",
    "",
    WS_POPUP | SS_BLACKRECT,
    0,
    0,
    1,
    1,
    null,
    null,
    null,
    null
  );
  if (!hwnd) {
    throw new Error("CreateWindowExW(STATIC) failed");
  }
  return hwnd;
}

const borderWindows = {
  top: createBorderWindow(),
  right: createBorderWindow(),
  bottom: createBorderWindow(),
  left: createBorderWindow()
};

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
  const left = rect.left;
  const top = rect.top;
  const right = rect.right;
  const bottom = rect.bottom;
  const width = Math.max(1, right - left);
  const height = Math.max(1, bottom - top);
  const t = BORDER_THICKNESS;

  positionBorderWindow(borderWindows.top, left, top, width, t);
  positionBorderWindow(borderWindows.bottom, left, bottom - t, width, t);
  positionBorderWindow(borderWindows.left, left, top, t, height);
  positionBorderWindow(borderWindows.right, right - t, top, t, height);
}

function buildRect(a, b) {
  return {
    left: Math.min(a.x, b.x),
    top: Math.min(a.y, b.y),
    right: Math.max(a.x, b.x),
    bottom: Math.max(a.y, b.y)
  };
}

function rectEquals(a, b) {
  return a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom;
}

let running = true;
let wasPressed = false;
let drawCount = 0;
let hotkeyPressed = false;

let dragStartPoint = null;
let lastCursorPoint = null;
let lastRenderedRect = null;

try {
  const ok = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  if (!ok) {
    SetProcessDPIAware();
  }
} catch {
  // Best effort only.
}

if (!RegisterHotKey(null, HOTKEY_ID, MOD_NOREPEAT, VK_OEM_3)) {
  console.error("[win32-dot-test] RegisterHotKey failed. Another app may already own backtick.");
  process.exit(1);
}

console.log("[win32-dot-test] Started");
console.log("[win32-dot-test] Global hotkey registered: backtick (`)");
console.log("[win32-dot-test] Hold backtick to start rectangle selection.");
console.log("[win32-dot-test] While held: live solid rectangle (4 topmost windows). On release: logs rectangle and clears preview.");
console.log("[win32-dot-test] Press Ctrl+C to exit");

const timer = setInterval(() => {
  if (!running) return;

  const msg = {};
  while (PeekMessageW(msg, null, 0, 0, PM_REMOVE)) {
    if (msg.message === WM_HOTKEY && Number(msg.wParam) === HOTKEY_ID) {
      hotkeyPressed = true;
    }
  }

  const keyState = GetAsyncKeyState(VK_OEM_3);
  const isPressed = hotkeyPressed && ((keyState & 0x8000) !== 0);

  if (isPressed && !wasPressed) {
    const point = { x: 0, y: 0 };
    const ok = GetCursorPos(point);
    if (ok && typeof point.x === "number" && typeof point.y === "number") {
      dragStartPoint = { x: point.x, y: point.y };
      lastCursorPoint = { x: point.x, y: point.y };
    } else {
      dragStartPoint = null;
      lastCursorPoint = null;
    }
    hideAllBorderWindows();
    lastRenderedRect = null;
  }

  if (isPressed && dragStartPoint) {
    const point = { x: 0, y: 0 };
    const ok = GetCursorPos(point);
    if (ok && typeof point.x === "number" && typeof point.y === "number") {
      lastCursorPoint = { x: point.x, y: point.y };
      const nextRect = buildRect(dragStartPoint, lastCursorPoint);

      if (nextRect.right > nextRect.left && nextRect.bottom > nextRect.top) {
        if (!lastRenderedRect || !rectEquals(lastRenderedRect, nextRect)) {
          drawSolidRectBorder(nextRect);
          lastRenderedRect = nextRect;
        }
      }
    }
  }

  if (!isPressed && wasPressed && dragStartPoint && lastCursorPoint) {
    try {
      hideAllBorderWindows();
      const rect = buildRect(dragStartPoint, lastCursorPoint);
      drawCount += 1;
      console.log(`[win32-dot-test] #${drawCount} released at x=${lastCursorPoint.x}, y=${lastCursorPoint.y}`);
      console.log(`[win32-dot-test] rectangle x=${rect.left}, y=${rect.top}, width=${rect.right - rect.left}, height=${rect.bottom - rect.top}`);
    } catch (error) {
      console.error(`[win32-dot-test] draw failed: ${String(error)}`);
    }

    dragStartPoint = null;
    lastCursorPoint = null;
    lastRenderedRect = null;
    hotkeyPressed = false;
  } else if (!isPressed) {
    hideAllBorderWindows();
    dragStartPoint = null;
    lastCursorPoint = null;
    lastRenderedRect = null;
    hotkeyPressed = false;
  }

  wasPressed = isPressed;
}, POLL_MS);

function shutdown() {
  if (!running) return;
  running = false;
  clearInterval(timer);
  UnregisterHotKey(null, HOTKEY_ID);
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

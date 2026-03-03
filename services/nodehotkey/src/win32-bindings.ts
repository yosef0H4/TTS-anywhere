import koffi from "koffi";

export const SW_HIDE = 0;
export const SW_SHOWNA = 8;
export const SWP_NOACTIVATE = 0x0010;
export const SWP_SHOWWINDOW = 0x0040;
export const HWND_TOPMOST = -1;
export const WS_POPUP = 0x80000000;
export const WS_EX_TOPMOST = 0x00000008;
export const WS_EX_TOOLWINDOW = 0x00000080;
export const WS_EX_TRANSPARENT = 0x00000020;
export const WS_EX_NOACTIVATE = 0x08000000;
export const SS_BLACKRECT = 0x0004;
export const WM_HOTKEY = 0x0312;
export const PM_REMOVE = 0x0001;
export const DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4;

export type WinMsg = { message?: number; wParam?: number | bigint };
export type Point = { x: number; y: number };

const POINT = koffi.struct("POINT", { x: "long", y: "long" });
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

const SetProcessDpiAwarenessContext = user32.func("bool __stdcall SetProcessDpiAwarenessContext(intptr value)") as (
  value: number
) => boolean;
const SetProcessDPIAware = user32.func("bool __stdcall SetProcessDPIAware()") as () => boolean;

export const RegisterHotKey = user32.func("bool __stdcall RegisterHotKey(void *hWnd, int id, uint32 fsModifiers, uint32 vk)") as (
  hWnd: null,
  id: number,
  modifiers: number,
  vk: number
) => boolean;

export const UnregisterHotKey = user32.func("bool __stdcall UnregisterHotKey(void *hWnd, int id)") as (hWnd: null, id: number) => boolean;

export const PeekMessageW = user32.func(
  "bool __stdcall PeekMessageW(_Out_ MSG *lpMsg, void *hWnd, uint32 wMsgFilterMin, uint32 wMsgFilterMax, uint32 wRemoveMsg)"
) as (msg: WinMsg, hWnd: null, min: number, max: number, remove: number) => boolean;

export const GetAsyncKeyState = user32.func("short __stdcall GetAsyncKeyState(int vKey)") as (vKey: number) => number;

export const GetCursorPos = user32.func("bool __stdcall GetCursorPos(_Out_ POINT *lpPoint)") as (pt: Point) => boolean;

export const CreateWindowExW = user32.func(
  "void * __stdcall CreateWindowExW(uint32 exStyle, const char16_t *className, const char16_t *windowName, uint32 style, int x, int y, int w, int h, void *parent, void *menu, void *instance, void *param)"
) as (
  exStyle: number,
  className: string,
  windowName: string,
  style: number,
  x: number,
  y: number,
  w: number,
  h: number,
  parent: null,
  menu: null,
  instance: null,
  param: null
) => unknown;

export const DestroyWindow = user32.func("bool __stdcall DestroyWindow(void *hWnd)") as (hWnd: unknown) => boolean;
export const ShowWindow = user32.func("bool __stdcall ShowWindow(void *hWnd, int nCmdShow)") as (hWnd: unknown, cmd: number) => boolean;
export const SetWindowPos = user32.func("bool __stdcall SetWindowPos(void *hWnd, intptr hWndInsertAfter, int x, int y, int cx, int cy, uint32 flags)") as (
  hWnd: unknown,
  insertAfter: number,
  x: number,
  y: number,
  cx: number,
  cy: number,
  flags: number
) => boolean;
export const InvalidateRect = user32.func("bool __stdcall InvalidateRect(void *hWnd, void *lpRect, bool erase)") as (
  hWnd: unknown,
  rect: null,
  erase: boolean
) => boolean;
export const UpdateWindow = user32.func("bool __stdcall UpdateWindow(void *hWnd)") as (hWnd: unknown) => boolean;

let dpiInitialized = false;

export function ensureDpiAwareness(): void {
  if (dpiInitialized) return;
  dpiInitialized = true;
  try {
    const ok = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    if (!ok) SetProcessDPIAware();
  } catch {
    // best effort
  }
}

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
export const SS_WHITERECT = 0x0006;
export const CS_HREDRAW = 0x0002;
export const CS_VREDRAW = 0x0001;
export const WM_HOTKEY = 0x0312;
export const WM_KEYDOWN = 0x0100;
export const WM_KEYUP = 0x0101;
export const WM_SYSKEYDOWN = 0x0104;
export const WM_SYSKEYUP = 0x0105;
export const PM_REMOVE = 0x0001;
export const HC_ACTION = 0;
export const WH_KEYBOARD_LL = 13;
export const DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4;
export const INPUT_KEYBOARD = 1;
export const KEYEVENTF_EXTENDEDKEY = 0x0001;
export const KEYEVENTF_KEYUP = 0x0002;
export const GMEM_MOVEABLE = 0x0002;
export const GMEM_ZEROINIT = 0x0040;
export const CF_UNICODETEXT = 13;
export const CF_HDROP = 15;
export const LLKHF_INJECTED = 0x00000010;

export const VK_CONTROL = 0x11;
export const VK_SHIFT = 0x10;
export const VK_MENU = 0x12;
export const VK_LWIN = 0x5b;
export const VK_RWIN = 0x5c;

export type WinMsg = { message?: number; wParam?: number | bigint };
export type Point = { x: number; y: number };
export type KbdLlHookStruct = { vkCode: number; scanCode: number; flags: number; time: number; dwExtraInfo: number };
export type RegisteredCallback = ReturnType<typeof koffi.register>;

const POINT = koffi.struct("POINT", { x: "long", y: "long" });
const WNDCLASSEXW = koffi.struct("WNDCLASSEXW", {
  cbSize: "uint32",
  style: "uint32",
  lpfnWndProc: "void *",
  cbClsExtra: "int32",
  cbWndExtra: "int32",
  hInstance: "void *",
  hIcon: "void *",
  hCursor: "void *",
  hbrBackground: "void *",
  lpszMenuName: "void *",
  lpszClassName: "const char16_t *",
  hIconSm: "void *"
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
const KBDLLHOOKSTRUCT = koffi.struct("KBDLLHOOKSTRUCT", {
  vkCode: "uint32",
  scanCode: "uint32",
  flags: "uint32",
  time: "uint32",
  dwExtraInfo: "uintptr"
});
const KEYBDINPUT = koffi.struct("KEYBDINPUT", {
  wVk: "uint16",
  wScan: "uint16",
  dwFlags: "uint32",
  time: "uint32",
  dwExtraInfo: "uintptr"
});
const INPUT = koffi.struct("INPUT", {
  type: "uint32",
  _pad: "uint32",
  ki: KEYBDINPUT,
  _unionPad: "uint64"
});

const user32 = koffi.load("user32.dll");
const kernel32 = koffi.load("kernel32.dll");
const gdi32 = koffi.load("gdi32.dll");
const LowLevelKeyboardProc = koffi.proto("intptr __stdcall LowLevelKeyboardProc(int nCode, uintptr wParam, KBDLLHOOKSTRUCT *lParam)");
const WindowProc = koffi.proto("intptr __stdcall WindowProc(void *hWnd, uint32 Msg, uintptr wParam, intptr lParam)");

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
export const SetWindowsHookExW = user32.func(
  "void * __stdcall SetWindowsHookExW(int idHook, LowLevelKeyboardProc *lpfn, void *hmod, uint32 dwThreadId)"
) as (idHook: number, hookProc: RegisteredCallback, module: unknown, threadId: number) => unknown;
export const UnhookWindowsHookEx = user32.func("bool __stdcall UnhookWindowsHookEx(void *hhk)") as (hook: unknown) => boolean;
export const CallNextHookEx = user32.func(
  "intptr __stdcall CallNextHookEx(void *hhk, int nCode, uintptr wParam, KBDLLHOOKSTRUCT *lParam)"
) as (hook: unknown, nCode: number, wParam: number, info: KbdLlHookStruct) => number;

export const GetAsyncKeyState = user32.func("short __stdcall GetAsyncKeyState(int vKey)") as (vKey: number) => number;

export const GetCursorPos = user32.func("bool __stdcall GetCursorPos(_Out_ POINT *lpPoint)") as (pt: Point) => boolean;
export const GetModuleHandleW = kernel32.func("void * __stdcall GetModuleHandleW(const char16_t *lpModuleName)") as (
  moduleName: string | null
) => unknown;
export const DefWindowProcW = user32.func(
  "intptr __stdcall DefWindowProcW(void *hWnd, uint32 Msg, uintptr wParam, intptr lParam)"
) as (hWnd: unknown, msg: number, wParam: number | bigint, lParam: number | bigint) => number;
export const RegisterClassExW = user32.func("uint16 __stdcall RegisterClassExW(const WNDCLASSEXW *lpwcx)") as (
  wndClass: {
    cbSize: number;
    style: number;
    lpfnWndProc: unknown;
    cbClsExtra: number;
    cbWndExtra: number;
    hInstance: unknown;
    hIcon: null;
    hCursor: null;
    hbrBackground: unknown;
    lpszMenuName: null;
    lpszClassName: string;
    hIconSm: null;
  }
) => number;

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
export const CreateSolidBrush = gdi32.func("void * __stdcall CreateSolidBrush(uint32 color)") as (color: number) => unknown;
export const DeleteObject = gdi32.func("bool __stdcall DeleteObject(void *ho)") as (handle: unknown) => boolean;
export const SendInput = user32.func(
  "uint32 __stdcall SendInput(uint32 cInputs, const INPUT *pInputs, int cbSize)"
) as (count: number, inputs: Array<{ type: number; _pad: number; ki: { wVk: number; wScan: number; dwFlags: number; time: number; dwExtraInfo: number } }>, cbSize: number) => number;
export const GetLastError = kernel32.func("uint32 __stdcall GetLastError()") as () => number;
export const OpenClipboard = user32.func("bool __stdcall OpenClipboard(void *hWndNewOwner)") as (hWnd: null) => boolean;
export const CloseClipboard = user32.func("bool __stdcall CloseClipboard()") as () => boolean;
export const EmptyClipboard = user32.func("bool __stdcall EmptyClipboard()") as () => boolean;
export const CountClipboardFormats = user32.func("int __stdcall CountClipboardFormats()") as () => number;
export const IsClipboardFormatAvailable = user32.func("bool __stdcall IsClipboardFormatAvailable(uint32 format)") as (format: number) => boolean;
export const EnumClipboardFormats = user32.func("uint32 __stdcall EnumClipboardFormats(uint32 format)") as (format: number) => number;
export const GetClipboardData = user32.func("void * __stdcall GetClipboardData(uint32 format)") as (format: number) => unknown;
export const SetClipboardData = user32.func("void * __stdcall SetClipboardData(uint32 format, void *hMem)") as (format: number, hMem: unknown) => unknown;
export const GetClipboardSequenceNumber = user32.func("uint32 __stdcall GetClipboardSequenceNumber()") as () => number;

export const GlobalSize = kernel32.func("size_t __stdcall GlobalSize(void *hMem)") as (hMem: unknown) => number;
export const GlobalLock = kernel32.func("void * __stdcall GlobalLock(void *hMem)") as (hMem: unknown) => unknown;
export const GlobalUnlock = kernel32.func("bool __stdcall GlobalUnlock(void *hMem)") as (hMem: unknown) => boolean;
export const GlobalAlloc = kernel32.func("void * __stdcall GlobalAlloc(uint32 uFlags, size_t dwBytes)") as (
  flags: number,
  bytes: number
) => unknown;
export const GlobalFree = kernel32.func("void * __stdcall GlobalFree(void *hMem)") as (hMem: unknown) => unknown;
export const RtlMoveMemory = kernel32.func("void __stdcall RtlMoveMemory(void *Destination, const void *Source, size_t Length)") as (
  destination: unknown,
  source: unknown,
  length: number
) => void;

export const INPUT_SIZE = koffi.sizeof(INPUT);
export const registerLowLevelKeyboardProc = (cb: (nCode: number, wParam: number, info: KbdLlHookStruct) => number): RegisteredCallback =>
  koffi.register(cb, koffi.pointer(LowLevelKeyboardProc));
export const unregisterCallback = (cb: RegisteredCallback): void => {
  koffi.unregister(cb);
};

export const registerWindowProc = (cb: (hWnd: unknown, msg: number, wParam: number | bigint, lParam: number | bigint) => number): RegisteredCallback =>
  koffi.register(cb, koffi.pointer(WindowProc));

export function rgb(red: number, green: number, blue: number): number {
  return (red & 0xff) | ((green & 0xff) << 8) | ((blue & 0xff) << 16);
}

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

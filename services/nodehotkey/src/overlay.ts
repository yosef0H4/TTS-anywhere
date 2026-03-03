import {
  CreateWindowExW,
  DestroyWindow,
  HWND_TOPMOST,
  InvalidateRect,
  SetWindowPos,
  ShowWindow,
  SS_BLACKRECT,
  SW_HIDE,
  SW_SHOWNA,
  SWP_NOACTIVATE,
  SWP_SHOWWINDOW,
  UpdateWindow,
  WS_EX_NOACTIVATE,
  WS_EX_TOOLWINDOW,
  WS_EX_TOPMOST,
  WS_EX_TRANSPARENT,
  WS_POPUP
} from "./win32-bindings.js";

export type RawRect = { left: number; top: number; right: number; bottom: number };

type BorderWindows = { top: unknown; right: unknown; bottom: unknown; left: unknown };

export class BorderOverlay {
  private readonly windows: BorderWindows;
  private readonly thickness: number;

  constructor(thickness: number) {
    this.thickness = Math.max(1, thickness);
    this.windows = {
      top: this.createBorderWindow(),
      right: this.createBorderWindow(),
      bottom: this.createBorderWindow(),
      left: this.createBorderWindow()
    };
  }

  private createBorderWindow(): unknown {
    const exStyle = WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE;
    const hwnd = CreateWindowExW(exStyle, "STATIC", "", WS_POPUP | SS_BLACKRECT, 0, 0, 1, 1, null, null, null, null);
    if (!hwnd) throw new Error("CreateWindowExW(STATIC) failed");
    return hwnd;
  }

  private positionWindow(hwnd: unknown, x: number, y: number, w: number, h: number): void {
    const width = Math.max(1, w);
    const height = Math.max(1, h);
    SetWindowPos(hwnd, HWND_TOPMOST, x, y, width, height, SWP_NOACTIVATE | SWP_SHOWWINDOW);
    ShowWindow(hwnd, SW_SHOWNA);
    InvalidateRect(hwnd, null, true);
    UpdateWindow(hwnd);
  }

  draw(rect: RawRect): void {
    const width = Math.max(1, rect.right - rect.left);
    const height = Math.max(1, rect.bottom - rect.top);
    const t = this.thickness;

    this.positionWindow(this.windows.top, rect.left, rect.top, width, t);
    this.positionWindow(this.windows.bottom, rect.left, rect.bottom - t, width, t);
    this.positionWindow(this.windows.left, rect.left, rect.top, t, height);
    this.positionWindow(this.windows.right, rect.right - t, rect.top, t, height);
  }

  hide(): void {
    ShowWindow(this.windows.top, SW_HIDE);
    ShowWindow(this.windows.right, SW_HIDE);
    ShowWindow(this.windows.bottom, SW_HIDE);
    ShowWindow(this.windows.left, SW_HIDE);
  }

  destroy(): void {
    this.hide();
    DestroyWindow(this.windows.top);
    DestroyWindow(this.windows.right);
    DestroyWindow(this.windows.bottom);
    DestroyWindow(this.windows.left);
  }
}

import {
  CreateWindowExW,
  DestroyWindow,
  HWND_TOPMOST,
  InvalidateRect,
  SS_BLACKRECT,
  SS_WHITERECT,
  SetWindowPos,
  ShowWindow,
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
  private readonly outerWindows: BorderWindows;
  private readonly innerWindows: BorderWindows;
  private readonly thickness: number;

  constructor(thickness: number) {
    this.thickness = Math.max(1, thickness);
    this.outerWindows = {
      top: this.createBorderWindow(SS_BLACKRECT),
      right: this.createBorderWindow(SS_BLACKRECT),
      bottom: this.createBorderWindow(SS_BLACKRECT),
      left: this.createBorderWindow(SS_BLACKRECT)
    };
    this.innerWindows = {
      top: this.createBorderWindow(SS_WHITERECT),
      right: this.createBorderWindow(SS_WHITERECT),
      bottom: this.createBorderWindow(SS_WHITERECT),
      left: this.createBorderWindow(SS_WHITERECT)
    };
  }

  private createBorderWindow(rectStyle: number): unknown {
    const exStyle = WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE;
    const hwnd = CreateWindowExW(exStyle, "STATIC", "", WS_POPUP | rectStyle, 0, 0, 1, 1, null, null, null, null);
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
    const innerLeft = rect.left + t;
    const innerTop = rect.top + t;
    const innerWidth = Math.max(1, width - t * 2);
    const innerHeight = Math.max(1, height - t * 2);

    this.positionWindow(this.outerWindows.top, rect.left, rect.top, width, t);
    this.positionWindow(this.outerWindows.bottom, rect.left, rect.bottom - t, width, t);
    this.positionWindow(this.outerWindows.left, rect.left, rect.top, t, height);
    this.positionWindow(this.outerWindows.right, rect.right - t, rect.top, t, height);

    this.positionWindow(this.innerWindows.top, innerLeft, innerTop, innerWidth, t);
    this.positionWindow(this.innerWindows.bottom, innerLeft, rect.bottom - t * 2, innerWidth, t);
    this.positionWindow(this.innerWindows.left, innerLeft, innerTop, t, innerHeight);
    this.positionWindow(this.innerWindows.right, rect.right - t * 2, innerTop, t, innerHeight);
  }

  hide(): void {
    ShowWindow(this.outerWindows.top, SW_HIDE);
    ShowWindow(this.outerWindows.right, SW_HIDE);
    ShowWindow(this.outerWindows.bottom, SW_HIDE);
    ShowWindow(this.outerWindows.left, SW_HIDE);
    ShowWindow(this.innerWindows.top, SW_HIDE);
    ShowWindow(this.innerWindows.right, SW_HIDE);
    ShowWindow(this.innerWindows.bottom, SW_HIDE);
    ShowWindow(this.innerWindows.left, SW_HIDE);
  }

  destroy(): void {
    this.hide();
    DestroyWindow(this.outerWindows.top);
    DestroyWindow(this.outerWindows.right);
    DestroyWindow(this.outerWindows.bottom);
    DestroyWindow(this.outerWindows.left);
    DestroyWindow(this.innerWindows.top);
    DestroyWindow(this.innerWindows.right);
    DestroyWindow(this.innerWindows.bottom);
    DestroyWindow(this.innerWindows.left);
  }
}

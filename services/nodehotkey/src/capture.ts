import { parseHotkeySpec } from "./hotkey-parser.js";
import { MOD_ALT, MOD_CONTROL, MOD_SHIFT, MOD_WIN } from "./hotkey-parser.js";
import { BorderOverlay, type RawRect } from "./overlay.js";
import type { CaptureRect, CaptureResult, HotkeySpec, NodeHotkeyOptions } from "./types.js";
import {
  ensureDpiAwareness,
  GetAsyncKeyState,
  GetCursorPos,
  PeekMessageW,
  PM_REMOVE,
  RegisterHotKey,
  UnregisterHotKey,
  WM_HOTKEY,
  type Point,
  type WinMsg
} from "./win32-bindings.js";

const HOTKEY_ID = 1;
const DEFAULT_HOTKEY = "ctrl+shift+alt+s";
const VK_SHIFT = 0x10;
const VK_CONTROL = 0x11;
const VK_MENU = 0x12;
const VK_LWIN = 0x5b;
const VK_RWIN = 0x5c;

type ScreenshotFn = (options?: { format?: "png" | "jpg" }) => Promise<Buffer>;

let screenshotFn: ScreenshotFn | null = null;

async function getScreenshotFn(): Promise<ScreenshotFn> {
  if (screenshotFn) return screenshotFn;
  const mod = await import("screenshot-desktop");
  screenshotFn = mod.default as ScreenshotFn;
  return screenshotFn;
}

function buildRect(a: Point, b: Point): RawRect {
  return {
    left: Math.min(a.x, b.x),
    top: Math.min(a.y, b.y),
    right: Math.max(a.x, b.x),
    bottom: Math.max(a.y, b.y)
  };
}

function rectEquals(a: RawRect, b: RawRect): boolean {
  return a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom;
}

export class NodeHotkey {
  private readonly pollMs: number;
  private readonly events: NodeHotkeyOptions["events"];
  private readonly overlay: BorderOverlay;

  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private activeHotkey: HotkeySpec;

  private captureActive = false;
  private dragStartPoint: Point | null = null;
  private lastCursorPoint: Point | null = null;
  private lastRenderedRect: RawRect | null = null;

  private pendingCaptureResolver: ((value: CaptureResult) => void) | null = null;
  private pendingCaptureRejecter: ((reason?: unknown) => void) | null = null;
  private triggerComboDown = false;

  constructor(options: NodeHotkeyOptions = {}) {
    if (process.platform !== "win32") throw new Error("nodehotkey is Windows-only");

    this.pollMs = options.pollMs ?? 16;
    this.events = options.events;
    this.overlay = new BorderOverlay(options.borderThickness ?? 2);
    this.activeHotkey = parseHotkeySpec(options.initialHotkey ?? DEFAULT_HOTKEY);
  }

  start(): void {
    if (this.running) return;
    ensureDpiAwareness();

    this.tryRegisterHotkey(this.activeHotkey);
    this.events?.onHotkeyRegistered?.(this.activeHotkey.label);

    this.running = true;
    this.timer = setInterval(() => {
      this.tick();
    }, this.pollMs);
  }

  stop(): void {
    if (!this.running) {
      this.overlay.destroy();
      return;
    }

    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    this.resetCaptureState();
    UnregisterHotKey(null, HOTKEY_ID);
    this.overlay.destroy();

    if (this.pendingCaptureRejecter) {
      this.pendingCaptureRejecter(new Error("nodehotkey stopped"));
      this.pendingCaptureRejecter = null;
      this.pendingCaptureResolver = null;
    }
  }

  setHotkey(hotkey: string): void {
    const next = parseHotkeySpec(hotkey);
    const previous = this.activeHotkey;

    UnregisterHotKey(null, HOTKEY_ID);
    try {
      this.tryRegisterHotkey(next);
      this.activeHotkey = next;
      this.events?.onHotkeySwitched?.(next.label);
    } catch (error) {
      this.tryRegisterHotkey(previous);
      throw error;
    }
  }

  getHotkey(): string {
    return this.activeHotkey.label;
  }

  captureOnce(): Promise<CaptureResult> {
    if (!this.running) return Promise.reject(new Error("nodehotkey is not started"));
    if (this.pendingCaptureResolver) return Promise.reject(new Error("captureOnce already pending"));

    return new Promise<CaptureResult>((resolve, reject) => {
      this.pendingCaptureResolver = resolve;
      this.pendingCaptureRejecter = reject;
    });
  }

  private tryRegisterHotkey(spec: HotkeySpec): void {
    const ok = RegisterHotKey(null, HOTKEY_ID, spec.modifiers, spec.vk);
    if (!ok) throw new Error(`RegisterHotKey failed for ${spec.label}`);
  }

  private tick(): void {
    if (!this.running) return;

    let startedByMessage = false;
    const msg: WinMsg = {};
    while (PeekMessageW(msg, null, WM_HOTKEY, WM_HOTKEY, PM_REMOVE)) {
      if (msg.message === WM_HOTKEY && Number(msg.wParam) === HOTKEY_ID && !this.captureActive) {
        this.startCapture();
        startedByMessage = true;
      }
    }

    if (!startedByMessage && !this.captureActive) {
      const comboDown = this.isTriggerComboDown();
      if (comboDown && !this.triggerComboDown) {
        this.startCapture();
      }
      this.triggerComboDown = comboDown;
    } else if (this.captureActive) {
      this.triggerComboDown = false;
    }

    if (this.captureActive) {
      const keyDown = (GetAsyncKeyState(this.activeHotkey.releaseVk) & 0x8000) !== 0;
      if (keyDown) this.updateCapture();
      else void this.finalizeCapture();
    }
  }

  private isTriggerComboDown(): boolean {
    const mods = this.activeHotkey.modifiers;
    if ((mods & MOD_CONTROL) !== 0 && (GetAsyncKeyState(VK_CONTROL) & 0x8000) === 0) return false;
    if ((mods & MOD_SHIFT) !== 0 && (GetAsyncKeyState(VK_SHIFT) & 0x8000) === 0) return false;
    if ((mods & MOD_ALT) !== 0 && (GetAsyncKeyState(VK_MENU) & 0x8000) === 0) return false;
    if ((mods & MOD_WIN) !== 0) {
      const lWinDown = (GetAsyncKeyState(VK_LWIN) & 0x8000) !== 0;
      const rWinDown = (GetAsyncKeyState(VK_RWIN) & 0x8000) !== 0;
      if (!lWinDown && !rWinDown) return false;
    }
    return (GetAsyncKeyState(this.activeHotkey.vk) & 0x8000) !== 0;
  }

  private startCapture(): void {
    const point: Point = { x: 0, y: 0 };
    if (!GetCursorPos(point)) {
      this.emitError(new Error("GetCursorPos failed at capture start"));
      this.resetCaptureState();
      return;
    }

    this.dragStartPoint = { x: point.x, y: point.y };
    this.lastCursorPoint = { x: point.x, y: point.y };
    this.lastRenderedRect = null;
    this.captureActive = true;
    this.overlay.hide();
    this.events?.onCaptureStart?.({ x: point.x, y: point.y, hotkey: this.activeHotkey.label });
  }

  private updateCapture(): void {
    if (!this.dragStartPoint) return;

    const point: Point = { x: 0, y: 0 };
    if (!GetCursorPos(point)) return;

    this.lastCursorPoint = { x: point.x, y: point.y };
    const nextRect = buildRect(this.dragStartPoint, this.lastCursorPoint);
    if (nextRect.right <= nextRect.left || nextRect.bottom <= nextRect.top) return;

    if (!this.lastRenderedRect || !rectEquals(this.lastRenderedRect, nextRect)) {
      this.overlay.draw(nextRect);
      this.lastRenderedRect = nextRect;
    }
  }

  private async finalizeCapture(): Promise<void> {
    if (!this.captureActive || !this.dragStartPoint || !this.lastCursorPoint) {
      this.resetCaptureState();
      return;
    }

    const rect = buildRect(this.dragStartPoint, this.lastCursorPoint);
    const captureRect: CaptureRect = {
      x: rect.left,
      y: rect.top,
      width: rect.right - rect.left,
      height: rect.bottom - rect.top
    };

    this.events?.onCaptureFinalize?.(captureRect);
    this.resetCaptureState();

    if (captureRect.width < 1 || captureRect.height < 1) {
      this.emitError(new Error("Selection rectangle has zero area"));
      return;
    }

    try {
      const screenshot = await getScreenshotFn();
      const sharpMod = await import("sharp");
      const sharp = sharpMod.default;
      const desktopPng = await screenshot({ format: "png" });
      const pngBuffer = await sharp(desktopPng)
        .extract({
          left: captureRect.x,
          top: captureRect.y,
          width: captureRect.width,
          height: captureRect.height
        })
        .png()
        .toBuffer();

      if (this.pendingCaptureResolver) {
        this.pendingCaptureResolver({ rect: captureRect, pngBuffer });
        this.pendingCaptureResolver = null;
        this.pendingCaptureRejecter = null;
      }
    } catch (error) {
      this.emitError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private emitError(error: Error): void {
    this.events?.onError?.(error);
    if (this.pendingCaptureRejecter) {
      this.pendingCaptureRejecter(error);
      this.pendingCaptureRejecter = null;
      this.pendingCaptureResolver = null;
    }
  }

  private resetCaptureState(): void {
    this.overlay.hide();
    this.captureActive = false;
    this.dragStartPoint = null;
    this.lastCursorPoint = null;
    this.lastRenderedRect = null;
  }
}

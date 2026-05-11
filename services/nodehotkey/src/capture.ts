import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { CaptureCropRect, FrozenCaptureHandle, MonitorBounds, WindowHandle, WindowInfo } from "./types.js";
import {
  ClientToScreen,
  GetClientRect,
  GetForegroundWindow,
  GetLastError,
  GetWindowRect,
  IsIconic,
  IsWindow,
  ensureDpiAwareness,
  type Rect
} from "./win32-bindings.js";

type NativeFrozenCaptureHandle = FrozenCaptureHandle;

type NativeCaptureModule = {
  captureWindowRegion(targetWindow: WindowHandle, rect: CaptureCropRect): Buffer;
  captureMonitorAtPoint(x: number, y: number): Buffer;
  beginFrozenMonitorCaptureAtPoint(x: number, y: number): NativeFrozenCaptureHandle;
  cropFrozenCapture(id: number, rect: CaptureCropRect): Buffer;
  disposeFrozenCapture(id: number): void;
  getMonitorBoundsAtPoint(x: number, y: number): MonitorBounds;
  getForegroundWindowBounds(): MonitorBounds;
};

let captureModule: NativeCaptureModule | null | undefined;

function resolveCaptureAddonPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const packageRoot = path.resolve(here, "..");
  const candidates = [
    path.join(packageRoot, "build", "Release", "nodehotkey_capture.node"),
    path.join(packageRoot, "build", "Debug", "nodehotkey_capture.node")
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    `nodehotkey native capture addon not found. Expected one of: ${candidates.join(", ")}`
  );
}

function loadCaptureModule(): NativeCaptureModule {
  if (captureModule) return captureModule;
  if (captureModule === null) throw new Error("nodehotkey native capture addon is unavailable");
  if (process.platform !== "win32") {
    captureModule = null;
    throw new Error("nodehotkey native capture addon is Windows-only");
  }

  const require = createRequire(import.meta.url);
  const addonPath = resolveCaptureAddonPath();
  const loaded = require(addonPath) as Partial<NativeCaptureModule>;
  if (
    typeof loaded.captureWindowRegion !== "function" ||
    typeof loaded.captureMonitorAtPoint !== "function" ||
    typeof loaded.beginFrozenMonitorCaptureAtPoint !== "function" ||
    typeof loaded.cropFrozenCapture !== "function" ||
    typeof loaded.disposeFrozenCapture !== "function" ||
    typeof loaded.getMonitorBoundsAtPoint !== "function"
  ) {
    captureModule = null;
    throw new Error(`nodehotkey native capture addon at ${addonPath} does not expose the expected API`);
  }

  captureModule = loaded as NativeCaptureModule;
  return captureModule;
}

export async function captureMonitorAtPoint(x: number, y: number): Promise<Buffer> {
  return loadCaptureModule().captureMonitorAtPoint(x, y);
}

export async function captureWindowRegion(targetWindow: WindowHandle, rect: CaptureCropRect): Promise<Buffer> {
  return loadCaptureModule().captureWindowRegion(targetWindow, rect);
}

export async function beginFrozenMonitorCaptureAtPoint(x: number, y: number): Promise<FrozenCaptureHandle> {
  return loadCaptureModule().beginFrozenMonitorCaptureAtPoint(x, y);
}

export async function cropFrozenCapture(id: number, rect: CaptureCropRect): Promise<Buffer> {
  return loadCaptureModule().cropFrozenCapture(id, rect);
}

export function disposeFrozenCapture(id: number): void {
  loadCaptureModule().disposeFrozenCapture(id);
}

export function getMonitorBoundsAtPoint(x: number, y: number): MonitorBounds {
  return loadCaptureModule().getMonitorBoundsAtPoint(x, y);
}

export function getForegroundWindowBounds(): MonitorBounds {
  return loadCaptureModule().getForegroundWindowBounds();
}

function rectToBounds(rect: Rect): MonitorBounds {
  const width = rect.right - rect.left;
  const height = rect.bottom - rect.top;
  if (width <= 0 || height <= 0) {
    throw new Error("Window has empty bounds");
  }
  return {
    left: rect.left,
    top: rect.top,
    width,
    height
  };
}

function getClientBounds(handle: WindowHandle): MonitorBounds {
  const clientRect: Rect = { left: 0, top: 0, right: 0, bottom: 0 };
  if (!GetClientRect(handle, clientRect)) {
    throw new Error(`GetClientRect failed (lastError=${GetLastError()})`);
  }
  const topLeft = { x: clientRect.left, y: clientRect.top };
  const bottomRight = { x: clientRect.right, y: clientRect.bottom };
  if (!ClientToScreen(handle, topLeft) || !ClientToScreen(handle, bottomRight)) {
    throw new Error(`ClientToScreen failed (lastError=${GetLastError()})`);
  }
  return rectToBounds({
    left: topLeft.x,
    top: topLeft.y,
    right: bottomRight.x,
    bottom: bottomRight.y
  });
}

export function getWindowInfo(handle: WindowHandle): WindowInfo {
  ensureDpiAwareness();
  if (!IsWindow(handle)) {
    throw new Error("Window handle is invalid");
  }
  const rect: Rect = { left: 0, top: 0, right: 0, bottom: 0 };
  if (!GetWindowRect(handle, rect)) {
    throw new Error(`GetWindowRect failed (lastError=${GetLastError()})`);
  }
  return {
    handle,
    bounds: rectToBounds(rect),
    clientBounds: getClientBounds(handle),
    minimized: IsIconic(handle)
  };
}

export function getForegroundWindowInfo(): WindowInfo {
  ensureDpiAwareness();
  const handle = GetForegroundWindow();
  if (!handle) {
    throw new Error("No foreground window found");
  }
  return getWindowInfo(handle);
}

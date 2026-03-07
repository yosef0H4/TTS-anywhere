import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { CaptureCropRect, FrozenCaptureHandle, MonitorBounds } from "./types.js";

type NativeFrozenCaptureHandle = FrozenCaptureHandle;

type NativeCaptureModule = {
  captureMonitorAtPoint(x: number, y: number): Buffer;
  beginFrozenMonitorCaptureAtPoint(x: number, y: number): NativeFrozenCaptureHandle;
  cropFrozenCapture(id: number, rect: CaptureCropRect): Buffer;
  disposeFrozenCapture(id: number): void;
  getMonitorBoundsAtPoint(x: number, y: number): MonitorBounds;
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

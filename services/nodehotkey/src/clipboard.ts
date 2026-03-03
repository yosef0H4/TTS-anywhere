import crypto from "node:crypto";
import type {
  ClipboardRestoreResult,
  ClipboardSnapshot,
  ClipboardWaitOptions,
  CopyCaptureOptions,
  CopyCaptureResult
} from "./types.js";
import {
  CF_HDROP,
  CF_UNICODETEXT,
  CloseClipboard,
  EmptyClipboard,
  EnumClipboardFormats,
  GetClipboardData,
  GetClipboardSequenceNumber,
  GlobalAlloc,
  GlobalLock,
  GlobalSize,
  GlobalUnlock,
  GMEM_MOVEABLE,
  GMEM_ZEROINIT,
  IsClipboardFormatAvailable,
  OpenClipboard,
  RtlMoveMemory,
  SetClipboardData
} from "./win32-bindings.js";
import { sendHotkey } from "./send.js";

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withOpenClipboard<T>(fn: () => T, timeoutMs = 300): Promise<T> {
  const startedAt = Date.now();
  for (;;) {
    if (OpenClipboard(null)) {
      try {
        return fn();
      } finally {
        CloseClipboard();
      }
    }
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error("Failed to open clipboard");
    }
    await sleepMs(8);
  }
}

function readUnicodeTextUnlocked(): string {
  const handle = GetClipboardData(CF_UNICODETEXT);
  if (!handle) return "";
  const size = GlobalSize(handle);
  if (!size || size <= 1) return "";
  const ptr = GlobalLock(handle);
  if (!ptr) return "";
  try {
    const bytes = Buffer.alloc(size);
    RtlMoveMemory(bytes, ptr, size);
    const utf16 = bytes.toString("utf16le");
    const nullAt = utf16.indexOf("\u0000");
    return nullAt >= 0 ? utf16.slice(0, nullAt) : utf16;
  } finally {
    GlobalUnlock(handle);
  }
}

function buildSignature(formats: ClipboardSnapshot["formats"]): string {
  const hash = crypto.createHash("sha256");
  const sorted = [...formats].sort((a, b) => a.format - b.format);
  for (const entry of sorted) {
    hash.update(String(entry.format), "utf8");
    hash.update(Buffer.from([0]));
    hash.update(entry.data);
    hash.update(Buffer.from([0xff]));
  }
  return hash.digest("hex");
}

export async function snapshotClipboard(): Promise<ClipboardSnapshot> {
  return withOpenClipboard(() => {
    const advertisedFormats: number[] = [];
    const skippedFormats: ClipboardSnapshot["skippedFormats"] = [];
    const formats: ClipboardSnapshot["formats"] = [];

    let format = 0;
    for (;;) {
      format = EnumClipboardFormats(format);
      if (!format) break;
      advertisedFormats.push(format);

      const handle = GetClipboardData(format);
      if (!handle) {
        skippedFormats.push({ format, reason: "GetClipboardData returned null" });
        continue;
      }

      const size = GlobalSize(handle);
      if (!size) {
        skippedFormats.push({ format, reason: "GlobalSize returned 0" });
        continue;
      }

      const ptr = GlobalLock(handle);
      if (!ptr) {
        skippedFormats.push({ format, reason: "GlobalLock failed" });
        continue;
      }

      try {
        const data = Buffer.alloc(size);
        RtlMoveMemory(data, ptr, size);
        formats.push({ format, size, data });
      } finally {
        GlobalUnlock(handle);
      }
    }

    const plainText = readUnicodeTextUnlocked();
    return {
      advertisedFormats,
      skippedFormats,
      formats,
      plainText,
      signature: buildSignature(formats),
      capturedAt: Date.now()
    };
  });
}

export async function restoreClipboard(snapshot: ClipboardSnapshot): Promise<ClipboardRestoreResult> {
  return withOpenClipboard(() => {
    const failedFormats: number[] = [];
    let restoredCount = 0;
    EmptyClipboard();

    for (const entry of snapshot.formats) {
      const allocSize = Math.max(1, entry.size);
      const mem = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, allocSize);
      if (!mem) {
        failedFormats.push(entry.format);
        continue;
      }

      if (entry.size > 0) {
        const locked = GlobalLock(mem);
        if (!locked) {
          failedFormats.push(entry.format);
          continue;
        }
        try {
          RtlMoveMemory(locked, entry.data, entry.size);
        } finally {
          GlobalUnlock(mem);
        }
      }

      const result = SetClipboardData(entry.format, mem);
      if (!result) {
        failedFormats.push(entry.format);
        continue;
      }
      restoredCount += 1;
    }

    return { restoredCount, failedFormats };
  });
}

export async function clearClipboard(): Promise<void> {
  await withOpenClipboard(() => {
    EmptyClipboard();
  });
}

export async function readClipboardText(): Promise<string> {
  return withOpenClipboard(() => readUnicodeTextUnlocked());
}

function hasTextOrFilesData(): boolean {
  return IsClipboardFormatAvailable(CF_UNICODETEXT) || IsClipboardFormatAvailable(CF_HDROP);
}

export async function waitForClipboardChange(
  previousSignature: string,
  options: ClipboardWaitOptions = {}
): Promise<boolean> {
  const timeoutMs = Math.max(0, Math.floor(options.timeoutMs ?? 5000));
  const pollMs = Math.max(5, Math.floor(options.pollMs ?? 25));
  const mode = options.mode ?? "text_or_files";

  const startSeq = GetClipboardSequenceNumber();
  const startedAt = Date.now();

  for (;;) {
    const now = Date.now();
    if (now - startedAt > timeoutMs) return false;

    const changedBySeq = GetClipboardSequenceNumber() !== startSeq;
    if (changedBySeq) {
      if (mode === "any") return true;
      if (hasTextOrFilesData()) return true;
    } else {
      const current = await snapshotClipboard();
      if (current.signature !== previousSignature) {
        if (mode === "any") return true;
        if (hasTextOrFilesData()) return true;
      }
    }
    await sleepMs(pollMs);
  }
}

export async function captureCopyToText(options: CopyCaptureOptions = {}): Promise<CopyCaptureResult> {
  const copyHotkey = options.copyHotkey ?? "ctrl+c";
  const restoreClipboardEnabled = options.restoreClipboard ?? true;
  const timeoutMs = options.timeoutMs ?? 5000;
  const pollMs = options.pollMs ?? 25;
  const waitMode = options.waitMode ?? "text_or_files";

  const sequenceBeforeClear = GetClipboardSequenceNumber();
  const snapshot = await snapshotClipboard();
  await clearClipboard();
  const sequenceAfterClear = GetClipboardSequenceNumber();
  const cleared = await snapshotClipboard();

  let changed = false;
  let changedBySequence = false;
  let text = "";
  let restoreResult: ClipboardRestoreResult | undefined;
  let postRestoreText: string | undefined;
  let sequenceAfterCopy = GetClipboardSequenceNumber();
  try {
    await sendHotkey(copyHotkey);
    sequenceAfterCopy = GetClipboardSequenceNumber();
    changedBySequence = sequenceAfterCopy !== sequenceAfterClear;
    changed = await waitForClipboardChange(cleared.signature, {
      timeoutMs,
      pollMs,
      mode: waitMode
    });
    text = changed ? await readClipboardText() : "";
  } finally {
    if (restoreClipboardEnabled) {
      restoreResult = await restoreClipboard(snapshot);
      postRestoreText = await readClipboardText();
    }
  }

  const result: CopyCaptureResult = {
    changed,
    text,
    snapshot,
    clearedSignature: cleared.signature,
    changedBySequence,
    sequenceBeforeClear,
    sequenceAfterClear,
    sequenceAfterCopy
  };
  if (restoreResult) result.restore = restoreResult;
  if (typeof postRestoreText === "string") result.postRestoreText = postRestoreText;
  return result;
}

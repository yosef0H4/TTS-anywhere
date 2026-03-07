# nodehotkey

Windows-only Node/Electron helper for:
- global hotkey registration
- on-screen rectangle drawing primitives
- monitor capture primitives backed by a native addon

## Usage

```ts
import { BorderOverlay, HotkeySession } from "nodehotkey";

const overlay = new BorderOverlay(2);
const session = new HotkeySession({
  initialHotkey: "ctrl+shift+alt+s",
  events: {
    onTriggerDown: (start) => console.log("start", start),
    onTriggerUp: (end) => console.log("end", end)
  }
});
session.start();
```

## Monitor capture

```ts
import {
  beginFrozenMonitorCaptureAtPoint,
  cropFrozenCapture,
  disposeFrozenCapture
} from "nodehotkey";

const frozen = await beginFrozenMonitorCaptureAtPoint(120, 240);
const png = await cropFrozenCapture(frozen.id, {
  x: 0,
  y: 0,
  width: frozen.bounds.width,
  height: frozen.bounds.height
});
disposeFrozenCapture(frozen.id);
```

The capture addon is Windows-only and must be built separately with:

```bash
npm run build:native
```

## Simulate hotkeys

```ts
import { sendHotkey } from "nodehotkey";

await sendHotkey("ctrl+c");
await sendHotkey("enter");
await sendHotkey("win+shift+s");
```

`sendHotkey` sends key press/release to the currently focused window.

## Clipboard management

```ts
import { captureCopyToText, snapshotClipboard, restoreClipboard } from "nodehotkey";

const saved = await snapshotClipboard();
const result = await captureCopyToText({
  copyHotkey: "ctrl+c",
  timeoutMs: 5000,
  waitMode: "any",
  restoreClipboard: true
});
console.log(result.text);

// You can also restore manually:
await restoreClipboard(saved);
```

Clipboard restore is best-effort for all available formats.

## Supported hotkey syntax
- Modifiers: `ctrl`, `shift`, `alt`, `win`
- Keys: `a-z`, `0-9`, `f1-f24`, `tab`, `space`, `enter`, `esc`, arrows

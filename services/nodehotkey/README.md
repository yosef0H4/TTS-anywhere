# nodehotkey

Windows-only Node/Electron helper for:
- global hotkey registration
- AHK-style rectangle preview while key is held
- screenshot capture of selected rectangle

## Usage

```ts
import { NodeHotkey } from "nodehotkey";

const hk = new NodeHotkey({ initialHotkey: "ctrl+shift+alt+s" });
hk.start();
const result = await hk.captureOnce();
console.log(result.rect, result.pngBuffer.length);
hk.stop();
```

## Supported hotkey syntax
- Modifiers: `ctrl`, `shift`, `alt`, `win`
- Keys: `a-z`, `0-9`, `f1-f24`, `tab`, `space`, `enter`, `esc`, arrows

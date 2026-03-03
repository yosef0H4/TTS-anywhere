# Win32 Rectangle Test (Node.js)

Global `Ctrl+Shift+Alt+S` hotkey, AHK-style border preview, and screenshot save.

## Run
cd services/win32-dot-test
npm install
npm start

## Behavior
- Default hotkey is `Ctrl+Shift+Alt+S`.
- Hold the active hotkey to start selection.
- Live rectangle preview appears while holding.
- Release the hotkey base key to finalize.
- Prints `x,y,width,height` and saves PNG to `screenshots/`.

## CLI
- `npm start -- --hotkey "ctrl+shift+alt+s"`
  - Set one custom hotkey.
  - Requires at least one modifier.
- `npm start -- --test-hotkeys`
  - Enables rotation across 5 hotkeys after each successful screenshot:
  - `ctrl+shift+alt+s -> alt+q -> ctrl+shift+x -> ctrl+alt+z -> shift+f8`
  - If both `--test-hotkeys` and `--hotkey` are passed, test mode takes precedence.

# Win32 Rectangle Test (Node.js)

Global `Ctrl+Shift+Alt+S` hotkey, AHK-style border preview, and screenshot save.

## Run
cd services/win32-dot-test
npm install
npm start

## Behavior
- `Ctrl+Shift+Alt+S` is registered as a global hotkey.
- Hold `Ctrl+Shift+Alt+S` to start selection.
- Live rectangle preview appears while holding.
- Release `S` to finalize.
- Prints `x,y,width,height` and saves PNG to `screenshots/`.

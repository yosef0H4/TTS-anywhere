# preproc-electron

Experimental Electron/Web app for validating image preprocessing + text-region detection before integrating into the main app.

## Scope
- Electron/web renderer handles UI, upload/paste input, and overlay drawing.
- Python server handles preprocessing + RapidOCR detection only.
- No OCR text extraction and no TTS.

## Run

### 1) Python server
```bash
cd python-server
uv sync
uv run preproc-server serve --host 127.0.0.1 --port 8091
```

### 2) Web app (recommended for feedback loop)
```bash
npm install
npm run dev:web
```

### 3) Electron app
```bash
npm run dev:electron
```

## Agent harness

- Console API: `window.lab` (see [docs/console-api.md](/mnt/z/files/projects/js/tts-electron/experiments/preproc-electron/docs/console-api.md))
- Playwright checks: `npm run test:e2e`
- Iteration workflow: [docs/agent-loop.md](/mnt/z/files/projects/js/tts-electron/experiments/preproc-electron/docs/agent-loop.md)

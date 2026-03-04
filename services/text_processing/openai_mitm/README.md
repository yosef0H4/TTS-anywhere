# OpenAI MITM Proxy

OpenAI-compatible pass-through proxy for debugging OCR requests from Electron.

## What it does
- Accepts OpenAI-style requests under `/v1/*`
- Forwards to upstream (`--upstream`)
- Logs request/response metadata
- Saves incoming `image_url` data-URL images to disk

## Quick start

```bash
cd services/text_processing/openai_mitm
uv sync
uv run openai-mitm-proxy serve --host 127.0.0.1 --port 8109 --upstream https://api.openai.com --api-key YOUR_KEY
```

Then in Electron settings:
- OCR Base URL: `http://127.0.0.1:8109/v1`
- OCR API Key: any value (proxy can override auth with `--api-key`)

Logs are written to `.mitm-logs/openai/` by default.

## Windows
Use `run_server_win.bat` for setup + run.

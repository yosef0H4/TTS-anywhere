# Hiro-MOSS OCR Service

GPU-only OpenAI-compatible OCR service for `PatSnap/Hiro-MOSS-OCR-0.3B`.

The model card lists English, Japanese, and Chinese support. Use Katib for Arabic OCR in this repo.

## Basic Test

```powershell
.\.venv-gpu\Scripts\python.exe basic_usage_test.py --image ..\..\..\test-fixtures\ocr\english-basic.png
```

## Start API

```powershell
uv run python launcher.py --host 127.0.0.1 --port 8098
```

Endpoints:

- `GET /healthz`
- `GET /v1/models`
- `POST /v1/chat/completions`

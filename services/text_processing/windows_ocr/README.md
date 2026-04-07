# Windows OCR Text Processing Server

Windows-only OpenAI-compatible OCR service built on the native `Windows.Media.Ocr` API.

## What This Service Does

- exposes `/healthz`
- exposes `/v1/models`
- exposes `/v1/chat/completions`
- uses the Windows OCR language packs installed on the host
- starts through `launcher.py`, which provisions a managed `.venv`

## Requirements

- Windows 10 or newer
- `uv` installed or the bundled `uv.exe` from TTS Anywhere
- Python version matching `.python-version`
- At least one installed Windows OCR language pack

## Quick Start

Use the helper script for the supported Windows path:

```bat
scripts\host.bat 127.0.0.1 8097
```

## Manual Launch

Create the managed environment:

```bat
uv venv .venv --python 3.11
```

Start the launcher:

```bat
.\.venv\Scripts\python.exe launcher.py --host 127.0.0.1 --port 8097
```

Optional language override:

```bat
.\.venv\Scripts\python.exe launcher.py --host 127.0.0.1 --port 8097 --language en-US
```

## API Endpoints

- `GET /healthz`
- `GET /v1/models`
- `POST /v1/chat/completions`

## Verification

Health check:

```bash
curl http://127.0.0.1:8097/healthz
```

List models:

```bash
curl http://127.0.0.1:8097/v1/models
```

OCR request:

```bash
curl -X POST http://127.0.0.1:8097/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"windows-media-ocr\",\"messages\":[{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"Extract all text from this image.\"},{\"type\":\"image_url\",\"image_url\":{\"url\":\"data:image/png;base64,<BASE64_IMAGE>\"}}]}]}"
```

## Notes

- This service is OCR-only. It does not implement `/v1/detect`.
- The runtime selects the OCR language in this order:
  - explicit `--language`
  - Windows user profile OCR languages
  - first available installed OCR language
- Images smaller than 40 pixels on either side are upscaled before OCR.
- Images larger than `OcrEngine.MaxImageDimension` are rejected.

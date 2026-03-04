# Rapid Text Processing Server

Detect-only RapidOCR service for the main app preprocessing flow.

## Run

```bash
uv sync
uv run rapid-text-processing serve --host 127.0.0.1 --port 8091
```

## Endpoints
- `GET /healthz`
- `POST /v1/detect`

`/v1/detect` returns detected boxes in both pixel and normalized coordinates.

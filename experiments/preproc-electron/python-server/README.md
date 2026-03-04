# preproc-server

FastAPI server for image preprocessing + RapidOCR text-region detection only.

## Run

```bash
uv sync
uv run preproc-server serve --host 127.0.0.1 --port 8091
```

## Endpoints

- `GET /healthz`
- `POST /v1/detect` (`multipart/form-data` with `image`, `settings`)

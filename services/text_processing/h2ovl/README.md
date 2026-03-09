# H2OVL Text Processing Server

GPU-only OpenAI-compatible OCR service for `h2oai/h2ovl-mississippi-800m`.

## Why

- wraps the Mississippi 800M VLM behind `/v1/models` and `/v1/chat/completions`
- uses direct `transformers` loading with `trust_remote_code=True`
- refuses to start without CUDA
- supports both normal completions and SSE streaming

## Run

Windows:

```bat
scripts\host.bat 127.0.0.1 8095
```

Direct Windows launch without creating the default `.venv`:

```bat
scripts\host.bat 127.0.0.1 8095
```

## Endpoints

- `GET /healthz`
- `GET /v1/models`
- `POST /v1/chat/completions`

## Notes

- GPU is mandatory; startup fails if CUDA is unavailable
- default model is fixed to `h2oai/h2ovl-mississippi-800m`
- Windows support is pinned to Python `3.11` + Torch `2.8.0` + CUDA `12.9`
- the host script uses `uv` only; no system Python install is required
- the service pins Python with `.python-version`; the host script ensures `.venv-gpu` exists and then runs `launcher.py` inside that env
- that Windows tuple is chosen to match the available prebuilt Flash-Attention wheel set
- `launcher.py` installs the torch-dependent Python stack separately, using the known-good `EyeHearYou` Mississippi setup (`transformers 4.57.3`, `accelerate 1.12.0`, `timm 1.0.24`, `peft 0.18.1`)
- the host script and launcher manage a dedicated `.venv-gpu`
- on Windows it prefers the matching prebuilt Flash-Attention wheel and falls back to SDPA if that wheel cannot be installed
- do not launch this service with `uv run ...` if you want to avoid creating the default `.venv`

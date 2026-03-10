# H2OVL Text Processing Server

GPU-only OpenAI-compatible OCR service for `h2oai/h2ovl-mississippi-800m`.

## What This Service Does

- serves OCR through OpenAI-style endpoints
- exposes `/v1/models` and `/v1/chat/completions`
- manages a dedicated GPU runtime in `.venv-gpu`
- starts through `launcher.py`, which installs the pinned Torch and transformer stack before booting the API

## Requirements

- Windows with a CUDA-capable GPU
- `uv` installed or the bundled `uv.exe` from TTS Anywhere
- Python `3.11` for the managed Windows environment

## Quick Start

Use the helper script if you just want the supported Windows path:

```bat
scripts\host.bat 127.0.0.1 8095
```

That script creates `.venv-gpu` if it does not exist, then runs `launcher.py`.

## What The Launcher Script Does

`scripts\host.bat` is only a wrapper. Its job is:

1. find `uv` from the TTS Anywhere install or from `PATH`
2. read the pinned version from `.python-version`
3. create `.venv-gpu` if needed
4. run:

```bat
".venv-gpu\Scripts\python.exe" launcher.py --host 127.0.0.1 --port 8095
```

`launcher.py` then does the heavy lifting:

- runs `uv sync --group dev --inexact` inside `.venv-gpu`
- installs the pinned CUDA torch stack:
  - `torch==2.8.0`
  - `torchvision==0.23.0`
- installs the pinned H2OVL runtime packages:
  - `transformers==4.57.3`
  - `accelerate==1.12.0`
  - `timm==1.0.24`
  - `peft==0.18.1`
- tries to install the Windows Flash-Attention wheel
- verifies CUDA is actually available
- finally launches:

```bat
".venv-gpu\Scripts\python.exe" -m h2ovl_text_processing.cli serve --host 127.0.0.1 --port 8095
```

## Manual Launch Without The .bat Script

Do this if you want to run the service yourself and keep the same managed environment flow as the app.

### 1. Create the managed GPU environment

The pinned Python version is stored in `.python-version`. On this service it is expected to resolve to Python `3.11` on Windows.

```bat
uv venv .venv-gpu --python 3.11
```

### 2. Start the launcher manually

```bat
.\.venv-gpu\Scripts\python.exe launcher.py --host 127.0.0.1 --port 8095
```

This is the real non-batch equivalent of `scripts\host.bat`.

### 3. Direct CLI start after the launcher has prepared the environment

If you already have a working `.venv-gpu` and want to skip the launcher step on later runs:

```bat
set HF_HOME=%CD%\.hf-cache
set PYTHONPATH=%CD%\src
.\.venv-gpu\Scripts\python.exe -m h2ovl_text_processing.cli serve --host 127.0.0.1 --port 8095
```

This starts the API directly, but it does not recreate the launcher's package repair logic. Use `launcher.py` when you want the supported managed startup path.

### Why not `uv run ...`?

Avoid `uv run -m h2ovl_text_processing.cli ...` here if your goal is to reuse the managed `.venv-gpu`. `uv run` can create or use the default project `.venv`, which is not the environment this service expects for the pinned GPU setup.

## API Endpoints

- `GET /healthz`
- `GET /v1/models`
- `POST /v1/chat/completions`

## Verification

Health check:

```bash
curl http://127.0.0.1:8095/healthz
```

List models:

```bash
curl http://127.0.0.1:8095/v1/models
```

OCR request:

```bash
curl -X POST http://127.0.0.1:8095/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"h2oai/h2ovl-mississippi-800m\",\"messages\":[{\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"Extract all text from this image. Return only the extracted text.\"},{\"type\":\"input_image\",\"image_url\":\"data:image/png;base64,<BASE64_IMAGE>\"}]}]}"
```

## Troubleshooting

- `H2OVL requires a CUDA GPU and will not start without one.`
  Use a CUDA-capable GPU. This service refuses CPU startup.
- `H2OVL Windows support is pinned to Python 3.11`
  Recreate `.venv-gpu` with the version from `.python-version`.
- First startup is slow
  The launcher may install Torch, transformer packages, Flash-Attention, and Hugging Face assets.
- `uv run` created the wrong environment
  Delete the unintended `.venv` and use `.venv-gpu` plus `launcher.py` instead.
- Flash-Attention install failed
  The launcher falls back to SDPA automatically. The service can still run without Flash-Attention.

## Notes

- GPU is mandatory.
- Default model id is `h2oai/h2ovl-mississippi-800m`.
- The launcher stores Hugging Face cache data under `.hf-cache`.
- The service supports both standard and streaming completion responses.

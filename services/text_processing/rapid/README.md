# Rapid Text Processing Server

RapidOCR-based preprocessing service with a detect endpoint and an optional OpenAI-compatible OCR endpoint.

## What This Service Does

- serves `/v1/detect` for box extraction
- serves `/v1/chat/completions` for OCR through an OpenAI-style API
- manages separate CPU and GPU environments with `launcher.py`
- lets detect and OCR run on different execution providers

## Requirements

- Windows is the primary supported launcher flow
- `uv` installed or the bundled `uv.exe` from TTS Anywhere
- Python version matching `.python-version`
- CPU, CUDA, or DirectML depending on the provider you choose

## Quick Start

Use one of the preset scripts in `scripts\`:

```bat
scripts\host_both.bat 127.0.0.1 8091
scripts\host_both_gpu.bat 127.0.0.1 8091
scripts\host_both_cpu_ocr_gpu.bat 127.0.0.1 8091
scripts\host_both_gpu_ocr_cpu.bat 127.0.0.1 8091
```

## What The Launcher Script Does

The preset scripts are wrappers around `scripts\_serve.bat`, and `_serve.bat` is a wrapper around `launcher.py`.

The scripts do this:

1. find `uv`
2. read `.python-version`
3. choose `.venv-cpu` or `.venv-gpu`
4. create the environment if missing
5. run `launcher.py` with:
   - `--enable-detect`
   - `--enable-openai-ocr`
   - `--detect-provider ...`
   - `--ocr-provider ...`

`launcher.py` then:

- runs `uv sync --inexact` inside the selected environment
- installs `onnxruntime` for CPU-only use
- installs `onnxruntime-gpu` plus CUDA torch in `.venv-gpu` when CUDA is requested
- starts:

```bat
".venv-...\Scripts\python.exe" -m rapid_text_processing.cli serve --host ... --port ... --enable-detect --enable-openai-ocr --detect-provider ... --ocr-provider ...
```

## Manual Launch Without The .bat Script

### CPU detect + CPU OCR

```bat
uv venv .venv-cpu --python 3.11
set UV_PROJECT_ENVIRONMENT=%CD%\.venv-cpu
.\.venv-cpu\Scripts\python.exe launcher.py --host 127.0.0.1 --port 8091 --enable-detect --enable-openai-ocr --detect-provider cpu --ocr-provider cpu
```

### CUDA detect + CUDA OCR

```bat
uv venv .venv-gpu --python 3.11
set UV_PROJECT_ENVIRONMENT=%CD%\.venv-gpu
.\.venv-gpu\Scripts\python.exe launcher.py --host 127.0.0.1 --port 8091 --enable-detect --enable-openai-ocr --detect-provider cuda --ocr-provider cuda
```

### CPU detect + CUDA OCR

```bat
uv venv .venv-gpu --python 3.11
set UV_PROJECT_ENVIRONMENT=%CD%\.venv-gpu
.\.venv-gpu\Scripts\python.exe launcher.py --host 127.0.0.1 --port 8091 --enable-detect --enable-openai-ocr --detect-provider cpu --ocr-provider cuda
```

### CUDA detect + CPU OCR

```bat
uv venv .venv-gpu --python 3.11
set UV_PROJECT_ENVIRONMENT=%CD%\.venv-gpu
.\.venv-gpu\Scripts\python.exe launcher.py --host 127.0.0.1 --port 8091 --enable-detect --enable-openai-ocr --detect-provider cuda --ocr-provider cpu
```

### Direct CLI start after the environment is prepared

If the launcher has already installed the right packages, you can run the CLI directly:

```bat
.\.venv-cpu\Scripts\python.exe -m rapid_text_processing.cli serve --host 127.0.0.1 --port 8091 --enable-detect --enable-openai-ocr --detect-provider cpu --ocr-provider cpu
```

For GPU cases, replace `.venv-cpu` with `.venv-gpu` and use the provider values you want.

## API Endpoints

- `GET /healthz`
- `POST /v1/detect` when `--enable-detect` is set
- `GET /v1/models` when `--enable-openai-ocr` is set
- `POST /v1/chat/completions` when `--enable-openai-ocr` is set

## Verification

Health check:

```bash
curl http://127.0.0.1:8091/healthz
```

Detect request:

```bash
curl -X POST http://127.0.0.1:8091/v1/detect -F "image=@example.png"
```

OCR request:

```bash
curl -X POST http://127.0.0.1:8091/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"rapidocr\",\"messages\":[{\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"Extract all text from this image.\"},{\"type\":\"input_image\",\"image_url\":\"data:image/png;base64,<BASE64_IMAGE>\"}]}]}"
```

## Troubleshooting

- Wrong environment selected
  CPU-only runs use `.venv-cpu`. Any CUDA preset uses `.venv-gpu`.
- CUDA packages not installed
  Start through `launcher.py` instead of calling the CLI directly.
- `uv` not found
  Install `uv` or use the TTS Anywhere bundled `uv.exe`.
- DirectML
  The CLI accepts `dml` as a provider. The helper scripts only expose the common CPU/CUDA presets, so use manual launcher invocation for DirectML.

## Notes

- `launcher.py` sets `UV_LINK_MODE=copy` and a temp `uv` cache on Windows to avoid mapped-drive issues.
- CPU uses `onnxruntime`.
- GPU uses `onnxruntime-gpu` and a CUDA-enabled torch build in `.venv-gpu`.

# Paddle Text Processing Server

PaddleOCR-based preprocessing service with a detect endpoint and an optional OpenAI-compatible OCR endpoint.

## What This Service Does

- serves `/v1/detect` for box extraction
- serves `/v1/chat/completions` for OCR through an OpenAI-style API
- manages separate CPU and GPU environments with `launcher.py`
- lets detect and OCR run on different devices

## Requirements

- Windows is the main supported launcher flow
- `uv` installed or the bundled `uv.exe` from TTS Anywhere
- Python version matching `.python-version`
- CPU or GPU depending on the device selection you want

## Quick Start

Use one of the preset scripts in `scripts\`:

```bat
scripts\host_both.bat 127.0.0.1 8093
scripts\host_both_gpu.bat 127.0.0.1 8093
scripts\host_both_cpu_ocr_gpu.bat 127.0.0.1 8093
scripts\host_both_gpu_ocr_cpu.bat 127.0.0.1 8093
scripts\host_detect.bat 127.0.0.1 8093
scripts\host_detect_gpu.bat 127.0.0.1 8093
scripts\host_ocr.bat 127.0.0.1 8093
scripts\host_ocr_gpu.bat 127.0.0.1 8093
```

## What The Launcher Script Does

The preset scripts are wrappers around `scripts\_serve.bat`, and `_serve.bat` is a wrapper around `launcher.py`.

The scripts do this:

1. find `uv`
2. read `.python-version`
3. choose `.venv-cpu` or `.venv-gpu`
4. create the environment if missing
5. run `launcher.py` with:
   - `--enable-detect` and/or `--enable-openai-ocr`
   - `--detect-device ...`
   - `--ocr-device ...`

`launcher.py` then:

- runs `uv sync --group dev --inexact` inside the selected environment
- installs `paddlepaddle==3.2.0` for CPU-only use
- installs `paddlepaddle-gpu==3.3.0` from the CUDA 12.9 index by default when GPU is requested
- sets Paddle cache and runtime environment variables
- starts:

```bat
".venv-...\Scripts\python.exe" -m paddle_text_processing.cli serve --host ... --port ... --enable-detect --enable-openai-ocr --detect-device ... --ocr-device ...
```

## Manual Launch Without The .bat Script

### CPU detect + CPU OCR

```bat
uv venv .venv-cpu --python 3.11
set UV_PROJECT_ENVIRONMENT=%CD%\.venv-cpu
.\.venv-cpu\Scripts\python.exe launcher.py --host 127.0.0.1 --port 8093 --enable-detect --enable-openai-ocr --detect-device cpu --ocr-device cpu
```

### CPU detect only

```bat
uv venv .venv-cpu --python 3.11
set UV_PROJECT_ENVIRONMENT=%CD%\.venv-cpu
.\.venv-cpu\Scripts\python.exe launcher.py --host 127.0.0.1 --port 8093 --enable-detect --detect-device cpu --ocr-device cpu
```

### GPU detect + GPU OCR

```bat
uv venv .venv-gpu --python 3.11
set UV_PROJECT_ENVIRONMENT=%CD%\.venv-gpu
.\.venv-gpu\Scripts\python.exe launcher.py --host 127.0.0.1 --port 8093 --enable-detect --enable-openai-ocr --detect-device gpu --ocr-device gpu
```

### GPU detect only

```bat
uv venv .venv-gpu --python 3.11
set UV_PROJECT_ENVIRONMENT=%CD%\.venv-gpu
.\.venv-gpu\Scripts\python.exe launcher.py --host 127.0.0.1 --port 8093 --enable-detect --detect-device gpu --ocr-device cpu
```

### CPU detect + GPU OCR

```bat
uv venv .venv-gpu --python 3.11
set UV_PROJECT_ENVIRONMENT=%CD%\.venv-gpu
.\.venv-gpu\Scripts\python.exe launcher.py --host 127.0.0.1 --port 8093 --enable-detect --enable-openai-ocr --detect-device cpu --ocr-device gpu
```

### GPU detect + CPU OCR

```bat
uv venv .venv-gpu --python 3.11
set UV_PROJECT_ENVIRONMENT=%CD%\.venv-gpu
.\.venv-gpu\Scripts\python.exe launcher.py --host 127.0.0.1 --port 8093 --enable-detect --enable-openai-ocr --detect-device gpu --ocr-device cpu
```

### CPU OCR only

```bat
uv venv .venv-cpu --python 3.11
set UV_PROJECT_ENVIRONMENT=%CD%\.venv-cpu
.\.venv-cpu\Scripts\python.exe launcher.py --host 127.0.0.1 --port 8093 --enable-openai-ocr --detect-device cpu --ocr-device cpu
```

### GPU OCR only

```bat
uv venv .venv-gpu --python 3.11
set UV_PROJECT_ENVIRONMENT=%CD%\.venv-gpu
.\.venv-gpu\Scripts\python.exe launcher.py --host 127.0.0.1 --port 8093 --enable-openai-ocr --detect-device cpu --ocr-device gpu
```

### Override the GPU package or index URL

The launcher reads these overrides:

```bat
set PADDLE_GPU_PACKAGE=paddlepaddle-gpu==3.3.0
set PADDLE_GPU_INDEX_URL=https://www.paddlepaddle.org.cn/packages/stable/cu129/
.\.venv-gpu\Scripts\python.exe launcher.py --host 127.0.0.1 --port 8093 --enable-detect --enable-openai-ocr --detect-device gpu --ocr-device gpu
```

### Direct CLI start after the environment is prepared

If the launcher has already set up the runtime, you can start the API directly:

```bat
set PADDLE_PDX_CACHE_HOME=%CD%\.paddlex-cache
set PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True
set PADDLE_PDX_ENABLE_MKLDNN_BYDEFAULT=False
set PYTHONPATH=%CD%\src
.\.venv-cpu\Scripts\python.exe -m paddle_text_processing.cli serve --host 127.0.0.1 --port 8093 --enable-detect --enable-openai-ocr --detect-device cpu --ocr-device cpu
```

For GPU runs, replace `.venv-cpu` with `.venv-gpu` and use the device values you need. You can also pass only `--enable-detect` or only `--enable-openai-ocr`.

## API Endpoints

- `GET /healthz`
- `POST /v1/detect` when `--enable-detect` is set
- `GET /v1/models` when `--enable-openai-ocr` is set
- `POST /v1/chat/completions` when `--enable-openai-ocr` is set

## Verification

Health check:

```bash
curl http://127.0.0.1:8093/healthz
```

List models:

```bash
curl http://127.0.0.1:8093/v1/models
```

Detect request:

```bash
curl -X POST http://127.0.0.1:8093/v1/detect -F "image=@example.png"
```

OCR request:

```bash
curl -X POST http://127.0.0.1:8093/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"paddleocr\",\"messages\":[{\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"Extract all text from this image.\"},{\"type\":\"input_image\",\"image_url\":\"data:image/png;base64,<BASE64_IMAGE>\"}]}]}"
```

## Troubleshooting

- Wrong environment selected
  CPU-only runs use `.venv-cpu`. Any GPU preset uses `.venv-gpu`.
- GPU startup fails
  Confirm your Paddle GPU package and index URL match your CUDA stack.
- Models downloading to an unexpected location
  The launcher defaults Paddle assets into `.paddlex-cache`.
- Direct CLI startup misses environment variables
  Start through `launcher.py` if you want the supported managed setup.

## Notes

- The launcher sets `UV_LINK_MODE=copy` and a temp `uv` cache on Windows.
- CPU uses `paddlepaddle==3.2.0`.
- GPU defaults to `paddlepaddle-gpu==3.3.0` from the CUDA 12.9 package index.

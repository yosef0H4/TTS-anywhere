# Rapid Text Processing Server

RapidOCR-based preprocessing service with:
- detect-only box extraction for the main app preprocessing flow
- an optional OpenAI-compatible OCR adapter for image text extraction
- a launcher that manages uv environments for CPU-only and GPU-capable runtime setups

## Run

```bash
uv run python launcher.py --enable-detect --detect-provider cpu --host 127.0.0.1 --port 8091
```

Enable both APIs:

```bash
uv run python launcher.py --enable-detect --enable-openai-ocr --detect-provider cuda --ocr-provider cpu --host 127.0.0.1 --port 8091
```

## Windows scripts

Use the scripts in `scripts\`:

- `host_detect.bat` for detect only on CPU
- `host_ocr.bat` for OpenAI OCR only on CPU
- `host_both.bat` for both APIs on CPU
- `host_detect_gpu.bat` for detect only on CUDA
- `host_ocr_gpu.bat` for OpenAI OCR only on CUDA
- `host_both_gpu.bat` for both APIs on CUDA
- `host_detect_cpu_ocr_gpu.bat` for detect on CPU and OCR on CUDA
- `host_detect_gpu_ocr_cpu.bat` for detect on CUDA and OCR on CPU

Each script accepts optional `host` and `port` arguments.

## Runtime notes

- `launcher.py` uses `UV_PROJECT_ENVIRONMENT` so `uv` targets either `.venv-cpu` or `.venv-gpu` instead of the default `.venv`.
- The Windows batch scripts call `launcher.py` directly with `py -3` so they do not create an extra bootstrap `.venv`.
- The launcher uses `uv sync --inexact`, so it updates repo-managed deps without deleting the separately managed CPU/GPU runtime packages.
- On Windows, the launcher uses a temp-directory `uv` cache and `UV_LINK_MODE=copy` to avoid cache rename and hardlink issues on mapped/project drives.
- CPU-only launches install `onnxruntime` in `.venv-cpu`.
- Any launch that requests CUDA or auto installs `onnxruntime-gpu` and a CUDA-enabled PyTorch build in `.venv-gpu`.
- The launcher checks the installed runtime versions first and skips reinstalling them when the current env already matches the requested runtime.
- The server still exposes the same APIs; only the runtime bootstrap path changes.

## Endpoints
- `GET /healthz`
- `POST /v1/detect` when `--enable-detect` is set
- `POST /v1/chat/completions` when `--enable-openai-ocr` is set

`/v1/detect` returns detected boxes in both pixel and normalized coordinates.

`/v1/chat/completions` accepts OpenAI-style image OCR requests and returns a non-streaming chat completion payload.

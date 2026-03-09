# Paddle Text Processing Server

PaddleOCR-based preprocessing service with:
- detect-only box extraction for the main app preprocessing flow
- an optional OpenAI-compatible OCR adapter for image text extraction
- a launcher that manages uv environments for CPU-only and GPU-capable runtime setups

## Run

The Windows host scripts are the supported launcher entrypoints. They require `uv`, not a system Python install.

The service pins Python with `.python-version`. The scripts ensure the selected env exists, then run `launcher.py` inside that env. The launcher owns dependency sync and runtime package switching.

## GPU runtime

CPU works out of the box. GPU launch defaults to:

- `paddlepaddle-gpu==3.3.0`
- `https://www.paddlepaddle.org.cn/packages/stable/cu129/`

So the GPU scripts can run directly on a CUDA 12.9 machine.

Override the defaults if needed:

```bash
set PADDLE_GPU_INDEX_URL=https://www.paddlepaddle.org.cn/packages/stable/cu118/
scripts\host_both_gpu.bat 127.0.0.1 8093
```

Optionally override the package string:

```bash
set PADDLE_GPU_PACKAGE=paddlepaddle-gpu==3.2.0
set PADDLE_GPU_INDEX_URL=https://www.paddlepaddle.org.cn/packages/stable/cu118/
scripts\host_both_cpu_ocr_gpu.bat
```

## Windows scripts

Use the scripts in `scripts\`:

- `host_both.bat` for both APIs on CPU
- `host_both_gpu.bat` for both APIs on GPU
- `host_both_cpu_ocr_gpu.bat` for detect on CPU and OCR on GPU
- `host_both_gpu_ocr_cpu.bat` for detect on GPU and OCR on CPU

Each script accepts optional `host` and `port` arguments.

## Runtime notes

- The scripts use `.venv-cpu` or `.venv-gpu` and run `launcher.py` with that env's Python
- Any preset that uses GPU for either detect or OCR uses `.venv-gpu`
- On Windows, `launcher.py` uses a temp-directory `uv` cache and `UV_LINK_MODE=copy` to avoid cache rename failures on mapped/project drives
- The launcher installs the shared package set with `uv sync --group dev --inexact`
- `TextDetection.predict(...)` powers `/v1/detect`
- `PaddleOCR.predict(...)` powers `/v1/chat/completions`
- `/healthz` reports enabled features plus requested/resolved detect and OCR devices
- The server defaults Paddle cache/model downloads into `.paddlex-cache`
- `auto` is not supported in the CLI or launcher flow anymore

## Endpoints

- `GET /healthz`
- `POST /v1/detect` when `--enable-detect` is set
- `GET /v1/models` when `--enable-openai-ocr` is set
- `POST /v1/chat/completions` when `--enable-openai-ocr` is set

`/v1/detect` returns detected boxes in both pixel and normalized coordinates.

`/v1/chat/completions` accepts OpenAI-style image OCR requests and returns a non-streaming or fake-streaming chat completion payload.

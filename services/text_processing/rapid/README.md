# Rapid Text Processing Server

RapidOCR-based preprocessing service with:
- detect-only box extraction for the main app preprocessing flow
- an optional OpenAI-compatible OCR adapter for image text extraction
- a launcher that manages uv environments for CPU-only and GPU-capable runtime setups

## Run

The Windows host scripts are the supported launcher entrypoints. They require `uv`, not a system Python install.

The service pins Python with `.python-version`. The scripts ensure the selected env exists, then run `launcher.py` inside that env. The launcher owns dependency sync and runtime package switching.

## Windows scripts

Use the scripts in `scripts\`:

- `host_both.bat` for both APIs on CPU
- `host_both_gpu.bat` for both APIs on CUDA
- `host_both_cpu_ocr_gpu.bat` for detect on CPU and OCR on CUDA
- `host_both_gpu_ocr_cpu.bat` for detect on CUDA and OCR on CPU

Each script accepts optional `host` and `port` arguments.

## Runtime notes

- The scripts use `.venv-cpu` or `.venv-gpu` and run `launcher.py` with that env's Python.
- Any preset that uses CUDA for either detect or OCR uses `.venv-gpu`.
- `launcher.py` uses `UV_PROJECT_ENVIRONMENT`, a temp-directory `uv` cache, and `UV_LINK_MODE=copy` to avoid mapped-drive issues on Windows.
- CPU launches install `onnxruntime` in `.venv-cpu`.
- Any GPU launch installs `onnxruntime-gpu` and a CUDA-enabled PyTorch build in `.venv-gpu`.
- `auto` is not supported in the CLI or launcher flow anymore.

## Endpoints
- `GET /healthz`
- `POST /v1/detect` when `--enable-detect` is set
- `POST /v1/chat/completions` when `--enable-openai-ocr` is set

`/v1/detect` returns detected boxes in both pixel and normalized coordinates.

`/v1/chat/completions` accepts OpenAI-style image OCR requests and returns a non-streaming chat completion payload.

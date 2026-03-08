# Paddle Text Processing Server

PaddleOCR-based preprocessing service with:
- detect-only box extraction for the main app preprocessing flow
- an optional OpenAI-compatible OCR adapter for image text extraction
- a launcher that manages uv environments for CPU-only and GPU-capable runtime setups

## Run

```bash
uv run python launcher.py --enable-detect --detect-device cpu --host 127.0.0.1 --port 8093
```

Enable both APIs:

```bash
uv run python launcher.py --enable-detect --enable-openai-ocr --detect-device cpu --ocr-device cpu --host 127.0.0.1 --port 8093
```

## GPU runtime

CPU works out of the box. GPU launch defaults to:

- `paddlepaddle-gpu==3.3.0`
- `https://www.paddlepaddle.org.cn/packages/stable/cu129/`

So the GPU scripts can run directly on a CUDA 12.9 machine.

Override the defaults if needed:

```bash
PADDLE_GPU_INDEX_URL=https://www.paddlepaddle.org.cn/packages/stable/cu118/ \
uv run python launcher.py --enable-detect --detect-device gpu --host 127.0.0.1 --port 8093
```

Optionally override the package string:

```bash
PADDLE_GPU_PACKAGE=paddlepaddle-gpu==3.2.0 \
PADDLE_GPU_INDEX_URL=https://www.paddlepaddle.org.cn/packages/stable/cu118/ \
uv run python launcher.py --enable-openai-ocr --ocr-device gpu
```

## Windows scripts

Use the scripts in `scripts\`:

- `host_detect.bat` for detect only on CPU
- `host_ocr.bat` for OpenAI OCR only on CPU
- `host_both.bat` for both APIs on CPU
- `host_detect_gpu.bat` for detect only on GPU
- `host_ocr_gpu.bat` for OpenAI OCR only on GPU
- `host_both_gpu.bat` for both APIs on GPU
- `host_detect_cpu_ocr_gpu.bat` for detect on CPU and OCR on GPU
- `host_detect_gpu_ocr_cpu.bat` for detect on GPU and OCR on CPU

Each script accepts optional `host` and `port` arguments.

## Runtime notes

- `launcher.py` uses `UV_PROJECT_ENVIRONMENT` so `uv` targets either `.venv-cpu` or `.venv-gpu`
- On Windows, the launcher uses a temp-directory `uv` cache and `UV_LINK_MODE=copy` to avoid cache rename failures on mapped/project drives
- The launcher installs the shared package set with `uv sync`, then installs the CPU or GPU Paddle runtime into the selected env
- `TextDetection.predict(...)` powers `/v1/detect`
- `PaddleOCR.predict(...)` powers `/v1/chat/completions`
- `/healthz` reports enabled features plus requested/resolved detect and OCR devices
- The server defaults Paddle cache/model downloads into `.paddlex-cache`

## Endpoints

- `GET /healthz`
- `POST /v1/detect` when `--enable-detect` is set
- `GET /v1/models` when `--enable-openai-ocr` is set
- `POST /v1/chat/completions` when `--enable-openai-ocr` is set

`/v1/detect` returns detected boxes in both pixel and normalized coordinates.

`/v1/chat/completions` accepts OpenAI-style image OCR requests and returns a non-streaming or fake-streaming chat completion payload.

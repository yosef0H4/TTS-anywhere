# Paddle Text Processing Server

Detect-only PaddleOCR service with the same external contract as the existing Rapid detect server:

- `GET /healthz`
- `POST /v1/detect`

The app can switch between RapidOCR and PaddleOCR without changing request or response handling.

## Install

```bash
uv sync --group dev
```

This service follows the current PaddleOCR 3.x docs line:

- `paddleocr==3.4.0`
- `paddlepaddle==3.2.0`

It intentionally uses the base `paddleocr` package instead of `paddleocr[all]`, because this service only needs the OCR core detect path.

## Run

```bash
uv run paddle-text-processing serve --device cpu --host 127.0.0.1 --port 8093
```

Optional local model path:

```bash
uv run paddle-text-processing serve --device cpu --det-model-dir /path/to/det/model --host 127.0.0.1 --port 8093
```

Optional custom model name:

```bash
uv run paddle-text-processing serve --device cpu --model-name PP-OCRv5_mobile_det --host 127.0.0.1 --port 8093
```

## Runtime notes

- Uses `paddleocr.TextDetection.predict(...)` and converts `dt_polys` into the existing `raw_boxes` format
- `auto` resolves to `gpu` when Paddle reports CUDA support, otherwise `cpu`
- The Windows launcher forces CPU and disables MKLDNN-by-default because the failing path observed in this repo was inside oneDNN
- `/healthz` reports the active runtime flags and installed Paddle package versions
- The server disables the Paddle model-source connectivity check by default to reduce startup noise

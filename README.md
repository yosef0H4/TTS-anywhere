# TTS Snipper

Electron/Web app for screen capture, OCR, preprocessing, and text-to-speech workflows, with local pluggable text-processing services.

## What It Does

- Capture text from screenshots or pasted images
- Run OCR through an OpenAI-compatible endpoint
- Preprocess images with local text detection services
- Send extracted text to local or remote TTS backends
- Run as a web UI during development and as an Electron desktop app

## Project Layout

- `src/` app code for renderer, core pipeline, UI, and Electron integration
- `services/text_processing/rapid/` RapidOCR-based text detection + OCR service
- `services/text_processing/paddle/` PaddleOCR-based text detection + OCR service
- `services/tts/` local TTS backends
- `scripts/` repo helpers, including the benchmark scripts

## App Development

Requirements:

- Node.js
- npm

Install dependencies:

```bash
npm install
```

Run the web app:

```bash
npm run dev:web
```

Run the Electron app:

```bash
npm run dev:electron
```

Build:

```bash
npm run build:web
npm run build:electron
```

Typecheck:

```bash
npm run typecheck
```

## Text Processing Services

Both local preprocessing services support:

- `GET /healthz`
- `POST /v1/detect`
- `GET /v1/models`
- `POST /v1/chat/completions`

Windows launchers exist for CPU and GPU runs under:

- `services/text_processing/rapid/scripts/`
- `services/text_processing/paddle/scripts/`

Useful launchers:

- `host_both.bat`
- `host_both_gpu.bat`
- `host_detect_cpu_ocr_gpu.bat`
- `host_detect_gpu_ocr_cpu.bat`

Current practical takeaway from local benchmarking:

- Rapid is the better CPU default overall
- Paddle is the better GPU default overall
- CPU detection is close between them
- Rapid is much faster for CPU OCR
- Paddle is faster for GPU detection and GPU OCR

## Recommended Stacks

### If You Have a GPU

Best overall stack:

- Text processing: `Paddle` on GPU
- OCR: `H2OVL Mississippi`
- TTS: `Kokoro`

This full stack is relatively lightweight for a local GPU setup. It has been run successfully on a machine with `4 GB` of VRAM, so most PCs with NVIDIA GPUs should be able to handle it.

### If Your GPU Is Busy or You Want a Low-Overhead All-Rounder

Recommended stack:

- Text processing: `Paddle` for both detection and OCR
- TTS: `Edge`

This is the best all-rounder if you want to keep GPU usage very low during normal use. It runs well on almost any CUDA-capable GPU and uses very little GPU at runtime compared with the heavier local VLM stack.

### If You Do Not Have a GPU

Recommended stack:

- Text processing: `Rapid` for both detection and OCR
- TTS: `Edge`

Rapid is the better CPU choice in this project, especially for OCR speed, so this is the best non-GPU default.

### If You Want to Avoid Edge

- If privacy matters more than using Microsoft Edge TTS, you can use any of the other local TTS backends instead.
- In practice they are currently all in roughly the same quality tier relative to each other, even if they are not as strong a recommendation as Kokoro on GPU.

### OCR Note

- `Qwen3-VL-4B` is also a strong OCR option for local use.
- You can run it through `LM Studio`, or through `Ollama` when you do have an NVIDIA GPU.
- It is probably one of the best OCR options overall, but because of its size it is not the default recommendation for this project.

## Benchmarking

Fetch the public benchmark image set:

```bash
python scripts/fetch_bench_images.py
```

Run the benchmark:

```bash
python scripts/bench_text_processing.py
```

The benchmark:

- uses a fixed public image set in `benchmarks/text_processing/public_images.json`
- downloads images into `bench_data/images/`
- runs Rapid CPU, Paddle CPU, Rapid GPU, and Paddle GPU one by one
- warms up each service before timing
- saves raw results into `bench_results/`

### Latest Benchmark Summary

From the latest local run:

- Detect CPU
  - Rapid: `907.71 ms`
  - Paddle: `928.26 ms`
- OCR CPU
  - Rapid: `2243.0 ms`
  - Paddle: `10544.16 ms`
- Detect GPU
  - Rapid: `400.26 ms`
  - Paddle: `127.24 ms`
- OCR GPU
  - Rapid: `608.59 ms`
  - Paddle: `441.3 ms`

Interpretation:

- Rapid wins on CPU overall
- Paddle wins on GPU overall

This benchmark is intended as a rough speed comparison, not a full accuracy benchmark.

## Tests

App tests:

```bash
npm run test
```

Focused tests:

```bash
npm run test:chunking
npm run test:openai
npm run test:settings
```

## Notes

- Downloaded benchmark images and benchmark result files are ignored from Git.
- Service-specific details and runtime notes are documented in each service README.
- `EyeHearYou/` is not part of the tracked project files.

# TTS Adapter

Standalone OpenAI-compatible local TTS service for NAMAA Saudi TTS.

## Features
- OpenAI-compatible `POST /v1/audio/speech`
- OpenAI-compatible `GET /v1/models`
- Optional bearer auth (`API_KEY` env)
- GPU-first startup: does not auto-fallback to CPU
- Explicit CPU override with `--allow-cpu`
- Strict typing via `mypy --strict`

## Install UV (example)
```bash
# Linux
curl -LsSf https://astral.sh/uv/install.sh | sh
```

## Setup
```bash
cd services/tts-adapter
uv sync --group dev
```

## Run API
```bash
uv run tts-adapter-api --host 127.0.0.1 --port 8000
```

GPU only by default. If CUDA is unavailable, startup fails with guidance.

Explicit CPU mode:
```bash
uv run tts-adapter-api --allow-cpu
```

## Quick CLI test
```bash
uv run tts-adapter-cli synth \
  --text "أنا الحين بروح الشغل" \
  --out ./out.wav
```

With reference audio:
```bash
uv run tts-adapter-cli synth \
  --text "آبي أخلص الشغل اليوم" \
  --audio-prompt /path/to/reference.wav \
  --out ./out.wav
```

## API usage
```bash
curl -X POST "http://127.0.0.1:8000/v1/audio/speech" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "namaa-saudi-tts",
    "input": "آبي أروح البقالة",
    "response_format": "wav",
    "speed": 1.0
  }' --output out.wav
```

## App integration
Use your Electron app settings:
- `TTS Base URL`: `http://127.0.0.1:8000/v1`
- `TTS Model`: `namaa-saudi-tts`
- `TTS API Key`: set only if adapter `API_KEY` is configured

## Linux and Windows
- Windows + CUDA 12.1 is primary target.
- Linux is supported with the same API and adapter code.
- PyTorch/CUDA wheel selection depends on host CUDA and platform.

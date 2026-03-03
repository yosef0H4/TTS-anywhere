# TTS Piper Adapter

OpenAI-compatible TTS adapter around the Piper binary.

## Why
- Piper is lightweight and local (CPU friendly).
- This adapter exposes OpenAI-style endpoints so your app can switch providers by URL/model only.

## Requirements
- Piper binary can be auto-downloaded from official `rhasspy/piper` GitHub releases when missing.
- Optional: local `.onnx` model file (and matching `.onnx.json` config).
- If model is not present locally, adapter auto-downloads from `rhasspy/piper-voices` on Hugging Face.

## Environment
- `PIPER_BIN`: path to piper executable (default: `piper`)
- `PIPER_BIN_DIR`: where auto-downloaded Piper binaries are cached (default `./bin`)
- `PIPER_MODEL`: default model path (`.onnx`)
- `PIPER_MODELS`: optional JSON map for multiple model IDs
  - Example: `{"en_US-amy-medium":"C:/models/en_US-amy-medium.onnx"}`
- `PIPER_SPEAKER`: optional integer speaker id
- `PIPER_MODEL_DIR`: where downloaded models are cached (default `./models`)
- `PIPER_VOICES_REPO`: HF repo id for model catalog (default `rhasspy/piper-voices`)
- `PIPER_DEFAULT_MODEL`: fallback model when `--model` is omitted (default `en_US-lessac-medium`)
- `API_KEY`: optional bearer token for auth

## Run API
```bash
uv run tts-piper serve --host 127.0.0.1 --port 8011
```

## CLI synth
```bash
uv run tts-piper synth --text "hello" --out out.wav --model en_US-amy-medium
```

Model argument is optional now; it uses `PIPER_DEFAULT_MODEL` and auto-installs if missing:
```bash
uv run tts-piper synth --text "hello" --out out.wav
```

## OpenAI-compatible endpoint
- `POST /v1/audio/speech`
- `GET /v1/models`

Current output format: `wav`.

## Notes on model auto-install
- The adapter downloads `voices.json` from HF and resolves model IDs/aliases.
- It downloads both `*.onnx` and `*.onnx.json` using `huggingface_hub` APIs.
- This is based on `rhasspy/piper-voices` catalog structure.

## Notes on Piper binary auto-install
- If `PIPER_BIN` is not found on PATH and not a valid file path, adapter auto-downloads Piper from latest release assets.
- Source: `https://github.com/rhasspy/piper/releases`.

# Kitten TTS Adapter

OpenAI-compatible adapter for `KittenTTS`, designed for CPU inference with model-aware switching.

## Why
- CPU-first local TTS
- Exposes real Kitten model ids through `/v1/models`
- Exposes voice aliases separately through `/v1/voices`
- Unloads the current model before loading a different one

## Environment
- `KITTEN_DEFAULT_MODEL` default: `KittenML/kitten-tts-nano-0.8-fp32`
- `KITTEN_DEFAULT_VOICE` default: `Bella`
- `KITTEN_DEFAULT_SPEED` default: `1.0`
- `KITTEN_CACHE_DIR` optional Hugging Face cache/model directory
- `KITTEN_PORT` default: `8014`
- `API_KEY` optional bearer token for auth

## Run API
```bash
uv run tts-kitten serve --host 127.0.0.1 --port 8014
```

## CLI
```bash
uv run tts-kitten models
uv run tts-kitten voices --model KittenML/kitten-tts-mini-0.8
uv run tts-kitten synth --model KittenML/kitten-tts-nano-0.8-fp32 --voice Bella --text "hello" --out out.wav
```

## Windows helpers
```bat
scripts\host.bat 127.0.0.1 8014
scripts\client.bat "hello from kitten" out.wav KittenML/kitten-tts-nano-0.8-fp32 Bella
```

## OpenAI-compatible endpoints
- `GET /v1/models`
- `GET /v1/voices?model=<model-id>`
- `GET /v1/audio/voices?model=<model-id>`
- `POST /v1/audio/speech`

Current output format: `wav`.

# TTS Edge Adapter

OpenAI-compatible TTS adapter using `edge-tts`.

## Why
- Very lightweight (no CUDA, no local model downloads).
- Good quality online neural voices.

## Environment
- `EDGE_DEFAULT_VOICE` (default: `en-US-AriaNeural`)
- `API_KEY` optional bearer token for auth

## Run API
```bash
uv run tts-edge serve --host 127.0.0.1 --port 8012
```

## CLI synth
```bash
uv run tts-edge synth --text "hello" --out out.mp3 --voice en-US-AriaNeural
```

## OpenAI-compatible endpoint
- `POST /v1/audio/speech`
- `GET /v1/models`

Current output format: `mp3`.

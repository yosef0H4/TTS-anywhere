# Kitten TTS Adapter

OpenAI-compatible adapter for `KittenTTS`, designed for CPU inference with model-aware switching.

## What This Service Does

- serves `/v1/audio/speech` for OpenAI-style speech synthesis
- exposes `/v1/models`, `/v1/voices`, and `/healthz`
- can list models and voices from the CLI
- lets you synthesize files directly from the CLI without the app

## Requirements

- `uv`
- CPU is enough for the intended use

## Quick Start

Helper script:

```bat
scripts\host.bat 127.0.0.1 8014
```

Manual direct startup:

```bash
uv run tts-kitten serve --host 127.0.0.1 --port 8014
```

## What The Launcher Script Does

This service does not have a custom Python launcher. `scripts\host.bat` is only a wrapper for:

```bat
uv run tts-kitten serve --host %HOST% --port %PORT%
```

The command entrypoint comes from `pyproject.toml`:

```text
tts-kitten = "tts_kitten_adapter.cli:main"
```

`scripts\client.bat` is also only a wrapper. It runs:

```bat
uv run tts-kitten synth --text ... --out ... --model ... --voice ...
```

## Manual Launch Without The .bat Script

Start the API directly:

```bash
uv run tts-kitten serve --host 127.0.0.1 --port 8014
```

List available models:

```bash
uv run tts-kitten models
```

List voices for a model:

```bash
uv run tts-kitten voices --model KittenML/kitten-tts-mini-0.8
```

Synthesize a file:

```bash
uv run tts-kitten synth --model KittenML/kitten-tts-nano-0.8-fp32 --voice Bella --text "hello" --out out.wav
```

## API Endpoints

- `GET /healthz`
- `GET /v1/models`
- `GET /v1/voices?model=<model-id>`
- `GET /v1/audio/voices?model=<model-id>`
- `POST /v1/audio/speech`

## Verification

Health check:

```bash
curl http://127.0.0.1:8014/healthz
```

List models:

```bash
curl http://127.0.0.1:8014/v1/models
```

List voices:

```bash
curl "http://127.0.0.1:8014/v1/voices?model=KittenML/kitten-tts-nano-0.8-fp32"
```

Synthesize speech:

```bash
curl -X POST http://127.0.0.1:8014/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{"input":"hello world","model":"KittenML/kitten-tts-nano-0.8-fp32","voice":"Bella"}' \
  --output out.wav
```

## Troubleshooting

- Model download or load time is slow
  The first use of a model can take longer while assets are prepared.
- Wrong model or voice name
  Use `uv run tts-kitten models` and `uv run tts-kitten voices --model ...` to inspect valid values.
- Auth failures
  Check `API_KEY` if bearer-token auth is enabled.

## Notes

- Default model is `KittenML/kitten-tts-nano-0.8-fp32`.
- Default voice is `Bella`.
- Current output format is `wav`.

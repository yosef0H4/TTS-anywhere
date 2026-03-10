# Kokoro TTS Adapter

OpenAI-compatible adapter for Kokoro TTS.

## What This Service Does

- serves `/v1/audio/speech` for OpenAI-style speech synthesis
- exposes `/v1/models`, `/v1/voices`, and `/healthz`
- provides CLI commands for listing models, listing voices, and synthesizing files
- requires a GPU for synthesis

## Requirements

- `uv`
- CUDA-capable GPU
- Python version accepted by the package

## Quick Start

Helper script:

```bat
scripts\host.bat 127.0.0.1 8040
```

Manual direct startup:

```bash
uv run tts-kokoro serve --host 127.0.0.1 --port 8013
```

The helper script defaults to port `8040`, while the CLI and app settings default to port `8013`. Pick one explicitly if you want consistent behavior.

## What The Launcher Script Does

This service does not have a custom `launcher.py`. `scripts\host.bat` is only a wrapper for:

```bat
uv run tts-kokoro serve --host %HOST% --port %PORT%
```

The command entrypoint comes from `pyproject.toml`:

```text
tts-kokoro = "tts_kokoro_adapter.cli:main"
```

## Manual Launch Without The .bat Script

Start the API directly:

```bash
uv run tts-kokoro serve --host 127.0.0.1 --port 8013
```

List models:

```bash
uv run tts-kokoro models
```

List voices:

```bash
uv run tts-kokoro voices
```

Synthesize a file:

```bash
uv run tts-kokoro synth --text "hello world" --out out.wav --voice af_heart
```

The helper client script is only a wrapper around the same `uv run tts-kokoro synth ...` command.

## API Endpoints

- `GET /healthz`
- `GET /v1/models`
- `GET /v1/voices`
- `POST /v1/audio/speech`

## Verification

Health check:

```bash
curl http://127.0.0.1:8013/healthz
```

List models:

```bash
curl http://127.0.0.1:8013/v1/models
```

List voices:

```bash
curl http://127.0.0.1:8013/v1/voices
```

Synthesize speech:

```bash
curl -X POST http://127.0.0.1:8013/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{"input":"hello world","voice":"af_heart"}' \
  --output out.wav
```

## Troubleshooting

- No GPU detected
  Kokoro synthesis requires CUDA. The app logs and `/v1/audio/speech` responses will report the missing GPU.
- First run is slow
  Model assets may be downloaded from Hugging Face.
- English fallback issues
  `espeak-ng` may still be needed in some environments.

## Notes

- `KOKORO_PORT` defaults to `8013`.
- First run can download roughly 300 MB of model data.
- Sample rate is fixed at 24000 Hz.

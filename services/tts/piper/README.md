# TTS Piper Adapter

OpenAI-compatible TTS adapter around the Piper binary.

## What This Service Does

- serves `/v1/audio/speech` for OpenAI-style speech synthesis
- exposes `/v1/models` and `/healthz`
- can synthesize files directly from the CLI
- can auto-download the Piper binary and voice models when needed

## Requirements

- `uv`
- local CPU is enough for normal use

## Quick Start

Helper script:

```bat
scripts\host.bat 127.0.0.1 8011
```

Manual direct startup:

```bash
uv run tts-piper serve --host 127.0.0.1 --port 8011
```

## What The Launcher Script Does

This service does not have a custom Python launcher. `scripts\host.bat` is only a wrapper for:

```bat
uv run tts-piper serve --host %HOST% --port %PORT%
```

The command entrypoint comes from `pyproject.toml`:

```text
tts-piper = "tts_piper_adapter.cli:main"
```

`scripts\client.bat` is only a wrapper around the same `uv run tts-piper synth ...` CLI path.

## Manual Launch Without The .bat Script

Start the API directly:

```bash
uv run tts-piper serve --host 127.0.0.1 --port 8011
```

Synthesize using an explicit model:

```bash
uv run tts-piper synth --text "hello" --out out.wav --model en_US-amy-medium
```

Synthesize using the default model:

```bash
uv run tts-piper synth --text "hello" --out out.wav
```

If you want to override binary or model locations for standalone use:

```bat
set PIPER_BIN=C:\path\to\piper.exe
set PIPER_MODEL_DIR=%CD%\models
set PIPER_DEFAULT_MODEL=en_US-lessac-medium
uv run tts-piper serve --host 127.0.0.1 --port 8011
```

## API Endpoints

- `GET /healthz`
- `GET /v1/models`
- `POST /v1/audio/speech`

## Verification

Health check:

```bash
curl http://127.0.0.1:8011/healthz
```

List models:

```bash
curl http://127.0.0.1:8011/v1/models
```

Synthesize speech:

```bash
curl -X POST http://127.0.0.1:8011/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{"input":"hello world","model":"en_US-lessac-medium"}' \
  --output out.wav
```

## Troubleshooting

- Piper binary not found
  The adapter can auto-download it unless you set `PIPER_BIN` to a bad path.
- Model not found
  The adapter can auto-download models from `rhasspy/piper-voices`.
- Wrong voice/model selection
  Check `/v1/models` or set `PIPER_DEFAULT_MODEL` explicitly.

## Notes

- Current output format is `wav`.
- `PIPER_BIN_DIR` controls where downloaded Piper binaries are cached.
- `PIPER_MODEL_DIR` controls where models are cached.

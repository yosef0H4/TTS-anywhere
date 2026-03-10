# TTS Edge Adapter

OpenAI-compatible TTS adapter using `edge-tts`.

## What This Service Does

- serves `/v1/audio/speech` for OpenAI-style speech synthesis
- exposes `/v1/models`, `/v1/voices`, and `/healthz`
- provides a simple CLI for direct synthesis
- uses Microsoft's online Edge voices instead of a local model runtime

## Requirements

- `uv`
- internet access for Microsoft Edge voices

## Quick Start

Helper script:

```bat
scripts\host.bat 127.0.0.1 8012
```

Manual direct startup:

```bash
uv run tts-edge serve --host 127.0.0.1 --port 8012
```

## What The Launcher Script Does

This service does not have a custom Python launcher. `scripts\host.bat` is only a convenience wrapper for:

```bat
uv run tts-edge serve --host %HOST% --port %PORT%
```

The command entrypoint comes from `pyproject.toml`:

```text
tts-edge = "tts_edge_adapter.cli:main"
```

`scripts\client.bat` is also only a wrapper around `uv run tts-edge synth ...`.

## Manual Launch Without The .bat Script

Start the API directly:

```bash
uv run tts-edge serve --host 127.0.0.1 --port 8012
```

List models:

```bash
uv run tts-edge models
```

List voices:

```bash
uv run tts-edge voices
```

Synthesize a file:

```bash
uv run tts-edge synth --text "hello" --out out.mp3 --voice en-US-AriaNeural
```

## API Endpoints

- `GET /healthz`
- `GET /v1/models`
- `GET /v1/voices`
- `POST /v1/audio/speech`

## Verification

Health check:

```bash
curl http://127.0.0.1:8012/healthz
```

List models:

```bash
curl http://127.0.0.1:8012/v1/models
```

List voices:

```bash
curl http://127.0.0.1:8012/v1/voices
```

Synthesize speech:

```bash
curl -X POST http://127.0.0.1:8012/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{"input":"hello world","voice":"en-US-AriaNeural"}' \
  --output out.mp3
```

## Troubleshooting

- No audio returned
  The upstream online TTS request may have failed or the voice may be invalid.
- Auth failures
  Check `API_KEY` if you enabled bearer-token auth.
- Voice list differences
  Available Edge voices can change upstream.

## Notes

- Default voice comes from `EDGE_DEFAULT_VOICE` and falls back to `en-US-AriaNeural`.
- Current output format is `mp3`.

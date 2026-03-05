# Kokoro TTS Adapter

OpenAI-compatible adapter for Kokoro TTS (GPU-only).

## Requirements

- Python 3.10+
- CUDA-capable GPU
- uv package manager

## Installation

```bash
cd services/tts/kokoro
uv venv
uv pip install -e .
```

## Usage

### Start API Server

```bash
uv run tts-kokoro serve --port 8013
```

### CLI Commands

```bash
# List available models
uv run tts-kokoro models

# List available voices
uv run tts-kokoro voices

# Synthesize text to WAV
uv run tts-kokoro synth --text "hello world" --out test.wav --voice af_heart
```

### API Endpoints

- `GET /v1/models` - List available models
- `GET /v1/voices` - List available voices
- `POST /v1/audio/speech` - Synthesize speech
- `GET /healthz` - Health check

### Example API Request

```bash
curl -X POST http://localhost:8013/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{"input": "hello world", "voice": "af_heart"}' \
  --output test.wav
```

## Available Voices

### American English (lang_code='a')
- af_heart, af_bella, af_nicole, af_sarah, af_sky
- am_michael, am_adam, am_gurney

### British English (lang_code='b')
- bf_emma, bm_george, bm_lewis

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| API_KEY | None | Optional API key for authentication |
| KOKORO_DEFAULT_VOICE | af_heart | Default voice |
| KOKORO_DEFAULT_SPEED | 1.0 | Default speech speed |
| KOKORO_PORT | 8013 | Default server port |

## Notes

- First run downloads ~300MB model from HuggingFace
- Sample rate is fixed at 24000 Hz
- espeak-ng may be required on some systems for English OOD fallback

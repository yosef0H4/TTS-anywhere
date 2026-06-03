# Supertonic TTS Adapter

OpenAI-compatible local adapter for `Supertone/supertonic-3`.

Supertonic runs through ONNX Runtime and supports Arabic with `lang="ar"`. This service exposes two launch presets:

- `Supertonic CPU`: uses `CPUExecutionProvider` and does not require a GPU.
- `Supertonic GPU`: uses a real ONNX GPU provider and refuses to start if GPU execution is unavailable. On Windows it uses DirectML so it does not require CUDA/cuDNN.

## Run

```powershell
uv run python launcher.py --runtime cpu --host 127.0.0.1 --port 8017
uv run python launcher.py --runtime gpu --host 127.0.0.1 --port 8018
```

## Smoke Test

```powershell
$body = @{
  model = "Supertone/supertonic-3"
  voice = "M1"
  input = "إِنَّ الْعِلْمَ نُورٌ."
  response_format = "wav"
} | ConvertTo-Json
Invoke-WebRequest http://127.0.0.1:8017/v1/audio/speech -Method POST -ContentType "application/json; charset=utf-8" -Body $body -OutFile test-results/supertonic.wav
```

# Supertonic TTS Adapter

OpenAI-compatible local adapter for `Supertone/supertonic-3`.

Supertonic supports Arabic with `lang="ar"`. This service exposes three launch presets:

- `Supertonic CPU`: uses ONNX Runtime `CPUExecutionProvider` and does not require a GPU.
- `Supertonic ONNX GPU`: uses a real ONNX GPU provider and refuses to start if GPU execution is unavailable. On Windows it uses DirectML so it does not require CUDA/cuDNN.
- `Supertonic NVIDIA`: uses the experimental PyTorch CUDA runtime adapted from `FluidInference/supertonic-3-coreml`, loads the official `Supertone/supertonic-3` ONNX assets, and requires an NVIDIA CUDA GPU.

The adapter defaults to `SUPERTONIC_TOTAL_STEPS=6`, which is the current local quality floor for chunked playback. Increase it toward `8` for higher quality at lower speed, or lower it only for fastest draft playback.

## Run

```powershell
uv run python launcher.py --runtime cpu --host 127.0.0.1 --port 8017
uv run python launcher.py --runtime gpu --host 127.0.0.1 --port 8018
uv run python launcher.py --runtime nvidia --host 127.0.0.1 --port 8019
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

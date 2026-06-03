---
name: tts-electron-service-builder
description: Build, debug, or add TTS Anywhere runtime services in this Electron repo. Use when implementing services under services/tts, services/text_processing, or related service manifests/launchers, especially GPU-only model services, OpenAI-compatible TTS/OCR adapters, launcher-to-UI setting handoff, and Electron Playwright validation.
---

# TTS Electron Service Builder

## Quick Start

Use this skill for service work in `tts-electron`, then use `electron-playwright-cli` for UI validation.

1. Inspect nearby services first. Prefer copying proven patterns from `services/tts/*`, `services/text_processing/*`, `stack.service.json`, and `launcher.py`.
2. Add or edit the service manifest, Python adapter, launcher, README, bundling script, and service manifest tests together.
3. For GPU-heavy services, enforce GPU-only startup before installing/loading the model. Refuse startup if CUDA/NVIDIA GPU is unavailable.
4. Keep model tests isolated. Stop other GPU services before launching a heavy service; test OCR and TTS one at a time.
5. Validate the direct API before UI playback. Then test launcher and UI through Electron Playwright.
6. When something fails, read the service logs before changing code. Do not guess from the UI status alone.

Read [service-patterns.md](references/service-patterns.md) when implementing or debugging a service.

## Pitfalls To Avoid

These are mistakes already hit in this repo. Check them explicitly before declaring a service done.

- Do not reinstall Torch on every launch. Probe the target env first, and only install when the package is missing or incompatible.
- Do not trust `VIRTUAL_ENV`. Strip inherited env vars and run the adapter with the exact Python from the service GPU env.
- Do not mark the service healthy while the first real request will still load the model. Warm the model during startup when cold load is expensive.
- Do not silently use CPU. Check both `nvidia-smi` and `torch.cuda.is_available()` from the same Python env that will run the adapter.
- Do not assume the launcher updated the UI. Verify provider, base URL, model, voice, response format, and timeout through Electron Playwright.
- Do not test multiple heavy services together. Stop the previous service and confirm GPU memory is released before starting the next one.
- Do not rely on package docs alone for fragile model runtimes. Run the simplest upstream/basic usage script first, then wrap it in FastAPI.
- Do not ignore duplicated or mixed chunk output. Electron may issue concurrent synthesis requests; serialize inference if the model runtime is not thread-safe.
- Do not patch Windows optional dependency failures with broad fake modules. Use narrow shims only for disabled features, and make them fail if used.
- Do not call a slow warmed GPU model an integration bug until logs prove there is no repeated load, no CPU fallback, and no duplicate request.

## Service Shape

Every runtime service should usually include:

- `stack.service.json`: service id, family, slot, presets, URL(s), launch command, GPU runtime metadata.
- `launcher.py`: environment setup, GPU checks, dependency repair, cache paths, and process start.
- `pyproject.toml`: adapter dependencies only; avoid baking heavyweight CUDA wheels into normal dev envs.
- `src/<adapter>/app.py`: FastAPI app exposing OpenAI-compatible endpoints.
- `tests/test_api.py`: cheap unit/API tests with mocked runtime where possible.
- integration updates: bundling script, service manifest test expectations, output format handling, UI default handoff.

## GPU Service Rules

- Never let heavy models fall back to CPU silently.
- Check `nvidia-smi` and `torch.cuda.is_available()` before serving.
- Reuse a known CUDA Torch env only after verifying compatible `torch`, `torchaudio`, and `torchvision`.
- Do not repeatedly download Torch. Probe installed packages before `uv pip install`.
- If installing is required, use `uv pip install` so uv cache is reused; do not switch to slower installers.
- Set model cache env vars such as `HF_HOME` inside the service folder so downloads are reusable and discoverable.
- For models that must be resident before use, warm the engine during FastAPI startup and expose `loaded: true` in `/healthz`.

## UI Handoff

When launching a discovered service, update the app config so the provider fields point to the launched service. For TTS services, set:

- provider: `openai_compatible`
- base URL: service `/v1`
- model and voice defaults
- response format when the model does not return MP3
- longer chunk timeout for cold or slow local models

Do this in `src/web/app.ts` near discovered-service URL application. Keep service-specific overrides narrow.

## Validation

Run cheap tests before launching heavy services:

```powershell
npm run build:electron:main
uv run python -m pytest tests
npx vitest run src/tests/service-manifest.test.ts --pool=threads --maxWorkers=1
```

Use direct API smoke tests before UI playback:

```powershell
Invoke-RestMethod http://127.0.0.1:<port>/healthz
Invoke-WebRequest http://127.0.0.1:<port>/v1/audio/speech -Method POST -ContentType 'application/json; charset=utf-8' -Body $body -OutFile test-results/service.wav
```

Use Electron Playwright for launcher/UI validation:

- Confirm selected service launches to `Running`.
- Confirm URL/model/voice fields update.
- Confirm the launched service is the selected provider, not only that the process is running.
- Confirm playback sends the expected chunk text and receives `200 OK`.
- Inspect service logs for repeated downloads, repeated model loads, CPU fallback, chunk duplication, and timeout/cancel errors.
- Stop the service afterward so GPU memory is released.

## Common Bugs

- Missing package after Windows `--no-deps` fallback: install minimal runtime deps explicitly.
- Torch companion mismatch: pin `torchaudio`/`torchvision` to the installed CUDA Torch version.
- Arabic stdout crash on Windows: set `PYTHONIOENCODING=utf-8` and `PYTHONUTF8=1`.
- First request slow: warm the model during startup before reporting healthy/running.
- Duplicate or mixed audio across chunks: serialize model inference if the upstream runtime is not thread-safe.
- App cancels a local model too early: raise `chunkTimeoutMs` for that service.

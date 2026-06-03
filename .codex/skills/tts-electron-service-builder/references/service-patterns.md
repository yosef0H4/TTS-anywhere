# Service Patterns

## Files To Touch

- `services/<family>/<service>/stack.service.json`
- `services/<family>/<service>/launcher.py`
- `services/<family>/<service>/pyproject.toml`
- `services/<family>/<service>/src/<adapter>/app.py`
- `services/<family>/<service>/src/<adapter>/cli.py`
- `services/<family>/<service>/tests/test_api.py`
- `scripts/prepare-bundled-resources.mjs`
- `src/tests/service-manifest.test.ts`
- `src/core/services/openai-compatible-client.ts`
- `src/electron/provider-service.ts`
- `src/web/app.ts` when launch should update model/voice/provider settings

## Manifest

Use `stack.service.json` to declare:

- stable `id`
- `family`: `tts`, `text_processing`, or existing family
- slot/runtime preset
- command and `cwd`
- URL(s), usually `/v1`
- GPU runtime flag for heavy models

Run the manifest Vitest after editing.

## Launcher

Launcher responsibilities:

- Strip inherited `VIRTUAL_ENV`.
- Use `uv` for env creation and package installs.
- Probe before installing; avoid repeated heavy downloads.
- Treat repeated Torch downloads as a launcher bug, not an acceptable launch cost.
- For NVIDIA-only services, fail before model load if `nvidia-smi` or CUDA Torch is unavailable.
- Verify CUDA from the final adapter Python, not from some other shell or env.
- Pin CUDA package families together, for example Torch 2.8 with torchaudio 2.8 and torchvision 0.23.
- Set cache env vars:
  - `HF_HOME=<service>/.hf-cache`
  - service-local `UV_CACHE_DIR` when useful
  - `PYTHONIOENCODING=utf-8` and `PYTHONUTF8=1` for Arabic/non-ASCII logs
- Start the adapter with the resolved GPU env Python, not with the wrong project `.venv`.
- Print enough launcher diagnostics to see which Python, Torch version, CUDA version, device name, and cache paths are being used.

## Adapter API

For TTS, expose:

- `GET /healthz`
- `GET /v1/models`
- `GET /v1/voices`
- `GET /v1/audio/voices`
- `POST /v1/audio/speech`

For OCR/OpenAI-compatible text processing, expose OpenAI-compatible model/chat endpoints used by the app.

Return precise errors:

- missing GPU: 500 with `code: gpu_required`
- empty input: 400
- auth failure: 401 when `API_KEY` is set

Keep `/healthz` cheap unless the service must be warm before use. If startup warms the model, include `loaded: true`.

## Heavy Model Runtime Lessons

Use a standalone basic usage script first when an upstream package is fragile. Prove:

- CUDA is available.
- The upstream example can load and infer.
- A WAV/image/text output is actually produced.

Then wrap it in the API.

Do not skip the basic script. It separates upstream/model problems from adapter, launcher, and Electron integration problems.

For Windows-hosted Python packages:

- If full install fails because of optional native deps, install the package with `--no-deps` and explicitly install runtime deps.
- If upstream imports optional modules at import time, consider disabled shims only when the feature is intentionally disabled in API calls.
- Keep such shims narrow and fail loudly if the disabled feature is used.

For non-thread-safe model runtimes:

- Use a process-wide inference lock.
- Expect the Electron app to prefetch multiple chunks concurrently.
- Serialize inside the adapter if concurrent `infer()` calls mix output or corrupt state.

For slow local models:

- Warm before health if cold load is long.
- Log one clear line when warmup starts and ends.
- Log one clear line around each request with text length, output format, device, and elapsed time.
- Check whether slowness is model architecture/GPU limit after ruling out repeated load, CPU fallback, downloads, and duplicate requests.

## Launcher-To-UI Handoff

Launching a service is not enough. The launcher/UI bridge must also update the active settings that synthesis uses.

Verify after launch:

- provider is OpenAI-compatible/local service as expected
- base URL points at the launched service `/v1`
- model is the service model, not the previous user setting
- voice is the service voice, not stale state
- response format matches the adapter output
- chunk timeout is long enough for the model

If UI fields update but playback still fails, inspect `provider.tts.request.begin` logs to confirm the actual request payload.

## Electron Playwright Workflow

Use `.codex/skills/electron-playwright-cli/SKILL.md`.

Good sequence:

1. Start or connect to `npm run dev:electron:debug`.
2. Stop unrelated GPU services.
3. Select only the service under test.
4. Launch selected services and poll the service chip to `Running`.
5. Verify fields:
   - TTS URL
   - TTS model
   - TTS voice
   - provider
6. Use `debug.captureText(...)` for deterministic playback.
7. Inspect `logs.tail({ category: 'stack' })`, `api`, and `playback`.
8. Stop the service when finished.

Prefer DOM/evaluate actions over pixel clicks when controls are outside the viewport.

Do not rely on screenshots alone. Screenshots can show `Running` while the app still uses stale model or voice settings.

## Performance Diagnosis

Check logs for:

- repeated model load per request
- model download during request
- CPU fallback
- concurrent duplicate TTS requests
- app aborts from `chunkTimeoutMs`
- multiple internal upstream batches for one input

Compare request start/end lines:

- `provider.tts.request.begin`
- `provider.tts.request.end`
- service `POST /v1/audio/speech 200 OK`
- upstream logs such as `Using device: cuda`, `Loading model weights`, `Generating audio chunks`

If the service is slow but correctly warmed and on CUDA, the remaining delay may be model architecture or GPU capability rather than integration.

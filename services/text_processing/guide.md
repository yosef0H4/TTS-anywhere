# OCR Service Guide

This repo already has three OCR-style services under `services/text_processing/`:

- `paddle`: text detection + OpenAI-compatible OCR
- `rapid`: text detection + OpenAI-compatible OCR
- `h2ovl`: OpenAI-compatible OCR only, GPU-only

Use them as the implementation reference for any new OCR service.

## What The App Actually Depends On

The Electron/web app only depends on a small HTTP contract.

### Required for detection integration

If the service should support preprocessing box detection, it must expose:

- `GET /healthz`
- `POST /v1/detect`

The renderer calls `/healthz` and expects:

```json
{
  "ok": true,
  "detector": "your-service-name",
  "features": {
    "detect": true,
    "openai_ocr": false
  }
}
```

The renderer posts `multipart/form-data` to `/v1/detect` with:

- `image`: uploaded file
- `settings`: JSON string, currently `{"detector":{"include_polygons":false}}`

Success response shape should match the existing services:

```json
{
  "status": "success",
  "request_id": "uuid",
  "image": { "width": 1920, "height": 1080 },
  "raw_boxes": [
    {
      "id": "uuid",
      "px": { "x1": 10, "y1": 20, "x2": 300, "y2": 80 },
      "norm": { "x": 0.01, "y": 0.02, "w": 0.15, "h": 0.05 },
      "polygon": null
    }
  ],
  "metrics": {
    "detect_ms": 12.34,
    "total_ms": 18.9,
    "raw_count": 1
  }
}
```

Error responses from current services are HTTP 200 with:

```json
{
  "status": "error",
  "request_id": "uuid",
  "error": {
    "code": "detect_failed",
    "message": "..."
  }
}
```

That behavior is worth keeping because the app already handles it.

### Required for OCR integration

If the service should act as an OCR backend through the app's OpenAI-compatible path, it must expose:

- `GET /healthz`
- `GET /v1/models`
- `POST /v1/chat/completions`

The OCR base URL used by the app is expected to look like `http://127.0.0.1:<port>/v1`, so your service should keep the OpenAI-style paths exactly as above.

`/healthz` should include:

```json
{
  "ok": true,
  "features": {
    "detect": false,
    "openai_ocr": true
  }
}
```

`POST /v1/chat/completions` should accept OpenAI-style message content with an image data URL:

```json
{
  "model": "your-model",
  "stream": false,
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "Extract all text from this image." },
        { "type": "image_url", "image_url": { "url": "data:image/png;base64,..." } }
      ]
    }
  ]
}
```

Current services only support `data:` URLs, not remote image URLs. Keep that unless you have a strong reason to widen the contract.

Non-streaming success response should match OpenAI chat completion shape:

```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "created": 1234567890,
  "model": "your-model",
  "choices": [
    {
      "index": 0,
      "finish_reason": "stop",
      "message": {
        "role": "assistant",
        "content": "line 1\nline 2"
      }
    }
  ],
  "usage": {
    "prompt_tokens": 0,
    "completion_tokens": 0,
    "total_tokens": 0
  }
}
```

Streaming should be SSE with `data: ...` chunks and a final `data: [DONE]`.

## Current Service Patterns

### `paddle`

Files:

- `services/text_processing/paddle/src/paddle_text_processing/app.py`
- `services/text_processing/paddle/src/paddle_text_processing/cli.py`
- `services/text_processing/paddle/launcher.py`

Behavior:

- supports both `/v1/detect` and `/v1/chat/completions`
- enables features explicitly with `--enable-detect` and `--enable-openai-ocr`
- supports separate devices for detection and OCR
- lazily initializes engines through factory objects
- returns axis-aligned boxes plus optional polygons

Use this as the best reference for a dual-purpose service.

### `rapid`

Files:

- `services/text_processing/rapid/src/rapid_text_processing/app.py`
- `services/text_processing/rapid/src/rapid_text_processing/cli.py`
- `services/text_processing/rapid/launcher.py`

Behavior:

- same high-level API shape as `paddle`
- uses execution providers instead of Paddle device strings
- keeps the same detection response contract
- keeps the same OpenAI OCR contract

Use this as the best reference for a non-Paddle dual-purpose service.

### `h2ovl`

Files:

- `services/text_processing/h2ovl/src/h2ovl_text_processing/app.py`
- `services/text_processing/h2ovl/src/h2ovl_text_processing/cli.py`
- `services/text_processing/h2ovl/launcher.py`

Behavior:

- OCR only, no `/v1/detect`
- GPU-only
- performs real token streaming instead of fake one-shot SSE
- warms the model on startup

Use this as the best reference for an OCR-only model service.

## Recommended Directory Layout

For a new service called `myocr`:

```text
services/text_processing/myocr/
  README.md
  launcher.py
  pyproject.toml
  uv.lock
  scripts/
    _serve.bat
    host_both.bat
    host_detect.bat
    host_ocr.bat
    ...
  src/
    myocr_text_processing/
      __init__.py
      app.py
      cli.py
  tests/
    conftest.py
    test_api.py
    test_cli.py
    test_launcher.py
    test_scripts.py
```

For OCR-only services like `h2ovl`, you can omit detect-specific scripts/tests.

## Python Package Pattern

Follow the existing packaging shape:

- package name in `pyproject.toml`
- console entry point in `[project.scripts]`
- source under `src/<service>_text_processing/`
- `cli.py` owns argument parsing and calls `uvicorn.run(create_app(...))`
- `app.py` owns HTTP models, runtime config, engine lifecycle, and endpoint handlers

Example script entry:

```toml
[project.scripts]
myocr-text-processing = "myocr_text_processing.cli:main"
```

## App Structure Pattern

### 1. Define runtime config

Each service has a `RuntimeConfig` Pydantic model in `app.py`.

Put all runtime flags there:

- feature toggles
- device/provider choices
- model IDs or model names
- optional model directories
- CPU thread counts

### 2. Normalize runtime selection early

Current services convert user-facing device/provider strings into a resolved runtime object:

- `resolve_device(...)` in `paddle`
- `resolve_execution_provider(...)` in `rapid`

Do the same in new services so `/healthz` can report both:

- requested mode
- resolved mode

### 3. Initialize heavy engines lazily

Do not create the OCR model or detector at import time.

Use a factory or runtime object that initializes on first use:

- `PaddleDetectFactory`
- `PaddleOcrFactory`
- `RapidEngineFactory`
- `H2OVLRuntime`

This keeps startup manageable and makes tests easy to fake.

### 4. Keep endpoint conversion logic separate from engine logic

Existing services separate:

- image decoding
- provider/device validation
- engine initialization
- provider-native result parsing
- HTTP response shaping

That separation matters because provider-native OCR outputs vary a lot.

## Detection Endpoint Requirements

If your service supports detection, match the existing behavior closely.

### Input handling

- accept uploaded image bytes
- decode to RGB
- optionally parse `settings`
- tolerate malformed `settings` by falling back to defaults

### Output handling

Your engine may return polygons, rotated boxes, tuples, custom classes, or dicts. Convert them into the repo's common shape:

- `px`: integer axis-aligned box in pixels
- `norm`: normalized `[0,1]` box fields
- `polygon`: original polygon only when requested

The current app primarily consumes `raw_boxes`, not provider-native data. Do not leak a provider-specific response format directly.

### Error handling

Current detect services usually:

- return structured `"status": "error"` payloads for image parse/init/inference failures
- avoid raw tracebacks in HTTP responses
- keep logging server-side

Keep that model.

## OCR Endpoint Requirements

### Input extraction

Current services parse the first `image_url` item from `messages[*].content[]`.

Recommended behavior:

- accept `content` as a string or list
- ignore non-image parts except for prompt text
- decode only `data:` URLs
- raise HTTP 400 when no image is present

### Text output

Normalize OCR output into plain text:

- strip empty lines
- join lines with `\n`
- return only extracted text in the OpenAI response content

### Streaming

Two acceptable patterns already exist:

- fake streaming: emit one chunk with the full text, then a stop chunk, then `[DONE]`
- real streaming: emit assistant role chunk, token chunks, stop chunk, `[DONE]`

If your backend cannot stream natively, fake streaming is fine and already used by `paddle` and `rapid`.

## Health Endpoint Expectations

`/healthz` is used both by humans and by the app's service launcher.

Include at minimum:

- `ok`
- `detector`
- `version`
- `features.detect`
- `features.openai_ocr`

If relevant, also include:

- execution provider or device info
- model names or model IDs
- package versions
- runtime flags
- GPU name

Examples:

- `paddle` reports requested/resolved devices and package versions
- `rapid` reports requested/resolved execution providers
- `h2ovl` reports GPU-only OCR runtime details

## CLI Pattern

`cli.py` should expose a `serve` subcommand and validate the runtime before booting Uvicorn.

Common pattern:

```python
def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(...)
    sub = parser.add_subparsers(dest="cmd", required=True)
    serve = sub.add_parser("serve")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=8090)
    serve.add_argument("--enable-detect", action="store_true")
    serve.add_argument("--enable-openai-ocr", action="store_true")
    return parser.parse_args(argv)
```

The `main()` function should:

- reject runs with no enabled feature for dual-purpose services
- validate device/provider args before app creation
- build `RuntimeConfig`
- call `uvicorn.run(create_app(config=config), host=args.host, port=args.port)`

## Launcher Pattern

Each service has a `launcher.py` that owns environment provisioning. That is an important repo convention.

Responsibilities:

- choose the right virtual environment path
- set `UV_PROJECT_ENVIRONMENT`
- run `uv sync` inside that environment
- install runtime-specific packages that are awkward to keep in the lockfile alone
- start `python -m <service>.cli serve ...`

Examples:

- `paddle` selects `.venv-cpu` or `.venv-gpu`
- `rapid` selects `.venv-cpu` or `.venv-gpu`
- `h2ovl` always uses `.venv-gpu`

If your backend needs separate CPU/GPU variants, copy the `paddle` or `rapid` pattern instead of inventing a new one.

## Windows Host Scripts

The existing services expose Windows-first launch helpers under `scripts/`.

For dual-purpose services, the current pattern is:

- `host_both.bat`
- `host_both_gpu.bat`
- `host_both_cpu_ocr_gpu.bat`
- `host_both_gpu_ocr_cpu.bat`
- `host_detect.bat`
- `host_detect_gpu.bat`
- `host_ocr.bat`
- `host_ocr_gpu.bat`
- `_serve.bat`

These scripts:

- find `uv`
- read `.python-version`
- create the selected venv if needed
- call `launcher.py` with the right flags

If the new service is intended to be launched manually by users on Windows, keep the same script style.

## Tests You Should Add

Match the existing test layout.

### `tests/test_api.py`

Cover:

- `/healthz` reports features correctly
- `/v1/detect` returns normalized boxes if detect is supported
- `/v1/detect` handles invalid image input
- `/v1/models` returns a model list if OCR is supported
- `/v1/chat/completions` returns valid OpenAI chat shape
- streaming returns `data: [DONE]`
- OCR returns HTTP 400 when image input is missing
- feature-disabled endpoints return 404 when appropriate

Use fake factories/runtimes instead of loading the real model in unit tests.

### `tests/test_cli.py`

Cover:

- `serve` arg parsing
- required feature flags for dual-purpose services
- provider/device validation

### `tests/test_launcher.py`

Cover:

- environment selection logic
- package/runtime repair logic
- generated subprocess command shape

### `tests/test_scripts.py`

For services with `.bat` wrappers, verify each script passes the expected launcher flags.

## Recommended Implementation Steps

1. Copy the nearest existing service as a starting point.
2. Decide whether the new service supports:
   - detect only
   - OCR only
   - both
3. Implement `app.py` first and keep the HTTP contract compatible.
4. Add `cli.py` with a `serve` subcommand.
5. Add `pyproject.toml` and confirm the package imports from `src/`.
6. Add `launcher.py` for managed environment startup.
7. Add Windows scripts if this service should be user-launchable outside the app.
8. Add API, CLI, launcher, and script tests.
9. Add `README.md` with quick start, API endpoints, and troubleshooting.

## Copy-From Guidance

Use this reference map:

- start from `paddle` if you need separate detection and OCR engines
- start from `rapid` if your backend is non-Paddle and provider-based
- start from `h2ovl` if your backend is OCR-only and model-centric

## Pitfalls To Avoid

- Do not return provider-native detection output directly.
- Do not make `/healthz` omit `features.detect` or `features.openai_ocr`.
- Do not require remote image URLs if the app only sends `data:` URLs.
- Do not initialize huge models at import time.
- Do not skip `launcher.py` if the runtime needs managed package installation.
- Do not make the OCR route non-OpenAI-shaped if it is intended for the app's OCR base URL.

## Repo-Specific Notes

- The managed Electron stack currently auto-launches `paddle` on Windows from [`src/electron/main.ts`](/mnt/z/files/projects/js/tts-electron/src/electron/main.ts).
- The renderer health check and detection client live in [`src/features/preprocessing/text-processing-client.ts`](/mnt/z/files/projects/js/tts-electron/src/features/preprocessing/text-processing-client.ts).
- Current bundled runtime-service sync tests mention `rapid`, so adding a new service may also require runtime packaging/inclusion changes outside `services/text_processing/`.
- If you want the app to auto-manage the new OCR service, you will need follow-up integration in Electron launcher code and UI settings. This guide only covers how to build the service itself so it matches the existing service family.

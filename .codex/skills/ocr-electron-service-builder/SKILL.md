---
name: ocr-electron-service-builder
description: Build, debug, benchmark, and validate OCR/text-processing services in this TTS Anywhere Electron repo, especially OpenAI-compatible image OCR adapters, GPU-only OCR models, launcher-to-UI setting handoff, Electron image-upload tests, screenshot hotkey capture, and speed/quality benchmarking.
---

# OCR Electron Service Builder

Use this skill when adding or fixing OCR services under `services/text_processing/*` or validating OCR behavior in the Electron UI.

## Core Workflow

1. Read the service manifest, launcher, adapter API, Electron service manager, and current UI handoff before changing code.
   - Check `src/electron/main.ts` service status reuse logic when changing launch presets.
   - Check `src/web/app.ts` handoff before assuming the UI will update base URL/model.
2. Create or reuse stable fixtures under `test-fixtures/ocr/`.
   - Keep at least one English fixture and one Arabic fixture.
   - Add screenshot-sized and slightly degraded fixtures when tuning speed/quality.
3. Prove the model with a basic script before the API.
   - Load the model once.
   - Use fixture images.
   - Verify expected substrings, not exact perfect OCR.
4. Prove the OpenAI-compatible API directly.
   - Test `/healthz`, `/v1/models`, and `/v1/chat/completions`.
   - Send `data:image/png;base64,...` image URLs.
   - Test one OCR service/model at a time.
   - For multi-model services, request each model ID explicitly and verify the service routes to the right engine.
5. Prove the Electron UI last with `electron-playwright-cli`.
   - Select only the target OCR service/model.
   - Clear detect/TTS selectors unless the test explicitly needs them.
   - Use `debug.uploadImage("test-fixtures/ocr/name.png")`.
   - Check `#raw-text`, service chips, active model, and logs.
6. Stop services after each validation pass.
   - Confirm no `python.exe` command line for the OCR service remains.
   - Confirm `nvidia-smi` memory returns to idle for GPU services.

## Multi-Model OCR

For one service exposing several OCR models, such as Paddle English plus Arabic:

- Keep startup lazy. Do not warm every model at service startup; load the selected engine on first request and cache it by model ID or recognition model name.
- `/v1/models` must list every selectable model ID.
- Unknown model IDs should use an intentional fallback only if documented; otherwise return a clear error.
- Add tests that prove model routing, not only response shape.
- In the UI, do not trust the hidden native `<select>` alone when TomSelect is used. Inspect `document.getElementById("llm-model").tomselect.options` and set values through `tomselect.setValue(...)` in Playwright snippets.

## GPU-Only Rules

For heavy OCR models that must not run on CPU:

- Fail fast if `nvidia-smi` or `torch.cuda.is_available()` is unavailable.
- Do not silently fall back to CPU.
- Put GPU envs in a managed `.venv-gpu` and ignore it in service `.gitignore`.
- Preserve CUDA package versions. A version check must treat `2.8.0+cu129` as satisfying `torch==2.8.0`; otherwise launchers can redownload torch repeatedly.
- Never run multiple GPU OCR services during tests.

## Launcher Handoff

When launching a local OCR service, make the UI update the active OCR settings:

- `llm.openaiCompatible.baseUrl`
- `llm.openaiCompatible.model`
- prompt only when blank/default, unless the service requires a fixed prompt
- streaming flag if the service does not stream well
- sane max token cap

Do not overwrite a user-custom OCR prompt unless the service cannot work without a fixed prompt.

Avoid stale launcher metadata:

- If `launchDiscoveredService` returns an existing running service, verify both `presetId` and normalized `servicePath` match.
- Service status must report the actual launched service ID and path. A stale `serviceId` breaks UI handoff.
- If a service launch uses a combined detect+OCR preset, make sure the UI can still apply the OCR base URL.

For Windows launcher scripts:

- Dry-run blocks in `.bat` files need delayed expansion when building command strings inside parentheses.
- Avoid nested quotes in variables like `set "RUN_CMD="%ENV_PYTHON%" ..."`.
- Run the service's launcher/script tests after touching host scripts.

## Performance Tuning

Vision-language OCR can be slow because image size becomes visual tokens.

- Inspect model/processor config for `shortest_edge`, `longest_edge`, patch size, and chat template expectations.
- Benchmark resize caps instead of guessing. Useful caps: `640`, `896`, `1024`, `1280`.
- Prefer the smallest cap that preserves expected substrings on clean, degraded, Arabic, English, and screenshot-sized fixtures.
- Cap `max_new_tokens`; old saved UI values must not force huge generations.
- Use `torch.inference_mode()`, `do_sample=False`, `use_cache=True`, and explicit `pad_token_id` where supported.
- If the Electron request is aborted/preempted, propagate cancellation to generation so stale OCR does not keep burning GPU time.

## Electron Checks

Use `electron-playwright-cli`; do not use MCP for this repo.

Before launching:

- Remove `ELECTRON_RUN_AS_NODE` before starting Electron.
- Stop unrelated OCR/TTS services; accidental TTS launch can create misleading playback failures while testing OCR.
- Prefer preload APIs for service launch when native controls are wrapped or off-screen, but still verify visible UI state afterward.

Useful snippets:

```powershell
@'
return await page.evaluate(async () => ({
  services: await window.electronAPI?.getDiscoveredServices?.(),
  statuses: await window.electronAPI?.getDiscoveredServiceStatuses?.()
}));
'@ | npm run pw:stdin
```

```powershell
@'
await debug.uploadImage('test-fixtures/ocr/english-basic.png');
await page.waitForFunction(() => document.getElementById('raw-text')?.value.includes('Invoice'), null, { timeout: 120000 });
return document.getElementById('raw-text')?.value;
'@ | npm run pw:stdin
```

TomSelect model checks:

```powershell
@'
return await page.evaluate(() => {
  const el = document.getElementById('llm-model');
  return {
    value: el?.tomselect?.getValue?.() ?? el?.value,
    tomOptions: el?.tomselect ? Object.keys(el.tomselect.options) : [],
    domOptions: Array.from(el?.querySelectorAll('option') ?? []).map((option) => option.value)
  };
});
'@ | npm run pw:stdin
```

Direct preload model fetch:

```powershell
@'
return await page.evaluate(async () => {
  return await window.electronAPI.fetchProviderModels({
    provider: 'openai_compatible',
    kind: 'ocr',
    baseUrl: document.getElementById('llm-url')?.value,
    apiKey: ''
  });
});
'@ | npm run pw:stdin
```

If Electron fails with `The requested module 'electron' does not provide an export named ...`, check `ELECTRON_RUN_AS_NODE`; remove it for app launch.

If the renderer stays on the boot screen:

- Check whether Vite can serve `/src/web/main.ts`.
- Restart the Electron debug stack after stopping model services.
- Wait for `#raw-text`, not just the page title.

## Screenshot Hotkey

If Ctrl+Alt+Shift+S fails before OCR:

- Check `logs/capture-diagnostics.log`.
- If it says `nodehotkey native capture addon not found`, rebuild:

```powershell
npm --prefix services/nodehotkey run build:native
```

If rebuild fails with `EPERM` on `.node`, stop Electron first because the addon is locked.

## Final Checklist

- Basic model test passed.
- Direct API test passed.
- Electron upload test passed.
- `/v1/models` and UI model picker include all intended model IDs.
- Relevant pytest/vitest/build checks passed.
- All launched services stopped.
- GPU memory idle.
- No venvs, caches, model downloads, or benchmark output accidentally staged.

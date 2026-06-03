---
name: ocr-electron-service-builder
description: Build, debug, benchmark, and validate OCR/text-processing services in this TTS Anywhere Electron repo, especially OpenAI-compatible image OCR adapters, GPU-only OCR models, launcher-to-UI setting handoff, Electron image-upload tests, screenshot hotkey capture, and speed/quality benchmarking.
---

# OCR Electron Service Builder

Use this skill when adding or fixing OCR services under `services/text_processing/*` or validating OCR behavior in the Electron UI.

## Core Workflow

1. Read the service manifest, launcher, adapter API, and current UI handoff before changing code.
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
5. Prove the Electron UI last with `electron-playwright-cli`.
   - Select only the target OCR service in `#service-ocr-select`.
   - Clear detect/TTS selectors unless the test explicitly needs them.
   - Use `debug.uploadImage("test-fixtures/ocr/name.png")`.
   - Check `#raw-text`, service chips, and logs.
6. Stop services after each validation pass.
   - Confirm no `python.exe` command line for the OCR service remains.
   - Confirm `nvidia-smi` memory returns to idle for GPU services.

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

If Electron fails with `The requested module 'electron' does not provide an export named ...`, check `ELECTRON_RUN_AS_NODE`; remove it for app launch.

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
- Relevant pytest/vitest/build checks passed.
- All launched services stopped.
- GPU memory idle.
- No venvs, caches, model downloads, or benchmark output accidentally staged.
